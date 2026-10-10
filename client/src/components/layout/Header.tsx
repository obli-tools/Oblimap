import { LogOut, Download, MoreHorizontal, ChevronDown } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/store/authStore';
import { useTenantStore } from '@/store/tenantStore';
import { useSocketStore } from '@/store/socketStore';
import { useAnonymize } from '@/utils/anonymize';
import { NotificationCenter } from './NotificationCenter';
import { TenantSwitcher } from './TenantSwitcher';
import { Logo } from '@/components/Logo';
import { cn } from '@/utils/cn';

/** True when running inside the Oblimap native desktop app overlay. */
const isNativeApp = typeof window !== 'undefined' &&
  !!(window as Window & { __oblimap_is_native_app?: boolean }).__oblimap_is_native_app;

// ── App switcher data ───────────────────────────────────────────────────────
//
// Pills, current app glowing with
// its own brand colour. The list and its order come entirely from Obligate
// (GET /api/auth/connected-apps, already sorted by its own `sort_order`) —
// no app type, label or colour is hard-coded here, so a new app registered
// on Obligate shows up in this switcher without a code change on this side.

type ConnectedApp = {
  appType: string; name: string; baseUrl: string; icon: string; color: string | null; self?: boolean;
  /** Not an Obli* app (filed under "More…" in Obligate): listed in the "More…" dropdown. */
  thirdParty?: boolean;
};

const CURRENT_APP = 'oblimap';

const FALLBACK_APP_COLOR = '#8B949E';

// Refreshed periodically so an app newly registered in Obligate shows up
// here without reloading the tab.
const REFRESH_INTERVAL_MS = 5 * 60_000;

