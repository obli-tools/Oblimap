import { useRef, useState, useEffect } from 'react';
import { ChevronDown, Building2, Check } from 'lucide-react';
// The button shows the workspace icon (Building2, the one of the Workspace
// menu entry) instead of the "TENANT" text label, then the tenant name.
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useTenantStore } from '@/store/tenantStore';
import { useGroupStore } from '@/store/groupStore';
import { reconnectSocket } from '@/socket/socketClient';
import { useAuthStore } from '@/store/authStore';
import { cn } from '@/utils/cn';

/** Detail pages bound to one tenant's object (site, group, probe, device check). */
const TENANT_DETAIL_PATH = /^\/(sites|group|manage\/probes|manage\/device-checks)\/[^/]+/;

export function TenantSwitcher() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const { currentTenantId, tenants, setCurrentTenant } = useTenantStore();
  const { user } = useAuthStore();
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close on outside click — must be BEFORE the early return to satisfy Rules of Hooks
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

  // In the native desktop app the injected tab bar replaces this dropdown
  const isNativeApp = !!(window as Window & { __oblimap_is_native_app?: boolean }).__oblimap_is_native_app;
  if (isNativeApp && tenants.length > 1) return null;

  // Only show when there are multiple tenants
  if (tenants.length <= 1) return null;

  const currentTenant = tenants.find((t) => t.id === currentTenantId) ?? tenants[0];

  const handleSwitch = async (tenantId: number) => {
    if (tenantId === currentTenantId || switching) return;
    setSwitching(true);
    setOpen(false);

    try {
      try {
        await setCurrentTenant(tenantId);
      } catch {
        // The session stays on the current tenant: keep its data on screen.
        toast.error(t('tenants.switchFailed', 'Could not switch workspace'));
        return;
      }

      // A detail page of the previous tenant (site, group, probe, device
      // check) means nothing in the new one: go back to the dashboard.
      if (TENANT_DETAIL_PATH.test(location.pathname)) {
        navigate('/', { replace: true });
      }

      // Re-run the socket handshake: the server joins the rooms of the
      // session's new tenant. Same Socket object, so listeners stay attached.
      if (user) reconnectSocket();

      // Reload the tenant-scoped stores. Pages and the sidebar reload on
      // their own through the tenant epoch (useIpamLiveRefresh / useTenantEpoch).
      const groups = useGroupStore.getState();
      await Promise.all([
        groups.fetchTree(),
        groups.fetchGroupStats(),
      ]);
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setOpen((v) => !v)}
        disabled={switching}
        className={cn(
          'flex items-center gap-2 rounded-md bg-bg-hover px-3 py-1.5 text-[13px] text-text-primary font-medium transition-colors hover:bg-bg-active',
          switching && 'opacity-60 cursor-wait',
        )}
      >
        <Building2 size={14} className="shrink-0 text-text-muted" aria-hidden="true" />
        <span className="sr-only">{t('tenant.label', 'Tenant')}</span>
        <span className="max-w-[140px] truncate tracking-[0.04em]">{currentTenant?.name ?? '…'}</span>
        <ChevronDown size={12} className={cn('text-text-muted transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div
          ref={panelRef}
          className="absolute left-0 top-9 z-50 w-52 rounded-xl border border-border bg-bg-secondary shadow-2xl overflow-hidden"
        >
          <div className="px-3 py-2 border-b border-border">
            <p className="text-xs font-semibold text-text-muted uppercase tracking-wide">
              {t('tenant.switchWorkspace')}
            </p>
          </div>
          <div className="py-1 max-h-64 overflow-y-auto">
            {tenants.map((tenant) => (
              <button
                key={tenant.id}
                onClick={() => handleSwitch(tenant.id)}
                className={cn(
                  'w-full flex items-center justify-between px-3 py-2 text-sm text-left transition-colors hover:bg-bg-hover',
                  tenant.id === currentTenantId
                    ? 'text-accent font-semibold'
                    : 'text-text-primary',
                )}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Building2 size={13} className="shrink-0 text-text-muted" />
                  <span className="truncate">{tenant.name}</span>
                  {tenant.role === 'admin' && (
                    <span className="shrink-0 text-[10px] text-text-muted bg-bg-tertiary rounded px-1 py-0.5">
                      {t('tenant.roleAdmin')}
                    </span>
                  )}
                </div>
                {tenant.id === currentTenantId && (
                  <Check size={13} className="shrink-0 text-accent" />
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
