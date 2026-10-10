import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { notificationsApi } from '@/api/notifications.api';

type ScopeAccess = 'checking' | 'ok' | 'forbidden' | 'notFound';

function httpStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } } | null)?.response?.status;
}

/**
 * Renders the notification bindings panel of a group or site only once the
 * server lets the user read that scope's bindings. The panel itself swallows
 * load errors (it would show an empty list); a refusal (403: capability
 * withdrawn meanwhile) or a scope that is gone (404) gets a clear message
 * instead. Other errors are left to the panel.
 */
export function NotificationBindingsGuard({
  scope,
  scopeId,
  children,
}: {
  scope: 'group' | 'site';
  scopeId: number;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [access, setAccess] = useState<ScopeAccess>('checking');

  useEffect(() => {
    let alive = true;
    setAccess('checking');
    notificationsApi.getBindings(scope, scopeId)
      .then(() => { if (alive) setAccess('ok'); })
      .catch((err: unknown) => {
        if (!alive) return;
        const status = httpStatus(err);
        setAccess(status === 403 ? 'forbidden' : status === 404 ? 'notFound' : 'ok');
      });
    return () => { alive = false; };
  }, [scope, scopeId]);

  if (access === 'checking') {
    return (
      <div className="flex justify-center py-8">
        <Loader2 className="animate-spin text-accent" size={20} />
      </div>
    );
  }
  if (access !== 'ok') {
    return (
      <div className="rounded-xl bg-bg-secondary p-5 text-center text-sm text-text-muted">
        {access === 'forbidden'
          ? t('notifications.bindings.forbidden', 'You do not have permission to manage these notifications.')
          : t('notifications.bindings.notFound', 'Not found: it may have been deleted.')}
      </div>
    );
  }
  return <>{children}</>;
}
