import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import {
  CheckCircle, XCircle, Trash2, Plus,
  X, Save, Loader2, AlertTriangle, Monitor, RefreshCw,
  Activity, Globe, ArrowLeftRight, Crown, KeyRound, ShieldCheck, ShieldAlert,
  PauseCircle, PlayCircle, Clock, Ban, Network, Info, GitBranch,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import apiClient from '../api/client';
import { probeApi, type ProbeEffectiveScanConfig, type ProbeEffectiveScanKey } from '../api/probe.api';
import { siteApi } from '../api/site.api';
import { deviceChecksApi } from '../api/deviceChecks.api';
import type { DeviceCheckStateDetail, Probe, ProbeApiKey, ProbeScanConfig, Site } from '@oblimap/shared';
import { SCAN_INTERVAL_MAX_SECONDS, SCAN_INTERVAL_MIN_SECONDS, SCAN_SUBNET_MIN_PREFIX, SOCKET_EVENTS } from '@oblimap/shared';
import type { SettingsKey } from '@oblimap/shared';
import { getSocket } from '@/socket/socketClient';
import { clsx } from 'clsx';
import { useAnonymize } from '../utils/anonymize';
import { apiErrorBody, isHandled, toastApiError } from '../utils/apiError';
import { formatRelative } from '../utils/formatRelative';
import { useAuthStore, useTenantCapability } from '../store/authStore';
import { useTenantStore } from '../store/tenantStore';
import { deviceCheckTimeAgo } from '@/components/deviceChecks/DeviceCheckChip';
import { PageContainer } from '@/components/common/PageContainer';
import { PageHeader } from '@/components/common/PageHeader';
import { Button } from '@/components/common/Button';
import { LoadError } from '@/components/common/LoadError';
import { EmptyState } from '@/components/common/EmptyState';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { SettingsPanel } from '@/components/settings/SettingsPanel';
import {
  LastSeen, ProbeStatusBadge, formatMmSs, updateErrorLabel, useProbeLiveRefresh, useUninstallRemaining,
} from '@/components/probes/ProbeStatusBadge';
import {
  ApproveSiteModal, NoSiteBadge, approveNeedsSite, cancelProbeCommand, canReceiveCommands, isProbeNotApproved,
  probeCommandLabel, sendProbeCommand,
} from './AdminProbePage';

/** Where the back button goes when there is no in-app history. */
const PROBES_LIST_URL = '/manage/discovery?tab=probes';

// ─── Sub-components ───────────────────────────────────────────────────────────

/** "192.168.1.0/24" through anonymize (IP part masked in anonymous mode). */
function anonymizeCidr(cidr: string, anonymize: (text: string, kind?: 'ip') => string): string {
  const [ip, prefix] = cidr.split('/');
  return prefix !== undefined ? `${anonymize(ip, 'ip')}/${prefix}` : anonymize(cidr, 'ip');
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-4 py-2.5 border-b border-border last:border-0">
      <span className="text-text-muted text-sm w-40 shrink-0">{label}</span>
      <span className="text-text-primary text-sm">{value ?? '—'}</span>
    </div>
  );
}

// ─── Subnet list editor ───────────────────────────────────────────────────────

