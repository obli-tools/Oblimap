import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import { cn } from '@/utils/cn';
import { IconButton } from './IconButton';

export interface PageHeaderProps {
  /** The page title (h1). */
  title?: ReactNode;
  /** Secondary line under the title. */
  subtitle?: ReactNode;
  /** Icon shown in an accent tile left of the title (e.g. <Network className="h-5 w-5" />). */
  icon?: ReactNode;
  /** Right-aligned actions; they wrap below the title under `lg`. */
  actions?: ReactNode;
  /**
   * Show a back button. It goes back in history when there is one, else to
   * this route (e.g. '/sites' for a page opened from a link or a new tab).
   */
  backTo?: string;
  /** Accessible label of the back button (default t('common.back')). */
  backLabel?: string;
  /** Extra content under the title row (chips, badges…). */
  children?: ReactNode;
  className?: string;
}

/**
 * Standard page header: optional back button, optional icon tile, h1
 * text-2xl font-semibold, optional subtitle and an actions slot that sits on
 * the right from `lg` and wraps under the title below it.
 *
 *   <PageHeader title={site.name} subtitle={site.description} backTo="/sites"
 *     actions={<Button size="sm">…</Button>} />
 */
export function PageHeader({
  title,
  subtitle,
  icon,
  actions,
  backTo,
  backLabel,
  children,
  className,
}: PageHeaderProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const goBack = () => {
    // history.length > 1 alone would also count pages of other sites (an
    // Obligate sign-in, a link from a chat): React Router's own position
    // (history.state.idx) > 0 proves the previous entry is an in-app page.
    let idx = 0;
    try {
      const state = window.history.state as { idx?: number } | null;
      idx = typeof state?.idx === 'number' ? state.idx : 0;
    } catch {
      idx = 0;
    }
    if (idx > 0 && window.history.length > 1) navigate(-1);
    else navigate(backTo ?? '/');
  };

  return (
    <div className={cn('mb-6 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between', className)}>
      <div className="flex min-w-0 items-start gap-3">
        {backTo !== undefined && (
          <IconButton
            label={backLabel ?? t('common.back', 'Back')}
            icon={<ArrowLeft className="h-5 w-5" />}
            size="md"
            onClick={goBack}
            className="mt-0.5 shrink-0"
          />
        )}
        {icon != null && (
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
            {icon}
          </div>
        )}
        <div className="min-w-0 flex-1">
          {title != null && <h1 className="break-words text-2xl font-semibold text-text-primary">{title}</h1>}
          {subtitle != null && <p className="mt-1 text-sm text-text-muted">{subtitle}</p>}
          {children}
        </div>
      </div>
      {actions != null && (
        <div className="flex flex-wrap items-center gap-2 lg:shrink-0 lg:justify-end">{actions}</div>
      )}
    </div>
  );
}
