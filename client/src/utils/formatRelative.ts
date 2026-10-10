import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

export type RelativeTimeInput = string | number | Date | null | undefined;

/**
 * Translated relative time ("Just now", "5 min ago", "3 h ago", "2 d ago").
 * Null / undefined / unparsable values read as "Never"; timestamps in the
 * future (clock skew between server and browser) read as "Just now".
 */
export function formatRelative(ts: RelativeTimeInput, t: TFunction): string {
  if (ts === null || ts === undefined || ts === '') return t('time.never', 'Never');
  const time = ts instanceof Date ? ts.getTime() : new Date(ts).getTime();
  if (Number.isNaN(time)) return t('time.never', 'Never');

  const diffSec = Math.floor((Date.now() - time) / 1000);
  if (diffSec < 60) return t('time.justNow', 'Just now');
  if (diffSec < 3600) {
    return t('time.minutesAgo', { count: Math.floor(diffSec / 60), defaultValue: '{{count}} min ago' });
  }
  if (diffSec < 86_400) {
    return t('time.hoursAgo', { count: Math.floor(diffSec / 3600), defaultValue: '{{count}} h ago' });
  }
  return t('time.daysAgo', { count: Math.floor(diffSec / 86_400), defaultValue: '{{count}} d ago' });
}

/** formatRelative bound to the current language. */
export function useFormatRelative(): (ts: RelativeTimeInput) => string {
  const { t } = useTranslation();
  return useCallback((ts: RelativeTimeInput) => formatRelative(ts, t), [t]);
}
