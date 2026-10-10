import { useRef, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Bell, X, Trash2, CheckCheck } from 'lucide-react';
import { useLiveAlertsStore, countUnread, isResolved } from '@/store/liveAlertsStore';
import type { LiveAlert, AlertSeverity, LiveAlertActionResult } from '@/store/liveAlertsStore';
import { ResolvedPill, ResolvedAlertsToggle } from './LiveAlerts';
import { useTenantStore } from '@/store/tenantStore';
import { useAuthStore, useTenantCapability } from '@/store/authStore';
import {
  permissionSetsApi,
  permissionSetSlugForRole,
  TENANT_ADMIN_ROLE,
  type PermissionSet,
} from '@/api/permissionSets.api';
import { cn } from '@/utils/cn';
import { formatRelative } from '@/utils/formatRelative';
import { useAlertText } from '@/utils/alertText';

const SEVERITY_STYLES: Record<AlertSeverity, { bar: string; dot: string; title: string }> = {
  down:    { bar: 'border-l-red-500',   dot: 'bg-red-500',   title: 'text-red-400'   },
  up:      { bar: 'border-l-green-500', dot: 'bg-green-500', title: 'text-green-400' },
  warning: { bar: 'border-l-amber-500', dot: 'bg-amber-500', title: 'text-amber-400' },
  info:    { bar: 'border-l-blue-500',  dot: 'bg-blue-500',  title: 'text-blue-400'  },
};

// ─── Single alert row ─────────────────────────────────────────────────────────

interface AlertRowProps {
  alert: LiveAlert;
  showTenantBadge: boolean;
  onRead: (alert: LiveAlert) => void;
  /** Absent without the 'settings' capability in the alert's tenant (the server refuses the delete). */
  onRemove?: (id: number) => void;
}