function SubnetListEditor({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const [input, setInput] = useState('');

  function add() {
    const v = input.trim();
    if (!v || value.includes(v)) return;
    onChange([...value, v]);
    setInput('');
  }

  function remove(subnet: string) {
    onChange(value.filter((s) => s !== subnet));
  }

  return (
    <div>
      <label className="text-sm text-text-muted block mb-2">{label}</label>
      <div className="flex gap-2 mb-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
          placeholder={placeholder ?? '192.168.1.0/24'}
          className="flex-1 bg-bg-tertiary border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent"
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={add}
          disabled={!input.trim()}
          className="gap-1"
        >
          <Plus size={14} /> {t('common.apply')}
        </Button>
      </div>
      {value.length === 0 ? (
        <p className="text-text-muted text-xs italic">{t('probesPage.detail.noneSubnets')}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {value.map((subnet) => (
            <span
              key={subnet}
              className="inline-flex items-center gap-1 bg-bg-tertiary rounded px-2 py-1 text-xs font-mono text-text-primary"
            >
              {anonymizeCidr(subnet, anonymize)}
              <button
                onClick={() => remove(subnet)}
                className="text-text-muted hover:text-red-400 ml-0.5"
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Port list editor ─────────────────────────────────────────────────────────

const DEFAULT_PORT_SCAN_PORTS = [21, 22, 23, 25, 53, 80, 110, 143, 443, 445, 3389, 8080, 8443];

function PortListEditor({
  value,
  onChange,
}: {
  value: number[];
  onChange: (v: number[]) => void;
}) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');

  function add() {
    const port = parseInt(input.trim(), 10);
    if (isNaN(port) || port < 1 || port > 65535 || value.includes(port)) return;
    onChange([...value, port].sort((a, b) => a - b));
    setInput('');
  }

  function remove(port: number) {
    onChange(value.filter((p) => p !== port));
  }

  return (
    <div>
      <div className="flex gap-2 mb-2">
        <input
          type="number"
          min={1}
          max={65535}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
          placeholder={t('probesPage.detail.portPlaceholder', 'e.g. 8080')}
          className="flex-1 bg-bg-tertiary border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent"
        />
        <Button
          variant="secondary"
          size="sm"
          onClick={add}
          disabled={!input.trim()}
          className="gap-1"
        >
          <Plus size={14} /> {t('common.apply')}
        </Button>
      </div>
      {value.length === 0 ? (
        <p className="text-text-muted text-xs italic">{t('probesPage.detail.noPortsConfigured')}</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {value.map((port) => (
            <span
              key={port}
              className="inline-flex items-center gap-1 bg-bg-tertiary rounded px-2 py-1 text-xs font-mono text-text-primary"
            >
              {port}
              <button
                onClick={() => remove(port)}
                className="text-text-muted hover:text-red-400 ml-0.5"
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Device checks card ───────────────────────────────────────────────────────

/** Checks this probe ran on its site (states whose executor is the probe). */
interface ProbeCheckStats {
  total: number;
  ok: number;
  failing: number;
  error: number;
  lastResultAt: string | null;
}

function probeCheckStats(states: DeviceCheckStateDetail[], probeId: number): ProbeCheckStats {
  const stats: ProbeCheckStats = { total: 0, ok: 0, failing: 0, error: 0, lastResultAt: null };
  for (const s of states) {
    if (s.probeId !== probeId) continue;
    stats.total++;
    if (s.status === 'ok') stats.ok++;
    else if (s.status === 'fail') stats.failing++;
    else if (s.status === 'error') stats.error++;
    if (s.lastCheckedAt && (!stats.lastResultAt || Date.parse(s.lastCheckedAt) > Date.parse(stats.lastResultAt))) {
      stats.lastResultAt = s.lastCheckedAt;
    }
  }
  return stats;
}

/**
 * Describes the scheme the probe reports only. Whether check credentials are
 * delivered is decided server side (FORCE_HTTPS + https, or
 * ALLOW_PLAINTEXT_PROBE_SECRETS and the probe's local
 * deviceChecks.allowPlaintextSecrets), which the probe DTO does not expose.
 */
function serverSchemeView(scheme: Probe['serverScheme'], t: TFunction): { text: string; cls: string } {
  if (scheme === 'https') {
    return {
      text: t('deviceChecks.probeCard.schemeHttps', 'HTTPS (check credentials also need FORCE_HTTPS on the server)'),
      cls: 'text-accent',
    };
  }
  if (scheme === 'http') {
    return {
      text: t('deviceChecks.probeCard.schemeHttp', 'HTTP (check credentials are not sent unless plaintext probe secrets are allowed on both the server and the probe)'),
      cls: 'text-amber-400',
    };
  }
  return { text: t('deviceChecks.probeCard.schemeUnknown', 'Not reported yet'), cls: 'text-text-muted' };
}

function DeviceChecksCard({
  probe,
  siteName,
  isAdmin,
  onUpdateProbe,
  onChanged,
}: {
  probe: Probe;
  siteName: string | null;
  isAdmin: boolean;
  onUpdateProbe: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const confirm = useConfirm();
  const [stats, setStats] = useState<ProbeCheckStats | null>(null);
  const [statsUnavailable, setStatsUnavailable] = useState(false);
  const [resetting, setResetting] = useState(false);

  const probeId = probe.id;
  const siteId = probe.siteId;
  useEffect(() => {
    setStats(null);
    setStatsUnavailable(false);
    if (!siteId) return;
    let cancelled = false;
    deviceChecksApi.siteStates(siteId)
      .then((states) => { if (!cancelled) setStats(probeCheckStats(states, probeId)); })
      .catch(() => { if (!cancelled) setStatsUnavailable(true); });
    return () => { cancelled = true; };
  }, [siteId, probeId]);

  async function handleResetToken() {
    const ok = await confirm({
      title: t('deviceChecks.probeCard.resetToken', 'Reset identity token'),
      message: <span className="whitespace-pre-line">{t(
        'deviceChecks.probeCard.resetTokenConfirm',
        'Reset the identity token of this probe?\n\nThe current token stops being required immediately. On its next contact the probe is accepted with its API key and UUID and re-enrolls: it receives a new identity token automatically. Use this after moving or reinstalling the probe, or if its token may have leaked.',
      )}</span>,
      confirmLabel: t('deviceChecks.probeCard.resetToken', 'Reset identity token'),
      danger: true,
    });
    if (!ok) return;
    setResetting(true);
    try {
      await apiClient.post(`/probe/devices/${probe.id}/reset-token`);
      toast.success(t('deviceChecks.probeCard.resetTokenDone', 'Identity token reset: the probe re-enrolls on its next contact'));
      onChanged();
    } catch (err) {
      toastApiError(err, t('deviceChecks.probeCard.resetTokenFailed', 'Failed to reset the identity token'));
    } finally {
      setResetting(false);
    }
  }

  const supported = probe.deviceChecksSupported === true;
  const scheme = serverSchemeView(probe.serverScheme ?? null, t);

  return (
    <div className="bg-bg-secondary rounded-xl p-5 shadow-[var(--shadow-card)]">
      <h2 className="text-sm font-semibold text-text-primary mb-3 flex items-center gap-2">
        <Activity size={15} className="text-accent" /> {t('deviceChecks.probeCard.title', 'Device checks')}
      </h2>

      <InfoRow
        label={t('deviceChecks.probeCard.support', 'Support')}
        value={supported ? (
          <span className="inline-flex items-center gap-1 text-accent">
            <CheckCircle size={13} /> {t('deviceChecks.probeCard.supported', 'Supported by this probe')}
          </span>
        ) : (
          <span className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1 text-amber-400">
              <AlertTriangle size={13} />
              {t('deviceChecks.probeCard.notSupported', 'Not supported by this probe version: update the probe')}
            </span>
            {isAdmin && probe.status === 'approved' && (
              <button
                type="button"
                onClick={onUpdateProbe}
                className="inline-flex items-center gap-1 rounded-md bg-bg-tertiary px-2 py-0.5 text-xs text-text-secondary hover:bg-bg-hover hover:text-accent"
              >
                <RefreshCw size={12} /> {t('probesPage.detail.updateProbe')}
              </button>
            )}
          </span>
        )}
      />
      <InfoRow
        label={t('deviceChecks.probeCard.serverScheme', 'Server connection')}
        value={<span className={scheme.cls}>{scheme.text}</span>}
      />
      <InfoRow
        label={t('deviceChecks.probeCard.targets', 'Checked devices')}
        value={
          !siteId ? (
            <span className="text-text-muted">{t('deviceChecks.probeCard.noSite', 'Assign the probe to a site to run device checks')}</span>
          ) : statsUnavailable ? (
            <span className="text-text-muted">{t('deviceChecks.probeCard.targetsUnavailable', 'Not available')}</span>
          ) : !stats ? (
            <Loader2 size={13} className="animate-spin text-text-muted" />
          ) : (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span>{t('deviceChecks.probeCard.targetsCount', { count: stats.total, defaultValue: '{{count}} devices' })}</span>
              {stats.total > 0 && (
                <span className="text-xs text-text-muted">
                  <span className="text-accent">{t('deviceChecks.siteSummary.okCount', { count: stats.ok, defaultValue: '{{count}} OK' })}</span>
                  {stats.failing > 0 && <> · <span className="text-red-400">{t('deviceChecks.siteSummary.failing', { count: stats.failing, defaultValue: '{{count}} failing' })}</span></>}
                  {stats.error > 0 && <> · <span className="text-amber-400">{t('deviceChecks.siteSummary.error', { count: stats.error, defaultValue: '{{count}} in error' })}</span></>}
                  {' · '}
                  {t('deviceChecks.probeCard.lastResult', { ago: deviceCheckTimeAgo(stats.lastResultAt, t), defaultValue: 'last result {{ago}}' })}
                </span>
              )}
              <Link to={`/sites/${siteId}`} className="text-xs text-accent hover:underline">
                {siteName ? anonymize(siteName, 'hostname') : t('deviceChecks.probeCard.openSite', 'Open the site')}
              </Link>
            </span>
          )
        }
      />
      <InfoRow
        label={t('deviceChecks.probeCard.identityToken', 'Identity token')}
        value={
          <span className="flex flex-wrap items-center gap-2">
            {probe.hasIdentityToken ? (
              <span className="inline-flex items-center gap-1 text-accent">
                <ShieldCheck size={13} /> {t('deviceChecks.probeCard.tokenIssued', 'Issued: required on every contact')}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-text-muted">
                <ShieldAlert size={13} /> {t('deviceChecks.probeCard.tokenNone', 'Not issued: the probe authenticates with its API key and UUID')}
              </span>
            )}
            {isAdmin && probe.hasIdentityToken && (
              <button
                type="button"
                onClick={() => void handleResetToken()}
                disabled={resetting}
                className="inline-flex items-center gap-1 rounded-md bg-bg-tertiary px-2 py-0.5 text-xs text-text-secondary hover:bg-bg-hover hover:text-amber-400 disabled:opacity-50"
              >
                {resetting ? <Loader2 size={12} className="animate-spin" /> : <KeyRound size={12} />}
                {t('deviceChecks.probeCard.resetToken', 'Reset identity token')}
              </button>
            )}
          </span>
        }
      />
    </div>
  );
}

// ─── Scan interval input ──────────────────────────────────────────────────────

const SCAN_INTERVAL_PRESETS = [60, 300, 900, 1800, 3600, 21_600, 86_400];

/** "90" → "1 min 30 s", "3600" → "1 h". */
function formatSeconds(total: number, t: TFunction): string {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const parts: string[] = [];
  if (h) parts.push(t('probesPage.detail.durationHours', { count: h, defaultValue: '{{count}} h' }));
  if (m) parts.push(t('probesPage.detail.durationMinutes', { count: m, defaultValue: '{{count}} min' }));
  if (s || parts.length === 0) parts.push(t('probesPage.detail.durationSeconds', { count: s, defaultValue: '{{count}} s' }));
  return parts.join(' ');
}

function isValidScanInterval(v: number): boolean {
  return Number.isInteger(v) && v >= SCAN_INTERVAL_MIN_SECONDS && v <= SCAN_INTERVAL_MAX_SECONDS;
}

/**
 * Number input (seconds) with presets; 60-86400 s. `baseValue` (the stored
 * interval) is not flagged when unchanged: a legacy value below 60 s has its
 * own "clamped" hint and is kept as it is on save.
 */
function ScanIntervalInput({ value, baseValue, onChange }: { value: number; baseValue: number; onChange: (v: number) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState(String(value));
  useEffect(() => { setText(String(value)); }, [value]);
  const valid = isValidScanInterval(value) || value === baseValue;
  return (
    <div>
      <label htmlFor="probe-scan-interval" className="text-sm text-text-muted block mb-2">
        {t('probesPage.detail.scanIntervalLabel', 'Scan interval (seconds)')}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id="probe-scan-interval"
          type="number"
          inputMode="numeric"
          min={SCAN_INTERVAL_MIN_SECONDS}
          max={SCAN_INTERVAL_MAX_SECONDS}
          step={1}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const n = Number(e.target.value);
            onChange(e.target.value.trim() === '' || !Number.isFinite(n) ? NaN : Math.round(n));
          }}
          aria-invalid={!valid}
          className={clsx(
            'w-36 bg-bg-tertiary border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-accent',
            valid ? 'border-border' : 'border-red-500/60',
          )}
        />
        {valid && <span className="text-xs text-text-muted">{formatSeconds(value, t)}</span>}
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {SCAN_INTERVAL_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => onChange(preset)}
            className={clsx(
              'rounded-full px-2.5 py-0.5 text-xs transition-colors',
              value === preset
                ? 'bg-accent/15 text-accent'
                : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover hover:text-accent',
            )}
          >
            {formatSeconds(preset, t)}
          </button>
        ))}
      </div>
      {!valid && (
        <p className="mt-1 text-xs text-red-400">
          {t('probesPage.detail.scanIntervalRange', {
            min: SCAN_INTERVAL_MIN_SECONDS,
            max: SCAN_INTERVAL_MAX_SECONDS,
            defaultValue: 'Enter a whole number of seconds between {{min}} and {{max}}.',
          })}
        </p>
      )}
    </div>
  );
}

// ─── Network & last scan card ─────────────────────────────────────────────────

function pushErrorLabel(code: string, t: TFunction): string {
  switch (code) {
    case 'invalid_payload':
      return t('probesPage.detail.pushErrorInvalidPayload', 'Scan report refused by the server (invalid data)');
    case 'device_processing_failed':
      return t('probesPage.detail.pushErrorProcessing', 'The server failed to process the reported devices');
    default:
      return code;
  }
}

function skippedReasonLabel(reason: string, t: TFunction): string {
  switch (reason) {
    case 'too_wide':
      return t('probesPage.detail.skippedTooWide', 'too wide to scan');
    case 'cycle_budget':
      return t('probesPage.detail.skippedCycleBudget', 'not scanned this cycle: the other subnets already fill the scan interval');
    default:
      return reason;
  }
}

/** Label of a probeUpdatePolicy value (same keys as the settings select). */
function updatePolicyLabel(policy: string, t: TFunction): string {
  switch (policy) {
    case 'auto': return t('settings.options.probeUpdatePolicy.auto', 'Automatic');
    case 'manual': return t('settings.options.probeUpdatePolicy.manual', 'Manual');
    case 'frozen': return t('settings.options.probeUpdatePolicy.frozen', 'Frozen');
    default: return policy;
  }
}

function sourceLabel(src: ProbeEffectiveScanConfig['sources'][ProbeEffectiveScanKey], t: TFunction): string {
  switch (src.source) {
    case 'probe':
      return t('probesPage.detail.sourceProbeOwn', 'this probe (own configuration)');
    case 'monitor':
      return t('probesPage.detail.sourceProbeSettings', 'this probe (settings)');
    case 'site':
      return t('probesPage.detail.sourceSite', 'site');
    case 'group':
      return src.sourceName
        ? t('probesPage.detail.sourceGroupNamed', { name: src.sourceName, defaultValue: 'group {{name}}' })
        : t('probesPage.detail.sourceGroup', 'group');
    case 'global':
      return t('probesPage.detail.sourceGlobal', 'global settings');
    default:
      return t('probesPage.detail.sourceDefault', 'default');
  }
}

function SubnetChips({ subnets, tone = 'neutral' }: { subnets: string[]; tone?: 'neutral' | 'warn' }) {
  const { anonymize } = useAnonymize();
  return (
    <span className="flex flex-wrap gap-1.5">
      {subnets.map((cidr) => (
        <span
          key={cidr}
          className={clsx(
            'inline-flex items-center rounded px-2 py-0.5 font-mono text-xs',
            tone === 'warn' ? 'bg-amber-500/10 text-amber-300' : 'bg-bg-tertiary text-text-primary',
          )}
        >
          {anonymizeCidr(cidr, anonymize)}
        </span>
      ))}
    </span>
  );
}

function NetworkScanCard({ probe, effective }: { probe: Probe; effective: ProbeEffectiveScanConfig | null }) {
  const { t } = useTranslation();
  const none = <span className="text-text-muted">—</span>;
  const scanned = probe.lastScannedSubnets ?? [];
  const skipped = probe.skippedSubnets ?? [];
  const errorIsStale = !!probe.lastPushErrorAt && !!probe.lastScanAt
    && Date.parse(probe.lastScanAt) > Date.parse(probe.lastPushErrorAt);

  const subnetValue = (list: string[]) => (list.length > 0 ? <SubnetChips subnets={list} /> : (
    <span className="text-text-muted">{t('probesPage.detail.noneSubnets', 'None')}</span>
  ));

  return (
    <div className="bg-bg-secondary rounded-xl p-5 shadow-[var(--shadow-card)]">
      <h2 className="text-sm font-semibold text-text-primary mb-3 flex items-center gap-2">
        <Network size={15} className="text-accent" /> {t('probesPage.detail.networkCard', 'Network & last scan')}
      </h2>
      <InfoRow
        label={t('probesPage.detail.lastScan', 'Last scan')}
        value={probe.lastScanAt ? (
          <span title={new Date(probe.lastScanAt).toLocaleString()}>{formatRelative(probe.lastScanAt, t)}</span>
        ) : (
          <span className="text-text-muted">{t('probesPage.detail.noScanYet', 'No scan reported yet')}</span>
        )}
      />
      <InfoRow
        label={t('probesPage.detail.scanDuration', 'Duration')}
        value={probe.lastScanDurationMs != null
          ? (probe.lastScanDurationMs < 1000
            ? t('probesPage.detail.durationMs', { count: probe.lastScanDurationMs, defaultValue: '{{count}} ms' })
            : formatSeconds(Math.round(probe.lastScanDurationMs / 1000), t))
          : none}
      />
      <InfoRow
        label={t('probesPage.detail.devicesFound', 'Devices found')}
        value={probe.lastScanDeviceCount != null ? probe.lastScanDeviceCount : none}
      />
      <InfoRow
        label={t('probesPage.detail.scannedSubnets', 'Scanned subnets')}
        value={probe.lastScanAt ? subnetValue(scanned) : none}
      />
      {skipped.length > 0 && (
        <InfoRow
          label={t('probesPage.detail.skippedSubnets', 'Skipped subnets')}
          value={(
            <span className="flex flex-col gap-1">
              {skipped.map((s) => (
                <span key={s.cidr} className="flex flex-wrap items-center gap-2">
                  <SubnetChips subnets={[s.cidr]} tone="warn" />
                  <span className="text-xs text-text-muted">{skippedReasonLabel(s.reason, t)}</span>
                </span>
              ))}
            </span>
          )}
        />
      )}
      <InfoRow
        label={t('probesPage.detail.lastPushError', 'Last push error')}
        value={probe.lastPushErrorCode ? (
          <span className={clsx('flex flex-wrap items-center gap-x-2', errorIsStale ? 'text-text-muted' : 'text-red-400')}>
            <span>{pushErrorLabel(probe.lastPushErrorCode, t)}</span>
            {probe.lastPushErrorAt && (
              <span className="text-xs text-text-muted" title={new Date(probe.lastPushErrorAt).toLocaleString()}>
                {formatRelative(probe.lastPushErrorAt, t)}
                {errorIsStale && ` · ${t('probesPage.detail.pushErrorRecovered', 'scans accepted since')}`}
              </span>
            )}
          </span>
        ) : (
          <span className="text-text-muted">{t('probesPage.detail.noPushError', 'None')}</span>
        )}
      />

      {effective && (
        <div className="mt-4 border-t border-border pt-3">
          <h3 className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-text-muted">
            <GitBranch size={12} /> {t('probesPage.detail.appliedConfig', 'Configuration sent to the probe')}
          </h3>
          {([
            ['scanIntervalSeconds', t('probesPage.detail.scanIntervalShort', 'Scan interval'), formatSeconds(effective.config.scanIntervalSeconds, t)],
            ['excludedSubnets', t('probesPage.detail.excludedSubnets', 'Excluded subnets'), subnetValue(effective.config.excludedSubnets)],
            ['extraSubnets', t('probesPage.detail.extraSubnets', 'Extra subnets'), subnetValue(effective.config.extraSubnets)],
            ['portScanEnabled', t('probesPage.detail.portScanEnabled', 'Port scan'), effective.config.portScanEnabled
              ? t('probesPage.detail.portScanOn', { count: effective.config.portScanPorts.length, defaultValue: 'On ({{count}} ports)' })
              : t('common.off', 'Off')],
            ['flowAnalysisEnabled', t('probesPage.detail.flowAnalysis', 'Flow analysis'), effective.config.flowAnalysisEnabled
              ? t('common.on', 'On')
              : t('common.off', 'Off')],
          ] as Array<[ProbeEffectiveScanKey, string, React.ReactNode]>).map(([key, label, value]) => (
            <InfoRow
              key={key}
              label={label}
              value={(
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  {value}
                  <span className="text-xs text-text-muted">
                    {t('probesPage.detail.fromSource', {
                      source: effective.sources[key] ? sourceLabel(effective.sources[key], t) : '—',
                      defaultValue: 'from {{source}}',
                    })}
                  </span>
                </span>
              )}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

/** Editable fields of the settings card (compared to detect unsaved edits). */
interface ProbeForm {
  name: string;
  scanInterval: number;
  siteId: number | null;
  scanConfig: ProbeScanConfig;
}

function formOf(p: Probe): ProbeForm {
  return {
    name: p.name ?? '',
    scanInterval: p.scanIntervalSeconds,
    siteId: p.siteId ?? null,
    scanConfig: p.scanConfig,
  };
}

function sameScanConfig(a: ProbeScanConfig, b: ProbeScanConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameForm(a: ProbeForm, b: ProbeForm): boolean {
  return a.name === b.name
    && (a.scanInterval === b.scanInterval || (Number.isNaN(a.scanInterval) && Number.isNaN(b.scanInterval)))
    && a.siteId === b.siteId
    && sameScanConfig(a.scanConfig, b.scanConfig);
}

/** Older probes (and servers) without the flag used their own scan config. */
function probeOverridesSettings(p: Probe): boolean {
  return p.scanConfigOverride ?? true;
}

/** A refused probe update names a too-wide extra subnet (service error or validation issue). */
function isSubnetTooWide(err: unknown): boolean {
  const body = apiErrorBody(err);
  if (body?.error === 'subnet_too_wide') return true;
  const issues = body?.issues;
  return Array.isArray(issues) && issues.some((i) => (i as { message?: unknown } | null)?.message === 'subnet_too_wide');
}

/**
 * Probe-level settings the server reads for a probe (resolveForProbe): the
 * effective scan config, and the probe-offline alerting. Other keys
 * (flow analysis, device processing, device checks…) are read from the site
 * chain only, so a probe-level value would have no effect.
 */
const PROBE_SETTINGS_KEYS: readonly SettingsKey[] = [
  'scanIntervalSeconds',
  'excludedSubnets',
  'extraSubnets',
  'portScanEnabled',
  'portScanPorts',
  'offlineThresholdMultiplier',
  'probeOfflineGraceMinutes',
  'notificationEnabled',
  'notifyProbeOffline',
];

/** Banner of a delivered uninstall: countdown to the record's deletion, with Cancel. */
function UninstallBanner({
  uninstallCommandedAt,
  canCancel,
  onCancel,
}: {
  uninstallCommandedAt: string;
  canCancel: boolean;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const remaining = useUninstallRemaining(uninstallCommandedAt) ?? 0;
  return (
    <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl bg-orange-500/10 px-4 py-3">
      <Clock size={16} className="shrink-0 text-orange-400" />
      <p className="min-w-0 flex-1 text-sm text-orange-300">
        {remaining > 0
          ? t('probesPage.detail.uninstallBanner', 'Uninstall sent: the probe removes itself and its record is deleted in {{time}}.', { time: formatMmSs(remaining) })
          : t('probesPage.detail.uninstallBannerDue', 'Uninstall sent: the record is deleted at the next cleanup (every 5 minutes).')}
        <span className="block text-xs text-text-muted">
          {t('probesPage.detail.uninstallCancelHint', 'Cancel keeps the record; a probe that already removed itself does not come back.')}
        </span>
      </p>
      {canCancel && (
        <Button type="button" variant="secondary" size="sm" onClick={onCancel} className="gap-1.5">
          <Ban size={14} /> {t('probesPage.detail.cancelUninstall', 'Cancel uninstall')}
        </Button>
      )}
    </div>
  );
}

export function ProbeDetailPage() {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const confirm = useConfirm();
  // Server-enforced: the page opens with probes.read;
  // approve / refuse / suspend / unsuspend take probes.approve; settings,
  // commands, token reset and delete take probes.manage (implies the
  // others). The cross-app device links route stays platform-admin only.
  const isAdmin = useTenantCapability('probes.manage');
  const canApprove = useTenantCapability('probes.approve');
  const isPlatformAdmin = useAuthStore((s) => s.user?.role === 'admin');

  const [probe, setProbe] = useState<Probe | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);

  // Sites list (for assignment)
  const [sites, setSites] = useState<Site[]>([]);
  // Approval site picker (keys are loaded on demand: the key's default site decides)
  const [approveTarget, setApproveTarget] = useState<Probe | null>(null);

  // Editable state
  const [name, setName] = useState('');
  const [scanInterval, setScanInterval] = useState(300);
  const [selectedSiteId, setSelectedSiteId] = useState<number | null>(null);
  const [scanConfig, setScanConfig] = useState<ProbeScanConfig>({
    excludedSubnets: [],
    extraSubnets: [],
  });
  // Values the form was last filled from: a live reload refills the form
  // only while it holds no unsaved edit.
  const formBaseRef = useRef<ProbeForm | null>(null);
  const currentForm: ProbeForm = { name, scanInterval, siteId: selectedSiteId, scanConfig };
  const currentFormRef = useRef(currentForm);
  currentFormRef.current = currentForm;

  // The scan config exactly as the probe receives it (with its sources).
  const [effective, setEffective] = useState<ProbeEffectiveScanConfig | null>(null);
  const canManageSettings = useTenantCapability('settings');

  const [crossAppLinks, setCrossAppLinks] = useState<Array<{ appType: string; name: string; url: string; color: string | null }>>([]);

  const probeId = parseInt(id ?? '0', 10);

  const fillForm = useCallback((p: Probe) => {
    const form = formOf(p);
    formBaseRef.current = form;
    setName(form.name);
    setScanInterval(form.scanInterval);
    setSelectedSiteId(form.siteId);
    setScanConfig(form.scanConfig);
  }, []);

  /**
   * The effective scan config (informational: a failure leaves the previous
   * view). It resolves the whole settings chain server side, so it is not
   * refetched on every push: see load() and the settings listener below.
   */
  const effectiveFpRef = useRef<string | null>(null);
  const refreshEffective = useCallback(() => {
    const epoch = useTenantStore.getState().epoch;
    probeApi.getEffectiveScanConfig(probeId)
      .then((e) => { if (useTenantStore.getState().epoch === epoch) setEffective(e); })
      .catch(() => { /* not shown */ });
  }, [probeId]);

  /**
   * `resetForm`: refill the settings form (initial load, after a save).
   * Otherwise (live reload) the form is refilled only when it is unchanged.
   */
  const load = useCallback(async (opts: { resetForm?: boolean; silent?: boolean } = {}) => {
    const epoch = useTenantStore.getState().epoch;
    try {
      const { probe: p } = await probeApi.get(probeId);
      if (useTenantStore.getState().epoch !== epoch) return;
      setProbe(p);
      // Refetched when what decides the effective config changed (a live
      // reload after a push usually changes nothing of it).
      const fp = JSON.stringify([p.siteId ?? null, p.scanConfigOverride ?? null, p.scanIntervalSeconds, p.scanConfig, p.status]);
      if (opts.resetForm || fp !== effectiveFpRef.current) {
        effectiveFpRef.current = fp;
        refreshEffective();
      }
      setNotFound(false);
      setLoadFailed(false);
      const base = formBaseRef.current;
      if (opts.resetForm || !base || sameForm(base, currentFormRef.current)) fillForm(p);
    } catch (err) {
      const status = (err as { response?: { status?: number } } | null)?.response?.status;
      if (status === 404 || status === 400) {
        setProbe(null);
        setNotFound(true);
      } else if (!opts.silent) {
        setLoadFailed(true);
      }
    } finally {
      setLoading(false);
    }
  }, [probeId, fillForm, refreshEffective]);

  // Settings saved anywhere in the tenant (site, group, global, this probe)
  // may change the effective config: refetch it, debounced.
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onSettingsUpdated = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; refreshEffective(); }, 500);
    };
    socket.on(SOCKET_EVENTS.SETTINGS_UPDATED, onSettingsUpdated);
    return () => {
      if (timer) clearTimeout(timer);
      socket.off(SOCKET_EVENTS.SETTINGS_UPDATED, onSettingsUpdated);
    };
  }, [refreshEffective]);

  useEffect(() => {
    formBaseRef.current = null;
    setLoading(true);
    void load({ resetForm: true });
  }, [load]);

  // Live updates: this probe's socket events, tenant switch, reconnect, 60 s fallback poll.
  const silentReload = useCallback(() => { void load({ silent: true }); }, [load]);
  useProbeLiveRefresh(silentReload, { probeId, resync: true });

  // Load sites once
  useEffect(() => {
    siteApi.list().then(({ sites: s }) => setSites(s)).catch(() => {});
  }, []);

  // Links to the same machine in the other Obli* apps (admin-only route; 404
  // while Obligate SSO is disabled): through apiClient for the ObliTools token.
  useEffect(() => {
    if (!probe?.uuid || !isPlatformAdmin) {
      setCrossAppLinks([]);
      return;
    }
    let cancelled = false;
    apiClient.get('/auth/device-links', { params: { uuid: probe.uuid } })
      .then((r) => {
        const d = r.data as { success?: boolean; data?: unknown };
        if (cancelled || !d?.success || !Array.isArray(d.data)) return;
        setCrossAppLinks((d.data as Array<{ appType: string; name: string; url: string; color: string | null }>)
          // Only http(s) links are rendered as anchors.
          .filter((l) => l && typeof l.url === 'string' && /^https?:\/\//i.test(l.url)));
      })
      .catch(() => { /* no links */ });
    return () => { cancelled = true; };
  }, [probe?.uuid, isPlatformAdmin]);

  async function handleSave() {
    if (!probe) return;
    const base = formBaseRef.current ?? formOf(probe);
    const overriding = probeOverridesSettings(probe);
    // The probe's own scan config is sent only while it is in use, and only
    // the parts that changed (a stored legacy value, e.g. 30 s, is kept as
    // it is when only the name or the site is edited).
    const intervalChanged = overriding && scanInterval !== base.scanInterval;
    if (intervalChanged && !isValidScanInterval(scanInterval)) {
      toast.error(t('probesPage.detail.scanIntervalRange', {
        min: SCAN_INTERVAL_MIN_SECONDS,
        max: SCAN_INTERVAL_MAX_SECONDS,
        defaultValue: 'Enter a whole number of seconds between {{min}} and {{max}}.',
      }));
      return;
    }
    const scanConfigChanged = overriding && !sameScanConfig(scanConfig, base.scanConfig);
    setSaving(true);
    try {
      await probeApi.update(probeId, {
        name: name.trim() || undefined,
        siteId: selectedSiteId,
        ...(intervalChanged ? { scanIntervalSeconds: scanInterval } : {}),
        ...(scanConfigChanged ? { scanConfig } : {}),
      });
      toast.success(t('probesPage.updated', 'Probe updated'));
      void load({ resetForm: true });
    } catch (err) {
      if (isHandled(err)) return;
      if (isSubnetTooWide(err)) {
        toast.error(t('settings.panel.subnetTooWide', 'Subnets wider than /16 cannot be scanned: split them into /16 or smaller subnets'));
      } else {
        toastApiError(err, t('probesPage.failedSave', 'Failed to save'));
      }
    } finally {
      setSaving(false);
    }
  }

  /** Stops using the probe's own scan config: it follows the site / group settings. */
  async function handleFollowSiteSettings() {
    const ok = await confirm({
      title: t('probesPage.detail.followSiteSettings', 'Follow site settings'),
      message: t(
        'probesPage.detail.followSiteSettingsConfirm',
        'Use the scan settings of the site and its groups for this probe? Its own scan interval, subnets and port scan are no longer applied; probe-level values can still be set in the settings of this page.',
      ),
      confirmLabel: t('probesPage.detail.followSiteSettings', 'Follow site settings'),
    });
    if (!ok) return;
    await setScanConfigOverride(false);
  }

  /** Back to the probe's own scan config (stored interval, subnets, port scan). */
  async function handleUseOwnScanConfig() {
    const ok = await confirm({
      title: t('probesPage.detail.useOwnScanConfig', 'Use own scan configuration'),
      message: t(
        'probesPage.detail.useOwnScanConfigConfirm',
        'Use the scan interval, subnets and port scan stored for this probe instead of the settings of its site and groups? Changes to those settings no longer reach it.',
      ),
      confirmLabel: t('probesPage.detail.useOwnScanConfig', 'Use own scan configuration'),
    });
    if (!ok) return;
    await setScanConfigOverride(true);
  }

  /**
   * Live-style reload afterwards: unsaved name / site edits of the settings
   * card are kept (the form is refilled only while it is pristine).
   */
  async function setScanConfigOverride(override: boolean) {
    setBusy(true);
    try {
      await probeApi.update(probeId, { scanConfigOverride: override });
      toast.success(override
        ? t('probesPage.detail.usingOwnScanConfig', 'The probe now uses its own scan configuration')
        : t('probesPage.detail.followingSiteSettings', 'The probe now follows the site settings'));
      void load();
    } catch (err) {
      toastApiError(err, t('probesPage.failedSave', 'Failed to save'));
    } finally {
      setBusy(false);
    }
  }

  async function doApprove(target: Probe, siteId?: number) {
    setBusy(true);
    try {
      const { probe: updated } = await probeApi.approve(target.id, siteId);
      toast.success(t('probesPage.approved', 'Probe approved'));
      if (!updated.siteId) {
        toast(t('probesPage.approvedNoSite', 'Approved without a site: its scans are ignored until a site is assigned'), { icon: '⚠️' });
      }
      setApproveTarget(null);
      void load({ resetForm: true });
    } catch (err) {
      toastApiError(err, t('probesPage.failedApprove', 'Failed to approve probe'));
    } finally {
      setBusy(false);
    }
  }

  async function handleApprove() {
    if (!probe) return;
    if (probe.siteId) { await doApprove(probe); return; }
    // The API key's default site is applied by the server: ask only when there is none.
    // Listing the keys takes probes.manage: without it the default is unknown, so ask.
    let keys: ProbeApiKey[] = [];
    if (isAdmin) {
      try {
        keys = (await probeApi.listKeys()).keys;
      } catch { /* unknown default: ask */ }
    }
    if (approveNeedsSite(probe, keys)) setApproveTarget(probe);
    else await doApprove(probe);
  }

  async function handleRefuse() {
    const ok = await confirm({
      message: t('probesPage.confirmRefuse', 'Refuse this probe?'),
      confirmLabel: t('probesPage.detail.refuse', 'Refuse'),
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await probeApi.refuse(probeId);
      toast.success(t('probesPage.refused', 'Probe refused'));
      void load();
    } catch (err) {
      toastApiError(err, t('probesPage.failedRefuse', 'Failed to refuse probe'));
    } finally {
      setBusy(false);
    }
  }

  async function handleSuspend() {
    const ok = await confirm({
      title: t('probesPage.suspend', 'Suspend'),
      message: t('probesPage.confirmSuspend', 'Suspend this probe? It is disconnected and refused until it is unsuspended; its site and settings are kept.'),
      confirmLabel: t('probesPage.suspend', 'Suspend'),
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await probeApi.suspend(probeId);
      toast.success(t('probesPage.suspended', 'Probe suspended'));
      void load();
    } catch (err) {
      if (isProbeNotApproved(err)) toast.error(t('probesPage.suspendNotApproved', 'Only an approved probe can be suspended'));
      else toastApiError(err, t('probesPage.failedSuspend', 'Failed to suspend the probe'));
    } finally {
      setBusy(false);
    }
  }

  async function handleUnsuspend() {
    setBusy(true);
    try {
      await probeApi.unsuspend(probeId);
      toast.success(t('probesPage.unsuspended', 'Probe unsuspended'));
      void load();
    } catch (err) {
      toastApiError(err, t('probesPage.failedUnsuspend', 'Failed to unsuspend the probe'));
    } finally {
      setBusy(false);
    }
  }

  async function handleCommand(command: string) {
    const confirmLabels: Record<string, string> = {
      uninstall: t('probesPage.detail.confirmUninstallNow', 'Uninstall this probe? It removes itself and its record is deleted after 10 minutes.'),
      update:    t('probesPage.detail.confirmUpdateNow', 'Update this probe to the server\'s version?'),
      rescan:    t('probesPage.detail.confirmRescanNow', 'Run a scan now?'),
    };
    const ok = await confirm({
      title: probeCommandLabel(command, t),
      message: confirmLabels[command] ?? t('probesPage.sendCommandConfirm', 'Send command: {{command}}?', { command }),
      confirmLabel: probeCommandLabel(command, t),
      danger: command === 'uninstall',
    });
    if (!ok) return;
    setBusy(true);
    try {
      if (await sendProbeCommand(probeId, command, t)) void load();
    } finally {
      setBusy(false);
    }
  }

  async function handleCancelCommand() {
    setBusy(true);
    try {
      await cancelProbeCommand({ id: probeId, uninstallCommandedAt: probe?.uninstallCommandedAt ?? null }, t);
      void load();
    } finally {
      setBusy(false);
    }
  }

  async function handleTogglePrimary() {
    if (!probe) return;
    try {
      await probeApi.update(probeId, { isPrimary: !probe.isPrimary });
      toast.success(probe.isPrimary ? t('probesPage.detail.demoted', 'Demoted to secondary') : t('probesPage.detail.promoted', 'Promoted to primary'));
      void load();
    } catch (err) { toastApiError(err, t('probesPage.failedSave', 'Failed to save')); }
  }

  async function handleDelete() {
    const ok = await confirm({
      title: t('probesPage.detail.deleteBtn', 'Delete probe'),
      message: t('probesPage.confirmDelete', 'Delete this probe?'),
      danger: true,
    });
    if (!ok) return;
    try {
      await probeApi.remove(probeId);
      toast.success(t('probesPage.deleted', 'Probe deleted'));
      navigate(PROBES_LIST_URL);
    } catch (err) { toastApiError(err, t('probesPage.failedDelete', 'Failed to delete probe')); }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48">
        <Loader2 className="animate-spin text-accent" size={28} />
      </div>
    );
  }

  if (!probe) {
    return (
      <PageContainer backTo={PROBES_LIST_URL} title={t('probesPage.title', 'Probes')}>
        {loadFailed && !notFound ? (
          <LoadError message={t('probesPage.failedLoad', 'Failed to load probes')} onRetry={() => { setLoading(true); void load({ resetForm: true }); }} />
        ) : (
          <EmptyState
            icon={<AlertTriangle className="h-6 w-6" />}
            title={t('probesPage.notFound', 'Probe not found')}
            action={(
              <Link to={PROBES_LIST_URL} className="text-sm text-accent hover:underline">
                {t('probesPage.backLink', 'Back to probes')}
              </Link>
            )}
          />
        )}
      </PageContainer>
    );
  }

  const displayName = anonymize(probe.name ?? probe.hostname, 'hostname');
  const subLine = [
    anonymize(probe.hostname, 'hostname'),
    probe.ip ? anonymize(probe.ip, 'ip') : null,
    probe.probeVersion ? `v${probe.probeVersion}` : null,
  ].filter(Boolean).join(' · ');
  const siteName = probe.siteId ? (sites.find((s) => s.id === probe.siteId)?.name ?? null) : null;
  // Pending probes get commands too (in the 202 push reply / over WS): only refused / suspended ones cannot.
  const commandsAllowed = isAdmin && canReceiveCommands(probe);
  const overriding = probeOverridesSettings(probe);

  return (
    <PageContainer className="space-y-6">
      <PageHeader
        backTo={PROBES_LIST_URL}
        backLabel={t('probesPage.backToProbes', 'Back to Probes')}
        title={displayName}
        className="mb-0"
        actions={(
          <>
            {crossAppLinks.map(link => (
              <a
                key={link.appType}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                title={t('probesPage.openInApp', 'Open in {{app}}', { app: link.name })}
                className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium transition-colors"
                style={{ color: link.color ?? '#58a6ff', backgroundColor: `${link.color ?? '#58a6ff'}1a` }}
              >
                <ArrowLeftRight size={12} />
                {link.name}
              </a>
            ))}
            {canApprove && probe.status === 'pending' && (
              <>
                <Button
                  size="sm"
                  onClick={() => void handleApprove()}
                  disabled={busy}
                  className="gap-1.5"
                >
                  <CheckCircle size={14} /> {t('probesPage.detail.approve', 'Approve')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void handleRefuse()}
                  disabled={busy}
                  className="gap-1.5 text-red-400"
                >
                  <XCircle size={14} /> {t('probesPage.detail.refuse', 'Refuse')}
                </Button>
              </>
            )}
            {canApprove && probe.status === 'refused' && (
              <Button
                size="sm"
                onClick={() => void handleApprove()}
                disabled={busy}
                className="gap-1.5"
              >
                <CheckCircle size={14} /> {t('probesPage.detail.reApprove', 'Re-approve')}
              </Button>
            )}
            {canApprove && probe.status === 'approved' && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleSuspend()}
                disabled={busy}
                className="gap-1.5"
              >
                <PauseCircle size={14} /> {t('probesPage.suspend', 'Suspend')}
              </Button>
            )}
            {canApprove && probe.status === 'suspended' && (
              <Button
                size="sm"
                onClick={() => void handleUnsuspend()}
                disabled={busy}
                className="gap-1.5"
              >
                <PlayCircle size={14} /> {t('probesPage.unsuspend', 'Unsuspend')}
              </Button>
            )}
          </>
        )}
      >
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <ProbeStatusBadge probe={probe} size="md" showApproval />
          <span className="inline-flex items-center gap-1 rounded-full bg-bg-tertiary px-2.5 py-1 text-xs text-text-secondary">
            <Clock size={11} />
            {probe.lastSeenAt
              ? <LastSeen ts={probe.lastSeenAt} />
              : t('common.never', 'Never')}
          </span>
          {probe.siteId && (
            <span className={clsx(
              'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium',
              probe.isPrimary ? 'bg-accent/15 text-accent' : 'bg-bg-tertiary text-text-secondary',
            )}>
              {probe.isPrimary ? t('probesPage.detail.primary', 'Primary') : t('probesPage.detail.secondary', 'Secondary')}
            </span>
          )}
          {probe.status === 'approved' && (
            <span
              className={clsx(
                'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium',
                probe.wsConnected ? 'bg-blue-500/15 text-blue-400' : 'bg-bg-tertiary text-text-secondary',
              )}
              title={probe.wsConnected
                ? t('probesPage.detail.transportWs', 'Connected over WebSocket: commands are delivered immediately')
                : t('probesPage.detail.transportHttp', 'HTTP mode: commands wait for the next push')}
            >
              {probe.wsConnected ? 'WS' : 'HTTP'}
            </span>
          )}
          {probe.status === 'approved' && !probe.siteId && <NoSiteBadge className="py-1" />}
          {probe.pendingCommand && (
            <span className="inline-flex items-center gap-1 rounded-full bg-yellow-500/15 py-0.5 pl-2.5 pr-1 text-xs font-medium text-yellow-400">
              <AlertTriangle size={11} />
              {t('probesPage.detail.queuedPill', 'Queued: {{command}}', { command: probeCommandLabel(probe.pendingCommand, t) })}
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => void handleCancelCommand()}
                  disabled={busy}
                  className="ml-1 rounded-full px-2 py-0.5 text-yellow-300 hover:bg-yellow-500/20 disabled:opacity-50"
                >
                  {t('common.cancel', 'Cancel')}
                </button>
              )}
            </span>
          )}
        </div>
        {subLine && <p className="mt-2 font-mono text-sm text-text-muted">{subLine}</p>}
      </PageHeader>

      {probe.uninstallCommandedAt && (
        <UninstallBanner
          uninstallCommandedAt={probe.uninstallCommandedAt}
          canCancel={isAdmin}
          onCancel={() => void handleCancelCommand()}
        />
      )}

      {/* Info card */}
      <div className="bg-bg-secondary rounded-xl p-5 shadow-[var(--shadow-card)]">
        <h2 className="text-sm font-semibold text-text-primary mb-3 flex items-center gap-2">
          <Monitor size={15} className="text-accent" /> {t('probesPage.detail.probeInfo', 'Probe Info')}
        </h2>
        <InfoRow label={t('probesPage.detail.hostname', 'Hostname')} value={anonymize(probe.hostname, 'hostname')} />
        <InfoRow
          label={t('probesPage.detail.uuid', 'UUID')}
          value={<span className="font-mono text-xs">{anonymize(probe.uuid)}</span>}
        />
        <InfoRow
          label={t('probesPage.detail.ip', 'IP address')}
          value={probe.ip ? <span className="font-mono">{anonymize(probe.ip, 'ip')}</span> : null}
        />
        {probe.ips && probe.ips.length > 0 && (
          <InfoRow
            label={t('probesPage.detail.allIps', 'All IP addresses')}
            value={<span className="font-mono">{probe.ips.map((ip) => anonymize(ip, 'ip')).join(', ')}</span>}
          />
        )}
        <InfoRow
          label={t('probesPage.detail.mac', 'MAC address')}
          value={probe.mac ? <span className="font-mono">{anonymize(probe.mac, 'mac')}</span> : null}
        />
        <InfoRow
          label={t('probesPage.detail.platform', 'Platform')}
          value={
            probe.osInfo
              ? `${String(probe.osInfo.platform ?? '')} ${String(probe.osInfo.arch ?? '')} ${probe.osInfo.release ? `(${String(probe.osInfo.release)})` : ''}`
              : null
          }
        />
        <InfoRow
          label={t('probesPage.detail.version', 'Version')}
          value={probe.probeVersion ? (
            <span className="inline-flex flex-wrap items-center gap-2">
              <span className={clsx(probe.updateAvailable && 'text-amber-400')}>v{probe.probeVersion}</span>
              {probe.latestVersion && (
                <span className="text-xs text-text-muted">
                  {probe.updateAvailable
                    ? t('probesPage.detail.serverShips', 'server ships v{{version}}', { version: probe.latestVersion })
                    : t('probesPage.detail.upToDate', 'up to date')}
                </span>
              )}
            </span>
          ) : null}
        />
        {effective?.updatePolicy && (
          <InfoRow
            label={t('probesPage.detail.updatePolicy', 'Update policy')}
            value={(
              <span>
                {updatePolicyLabel(effective.updatePolicy.policy, t)}
                <span className="ml-2 text-xs text-text-muted">
                  {t('probesPage.detail.fromSource', { source: sourceLabel(effective.updatePolicy, t), defaultValue: 'from {{source}}' })}
                </span>
              </span>
            )}
          />
        )}
        {probe.lastUpdateError && (
          <InfoRow
            label={t('probesPage.detail.lastUpdateError', 'Last update error')}
            value={(
              <span className="text-red-400">
                {probe.lastUpdateTarget
                  ? t('probesPage.detail.lastUpdateErrorTarget', 'Update to v{{version}} failed: {{error}}', {
                    version: probe.lastUpdateTarget,
                    error: updateErrorLabel(probe.lastUpdateError, t),
                  })
                  : updateErrorLabel(probe.lastUpdateError, t)}
                {probe.lastUpdateErrorAt && (
                  <span className="ml-2 text-xs text-text-muted">{new Date(probe.lastUpdateErrorAt).toLocaleString()}</span>
                )}
              </span>
            )}
          />
        )}
        <InfoRow
          label={t('probesPage.detail.apiKey', 'API key')}
          value={probe.apiKeyName ?? (probe.apiKeyId ? t('probesPage.detail.apiKeyNumber', 'Key #{{id}}', { id: probe.apiKeyId }) : null)}
        />
        <InfoRow
          label={t('probesPage.detail.lastSeen', 'Last seen')}
          value={
            probe.lastSeenAt
              ? new Date(probe.lastSeenAt).toLocaleString()
              : t('common.never', 'Never')
          }
        />
        {probe.offlineSince && (
          <InfoRow
            label={t('probesPage.detail.offlineSince', 'Offline since')}
            value={<span className="text-text-secondary">{new Date(probe.offlineSince).toLocaleString()}</span>}
          />
        )}
        <InfoRow
          label={t('probesPage.detail.createdAt', 'Registered')}
          value={probe.createdAt ? new Date(probe.createdAt).toLocaleString() : null}
        />
        <InfoRow
          label={t('probesPage.detail.approvedAt', 'Approved')}
          value={probe.approvedAt ? new Date(probe.approvedAt).toLocaleString() : null}
        />
        <InfoRow
          label={t('probesPage.detail.assignedSite', 'Assigned site')}
          value={
            probe.siteId
              ? (
                <Link to={`/sites/${probe.siteId}`} className="text-accent hover:underline">
                  {siteName
                    ? anonymize(siteName, 'hostname')
                    : t('probesPage.siteNumber', 'Site #{{id}}', { id: probe.siteId })}
                </Link>
              )
              : (probe.status === 'approved' ? <NoSiteBadge /> : '—')
          }
        />
        {probe.updatingSince && (
          <InfoRow
            label={t('probesPage.detail.updatingSince', 'Updating since')}
            value={new Date(probe.updatingSince).toLocaleString()}
          />
        )}
      </div>

      {/* Device checks card */}
      <DeviceChecksCard
        probe={probe}
        siteName={probe.siteId ? (sites.find((s) => s.id === probe.siteId)?.name ?? null) : null}
        isAdmin={isAdmin}
        onUpdateProbe={() => void handleCommand('update')}
        onChanged={() => void load()}
      />

      {/* Network & last scan card */}
      <NetworkScanCard probe={probe} effective={effective} />

      {/* Settings card */}
      <div className="bg-bg-secondary rounded-xl p-5 shadow-[var(--shadow-card)]">
        <h2 className="text-sm font-semibold text-text-primary mb-4 flex items-center gap-2">
          <Activity size={15} className="text-accent" /> {t('probesPage.detail.scanSettings', 'Scan settings')}
        </h2>

        {!isAdmin && (
          <p className="mb-4 text-xs text-text-muted">
            {t('probesPage.detail.readOnlySettings', 'Changing the settings of a probe needs the Manage probes permission.')}
          </p>
        )}
        <fieldset disabled={!isAdmin} className="m-0 min-w-0 space-y-5 border-0 p-0">
          {overriding ? (
            <div role="status" className="flex flex-wrap items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5">
              <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-400" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-amber-300">
                  {t('probesPage.detail.overridesBanner', 'This probe overrides the site settings')}
                </p>
                <p className="mt-0.5 text-xs text-text-muted">
                  {t('probesPage.detail.overridesBannerDesc', 'It uses its own scan interval, subnets and port scan below: changes to the scan settings of its site, groups or the global settings do not reach it.')}
                </p>
              </div>
              {isAdmin && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => void handleFollowSiteSettings()}
                  disabled={busy}
                  className="shrink-0 gap-1.5"
                >
                  <GitBranch size={14} /> {t('probesPage.detail.followSiteSettings', 'Follow site settings')}
                </Button>
              )}
            </div>
          ) : (
            <div className="flex flex-wrap items-start gap-3 rounded-lg border border-accent/20 bg-accent/5 px-3 py-2">
              <p className="flex min-w-0 flex-1 items-start gap-2 text-xs text-accent/80">
                <Info size={14} className="mt-0.5 shrink-0" />
                {t('probesPage.detail.followsSiteSettings', 'This probe follows the scan settings of its site, groups and the global settings. Values set in the probe settings below apply to this probe only.')}
              </p>
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => void handleUseOwnScanConfig()}
                  disabled={busy}
                  className="flex shrink-0 items-center gap-1.5 text-xs text-text-secondary hover:text-accent disabled:opacity-50"
                >
                  <Activity size={13} /> {t('probesPage.detail.useOwnScanConfig', 'Use own scan configuration')}
                </button>
              )}
            </div>
          )}

          {/* Display name */}
          <div>
            <label className="text-sm text-text-muted block mb-2">
              {t('probesPage.detail.displayName')}
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full bg-bg-tertiary border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-accent"
              placeholder={anonymize(probe.hostname, 'hostname')}
            />
          </div>

          {/* Site assignment */}
          <div>
            <label className="text-sm text-text-muted block mb-2">
              {t('probesPage.detail.assignedSite')}
            </label>
            <select
              value={selectedSiteId ?? ''}
              onChange={(e) => setSelectedSiteId(e.target.value ? parseInt(e.target.value, 10) : null)}
              className="w-full bg-bg-tertiary border border-border rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-accent"
            >
              <option value="">{t('probesPage.detail.noSite')}</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>{anonymize(s.name, 'hostname')}</option>
              ))}
            </select>
          </div>

          {/* Own scan config: only while the probe overrides the settings chain */}
          {overriding && (
            <>
              <ScanIntervalInput
                value={scanInterval}
                baseValue={formBaseRef.current?.scanInterval ?? probe.scanIntervalSeconds}
                onChange={setScanInterval}
              />
              {probe.scanIntervalSeconds < SCAN_INTERVAL_MIN_SECONDS && (
                <p className="-mt-3 text-xs text-text-muted">
                  {t('probesPage.detail.scanIntervalClamped', {
                    stored: probe.scanIntervalSeconds,
                    min: SCAN_INTERVAL_MIN_SECONDS,
                    defaultValue: 'Stored value {{stored}} s is below the minimum: the probe scans every {{min}} s.',
                  })}
                </p>
              )}

              {/* Excluded subnets */}
              <SubnetListEditor
                label={t('probesPage.detail.excludedSubnets')}
                value={scanConfig.excludedSubnets}
                onChange={(v) => setScanConfig((c) => ({ ...c, excludedSubnets: v }))}
                placeholder="10.0.0.0/8"
              />

              {/* Extra subnets */}
              <SubnetListEditor
                label={t('probesPage.detail.extraSubnets')}
                value={scanConfig.extraSubnets}
                onChange={(v) => setScanConfig((c) => ({ ...c, extraSubnets: v }))}
                placeholder="172.16.50.0/24"
              />
              <p className="-mt-3 text-xs text-text-muted">
                {t('probesPage.detail.extraSubnetsHint', { prefix: SCAN_SUBNET_MIN_PREFIX, defaultValue: 'Extra subnets can be at most /{{prefix}} wide.' })}
              </p>

              {/* Port scan */}
              <div className="border-t border-border pt-4">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <p className="text-sm text-text-primary font-medium">{t('probesPage.detail.portScanEnabled')}</p>
                    <p className="text-xs text-text-muted mt-0.5">{t('probesPage.detail.portScanDesc')}</p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={scanConfig.portScanEnabled ?? false}
                    onClick={() => {
                      const enabling = !(scanConfig.portScanEnabled ?? false);
                      setScanConfig((c) => ({
                        ...c,
                        portScanEnabled: enabling,
                        portScanPorts: enabling && (!c.portScanPorts || c.portScanPorts.length === 0)
                          ? DEFAULT_PORT_SCAN_PORTS
                          : c.portScanPorts,
                      }));
                    }}
                    className={clsx(
                      'relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none',
                      (scanConfig.portScanEnabled ?? false) ? 'bg-accent' : 'bg-bg-tertiary',
                    )}
                  >
                    <span
                      className={clsx(
                        'inline-block h-4 w-4 rounded-full bg-white shadow transition-transform',
                        (scanConfig.portScanEnabled ?? false) ? 'translate-x-6' : 'translate-x-1',
                      )}
                    />
                  </button>
                </div>
                {(scanConfig.portScanEnabled ?? false) && (
                  <div>
                    <label className="text-sm text-text-muted block mb-2">{t('probesPage.detail.portScanPorts')}</label>
                    <PortListEditor
                      value={scanConfig.portScanPorts ?? []}
                      onChange={(v) => setScanConfig((c) => ({ ...c, portScanPorts: v }))}
                    />
                    <div className="mt-2">
                      <button
                        type="button"
                        onClick={() => setScanConfig((c) => ({ ...c, portScanPorts: DEFAULT_PORT_SCAN_PORTS }))}
                        className="text-xs text-accent hover:underline"
                      >
                        {t('probesPage.detail.portScanReset')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {isAdmin && (
            <div className="flex justify-end pt-2">
              <Button
                size="sm"
                onClick={() => void handleSave()}
                disabled={saving}
                className="gap-1.5"
              >
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                {t('probesPage.detail.saveChanges')}
              </Button>
            </div>
          )}
        </fieldset>
      </div>

      {/* Probe-level settings (inherited from the site chain) */}
      {!overriding && (
        canManageSettings ? (
          <SettingsPanel
            scope="monitor"
            scopeId={probe.id}
            title={t('probesPage.detail.probeSettings', 'Probe settings (inherited from the site)')}
            keys={PROBE_SETTINGS_KEYS}
            onSaved={refreshEffective}
          />
        ) : (
          <div className="rounded-xl bg-bg-secondary p-4 text-sm text-text-muted shadow-[var(--shadow-card)]">
            {t('probesPage.detail.probeSettingsNoAccess', 'Editing the scan settings of this probe needs the Settings permission.')}
          </div>
        )
      )}

      {/* Commands card */}
      {isAdmin && (
        <div className="bg-bg-secondary rounded-xl p-5 shadow-[var(--shadow-card)]">
          <h2 className="text-sm font-semibold text-text-primary mb-4 flex items-center gap-2">
            <Globe size={15} className="text-accent" /> {t('probesPage.detail.commands', 'Commands')}
          </h2>
          <p className="text-text-muted text-xs mb-4">
            {commandsAllowed
              ? t('probesPage.detail.commandsDescLive', 'A probe connected over WebSocket receives commands immediately; otherwise they are queued until its next contact (within one scan interval).')
              : t('probesPage.detail.commandsRefusedSuspended', 'A refused or suspended probe cannot receive commands.')}
          </p>
          <div className="flex flex-wrap gap-2">
            {probe.siteId && probe.status === 'approved' && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleTogglePrimary()}
                disabled={busy}
                className={clsx('gap-1.5', probe.isPrimary && 'text-accent')}
              >
                <Crown size={14} />
                {probe.isPrimary
                  ? t('probesPage.detail.demoteToPrimary', 'Demote to secondary')
                  : t('probesPage.detail.promoteToPrimary', 'Promote to primary')}
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleCommand('rescan')}
              disabled={busy || !commandsAllowed}
              className="gap-1.5"
            >
              <RefreshCw size={14} /> {t('probesPage.detail.forceRescan', 'Force rescan')}
            </Button>
            {/* Hidden when the probe already runs the server's version (an older
                server sends no updateAvailable: the button stays). */}
            {probe.updateAvailable !== false && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleCommand('update')}
                disabled={busy || !commandsAllowed || !!probe.updatingSince}
                className="gap-1.5"
              >
                <RefreshCw size={14} />
                {probe.updateAvailable && probe.latestVersion
                  ? t('probesPage.updateTo', 'Update to v{{version}}', { version: probe.latestVersion })
                  : t('probesPage.detail.updateProbe', 'Update probe')}
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleCommand('uninstall')}
              disabled={busy || !commandsAllowed || probe.pendingCommand === 'uninstall' || !!probe.uninstallCommandedAt}
              className="gap-1.5 text-red-400 hover:bg-red-500/10"
            >
              <Trash2 size={14} /> {t('probesPage.detail.uninstall', 'Uninstall')}
            </Button>
            {probe.pendingCommand && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void handleCancelCommand()}
                disabled={busy}
                className="gap-1.5"
              >
                <Ban size={14} />
                {t('probesPage.detail.cancelQueued', 'Cancel queued {{command}}', { command: probeCommandLabel(probe.pendingCommand, t) })}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Danger zone */}
      {isAdmin && (
        <div className="bg-bg-secondary border border-red-500/20 rounded-xl p-5 shadow-[var(--shadow-card)]">
          <h2 className="text-sm font-semibold text-red-400 mb-3 flex items-center gap-2">
            <AlertTriangle size={15} /> {t('probesPage.detail.dangerZone', 'Danger zone')}
          </h2>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-text-primary text-sm font-medium">{t('probesPage.detail.deleteRecord', 'Delete probe record')}</p>
              <p className="text-text-muted text-xs">{t('probesPage.detail.deleteRecordDesc', 'Removes the probe from Oblimap. Discovered devices remain in their site.')}</p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleDelete()}
              className="shrink-0 gap-1.5 text-red-400 hover:bg-red-500/10"
            >
              <Trash2 size={14} /> {t('probesPage.detail.deleteBtn', 'Delete probe')}
            </Button>
          </div>
        </div>
      )}

      <ApproveSiteModal
        probe={approveTarget}
        sites={sites}
        onClose={() => setApproveTarget(null)}
        onApprove={(target, siteId) => doApprove(target, siteId)}
      />
    </PageContainer>
  );
}
