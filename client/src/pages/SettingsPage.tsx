import { useState, useEffect, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import {
  Shield, Server, Plus, Pencil, Trash2, Wifi, Eye, EyeOff, ArrowLeftRight, Info, Cpu, HardDrive,
  Database, Clock, SlidersHorizontal, ArrowRight, PackageOpen,
} from 'lucide-react';
import { useAuthStore, useTenantCapability, usePageAccess, PAGE_ACCESS } from '@/store/authStore';
import { smtpServerApi, type CreateSmtpServerRequest } from '@/api/smtpServer.api';
import {
  appConfigApi,
  OBLIGATE_INBOUND_SECRET_MAX,
  OBLIGATE_INBOUND_SECRET_MIN,
  type ObligateAdminConfig,
} from '@/api/appConfig.api';
import { systemApi, type SystemInfo } from '@/api/system.api';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { IconButton } from '@/components/common/IconButton';
import { Modal } from '@/components/common/Modal';
import { PageContainer, EmbeddedProvider } from '@/components/common/PageContainer';
import { TableScroll } from '@/components/common/TableScroll';
import { ToggleSwitch } from '@/components/common/ToggleSwitch';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Checkbox } from '@/components/ui/Checkbox';
import { ImportExportPage } from '@/pages/ImportExportPage';
import { apiErrorMessage, isHandled } from '@/utils/apiError';
import { openExternal } from '@/utils/openExternal';
import type { SmtpServer, AppConfig } from '@oblimap/shared';
import toast from 'react-hot-toast';
import { cn } from '@/utils/cn';

function AboutRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-xs text-text-muted">{label}</span>
      <span className="font-mono text-xs text-text-primary">{value}</span>
    </div>
  );
}

function AboutGroup({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted mb-3">
        {icon} {title}
      </p>
      {children}
    </div>
  );
}

/** Section heading of the page (h2 + optional icon and right-aligned actions). */
function SectionTitle({ icon, title, actions }: { icon?: ReactNode; title: string; actions?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 mb-4">
      <div className="flex items-center gap-2 min-w-0">
        {icon}
        <h2 className="text-lg font-semibold text-text-primary">{title}</h2>
      </div>
      {actions}
    </div>
  );
}

/** The server's refusal of an SMTP host below the platform level (SSRF screening). */
const SMTP_TARGET_NOT_ALLOWED = 'Target not allowed';

/** Card look of the page (borderless: depth from the background delta). */
const CARD = 'rounded-xl bg-bg-secondary';

type SmtpFormMode = 'create' | 'edit' | null;

interface SmtpForm {
  name: string;
  host: string;
  port: string;
  secure: boolean;
  username: string;
  password: string;
  fromAddress: string;
}

const emptySmtpForm = (): SmtpForm => ({
  name: '',
  host: '',
  port: '587',
  secure: false,
  username: '',
  password: '',
  fromAddress: '',
});

const SMTP_FORM_ID = 'settings-smtp-server-form';

