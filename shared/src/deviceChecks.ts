// Device Checks: declarative checks on third-party devices, executed by the probe.
// Typed contract shared by server, client and (mirrored in Go) the probe.

import type { DeviceType } from './types';

export const DEVICE_CHECKS_CAPABILITY = 'device_checks:1';
/**
 * Advertised by a probe whose local policy (config.json
 * deviceChecks.allowPlaintextSecrets) accepts check credentials over plain
 * HTTP. The server sends credentials over http only to such a probe, and only
 * when ALLOW_PLAINTEXT_PROBE_SECRETS is set: both sides must opt in.
 */
export const DEVICE_CHECKS_PLAINTEXT_SECRETS_CAPABILITY = 'device_checks_plaintext_secrets:1';
export const DEVICE_CHECK_LIMITS = {
  minIntervalSeconds: 30, maxIntervalSeconds: 3600, maxJitterSeconds: 60,
  minTimeoutMs: 1000, maxTimeoutMs: 10000,
  minBodyBytes: 1024, defaultBodyBytes: 262144, maxBodyBytes: 524288,
  maxVariants: 4, maxFields: 12, maxExtractorsPerVariant: 12, maxTransforms: 6,
  maxAssertions: 10, maxPatternLength: 512, maxPathLength: 512, maxValueLength: 256,
  maxTargetsPerProbe: 64, maxResultsPerBatch: 100, maxTemplateLength: 300, maxMatchEntries: 20,
} as const;

export type DeviceCheckValue = string | number | boolean | null;
export type DeviceCheckTone = 'ok' | 'warn' | 'bad' | 'neutral';
export type DeviceCheckStatus = 'pending' | 'ok' | 'fail' | 'error';
export type DeviceCheckAlertState = 'ok' | 'pending' | 'alerting' | 'suppressed';
export type DeviceCheckIcon = 'music' | 'radio' | 'volume' | 'activity' | 'printer' | 'info';

// ── Rule spec (stored in device_check_rules.spec) ──
export interface DeviceCheckMatch {
  vendorContains?: string[];          // case-insensitive substring of site_items.vendor
  macPrefixes?: string[];             // "AA:BB:CC"
  deviceTypes?: DeviceType[];
  itemIds?: number[];
  excludeItemIds?: number[];
  excludeDeviceTypes?: DeviceType[];
  requireMac: boolean;                // true => items without MAC never targeted; forced true when auth='basic'
}
export interface DeviceCheckField {
  key: string;                        // ^[a-zA-Z][a-zA-Z0-9_]{0,31}$
  label: string;                      // admin text (presets fill it from i18n at clone time)
  valueType: 'string' | 'number' | 'boolean' | 'enum';
  enumValues?: Array<{ value: string; label: string; tone: DeviceCheckTone }>;
  maxLength?: number;                 // <= 256
  sensitive?: boolean;                // masked in anonymous mode; never in notifications/socket
  historize?: boolean;                // writes value_changed events (7-day retention)
}
export type DeviceCheckTransform =
  | { op: 'trim' | 'collapseSpaces' | 'htmlUnescape' | 'stripTags' | 'lowercase' | 'uppercase' | 'toNumber' }
  | { op: 'map'; values: Record<string, string>; default?: string }
  | { op: 'truncate'; max: number }
  | { op: 'default'; value: string };
export interface DeviceCheckRequest {
  scheme: 'http' | 'https'; port: number; method: 'GET' | 'HEAD';
  path: string;                       // ^/[^\s\\#]{0,511}$ ; not '//' prefix; no '://', '@', '..', CR/LF
  accept: 'text/html' | 'application/json' | 'application/xml' | 'text/plain' | '*/*';
  auth: 'none' | 'basic';             // credentials live in device_check_credentials
  maxBodyBytes: number; followRedirects: 0 | 1 | 2 | 3;
  tlsSkipVerify: boolean; expectStatus: number[];     // default [200]
  charset: 'auto' | 'utf-8' | 'iso-8859-1' | 'windows-1252';
}
interface ExtractorBase { field: string; transforms?: DeviceCheckTransform[]; required?: boolean }
export type DeviceCheckExtractor =
  | (ExtractorBase & { type: 'regex'; source: 'body' | 'header'; header?: string; pattern: string; group: number })
  | (ExtractorBase & { type: 'json'; path: string })  // a.b[0].c
  | (ExtractorBase & { type: 'xml'; path: string })   // /a/b/c or /a/b/@attr (local names)
  | { field: string; type: 'httpStatus' }
  | { field: string; type: 'durationMs' };
