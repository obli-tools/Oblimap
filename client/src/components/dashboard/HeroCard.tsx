import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/utils/cn';
import { Sparkline } from './Sparkline';

// Ported from Obliance client/src/pages/DashboardPage.tsx:69-160
// (HeroFeatured / HeroCard). Borderless: depth from the shadow and the
// background delta only. Each card is a
// whole Link to the filtered list it summarises.

/** Shadow of the standard dashboard cards. */
export const CARD_SHADOW = 'shadow-[0_1px_0_0_rgba(255,255,255,0.03),_0_6px_24px_-8px_rgba(0,0,0,0.45)]';

const LINK_CLASS =
  'block h-full rounded-xl transition-opacity hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60';

/**
 * Arrow and color of a delta: positive ↑ green, negative ↓ red, zero — muted.
 * No delta (undefined / null: no comparison) → no marker at all, the text is
 * then a plain caption, not a change.
 */
function deltaStyle(delta: number | null | undefined): { icon: string; className: string } | null {
  if (delta == null) return null;
  if (delta === 0) return { icon: '—', className: 'text-text-muted' };
  return delta > 0 ? { icon: '↑', className: 'text-green-400' } : { icon: '↓', className: 'text-red-400' };
}

export interface HeroFeaturedProps {
  to: string;
  label: string;
  value: ReactNode;
  /** Text color class of the value (default text-accent). */
  color?: string;
  /** Sparkline series, oldest first. */
  series: number[];
  /** The last few days under the sparkline (the last one is "today"). */
  days: { short: string; value: number }[];
  /** Sign of the change for the arrow (positive = ↑). */
  delta?: number | null;
  deltaText?: string;
  sparklineLabel?: string;
}

export function HeroFeatured({
  to, label, value, color = 'text-accent', series, days, delta, deltaText, sparklineLabel,
}: HeroFeaturedProps) {
  const d = deltaStyle(delta);
  return (
    <Link to={to} className={LINK_CLASS}>
      <div className="relative flex h-full flex-col overflow-hidden rounded-xl bg-gradient-to-br from-accent/10 via-bg-secondary to-bg-secondary p-5 shadow-[0_0_0_1px_rgb(var(--c-accent)/0.18)_inset,_0_6px_28px_-10px_rgb(var(--c-accent)/0.25)]">
        <div className="mb-3 font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">{label}</div>
        <div className={cn('font-display text-[48px] font-semibold leading-none', color)}>{value}</div>
        {deltaText && (
          <div className={cn('mt-2 font-mono text-[12px]', d ? d.className : 'text-text-muted')}>
            {d && <span className="mr-1">{d.icon}</span>}
            {deltaText}
          </div>
        )}
        <div className="mt-3">
          <Sparkline data={series} color="rgb(var(--c-accent))" label={sparklineLabel} />
        </div>
        {days.length > 0 && (
          <div className="mt-2 grid grid-cols-4 gap-2">
            {days.map((day, i) => {
              const isLast = i === days.length - 1;
              return (
                <div key={i} className={cn('flex flex-col items-start', isLast ? 'text-text-primary' : 'text-text-muted')}>
                  <span className="font-mono text-[10px] uppercase tracking-wider">{day.short}</span>
                  <span className={cn('font-mono text-[12px]', isLast ? 'font-semibold text-text-primary' : 'text-text-secondary')}>
                    {day.value}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Link>
  );
}

export interface HeroCardProps {
  to: string;
  label: string;
  value: ReactNode;
  /** Text color class of the value. */
  color: string;
  /** Sign of the change for the arrow (positive = ↑ green, negative = ↓ red). */
  delta?: number | null;
  deltaText?: string;
  /** Text color class of deltaText when no delta is given (default muted). */
  deltaColor?: string;
  /** Optional progress bar (0–100). */
  barPct?: number;
  /** CSS color of the bar (default the accent). */
  barColor?: string;
  /** Optional breakdown under the bar. */
  subStats?: Array<{ label: string; value: number; color?: string }>;
}

export function HeroCard({ to, label, value, color, delta, deltaText, deltaColor, barPct, barColor, subStats }: HeroCardProps) {
  const d = deltaStyle(delta);
  return (
    <Link to={to} className={LINK_CLASS}>
      <div className={cn('relative flex h-full flex-col overflow-hidden rounded-xl bg-bg-secondary p-5', CARD_SHADOW)}>
        <div className="mb-3 font-mono text-[11px] uppercase tracking-[0.14em] text-text-muted">{label}</div>
        <div className={cn('font-display text-[36px] font-semibold leading-none', color)}>{value}</div>
        {(d || deltaText) && (
          <div className={cn('mt-3 font-mono text-[12px]', d ? d.className : deltaColor ?? 'text-text-muted')}>
            {d && <span className="mr-1">{d.icon}</span>}
            {deltaText}
          </div>
        )}
        {barPct != null && (
          <div className="mt-2 h-1 w-full rounded bg-text-muted/10">
            <div
              className="h-full rounded"
              style={{ width: `${Math.min(100, Math.max(0, barPct))}%`, background: barColor ?? 'rgb(var(--c-accent))' }}
            />
          </div>
        )}
        {subStats && subStats.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-text-muted">
            {subStats.map((s) => (
              <span key={s.label} className="flex items-center gap-1">
                <span className={s.color ?? 'text-text-secondary'}>{s.value}</span>
                <span>{s.label}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </Link>
  );
}
