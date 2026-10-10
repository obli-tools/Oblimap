import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/utils/cn';

// Ported from Obliance client/src/pages/DashboardPage.tsx:292 (MiniStat):
// compact icon + label + value card. Every
// mini-stat of the dashboard navigates to the matching page.

export interface MiniStatProps {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  sub?: string;
  /** Text color class of the value. */
  color?: string;
  to: string;
  /** Tooltip of the card. */
  title?: string;
}

export function MiniStat({ icon, label, value, sub, color = 'text-text-primary', to, title }: MiniStatProps) {
  return (
    <Link
      to={to}
      title={title}
      className="block rounded-lg transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
    >
      <div className="flex items-center gap-3 rounded-lg bg-bg-secondary px-3.5 py-2.5 shadow-[0_1px_0_0_rgba(255,255,255,0.03),_0_4px_16px_-8px_rgba(0,0,0,0.35)] coarse:min-h-14">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-bg-hover text-text-muted">{icon}</div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">{label}</div>
          <div className={cn('truncate text-[14px] font-semibold leading-tight', color)}>{value}</div>
          {sub && <div className="truncate font-mono text-[10px] text-text-muted">{sub}</div>}
        </div>
      </div>
    </Link>
  );
}