export function SettingsPage() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { isAdmin } = useAuthStore();
  // Platform admin: About, Obligate SSO, security / 2FA (platform routes).
  const admin = isAdmin();
  // Tenant capabilities (enforced by the server on the same routes): the
  // tenant's default settings take 'settings', its SMTP servers
  // 'notifications.manage'. Platform and tenant admins hold both.
  const canManageSettings = useTenantCapability('settings');
  const canManageSmtp = useTenantCapability('notifications.manage');
  // Import / export carries settings, groups, sites, channels and teams: its
  // own (stricter) gate, the same as the standalone /manage/import-export page.
  const canImportExport = usePageAccess(PAGE_ACCESS.importExport);

  /** toast.error with the server's message or the fallback, unless the API client already reported it. */
  function toastError(err: unknown, fallback: string) {
    if (isHandled(err)) return;
    toast.error(apiErrorMessage(err, fallback));
  }

  /**
   * An SMTP request's error for the user: the server's message — with an
   * explanation for a host refused by the SSRF screening — or the fallback.
   */
  function toastSmtpError(err: unknown, fallback: string) {
    if (isHandled(err)) return;
    const msg = apiErrorMessage(err, fallback);
    if (msg === SMTP_TARGET_NOT_ALLOWED) {
      toast.error(t('settings.smtp.targetNotAllowed', 'Target not allowed: the SMTP host must be a public address. A private or internal mail relay must be listed in SSRF_ALLOWLIST by the platform administrator.'));
      return;
    }
    toast.error(msg);
  }

  // ── SMTP Servers ──
  const [servers, setServers] = useState<SmtpServer[]>([]);
  const [smtpMode, setSmtpMode] = useState<SmtpFormMode>(null);
  const [editingServer, setEditingServer] = useState<SmtpServer | null>(null);
  const [smtpForm, setSmtpForm] = useState<SmtpForm>(emptySmtpForm());
  const [showPassword, setShowPassword] = useState(false);
  const [smtpSaving, setSmtpSaving] = useState(false);
  const [testingId, setTestingId] = useState<number | null>(null);

  // ── App Config (2FA) ──
  const [appConfig, setAppConfig] = useState<AppConfig | null>(null);
  const [configSaving, setConfigSaving] = useState(false);

  // ── System info (About section) ──
  const [systemInfo, setSystemInfo]               = useState<SystemInfo | null>(null);
  const [systemInfoLoading, setSystemInfoLoading] = useState(false);

  // ── Obligate SSO Integration ──
  const [obligateCfg,     setObligateCfg]     = useState<ObligateAdminConfig | null>(null);
  const [obligateUrl,     setObligateUrl]     = useState('');
  const [obligateApiKey,  setObligateApiKey]  = useState('');
  const [showObligateKey, setShowObligateKey] = useState(false);
  // Optional inbound secret (unset: Obligate presents the API key)
  const [obligateInboundSecret, setObligateInboundSecret] = useState('');
  const [showInboundSecret,     setShowInboundSecret]     = useState(false);
  const [obligateSecretsSaving, setObligateSecretsSaving] = useState(false);

  useEffect(() => {
    if (!admin) return;
    setSystemInfoLoading(true);
    systemApi.getInfo().then(setSystemInfo).catch(() => {}).finally(() => setSystemInfoLoading(false));
    appConfigApi.getConfig().then(setAppConfig).catch(() => {});
    appConfigApi.getObligateConfig().then((cfg) => {
      setObligateCfg(cfg);
      setObligateUrl(cfg.url ?? '');
    }).catch(() => {});
  }, [admin]);

  useEffect(() => {
    if (!canManageSmtp) return;
    smtpServerApi.list().then(setServers).catch(() => {});
  }, [canManageSmtp]);

  async function saveObligateConfig() {
    try {
      const trimmedUrl = obligateUrl.trim().replace(/\/$/, '');
      if (trimmedUrl && trimmedUrl === window.location.origin.replace(/\/$/, '')) {
        toast.error(t('settings.obligate.selfUrl', 'The Obligate URL cannot point to this application. Enter the URL of your Obligate SSO gateway.'));
        return;
      }
      const patch: { url?: string | null; apiKey?: string | null; enabled?: boolean } = { url: trimmedUrl || null };
      if (obligateApiKey.trim()) patch.apiKey = obligateApiKey.trim();
      const updated = await appConfigApi.patchObligateConfig(patch);
      setObligateCfg(updated);
      setObligateApiKey('');
      toast.success(t('settings.obligate.secretsSaved', 'Obligate configuration saved'));
    } catch (err) {
      toastError(err, t('settings.obligate.secretsSaveFailed', 'Failed to save Obligate configuration'));
    }
  }

  // Inbound secret: saved on its own, never with the URL or the key (a failed
  // save must not touch the other fields).
  async function patchObligateSecrets(patch: { inboundSecret?: string | null }) {
    setObligateSecretsSaving(true);
    try {
      const updated = await appConfigApi.patchObligateConfig(patch);
      setObligateCfg(updated);
      if ('inboundSecret' in patch) {
        setObligateInboundSecret('');
        setShowInboundSecret(false);
      }
      toast.success(t('settings.obligate.secretsSaved', 'Obligate configuration saved'));
    } catch (err) {
      toastError(err, t('settings.obligate.secretsSaveFailed', 'Failed to save Obligate configuration'));
    } finally {
      setObligateSecretsSaving(false);
    }
  }

  // The inbound secret is only saved on an explicit action, after a warning:
  // once it is set, every Obligate call to this server must present it — an
  // Obligate that still sends the API key is refused (user deactivations and
  // deletions included) until it is configured to send this secret.
  async function saveInboundSecret() {
    const value = obligateInboundSecret.trim();
    if (!value) return;
    if (value.length < OBLIGATE_INBOUND_SECRET_MIN || value.length > OBLIGATE_INBOUND_SECRET_MAX || !/^[\x21-\x7e]+$/.test(value)) {
      toast.error(t('settings.obligate.inboundSecret.invalid', 'The inbound secret must be {{min}} to {{max}} visible characters long, without spaces.', {
        min: OBLIGATE_INBOUND_SECRET_MIN,
        max: OBLIGATE_INBOUND_SECRET_MAX,
      }));
      return;
    }
    const ok = await confirm({
      title: t('settings.obligate.inboundSecret.label', 'Inbound secret (optional)'),
      message: t(
        'settings.obligate.inboundSecret.confirmSet',
        'Set this inbound secret? From now on, Obligate calls to this server (user sync, app info, dashboard stats) must present it instead of the API key. Until Obligate is configured to send it, all of its calls are refused, including the deactivations and deletions of SSO users.',
      ),
      confirmLabel: t('settings.obligate.inboundSecret.set', 'Set'),
      danger: true,
    });
    if (!ok) return;
    await patchObligateSecrets({ inboundSecret: value });
  }

  async function clearInboundSecret() {
    const ok = await confirm({
      title: t('settings.obligate.inboundSecret.label', 'Inbound secret (optional)'),
      message: t(
        'settings.obligate.inboundSecret.confirmClear',
        'Clear the inbound secret? Obligate calls to this server must then present the API key again.',
      ),
      confirmLabel: t('settings.obligate.inboundSecret.clear', 'Clear'),
    });
    if (!ok) return;
    await patchObligateSecrets({ inboundSecret: null });
  }

  async function toggleObligateEnabled() {
    setConfigSaving(true);
    try {
      const newVal = !appConfig?.obligateEnabled;
      await appConfigApi.patchObligateConfig({ enabled: newVal });
      setAppConfig((prev) => prev ? { ...prev, obligateEnabled: newVal } : prev);
    } catch (err) {
      toastError(err, t('settings.failedUpdate', 'Failed to update setting'));
    } finally {
      setConfigSaving(false);
    }
  }

  function openCreate() {
    setEditingServer(null);
    setSmtpForm(emptySmtpForm());
    setShowPassword(false);
    setSmtpMode('create');
  }

  function openEdit(server: SmtpServer) {
    setEditingServer(server);
    setSmtpForm({
      name: server.name,
      host: server.host,
      port: String(server.port),
      secure: server.secure,
      username: server.username ?? '',
      password: '',
      fromAddress: server.fromAddress ?? '',
    });
    setShowPassword(false);
    setSmtpMode('edit');
  }

  function closeSmtpModal() {
    setSmtpMode(null);
    setEditingServer(null);
  }

  async function handleSmtpSubmit(e: FormEvent) {
    e.preventDefault();
    setSmtpSaving(true);
    try {
      const data: CreateSmtpServerRequest = {
        name: smtpForm.name,
        host: smtpForm.host,
        port: parseInt(smtpForm.port, 10),
        secure: smtpForm.secure,
        username: smtpForm.username,
        password: smtpForm.password,
        fromAddress: smtpForm.fromAddress,
      };
      if (smtpMode === 'create') {
        const created = await smtpServerApi.create(data);
        setServers((prev) => [...prev, created]);
        toast.success(t('settings.smtp.created'));
      } else if (editingServer) {
        const payload = smtpForm.password ? data : { ...data, password: undefined };
        const updated = await smtpServerApi.update(editingServer.id, payload);
        setServers((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
        toast.success(t('settings.smtp.updated'));
      }
      closeSmtpModal();
    } catch (err) {
      toastSmtpError(err, t('settings.smtp.failedSave'));
    } finally {
      setSmtpSaving(false);
    }
  }

  async function handleDelete(server: SmtpServer) {
    const ok = await confirm({
      message: t('settings.smtp.confirmDelete', 'Delete SMTP server "{{name}}"?', { name: server.name }),
      danger: true,
    });
    if (!ok) return;
    try {
      await smtpServerApi.delete(server.id);
      setServers((prev) => prev.filter((s) => s.id !== server.id));
      toast.success(t('settings.smtp.deleted'));
    } catch (err) {
      toastSmtpError(err, t('settings.smtp.failedDelete'));
    }
  }

  async function handleTest(server: SmtpServer) {
    setTestingId(server.id);
    try {
      await smtpServerApi.test(server.id);
      toast.success(t('settings.smtp.testOk', { name: server.name }));
    } catch (err: unknown) {
      // 'Connection failed' (details stay in the server log) or 'Target not allowed'.
      toastSmtpError(err, t('settings.smtp.testFailed'));
    } finally {
      setTestingId(null);
    }
  }

  async function setConfigKey(key: keyof AppConfig, value: boolean | number | null) {
    if (!appConfig) return;
    setConfigSaving(true);
    try {
      await appConfigApi.setConfig(key, value);
      setAppConfig((prev) => prev ? { ...prev, [key]: value } : prev);
    } catch (err) {
      toastError(err, t('settings.failedUpdate', 'Failed to update setting'));
    } finally {
      setConfigSaving(false);
    }
  }

  function formatUptime(seconds: number): string {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const parts: string[] = [];
    if (d > 0) parts.push(t('settings.about.uptimeDays', '{{n}}d', { n: d }));
    if (h > 0) parts.push(t('settings.about.uptimeHours', '{{n}}h', { n: h }));
    parts.push(t('settings.about.uptimeMinutes', '{{n}}m', { n: m }));
    return parts.join(' ');
  }

  const mb = (value: number) => t('settings.about.megabytes', '{{value}} MB', { value });

  return (
    <PageContainer
      title={t('settings.title', 'Global Settings')}
      subtitle={t('settings.globalDesc', 'These defaults apply to all groups and sites unless overridden at a lower level.')}
      className="space-y-8"
    >
      {/* ── About ── */}
      {admin && (
        <section>
          <SectionTitle icon={<Info size={18} className="text-accent" />} title={t('settings.about.title', 'About')} />
          <div className={cn(CARD, 'p-5')}>
            {systemInfoLoading ? (
              <p className="text-sm text-text-muted animate-pulse">{t('settings.about.loading', 'Loading system information…')}</p>
            ) : systemInfo ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-8 gap-y-6">
                <AboutGroup icon={<Server size={12} />} title={t('settings.about.versions', 'Versions')}>
                  <AboutRow label={t('settings.about.server', 'Server')} value={`v${systemInfo.appVersion}`} />
                  <AboutRow label={t('settings.about.probe', 'Probe')} value={`v${systemInfo.probeVersion}`} />
                  <AboutRow label={t('settings.about.node', 'Node.js')} value={systemInfo.nodeVersion} />
                </AboutGroup>
                <AboutGroup icon={<Clock size={12} />} title={t('settings.about.instance', 'Instance')}>
                  <AboutRow label={t('settings.about.uptime', 'Uptime')} value={formatUptime(systemInfo.uptimeSeconds)} />
                  <AboutRow
                    label={t('settings.about.environment', 'Environment')}
                    value={systemInfo.environment.isDocker ? t('settings.about.docker', 'Docker') : t('settings.about.native', 'Native')}
                  />
                  <AboutRow label={t('settings.about.platform', 'Platform')} value={systemInfo.environment.platform} />
                  <AboutRow label={t('settings.about.cpuCores', 'CPU cores')} value={String(systemInfo.cpu.cores)} />
                </AboutGroup>
                <AboutGroup icon={<HardDrive size={12} />} title={t('settings.about.memory', 'Memory')}>
                  <AboutRow label={t('settings.about.processRss', 'Process (RSS)')} value={mb(systemInfo.memory.processRssMb)} />
                  <AboutRow label={t('settings.about.heapUsed', 'Heap used')} value={mb(systemInfo.memory.processHeapMb)} />
                  <AboutRow
                    label={t('settings.about.systemFree', 'System free')}
                    value={t('settings.about.systemFreeValue', '{{free}} / {{total}} MB', {
                      free: systemInfo.memory.systemFreeMb,
                      total: systemInfo.memory.systemTotalMb,
                    })}
                  />
                </AboutGroup>
                <AboutGroup icon={<Cpu size={12} />} title={t('settings.about.cpuLoad', 'CPU load avg')}>
                  <AboutRow label={t('settings.about.load1', '1 min')} value={String(systemInfo.cpu.loadAvg1)} />
                  <AboutRow label={t('settings.about.load5', '5 min')} value={String(systemInfo.cpu.loadAvg5)} />
                  <AboutRow label={t('settings.about.load15', '15 min')} value={String(systemInfo.cpu.loadAvg15)} />
                </AboutGroup>
                <AboutGroup icon={<Database size={12} />} title={t('settings.about.database', 'Database')}>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-text-muted">{t('settings.about.postgresql', 'PostgreSQL')}</span>
                    <span className={cn(
                      'flex items-center gap-1.5 text-xs font-medium',
                      systemInfo.environment.dbStatus === 'ok' ? 'text-status-up' : 'text-status-down',
                    )}>
                      <span className={cn(
                        'h-1.5 w-1.5 rounded-full',
                        systemInfo.environment.dbStatus === 'ok' ? 'bg-status-up' : 'bg-status-down',
                      )} />
                      {systemInfo.environment.dbStatus === 'ok'
                        ? t('settings.about.dbConnected', 'Connected')
                        : t('settings.about.dbError', 'Error')}
                    </span>
                  </div>
                </AboutGroup>
              </div>
            ) : (
              <p className="text-sm text-text-muted">{t('settings.about.loadFailed', 'Could not load system information.')}</p>
            )}
          </div>
        </section>
      )}

      {/* ── Tenant default settings: edited in Policies → Default settings ── */}
      {canManageSettings && (
        <section>
          <SectionTitle
            icon={<SlidersHorizontal size={18} className="text-accent" />}
            title={t('settings.defaultSiteProbeSettings', 'Default site & probe settings (this tenant)')}
          />
          <div className={cn(CARD, 'p-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between')}>
            <p className="text-sm text-text-muted">
              {t('settings.defaultSiteProbeSettingsDesc', 'Scan interval, offline debounce, subnets, port scan, flow analysis, device checks, notification switches and business hours inherited by every group, site and probe of this tenant unless overridden at a lower level.')}
            </p>
            <Link
              to="/policies?tab=defaults"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover"
            >
              {t('settings.defaultSiteProbeSettingsLink', 'Open the default settings')}
              <ArrowRight size={14} />
            </Link>
          </div>
        </section>
      )}

      {/* ── SMTP Servers ── */}
      {canManageSmtp && (
        <section>
          <SectionTitle
            title={t('settings.smtp.title')}
            actions={(
              <Button size="sm" onClick={openCreate}>
                <Plus size={14} className="mr-1" /> {t('settings.smtp.addServer')}
              </Button>
            )}
          />
          {servers.length === 0 ? (
            <div className={cn(CARD, 'p-5 text-sm text-text-muted flex items-center gap-3')}>
              <Server size={16} className="shrink-0" />
              {t('settings.smtp.noServers')}
            </div>
          ) : (
            <TableScroll className="bg-bg-secondary">
              <table className="w-full min-w-[560px] text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className="px-4 py-2.5 font-medium text-text-secondary">{t('settings.smtp.colName')}</th>
                    <th className="px-4 py-2.5 font-medium text-text-secondary">{t('settings.smtp.colHost')}</th>
                    <th className="px-4 py-2.5 font-medium text-text-secondary">{t('settings.smtp.colFrom')}</th>
                    <th className="px-4 py-2.5 font-medium text-text-secondary text-right">{t('settings.smtp.colActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {servers.map((server) => (
                    <tr key={server.id} className="border-b border-border last:border-0 hover:bg-bg-hover transition-colors">
                      <td className="px-4 py-3 text-text-primary font-medium">{server.name}</td>
                      <td className="px-4 py-3 text-text-secondary">
                        {server.host}:{server.port}
                        {server.secure && <span className="ml-1.5 text-xs bg-green-500/10 text-green-400 rounded px-1">{t('settings.smtp.tlsBadge')}</span>}
                      </td>
                      <td className="px-4 py-3 text-text-muted">{server.fromAddress}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1.5">
                          <IconButton
                            label={t('settings.smtp.testConnection')}
                            icon={<Wifi size={14} />}
                            variant="accent"
                            onClick={() => void handleTest(server)}
                            disabled={testingId === server.id}
                          />
                          <IconButton
                            label={t('common.edit')}
                            icon={<Pencil size={14} />}
                            onClick={() => openEdit(server)}
                          />
                          <IconButton
                            label={t('common.delete')}
                            icon={<Trash2 size={14} />}
                            variant="danger"
                            onClick={() => void handleDelete(server)}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
          )}
        </section>
      )}

      {admin && (
        <>
          {/* ── Obligate SSO Gateway ── */}
          <section>
            <SectionTitle
              icon={<ArrowLeftRight size={16} className="text-text-muted" />}
              title={t('settings.obligate.title', 'Obligate SSO gateway')}
            />
            <div className={cn(CARD, 'p-5 space-y-4')}>
              <p className="text-sm text-text-muted">
                {t('settings.obligate.description', 'Connect this app to your Obligate SSO gateway for centralized authentication and cross-app navigation. Register this app in Obligate first, then paste the API key here.')}
              </p>
              <div className="bg-status-pending-bg rounded-md p-3 text-sm text-status-pending">
                {t('settings.obligate.warning', 'When enabled, local authentication is disabled. Users must sign in through the Obligate gateway. If the gateway becomes unreachable, local authentication is automatically restored as a fallback.')}
              </div>

              <div>
                <div className="flex items-center gap-2 mb-1">
                  <label htmlFor="obligate-url" className="text-sm font-medium text-text-secondary">
                    {t('settings.obligate.urlLabel', 'Obligate URL')}
                  </label>
                  {obligateCfg?.url && (
                    <a
                      href={obligateCfg.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => { e.preventDefault(); if (obligateCfg.url) void openExternal(obligateCfg.url); }}
                      className="text-xs text-accent hover:underline"
                    >
                      {t('settings.obligate.open', 'Open ↗')}
                    </a>
                  )}
                </div>
                <input
                  id="obligate-url"
                  type="url"
                  placeholder="https://obligate.example.com"
                  value={obligateUrl}
                  onChange={(e) => setObligateUrl(e.target.value)}
                  onBlur={() => void saveObligateConfig()}
                  className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30"
                />
              </div>

              <div>
                <label htmlFor="obligate-api-key" className="block text-sm font-medium text-text-secondary mb-1">
                  {t('settings.obligate.apiKeyLabel', 'API key')}
                  {obligateCfg?.apiKeySet && (
                    <span className="ml-2 text-[10px] font-semibold rounded px-1.5 py-0.5 bg-green-500/10 text-green-400">
                      {t('settings.obligate.setBadge', 'SET')}
                    </span>
                  )}
                </label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <input
                      id="obligate-api-key"
                      type={showObligateKey ? 'text' : 'password'}
                      placeholder={obligateCfg?.apiKeySet
                        ? '••••••••••••••••••••••••••••••••••••'
                        : t('settings.obligate.apiKeyPlaceholder', 'Paste the API key from Obligate…')}
                      value={obligateApiKey}
                      onChange={(e) => setObligateApiKey(e.target.value)}
                      onBlur={() => { if (obligateApiKey.trim()) void saveObligateConfig(); }}
                      autoComplete="off"
                      spellCheck={false}
                      className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 pr-8 text-sm font-mono text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30"
                    />
                    <button
                      type="button"
                      onClick={() => setShowObligateKey((v) => !v)}
                      aria-label={t('settings.obligate.toggleSecretVisibility', 'Show / hide')}
                      aria-pressed={showObligateKey}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
                    >
                      {showObligateKey ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </div>
                <p className="mt-1.5 text-xs text-text-muted">
                  <Trans
                    i18nKey="settings.obligate.apiKeyHint"
                    defaults="Generate this key in <b>Obligate → Connected Apps → Add App</b>."
                    components={{ b: <span className="text-text-secondary font-medium" /> }}
                  />
                </p>
              </div>

              {obligateCfg?.apiKeySet && (
                <>
                  {/* Optional distinct secret Obligate must present on its calls to this server (write-only) */}
                  <div>
                    <label htmlFor="obligate-inbound-secret" className="block text-sm font-medium text-text-secondary mb-1">
                      {t('settings.obligate.inboundSecret.label', 'Inbound secret (optional)')}
                      {obligateCfg.inboundSecretSet && (
                        <span className="ml-2 text-[10px] font-semibold rounded px-1.5 py-0.5 bg-green-500/10 text-green-400">
                          {t('settings.obligate.setBadge', 'SET')}
                        </span>
                      )}
                    </label>
                    <div className="flex gap-2">
                      <div className="relative flex-1">
                        <input
                          id="obligate-inbound-secret"
                          type={showInboundSecret ? 'text' : 'password'}
                          placeholder={obligateCfg.inboundSecretSet
                            ? '••••••••••••••••••••••••••••••••••••'
                            : t('settings.obligate.inboundSecret.placeholder', 'Empty: the API key is expected')}
                          value={obligateInboundSecret}
                          disabled={!!obligateCfg.inboundSecretFromEnv || obligateSecretsSaving}
                          maxLength={OBLIGATE_INBOUND_SECRET_MAX}
                          onChange={(e) => setObligateInboundSecret(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void saveInboundSecret(); } }}
                          autoComplete="off"
                          spellCheck={false}
                          className="w-full rounded-lg border border-border bg-bg-primary px-3 py-2 pr-8 text-sm font-mono text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-50"
                        />
                        <button
                          type="button"
                          onClick={() => setShowInboundSecret((v) => !v)}
                          aria-label={t('settings.obligate.toggleSecretVisibility', 'Show / hide')}
                          aria-pressed={showInboundSecret}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-primary"
                        >
                          {showInboundSecret ? <EyeOff size={14} /> : <Eye size={14} />}
                        </button>
                      </div>
                      {obligateInboundSecret.trim() && !obligateCfg.inboundSecretFromEnv && (
                        <Button type="button" size="sm" className="shrink-0" disabled={obligateSecretsSaving} onClick={() => void saveInboundSecret()}>
                          {t('settings.obligate.inboundSecret.set', 'Set')}
                        </Button>
                      )}
                      {obligateCfg.inboundSecretSet && !obligateCfg.inboundSecretFromEnv && (
                        <Button type="button" size="sm" variant="ghost" className="shrink-0" disabled={obligateSecretsSaving} onClick={() => void clearInboundSecret()}>
                          {t('settings.obligate.inboundSecret.clear', 'Clear')}
                        </Button>
                      )}
                    </div>
                    <p className="mt-1.5 text-xs text-text-muted">
                      {obligateCfg.inboundSecretFromEnv
                        ? t('settings.obligate.inboundSecret.fromEnv', 'Set by the OBLIGATE_INBOUND_SECRET environment variable.')
                        : t('settings.obligate.inboundSecret.hint', 'Secret that Obligate must present when it calls this server (user sync, app info, dashboard stats), {{min}} to {{max}} characters. It is never shown again once set. Leave it empty to keep expecting the API key. Set it only once Obligate is configured to send it: otherwise all of its calls are refused, and the deactivations and deletions of SSO users no longer reach this server.', {
                          min: OBLIGATE_INBOUND_SECRET_MIN,
                          max: OBLIGATE_INBOUND_SECRET_MAX,
                        })}
                    </p>
                  </div>
                </>
              )}

              {obligateCfg?.url && obligateCfg.apiKeySet && (
                <div className="pt-4 border-t border-border mt-4">
                  <ToggleSwitch
                    checked={appConfig?.obligateEnabled ?? false}
                    disabled={configSaving || !appConfig}
                    onChange={() => void toggleObligateEnabled()}
                    label={t('settings.obligate.enableSso', 'Enable SSO')}
                    description={t('settings.obligate.enableSsoDesc', 'When enabled, the login page redirects to Obligate for authentication. Users are auto-provisioned on first login. Cross-app navigation buttons appear in the header.')}
                  />
                </div>
              )}
            </div>
          </section>

          {/* ── Security / 2FA ── */}
          <section>
            <SectionTitle title={t('settings.security.title')} />
            <div className={cn(CARD, 'divide-y divide-border')}>
              <div className="flex items-start justify-between gap-4 p-4">
                <div className="flex items-start gap-3">
                  <Shield size={16} className="text-text-muted mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-text-primary">{t('settings.security.allow2fa')}</p>
                    <p className="text-xs text-text-muted mt-0.5">{t('settings.security.allow2faDesc')}</p>
                  </div>
                </div>
                <ToggleSwitch
                  checked={appConfig?.allow_2fa ?? false}
                  disabled={configSaving || !appConfig}
                  onChange={() => void setConfigKey('allow_2fa', !appConfig?.allow_2fa)}
                  ariaLabel={t('settings.security.allow2fa')}
                />
              </div>

              <div className={cn('flex items-start justify-between gap-4 p-4', !appConfig?.allow_2fa && 'opacity-50 pointer-events-none')}>
                <div className="flex items-start gap-3">
                  <Shield size={16} className="text-text-muted mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-text-primary">{t('settings.security.force2fa')}</p>
                    <p className="text-xs text-text-muted mt-0.5">
                      {t('settings.security.force2faDesc').split('\n')[0]}
                      {' '}
                      <Trans
                        i18nKey="settings.security.force2faBypass"
                        defaults="Bypass via <code>DISABLE_2FA_FORCE=true</code> in .env."
                        components={{ code: <code className="text-xs font-mono" /> }}
                      />
                    </p>
                  </div>
                </div>
                <ToggleSwitch
                  checked={appConfig?.force_2fa ?? false}
                  disabled={configSaving || !appConfig || !appConfig.allow_2fa}
                  onChange={() => void setConfigKey('force_2fa', !appConfig?.force_2fa)}
                  ariaLabel={t('settings.security.force2fa')}
                />
              </div>

              <div className={cn('flex items-start gap-4 p-4', !appConfig?.allow_2fa && 'opacity-50 pointer-events-none')}>
                <Server size={16} className="text-text-muted mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <label htmlFor="settings-otp-smtp" className="block text-sm font-medium text-text-primary">{t('settings.security.otpSmtp')}</label>
                  <p className="text-xs text-text-muted mt-0.5">{t('settings.security.otpSmtpDesc')}</p>
                  <select
                    id="settings-otp-smtp"
                    className="mt-2 w-full max-w-xs rounded-md border border-border bg-bg-primary px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
                    value={appConfig?.otp_smtp_server_id ?? ''}
                    disabled={configSaving || !appConfig || !appConfig.allow_2fa}
                    onChange={(e) => void setConfigKey('otp_smtp_server_id', e.target.value ? parseInt(e.target.value, 10) : null)}
                  >
                    <option value="">{t('settings.security.noneOption')}</option>
                    {servers.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </section>
        </>
      )}

      {/* ── Import / Export (same gate as /manage/import-export) ── */}
      {canImportExport && (
        <section>
          <SectionTitle
            icon={<PackageOpen size={18} className="text-accent" />}
            title={t('importExport.title', 'Import / Export')}
          />
          <p className="-mt-2 mb-4 text-sm text-text-muted">
            {t('importExport.description', 'Export your configuration to a portable JSON file, or import a previously saved file.')}
          </p>
          <EmbeddedProvider>
            <ImportExportPage />
          </EmbeddedProvider>
        </section>
      )}

      <Modal
        open={smtpMode !== null}
        onClose={closeSmtpModal}
        dismissible={!smtpSaving}
        closeOnBackdrop={false}
        title={smtpMode === 'create' ? t('settings.smtp.addTitle') : t('settings.smtp.editTitle')}
        size="sm"
        footer={(
          <>
            <Button type="button" variant="ghost" onClick={closeSmtpModal} disabled={smtpSaving}>{t('common.cancel')}</Button>
            <Button type="submit" form={SMTP_FORM_ID} disabled={smtpSaving}>
              {smtpSaving ? t('common.saving') : smtpMode === 'create' ? t('common.create') : t('common.save')}
            </Button>
          </>
        )}
      >
        <form id={SMTP_FORM_ID} onSubmit={handleSmtpSubmit} className="space-y-3">
          <Input
            label={t('settings.smtp.nameLabel')}
            value={smtpForm.name}
            onChange={(e) => setSmtpForm((f) => ({ ...f, name: e.target.value }))}
            placeholder={t('settings.smtp.namePlaceholder')}
            required
          />
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <Input
                label={t('settings.smtp.hostLabel')}
                value={smtpForm.host}
                onChange={(e) => setSmtpForm((f) => ({ ...f, host: e.target.value }))}
                placeholder={t('settings.smtp.hostPlaceholder')}
                required
              />
            </div>
            <Input
              label={t('settings.smtp.portLabel')}
              type="number"
              value={smtpForm.port}
              onChange={(e) => setSmtpForm((f) => ({ ...f, port: e.target.value }))}
              placeholder={t('settings.smtp.portPlaceholder')}
              required
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer select-none">
            <Checkbox
              checked={smtpForm.secure}
              onCheckedChange={(v) => setSmtpForm((f) => ({ ...f, secure: v }))}
            />
            {t('settings.smtp.tlsLabel')}
          </label>
          <Input
            label={t('settings.smtp.usernameLabel')}
            value={smtpForm.username}
            onChange={(e) => setSmtpForm((f) => ({ ...f, username: e.target.value }))}
            required
          />
          <div>
            <div className="relative">
              <Input
                label={smtpMode === 'edit' && editingServer?.passwordSet !== false ? t('settings.smtp.passwordEditLabel') : t('settings.smtp.passwordLabel')}
                type={showPassword ? 'text' : 'password'}
                value={smtpForm.password}
                onChange={(e) => setSmtpForm((f) => ({ ...f, password: e.target.value }))}
                required={smtpMode === 'create'}
                autoComplete="new-password"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={t('settings.obligate.toggleSecretVisibility', 'Show / hide')}
                aria-pressed={showPassword}
                className="absolute right-2.5 bottom-2 text-text-muted hover:text-text-primary"
              >
                {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            {/* The stored password is never returned: only whether one is set */}
            {smtpMode === 'edit' && typeof editingServer?.passwordSet === 'boolean' && (
              <p className="mt-1 text-xs text-text-muted">
                {!editingServer.passwordSet
                  ? t('settings.smtp.passwordNotSet', 'No password is stored for this server.')
                  : t('settings.smtp.passwordStored', 'A password is stored. It is never displayed; leave the field blank to keep it.')}
              </p>
            )}
          </div>
          <Input
            label={t('settings.smtp.fromLabel')}
            type="email"
            value={smtpForm.fromAddress}
            onChange={(e) => setSmtpForm((f) => ({ ...f, fromAddress: e.target.value }))}
            placeholder={t('settings.smtp.fromPlaceholder')}
            required
          />
        </form>
      </Modal>
    </PageContainer>
  );
}