export interface DeviceCheckVariant { id: string; label?: string; request: DeviceCheckRequest; extract: DeviceCheckExtractor[] }
export type DeviceCheckAssertionOp =
  | 'exists' | 'notEmpty' | 'equals' | 'notEquals' | 'in' | 'notIn' | 'contains' | 'notContains'
  | 'matches' | 'notMatches' | 'gt' | 'gte' | 'lt' | 'lte' | 'changedWithin';
export interface DeviceCheckAssertion {
  id: string; label: string; field: string; op: DeviceCheckAssertionOp;
  value?: string | number | boolean | Array<string | number>;
  pattern?: string;                   // matches/notMatches only; RE2, executed on the probe
  seconds?: number;                   // changedWithin only
  optional?: boolean;                 // skipped when field is null
  enabled: boolean;
}
export interface DeviceCheckDisplay { icon: DeviceCheckIcon; primary?: string; secondary?: string; badge?: string }
export interface DeviceCheckSchedule { intervalSeconds: number; jitterSeconds: number; timeoutMs: number }
export interface DeviceCheckAlerting {
  enabled: boolean; severity: 'down' | 'warning';
  failAfterRuns: number; failForSeconds: number;         // both must be met
  recoverAfterRuns: number; recoverForSeconds: number;
  treatErrorAs: 'fail' | 'ignore'; skipWhenDeviceOffline: boolean;
  window: 'always' | 'businessHours'; graceAfterOpenSeconds: number; onWindowClose: 'silent' | 'notify';
  renotifyEverySeconds: number;                           // 0 or >= 900
  notify: boolean; notifyRecovery: boolean; liveAlert: boolean;
  titleTemplate?: string; messageTemplate?: string;
}
export interface DeviceCheckSpec {
  schemaVersion: 1;
  match: DeviceCheckMatch; schedule: DeviceCheckSchedule;
  fields: DeviceCheckField[]; variants: DeviceCheckVariant[];
  assertions: DeviceCheckAssertion[]; display: DeviceCheckDisplay; alerting: DeviceCheckAlerting;
}

// ── API DTOs ──
export interface DeviceCheckRule {
  id: number; uuid: string; tenantId: number; name: string; description: string | null;
  enabled: boolean; suspendedReason: string | null; groupId: number | null; siteId: number | null;
  presetKey: string | null; presetVersion: number | null; spec: DeviceCheckSpec; revision: number;
  credentials: DeviceCheckCredentialInfo[];
  createdBy: number | null; updatedBy: number | null; createdAt: string; updatedAt: string;
  coverage?: { matchedItems: number; sites: number; withoutCapableProbe: number; ok: number; failing: number; alerting: number };
}
export interface DeviceCheckCredentialInfo { siteId: number | null; usernameMasked: string; secretVersion: number; updatedAt: string; updatedBy: number | null }
export interface DeviceCheckAssertionResult { id: string; label: string; pass: boolean; skipped: boolean; actual?: string }
export interface DeviceCheckTraceStep { step: string; status: 'ok' | 'failed' | 'skipped'; ms: number; detail?: string }
export interface DeviceCheckSlot { label: string; value: DeviceCheckValue; tone?: DeviceCheckTone }
export interface DeviceCheckSummary {             // SiteItem.checks[]
  stateId: number; ruleId: number; ruleName: string; icon: DeviceCheckIcon;
  status: DeviceCheckStatus; alertState: DeviceCheckAlertState; stale: boolean;
  primary?: DeviceCheckSlot; secondary?: DeviceCheckSlot; badge?: DeviceCheckSlot;
  lastCheckedAt: string | null; lastErrorCode: string | null; intervalSeconds: number;
}
export interface DeviceCheckStateDetail extends DeviceCheckSummary {
  siteItemId: number; siteId: number; probeId: number | null; variantId: string | null;
  values: Record<string, DeviceCheckValue>; valuesChangedAt: Record<string, string>;
  fields: DeviceCheckField[]; assertions: DeviceCheckAssertionResult[] | null;
  lastTrace: DeviceCheckTraceStep[] | null; lastError: string | null; alertSince: string | null;
}
export interface DeviceCheckEvent { id: number; kind: string; fromStatus: string | null; toStatus: string | null; details: Record<string, unknown> | null; createdAt: string }
export interface DeviceCheckSiteSummary { siteId: number; total: number; ok: number; failing: number; error: number; alerting: number; stale: number }
export interface DeviceCheckTestResponse {
  probeId: number; status: 'ok' | 'fail' | 'error';
  result: ProbeCheckResult; assertions: DeviceCheckAssertionResult[];
}
export interface BusinessHours {
  tz?: string;                                            // IANA, e.g. 'Europe/Paris'; default 'UTC'
  days?: Partial<Record<'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun', Array<[string, string]>>>; // "HH:MM"; end<start crosses midnight
  closedDates?: string[];                                 // 'YYYY-MM-DD', <= 60
}

