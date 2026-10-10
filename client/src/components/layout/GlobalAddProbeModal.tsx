import { useState, useEffect, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import { Key, Copy, Check, ChevronDown, Monitor, Terminal, Apple, Radar, Download, Plus, Router } from 'lucide-react';
import type { ProbeApiKey } from '@oblimap/shared';
import { probeApi } from '@/api/probe.api';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { IconButton } from '@/components/common/IconButton';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { Input } from '@/components/common/Input';
import { useUiStore } from '@/store/uiStore';
import { useTenantCapability } from '@/store/authStore';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { copyText } from '@/utils/clipboard';
import { downloadUrl } from '@/utils/download';
import { toastApiError } from '@/utils/apiError';
import { useAnonymize } from '@/utils/anonymize';

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    // Clipboard API → execCommand fallback (plain-http origins, ObliTools
    // iframe). Copying is the point of this modal: a failure must be visible.
    const ok = await copyText(text);
    if (!ok) {
      toast.error(t('common.copyFailed', 'Could not copy — select and copy manually'));
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <IconButton
      label={t('common.copy', 'Copy')}
      onClick={handleCopy}
      size="sm"
      className="shrink-0"
      icon={copied ? <Check size={14} className="text-status-up" /> : <Copy size={14} />}
    />
  );
}

function CommandBlock({ cmd }: { cmd: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md bg-bg-tertiary p-3">
      <code className="flex-1 text-xs font-mono text-text-primary break-all whitespace-pre-wrap leading-relaxed select-all">{cmd}</code>
      <CopyButton text={cmd} />
    </div>
  );
}

type OsTab = 'windows' | 'linux' | 'macos' | 'freebsd' | 'mikrotik';
type WindowsVariant = 'modern' | 'oldtls' | 'manual';
type MikrotikArch = 'arm64' | 'arm' | 'amd64';

/** Random password for the read-only RouterOS user (letters + digits: no quoting issue in RouterOS scripts). */
function randomRouterPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

/**
 * RouterOS v7 commands: a veth on a dedicated bridge, a read-only REST user
 * limited to the container subnet, then the probe container (image served by
 * this server, no registry).
 */
function mikrotikScript(base: string, key: string, arch: MikrotikArch, password: string): string {
  const image = `oblimap-probe-container-${arch}.tar`;
  return [
    '/interface/veth/add name=veth-oblimap address=172.17.0.2/24 gateway=172.17.0.1',
    '/interface/bridge/add name=br-oblimap',
    '/interface/bridge/port/add bridge=br-oblimap interface=veth-oblimap',
    '/ip/address/add address=172.17.0.1/24 interface=br-oblimap',
    '/ip/firewall/nat/add chain=srcnat action=masquerade src-address=172.17.0.0/24 comment=oblimap-probe',
    '/certificate/add name=oblimap-rest common-name=172.17.0.1',
    '/certificate/sign oblimap-rest',
    '/ip/service/set www-ssl certificate=oblimap-rest disabled=no',
    '/user/group/add name=oblimap-read policy=read,rest-api',
    `/user/add name=oblimap group=oblimap-read address=172.17.0.0/24 password=${password}`,
    `/container/envs/add name=oblimap key=OBLIMAP_SERVER value="${base}"`,
    `/container/envs/add name=oblimap key=OBLIMAP_KEY value="${key}"`,
    '/container/envs/add name=oblimap key=OBLIMAP_ROUTEROS_URL value="https://172.17.0.1"',
    '/container/envs/add name=oblimap key=OBLIMAP_ROUTEROS_USER value="oblimap"',
    `/container/envs/add name=oblimap key=OBLIMAP_ROUTEROS_PASSWORD value="${password}"`,
    '/container/envs/add name=oblimap key=OBLIMAP_ROUTEROS_INSECURE value="1"',
    '/container/mounts/add name=oblimap-cfg src=/oblimap/config dst=/etc/oblimap-probe',
    `/tool/fetch url="${base}/api/probe/download/${image}" dst-path=${image}`,
    `/container/add file=${image} interface=veth-oblimap root-dir=oblimap/root envlist=oblimap mounts=oblimap-cfg start-on-boot=yes logging=yes`,
    '/container/start [find interface=veth-oblimap]',
  ].join('\n');
}

