import toast from 'react-hot-toast';

// Error helpers for API calls (Obliance pattern, client/src/api/client.ts):
// the server's human-readable refusal reason reaches the user instead of a
// generic "Failed to…", and errors the API client already reported (e.g. the
// missing-capability toast) are not reported twice by the call site.

type ApiErrorBody = {
  error?: unknown;
  message?: unknown;
  issues?: Array<{ message?: unknown }> | unknown;
};

/** A machine-readable code ('forbidden', 'missing_config_field'…), not a sentence. */
function isBareCode(text: string): boolean {
  return /^[a-z0-9]+([_.:-][a-z0-9]+)*$/i.test(text);
}

/** The response body of a failed axios request, if any. */
export function apiErrorBody(err: unknown): ApiErrorBody | undefined {
  const data = (err as { response?: { data?: unknown } } | null)?.response?.data;
  return data && typeof data === 'object' ? data as ApiErrorBody : undefined;
}

/**
 * The server's human-readable message for a failed request — the first
 * validation issue, else `error`, else `message` — when it is a sentence and
 * not a bare code; the fallback otherwise.
 */
export function apiErrorMessage(err: unknown, fallback = ''): string {
  const data = apiErrorBody(err);
  if (!data) return fallback;
  const issues = Array.isArray(data.issues) ? data.issues as Array<{ message?: unknown }> : [];
  const issue = issues[0]?.message;
  if (typeof issue === 'string' && issue.trim()) return issue;
  for (const candidate of [data.error, data.message]) {
    if (typeof candidate === 'string' && candidate.trim() && !isBareCode(candidate.trim())) return candidate;
  }
  return fallback;
}

const HANDLED = Symbol.for('oblimap.apiErrorHandled');

/** Marks an error as already reported to the user (call sites skip their toast). */
export function markHandled(err: unknown): void {
  if (err && typeof err === 'object') {
    try { (err as Record<symbol, unknown>)[HANDLED] = true; } catch { /* frozen object */ }
  }
}

/** True when the API client already reported this error to the user. */
export function isHandled(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as Record<symbol, unknown>)[HANDLED] === true;
}

/** toast.error with the server's message (or the fallback), unless the error was already reported. */
export function toastApiError(err: unknown, fallback: string): void {
  if (isHandled(err)) return;
  toast.error(apiErrorMessage(err, fallback));
}
