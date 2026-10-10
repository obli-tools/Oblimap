/**
 * BusinessHoursEditor — editor of the `businessHours` setting (type
 * 'schedule'), used by device check alerting ("only during
 * business hours").
 *
 * Value shape (BusinessHours, validated server-side by parseBusinessHours):
 *   { tz?: IANA zone (default UTC), days?: { mon..sun: [["HH:MM","HH:MM"], …] ≤ 4 },
 *     closedDates?: ["YYYY-MM-DD", …] ≤ 60 }
 * - No range at all = always open (except closed dates). Once one day has a
 *   range, days without ranges are closed.
 * - An end before the start crosses midnight; "24:00" is the end of the day.
 *
 * Edits are kept locally until "Save"; an empty schedule is saved as {}.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { CalendarX, Clock, Copy, Loader2, Plus, RotateCcw, Save, X } from 'lucide-react';
import type { BusinessHours } from '@oblimap/shared';
import { cn } from '@/utils/cn';

export type BusinessDayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export const BUSINESS_DAY_KEYS: readonly BusinessDayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const BUSINESS_HOURS_MAX_RANGES = 4;
export const BUSINESS_HOURS_MAX_CLOSED_DATES = 60;

const DAY_FALLBACKS: Record<BusinessDayKey, string> = {
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
};
const DAY_SHORT_FALLBACKS: Record<BusinessDayKey, string> = {
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun',
};

/** Used when Intl.supportedValuesOf is not available. */
const FALLBACK_TIME_ZONES = [
  'UTC',
  'Europe/London', 'Europe/Dublin', 'Europe/Lisbon', 'Europe/Paris', 'Europe/Brussels', 'Europe/Amsterdam',
  'Europe/Luxembourg', 'Europe/Berlin', 'Europe/Zurich', 'Europe/Vienna', 'Europe/Rome', 'Europe/Madrid',
  'Europe/Prague', 'Europe/Warsaw', 'Europe/Copenhagen', 'Europe/Stockholm', 'Europe/Oslo', 'Europe/Helsinki',
  'Europe/Athens', 'Europe/Bucharest', 'Europe/Istanbul', 'Europe/Kyiv', 'Europe/Moscow',
  'Africa/Casablanca', 'Africa/Algiers', 'Africa/Tunis', 'Africa/Cairo', 'Africa/Johannesburg', 'Africa/Lagos',
  'Asia/Dubai', 'Asia/Riyadh', 'Asia/Karachi', 'Asia/Kolkata', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Shanghai',
  'Asia/Hong_Kong', 'Asia/Tokyo', 'Asia/Seoul',
  'Australia/Perth', 'Australia/Sydney', 'Pacific/Auckland', 'Pacific/Noumea', 'Pacific/Tahiti',
  'America/St_Johns', 'America/Halifax', 'America/New_York', 'America/Toronto', 'America/Chicago',
  'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu',
  'America/Mexico_City', 'America/Bogota', 'America/Lima', 'America/Santiago', 'America/Sao_Paulo',
  'America/Argentina/Buenos_Aires', 'America/Martinique', 'America/Guadeloupe', 'America/Cayenne',
  'Indian/Reunion', 'Indian/Mayotte',
];

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The browser's IANA zone ('UTC' when unknown). */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

let cachedZones: string[] | null = null;

/** IANA zones known by the browser (fallback list when Intl.supportedValuesOf is missing). */
export function listTimeZones(): string[] {
  if (cachedZones) return cachedZones;
  let zones: string[] = [];
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    if (typeof fn === 'function') zones = fn.call(Intl, 'timeZone');
  } catch {
    zones = [];
  }
  if (!Array.isArray(zones) || zones.length === 0) zones = [...FALLBACK_TIME_ZONES];
  if (!zones.includes('UTC')) zones = ['UTC', ...zones];
  cachedZones = zones;
  return zones;
}

type Range = [string, string];