const MSI_PATH = '/api/probe/installer/windows.msi';
const MSI_FILENAME = 'oblimap-probe.msi';

/** Quick-install modal for the Oblimap probe (Obliance GlobalAddAgentModal pattern). */
export function GlobalAddProbeModal() {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const { addProbeModalOpen, closeAddProbeModal } = useUiStore();
  const canManageProbes = useTenantCapability('probes.manage');

  const [keys, setKeys] = useState<ProbeApiKey[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [selectedKeyId, setSelectedKeyId] = useState<number | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [osTab, setOsTab] = useState<OsTab>('windows');
  const [windowsVariant, setWindowsVariant] = useState<WindowsVariant>('modern');
  const [mikrotikArch, setMikrotikArch] = useState<MikrotikArch>('arm64');
  const [routerPassword, setRouterPassword] = useState(randomRouterPassword);
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [newKeyName, setNewKeyName] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!addProbeModalOpen) return;
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    setDropdownOpen(false);
    setNewKeyName('');
    setServerUrl(null);
    setRouterPassword(randomRouterPassword());
    if (!canManageProbes) {
      // Both routes need probes.manage: do not trigger the missing-capability toast.
      setKeys([]);
      setSelectedKeyId(null);
      setLoadFailed(true);
      setLoading(false);
      return;
    }
    probeApi.listKeys()
      .then(({ keys: k }) => {
        if (cancelled) return;
        setKeys(k);
        setSelectedKeyId(k.length === 1 ? k[0].id : null);
      })
      .catch(() => {
        if (cancelled) return;
        setKeys([]);
        setSelectedKeyId(null);
        setLoadFailed(true);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    // The URL the installers write into their scripts (APP_URL unless
    // loopback); the browser origin when the server has none to offer.
    probeApi.installInfo()
      .then(({ serverUrl: url }) => { if (!cancelled) setServerUrl(url); })
      .catch(() => { /* fallback: window.location.origin */ });
    return () => { cancelled = true; };
  }, [addProbeModalOpen, canManageProbes]);

  if (!addProbeModalOpen) return null;

  const base = (serverUrl ?? window.location.origin).replace(/\/+$/, '');
  const selectedKey = keys.find((k) => k.id === selectedKeyId) ?? null;

  const handleCreateKey = async (e: FormEvent) => {
    e.preventDefault();
    const name = newKeyName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      const { key } = await probeApi.createKey(name);
      setKeys((prev) => [...prev, key]);
      setSelectedKeyId(key.id);
      setNewKeyName('');
      toast.success(t('addProbe.keyCreated', 'API key created'));
    } catch (err) {
      toastApiError(err, t('addProbe.keyCreateFailed', 'Failed to create the API key'));
    } finally {
      setCreating(false);
    }
  };

  const onMsiClick = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    void downloadUrl(MSI_PATH, MSI_FILENAME).then((ok) => {
      if (!ok) toast.error(t('addProbe.downloadFailed', 'Download failed'));
    });
  };

  // Install commands. The API key is passed as --key (or an msiexec property),
  // never in the URL: it would end up in proxy and access logs.
  let commands: { linux: string; macos: string; freebsd: string; windows: string; msiexec: string; mikrotik: string } | null = null;
  if (selectedKey) {
    const key = selectedKey.key;
    const msiUrl = `${base}${MSI_PATH}`;
    const windowsModern = `$m="$env:TEMP\\oblimap-probe.msi"; Invoke-WebRequest "${msiUrl}" -OutFile $m -UseBasicParsing; Start-Process msiexec -ArgumentList "/i \`"$m\`" SERVERURL=\`"${base}\`" APIKEY=\`"${key}\`" /quiet" -Wait -Verb RunAs; Remove-Item $m`;
    commands = {
      linux: `curl -fsSL "${base}/api/probe/installer/linux" | bash -s -- --key ${key}`,
      macos: `sudo bash -c "$(curl -fsSL '${base}/api/probe/installer/macos')" -- --key ${key}`,
      freebsd: `fetch -o - "${base}/api/probe/installer/freebsd" | sh -s -- --key ${key}`,
      windows: windowsVariant === 'oldtls'
        ? `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; ${windowsModern}`
        : windowsModern,
      msiexec: `msiexec /i ${MSI_FILENAME} SERVERURL="${base}" APIKEY="${key}" /quiet`,
      mikrotik: mikrotikScript(base, key, mikrotikArch, routerPassword),
    };
  }

  const osTabs: Array<{ id: OsTab; label: string; icon: ReactNode }> = [
    { id: 'windows', label: t('addProbe.osWindows', 'Windows'), icon: <Monitor size={14} /> },
    { id: 'linux', label: t('addProbe.osLinux', 'Linux'), icon: <Terminal size={14} /> },
    { id: 'macos', label: t('addProbe.osMacos', 'macOS'), icon: <Apple size={14} /> },
    { id: 'freebsd', label: t('addProbe.osFreebsd', 'FreeBSD'), icon: <Terminal size={14} /> },
    { id: 'mikrotik', label: t('addProbe.osMikrotik', 'MikroTik'), icon: <Router size={14} /> },
  ];

  const windowsHint = windowsVariant === 'oldtls'
    ? t('addProbe.windowsOldTlsHint', 'Run in PowerShell (admin) — older Windows (Server 2012 R2 / 2016, PowerShell 5.1) where TLS 1.2 is not enabled by default')
    : windowsVariant === 'manual'
      ? t('addProbe.windowsManualHint', 'Download the MSI, copy it to the target host, then run this command from an elevated prompt in the folder that holds the MSI')
      : t('addProbe.windowsHint', 'Run in PowerShell (admin) — Windows 10 / 11, Server 2019 and later');

  const osHint: Record<Exclude<OsTab, 'windows' | 'mikrotik'>, string> = {
    linux: t('addProbe.linuxHint', 'Run as root — Linux (amd64 / arm64)'),
    macos: t('addProbe.macosHint', 'Run in Terminal — macOS (Apple Silicon / Intel)'),
    freebsd: t('addProbe.freebsdHint', 'Run as root — FreeBSD / OPNsense / pfSense (amd64)'),
  };

  const renderNoKey = () => {
    if (loadFailed && !canManageProbes) {
      return (
        <div className="text-center py-8">
          <Key size={28} className="mx-auto mb-2 text-text-muted" />
          <p className="text-sm text-text-muted">
            {t('addProbe.noAccess', 'You cannot read the probe API keys of this workspace. Ask a workspace administrator, or a member whose role grants "Manage probes".')}
          </p>
        </div>
      );
    }
    if (loadFailed) {
      return (
        <div className="text-center py-8">
          <Key size={28} className="mx-auto mb-2 text-text-muted" />
          <p className="text-sm text-text-muted">{t('addProbe.loadFailed', 'Could not load the probe API keys.')}</p>
        </div>
      );
    }
    if (!canManageProbes) {
      return (
        <div className="text-center py-8">
          <Key size={28} className="mx-auto mb-2 text-text-muted" />
          <p className="text-sm text-text-muted">
            {t('addProbe.noKeysNoRight', 'No probe API key exists yet. A workspace administrator, or a member whose role grants "Manage probes", must create one first.')}
          </p>
        </div>
      );
    }
    return (
      <form onSubmit={handleCreateKey} className="space-y-3 py-2">
        <div className="flex items-start gap-3">
          <Key size={20} className="mt-0.5 shrink-0 text-text-muted" />
          <p className="text-sm text-text-secondary">
            {t('addProbe.noKeys', 'A probe authenticates with an API key of this workspace. Create one to get the install commands.')}
          </p>
        </div>
        <div className="flex items-end gap-2 max-sm:flex-col max-sm:items-stretch">
          <div className="flex-1">
            <Input
              id="add-probe-new-key-name"
              label={t('addProbe.keyName', 'API key name')}
              placeholder={t('addProbe.keyNamePlaceholder', 'e.g. Head office')}
              value={newKeyName}
              maxLength={128}
              onChange={(e) => setNewKeyName(e.target.value)}
              autoFocus
            />
          </div>
          <Button type="submit" loading={creating} disabled={!newKeyName.trim()}>
            <Plus size={14} className="mr-1.5" />
            {t('addProbe.createKey', 'Create key')}
          </Button>
        </div>
      </form>
    );
  };

  return (
    <Modal
      open
      onClose={closeAddProbeModal}
      size="lg"
      icon={<Radar size={16} className="text-accent" />}
      title={t('addProbe.title', 'Add a probe')}
      bodyClassName="px-4 py-3 space-y-5"
      footer={
        <Button variant="secondary" onClick={closeAddProbeModal}>
          {t('common.close', 'Close')}
        </Button>
      }
    >
      <p className="text-xs text-text-muted">
        {t('addProbe.subtitle', 'Install the Oblimap probe on a host of the network to map and point it at this server.')}
      </p>

      {loading ? (
        <p className="py-8 text-center text-sm text-text-muted">{t('common.loading', 'Loading…')}</p>
      ) : keys.length === 0 ? (
        renderNoKey()
      ) : (
        <>
          {/* API key selector */}
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-text-muted uppercase">{t('addProbe.selectKey', 'API key')}</span>
            <div>
              <button
                type="button"
                onClick={() => setDropdownOpen((o) => !o)}
                aria-expanded={dropdownOpen}
                className="w-full flex items-center gap-2 px-3 py-2.5 bg-bg-tertiary rounded-lg text-sm text-left hover:bg-bg-hover transition-colors"
              >
                <Key size={14} className="text-accent shrink-0" />
                {selectedKey ? (
                  <div className="flex-1 min-w-0 flex items-center gap-2 max-sm:flex-wrap max-sm:gap-y-0.5">
                    <span className="font-medium text-text-primary truncate">{selectedKey.name}</span>
                    <code className="text-xs text-text-muted font-mono">{selectedKey.key.slice(0, 8)}...{selectedKey.key.slice(-4)}</code>
                    {selectedKey.defaultSiteName && (
                      <span className="text-xs text-accent truncate">→ {anonymize(selectedKey.defaultSiteName)}</span>
                    )}
                  </div>
                ) : (
                  <span className="flex-1 text-text-muted">{t('addProbe.chooseKey', 'Choose an API key…')}</span>
                )}
                <ChevronDown size={14} className="text-text-muted shrink-0" />
              </button>
              {dropdownOpen && (
                <div className="mt-1 bg-bg-tertiary rounded-lg overflow-hidden max-h-60 overflow-y-auto" role="listbox">
                  {keys.map((k) => (
                    <button
                      key={k.id}
                      type="button"
                      role="option"
                      aria-selected={selectedKeyId === k.id}
                      onClick={() => { setSelectedKeyId(k.id); setDropdownOpen(false); }}
                      className={`w-full flex items-center gap-2 px-3 py-2.5 text-sm text-left transition-colors max-sm:flex-wrap ${
                        selectedKeyId === k.id ? 'bg-accent/10 text-accent' : 'text-text-primary hover:bg-bg-hover'
                      }`}
                    >
                      <Key size={14} className={selectedKeyId === k.id ? 'text-accent' : 'text-text-muted'} />
                      <span className="font-medium truncate">{k.name}</span>
                      <code className="text-xs text-text-muted font-mono ml-auto">{k.key.slice(0, 8)}...</code>
                      {k.defaultSiteName && (
                        <span className="text-xs text-text-muted truncate">→ {anonymize(k.defaultSiteName)}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Install commands (once a key is selected) */}
          {selectedKey && commands ? (
            <div className="space-y-3">
              <SegmentedTabs
                tabs={osTabs}
                value={osTab}
                onChange={setOsTab}
                size="sm"
                ariaLabel={t('addProbe.osTabs', 'Operating system')}
              />

              <div className="rounded-lg bg-bg-primary/50 p-4 space-y-2">
                {osTab === 'windows' ? (
                  <>
                    <div className="flex items-center justify-between gap-2 max-sm:flex-col-reverse max-sm:items-stretch">
                      <p className="text-xs font-medium text-text-muted">{windowsHint}</p>
                      <select
                        value={windowsVariant}
                        onChange={(e) => setWindowsVariant(e.target.value as WindowsVariant)}
                        aria-label={t('addProbe.windowsVariant', 'Windows version')}
                        className="shrink-0 text-[11px] bg-bg-tertiary rounded px-1.5 py-1 text-text-muted border border-border"
                      >
                        <option value="modern">{t('addProbe.optionModern', 'Windows 10+ / Server 2019+')}</option>
                        <option value="oldtls">{t('addProbe.optionOldTls', 'Older Windows (TLS 1.2)')}</option>
                        <option value="manual">{t('addProbe.optionManual', 'Manual (MSI download)')}</option>
                      </select>
                    </div>
                    {windowsVariant === 'manual' ? (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2 rounded-md bg-bg-tertiary p-3 max-sm:flex-col max-sm:items-stretch">
                          <div className="flex-1 text-xs">
                            <div className="font-medium text-text-primary mb-0.5">{t('addProbe.msiTitle', 'Oblimap probe MSI')}</div>
                            <div className="text-text-muted leading-relaxed">
                              {t('addProbe.msiDescription', 'Windows installer (64-bit). The server URL and the API key are passed on the msiexec command line below.')}
                            </div>
                          </div>
                          <a
                            href={MSI_PATH}
                            download={MSI_FILENAME}
                            onClick={onMsiClick}
                            className="shrink-0 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md bg-accent text-white hover:bg-accent/80 transition-colors"
                          >
                            <Download size={13} />
                            {t('addProbe.msiDownload', 'Download MSI')}
                          </a>
                        </div>
                        <CommandBlock cmd={commands.msiexec} />
                      </div>
                    ) : (
                      <CommandBlock cmd={commands.windows} />
                    )}
                  </>
                ) : osTab === 'mikrotik' ? (
                  <>
                    <div className="flex items-center justify-between gap-2 max-sm:flex-col-reverse max-sm:items-stretch">
                      <p className="text-xs font-medium text-text-muted">
                        {t('addProbe.mikrotikHint', 'RouterOS v7 with the container package. The probe runs in a container and reads the router ARP / DHCP tables through the REST API (read-only user).')}
                      </p>
                      <select
                        value={mikrotikArch}
                        onChange={(e) => setMikrotikArch(e.target.value as MikrotikArch)}
                        aria-label={t('addProbe.mikrotikArch', 'Router architecture')}
                        className="shrink-0 text-[11px] bg-bg-tertiary rounded px-1.5 py-1 text-text-muted border border-border"
                      >
                        <option value="arm64">{t('addProbe.mikrotikArm64', 'ARM64 (RB5009, hAP ax, CCR2xxx)')}</option>
                        <option value="arm">{t('addProbe.mikrotikArm', 'ARM 32-bit')}</option>
                        <option value="amd64">{t('addProbe.mikrotikAmd64', 'x86 / CHR')}</option>
                      </select>
                    </div>
                    <p className="text-xs text-text-muted">
                      {t('addProbe.mikrotikStep1', '1. Once per router: enable container mode, then confirm it on the router (reset button or power cycle, as RouterOS asks).')}
                    </p>
                    <CommandBlock cmd="/system/device-mode/update container=yes" />
                    <p className="text-xs text-text-muted">
                      {t('addProbe.mikrotikStep2', '2. Paste in the router terminal. The password of the read-only "oblimap" user was generated for this router; adapt the 172.17.0.0/24 subnet and the oblimap/ disk paths when needed (e.g. usb1/oblimap on small flash).')}
                    </p>
                    <CommandBlock cmd={commands.mikrotik} />
                    <p className="text-xs text-text-muted">
                      {t('addProbe.mikrotikEnvsHint', 'RouterOS 7.20 and later name the env / mount lists with list= (and envlists= on the container) instead of name= / envlist=.')}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-xs font-medium text-text-muted">{osHint[osTab]}</p>
                    <CommandBlock cmd={commands[osTab]} />
                  </>
                )}
              </div>

              <p className="text-xs text-text-muted">
                {t('addProbe.serverUrl', 'Server URL used by the probe: {{url}}', { url: base })}
              </p>
              <p className="text-xs text-text-muted">
                {t('addProbe.afterInstall', 'The probe appears in the Probes page after its first push; approve it there and assign it a site.')}
              </p>
            </div>
          ) : (
            <p className="text-sm text-text-muted">{t('addProbe.pickKeyFirst', 'Pick an API key to see the install commands.')}</p>
          )}
        </>
      )}
    </Modal>
  );
}
