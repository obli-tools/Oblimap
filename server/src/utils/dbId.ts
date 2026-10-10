import { AppError } from '../middleware/errorHandler';

const INT4_MAX = 2_147_483_647;

/**
 * Strict parser for an id that will reach Postgres: a positive integer, or a
 * string of plain digits without a leading zero. Anything else is refused
 * (null). Number() / parseInt() and the Postgres integer input disagree on
 * some strings — parseInt('12abc') is 12, PostgreSQL 16 reads '1_000' as 1000
 * while Number('1_000') is NaN — so a permission check that normalises one way
 * and a query that receives the raw value can look at two different rows.
 * Normalise once with this, then use the result for both.
 * (Port of Obliance server/src/utils/dbId.ts.)
 */
export function toDbId(value: unknown): number | null {
  let n: number;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value)) n = Number(value);
  else return null;
  return Number.isSafeInteger(n) && n > 0 && n <= INT4_MAX ? n : null;
}

/** Every entry valid → the normalised ids; any invalid entry (or not an array) → null. */
export function toDbIds(values: unknown): number[] | null {
  if (!Array.isArray(values)) return null;
  const out: number[] = [];
  for (const v of values) {
    const id = toDbId(v);
    if (id == null) return null;
    out.push(id);
  }
  return out;
}

/** The valid ids only (stored data read back: drop what cannot be an id). */
export function validDbIds(values: readonly unknown[]): number[] {
  const out: number[] = [];
  for (const v of values) {
    const id = toDbId(v);
    if (id != null) out.push(id);
  }
  return out;
}

/** toDbId for route params / body ids: an invalid value is a 400, never a NaN query. */
export function requireDbId(value: unknown, label = 'id'): number {
  const id = toDbId(value);
  if (id == null) throw new AppError(400, `Invalid ${label}`);
  return id;
}
