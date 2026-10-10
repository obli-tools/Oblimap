import apiClient from './client';
import type { AxiosResponse } from 'axios';
import type { TFunction } from 'i18next';
import type {
  DeviceCheckRule,
  DeviceCheckSpec,
  DeviceCheckMatch,
  DeviceCheckTestResponse,
  DeviceCheckStateDetail,
  DeviceCheckEvent,
  DeviceCheckSiteSummary,
  SiteItem,
} from '@oblimap/shared';

// ── DTOs ────────────────────────────────────────────────────────

/** One validation problem. `path` is relative to the rule ("name") or to its spec ("variants.0.request.port"). */
export interface DeviceCheckIssue {
  path: string;
  message: string;
}

export interface DeviceCheckValidation {
  ok: boolean;
  issues: DeviceCheckIssue[];
}

export interface DeviceCheckRuleInput {
  name: string;
  description?: string | null;
  groupId?: number | null;
  siteId?: number | null;
  presetKey?: string | null;
  presetVersion?: number | null;
  spec: DeviceCheckSpec;
}

export type DeviceCheckRulePatch = Partial<DeviceCheckRuleInput>;

/** Write-only: the server stores it encrypted and only ever returns the masked username. */
export interface DeviceCheckCredentialsInput {
  /** null = rule default, otherwise a per-site override. */
  siteId: number | null;
  username: string;
  password: string;
}

export interface DeviceCheckPreviewInput {
  match: DeviceCheckMatch;
  groupId?: number | null;
  siteId?: number | null;
}

export interface DeviceCheckPreview {
  total: number;
  /** withoutCapableProbe: no approved probe of that site advertises device checks support yet. */
  bySite: Array<{ siteId: number; siteName: string | null; count: number; withoutCapableProbe: boolean }>;
  sitesWithoutCapableProbe: number;
  /** At most 50 matched devices. */
  sample: SiteItem[];
}

export interface DeviceCheckEventsPage {
  /** Newest first. */
  events: DeviceCheckEvent[];
  /** Pass as `before` for the next (older) page; null when there is none. */
  nextCursor: number | null;
}

export interface DeviceCheckTestInput {
  spec: DeviceCheckSpec;
  ruleId?: number;
  siteItemId: number;
  /** 'stored' = the rule's stored credentials; an object = inline, never stored. */
  credentials?: { username: string; password: string } | 'stored';
}

/** Platform policy (app_config key device_checks_policy). */
export interface DeviceChecksPolicy {
  allowedPorts: number[];
  maxTargetsPerProbe: number;
  minIntervalSeconds: number;
  eventRetentionDays: number;
  valueEventRetentionDays: number;
}

export const DEFAULT_DEVICE_CHECKS_POLICY: DeviceChecksPolicy = {
  allowedPorts: [80, 443, 8000, 8080, 8081, 8443],
  maxTargetsPerProbe: 50,
  minIntervalSeconds: 30,
  eventRetentionDays: 90,
  valueEventRetentionDays: 7,
};

// ── Response helpers ──────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Reads a response body whatever its envelope: the bare value, `{ success, data }`
 * (appConfig style) or `{ <key>: value }` (vendorRules style, first key present wins).
 */
function pick<T>(body: unknown, ...keys: string[]): T {
  let v = body;
  if (isRecord(v) && 'success' in v && 'data' in v) v = v.data;
  if (isRecord(v)) {
    const key = keys.find((k) => k in (v as Record<string, unknown>));
    if (key) v = (v as Record<string, unknown>)[key];
  }
  return v as T;
}

function pickArray<T>(r: AxiosResponse, ...keys: string[]): T[] {
  const v = pick<unknown>(r.data, ...keys);
  return Array.isArray(v) ? (v as T[]) : [];
}

function isRule(v: unknown): v is DeviceCheckRule {
  return isRecord(v) && typeof v.id === 'number' && isRecord(v.spec);
}

/** Normalises zod-style issues; spec paths lose their leading "spec." so they match the form. */
export function normalizeIssues(raw: unknown): DeviceCheckIssue[] {
  if (!Array.isArray(raw)) return [];
  const out: DeviceCheckIssue[] = [];
  for (const it of raw) {
    if (!isRecord(it)) continue;
    const p = Array.isArray(it.path) ? it.path.join('.') : typeof it.path === 'string' ? it.path : '';
    const message = typeof it.message === 'string' ? it.message : '';
    const path = p === 'spec' ? '' : p.startsWith('spec.') ? p.slice(5) : p;
    out.push({ path, message });
  }
  return out;
}

export interface DeviceCheckApiError {
  status: number | undefined;
  /** Machine code when the server sent one ('encryption_key_missing', 'probe_not_connected', …). */
  code: string | undefined;
  /** Server message, when there is one. */
  message: string | undefined;
  issues: DeviceCheckIssue[];
}

