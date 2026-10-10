import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, RotateCw } from 'lucide-react';
import { cn } from '@/utils/cn';

export interface LoadErrorProps {
  /** Error text (default t('common.loadFailed')). */
  message?: ReactNode;
  /** Retry handler; the Retry button is shown when set. */
  onRetry?: () => void;
  className?: string;
}

/**
 * Inline "could not load" block for a page or a panel whose data request
 * failed: warning icon, message and a Retry button.
 *
 *   if (error) return <LoadError onRetry={load} />;
 */
export function LoadError({ message, onRetry, className }: LoadErrorProps) {
  const { t } = useTranslation();
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-xl bg-bg-secondary px-6 py-10 text-center',
        className,
      )}
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-500/10">
        <AlertTriangle className="h-5 w-5 text-red-400" />
      </div>
      <p className="max-w-md text-sm text-text-secondary">
        {message ?? t('common.loadFailed', 'Could not load the data.')}
      </p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className={cn(
            'inline-flex items-center gap-2 rounded-lg bg-bg-tertiary px-3 py-1.5 text-sm font-medium text-text-primary',
            'transition-colors hover:bg-bg-hover coarse:min-h-11 coarse:px-4',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
          )}
        >
          <RotateCw className="h-4 w-4" />
          {t('common.retry', 'Retry')}
        </button>
      )}
    </div>
  );
}
