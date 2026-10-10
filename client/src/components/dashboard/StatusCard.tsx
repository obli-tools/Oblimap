import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { cn } from '@/utils/cn';
import { CARD_SHADOW } from './HeroCard';

// Bottom status card of the Obli dashboard pattern (
// "4 small status cards — icon left, label / name / count, badge right";
// Obliance secondary metrics row, DashboardPage.tsx:424-474). Borderless.

export interface StatusCardProps {
  icon: ReactNode;
  /** Small caption above the main line. */
  label: string;
  /** Main line (a name, a relative time…). */
  primary: ReactNode;
  /** Optional muted line under it. */
  secondary?: ReactNode;
  /** Badge on the right (a count, a percentage…). */
  badge?: ReactNode;
  /** Badge text color class. */
  badgeColor?: string;
  /** Optional progress bar (0–100) under the text. */
  barPct?: number;
  barColor?: string;
  /** Destination of the card; text of its footer link. */
  to?: string;
  linkLabel?: string;
}

export function StatusCard({
  icon, label, primary, secondary, badge, badgeColor = 'text-text-primary', barPct, barColor, to, linkLabel,
}: StatusCardProps) {
  const body = (
    <div className={cn('flex h-full flex-col gap-3 rounded-xl bg-bg-secondary p-5', CARD_SHADOW)}>
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">{icon}</div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">{label}</div>
          <div className="truncate text-[14px] font-semibold text-text-primary">{primary}</div>
          {secondary != null && <div className="truncate font-mono text-[11px] text-text-muted">{secondary}</div>}
        </div>
        {badge != null && (
          <div className={cn('shrink-0 font-display text-[28px] font-semibold leading-none', badgeColor)}>{badge}</div>
        )}
      </div>
      {barPct != null && (
        <div className="h-1.5 w-full overflow-hidden rounded bg-text-muted/10">
          <div
            className="h-full rounded"
            style={{ width: `${Math.min(100, Math.max(0, barPct))}%`, background: barColor ?? 'rgb(var(--c-accent))' }}
          />
        </div>
      )}
      {to && linkLabel && (
        <div className="mt-auto flex items-center gap-1 font-mono text-[11px] text-text-muted">
          {linkLabel} <ArrowRight size={11} />
        </div>
      )}
    </div>
  );
  if (!to) return body;
  return (
    <Link
      to={to}
      className="block h-full rounded-xl transition-opacity hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
    >
      {body}
    </Link>
  );
}
