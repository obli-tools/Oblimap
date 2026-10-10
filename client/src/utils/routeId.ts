/**
 * Strict parse of a numeric id taken from a route parameter: a positive
 * integer without sign, leading zero, spaces or trailing characters
 * ("12abc", "0", "-1", "1e3" are refused). Returns null for anything else,
 * so the page can render its not-found state instead of calling the API
 * with a loosely parsed id.
 */
export function parseRouteId(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string' || !/^[1-9]\d{0,9}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}
