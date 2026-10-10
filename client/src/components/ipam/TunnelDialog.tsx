import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Loader2, CheckCircle, AlertTriangle, Unplug, Globe, ExternalLink, ShieldAlert, Plug, Copy, Lock, Info, Monitor,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { tunnelApi, type TunnelProxyAccess, type TunnelScheme } from '../../api/tunnel.api';
import { siteApi, type TunnelProbe } from '../../api/site.api';
import { useAnonymize } from '@/utils/anonymize';
import { copyText } from '@/utils/clipboard';
import { isHandled } from '@/utils/apiError';
import { STEP_UP_PROMPT_EVENT } from '@/api/restrictions.api';
import { storageGet, storageSet } from '@/utils/safeStorage';
import { Modal } from '@/components/common/Modal';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { Button } from '@/components/common/Button';
import { LoadError } from '@/components/common/LoadError';
import type { Tunnel } from '@oblimap/shared';

interface TunnelDialogProps {
  siteId: number;
  targetIp: string;
  targetPort: number;
  onClose: () => void;
}

/** Ports whose tunnel opens the device's web UI (the only tunnels offered on port chips). */
export const WEB_PORTS: ReadonlySet<number> = new Set([80, 443, 8080, 8443]);

/** Usual scheme of the web ports, for the direct (Local) link. */
const LOCAL_SCHEMES: Record<number, 'http' | 'https'> = { 80: 'http', 443: 'https', 8080: 'http', 8443: 'https' };

const SCHEMES: readonly TunnelScheme[] = ['auto', 'http', 'https'];

function isOpen(tunnel: Tunnel | null): tunnel is Tunnel {
  return tunnel != null && (tunnel.status === 'opening' || tunnel.status === 'active');
}

/** The probe preselected: the WebSocket-connected primary, else the first connected one. */
function defaultProbe(probes: readonly TunnelProbe[]): number | null {
  const connected = probes.filter((p) => p.wsConnected);
  return (connected.find((p) => p.isPrimary) ?? connected[0])?.id ?? null;
}

/** The scheme chosen for this device port last time (remembered per item and port). */
function schemeKey(siteId: number, ip: string, port: number): string {
  return `oblimap.tunnelScheme.${siteId}.${ip}.${port}`;
}

function readScheme(siteId: number, ip: string, port: number): TunnelScheme {
  const v = storageGet(schemeKey(siteId, ip, port));
  return v === 'http' || v === 'https' || v === 'auto' ? v : 'auto';
}

/** Absolute URL of a proxy link (isolated mode answers a root-relative one). */
function absoluteProxyUrl(url: string): string {
  try {
    return new URL(url, window.location.origin).href;
  } catch {
    return url;
  }
}

/**
 * Tunnel to a device of the site through one of its probes.
 * The dialog first lists the site's probes (GET /sites/:id/tunnel-probes)
 * with the connected primary preselected and the scheme to speak to the
 * device; nothing is opened before the user clicks. "Open web interface"
 * opens the tunnel and the device's web UI in a new tab through the proxy
 * link (token URL, valid as long as the tunnel). The tunnel lives as long as
 * the dialog.
 */
