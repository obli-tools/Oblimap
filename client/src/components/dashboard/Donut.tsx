import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

// Ported from Obliance client/src/pages/DashboardPage.tsx:160-208 (OsDonut),
// SVG only: viewBox 42×42, r = 15.915 so the
// circumference is 100 and dash lengths are percentages.

export interface DonutSlice {
  /** Stable key (e.g. the raw device type). */
  key: string;
  name: string;
  value: number;
  /** CSS color. */
  color: string;
  /** Optional link of the legend row. */
  to?: string;
}

export interface DonutProps {
  slices: DonutSlice[];
  total: number;
  /** Caption under the total (default "total"). */
  caption?: string;
}

export function Donut({ slices, total, caption }: DonutProps) {
  const { t } = useTranslation();
  let cumulative = 0;
  const arcs = slices.map((s) => {
    const len = total > 0 ? (s.value / total) * 100 : 0;
    const offset = -cumulative + 25;
    cumulative += len;
    return { ...s, len, offset };
  });
  return (
    <div className="flex items-center gap-5 max-sm:flex-col max-sm:items-stretch">
      <svg viewBox="0 0 42 42" className="h-28 w-28 shrink-0 max-sm:mx-auto" aria-hidden="true">
        <circle cx="21" cy="21" r="15.915" fill="none" stroke="rgb(var(--c-text-muted))" strokeOpacity="0.1" strokeWidth="3.5" />
        {arcs.map((a) => (
          <circle
            key={a.key}
            cx="21"
            cy="21"
            r="15.915"
            fill="none"
            stroke={a.color}
            strokeWidth="3.5"
            strokeDasharray={`${a.len} ${100 - a.len}`}
            strokeDashoffset={a.offset}
          />
        ))}
        <text x="21" y="20" textAnchor="middle" dominantBaseline="middle" fill="rgb(var(--c-text-primary))" fontSize="6.5" fontWeight="600">
          {total}
        </text>
        <text
          x="21"
          y="26"
          textAnchor="middle"
          dominantBaseline="middle"
          fill="rgb(var(--c-text-muted))"
          fontSize="2.6"
          fontFamily="JetBrains Mono, monospace"
        >
          {caption ?? t('dashboard.donutTotal', 'total')}
        </text>
      </svg>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {slices.map((s) => {
          const pct = total > 0 ? Math.round((s.value / total) * 100) : 0;
          const inner = (
            <>
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: s.color }} />
              <span className="min-w-0 flex-1 truncate font-medium text-text-primary">{s.name}</span>
              <span className="shrink-0 font-mono text-[11px] text-text-muted">
                {s.value} · {pct}%
              </span>
            </>
          );
          return s.to ? (
            <Link
              key={s.key}
              to={s.to}
              className="-mx-1.5 flex items-center gap-3 rounded px-1.5 py-0.5 text-[13px] transition-colors hover:bg-bg-hover coarse:min-h-10"
            >
              {inner}
            </Link>
          ) : (
            <div key={s.key} className="flex items-center gap-3 text-[13px]">
              {inner}
            </div>
          );
        })}
      </div>
    </div>
  );
}
