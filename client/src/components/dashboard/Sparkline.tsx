import { useId } from 'react';

// Ported from Obliance client/src/pages/DashboardPage.tsx:38 (Sparkline):
// a filled area under a line, SVG only. `color` is any CSS color, theme
// tokens included (e.g. 'rgb(var(--c-accent))').

export interface SparklineProps {
  data: number[];
  color: string;
  height?: number;
  /** Accessible description; the sparkline is decorative without it. */
  label?: string;
}

export function Sparkline({ data, color, height = 36, label }: SparklineProps) {
  // useId: two sparklines of the same color must not share a gradient id.
  const gradientId = `sg-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  if (data.length < 2) return <div style={{ height }} />;
  const max = Math.max(...data, 1);
  const min = Math.min(...data, 0);
  const range = max - min || 1;
  const w = 200;
  const h = height;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 4) - 2;
    return [x, y];
  });
  const linePath = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${w},${h} L0,${h} Z`;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height }}
      className="block"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.40" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradientId})`} />
      <path d={linePath} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