/** Extracts status / code / message / issues from an axios error (or anything else). */
export function parseDeviceCheckError(err: unknown): DeviceCheckApiError {
  const res = (err as { response?: { status?: number; data?: unknown } } | null)?.response;
  const data = isRecord(res?.data) ? res!.data as Record<string, unknown> : {};
  const errorField = typeof data.error === 'string' ? data.error : undefined;
  const codeField = typeof data.code === 'string' ? data.code : undefined;
  const code = codeField ?? (errorField && /^[a-z][a-z0-9_]{1,63}$/.test(errorField) ? errorField : undefined);
  const message = typeof data.message === 'string' ? data.message : errorField;
  return { status: res?.status, code, message, issues: normalizeIssues(data.issues) };
}

/** English fallbacks of deviceChecks.errors.<code> (probe error codes + API codes). */
export const DEVICE_CHECK_ERROR_FALLBACKS: Record<string, string> = {
  timeout: 'The device did not answer in time',
  conn_refused: 'Connection refused by the device',
  unreachable: 'The device is unreachable',
  tls: 'TLS handshake failed',
  http_status: 'Unexpected HTTP status',
  mac_mismatch: 'Another device (different MAC) now answers on this IP: nothing was sent',
  mac_unverified: 'The probe could not verify the MAC address of the device',
  target_not_allowed: 'The probe refused this target (outside its scanned subnets)',
  extract_failed: 'A required value was not found in the answer',
  regex_compile: 'A pattern could not be compiled by the probe',
  overrun: 'The check took longer than its schedule allows',
  credentials_unavailable: 'Credentials are not available on the probe',
  insecure_transport: 'Credentials are only sent to probes that talk to the server over HTTPS',
  policy_denied: 'The probe local policy refused this check',
  internal: 'Internal probe error',
  encryption_key_missing: 'The server has no DATA_ENCRYPTION_KEY: credentials cannot be stored',
  probe_not_connected: 'The probe that would run this check is not connected (WebSocket)',
  probe_unsupported: 'No probe of this site supports device checks yet: update the probe',
  probe_timeout: 'The probe did not answer in time (20 s)',
  rule_disabled: 'This check is disabled or suspended',
  scope_not_allowed: 'You can only manage checks of a group or site you can edit (a whole-workspace check needs a workspace admin)',
};

/** Translated label of an error code, or undefined when the code is unknown. */
export function deviceCheckErrorLabel(code: string | null | undefined, t: TFunction): string | undefined {
  if (!code) return undefined;
  const fallback = DEVICE_CHECK_ERROR_FALLBACKS[code];
  if (!fallback) return undefined;
  return t(`deviceChecks.errors.${code}`, fallback);
}

/** User-facing message of a failed API call: known code, then server message, then `fallback`. */
export function describeDeviceCheckError(err: unknown, t: TFunction, fallback: string): string {
  const e = parseDeviceCheckError(err);
  return deviceCheckErrorLabel(e.code, t) ?? e.message ?? fallback;
}

// ── API ───────────────────────────────────────────────────────────────────────