function AlertRow({ alert, showTenantBadge, onRead, onRemove }: AlertRowProps) {
  const { t } = useTranslation();
  const styles = SEVERITY_STYLES[alert.severity];
  // Translated from kind / params, anonymized in anonymous mode.
  const text = useAlertText()(alert);
  // A resolved alert (the problem it reported is over) is greyed out.
  const resolved = isResolved(alert);
  return (
    <div
      className={cn(
        'relative flex items-start gap-3 px-4 py-3 border-l-4 transition-colors',
        styles.bar,
        resolved ? 'grayscale opacity-50' : alert.read ? 'opacity-40' : 'opacity-100',
        alert.navigateTo && 'cursor-pointer hover:bg-bg-hover',
      )}
      onClick={() => onRead(alert)}
    >
      <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', styles.dot)} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <p className={cn('text-sm font-semibold truncate', styles.title)}>
            {text.title}
          </p>
          {resolved && <ResolvedPill />}
          {!alert.read && !resolved && (
            <span className="shrink-0 h-1.5 w-1.5 rounded-full bg-accent" />
          )}
        </div>
        <p className="text-xs text-text-muted mt-0.5 truncate" title={text.message}>{text.message}</p>
        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
          <p className="text-xs text-text-muted/60">{formatRelative(alert.createdAt, t)}</p>
          {/* Tenant badge: shown in Global tab for alerts from other tenants */}
          {showTenantBadge && alert.tenantName && (
            <span className="text-[10px] bg-accent/20 text-accent px-1.5 py-0.5 rounded-full font-medium">
              {alert.tenantName}
            </span>
          )}
        </div>
      </div>
      {onRemove && (
        <button
          className="shrink-0 text-text-muted hover:text-text-primary transition-colors mt-0.5"
          onClick={(e) => { e.stopPropagation(); onRemove(alert.id); }}
          title={t('liveAlerts.dismiss', 'Dismiss')}
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}

// ─── Inline toggle switch ─────────────────────────────────────────────────────

interface ToggleProps {
  enabled: boolean;
  onChange: (v: boolean) => void;
  label: string;
}

function Toggle({ enabled, onChange, label }: ToggleProps) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-text-muted">{label}</span>
      <button
        onClick={() => onChange(!enabled)}
        className={cn(
          'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors focus:outline-none',
          enabled ? 'bg-accent' : 'bg-text-muted/30',
        )}
      >
        <span
          className={cn(
            'inline-block h-3 w-3 rounded-full bg-white shadow transition-transform',
            enabled ? 'translate-x-3.5' : 'translate-x-0.5',
          )}
        />
      </button>
    </div>
  );
}

// ─── Main NotificationCenter ──────────────────────────────────────────────────

type Tab = 'local' | 'global';

export function NotificationCenter() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('local');

  const {
    alerts,
    localEnabled, multiTenantEnabled,
    setLocalEnabled, setMultiTenantEnabled,
    clearAll, markAllRead, markAlertRead, removeAlert,
  } = useLiveAlertsStore();

  const { currentTenantId, tenants } = useTenantStore();
  // Mark-all-read and clear (current tenant) and delete (the alert's tenant)
  // take the 'settings' tenant capability on the server (403 otherwise).
  const isPlatformAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const canManageLocal = useTenantCapability('settings');
  const navigate = useNavigate();
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Multi-tenant mode is shown only when the user can access more than one tenant
  const isMultiTenant = tenants.length > 1;

  // Capabilities in the other tenants come from the user's role there (a
  // permission set): the sets are loaded when the All Tenants tab shows.
  const [roleSets, setRoleSets] = useState<PermissionSet[] | null>(null);
  const needsRoleSets = open && tab === 'global' && isMultiTenant && !isPlatformAdmin;
  useEffect(() => {
    if (!needsRoleSets || roleSets !== null) return;
    permissionSetsApi.list().then(setRoleSets).catch(() => setRoleSets([]));
  }, [needsRoleSets, roleSets]);

  /** 'settings' in the alert's tenant: what the server requires to delete it. */
  const canDeleteIn = (tenantId: number): boolean => {
    if (isPlatformAdmin) return true;
    if (tenantId === currentTenantId) return canManageLocal;
    const role = tenants.find((tn) => tn.id === tenantId)?.role;
    if (!role) return false;
    if (role === TENANT_ADMIN_ROLE) return true;
    const set = roleSets?.find((s) => s.slug === permissionSetSlugForRole(role));
    return !!set?.capabilities.includes('settings');
  };

  /** A refused action changed nothing: say why. */
  const reportResult = (result: LiveAlertActionResult) => {
    if (result.ok) return;
    toast.error(result.status === 403
      ? t('liveAlerts.notAllowed', 'Not allowed: managing notifications of this tenant takes the settings permission.')
      : t('liveAlerts.actionFailed', 'The action failed. Please try again.'));
  };

  // Partition alerts by tenant
  const localAlerts  = alerts.filter((a) => a.tenantId === currentTenantId);
  const globalAlerts = alerts; // all tenants (including local)

  const tabAlerts = tab === 'global' ? globalAlerts : localAlerts;
  const totalUnread = countUnread(alerts);
  const localUnread  = countUnread(localAlerts);

  // If multi-tenant becomes unavailable, fall back to local tab
  useEffect(() => {
    if (!isMultiTenant && tab === 'global') setTab('local');
  }, [isMultiTenant, tab]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  /**
   * Handle a notification click:
   * - Mark as read
   * - If the alert belongs to another tenant, switch to it then reload all tenant-scoped data
   * - Navigate to alert.navigateTo if set
   */
  const handleAlertClick = async (alert: LiveAlert) => {
    await markAlertRead(alert.id);

    if (alert.tenantId && alert.tenantId !== currentTenantId) {
      // Switch tenant session on the server, then do a full page navigation.
      // A client-side navigate() leaves stale store data in memory; a hard
      // redirect reloads the app fresh with the new tenant context — same as F5.
      try {
        await useTenantStore.getState().setCurrentTenant(alert.tenantId);
      } catch {
        toast.error(t('tenants.switchFailed', 'Could not switch workspace'));
        return;
      }
      setOpen(false);
      window.location.href = alert.navigateTo ?? '/';
      return;
    }

    // Same-tenant: normal client-side navigation
    if (alert.navigateTo) {
      setOpen(false);
      navigate(alert.navigateTo);
    }
  };

  const isAnyEnabled = localEnabled || multiTenantEnabled;

  return (
    <div className="relative">
      {/* Bell button */}
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        title={t('liveAlerts.centerTitle', 'Notification Center')}
        className="relative flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors"
      >
        <Bell
          size={14}
          className={isAnyEnabled ? 'text-accent' : 'text-text-muted'}
        />
        {totalUnread > 0 && (
          <span className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white leading-none">
            {totalUnread > 99 ? '99+' : totalUnread}
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      {open && (
        <div
          ref={panelRef}
          className="absolute right-0 top-8 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-bg-secondary shadow-2xl overflow-hidden"
        >
          {/* Header */}
          <div className="px-4 py-3 border-b border-border space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-text-primary">{t('liveAlerts.title', 'Notifications')}</h3>
              <div className="flex items-center gap-2">
                {/* Both act on the current tenant only: shown on its (local) tab. */}
                {tab === 'local' && canManageLocal && tabAlerts.some((a) => !a.read) && (
                  <button
                    onClick={() => void markAllRead().then(reportResult)}
                    title={t('liveAlerts.markAllRead', 'Mark all as read')}
                    className="text-text-muted hover:text-text-primary transition-colors"
                  >
                    <CheckCheck size={14} />
                  </button>
                )}
                {tab === 'local' && canManageLocal && tabAlerts.length > 0 && (
                  <button
                    onClick={() => void clearAll().then(reportResult)}
                    title={t('liveAlerts.clearLocal', 'Clear local notifications')}
                    className="text-text-muted hover:text-text-primary transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
                <button
                  onClick={() => setOpen(false)}
                  className="text-text-muted hover:text-text-primary transition-colors"
                >
                  <X size={14} />
                </button>
              </div>
            </div>

            {/* Tab bar — visible only in multi-tenant mode */}
            {isMultiTenant && (
              <div className="flex gap-1">
                {(['local', 'global'] as const).map((tabKey) => {
                  const badgeCount = tabKey === 'local' ? localUnread : totalUnread;
                  return (
                    <button
                      key={tabKey}
                      onClick={() => setTab(tabKey)}
                      className={cn(
                        'flex-1 text-xs py-1 rounded-md transition-colors',
                        tab === tabKey
                          ? 'bg-accent text-white font-medium'
                          : 'text-text-muted hover:text-text-primary hover:bg-bg-hover',
                      )}
                    >
                      {tabKey === 'local' ? t('liveAlerts.tabLocal', 'Local') : t('liveAlerts.tabAllTenants', 'All Tenants')}
                      {badgeCount > 0 && (
                        <span className="ml-1 opacity-80">({badgeCount})</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Per-tab pop-up toggle */}
            {tab === 'local' && (
              <Toggle
                enabled={localEnabled}
                onChange={setLocalEnabled}
                label={localEnabled
                  ? t('liveAlerts.localPopupsOn', 'Local pop-ups on')
                  : t('liveAlerts.localPopupsOff', 'Local pop-ups off')}
              />
            )}
            {tab === 'global' && isMultiTenant && (
              <Toggle
                enabled={multiTenantEnabled}
                onChange={setMultiTenantEnabled}
                label={multiTenantEnabled
                  ? t('liveAlerts.allTenantPopupsOn', 'All-tenant pop-ups on')
                  : t('liveAlerts.allTenantPopupsOff', 'All-tenant pop-ups off')}
              />
            )}
            <ResolvedAlertsToggle />
          </div>

          {/* Notifications list */}
          <div className="max-h-96 overflow-y-auto divide-y divide-border/50">
            {tabAlerts.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-text-muted gap-2">
                <Bell size={24} className="opacity-30" />
                <p className="text-sm">{t('liveAlerts.empty', 'No notifications')}</p>
              </div>
            ) : (
              tabAlerts.map((alert) => (
                <AlertRow
                  key={alert.id}
                  alert={alert}
                  // Show tenant badge in the Global tab for cross-tenant alerts
                  showTenantBadge={tab === 'global' && alert.tenantId !== currentTenantId}
                  onRead={handleAlertClick}
                  onRemove={canDeleteIn(alert.tenantId) ? (id) => void removeAlert(id).then(reportResult) : undefined}
                />
              ))
            )}
          </div>

          {/* Footer */}
          {tabAlerts.length > 0 && (
            <div className="border-t border-border px-4 py-2">
              <p className="text-xs text-text-muted/60 text-center">
                {t('liveAlerts.count', { count: tabAlerts.length, defaultValue: '{{count}} notifications' })}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
