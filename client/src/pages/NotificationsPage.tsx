import { useState, useEffect, useRef, useCallback, type FormEvent } from 'react';
import {
  Plus,
  Pencil,
  Trash2,
  Bell,
  TestTube2,
  Zap,
  Loader2,
  Building2,
  ChevronDown,
  ChevronRight,
  X,
  History,
  CheckCircle2,
  XCircle,
  RefreshCw,
} from 'lucide-react';
import type {
  NotificationChannel,
  NotificationPluginMeta,
  NotificationBinding,
  SmtpServer,
} from '@oblimap/shared';
import { notificationsApi, type NotificationLogEntry } from '@/api/notifications.api';
import { smtpServerApi } from '@/api/smtpServer.api';
import { Button } from '@/components/common/Button';
import { Input } from '@/components/common/Input';
import { PageContainer, useEmbedded } from '@/components/common/PageContainer';
import { Modal } from '@/components/common/Modal';
import { Drawer } from '@/components/common/Drawer';
import { IconButton } from '@/components/common/IconButton';
import { ActionMenu } from '@/components/common/ActionMenu';
import { EmptyState } from '@/components/common/EmptyState';
import { LoadError } from '@/components/common/LoadError';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Checkbox } from '@/components/ui/Checkbox';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useTenantStore, useTenantEpoch } from '@/store/tenantStore';
import { apiErrorBody, apiErrorMessage, isHandled } from '@/utils/apiError';
import { formatRelative } from '@/utils/formatRelative';
import { cn } from '@/utils/cn';

/**
 * Placeholder the server returns instead of a stored channel secret (bot token,
 * webhook URL, password...). Sent back unchanged on update, it keeps the stored
 * value (server notification.service REDACTED).
 */
const REDACTED = '__REDACTED__';

/**
 * Config keys that decide where a channel delivers (server TARGET_KEYS): when
 * one of them changes, the server refuses to keep the stored secrets, which
 * must then be re-entered.
 */
const TARGET_KEYS = ['url', 'serverUrl', 'webhookUrl', 'host'] as const;

const FORM_ID = 'notification-channel-form';

const selectCls =
  'w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent';

/**
 * Toast for a failed API call: nothing when the API client already reported
 * it (missing capability), the translated text of the notification-specific
 * codes, else the server's message or the fallback.
 */
function toastNotificationError(
  err: unknown,
  t: TFunction,
  fallback: string,
  fieldLabel: (key: string) => string = (key) => key,
): void {
  if (isHandled(err)) return;
  const data = apiErrorBody(err);
  if (data?.error === 'forbidden') {
    toast.error(t('notifications.forbidden', 'You are not allowed to manage notification channels in this workspace'));
    return;
  }
  const field = (data as { field?: unknown } | undefined)?.field;
  if (data?.error === 'missing_config_field' && typeof field === 'string' && field) {
    toast.error(t('notifications.missingConfigField', 'Required field missing: {{field}}', { field: fieldLabel(field) }));
    return;
  }
  toast.error(apiErrorMessage(err, fallback));
}

/** English fallbacks of the delivery-log error codes (notifications.logError.<code>). */
const LOG_ERROR_FALLBACKS: Record<string, string> = {
  ssrf_blocked: 'Target refused: local or internal address (add it to SSRF_ALLOWLIST)',
  timeout: 'Timed out',
  auth_failed: 'Authentication failed',
  error: 'Delivery failed',
};

/** Translated label of a delivery-log error code ('http_<status>' → "HTTP <status>"). */
function logErrorLabel(code: string, t: TFunction): string {
  const http = /^http_(\d{3})$/.exec(code);
  if (http) return t('notifications.logError.http', 'HTTP error {{status}}', { status: http[1] });
  return t(`notifications.logError.${code}`, LOG_ERROR_FALLBACKS[code] ?? code);
}

// ── Delivery log drawer (per channel) ───────────────────────────────────────

