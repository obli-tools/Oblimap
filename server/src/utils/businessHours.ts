import type { BusinessHours } from '@oblimap/shared';
import { AppError } from '../middleware/errorHandler';

/**
 * Business hours: validation of the `businessHours` setting and
 * evaluation of a schedule at a given instant, in the schedule's time zone.
 *
 * Semantics:
 * - Wall-clock times are read in `tz` (IANA name, default 'UTC').
 * - `days.<mon..sun>` holds at most 4 ['HH:MM', 'HH:MM'] ranges. A range whose
 *   end is before its start crosses midnight and ends on the next day. '24:00'
 *   is accepted as an end (end of the day). start === end is refused (a whole
 *   day is written 00:00–24:00).
 * - No range at all (`days` absent, empty, or only empty lists) = always open.
 *   Once any day has a range, a day without ranges is closed.
 * - `closedDates` ('YYYY-MM-DD', local dates, at most 60) are closed for the
 *   whole local day: a range starting on a closed date does not run, and the
 *   tail of a previous-day range that crosses into a closed date is cut at
 *   midnight.
 * - DST: a range starting inside a spring-forward gap opens at the transition;
 *   during a fall-back the repeated wall-clock hour is evaluated twice.
 */

export type BusinessDay = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export const BUSINESS_DAYS: readonly BusinessDay[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export const BUSINESS_HOURS_LIMITS = {
  maxRangesPerDay: 4,
  maxClosedDates: 60,
  maxTzLength: 64,
  /** Longest JSON string accepted by parseBusinessHours. */
  maxJsonLength: 16_384,
} as const;

const MIN_MS = 60_000;
const DAY_MS = 86_400_000;
const DAY_MIN = 1440;
/** openSince looks back this many local days; an open period older than that is "open since forever". */
const LOOKBACK_DAYS = 8;

/** Day keys indexed like Date#getUTCDay (0 = Sunday). */
const JS_DAY_KEYS: readonly BusinessDay[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const TOP_LEVEL_FIELDS = new Set(['tz', 'days', 'closedDates']);
const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function invalid(message: string): never {
  throw new AppError(400, `Invalid businessHours: ${message}`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function shortLabel(s: string): string {
  return s.length > 32 ? `${s.slice(0, 32)}…` : s;
}

/** Short description of a rejected value for error messages. */
function describe(v: unknown): string {
  return typeof v === 'string' ? `"${shortLabel(v)}"` : v === null ? 'null' : typeof v;
}

// ── Time zones ───────────────────────────────────────────────────────────────

/** Formatters per canonical zone (Intl.DateTimeFormat construction is the slow part). */
const formatters = new Map<string, Intl.DateTimeFormat>();
/** Input spelling → canonical zone name ('europe/paris' → 'Europe/Paris'). */
const canonicalZones = new Map<string, string>();
const MAX_CACHED_ZONES = 512;

/** Canonical IANA name of `tz`, or null when Intl does not know it. */
function canonicalZone(tz: string): string | null {
  const cached = canonicalZones.get(tz);
  if (cached) return cached;
  let canonical: string;
  try {
    canonical = new Intl.DateTimeFormat('en', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  if (canonicalZones.size >= MAX_CACHED_ZONES) canonicalZones.clear();
  canonicalZones.set(tz, canonical);
  return canonical;
}

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    });
    if (formatters.size >= MAX_CACHED_ZONES) formatters.clear();
    formatters.set(tz, f);
  }
  return f;
}

/**
 * Local wall clock of instant `t` (ms) in `tz`, as "wall minutes": minutes
 * since 1970-01-01 00:00 of the local calendar. floor(wall / 1440) is the
 * local day number, wall % 1440 the minute of the local day.
 */
function wallMinutes(tz: string, t: number): number {
  let year = 0, month = 1, day = 1, hour = 0, minute = 0;
  for (const p of formatter(tz).formatToParts(new Date(t))) {
    switch (p.type) {
      case 'year': year = Number(p.value); break;
      case 'month': month = Number(p.value); break;
      case 'day': day = Number(p.value); break;
      case 'hour': hour = Number(p.value) % 24; break; // some ICU builds print 24 at midnight
      case 'minute': minute = Number(p.value); break;
      default: break;
    }
  }
  return Math.floor(Date.UTC(year, month - 1, day) / MIN_MS) + hour * 60 + minute;
}

/** UTC offset of `tz` at instant `t`, in minutes. */
function offsetMinutes(tz: string, t: number): number {
  return wallMinutes(tz, t) - Math.floor(t / MIN_MS);
}

/**
 * Earliest instant (ms) whose local wall clock is `wall`. A wall time that
 * does not exist (spring-forward gap) maps to the first instant after the gap.
 */
function wallToInstant(tz: string, wall: number): number {
  const approx = wall * MIN_MS;
  const offsets = new Set([
    offsetMinutes(tz, approx - DAY_MS),
    offsetMinutes(tz, approx),
    offsetMinutes(tz, approx + DAY_MS),
  ]);
  const candidates = [...offsets].map((off) => (wall - off) * MIN_MS);
  const exact = candidates.filter((t) => wallMinutes(tz, t) === wall);
  if (exact.length > 0) return Math.min(...exact);

  // Gap: binary search the first minute whose wall clock reaches `wall`.
  let lo = Math.min(...candidates);
  let hi = Math.max(...candidates);
  if (wallMinutes(tz, lo) >= wall || wallMinutes(tz, hi) < wall) return hi;
  while (hi - lo > MIN_MS) {
    const mid = lo + Math.floor((hi - lo) / MIN_MS / 2) * MIN_MS;
    if (wallMinutes(tz, mid) >= wall) hi = mid;
    else lo = mid;
  }
  return hi;
}

// ── Parsing ──────────────────────────────────────────────────────────────────

function parseTimeZone(v: unknown): string {
  if (typeof v !== 'string' || v.trim() === '' || v.length > BUSINESS_HOURS_LIMITS.maxTzLength) {
    invalid('tz must be an IANA time zone name');
  }
  const canonical = canonicalZone(v.trim());
  if (!canonical) invalid(`unknown time zone "${shortLabel(v)}"`);
  return canonical;
}

/** 'HH:MM' → minutes of the day. '24:00' only when `allowEndOfDay`. */
function parseClock(v: unknown, allowEndOfDay: boolean): number {
  if (typeof v === 'string') {
    if (allowEndOfDay && v === '24:00') return DAY_MIN;
    const m = HHMM_RE.exec(v);
    if (m) return Number(m[1]) * 60 + Number(m[2]);
  }
  invalid(`times must be "HH:MM" strings (got ${describe(v)})`);
}

function parseDays(v: unknown): NonNullable<BusinessHours['days']> {
  if (!isPlainObject(v)) invalid('days must be an object keyed by mon..sun');
  const out: NonNullable<BusinessHours['days']> = {};
  for (const key of Object.keys(v)) {
    if (!(BUSINESS_DAYS as readonly string[]).includes(key)) invalid(`unknown day "${shortLabel(key)}" (use mon..sun)`);
  }
  for (const day of BUSINESS_DAYS) {
    if (!(day in v)) continue;
    const ranges = v[day];
    if (ranges === null || ranges === undefined) { out[day] = []; continue; }
    if (!Array.isArray(ranges)) invalid(`days.${day} must be a list of ["HH:MM", "HH:MM"] ranges`);
    if (ranges.length > BUSINESS_HOURS_LIMITS.maxRangesPerDay) {
      invalid(`days.${day} has more than ${BUSINESS_HOURS_LIMITS.maxRangesPerDay} ranges`);
    }
    out[day] = ranges.map((range): [string, string] => {
      if (!Array.isArray(range) || range.length !== 2) invalid(`days.${day} ranges must be ["HH:MM", "HH:MM"] pairs`);
      const start = parseClock(range[0], false);
      const end = parseClock(range[1], true);
      if (start === end) invalid(`days.${day}: a range cannot start and end at the same time (a whole day is 00:00–24:00)`);
      return [range[0] as string, range[1] as string];
    });
  }
  return out;
}

/** 'YYYY-MM-DD' → local day number (days since 1970-01-01), or null when not a real date. */
function dateToDayNumber(s: string): number | null {
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, d);
  const check = new Date(ms);
  if (y < 1970 || check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return Math.round(ms / DAY_MS);
}

function parseClosedDates(v: unknown): string[] {
  if (!Array.isArray(v)) invalid('closedDates must be a list of "YYYY-MM-DD" dates');
  if (v.length > BUSINESS_HOURS_LIMITS.maxClosedDates) {
    invalid(`closedDates holds more than ${BUSINESS_HOURS_LIMITS.maxClosedDates} dates`);
  }
  const out = new Set<string>();
  for (const d of v) {
    if (typeof d !== 'string' || dateToDayNumber(d) === null) {
      invalid(`closedDates entries must be "YYYY-MM-DD" dates (got ${describe(d)})`);
    }
    out.add(d);
  }
  return [...out].sort();
}

/**
 * Validates and normalises a businessHours value: an object, or its JSON
 * string (as stored). null / undefined / '' → {} (always open). The time zone
 * is canonicalised, closedDates deduplicated and sorted, unknown fields
 * refused. Throws AppError(400) on invalid input.
 */
export function parseBusinessHours(v: unknown): BusinessHours {
  let input = v;
  if (input === undefined || input === null) return {};
  if (typeof input === 'string') {
    const s = input.trim();
    if (s === '') return {};
    if (s.length > BUSINESS_HOURS_LIMITS.maxJsonLength) invalid('value is too long');
    try {
      input = JSON.parse(s);
    } catch {
      invalid('not valid JSON');
    }
  }
  if (!isPlainObject(input)) invalid('must be an object');

  for (const key of Object.keys(input)) {
    if (!TOP_LEVEL_FIELDS.has(key)) invalid(`unknown field "${shortLabel(key)}"`);
  }

  const out: BusinessHours = {};
  if (input.tz !== undefined && input.tz !== null) out.tz = parseTimeZone(input.tz);
  if (input.days !== undefined && input.days !== null) out.days = parseDays(input.days);
  if (input.closedDates !== undefined && input.closedDates !== null) {
    const dates = parseClosedDates(input.closedDates);
    if (dates.length > 0) out.closedDates = dates;
  }
  return out;
}

// ── Evaluation ───────────────────────────────────────────────────────────────

interface CompiledSchedule {
  tz: string;
  /** No range at all: open every day except closed dates. */
  allDay: boolean;
  /** [startMinute, endMinute] per JS weekday (0 = Sunday); end <= start crosses midnight. */
  ranges: Array<Array<[number, number]>>;
  /** Closed local day numbers. */
  closed: Set<number>;
}

/** Compiled schedules keyed by their JSON text. */
const compiledSchedules = new Map<string, CompiledSchedule>();
const MAX_CACHED_SCHEDULES = 512;

/**
 * An object is evaluated through its JSON form, which is also the cache key:
 * the key always matches the content, so an object mutated between calls is
 * compiled again instead of hitting a stale entry.
 */
function compile(bh: BusinessHours | string | null | undefined): CompiledSchedule {
  let key: string;
  if (bh !== null && typeof bh === 'object') {
    let json: unknown;
    try {
      json = JSON.stringify(bh);
    } catch {
      json = undefined;
    }
    if (typeof json !== 'string') invalid('must be plain JSON data');
    key = json;
  } else {
    key = typeof bh === 'string' ? bh : '';
  }
  const hit = compiledSchedules.get(key);
  if (hit) return hit;

  const parsed = parseBusinessHours(key);
  const ranges: Array<Array<[number, number]>> = JS_DAY_KEYS.map(() => []);
  let total = 0;
  JS_DAY_KEYS.forEach((dayKey, jsDay) => {
    for (const [start, end] of parsed.days?.[dayKey] ?? []) {
      ranges[jsDay].push([parseClock(start, false), parseClock(end, true)]);
      total++;
    }
  });
  const closed = new Set<number>();
  for (const d of parsed.closedDates ?? []) {
    const n = dateToDayNumber(d);
    if (n !== null) closed.add(n);
  }
  const compiled: CompiledSchedule = { tz: parsed.tz ?? 'UTC', allDay: total === 0, ranges, closed };

  if (compiledSchedules.size >= MAX_CACHED_SCHEDULES) compiledSchedules.clear();
  compiledSchedules.set(key, compiled);
  return compiled;
}

function jsDayOf(dayNumber: number): number {
  // 1970-01-01 (day 0) was a Thursday.
  return (((dayNumber + 4) % 7) + 7) % 7;
}

/**
 * Open periods, in wall minutes, of the ranges that start on local days
 * fromDay..toDay, sorted and merged (adjacent periods are joined).
 */
function openPeriods(c: CompiledSchedule, fromDay: number, toDay: number): Array<[number, number]> {
  const raw: Array<[number, number]> = [];
  for (let day = fromDay; day <= toDay; day++) {
    if (c.closed.has(day)) continue;
    const base = day * DAY_MIN;
    if (c.allDay) {
      raw.push([base, base + DAY_MIN]);
      continue;
    }
    for (const [start, end] of c.ranges[jsDayOf(day)]) {
      let stop = end > start ? base + end : base + DAY_MIN + end;
      if (stop > base + DAY_MIN && c.closed.has(day + 1)) stop = base + DAY_MIN;
      raw.push([base + start, stop]);
    }
  }
  raw.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of raw) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function instantOf(now: Date): number {
  const t = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(t)) throw new TypeError('businessHours: invalid date');
  return Math.floor(t / MIN_MS) * MIN_MS;
}

/**
 * Whether the schedule is open at `now`. `bh` is a parsed value (or its JSON
 * string; '{}' and empty = always open). Throws AppError(400) if `bh` is invalid.
 */
export function isOpen(bh: BusinessHours | string | null | undefined, now: Date): boolean {
  const c = compile(bh);
  if (c.allDay && c.closed.size === 0) return true;
  const wall = wallMinutes(c.tz, instantOf(now));
  const day = Math.floor(wall / DAY_MIN);
  return openPeriods(c, day - 1, day).some(([start, end]) => start <= wall && wall < end);
}

/**
 * Start of the open period containing `now`, or null when the schedule is
 * closed at `now` or has been open for more than a week ("open since
 * forever": always-open schedules, 24/7 ranges). Minute precision.
 */
export function openSince(bh: BusinessHours | string | null | undefined, now: Date): Date | null {
  const c = compile(bh);
  if (c.allDay && c.closed.size === 0) return null;

  const t = instantOf(now);
  const wall = wallMinutes(c.tz, t);
  const day = Math.floor(wall / DAY_MIN);
  const current = openPeriods(c, day - LOOKBACK_DAYS, day).find(([start, end]) => start <= wall && wall < end);
  if (!current) return null;
  const [periodStart, periodEnd] = current;
  if (periodStart <= (day - LOOKBACK_DAYS) * DAY_MIN) return null;

  let start = wallToInstant(c.tz, periodStart);

  // More real time than wall time elapsed since `start`: a fall-back repeated
  // part of the wall clock in between. The period is continuous only if the
  // wall clock reached before the transition was still inside it; otherwise
  // the schedule closed and re-opened during the repeated hour.
  if ((t - start) / MIN_MS > wall - periodStart) {
    const offsetNow = offsetMinutes(c.tz, t);
    if (offsetMinutes(c.tz, start) !== offsetNow) {
      let lo = start;
      let hi = t;
      while (hi - lo > MIN_MS) {
        const mid = lo + Math.floor((hi - lo) / MIN_MS / 2) * MIN_MS;
        if (offsetMinutes(c.tz, mid) === offsetNow) hi = mid;
        else lo = mid;
      }
      const transition = hi;
      const wallAfter = wallMinutes(c.tz, transition);
      const wallBefore = wallMinutes(c.tz, transition - MIN_MS) + 1;
      if (wallBefore > periodEnd) {
        start = transition + (Math.max(periodStart, wallAfter) - wallAfter) * MIN_MS;
      }
    }
  }

  return new Date(Math.min(start, t));
}
