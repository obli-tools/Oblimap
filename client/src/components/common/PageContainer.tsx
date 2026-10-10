import { createContext, forwardRef, useContext, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/utils/cn';
import { PageHeader } from './PageHeader';

/**
 * True inside a hub tab: the hub page owns the padding and the header, so
 * the embedded page renders neither. Default false.
 */
export const EmbeddedContext = createContext(false);

/** Renders `children` as embedded pages (hub tab bodies). */
export function EmbeddedProvider({ children, value = true }: { children?: ReactNode; value?: boolean }) {
  return <EmbeddedContext.Provider value={value}>{children}</EmbeddedContext.Provider>;
}

/** Whether the current page is rendered inside a hub (EmbeddedProvider). */
export function useEmbedded(): boolean {
  return useContext(EmbeddedContext);
}

export interface PageContainerProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  children?: ReactNode;
  /**
   * Drop the padding and the header (a page rendered inside another page,
   * e.g. a hub tab). Default: the EmbeddedContext value (false outside a hub).
   */
  embedded?: boolean;
  /** Page title: renders a PageHeader (not when embedded). */
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Icon tile of the header. */
  icon?: ReactNode;
  /** Header actions (not rendered when embedded). */
  actions?: ReactNode;
  /** Header back button fallback route (see PageHeader). */
  backTo?: string;
}

/**
 * Standard page root (ported from Obliance): p-3 (phone) · sm:p-4 · lg:p-6.
 * Replaces the hard-coded `p-6` on page roots; combine with spacing
 * utilities as before:
 *
 *   <PageContainer title={t('x.title')} actions={…} className="space-y-6">…</PageContainer>
 *
 * Inside <EmbeddedProvider> (hub tabs) it renders no padding, no title and
 * no actions, without any prop on the embedded page.
 */
export const PageContainer = forwardRef<HTMLDivElement, PageContainerProps>(function PageContainer(
  { children, className, embedded, title, subtitle, icon, actions, backTo, ...rest },
  ref,
) {
  const fromContext = useContext(EmbeddedContext);
  const isEmbedded = embedded ?? fromContext;
  const showHeader =
    !isEmbedded &&
    (title != null || actions != null || subtitle != null || icon != null || backTo !== undefined);
  return (
    <div ref={ref} className={cn('min-w-0', !isEmbedded && 'p-3 sm:p-4 lg:p-6', className)} {...rest}>
      {showHeader && (
        <PageHeader
          title={title}
          subtitle={subtitle}
          icon={icon}
          actions={actions}
          backTo={backTo}
        />
      )}
      {children}
    </div>
  );
});
