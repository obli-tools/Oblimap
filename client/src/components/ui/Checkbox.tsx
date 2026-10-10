import { forwardRef } from 'react';
import { cn } from '@/utils/cn';

export interface CheckboxProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  /** Callback with the new boolean value (convenience over raw onChange) */
  onCheckedChange?: (checked: boolean) => void;
  /** Extra classes applied to the outer wrapper div */
  wrapperClassName?: string;
}

/**
 * Custom styled checkbox.
 * - appearance-none so Tailwind controls the look (no browser-native white box)
 * - Dark bg-bg-primary when unchecked, accent colour when checked
 * - SVG checkmark overlay (peer-checked) + dash overlay (peer-indeterminate)
 * - Supports forwardRef for programmatic .indeterminate access
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  (
    {
      checked,
      onCheckedChange,
      onChange,
      id,
      disabled,
      title,
      wrapperClassName,
      className,
      onClick,
      ...rest
    },
    ref,
  ) => {
    return (
      <div className={cn('relative h-4 w-4 shrink-0', wrapperClassName)}>
        <input
          ref={ref}
          type="checkbox"
          id={id}
          checked={checked}
          onChange={
            onCheckedChange
              ? (e) => onCheckedChange(e.target.checked)
              : onChange
          }
          disabled={disabled}
          title={title}
          onClick={onClick}
          className={cn(
            'peer appearance-none h-4 w-4 rounded border cursor-pointer transition-colors',
            'bg-bg-primary border-border-light',
            'checked:bg-accent checked:border-accent',
            'indeterminate:bg-accent/70 indeterminate:border-accent',
            'focus:outline-none focus:ring-2 focus:ring-accent/30',
            disabled && 'opacity-50 cursor-not-allowed',
            className,
          )}
          {...rest}
        />
        {/* Checkmark — checked */}
        <svg
          className="pointer-events-none absolute top-0 left-0 hidden h-4 w-4 text-white peer-checked:block"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2.5 8L6 11.5L13.5 4.5" />
        </svg>
        {/* Dash — indeterminate */}
        <svg
          className="pointer-events-none absolute top-0 left-0 hidden h-4 w-4 text-white peer-indeterminate:block"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        >
          <path d="M3.5 8H12.5" />
        </svg>
      </div>
    );
  },
);
Checkbox.displayName = 'Checkbox';
