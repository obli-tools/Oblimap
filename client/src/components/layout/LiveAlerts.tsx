import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { useLiveAlertsStore, isResolved } from '@/store/liveAlertsStore';
import type { LiveAlert, AlertSeverity } from '@/store/liveAlertsStore';
import { useTenantStore } from '@/store/tenantStore';
import { cn } from '@/utils/cn';
import { useAlertText } from '@/utils/alertText';

const TOAST_LIFETIME_MS     = 60_000;  // bottom-right: 1 min from alert.createdAt
const TOP_CENTER_LIFETIME_MS = 10_000; // top-center: 10 s (user sees only the latest)

const SEVERITY_STYLES: Record<AlertSeverity, { bar: string; title: string }> = {
  down:    { bar: 'border-l-red-500',   title: 'text-red-400'   },
  up:      { bar: 'border-l-green-500', title: 'text-green-400' },
  warning: { bar: 'border-l-amber-500', title: 'text-amber-400' },
  info:    { bar: 'border-l-blue-500',  title: 'text-blue-400'  },
};

/** Muted style of a resolved alert (the problem it reported is over). */
const RESOLVED_STYLES = { bar: 'border-l-zinc-500', title: 'text-text-muted' };

// ─── Shared pieces (also for the notification center) ─────────────────────────

/** "Resolved" pill shown on an alert whose problem is over. */
export function ResolvedPill({ className }: { className?: string }) {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        'shrink-0 rounded-full bg-zinc-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-muted',
        className,
      )}
    >
      {t('liveAlerts.resolved', 'Resolved')}
    </span>
  );
}

/** Switch for the "hide resolved alerts" preference (on by default). */
export function ResolvedAlertsToggle({ className }: { className?: string }) {
  const { t } = useTranslation();
  const hideResolved = useLiveAlertsStore((s) => s.hideResolved);
  const setHideResolved = useLiveAlertsStore((s) => s.setHideResolved);
  const label = t('liveAlerts.hideResolved', 'Hide resolved alerts');
  return (
    <div className={cn('flex items-center justify-between', className)}>
      <span className="text-xs text-text-muted">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={hideResolved}
        aria-label={label}
        onClick={() => setHideResolved(!hideResolved)}
        className={cn(
          'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors focus:outline-none',
          hideResolved ? 'bg-accent' : 'bg-text-muted/30',
        )}
      >
        <span
          className={cn(
            'inline-block h-3 w-3 rounded-full bg-white shadow transition-transform',
            hideResolved ? 'translate-x-3.5' : 'translate-x-0.5',
          )}
        />
      </button>
    </div>
  );
}

// ─── Single toast card ────────────────────────────────────────────────────────

interface AlertCardProps {
  alert: LiveAlert;
  opacity?: number;
  lifetimeMs: number;
}

function AlertCard({ alert, opacity = 1, lifetimeMs }: AlertCardProps) {
  const { t } = useTranslation();
  const { dismissToast } = useLiveAlertsStore();
  const navigate = useNavigate();
  // Translated from kind / params, anonymized in anonymous mode.
  const text = useAlertText()(alert);
  const resolved = isResolved(alert);
  const styles = resolved ? RESOLVED_STYLES : SEVERITY_STYLES[alert.severity];

  // Per-notification independent timer — respects elapsed time since createdAt.
  // If the page reloads after the window has already elapsed, the toast is
  // immediately dismissed without rendering.
  useEffect(() => {
    const elapsed = Date.now() - new Date(alert.createdAt).getTime();
    const msRemaining = Math.max(0, lifetimeMs - elapsed);

    if (msRemaining === 0) {
      dismissToast(alert.id);
      return;
    }

    const timer = setTimeout(() => dismissToast(alert.id), msRemaining);
    return () => clearTimeout(timer);
  }, [alert.id, alert.createdAt, lifetimeMs, dismissToast]);

  const handleCardClick = () => {
    if (alert.navigateTo) {
      navigate(alert.navigateTo);
    }
  };

  return (
    <div
      className={cn(
        'relative flex items-stretch rounded-xl border border-border/50 backdrop-blur-md bg-bg-secondary/80 shadow-lg overflow-hidden transition-opacity duration-300',
        alert.navigateTo && 'cursor-pointer hover:bg-bg-secondary/90',
        `border-l-4 ${styles.bar}`,
        resolved && 'grayscale',
      )}
      style={{ opacity: resolved ? Math.min(opacity, 0.6) : opacity }}
      onClick={handleCardClick}
    >
      <div className="flex-1 p-3 pr-8 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <p className={cn('text-sm font-semibold leading-tight truncate', styles.title)}>
            {text.title}
          </p>
          {resolved && <ResolvedPill />}
        </div>
        <p className="text-xs text-text-muted mt-0.5 leading-snug line-clamp-2">
          {text.message}
        </p>
      </div>

      {/* Dismiss button — hides from tray but keeps alert in the bell */}
      <button
        className="absolute top-2 right-2 text-text-muted hover:text-text-primary transition-colors"
        onClick={(e) => {
          e.stopPropagation();
          dismissToast(alert.id);
        }}
        aria-label={t('liveAlerts.dismiss', 'Dismiss')}
      >
        <X size={13} />
      </button>
    </div>
  );
}

// ─── Main LiveAlerts renderer ──────────────────────────────────────────────────

export function LiveAlerts() {
  const { alerts, localEnabled, multiTenantEnabled, position, hideResolved } = useLiveAlertsStore();
  const { currentTenantId } = useTenantStore();

  const lifetimeMs = position === 'top-center' ? TOP_CENTER_LIFETIME_MS : TOAST_LIFETIME_MS;
  const now = Date.now();

  // Compute which toasts should currently be visible in the tray
  const visibleToasts = alerts.filter((a) => {
    if (a.toastDismissed) return false;
    // Resolved alerts: hidden by default, else shown greyed until their toast expires
    if (hideResolved && isResolved(a)) return false;
    // Already past the lifetime window — don't render (AlertCard.useEffect will dismiss on mount)
    if (now - new Date(a.createdAt).getTime() >= lifetimeMs) return false;
    // Per-tenant preference filter
    // If currentTenantId is not yet loaded, treat all alerts as local
    const isLocal = currentTenantId !== null ? a.tenantId === currentTenantId : true;
    return isLocal ? localEnabled : multiTenantEnabled;
  });

  if (visibleToasts.length === 0) return null;

  if (position === 'top-center') {
    // Only show the newest alert
    const latest = visibleToasts[0];
    return (
      <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 w-[400px] max-w-[calc(100vw-2rem)] animate-fade-in">
        <AlertCard key={latest.id} alert={latest} lifetimeMs={TOP_CENTER_LIFETIME_MS} />
      </div>
    );
  }

  // bottom-right: show up to 10, newest at bottom, older stacked above with fading opacity
  const capped = visibleToasts.slice(0, 10);

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col-reverse gap-2 w-80 max-w-[calc(100vw-2rem)]">
      {capped.map((alert, index) => {
        const opacity = Math.max(0.4, 1 - index * 0.15);
        return (
          <AlertCard
            key={alert.id}
            alert={alert}
            opacity={opacity}
            lifetimeMs={TOAST_LIFETIME_MS}
          />
        );
      })}
    </div>
  );
}