interface Draft {
  tz: string;
  days: Record<BusinessDayKey, Range[]>;
  closedDates: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Lenient read of a stored value (object, its JSON string, '{}', null):
 * unknown or malformed parts are dropped (the server validates on save).
 */
export function toBusinessHours(raw: unknown): BusinessHours {
  let v = raw;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return {};
    try { v = JSON.parse(s); } catch { return {}; }
  }
  if (!isRecord(v)) return {};
  const out: BusinessHours = {};
  if (typeof v.tz === 'string' && v.tz.trim() !== '') out.tz = v.tz.trim();
  if (isRecord(v.days)) {
    const days: NonNullable<BusinessHours['days']> = {};
    for (const d of BUSINESS_DAY_KEYS) {
      const ranges = v.days[d];
      if (!Array.isArray(ranges)) continue;
      days[d] = ranges
        .filter((r): r is [string, string] => Array.isArray(r) && r.length === 2 && typeof r[0] === 'string' && typeof r[1] === 'string')
        .map((r): [string, string] => [r[0], r[1]]);
    }
    out.days = days;
  }
  if (Array.isArray(v.closedDates)) {
    out.closedDates = v.closedDates.filter((d): d is string => typeof d === 'string' && DATE_RE.test(d));
  }
  return out;
}

/** True when the schedule has no opening range (always open, except closed dates). */
export function hasNoRanges(bh: BusinessHours): boolean {
  return BUSINESS_DAY_KEYS.every((d) => (bh.days?.[d]?.length ?? 0) === 0);
}

function draftOf(bh: BusinessHours): Draft {
  const empty = hasNoRanges(bh) && (bh.closedDates?.length ?? 0) === 0;
  const days = {} as Record<BusinessDayKey, Range[]>;
  for (const d of BUSINESS_DAY_KEYS) days[d] = (bh.days?.[d] ?? []).map((r): Range => [r[0], r[1]]);
  return {
    // A stored schedule without tz is evaluated in UTC; a new one starts in the browser's zone.
    tz: bh.tz ?? (empty ? browserTimeZone() : 'UTC'),
    days,
    closedDates: [...(bh.closedDates ?? [])],
  };
}

/** The value to save: {} when nothing is set; days without ranges are left out. */
export function draftToBusinessHours(draft: Draft): BusinessHours {
  const days: NonNullable<BusinessHours['days']> = {};
  let anyRange = false;
  for (const d of BUSINESS_DAY_KEYS) {
    const ranges = draft.days[d];
    if (ranges.length === 0) continue;
    days[d] = ranges.map((r): [string, string] => [r[0], r[1]]);
    anyRange = true;
  }
  const closedDates = [...new Set(draft.closedDates)].sort();
  if (!anyRange && closedDates.length === 0) return {};
  const out: BusinessHours = { tz: draft.tz };
  if (anyRange) out.days = days;
  if (closedDates.length > 0) out.closedDates = closedDates;
  return out;
}

