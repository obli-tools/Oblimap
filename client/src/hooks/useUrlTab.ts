import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Tab state stored in the `?tab=` query parameter, so tabs are deep-linkable
 * and survive a reload. Changing the tab replaces the history entry (no back
 * stack of tab clicks) and keeps the other query parameters. A missing or
 * unknown value reads as `defaultTab` (the URL is not rewritten: a tab that
 * becomes valid once permissions load is still honoured).
 *
 *   const [tab, setTab] = useUrlTab(['devices', 'reservations'] as const, 'devices');
 */
export function useUrlTab<T extends string>(
  validTabs: readonly T[],
  defaultTab: T,
): [T, (tab: T) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get('tab');
  const tab = raw !== null && (validTabs as readonly string[]).includes(raw) ? (raw as T) : defaultTab;

  const setTab = useCallback(
    (next: T) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          params.set('tab', next);
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  return [tab, setTab];
}
