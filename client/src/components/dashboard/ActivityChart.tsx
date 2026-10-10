import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMediaQuery, MEDIA } from '@/hooks/useMediaQuery';

// Ported from Obliance client/src/pages/DashboardPage.tsx:217 (ActivityChart),
// SVG only: a primary series as a solid line
// over a filled area, a secondary series as a dashed line, 3 horizontal
// ticks (0 / 50 % / 100 %) and 3 x-axis labels (first / middle / last).

export interface ActivityPoint {
  /** X-axis label (e.g. a short date). */
  label: string;
  primary: number;
  secondary: number;
}

export interface ActivityChartProps {
  data: ActivityPoint[];
  /** CSS colors (theme tokens welcome). */
  primaryColor?: string;
  secondaryColor?: string;
  /** Accessible summary of the chart. */
  ariaLabel?: string;
}

export function ActivityChart({
  data,
  primaryColor = 'rgb(var(--c-status-up))',
  secondaryColor = 'rgb(var(--c-text-muted))',
  ariaLabel,
}: ActivityChartProps) {
  const { t } = useTranslation();
  const gradientId = `ag-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  // Desktop keeps an 800×240 viewBox stretched to the card width. Below lg
  // the viewBox follows the measured width with a fixed 200 px height so the
  // axis labels stay readable on a phone.
  const isDesktop = useMediaQuery(MEDIA.lg);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(0);
  useEffect(() => {
    if (isDesktop) return;
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setMeasured(Math.round(el.getBoundingClientRect().width));
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isDesktop, data.length]);

  if (data.length < 2) {
    return (
      <div className="flex h-[240px] items-center justify-center text-sm text-text-muted">
        {t('dashboard.notEnoughHistory', 'Not enough history yet: data appears after the first daily snapshot')}
      </div>
    );
  }

  const yMax = Math.max(...data.map((d) => Math.max(d.primary, d.secondary)), 1);
  const narrow = !isDesktop && measured > 0;
  const w = narrow ? Math.max(measured, 240) : 800;
  const h = narrow ? 200 : 240;
  const pad = { l: 36, r: 12, t: 16, b: 28 };
  const cw = w - pad.l - pad.r;
  const ch = h - pad.t - pad.b;
  const xOf = (i: number) => pad.l + (i / (data.length - 1)) * cw;
  const yOf = (v: number) => pad.t + (1 - v / yMax) * ch;
  const pathOf = (pick: (d: ActivityPoint) => number) =>
    data.map((d, i) => `${i === 0 ? 'M' : 'L'}${xOf(i).toFixed(1)},${yOf(pick(d)).toFixed(1)}`).join(' ');
  const primaryPath = pathOf((d) => d.primary);
  const secondaryPath = pathOf((d) => d.secondary);
  const primaryArea = `${primaryPath} L${xOf(data.length - 1)},${pad.t + ch} L${xOf(0)},${pad.t + ch} Z`;
  // Integer ticks: deduplicated so a small yMax (1, 2) does not print "1" twice.
  const ticks = [...new Set([0, 0.5, 1].map((f) => Math.round(yMax * f)))];
  const labelIdx = [...new Set([0, Math.floor(data.length / 2), data.length - 1])];

  return (
    <div ref={wrapRef} className="w-full">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="block w-full"
        preserveAspectRatio="none"
        style={narrow ? { height: h } : undefined}
        role="img"
        aria-label={ariaLabel}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={primaryColor} stopOpacity="0.30" />
            <stop offset="100%" stopColor={primaryColor} stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((v) => (
          <g key={v}>
            <line
              x1={pad.l}
              x2={w - pad.r}
              y1={yOf(v)}
              y2={yOf(v)}
              stroke="rgb(var(--c-text-muted))"
              strokeOpacity="0.12"
              strokeWidth="1"
            />
            <text
              x={pad.l - 6}
              y={yOf(v) + 3}
              fontSize="10"
              fontFamily="JetBrains Mono, monospace"
              fill="rgb(var(--c-text-muted))"
              textAnchor="end"
            >
              {v}
            </text>
          </g>
        ))}
        <path d={primaryArea} fill={`url(#${gradientId})`} />
        <path d={primaryPath} fill="none" stroke={primaryColor} strokeWidth="1.8" strokeLinejoin="round" />
        <path
          d={secondaryPath}
          fill="none"
          stroke={secondaryColor}
          strokeWidth="1.4"
          strokeDasharray="4 3"
          strokeLinejoin="round"
        />
        {labelIdx.map((i) => (
          <text
            key={i}
            x={xOf(i)}
            y={h - 8}
            fontSize="10"
            fontFamily="JetBrains Mono, monospace"
            fill="rgb(var(--c-text-muted))"
            textAnchor={i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle'}
          >
            {data[i].label}
          </text>
        ))}
      </svg>
    </div>
  );
}