function minutesOf(clock: string, isEnd: boolean): number | null {
  if (isEnd && clock === '24:00') return 1440;
  const m = HHMM_RE.exec(clock);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** "9:5" / "9h00" / "0900" → "09:00" when it can be read, otherwise the input unchanged. */
function normalizeClock(input: string): string {
  const s = input.trim().replace(/h/i, ':');
  const m = /^(\d{1,2}):?(\d{2})$/.exec(s);
  if (!m) return input.trim();
  const out = `${m[1].padStart(2, '0')}:${m[2]}`;
  return out === '24:00' || HHMM_RE.test(out) ? out : input.trim();
}

/** Error text of one range, or null. */
function rangeError(r: Range, t: TFunction): string | null {
  const start = minutesOf(r[0], false);
  const end = minutesOf(r[1], true);
  if (start === null || end === null) {
    return t('settings.businessHours.invalidTime', 'Use HH:MM times (24:00 = end of the day)');
  }
  if (start === end) {
    return t('settings.businessHours.sameTime', 'A range cannot start and end at the same time (a whole day is 00:00–24:00)');
  }
  return null;
}

function isValidDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return y >= 1970 && dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** One-line summary of a schedule ("Mon 09:00–18:00 · …"), for read-only display. */
function dayLine(ranges: readonly Range[] | undefined): string {
  return (ranges ?? []).map((r) => `${r[0]}–${r[1]}`).join(', ');
}

// ─── Component ────────────────────────────────────────────────────────────────

export interface BusinessHoursEditorProps {
  /** Stored value: a BusinessHours object, its JSON string, or '{}' (the default). */
  value: unknown;
  /** Inherited value (not overridden here): read-only. */
  disabled?: boolean;
  /**
   * The value is not stored at this level yet (a new override starting from
   * the inherited schedule): Save is enabled even without edits, so the
   * inherited schedule can be pinned here as it is.
   */
  unsaved?: boolean;
  /** Resolves to false when the save failed (the edits are kept). */
  onSave: (value: BusinessHours) => Promise<boolean | void> | boolean | void;
}

export function BusinessHoursEditor({ value, disabled = false, unsaved = false, onSave }: BusinessHoursEditorProps) {
  const { t } = useTranslation();
  const stored = useMemo(() => toBusinessHours(value), [value]);
  const storedKey = JSON.stringify(stored);
  const [draft, setDraft] = useState<Draft>(() => draftOf(stored));
  const [newDate, setNewDate] = useState('');
  const [saving, setSaving] = useState(false);

  // A new stored value (after a save or a reload) replaces the local edits.
  useEffect(() => {
    setDraft(draftOf(stored));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedKey]);

  const zones = useMemo(() => {
    const list = listTimeZones();
    return list.includes(draft.tz) ? list : [draft.tz, ...list];
  }, [draft.tz]);

  const output = draftToBusinessHours(draft);
  const dirty = JSON.stringify(output) !== JSON.stringify(draftToBusinessHours(draftOf(stored)));
  const canSave = dirty || unsaved;
  const alwaysOpen = BUSINESS_DAY_KEYS.every((d) => draft.days[d].length === 0);
  const rangeErrors = Object.fromEntries(
    BUSINESS_DAY_KEYS.map((d) => [d, draft.days[d].map((r) => rangeError(r, t))]),
  ) as Record<BusinessDayKey, Array<string | null>>;
  const hasErrors = BUSINESS_DAY_KEYS.some((d) => rangeErrors[d].some((e) => e !== null));

  const dayLabel = (d: BusinessDayKey) => t(`settings.businessHours.days.${d}`, DAY_FALLBACKS[d]);
  const dayShort = (d: BusinessDayKey) => t(`settings.businessHours.daysShort.${d}`, DAY_SHORT_FALLBACKS[d]);

  // ── Read-only (inherited) ──
  if (disabled) {
    const noRanges = hasNoRanges(stored);
    return (
      <div className="w-full rounded-lg bg-bg-tertiary px-3 py-2 text-xs text-text-secondary">
        {noRanges && (stored.closedDates?.length ?? 0) === 0 ? (
          <span className="inline-flex items-center gap-1.5 text-text-muted">
            <Clock size={12} />{t('settings.businessHours.alwaysOpen', 'Always open')}
          </span>
        ) : (
          <div className="space-y-1">
            <p className="text-text-muted">
              {t('settings.businessHours.timezone', 'Time zone')}: <span className="font-mono text-text-secondary">{stored.tz ?? 'UTC'}</span>
            </p>
            {noRanges ? (
              <p>{t('settings.businessHours.alwaysOpenExceptClosed', 'Open every day, except the closed dates')}</p>
            ) : (
              <ul className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
                {BUSINESS_DAY_KEYS.map((d) => (
                  <li key={d} className="flex gap-2">
                    <span className="w-9 shrink-0 text-text-muted">{dayShort(d)}</span>
                    <span className="font-mono">
                      {stored.days?.[d]?.length ? dayLine(stored.days[d]) : t('settings.businessHours.closed', 'Closed')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {(stored.closedDates?.length ?? 0) > 0 && (
              <p>
                <span className="text-text-muted">{t('settings.businessHours.closedDates', 'Closed dates')}: </span>
                <span className="font-mono">{stored.closedDates!.join(', ')}</span>
              </p>
            )}
          </div>
        )}
      </div>
    );
  }

  // ── Editing ──
  const setDay = (d: BusinessDayKey, ranges: Range[]) =>
    setDraft((prev) => ({ ...prev, days: { ...prev.days, [d]: ranges } }));

  const updateRange = (d: BusinessDayKey, i: number, part: 0 | 1, v: string) =>
    setDraft((prev) => {
      const ranges = prev.days[d].map((r, idx): Range => (idx === i ? (part === 0 ? [v, r[1]] : [r[0], v]) : r));
      return { ...prev, days: { ...prev.days, [d]: ranges } };
    });

  const addRange = (d: BusinessDayKey) => {
    const ranges = draft.days[d];
    if (ranges.length >= BUSINESS_HOURS_MAX_RANGES) return;
    // First range of the day: a typical day; the next ones are left to fill in.
    const next: Range = ranges.length === 0 ? ['09:00', '18:00'] : ['', ''];
    setDay(d, [...ranges, next]);
  };

  const copyMondayToWeekdays = () =>
    setDraft((prev) => {
      const mon = () => prev.days.mon.map((r): Range => [r[0], r[1]]);
      return { ...prev, days: { ...prev.days, tue: mon(), wed: mon(), thu: mon(), fri: mon() } };
    });

  const addClosedDate = () => {
    const d = newDate.trim();
    if (!isValidDate(d) || draft.closedDates.includes(d) || draft.closedDates.length >= BUSINESS_HOURS_MAX_CLOSED_DATES) return;
    setDraft((prev) => ({ ...prev, closedDates: [...prev.closedDates, d].sort() }));
    setNewDate('');
  };

  async function save() {
    if (hasErrors || saving) return;
    setSaving(true);
    try {
      await onSave(output);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="w-full space-y-3 rounded-lg bg-bg-tertiary/40 p-3">
      {/* Time zone */}
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="bh-tz" className="text-xs text-text-muted">{t('settings.businessHours.timezone', 'Time zone')}</label>
        <select
          id="bh-tz"
          value={draft.tz}
          onChange={(e) => setDraft((prev) => ({ ...prev, tz: e.target.value }))}
          className="min-w-0 max-w-full rounded-md border border-border bg-bg-tertiary px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
        >
          {zones.map((z) => <option key={z} value={z}>{z}</option>)}
        </select>
        {draft.tz !== browserTimeZone() && (
          <button
            type="button"
            onClick={() => setDraft((prev) => ({ ...prev, tz: browserTimeZone() }))}
            className="text-[11px] text-accent hover:underline"
          >
            {t('settings.businessHours.useBrowserZone', { zone: browserTimeZone(), defaultValue: 'Use {{zone}}' })}
          </button>
        )}
      </div>

      {alwaysOpen && (
        <p className="flex items-start gap-1.5 rounded-md border border-accent/30 bg-accent/5 px-2.5 py-1.5 text-xs text-text-secondary">
          <Clock size={12} className="mt-0.5 shrink-0 text-accent" />
          <span>
            <span className="font-medium text-text-primary">{t('settings.businessHours.alwaysOpen', 'Always open')}</span>
            {' — '}
            {t('settings.businessHours.alwaysOpenHint', 'Add opening hours to restrict alerting. Once a day has hours, days without hours are closed.')}
          </span>
        </p>
      )}

      {/* Days */}
      <div className="space-y-1.5">
        {BUSINESS_DAY_KEYS.map((d) => {
          const ranges = draft.days[d];
          return (
            <div key={d} className="flex flex-wrap items-start gap-2">
              <span className="w-24 shrink-0 pt-1 text-xs text-text-secondary">{dayLabel(d)}</span>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                {ranges.length === 0 && (
                  <span className="pt-1 text-xs text-text-muted">
                    {alwaysOpen ? '—' : t('settings.businessHours.closed', 'Closed')}
                  </span>
                )}
                {ranges.map((r, i) => {
                  const err = rangeErrors[d][i];
                  return (
                    <span
                      key={i}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-md border bg-bg-tertiary px-1.5 py-0.5',
                        err ? 'border-red-500/60' : 'border-border',
                      )}
                      title={err ?? undefined}
                    >
                      <input
                        type="text"
                        inputMode="numeric"
                        maxLength={5}
                        value={r[0]}
                        placeholder={t('settings.businessHours.timePlaceholder', 'HH:MM')}
                        aria-label={t('settings.businessHours.opens', 'Opens')}
                        onChange={(e) => updateRange(d, i, 0, e.target.value)}
                        onBlur={(e) => updateRange(d, i, 0, normalizeClock(e.target.value))}
                        className="w-12 bg-transparent text-center font-mono text-xs text-text-primary focus:outline-none"
                      />
                      <span className="text-xs text-text-muted">–</span>
                      <input
                        type="text"
                        inputMode="numeric"
                        maxLength={5}
                        value={r[1]}
                        placeholder={t('settings.businessHours.timePlaceholder', 'HH:MM')}
                        aria-label={t('settings.businessHours.closes', 'Closes')}
                        onChange={(e) => updateRange(d, i, 1, e.target.value)}
                        onBlur={(e) => updateRange(d, i, 1, normalizeClock(e.target.value))}
                        className="w-12 bg-transparent text-center font-mono text-xs text-text-primary focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => setDay(d, ranges.filter((_, idx) => idx !== i))}
                        className="text-text-muted hover:text-red-400"
                        aria-label={t('settings.businessHours.removeRange', 'Remove this range')}
                      >
                        <X size={11} />
                      </button>
                    </span>
                  );
                })}
                {ranges.length < BUSINESS_HOURS_MAX_RANGES && (
                  <button
                    type="button"
                    onClick={() => addRange(d)}
                    className="inline-flex items-center gap-0.5 rounded-md px-1.5 py-1 text-[11px] text-accent hover:bg-accent/10"
                    title={t('settings.businessHours.addRange', 'Add a range')}
                  >
                    <Plus size={11} />{t('settings.businessHours.addRange', 'Add a range')}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3 text-[11px]">
        <button
          type="button"
          onClick={copyMondayToWeekdays}
          disabled={draft.days.mon.length === 0}
          className="inline-flex items-center gap-1 text-accent hover:underline disabled:cursor-not-allowed disabled:text-text-muted disabled:no-underline"
        >
          <Copy size={11} />{t('settings.businessHours.copyToWeekdays', 'Copy Monday to weekdays')}
        </button>
        <span className="text-text-muted">
          {t('settings.businessHours.rangesHint', 'An end before the start crosses midnight; 24:00 is the end of the day.')}
        </span>
      </div>

      {/* Closed dates */}
      <div className="space-y-1.5 border-t border-border pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 text-xs text-text-secondary">
            <CalendarX size={12} />{t('settings.businessHours.closedDates', 'Closed dates')}
          </span>
          <span className="text-[11px] text-text-muted">{draft.closedDates.length}/{BUSINESS_HOURS_MAX_CLOSED_DATES}</span>
          <input
            type="date"
            value={newDate}
            onChange={(e) => setNewDate(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addClosedDate(); } }}
            className="rounded-md border border-border bg-bg-tertiary px-2 py-0.5 text-xs text-text-primary focus:outline-none focus:ring-2 focus:ring-accent"
          />
          <button
            type="button"
            onClick={addClosedDate}
            disabled={!isValidDate(newDate) || draft.closedDates.includes(newDate) || draft.closedDates.length >= BUSINESS_HOURS_MAX_CLOSED_DATES}
            className="inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[11px] text-accent hover:bg-accent/10 disabled:cursor-not-allowed disabled:text-text-muted disabled:hover:bg-transparent"
          >
            <Plus size={11} />{t('common.add', 'Add')}
          </button>
        </div>
        {draft.closedDates.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {draft.closedDates.map((d) => (
              <span key={d} className="inline-flex items-center gap-1 rounded-md bg-bg-tertiary px-2 py-0.5 font-mono text-[11px] text-text-primary">
                {d}
                <button
                  type="button"
                  onClick={() => setDraft((prev) => ({ ...prev, closedDates: prev.closedDates.filter((x) => x !== d) }))}
                  className="text-text-muted hover:text-red-400"
                  aria-label={t('settings.businessHours.removeDate', 'Remove this date')}
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <button
          type="button"
          onClick={() => setDraft((prev) => ({ ...prev, days: draftOf({}).days, closedDates: [] }))}
          disabled={alwaysOpen && draft.closedDates.length === 0}
          className="inline-flex items-center gap-1 text-[11px] text-text-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Clock size={11} />{t('settings.businessHours.clear', 'Clear (always open)')}
        </button>
        <div className="flex items-center gap-2">
          {hasErrors && (
            <span className="text-[11px] text-red-400">{t('settings.businessHours.fixErrors', 'Fix the highlighted ranges')}</span>
          )}
          {dirty && (
            <button
              type="button"
              onClick={() => setDraft(draftOf(stored))}
              disabled={saving}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-text-muted hover:bg-bg-hover hover:text-text-primary"
            >
              <RotateCcw size={12} />{t('common.cancel', 'Cancel')}
            </button>
          )}
          <button
            type="button"
            onClick={() => void save()}
            disabled={!canSave || hasErrors || saving}
            className="inline-flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-white transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            {t('common.save', 'Save')}
          </button>
        </div>
      </div>
    </div>
  );
}