export const deviceChecksApi = {
  // ── Rules (admin) ──

  list: (): Promise<DeviceCheckRule[]> =>
    apiClient.get('/device-checks/rules').then((r) => pickArray<DeviceCheckRule>(r, 'rules', 'items')),

  get: (id: number): Promise<DeviceCheckRule> =>
    apiClient.get(`/device-checks/rules/${id}`).then((r) => pick<DeviceCheckRule>(r.data, 'rule')),

  /** Rules are always created disabled; enabling is a separate call. */
  create: (data: DeviceCheckRuleInput): Promise<DeviceCheckRule> =>
    apiClient.post('/device-checks/rules', data).then((r) => pick<DeviceCheckRule>(r.data, 'rule')),

  update: (id: number, data: DeviceCheckRulePatch): Promise<DeviceCheckRule> =>
    apiClient.patch(`/device-checks/rules/${id}`, data).then((r) => pick<DeviceCheckRule>(r.data, 'rule')),

  remove: (id: number): Promise<void> =>
    apiClient.delete(`/device-checks/rules/${id}`).then(() => undefined),

  /** Resolves with the updated rule when the server returns it, null otherwise. */
  enable: (id: number): Promise<DeviceCheckRule | null> =>
    apiClient.post(`/device-checks/rules/${id}/enable`).then((r) => {
      const v = pick<unknown>(r.data, 'rule');
      return isRule(v) ? v : null;
    }),

  disable: (id: number): Promise<DeviceCheckRule | null> =>
    apiClient.post(`/device-checks/rules/${id}/disable`).then((r) => {
      const v = pick<unknown>(r.data, 'rule');
      return isRule(v) ? v : null;
    }),

  // ── Credentials (write-only; 409 encryption_key_missing without DATA_ENCRYPTION_KEY) ──

  setCredentials: (id: number, data: DeviceCheckCredentialsInput): Promise<void> =>
    apiClient.put(`/device-checks/rules/${id}/credentials`, data).then(() => undefined),

  clearCredentials: (id: number, siteId: number | null): Promise<void> =>
    apiClient
      .delete(`/device-checks/rules/${id}/credentials`, { params: siteId !== null ? { siteId } : undefined })
      .then(() => undefined),

  // ── Authoring helpers ──

  /** Live form validation. A 400 carrying issues is returned as { ok: false, issues }. */
  validate: async (spec: DeviceCheckSpec): Promise<DeviceCheckValidation> => {
    try {
      const r = await apiClient.post('/device-checks/validate', { spec });
      const body = pick<unknown>(r.data, 'validation');
      const issues = normalizeIssues(isRecord(body) ? body.issues : undefined);
      const ok = isRecord(body) && typeof body.ok === 'boolean' ? body.ok : issues.length === 0;
      return { ok, issues };
    } catch (err) {
      const e = parseDeviceCheckError(err);
      if (e.status === 400 && e.issues.length > 0) return { ok: false, issues: e.issues };
      throw err;
    }
  },

  previewMatches: (data: DeviceCheckPreviewInput): Promise<DeviceCheckPreview> =>
    apiClient.post('/device-checks/preview-matches', data).then((r) => {
      const v = pick<Record<string, unknown> | undefined>(r.data, 'preview');
      const rawSites = Array.isArray(v?.bySite) ? (v.bySite as Array<Record<string, unknown>>) : [];
      const bySite = rawSites.filter(isRecord).map((s) => ({
        siteId: Number(s.siteId),
        siteName: typeof s.siteName === 'string' ? s.siteName : null,
        count: typeof s.count === 'number' ? s.count : 0,
        // boolean in the API; a count is accepted too
        withoutCapableProbe: typeof s.withoutCapableProbe === 'number' ? s.withoutCapableProbe > 0 : s.withoutCapableProbe === true,
      }));
      return {
        total: typeof v?.total === 'number' ? v.total : 0,
        bySite,
        sitesWithoutCapableProbe: typeof v?.sitesWithoutCapableProbe === 'number'
          ? v.sitesWithoutCapableProbe
          : bySite.filter((s) => s.withoutCapableProbe).length,
        sample: Array.isArray(v?.sample) ? (v.sample as SiteItem[]) : [],
      };
    }),

  /** Runs the (possibly unsaved) spec once on one device through its executor probe (≈20 s max). */
  test: (data: DeviceCheckTestInput): Promise<DeviceCheckTestResponse> =>
    apiClient
      .post('/device-checks/test', data, { timeout: 30_000 })
      .then((r) => pick<DeviceCheckTestResponse>(r.data, 'test')),

  runNow: (stateId: number): Promise<void> =>
    apiClient.post(`/device-checks/states/${stateId}/run-now`).then(() => undefined),

  // ── Reads (tenant members) ──

  siteStates: (siteId: number): Promise<DeviceCheckStateDetail[]> =>
    apiClient.get(`/device-checks/sites/${siteId}/states`).then((r) => pickArray<DeviceCheckStateDetail>(r, 'states')),

  /** History of one (rule, device) state, newest first, cursor-paged (limit ≤ 100). */
  events: (stateId: number, params: { before?: number; limit?: number } = {}): Promise<DeviceCheckEventsPage> =>
    apiClient
      .get(`/device-checks/states/${stateId}/events`, { params })
      .then((r) => {
        const events = pickArray<DeviceCheckEvent>(r, 'events', 'items');
        const body = pick<unknown>(r.data);
        const cursor = isRecord(body) ? body.nextCursor : undefined;
        return {
          events,
          nextCursor: typeof cursor === 'number'
            ? cursor
            : cursor === null ? null
              : params.limit !== undefined && events.length >= params.limit ? events[events.length - 1].id : null,
        };
      }),

  summary: (): Promise<DeviceCheckSiteSummary[]> =>
    apiClient.get('/device-checks/summary').then((r) => pickArray<DeviceCheckSiteSummary>(r, 'summary', 'sites')),

  // ── Platform policy (platform admin) ──

  getPolicy: (): Promise<DeviceChecksPolicy> =>
    apiClient.get('/admin/config/device-checks-policy').then((r) => {
      const v = pick<Partial<DeviceChecksPolicy>>(r.data, 'policy');
      return { ...DEFAULT_DEVICE_CHECKS_POLICY, ...(isRecord(v) ? v : {}) };
    }),

  setPolicy: (policy: DeviceChecksPolicy): Promise<DeviceChecksPolicy> =>
    apiClient.put('/admin/config/device-checks-policy', policy).then((r) => {
      const v = pick<Partial<DeviceChecksPolicy>>(r.data, 'policy');
      return isRecord(v) && Array.isArray(v.allowedPorts) ? { ...policy, ...v } : policy;
    }),
};