export function Header() {
  const { t } = useTranslation();
  const { user, logout } = useAuthStore();
  const { anonymize } = useAnonymize();
  const { status: socketStatus } = useSocketStore();
  const [connectedApps, setConnectedApps] = useState<ConnectedApp[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  const switcherWrapRef = useRef<HTMLDivElement>(null); // flexible slot: its clientWidth is the space actually granted
  const measureRef = useRef<HTMLDivElement>(null); // hidden full-label copy, only measured
  const moreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const loadApps = () => {
      fetch('/api/auth/connected-apps', { credentials: 'include' })
        .then(r => r.json())
        .then((d: { success: boolean; data?: ConnectedApp[] }) => {
          if (d.success && d.data) setConnectedApps(d.data);
        })
        .catch(() => {});
    };
    loadApps();
    const interval = setInterval(loadApps, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  // The switcher is exactly what Obligate returns, already in its display
  // order. `self: true` marks our own entry reliably even with several
  // instances of this app type registered; fall back to appType matching
  // for callers that predate that field. If Obligate didn't include us at
  // all (not registered, or the fetch failed before it could load), synth a
  // minimal self entry so the current app never disappears from its own
  // switcher.
  const hasSelf = connectedApps.some(a => (a.self ?? a.appType === CURRENT_APP));
  const pills: ConnectedApp[] = hasSelf
    ? connectedApps
    : [{ appType: CURRENT_APP, name: 'Oblimap', baseUrl: '', icon: '', color: '#8DC63F', self: true }, ...connectedApps];
  const isCurrentApp = (a: ConnectedApp) => a.self === true || a.appType === CURRENT_APP;
  // Obli* apps in the main row, third-party apps (Passly…) in "More…". The
  // current app always stays in the main row, even when it is third-party.
  const mainApps = pills.filter(a => !a.thirdParty || isCurrentApp(a));
  const moreApps = pills.filter(a => a.thirdParty && !isCurrentApp(a));

  // "More…" dropdown: outside click and Escape close it.
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: PointerEvent) => { if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMoreOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey); };
  }, [moreOpen]);

  // Collapse to dot-only pills the moment the labelled row would not fit the
  // space flexbox grants the switcher — re-measured on resize and whenever
  // the app list changes.
  useEffect(() => {
    const el = switcherWrapRef.current;
    const measure = measureRef.current;
    if (!el || !measure) return;
    const update = () => setCollapsed(measure.scrollWidth > el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [mainApps.length, moreApps.length]);

  const moreButton = (labelled: boolean, interactive: boolean) => (
    <button
      type="button"
      onClick={interactive ? () => setMoreOpen(v => !v) : undefined}
      tabIndex={interactive ? undefined : -1}
      aria-haspopup={interactive ? 'true' : undefined}
      aria-expanded={interactive ? moreOpen : undefined}
      className={cn(
        'flex items-center gap-1.5 rounded-md py-1.5 text-[12.5px] font-medium text-text-secondary transition-colors hover:bg-bg-active hover:text-text-primary shrink-0',
        labelled ? 'px-3' : 'px-1.5',
      )}
      title={t('header.moreApps', 'More…')}
      aria-label={t('header.moreApps', 'More…')}
    >
      <MoreHorizontal size={14} className="shrink-0" />
      {labelled && <span>{t('header.moreApps', 'More…')}</span>}
      {labelled && <ChevronDown size={12} className={cn('shrink-0 text-text-muted transition-transform', moreOpen && 'rotate-180')} />}
    </button>
  );

  const pill = (app: ConnectedApp, labelled: boolean) => {
    const isCurrent = isCurrentApp(app);
    return (
      <button
        key={app.appType}
        type="button"
        onClick={() => goApp(app)}
        className={cn(
          'flex items-center gap-2 py-1.5 rounded-md text-[12.5px] font-medium transition-colors shrink-0',
          labelled ? 'px-3' : 'px-1.5',
          isCurrent
            ? 'bg-bg-secondary text-text-primary font-semibold shadow-[0_1px_3px_rgb(46_52_64_/_0.1)]'
            : 'text-text-secondary hover:bg-bg-active hover:text-text-primary',
        )}
        title={app.name}
        aria-label={app.name}
      >
        <span
          className="w-2 h-2 rounded-full shrink-0"
          style={{ background: app.color || FALLBACK_APP_COLOR }}
        />
        {labelled && app.name}
      </button>
    );
  };

  const goApp = (app: ConnectedApp) => {
    if (isCurrentApp(app) || !app.baseUrl) return;

    // Cross-app tenant handoff: append the current tenant slug so the target
    // app lands on the same workspace if the user has access there.
    const { tenants, currentTenantId } = useTenantStore.getState();
    const tenantSlug = tenants.find(t => t.id === currentTenantId)?.slug;

    const url = new URL(`${app.baseUrl}/auth/sso-redirect`);
    if (tenantSlug) url.searchParams.set('tenant', tenantSlug);
    window.location.href = url.toString();
  };

  const username = user?.username ?? '';
  const cleanUsername = username.startsWith('og_') ? username.slice(3) : username;
  // Prefer displayName for the top-right user pill; fall back to the cleaned
  // username when the SSO assertion did not provide one.
  const displayedName = anonymize(user?.displayName || cleanUsername, 'username');

  return (
    <header className="relative flex shrink-0 items-center gap-3 bg-bg-secondary px-4" style={{ height: 52 }}>
      {/* Logo — always visible in the topbar so it (and the tenant selector
          right next to it) stay accessible regardless of sidebar state. */}
      <Link to="/" className="flex items-center gap-2 shrink-0">
        <Logo className="h-8 w-auto max-w-[160px] object-contain" />
      </Link>

      {/* Tenant selector — sits left of the app switcher, preserving the
          context that gets carried across apps. */}
      <TenantSwitcher />

      {/* App switcher — container-wrapped pill group.
          The container reuses --c-bg-hover so its "outline" matches the user
          pill top-right on every theme. Only the current app + apps the user
          can reach via Obligate are rendered; inaccessible apps are hidden.
          The active pill uses a neutral raised surface (not a brand tint) so it
          reads as a professional tab bar; only the brand dot carries colour. */}
      {!isNativeApp && (
        <>
          {/* Flexible slot: squeezed by its siblings, so its width is the
              space really available — the switcher collapses when the
              labelled row would not fit it. */}
          {/* No overflow-hidden here: it would clip the "More…" dropdown. */}
          <div ref={switcherWrapRef} className="ml-1 flex-1 min-w-0 flex items-center">
            <nav className="flex items-center gap-1 rounded-lg bg-bg-hover p-1">
              {mainApps.map(app => pill(app, !collapsed))}
              {moreApps.length > 0 && (
                <div ref={moreRef} className="relative">
                  {moreButton(!collapsed, true)}
                  {moreOpen && (
                    <div className="absolute left-0 top-9 z-50 w-56 max-w-[calc(100vw-1.5rem)] rounded-xl bg-bg-secondary shadow-2xl overflow-hidden">
                      <div className="px-3 py-2">
                        <p className="text-xs font-semibold text-text-muted uppercase tracking-wide">{t('header.moreAppsTitle', 'Other apps')}</p>
                      </div>
                      <div className="py-1 max-h-64 overflow-y-auto overscroll-contain">
                        {moreApps.map(app => (
                          <button
                            key={app.appType + app.baseUrl}
                            type="button"
                            onClick={() => { setMoreOpen(false); goApp(app); }}
                            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left text-text-primary transition-colors hover:bg-bg-hover"
                          >
                            <span className="h-2 w-2 rounded-full shrink-0" style={{ background: app.color || FALLBACK_APP_COLOR }} />
                            <span className="truncate">{app.name}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </nav>
          </div>
          {/* Hidden measurer: the labelled row, off-screen, never interactive. */}
          <div
            ref={measureRef}
            aria-hidden
            className="absolute -z-10 opacity-0 pointer-events-none flex items-center gap-1 p-1"
            style={{ top: -9999, left: -9999 }}
          >
            {mainApps.map(app => pill(app, true))}
            {moreApps.length > 0 && moreButton(true, false)}
          </div>
        </>
      )}

      <div className="ml-auto flex items-center gap-3 shrink-0">
        {/* Download App link — hidden inside the native desktop app */}
        {!isNativeApp && (
          <Link
            to="/download"
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[13px] font-medium text-text-muted hover:bg-bg-hover hover:text-text-primary transition-colors"
          >
            <Download size={14} />
            {t('nav.downloadApp')}
          </Link>
        )}

        {/* Socket connection status dot */}
        <button
          onClick={socketStatus !== 'connected' ? () => window.location.reload() : undefined}
          title={
            socketStatus === 'connected'    ? t('header.socketConnected')    :
            socketStatus === 'reconnecting' ? t('header.socketReconnecting') :
                                              t('header.socketDisconnected')
          }
          className={cn(
            'flex h-7 w-7 items-center justify-center rounded-md transition-opacity',
            socketStatus !== 'connected' && 'cursor-pointer hover:opacity-70',
            socketStatus === 'connected'  && 'cursor-default',
          )}
        >
          <span
            className={cn(
              'h-2 w-2 rounded-full transition-colors',
              socketStatus === 'connected'    && 'bg-green-500',
              socketStatus === 'reconnecting' && 'bg-amber-400 animate-pulse',
              socketStatus === 'disconnected' && 'bg-red-500 animate-pulse',
            )}
          />
        </button>

        {/* Notification Center */}
        <NotificationCenter />

        {user && (
          <>
            <Link
              to="/profile"
              className="flex items-center gap-2 pl-1.5 pr-3 py-1 rounded-lg bg-bg-hover hover:bg-bg-active transition-colors"
            >
              {user.avatar ? (
                <img
                  src={user.avatar}
                  alt={displayedName}
                  className="w-7 h-7 rounded-full object-cover"
                />
              ) : (
                <div
                  className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-semibold text-white"
                  style={{ background: 'linear-gradient(135deg, rgba(30,221,138,0.6), rgba(92,240,168,0.4))' }}
                >
                  {(displayedName?.[0] ?? '?').toUpperCase()}
                </div>
              )}
              <span className="text-[13px] font-medium text-text-primary">{displayedName}</span>
              <span className="text-[10px] font-mono uppercase tracking-wider text-accent pl-2 border-l border-border-light">
                {user.role}
              </span>
            </Link>
            <button
              onClick={logout}
              title={t('nav.signOut')}
              className="flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-bg-hover hover:text-text-primary transition-colors"
            >
              <LogOut size={15} />
            </button>
          </>
        )}
      </div>
    </header>
  );
}

