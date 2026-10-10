import type { ReactNode } from 'react';
import { cn } from '@/utils/cn';

export interface EmptyStateProps {
  /** Icon (e.g. <Router className="h-6 w-6" />), shown in a muted tile. */
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Call to action (a Button or Link). */
  action?: ReactNode;
  className?: string;
}

/**
 * Placeholder for an empty list or page: icon, title, optional description
 * and an optional call to action.
 *
 *   <EmptyState icon={<Server className="h-6 w-6" />} title={t('x.none')} action={<Button>…</Button>} />
 */
export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-xl bg-bg-secondary px-6 py-12 text-center',
        className,
      )}
    >
      {icon != null && (
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-bg-tertiary text-text-muted">
          {icon}
        </div>
      )}
      <div className="space-y-1">
        <p className="text-sm font-medium text-text-primary">{title}</p>
        {description != null && <p className="mx-auto max-w-md text-sm text-text-muted">{description}</p>}
      </div>
      {action != null && <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}
