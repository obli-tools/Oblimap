import { useCallback, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Menu } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { DesktopUpdateBanner } from './DesktopUpdateBanner';
import { LiveAlerts } from './LiveAlerts';
import { GlobalAddProbeModal } from './GlobalAddProbeModal';
import { useUiStore } from '@/store/uiStore';
import { useSocket } from '@/hooks/useSocket';
import { useLayoutMode } from '@/hooks/useMediaQuery';
import { Drawer } from '@/components/common/Drawer';
import { IconButton } from '@/components/common/IconButton';
import { cn } from '@/utils/cn';

export function AppLayout() {
  // Global socket subscriptions — always active regardless of which page is open
  useSocket();

  const { t } = useTranslation();
  const {
    sidebarOpen, sidebarWidth, setSidebarWidth, sidebarFloating, sidebarCollapsed,
    mobileNavOpen, setMobileNavOpen,
  } = useUiStore();
  // Below lg (phone / tablet) the sidebar is an off-canvas drawer opened by
  // the hamburger; the stored width / collapsed / floating preferences are
  // ignored there (left untouched for the desktop).
  const isDrawer = useLayoutMode() !== 'desktop';
  const dragging = useRef(false);
  const startX = useRef(0);
  const startWidth = useRef(0);

  // ── Body-row top offset ────────────────────────────────────────────────────
  // Floating sidebar is `position: fixed` and must drop down from BELOW the
  // topbar — not from y=0. We measure where the body row (header excluded)
  // actually starts and use that as the floating sidebar's top anchor. This
  // also handles the native desktop app's tab bar (added as body padding-top).
  const bodyRowRef = useRef<HTMLDivElement>(null);
  const [topOffset, setTopOffset] = useState(0);

  useEffect(() => {
    const measure = () => {
      if (bodyRowRef.current) {
        setTopOffset(bodyRowRef.current.getBoundingClientRect().top);
      }
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  // ── Off-canvas drawer (phone / tablet) ────────────────────────────────────
  // Closes on every navigation (location.key changes even when the same link
  // is tapped again) and whenever the layout leaves drawer mode, so it never
  // pops back open after a resize / rotation.
  const location = useLocation();
  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.key, setMobileNavOpen]);
  useEffect(() => {
    if (!isDrawer) setMobileNavOpen(false);
  }, [isDrawer, setMobileNavOpen]);
  const closeMobileNav = useCallback(() => setMobileNavOpen(false), [setMobileNavOpen]);

  // ── Floating sidebar visibility ───────────────────────────────────────────
  const [floatVisible, setFloatVisible] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!sidebarFloating || isDrawer) setFloatVisible(false);
  }, [sidebarFloating, isDrawer]);

  const showFloat = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setFloatVisible(true);
  }, []);

  const hideFloat = useCallback(() => {
    hideTimer.current = setTimeout(() => setFloatVisible(false), 150);
  }, []);

  // ── Resize handle ─────────────────────────────────────────────────────────
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      startX.current = e.clientX;
      startWidth.current = sidebarWidth;

      const handleMouseMove = (ev: MouseEvent) => {
        if (!dragging.current) return;
        const delta = ev.clientX - startX.current;
        setSidebarWidth(startWidth.current + delta);
      };

      const handleMouseUp = () => {
        dragging.current = false;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [sidebarWidth, setSidebarWidth],
  );

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg-primary">

      {/* Full-width topbar — always on top of the sidebar so logo + tenant
          selector + app pills stay visible regardless of sidebar state
          (collapsed, floating, hidden).
          Below lg a hamburger in front of it opens the navigation drawer. The
          header keeps overflow visible (its dropdowns are absolutely
          positioned); the root's overflow-hidden keeps a header wider than a
          phone screen from widening the page. */}
      <div className="flex shrink-0 items-center bg-bg-secondary">
        {isDrawer && (
          <IconButton
            label={t('nav.openMenu', 'Open menu')}
            icon={<Menu className="h-5 w-5" />}
            size="md"
            onClick={() => setMobileNavOpen(true)}
            aria-expanded={mobileNavOpen}
            className="ml-2 shrink-0"
          />
        )}
        <div className="min-w-0 flex-1">
          <Header />
        </div>
      </div>
      <DesktopUpdateBanner />

      {/* Body row — sidebar + main content side by side, below the topbar */}
      <div ref={bodyRowRef} className="flex flex-1 overflow-hidden">

        {isDrawer ? null : sidebarFloating ? (
          <>
            {/* Invisible hover-trigger strip on the far left edge of the body
                row (excludes the topbar so the user can still click logo /
                tenant when the sidebar is auto-hidden). */}
            <div
              className="fixed left-0 z-[51]"
              style={{ top: topOffset, height: `calc(100% - ${topOffset}px)`, width: '8px' }}
              onMouseEnter={showFloat}
            />

            {/* Floating sidebar — slides in from left on hover, anchored to
                the body row top so it never overlaps the topbar. */}
            <div
              className={cn(
                'fixed left-0 z-50',
                'transition-transform duration-200 ease-in-out',
                'shadow-[4px_0_24px_0_rgba(0,0,0,0.35)]',
                floatVisible ? 'translate-x-0' : '-translate-x-full',
              )}
              style={{ width: `${sidebarWidth}px`, top: topOffset, height: `calc(100% - ${topOffset}px)` }}
              onMouseEnter={showFloat}
              onMouseLeave={hideFloat}
            >
              <Sidebar variant="floating" />

              {/* Resize handle — still usable in floating mode */}
              <div
                onMouseDown={handleMouseDown}
                className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-accent/30 active:bg-accent/50 transition-colors z-10"
              />
            </div>
          </>
        ) : (
          /* ── Normal pinned sidebar ── */
          <div
            className={cn(
              'flex-shrink-0 transition-all duration-200 relative',
              !sidebarOpen && 'w-0 overflow-hidden',
            )}
            style={sidebarOpen
              ? { width: sidebarCollapsed ? '64px' : `${sidebarWidth}px` }
              : undefined}
          >
            <Sidebar variant="pinned" />

            {/* Resize handle — disabled while collapsed (fixed 64 px width). */}
            {sidebarOpen && !sidebarCollapsed && (
              <div
                onMouseDown={handleMouseDown}
                className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-accent/30 active:bg-accent/50 transition-colors z-10"
              />
            )}
          </div>
        )}

        {/* Main content — min-w-0: a wide page (tables, toolbars) scrolls inside itself
            instead of widening the layout; safe-area padding keeps content
            clear of the gesture bar / notch (0 on desktop). */}
        <main className="flex min-w-0 flex-1 flex-col overflow-y-auto px-safe pb-safe">
          <Outlet />
        </main>

      </div>

      {/* Phone / tablet navigation: the sidebar as an off-canvas drawer,
          opened by the hamburger. The Drawer closes itself on backdrop tap
          and Escape. */}
      {isDrawer && (
        <Drawer
          open={mobileNavOpen}
          onClose={closeMobileNav}
          side="left"
          ariaLabel={t('nav.menu', 'Menu')}
          bodyClassName="flex flex-col overflow-hidden p-0"
        >
          <Sidebar variant="drawer" />
        </Drawer>
      )}

      {/* Live alert toasts */}
      <LiveAlerts />

      {/* Global Add Probe modal (triggered from sidebar / dashboard) */}
      <GlobalAddProbeModal />
    </div>
  );
}
