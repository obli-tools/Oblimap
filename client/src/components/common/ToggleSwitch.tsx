import type { ReactNode } from 'react';
import { cn } from '@/utils/cn';

export interface ToggleSwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  size?: 'sm' | 'md';
  label?: ReactNode;
  description?: ReactNode;
  /** Native tooltip (hover devices). */
  title?: string;
  /**
   * Accessible name of the switch when it has no visible `label` (a
   * wrapping element's aria-label does not name the control).
   */
  ariaLabel?: string;
  /** Id(s) of the element(s) that describe the switch (e.g. why it is disabled / inherited). */
  ariaDescribedBy?: string;
  className?: string;
}

/**
 * iOS-style toggle switch (ported from Obliance). Drop-in replacement for
 * checkbox inputs used to represent booleans. Accessible (role="switch",
 * aria-checked). Borderless track: depth comes from the background delta.
 *
 * Positioning is done with inline styles rather than Tailwind utility classes
 * to avoid ambiguous absolute-anchoring bugs where the knob ends up at the
 * wrong edge of the track.
 *
 * Touch: an invisible hit area grows the track to ≥ 40 px tall on coarse
 * pointers without moving the layout.
 */
export function ToggleSwitch({
  checked,
  onChange,
  disabled = false,
  size = 'md',
  label,
  description,
  title,
  ariaLabel,
  ariaDescribedBy,
  className,
}: ToggleSwitchProps) {
  // Geometry (px): the knob keeps a 2px padding from the track edge in both positions.
  const G = size === 'sm'
    ? { trackW: 32, trackH: 16, knob: 12, pad: 2 }
    : { trackW: 40, trackH: 20, knob: 16, pad: 2 };
  const translateX = checked ? G.trackW - G.knob - G.pad : G.pad;

  const toggle = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); if (!disabled) onChange(!checked); }}
      title={title}
      style={{ width: G.trackW, height: G.trackH }}
      className={cn(
        'relative shrink-0 rounded-full transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
        // Invisible touch hit area (≥ 40 px tall), layout unchanged.
        "coarse:after:absolute coarse:after:-inset-x-2 coarse:after:-inset-y-3 coarse:after:content-['']",
        checked ? 'bg-accent' : 'bg-bg-hover',
        disabled && 'cursor-not-allowed opacity-50',
        !label && !description && className,
      )}
    >
      <span
        className="absolute rounded-full bg-white shadow-sm transition-transform"
        style={{
          top: (G.trackH - G.knob) / 2,
          left: 0,
          width: G.knob,
          height: G.knob,
          transform: `translateX(${translateX}px)`,
        }}
      />
    </button>
  );

  if (!label && !description) return toggle;

  return (
    <label className={cn('flex items-start gap-2.5', disabled ? 'cursor-not-allowed' : 'cursor-pointer', className)}>
      {toggle}
      <span className="flex min-w-0 flex-col">
        {label && <span className="text-sm text-text-primary">{label}</span>}
        {description && <span className="text-xs text-text-muted">{description}</span>}
      </span>
    </label>
  );
}