export default function TunnelDialog({ siteId, targetIp, targetPort, onClose }: TunnelDialogProps) {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const shownTargetIp = anonymize(targetIp, 'ip');
  const [tunnel, setTunnelState] = useState<Tunnel | null>(null);
  const [proxy, setProxy] = useState<TunnelProxyAccess | null>(null);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [probes, setProbes] = useState<TunnelProbe[] | null>(null);
  const [probesError, setProbesError] = useState(false);
  const [selectedProbeId, setSelectedProbeId] = useState<number | null>(null);
  const [scheme, setScheme] = useState<TunnelScheme>(() => readScheme(siteId, targetIp, targetPort));
  const [popupBlocked, setPopupBlocked] = useState(false);
  // 429 "Maximum N concurrent tunnels": offer the supervision page to close some.
  const [limitHit, setLimitHit] = useState(false);
  // How to reach the device: through a probe (default) or directly from this
  // computer ("Local": only works on the site's network or over a VPN).
  const [access, setAccess] = useState<'proxy' | 'local'>('proxy');

  // The tunnel is closed when the dialog closes (refs, because the unmount
  // cleanup must see the latest tunnel).
  const tunnelRef = useRef<Tunnel | null>(null);
  const mountedRef = useRef(false);
  // Once a web link was issued the device lives in another tab: closing this
  // dialog must not cut it. The tunnel then ends with "Close tunnel", from the
  // tunnel supervision, or after inactivity (probe 10 min / server 30 min).
  const webLinkRef = useRef(false);

  function setTunnel(next: Tunnel | null) {
    tunnelRef.current = next;
    setTunnelState(next);
  }

  function chooseScheme(next: TunnelScheme) {
    setScheme(next);
    storageSet(schemeKey(siteId, targetIp, targetPort), next);
  }

  /** Closes the tunnel on the server, once; errors are ignored (it expires on its own). */
  function releaseTunnel(current: Tunnel | null) {
    if (!isOpen(current)) return;
    tunnelRef.current = { ...current, status: 'closed' };
    void tunnelApi.close(current.id).catch(() => { /* expires server-side */ });
  }

  const loadProbes = useCallback(async () => {
    setProbesError(false);
    setProbes(null);
    try {
      const res = await siteApi.tunnelProbes(siteId);
      if (!mountedRef.current) return;
      setProbes(res.probes);
      setSelectedProbeId(defaultProbe(res.probes));
    } catch {
      if (mountedRef.current) setProbesError(true);
    }
  }, [siteId]);

  function errorMessage(err: unknown, fallback: string): string {
    if (err && typeof err === 'object' && 'response' in err) {
      const resp = (err as { response?: { data?: { error?: string; message?: string } } }).response;
      return resp?.data?.error ?? resp?.data?.message ?? fallback;
    }
    return err instanceof Error ? err.message : fallback;
  }

  /**
   * Opens the tunnel, then the device's web UI. The tab is opened right away
   * (in the click, so the browser allows it) and sent to the proxy link once
   * the tunnel is ready; where pop-ups are blocked (ObliTools frame) the
   * "Open web interface" link is shown instead.
   */
  async function openTunnel() {
    if (selectedProbeId === null) return;
    if (tunnelRef.current && !isOpen(tunnelRef.current)) setTunnel(null);
    let win: Window | null = null;
    try {
      win = window.open('', '_blank');
      if (win) {
        win.opener = null;
        win.document.title = t('tunnel.openingTab', 'Opening the device web interface…');
      }
    } catch {
      win = null;
    }
    setPopupBlocked(win === null);
    setLoading(true);
    setError(null);
    setLimitHit(false);
    // A step-up dialog opens in this tab: close the blank popup so it does not
    // hide the dialog; the "Open web interface" link is shown after the replay.
    const onPrompt = () => {
      win?.close();
      win = null;
      if (mountedRef.current) setPopupBlocked(true);
    };
    window.addEventListener(STEP_UP_PROMPT_EVENT, onPrompt);
    try {
      const res = await tunnelApi.open(siteId, targetIp, targetPort, selectedProbeId, scheme);
      if (!mountedRef.current) {
        // The dialog was closed while the tunnel was opening.
        win?.close();
        releaseTunnel(res.tunnel);
        return;
      }
      setTunnel(res.tunnel);
      setProxy(res.proxy);
      if (res.proxy) webLinkRef.current = true;
      if (res.proxy && win) {
        win.location.replace(absoluteProxyUrl(res.proxy.url));
      } else {
        win?.close();
        if (!res.proxy) setPopupBlocked(false);
      }
      toast.success(t('tunnel.opened', 'Tunnel opened'));
    } catch (err: unknown) {
      win?.close();
      const msg = errorMessage(err, t('tunnel.failedOpen', 'Failed to open tunnel'));
      if (!mountedRef.current) return;
      // A cancelled step-up or a step-up refusal already told the user.
      if (isHandled(err)) return;
      setLimitHit((err as { response?: { status?: number } })?.response?.status === 429);
      setError(msg);
      toast.error(msg);
    } finally {
      window.removeEventListener(STEP_UP_PROMPT_EVENT, onPrompt);
      if (mountedRef.current) setLoading(false);
    }
  }

  /** Changes the scheme of the open tunnel (applied by the probe at once) and gets a fresh link. */
  async function switchScheme(next: TunnelScheme) {
    chooseScheme(next);
    const current = tunnelRef.current;
    if (!current || current.status !== 'active') return;
    setSwitching(true);
    try {
      const access = await tunnelApi.proxyAccess(current.id, next);
      if (mountedRef.current) setProxy(access);
    } catch (err: unknown) {
      toast.error(errorMessage(err, t('tunnel.schemeChangeFailed', 'Could not change the scheme')));
    } finally {
      if (mountedRef.current) setSwitching(false);
    }
  }

  async function copyLink() {
    if (!proxy) return;
    const ok = await copyText(absoluteProxyUrl(proxy.url));
    if (ok) toast.success(t('tunnel.linkCopied', 'Link copied — it works as long as the tunnel is open'));
    else toast.error(t('tunnel.copyFailed', 'Could not copy the link'));
  }

  async function closeTunnel() {
    const current = tunnelRef.current;
    if (!current) return;
    try {
      await tunnelApi.close(current.id);
      setTunnel(null);
      setProxy(null);
      toast.success(t('tunnel.closed', 'Tunnel closed'));
      onClose();
    } catch {
      toast.error(t('tunnel.failedClose', 'Failed to close tunnel'));
    }
  }

  // Probe list on mount; the tunnel is closed when the dialog goes away.
  useEffect(() => {
    mountedRef.current = true;
    void loadProbes();
    return () => {
      mountedRef.current = false;
      if (!webLinkRef.current) releaseTunnel(tunnelRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadProbes]);

  // Poll tunnel status while active
  useEffect(() => {
    if (!tunnel || tunnel.status === 'closed' || tunnel.status === 'error') return;
    const interval = setInterval(async () => {
      try {
        const { tunnel: updated } = await tunnelApi.get(tunnel.id);
        if (!mountedRef.current || tunnelRef.current?.id !== updated.id) return;
        setTunnel(updated);
        if (updated.status === 'closed' || updated.status === 'error') {
          setProxy(null);
          clearInterval(interval);
        }
      } catch { /* ignore */ }
    }, 5000);
    return () => clearInterval(interval);
  }, [tunnel?.id, tunnel?.status]);

  // The relay of the probe was not known yet at the open: ask once more.
  useEffect(() => {
    if (!tunnel || tunnel.status !== 'active' || proxy?.relay !== 'pending') return;
    const timer = setTimeout(() => {
      tunnelApi.proxyAccess(tunnel.id)
        .then((access) => { if (mountedRef.current && tunnelRef.current?.id === tunnel.id) setProxy(access); })
        .catch(() => { /* keep the current link */ });
    }, 3000);
    return () => clearTimeout(timer);
  }, [tunnel?.id, tunnel?.status, proxy?.relay]);

  const isWebPort = WEB_PORTS.has(targetPort);
  const probeName = (id: number) => {
    const p = probes?.find((x) => x.id === id);
    return p ? anonymize(p.name, 'hostname') : `#${id}`;
  };
  const connectedCount = probes?.filter((p) => p.wsConnected).length ?? 0;
  // Before the first open, and again after a tunnel failed or closed.
  const picking = !isOpen(tunnel);
  const schemeLabel = (s: TunnelScheme) => (s === 'auto'
    ? t('tunnel.schemeAuto', 'Auto (follow the device)')
    : s === 'https' ? t('tunnel.schemeHttps', 'HTTPS') : t('tunnel.schemeHttp', 'HTTP'));
  const proxyHost = (() => {
    if (!proxy || proxy.mode !== 'origin') return '';
    try {
      return new URL(proxy.url).host;
    } catch {
      return '';
    }
  })();

  const schemeSelect = (disabled: boolean) => (
    <div>
      <label htmlFor="tunnel-scheme" className="block text-xs text-text-muted mb-1">{t('tunnel.scheme', 'Device protocol')}</label>
      <select
        id="tunnel-scheme"
        value={scheme}
        onChange={(e) => {
          const next = e.target.value as TunnelScheme;
          if (picking) chooseScheme(next);
          else void switchScheme(next);
        }}
        disabled={disabled}
        className="w-full rounded-lg bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/60 disabled:opacity-60"
      >
        {SCHEMES.map((s) => <option key={s} value={s}>{schemeLabel(s)}</option>)}
      </select>
    </div>
  );

  // Direct URL of the device (Local tab): the usual scheme of the port, else
  // the scheme picked for the proxy (http when left on auto).
  const localScheme = LOCAL_SCHEMES[targetPort] ?? (scheme === 'https' ? 'https' : 'http');
  const localHostPart = (localScheme === 'http' && targetPort === 80) || (localScheme === 'https' && targetPort === 443) ? '' : `:${targetPort}`;
  const localUrl = `${localScheme}://${targetIp}${localHostPart}`;
  const shownLocalUrl = `${localScheme}://${shownTargetIp}${localHostPart}`;

  const footer = (
    <>
      {access === 'proxy' && picking && (
        <Button
          size="sm"
          onClick={() => void openTunnel()}
          disabled={loading || selectedProbeId === null}
          loading={loading}
          className="gap-1.5"
        >
          {!loading && <Plug size={14} />}
          {error ? t('tunnel.retry', 'Retry') : t('tunnel.openWeb', 'Open web interface')}
        </Button>
      )}
      {access === 'local' && (
        <a
          href={localUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
        >
          <ExternalLink size={14} />
          {t('tunnel.openLocal', 'Open directly')}
        </a>
      )}
      {access === 'proxy' && tunnel?.status === 'active' && (
        <Button size="sm" variant="danger" onClick={() => void closeTunnel()} className="gap-1.5">
          <Unplug size={14} />
          {t('tunnel.close', 'Close tunnel')}
        </Button>
      )}
      <Button size="sm" variant="secondary" onClick={onClose}>
        {t('common.close', 'Close')}
      </Button>
    </>
  );

  return (
    <Modal
      open
      onClose={onClose}
      title={t('tunnel.webAccessTitle', 'Web access')}
      icon={<Globe size={15} className="text-accent" />}
      size="sm"
      phoneLayout="sheet"
      footer={footer}
      bodyClassName="space-y-4"
    >
      <SegmentedTabs<'proxy' | 'local'>
        value={access}
        onChange={setAccess}
        size="sm"
        ariaLabel={t('tunnel.accessMode', 'Access mode')}
        tabs={[
          { id: 'proxy', label: t('tunnel.tabProxy', 'Proxy'), icon: <Globe size={13} /> },
          { id: 'local', label: t('tunnel.tabLocal', 'Local'), icon: <Monitor size={13} /> },
        ]}
      />

      {/* Target info */}
      <div className="text-xs text-text-secondary space-y-1">
        <div><span className="text-text-muted">{t('tunnel.target', 'Target')}:</span> {shownTargetIp}:{targetPort}</div>
        {access === 'proxy' && tunnel && (
          <div>
            <span className="text-text-muted">{t('tunnel.probeId', 'Probe')}:</span> {probeName(tunnel.probeId)}
          </div>
        )}
      </div>

      {access === 'local' && (
        <div className="space-y-2">
          <p className="break-all font-mono text-sm text-text-primary">{shownLocalUrl}</p>
          <div className="flex items-start gap-2 rounded-lg bg-bg-secondary p-2 text-xs text-text-secondary">
            <Info size={14} className="mt-0.5 shrink-0" />
            <span>
              {t('tunnel.localHint', 'Opens the device directly from this computer, without a probe: it only works if this computer is on the site network (or reaches it over a VPN).')}
            </span>
          </div>
        </div>
      )}

      {access === 'proxy' && (<>
      {/* Probe and protocol choice (before the tunnel is opened) */}
      {picking && (
        probesError ? (
          <LoadError
            message={t('tunnel.probesLoadFailed', 'Could not load the probes of this site.')}
            onRetry={() => void loadProbes()}
            className="py-6"
          />
        ) : probes === null ? (
          <div className="flex items-center gap-2 text-text-secondary text-sm">
            <Loader2 size={16} className="animate-spin text-accent" />
            {t('common.loading', 'Loading...')}
          </div>
        ) : connectedCount === 0 ? (
          <div className="flex items-start gap-2 text-sm text-amber-400">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            {t('tunnel.noConnectedProbe', 'No probe of this site is connected right now: a tunnel needs a probe online over its live connection.')}
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <label htmlFor="tunnel-probe" className="block text-xs text-text-muted mb-1">{t('tunnel.selectProbe', 'Select probe')}</label>
              <select
                id="tunnel-probe"
                value={selectedProbeId ?? ''}
                onChange={(e) => setSelectedProbeId(e.target.value ? Number(e.target.value) : null)}
                disabled={loading}
                className="w-full rounded-lg bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/60 disabled:opacity-60"
              >
                {probes.map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.wsConnected}>
                    {anonymize(p.name, 'hostname')}
                    {p.isPrimary ? ` ${t('tunnel.primarySuffix', '(Primary)')}` : ''}
                    {!p.wsConnected ? ` ${t('tunnel.notConnectedSuffix', '(not connected)')}` : ''}
                  </option>
                ))}
              </select>
            </div>
            {schemeSelect(loading)}
            {!isWebPort && (
              <p className="text-xs text-text-muted">
                {t('tunnel.nonWebPortInfo', 'Port {{port}} is not a usual web port: the web interface opens only if the device serves HTTP or HTTPS on it.', { port: targetPort })}
              </p>
            )}
          </div>
        )
      )}

      {/* Status */}
      {loading && (
        <div className="flex items-center gap-2 text-text-secondary text-sm">
          <Loader2 size={16} className="animate-spin text-accent" />
          {t('tunnel.opening', 'Opening tunnel...')}
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 text-red-400 text-sm">
          <AlertTriangle size={16} />
          <span>
            {error}
            {limitHit && (
              <>
                {' '}
                <Link to="/manage/supervision" onClick={onClose} className="underline hover:text-red-300">
                  {t('tunnel.manageOpenTunnels', 'Close open tunnels in Supervision')}
                </Link>
              </>
            )}
          </span>
        </div>
      )}

      {tunnel?.status === 'opening' && (
        <div className="flex items-center gap-2 text-text-secondary text-sm">
          <Loader2 size={16} className="animate-spin text-accent" />
          {t('tunnel.opening', 'Opening tunnel...')}
        </div>
      )}

      {tunnel?.status === 'active' && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-accent text-sm">
            <CheckCircle size={16} />
            {t('tunnel.active', 'Tunnel active')}
          </div>

          {proxy ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <a
                  href={absoluteProxyUrl(proxy.url)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
                >
                  <ExternalLink size={14} />
                  {t('tunnel.openWeb', 'Open web interface')}
                </a>
                <Button size="sm" variant="secondary" onClick={() => void copyLink()} className="gap-1.5">
                  <Copy size={14} />
                  {t('tunnel.copyLink', 'Copy link')}
                </Button>
              </div>
              {popupBlocked && (
                <p className="text-xs text-text-muted">
                  {t('tunnel.popupBlocked', 'The new tab could not be opened automatically: use "Open web interface".')}
                </p>
              )}
              <p className="text-xs text-text-muted">
                {t('tunnel.linkExpires', 'Anyone with this link can open the device while this tunnel is open: share it only with people allowed to reach the device.')}
              </p>

              {schemeSelect(switching)}

              {proxy.relay === 'legacy' && (
                <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 p-2 text-xs text-amber-300">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                  <span>
                    {t('tunnel.legacyProbe', 'This probe is too old for full web access: one request at a time and no HTTPS devices. Update the probe for full web access.')}
                  </span>
                </div>
              )}

              {proxy.relay !== 'legacy' && proxy.scheme !== 'http' && (
                <div className="flex items-start gap-2 rounded-lg bg-bg-secondary p-2 text-xs text-text-secondary">
                  <Lock size={14} className="mt-0.5 shrink-0" />
                  <span>
                    {t('tunnel.httpsNotice', 'HTTPS devices: the probe accepts the device certificate without verifying it (devices use self-signed certificates). The connection only ever reaches this device; your browser talks to Oblimap over its own HTTPS.')}
                  </span>
                </div>
              )}

              {proxy.mode === 'isolated' ? (
                <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 p-2 text-xs text-amber-300">
                  <ShieldAlert size={14} className="mt-0.5 shrink-0" />
                  <span>
                    {t(
                      'tunnel.isolatedMode',
                      'Isolated mode: the device page opens in a sandboxed tab on the Oblimap address; its scripts cannot use your Oblimap session. Device logins that rely on cookies may not work — an administrator can set a dedicated tunnel address (TUNNEL_ORIGIN) for full compatibility.',
                    )}
                  </span>
                </div>
              ) : (
                <div className="flex items-start gap-2 rounded-lg bg-bg-secondary p-2 text-xs text-text-secondary">
                  <Info size={14} className="mt-0.5 shrink-0" />
                  <span>
                    {t('tunnel.originMode', 'Dedicated tunnel address: the device page is served on {{host}}, separate from Oblimap — its cookies and logins work.', { host: proxyHost })}
                  </span>
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-text-muted">
              {t('tunnel.noWebAccess', 'The tunnel is open, but no web link is available for you (only the user who opened it gets one).')}
            </p>
          )}

          <p className="text-xs text-text-muted">
            {proxy
              ? t('tunnel.staysOpenWithWeb', 'The tunnel stays open when this dialog is closed, so the device page keeps working: close it with "Close tunnel" or from the tunnel supervision; it also closes after 10 minutes without traffic.')
              : t('tunnel.closesWithDialog', 'The tunnel is closed when this dialog is closed.')}
          </p>
        </div>
      )}

      {tunnel?.status === 'error' && (
        <div className="flex items-center gap-2 text-red-400 text-sm">
          <AlertTriangle size={16} />
          {tunnel.errorMessage ?? t('tunnel.unknownError', 'Unknown error')}
        </div>
      )}

      {tunnel?.status === 'closed' && (
        <div className="flex items-center gap-2 text-text-muted text-sm">
          <Unplug size={16} />
          {t('tunnel.closed', 'Tunnel closed')}
        </div>
      )}
      </>)}
    </Modal>
  );
}