// ── Probe wire ──
export interface ProbeCheckRule {
  id: number; rev: number; schedule: DeviceCheckSchedule; requireMac: boolean;
  fields: Array<Pick<DeviceCheckField, 'key' | 'valueType' | 'maxLength'>>;
  variants: DeviceCheckVariant[];
  regexTests: Array<{ id: string; field: string; pattern: string }>;  // built from matches/notMatches assertions
}
export interface ProbeCheckTarget {
  ruleId: number; itemId: number; ip: string; mac: string | null;
  credentials?: { username: string; password: string };
  authBlocked?: 'missing' | 'no_key' | 'insecure_transport';
}
export interface ProbeDeviceChecksConfig { v: 1; rev: string; maxConcurrency: number; rules: ProbeCheckRule[]; targets: ProbeCheckTarget[] }
export type ProbeCheckErrorCode =
  | 'timeout' | 'conn_refused' | 'unreachable' | 'tls' | 'http_status' | 'mac_mismatch' | 'mac_unverified'
  | 'target_not_allowed' | 'extract_failed' | 'regex_compile' | 'overrun' | 'credentials_unavailable'
  | 'insecure_transport' | 'policy_denied' | 'internal';
export interface ProbeCheckResult {
  ruleId: number; ruleRev: number; itemId: number; ip: string; variantId: string | null;
  startedAt: string; durationMs: number; status: 'ok' | 'error'; attempts: number;
  httpStatus?: number; bytes?: number; truncated?: boolean; macCheck: 'match' | 'unverified';
  values: Record<string, DeviceCheckValue>; regex: Record<string, boolean | null>;
  error?: { code: ProbeCheckErrorCode; message: string };
  trace?: DeviceCheckTraceStep[];      // always on error, on status change, and 1/15 min sample
  bodySnippet?: string;                // check_test only, <= 4 KiB, secret-looking lines redacted; never stored
}
export interface ProbeCheckResultsBatch { v: 1; sentAt: string; results: ProbeCheckResult[] }

// ── Presets (data lives in deviceCheckPresets.ts) ──
export interface DeviceCheckPreset {
  key: string; version: number; category: 'audio' | 'generic'; vendor: string | null;
  icon: DeviceCheckIcon; titleKey: string; titleFallback: string;
  descriptionKey: string; descriptionFallback: string;
  validated: boolean; validationNotes: string; minProbeVersion: string;
  spec: DeviceCheckSpec;             // field labels are fallbacks; client replaces them with t(`deviceChecks.presets.<key>.fields.<field>`)
}

// ── UI option lists (form selects) ──
export const DEVICE_CHECK_ICONS: readonly DeviceCheckIcon[] = [
  'music', 'radio', 'volume', 'activity', 'printer', 'info',
] as const;

export const DEVICE_CHECK_ASSERTION_OPS: readonly DeviceCheckAssertionOp[] = [
  'exists', 'notEmpty', 'equals', 'notEquals', 'in', 'notIn', 'contains', 'notContains',
  'matches', 'notMatches', 'gt', 'gte', 'lt', 'lte', 'changedWithin',
] as const;