function DeliveryLogDrawer({ channel, onClose }: { channel: NotificationChannel | null; onClose: () => void }) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<NotificationLogEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const requestSeq = useRef(0);
  const channelId = channel?.id ?? null;

  const load = useCallback(async () => {
    if (channelId === null) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setFailed(false);
    try {
      const rows = await notificationsApi.getChannelLog(channelId, 100);
      if (seq === requestSeq.current) setEntries(rows);
    } catch (err) {
      if (seq !== requestSeq.current) return;
      setFailed(true);
      toastNotificationError(err, t, t('notifications.logLoadFailed', 'Failed to load the delivery log'));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [channelId, t]);

  useEffect(() => {
    setEntries(null);
    if (channelId !== null) void load();
    return () => { requestSeq.current++; };
  }, [channelId, load]);

  const sentCount = entries?.filter((e) => e.status === 'sent').length ?? 0;
  const failedCount = (entries?.length ?? 0) - sentCount;

  return (
    <Drawer
      open={channel !== null}
      onClose={onClose}
      side="right"
      size="md"
      icon={<History className="h-4 w-4 text-accent" />}
      title={t('notifications.logTitle', 'Delivery log: {{name}}', { name: channel?.name ?? '' })}
      headerExtra={
        <IconButton
          label={t('common.refresh', 'Refresh')}
          icon={<RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />}
          size="sm"
          variant="plain"
          onClick={() => void load()}
          disabled={loading}
        />
      }
    >
      <p className="mb-3 text-xs text-text-muted">
        {t('notifications.logHint', 'Latest deliveries of this channel, newest first. Entries are kept 30 days.')}
      </p>
      {failed && entries === null ? (
        <LoadError onRetry={() => void load()} />
      ) : entries === null ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('common.loading')}
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          icon={<History className="h-6 w-6" />}
          title={t('notifications.logEmpty', 'No delivery yet')}
          description={t('notifications.logEmptyDesc', 'Deliveries appear here once an alert or a test is sent through this channel.')}
        />
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-2 text-xs">
            <span className="rounded-full bg-status-up/10 px-2 py-0.5 font-medium text-status-up">
              {t('notifications.logSentCount', '{{n}} sent', { n: sentCount })}
            </span>
            {failedCount > 0 && (
              <span className="rounded-full bg-status-down/10 px-2 py-0.5 font-medium text-status-down">
                {t('notifications.logFailedCount', '{{n}} failed', { n: failedCount })}
              </span>
            )}
          </div>
          <ul className="divide-y divide-border rounded-xl bg-bg-tertiary/40">
            {entries.map((e) => {
              const ok = e.status === 'sent';
              return (
                <li key={e.id} className="flex items-start gap-3 px-3 py-2.5">
                  {ok
                    ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-status-up" />
                    : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-status-down" />}
                  <div className="min-w-0 flex-1">
                    <div className={cn('text-sm font-medium', ok ? 'text-text-primary' : 'text-status-down')}>
                      {ok
                        ? t('notifications.logSent', 'Delivered')
                        : logErrorLabel(e.errorCode ?? 'error', t)}
                    </div>
                    <div className="text-xs text-text-muted" title={new Date(e.createdAt).toLocaleString()}>
                      {formatRelative(e.createdAt, t)}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Drawer>
  );
}

// ── Tenant sharing panel (per channel) ──────────────────────────────────────

interface TenantSharingPanelProps {
  channelId: number;
  currentTenantId: number | null;
}

function TenantSharingPanel({ channelId, currentTenantId }: TenantSharingPanelProps) {
  const { t } = useTranslation();
  const { tenants } = useTenantStore();
  const [sharedTenantIds, setSharedTenantIds] = useState<number[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [addingId, setAddingId] = useState<number | ''>('');
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    setLoading(true);
    notificationsApi.getChannelTenants(channelId)
      .then((ids) => {
        if (isMounted.current) {
          setSharedTenantIds(ids);
          setLoading(false);
        }
      })
      .catch(() => {
        if (isMounted.current) setLoading(false);
      });
    return () => { isMounted.current = false; };
  }, [channelId]);

  const applyChange = async (newIds: number[]) => {
    setSaving(true);
    try {
      await notificationsApi.setChannelTenants(channelId, newIds);
      setSharedTenantIds(newIds);
    } catch (err) {
      toastNotificationError(err, t, t('notifications.failedTenantAssign'));
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = (tenantId: number) => {
    if (!sharedTenantIds) return;
    applyChange(sharedTenantIds.filter((id) => id !== tenantId));
  };

  const handleAdd = () => {
    if (!addingId || !sharedTenantIds) return;
    const id = Number(addingId);
    if (sharedTenantIds.includes(id)) return;
    applyChange([...sharedTenantIds, id]);
    setAddingId('');
  };

  // Available: exclude the channel's owner tenant (current) and already-shared ones
  const availableTenants = tenants.filter(
    (t) => t.id !== currentTenantId && !(sharedTenantIds ?? []).includes(t.id),
  );

  if (loading) {
    return (
      <div className="mt-2 flex items-center gap-1.5 px-3 py-2 text-xs text-text-muted">
        <Loader2 size={12} className="animate-spin" />
        {t('common.loading')}
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-lg bg-bg-tertiary/50 px-3 py-2.5 space-y-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
        {t('notifications.sharedWith')}
      </p>

      {/* Current shared tenants */}
      <div className="flex flex-wrap gap-1.5 min-h-[22px]">
        {sharedTenantIds && sharedTenantIds.length === 0 && (
          <span className="text-xs text-text-muted italic">{t('notifications.notShared')}</span>
        )}
        {sharedTenantIds?.map((tid) => {
          const tenant = tenants.find((t) => t.id === tid);
          return (
            <span
              key={tid}
              className="inline-flex items-center gap-1 rounded-md bg-bg-tertiary px-2 py-0.5 text-xs text-text-primary"
            >
              <Building2 size={10} className="text-text-muted shrink-0" />
              {tenant?.name ?? t('notifications.workspaceNumber', 'Workspace #{{id}}', { id: tid })}
              <IconButton
                label={t('notifications.removeTenantAccess')}
                icon={<X size={10} />}
                size="xs"
                variant="plain"
                touchTarget="overlay"
                onClick={() => handleRemove(tid)}
                disabled={saving}
                className="ml-0.5 hover:text-status-down"
              />
            </span>
          );
        })}
        {saving && <Loader2 size={12} className="animate-spin text-text-muted self-center" />}
      </div>

      {/* Add tenant */}
      {availableTenants.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={addingId}
            onChange={(e) => setAddingId(e.target.value ? Number(e.target.value) : '')}
            className="rounded-md border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
          >
            <option value="">{t('notifications.selectTenant')}</option>
            {availableTenants.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleAdd}
            disabled={!addingId || saving}
            className="inline-flex items-center gap-1 rounded-md bg-accent/10 px-2 py-1 text-xs font-medium text-accent hover:bg-accent/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors coarse:min-h-10"
          >
            <Plus size={11} />
            {t('notifications.grantAccess')}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export function NotificationsPage() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const embedded = useEmbedded();
  const { currentTenantId, tenants } = useTenantStore();
  const isMultiTenant = tenants.length > 1;

  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [plugins, setPlugins] = useState<NotificationPluginMeta[]>([]);
  const [globalBindings, setGlobalBindings] = useState<NotificationBinding[]>([]);
  const [smtpServers, setSmtpServers] = useState<SmtpServer[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [selectedType, setSelectedType] = useState('');
  const [formName, setFormName] = useState('');
  const [formConfig, setFormConfig] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<number | null>(null);
  // Edit form: config keys whose stored secret the server redacted (shown
  // empty; left empty they are sent back as REDACTED = keep), and the config
  // as loaded (to detect a destination change).
  const [redactedKeys, setRedactedKeys] = useState<Set<string>>(new Set());
  const [loadedConfig, setLoadedConfig] = useState<Record<string, unknown>>({});
  // Channel whose delivery log drawer is open.
  const [logChannel, setLogChannel] = useState<NotificationChannel | null>(null);

  // Which channel IDs have their tenant sharing panel expanded
  const [expandedTenants, setExpandedTenants] = useState<Set<number>>(new Set());

  const load = async () => {
    try {
      const [ch, pl, gb] = await Promise.all([
        notificationsApi.listChannels(),
        notificationsApi.getPlugins(),
        notificationsApi.getBindings('global', null),
      ]);
      setChannels(ch);
      setPlugins(pl);
      setGlobalBindings(gb);
      setLoadFailed(false);
    } catch (err) {
      setLoadFailed(true);
      toastNotificationError(err, t, t('notifications.failedLoad', 'Failed to load notifications'));
    } finally {
      setLoaded(true);
    }
  };

  // Reloaded after a tenant switch too.
  const tenantEpoch = useTenantEpoch();
  useEffect(() => {
    load();
    setLogChannel(null);
    smtpServerApi.list().then(setSmtpServers).catch(() => {});
  }, [tenantEpoch]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedPlugin = plugins.find((p) => p.type === selectedType);

  const openCreate = () => {
    setEditingId(null);
    setSelectedType(plugins[0]?.type || '');
    setFormName('');
    setFormConfig({});
    setRedactedKeys(new Set());
    setLoadedConfig({});
    setShowForm(true);
  };

  const openEdit = (ch: NotificationChannel) => {
    const config: Record<string, unknown> = { ...ch.config };
    const redacted = new Set(Object.keys(config).filter((k) => config[k] === REDACTED));
    // Never show the placeholder in a field: empty = keep the stored secret.
    for (const k of redacted) config[k] = '';
    setEditingId(ch.id);
    setSelectedType(ch.type);
    setFormName(ch.name);
    setFormConfig(config);
    setRedactedKeys(redacted);
    setLoadedConfig({ ...ch.config });
    setShowForm(true);
  };

  const closeForm = () => {
    if (saving) return;
    setShowForm(false);
    setEditingId(null);
  };

  /** Label of a config key of the selected plugin (the key itself when unknown). */
  const fieldLabel = (key: string): string =>
    plugins.find((p) => p.type === selectedType)?.configFields.find((f) => f.key === key)?.label ?? key;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    let config = formConfig;
    if (editingId) {
      // Secrets left empty are kept: send the placeholder back.
      config = { ...formConfig };
      const kept: string[] = [];
      for (const k of redactedKeys) {
        const v = config[k];
        if (v === undefined || v === null || v === '') {
          config[k] = REDACTED;
          kept.push(k);
        }
      }
      // The server refuses to keep stored secrets for a new destination.
      // (A re-entered secret destination is checked by the server alone.)
      const retargeted = kept.length > 0 && TARGET_KEYS.some((k) =>
        !redactedKeys.has(k) && String(config[k] ?? '') !== String(loadedConfig[k] ?? ''));
      if (retargeted) {
        toast.error(t('notifications.secretsReenter', 'The destination changed: re-enter the secret fields ({{fields}})', {
          fields: kept.map(fieldLabel).join(', '),
        }));
        return;
      }
    }
    setSaving(true);
    try {
      if (editingId) {
        await notificationsApi.updateChannel(editingId, {
          name: formName,
          config,
        });
        toast.success(t('notifications.updated'));
      } else {
        await notificationsApi.createChannel({
          name: formName,
          type: selectedType,
          config: formConfig,
        });
        toast.success(t('notifications.created'));
      }
      setShowForm(false);
      setEditingId(null);
      load();
    } catch (err) {
      toastNotificationError(err, t, t('notifications.failedSave'), fieldLabel);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number, name: string) => {
    const ok = await confirm({
      title: t('notifications.deleteTitle', 'Delete channel'),
      message: t('notifications.confirmDelete', { name }),
      danger: true,
    });
    if (!ok) return;
    try {
      await notificationsApi.deleteChannel(id);
      toast.success(t('notifications.deleted'));
      setExpandedTenants((prev) => {
        const s = new Set(prev);
        s.delete(id);
        return s;
      });
      setLogChannel((cur) => (cur?.id === id ? null : cur));
      load();
    } catch (err) {
      toastNotificationError(err, t, t('notifications.failedDelete'));
    }
  };

  const handleTest = async (id: number) => {
    if (testing === id) return;
    setTesting(id);
    try {
      await notificationsApi.testChannel(id);
      toast.success(t('notifications.testSent'));
    } catch (err: unknown) {
      toastNotificationError(err, t, t('notifications.testFailed'));
    } finally {
      setTesting(null);
    }
  };

  const toggleGlobalBinding = async (channelId: number) => {
    const existing = globalBindings.find((b) => b.channelId === channelId);
    try {
      if (existing) {
        await notificationsApi.removeBinding(channelId, 'global', null);
        toast.success(t('notifications.removedFromGlobal'));
      } else {
        await notificationsApi.addBinding(channelId, 'global', null);
        toast.success(t('notifications.addedToGlobal'));
      }
      load();
    } catch (err) {
      toastNotificationError(err, t, t('notifications.failedBinding'));
    }
  };

  const isGloballyBound = (channelId: number) =>
    globalBindings.some((b) => b.channelId === channelId);

  const toggleTenantPanel = (channelId: number) => {
    setExpandedTenants((prev) => {
      const next = new Set(prev);
      if (next.has(channelId)) next.delete(channelId);
      else next.add(channelId);
      return next;
    });
  };

  const newChannelButton = (
    <Button size="sm" onClick={openCreate} disabled={!loaded || plugins.length === 0}>
      <Plus size={16} className="mr-1.5" />
      {t('notifications.newChannel')}
    </Button>
  );

  // Inline row actions show on hover with a mouse and always on touch.
  const rowActionCls = 'hidden md:inline-flex shrink-0 can-hover:opacity-0 can-hover:group-hover:opacity-100 can-hover:group-focus-within:opacity-100 transition-opacity';

  return (
    <PageContainer
      title={t('notifications.title')}
      subtitle={t('notifications.subtitle', 'Channels that deliver alerts, and the ones every site of this workspace uses (global).')}
      actions={newChannelButton}
    >
      {/* Inside a hub tab the page header (and its action) is not rendered. */}
      {embedded && <div className="mb-4 flex justify-end">{newChannelButton}</div>}

      {/* Create / edit dialog */}
      <Modal
        open={showForm}
        onClose={closeForm}
        dismissible={!saving}
        size="lg"
        icon={<Bell className="h-4 w-4 text-accent" />}
        title={editingId ? t('notifications.editChannel') : t('notifications.newChannel')}
        footer={
          <>
            <Button type="button" variant="ghost" onClick={closeForm} disabled={saving}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" form={FORM_ID} loading={saving}>
              {editingId ? t('common.save') : t('common.create')}
            </Button>
          </>
        }
      >
        <form id={FORM_ID} onSubmit={handleSubmit} className="space-y-4">
          <Input
            id="notification-channel-name"
            label={t('notifications.channelName')}
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            placeholder={t('notifications.channelNamePlaceholder')}
            required
            autoFocus
          />

          {!editingId && (
            <div className="space-y-1">
              <label htmlFor="notification-channel-type" className="block text-sm font-medium text-text-secondary">{t('common.type')}</label>
              <select
                id="notification-channel-type"
                value={selectedType}
                onChange={(e) => {
                  setSelectedType(e.target.value);
                  setFormConfig({});
                }}
                className={selectCls}
              >
                {plugins.map((p) => (
                  <option key={p.type} value={p.type}>
                    {p.name}
                  </option>
                ))}
              </select>
              {selectedPlugin && (
                <p className="text-xs text-text-muted mt-1">{selectedPlugin.description}</p>
              )}
            </div>
          )}

          {/* Dynamic config fields */}
          {selectedPlugin?.configFields.map((field) => {
            if (field.type === 'boolean') {
              return (
                <div key={field.key} className="flex items-center gap-2">
                  <Checkbox
                    id={`cfg-${field.key}`}
                    checked={Boolean(formConfig[field.key])}
                    onCheckedChange={(v) => setFormConfig({ ...formConfig, [field.key]: v })}
                  />
                  <label htmlFor={`cfg-${field.key}`} className="text-sm text-text-secondary coarse:py-2">
                    {field.label}
                  </label>
                </div>
              );
            }
            if (field.type === 'smtp_server_select') {
              return (
                <div key={field.key} className="space-y-1">
                  <label htmlFor={`cfg-${field.key}`} className="block text-sm font-medium text-text-secondary">
                    {field.label}{field.required && <span className="text-status-down ml-1">*</span>}
                  </label>
                  <select
                    id={`cfg-${field.key}`}
                    value={String(formConfig[field.key] ?? '')}
                    onChange={(e) => setFormConfig({ ...formConfig, [field.key]: e.target.value ? Number(e.target.value) : '' })}
                    required={field.required}
                    className={selectCls}
                  >
                    <option value="">{t('notifications.selectSmtp')}</option>
                    {smtpServers.map((s) => (
                      <option key={s.id} value={s.id}>{s.name} ({s.host}:{s.port})</option>
                    ))}
                  </select>
                  {smtpServers.length === 0 && (
                    <p className="text-xs text-amber-400">{t('notifications.noSmtp')}</p>
                  )}
                </div>
              );
            }
            // A stored secret the server redacted: empty field, empty = keep it.
            const keepsSecret = redactedKeys.has(field.key);
            return (
              <div key={field.key} className="space-y-1">
                <Input
                  id={`cfg-${field.key}`}
                  label={field.label}
                  type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
                  value={String(formConfig[field.key] ?? '')}
                  onChange={(e) =>
                    setFormConfig({
                      ...formConfig,
                      [field.key]: field.type === 'number' ? Number(e.target.value) : e.target.value,
                    })
                  }
                  placeholder={keepsSecret ? t('notifications.secretSavedPlaceholder', '•••••••• (saved)') : field.placeholder}
                  required={field.required && !keepsSecret}
                  autoComplete={keepsSecret || field.type === 'password' ? 'new-password' : undefined}
                  // Config values are URLs / tokens / addresses: no autocorrect.
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                />
                {keepsSecret && (
                  <p className="text-xs text-text-muted">
                    {t('notifications.secretKeepHint', 'Saved secret: leave empty to keep it, or type a new value to replace it.')}
                  </p>
                )}
              </div>
            );
          })}
        </form>
      </Modal>

      <DeliveryLogDrawer channel={logChannel} onClose={() => setLogChannel(null)} />

      {/* Channel list */}
      {loadFailed && channels.length === 0 ? (
        <LoadError onRetry={() => void load()} />
      ) : !loaded ? (
        <div className="flex items-center justify-center gap-2 rounded-xl bg-bg-secondary py-12 text-sm text-text-muted">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('common.loading')}
        </div>
      ) : channels.length === 0 ? (
        <EmptyState
          icon={<Bell className="h-6 w-6" />}
          title={t('notifications.noChannels')}
          description={t('notifications.noChannelsDesc')}
        />
      ) : (
        <div className="rounded-xl bg-bg-secondary">
          <div className="divide-y divide-border">
            {channels.map((ch) => {
              const plugin = plugins.find((p) => p.type === ch.type);
              const isShared = ch.isShared === true;
              const isExpanded = expandedTenants.has(ch.id);
              const bound = isGloballyBound(ch.id);

              return (
                <div key={ch.id} className="px-3 sm:px-4 py-3 group">
                  {/* Main row — phones: name + badges on the first line, actions wrap below */}
                  <div className="flex flex-wrap sm:flex-nowrap items-center gap-x-3 gap-y-2">
                    <div className="flex-1 min-w-0 max-sm:basis-full">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-text-primary">{ch.name}</span>
                        <span className="rounded-full bg-bg-tertiary px-2 py-0.5 text-[10px] font-medium text-text-muted">
                          {plugin?.name || ch.type}
                        </span>
                        {!ch.isEnabled && (
                          <span className="rounded-full bg-status-down/10 px-2 py-0.5 text-[10px] font-medium text-status-down">
                            {t('status.disabled')}
                          </span>
                        )}
                        {/* Badge for shared channels showing the source tenant */}
                        {isShared && ch.tenantId && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-medium text-accent">
                            <Building2 size={9} className="shrink-0" />
                            {tenants.find((tn) => tn.id === ch.tenantId)?.name ?? t('notifications.workspaceNumber', 'Workspace #{{id}}', { id: ch.tenantId })}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Global binding toggle */}
                    <button
                      type="button"
                      onClick={() => toggleGlobalBinding(ch.id)}
                      aria-pressed={bound}
                      className={cn(
                        'shrink-0 rounded-md px-2 py-1 coarse:px-3 coarse:py-2 text-xs font-medium transition-colors',
                        bound ? 'bg-accent/10 text-accent' : 'text-text-muted hover:bg-bg-hover',
                      )}
                      title={bound
                        ? t('notifications.removeFromGlobalTitle', 'Remove from global')
                        : t('notifications.addToGlobalTitle', 'Add to global notifications')}
                    >
                      <Zap size={12} className="inline mr-1" />
                      {bound ? t('notifications.globalActive', 'Global ✓') : t('common.enable')}
                    </button>

                    {/* Tenant sharing toggle — own channels only, multi-tenant mode only */}
                    {isMultiTenant && !isShared && (
                      <button
                        type="button"
                        onClick={() => toggleTenantPanel(ch.id)}
                        aria-expanded={isExpanded}
                        className={cn(
                          'shrink-0 inline-flex items-center gap-1 rounded-md px-2 py-1 coarse:px-3 coarse:py-2 text-xs font-medium transition-colors',
                          isExpanded ? 'bg-bg-tertiary text-text-primary' : 'text-text-muted hover:bg-bg-hover',
                        )}
                        title={t('notifications.manageTenantAccess')}
                      >
                        <Building2 size={12} />
                        {t('notifications.workspaces')}
                        {isExpanded
                          ? <ChevronDown size={11} />
                          : <ChevronRight size={11} />}
                      </button>
                    )}

                    {/* md+: inline icons (hover-revealed with a mouse, always
                        visible on touch). Phones: the same actions in a "⋯" menu. */}
                    <IconButton
                      label={t('notifications.deliveryLog', 'Delivery log')}
                      icon={<History size={14} />}
                      variant="plain"
                      onClick={() => setLogChannel(ch)}
                      className={cn(rowActionCls, 'hover:text-accent')}
                    />
                    {/* Test / Edit / Delete — hidden for shared channels */}
                    {!isShared && (
                      <>
                        <IconButton
                          label={t('notifications.sendTest')}
                          icon={testing === ch.id
                            ? <Loader2 size={14} className="animate-spin" />
                            : <TestTube2 size={14} />}
                          variant="plain"
                          onClick={() => void handleTest(ch.id)}
                          aria-disabled={testing === ch.id}
                          className={cn(rowActionCls, 'hover:text-accent')}
                        />
                        <IconButton
                          label={t('common.edit')}
                          icon={<Pencil size={14} />}
                          variant="plain"
                          onClick={() => openEdit(ch)}
                          className={rowActionCls}
                        />
                        <IconButton
                          label={t('common.delete')}
                          icon={<Trash2 size={14} />}
                          variant="plain"
                          onClick={() => void handleDelete(ch.id, ch.name)}
                          className={cn(rowActionCls, 'hover:text-status-down')}
                        />
                      </>
                    )}
                    <ActionMenu
                      sheetTitle={ch.name}
                      triggerClassName="md:hidden shrink-0 ml-auto"
                      items={[
                        { key: 'log', icon: <History size={16} />, label: t('notifications.deliveryLog', 'Delivery log'), onClick: () => setLogChannel(ch) },
                        { key: 'test', icon: <TestTube2 size={16} />, label: t('notifications.sendTest'), onClick: () => void handleTest(ch.id), disabled: testing === ch.id, hidden: isShared },
                        { key: 'edit', icon: <Pencil size={16} />, label: t('common.edit'), onClick: () => openEdit(ch), hidden: isShared },
                        { key: 'delete', icon: <Trash2 size={16} />, label: t('common.delete'), onClick: () => void handleDelete(ch.id, ch.name), hidden: isShared, danger: true, separator: true },
                      ]}
                    />
                  </div>

                  {/* Tenant sharing panel (expandable, own channels only) */}
                  {isExpanded && !isShared && (
                    <TenantSharingPanel channelId={ch.id} currentTenantId={currentTenantId} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </PageContainer>
  );
}
