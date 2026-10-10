import { z } from 'zod';
import {
  DEVICE_CHECK_LIMITS,
  DEVICE_CHECK_ICONS,
  DEVICE_CHECK_ASSERTION_OPS,
} from '@oblimap/shared';
import type {
  DeviceCheckIcon,
  DeviceCheckAssertionOp,
  DeviceCheckSpec,
  ProbeCheckErrorCode,
} from '@oblimap/shared';
import { VENDOR_RULE_DEVICE_TYPES } from './vendorRule.schema';
import { filterProbeCapabilities } from './probe.schema';
import { templateReferences } from '../utils/templates';

// Device Checks validation. Rule specs are admin input that
// ends up executed on shop LANs by the probes: every object is .strict()
// (an unknown key is an error, never silently stored), every list and string
// is bounded by DEVICE_CHECK_LIMITS, and the cross-field rules (declared
// fields, unique ids, per-op requirements, template variables) are checked
// once the shape is known. The probe re-checks the hard limits on its side.
//
// Checks that need the database are done by the rule service: ports ⊂
// policy.allowedPorts, schedule.intervalSeconds ≥ policy.minIntervalSeconds,
// itemIds / excludeItemIds / groupId / siteId owned by the tenant.
//
// Rule regexes are NEVER compiled or run on the server (no ReDoS on Node):
// they are RE2 patterns run by the probe. The server only refuses the PCRE
// constructs RE2 does not have, so the author gets the error at save time.
//
// Probe → server messages (results, hello) are validated with bounded,
// NON-strict schemas: unknown keys are stripped, not fatal, so a newer probe
// that reports an extra field keeps working with this server.

const L = DEVICE_CHECK_LIMITS;
const INT4_MAX = 2_147_483_647;

// ── Primitives ───────────────────────────────────────────────────────────────

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_NEWLINES_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Bounded single-line text (no control characters). */
function text(max: number) {
  return z.string().max(max).refine((s) => !CONTROL_RE.test(s), 'Control characters are not allowed');
}

/** Non-empty, trimmed, bounded single-line text. */
function label(max: number) {
  return z.string().trim().min(1, 'Required').max(max)
    .refine((s) => !CONTROL_RE.test(s), 'Control characters are not allowed');
}

const dbId = z.number().int().positive().max(INT4_MAX);

export const FIELD_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;
const fieldKey = z.string().regex(FIELD_KEY_RE, 'Keys start with a letter and hold at most 32 letters, digits or _');

const VARIANT_ID_RE = /^[a-z0-9-]{1,32}$/;
const variantId = z.string().regex(VARIANT_ID_RE, 'Variant ids hold 1-32 lowercase letters, digits or -');

// Assertion ids double as the probe's regex test ids (at most 64 characters there).
const ASSERTION_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/;
const assertionId = z.string().regex(ASSERTION_ID_RE, 'Ids start with a letter and hold at most 32 letters, digits, _ or -');

const deviceType = z.enum(VENDOR_RULE_DEVICE_TYPES);

const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;

const MAC_PREFIX_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){2}$/;
const macPrefix = z.string().max(17)
  .transform((s) => s.trim().toUpperCase().replace(/-/g, ':'))
  .refine((s) => MAC_PREFIX_RE.test(s), 'MAC prefixes look like AA:BB:CC');

// ── RE2 compatibility ────────────────────────────────────────────────────────

// The probe compiles rule regexes with Go's regexp (RE2 syntax, Perl flags).
// The scanner below follows Go's parser closely enough that a pattern it
// accepts compiles there (checked differentially against regexp.Compile on
// ~48k generated patterns: no pattern Go accepts is refused), short of the
// checks that need Go's tables or ranges (unknown \p{Name} or POSIX class
// names, reversed ranges [z-a], nested repeat sizes): those still surface as
// regex_compile on the probe.

// Letters Go accepts after a backslash, outside / inside a character class
// (octal digits, \x, \p and \P are handled apart). Any other letter or digit
// (\Z, \u, \e, \h, \G, \K, \C, \E alone…) is a compile error there; escaped
// ASCII punctuation is a literal.
const RE2_ESCAPE_LETTERS: ReadonlySet<string> = new Set('AbBzQdDsSwWaftnrv');
const RE2_CLASS_ESCAPE_LETTERS: ReadonlySet<string> = new Set('dDsSwWaftnrv');
const RE2_ESCAPE_HINTS: Readonly<Record<string, string>> = {
  Z: 'use \\z (end of text)',
  u: 'use \\x{…} for a code point',
  e: 'use \\x1B',
  h: 'use [ \\t]',
};

function isOctalDigit(c: string | undefined): boolean {
  return c !== undefined && c >= '0' && c <= '7';
}

/** The escape at pattern[i] ('\\'): why RE2 refuses it, and the index of its last character. */
function re2Escape(pattern: string, i: number, inClass: boolean): { problem: string | null; last: number } {
  const n = pattern[i + 1];
  if (n === undefined) return { problem: 'The pattern ends with a lone backslash', last: i };
  // Octal: \0 plus up to two octal digits, \1-\7 followed by at least one.
  if (n === '0' || (isOctalDigit(n) && isOctalDigit(pattern[i + 2]))) {
    let j = i + 2;
    while (j < i + 4 && isOctalDigit(pattern[j])) j++;
    return { problem: null, last: j - 1 };
  }
  if (n >= '1' && n <= '9') return { problem: 'Backreferences (\\1-\\9) are not supported (RE2)', last: i + 1 };
  if (n === 'k' && pattern[i + 2] === '<') return { problem: 'Named backreferences (\\k<name>) are not supported (RE2)', last: i + 1 };
  if (n === 'x') {
    const m = /^(?:\{([0-9A-Fa-f]{1,8})\}|[0-9A-Fa-f]{2})/.exec(pattern.slice(i + 2, i + 12));
    if (!m || (m[1] !== undefined && parseInt(m[1], 16) > 0x10ffff)) {
      return { problem: 'Hex escapes are written \\x7F or \\x{10FFFF} (RE2)', last: i + 1 };
    }
    return { problem: null, last: i + 1 + m[0].length };
  }
  if (n === 'p' || n === 'P') {
    const m = /^(?:\{\^?[A-Za-z_]{1,40}\}|[A-Za-z])/.exec(pattern.slice(i + 2, i + 46));
    if (!m) return { problem: 'Unicode classes are written \\pL or \\p{Name} (RE2)', last: i + 1 };
    return { problem: null, last: i + 1 + m[0].length };
  }
  if (/^[A-Za-z0-9]$/.test(n)) {
    if ((inClass ? RE2_CLASS_ESCAPE_LETTERS : RE2_ESCAPE_LETTERS).has(n)) return { problem: null, last: i + 1 };
    const hint = RE2_ESCAPE_HINTS[n];
    return {
      problem: `\\${n} is not supported${inClass ? ' inside a character class' : ''} (RE2)${hint ? `: ${hint}` : ''}`,
      last: i + 1,
    };
  }
  if (n.charCodeAt(0) > 0x7f) return { problem: 'Only ASCII punctuation can be escaped (RE2)', last: i + 1 };
  return { problem: null, last: i + 1 }; // escaped punctuation: a literal
}

/**
 * Scans `pattern` as Go's regexp parser does, token by token (an escaped
 * backslash followed by a digit is a literal, not a backreference; a
 * parenthesis inside a character class is a literal; \Q…\E is literal
 * text). `problem` says why the probe could not compile it, or is null;
 * `groups` counts the capturing groups.
 * Refused: lookahead (?= (?!, lookbehind (?<= (?<!, atomic groups (?>,
 * backreferences \1-\9, \k<name>, (?P=name), any other (?…) construct but
 * (?:…), (?P<name>…), (?<name>…) and the flags i m s U, escapes Go does not
 * have (\Z, \u…), possessive / stacked quantifiers (a*+, a++, a**),
 * quantifiers without an argument, repeat counts above 1000, unbalanced
 * parentheses and unclosed character classes. Flags are written inline:
 * (?is).
 */
export function re2PatternInfo(pattern: string): { problem: string | null; groups: number } {
  let groups = 0;
  let depth = 0;
  let inClass = false;
  // What a quantifier would apply to: nothing, an atom, or a quantifier.
  let prev: 'none' | 'atom' | 'repeat' = 'none';
  const fail = (problem: string) => ({ problem, groups });

  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];

    if (inClass) {
      if (c === '\\') {
        const e = re2Escape(pattern, i, true);
        if (e.problem) return fail(e.problem);
        i = e.last;
      } else if (c === '[' && pattern[i + 1] === ':') {
        // POSIX class [:alpha:]: consumed whole when closed.
        const end = pattern.indexOf(':]', i + 2);
        if (end >= 0) i = end + 1;
      } else if (c === ']') {
        inClass = false;
        prev = 'atom';
      }
      continue;
    }

    if (c === '\\') {
      if (pattern[i + 1] === 'Q') {
        // \Q…\E (or to the end): literal text.
        const end = pattern.indexOf('\\E', i + 2);
        const literalLength = (end < 0 ? pattern.length : end) - (i + 2);
        i = end < 0 ? pattern.length : end + 1;
        if (literalLength > 0 || prev === 'repeat') prev = 'atom';
        continue;
      }
      const e = re2Escape(pattern, i, false);
      if (e.problem) return fail(e.problem);
      i = e.last;
      prev = 'atom';
      continue;
    }

    if (c === '[') {
      inClass = true;
      // A ']' right after '[' or '[^' is a literal member of the class.
      if (pattern[i + 1] === '^') i++;
      if (pattern[i + 1] === ']') i++;
      continue;
    }

    if (c === '(') {
      if (pattern[i + 1] !== '?') {
        groups++;
        depth++;
        prev = 'none';
        continue;
      }
      const rest = pattern.slice(i + 2);
      if (rest[0] === '=' || rest[0] === '!') return fail('Lookahead ((?= / (?!) is not supported (RE2)');
      if (rest[0] === '<' && (rest[1] === '=' || rest[1] === '!')) return fail('Lookbehind ((?<= / (?<!) is not supported (RE2)');
      if (rest[0] === '>') return fail('Atomic groups ((?>…)) are not supported (RE2)');
      if (rest.startsWith('P=') || rest.startsWith('P>')) {
        return fail('Named backreferences and recursion ((?P=name), (?P>name)) are not supported (RE2)');
      }
      const named = /^P?<([A-Za-z0-9_]+)>/.exec(rest);
      if (named) {
        groups++;
        depth++;
        prev = 'none';
        i += 1 + named[0].length; // at '>'
        continue;
      }
      if (/^P?</.test(rest)) return fail('Group names hold only letters, digits and _ (RE2)');
      const flags = /^[imsU]*(?:-[imsU]+)?([:)])/.exec(rest);
      if (!flags) {
        return fail('Unsupported group (RE2): only (?:…), (?P<name>…), (?<name>…) and the flags i, m, s, U are allowed');
      }
      i += 1 + flags[0].length; // at ':' or ')'
      if (flags[1] === ':') {
        depth++;
        prev = 'none';
      } else if (prev === 'repeat') {
        prev = 'atom'; // (?i) alone: a quantifier after it is not "stacked" for Go
      }
      continue;
    }

    if (c === ')') {
      depth--;
      if (depth < 0) return fail('Unbalanced parenthesis: ")" without "("');
      prev = 'atom';
      continue;
    }

    if (c === '|') {
      prev = 'none';
      continue;
    }

    let quantifierLength = 0;
    if (c === '*' || c === '+' || c === '?') {
      quantifierLength = 1;
    } else if (c === '{') {
      // {n}, {n,}, {n,m}: a repeat; anything else is a literal '{' for Go.
      const m = /^\{(0|[1-9]\d*)(?:(,)(0|[1-9]\d*)?)?\}/.exec(pattern.slice(i, i + 32));
      if (m) {
        const min = Number(m[1]);
        const max = m[2] ? (m[3] !== undefined ? Number(m[3]) : -1) : min;
        if (min > 1000 || max > 1000 || (max >= 0 && min > max)) {
          return fail('Repeat counts are at most 1000, with {min,max} in order (RE2)');
        }
        quantifierLength = m[0].length;
      }
    }
    if (quantifierLength > 0) {
      if (prev === 'none') return fail(`Nothing to repeat before "${c}"`);
      if (prev === 'repeat') return fail('Possessive or stacked quantifiers (a*+, a++, a**) are not supported (RE2)');
      i += quantifierLength - 1;
      if (pattern[i + 1] === '?') i++; // lazy
      prev = 'repeat';
      continue;
    }

    prev = 'atom';
  }

  if (inClass) return fail('Missing "]" at the end of a character class');
  if (depth > 0) return fail('Missing ")"');
  return { problem: null, groups };
}

/** Why `pattern` cannot be an RE2 pattern (see re2PatternInfo), or null. */
export function re2Incompatibility(pattern: string): string | null {
  return re2PatternInfo(pattern).problem;
}

const re2Pattern = z.string().min(1, 'Required').max(L.maxPatternLength).superRefine((p, ctx) => {
  const why = re2Incompatibility(p);
  if (why) ctx.addIssue({ code: z.ZodIssueCode.custom, message: why });
});

// ── Request path ─────────────────────────────────────────────────────────────

const PATH_RE = /^\/[^\s\\#]{0,511}$/;

/** %XX → the byte as a character (never throws, unlike decodeURIComponent). */
function percentDecode(s: string): string {
  return s.replace(/%([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/**
 * Why `path` is not an acceptable request path, or null. The probe builds
 * `scheme://ip:port` + path itself (IP literal, no DNS): the path must stay
 * a path — no authority, no traversal, also once percent-decoded (up to
 * three rounds, against double encoding).
 */
export function requestPathProblem(path: string): string | null {
  if (!PATH_RE.test(path)) return 'The path starts with / and holds at most 512 characters, without spaces, backslashes or #';
  if (path.startsWith('//')) return 'The path must not start with //';
  if (path.includes('://')) return 'The path must not contain ://';
  if (path.includes('@')) return 'The path must not contain @';
  let cur = path;
  for (let round = 0; round < 4; round++) {
    if (cur.includes('..')) return 'The path must not contain ..';
    if (cur.includes('//')) return 'The path must not contain //';
    if (cur.includes('\\')) return 'The path must not contain a backslash';
    if (CONTROL_RE.test(cur)) return 'The path must not contain control characters';
    const next = percentDecode(cur);
    if (next === cur) break;
    cur = next;
  }
  return null;
}

const requestPath = z.string().max(L.maxPathLength).superRefine((p, ctx) => {
  const why = requestPathProblem(p);
  if (why) ctx.addIssue({ code: z.ZodIssueCode.custom, message: why });
});

// ── Extraction paths ─────────────────────────────────────────────────────────

export const JSON_PATH_RE = /^[A-Za-z_][\w-]{0,63}(\[\d{1,4}\])?(\.[A-Za-z_][\w-]{0,63}(\[\d{1,4}\])?){0,11}$/;
export const XML_PATH_RE = /^(\/[A-Za-z_][\w.-]{0,63}){1,12}(\/@[A-Za-z_][\w.-]{0,63})?$/;

const jsonPath = z.string().max(L.maxPathLength).regex(JSON_PATH_RE, 'JSON paths look like a.b[0].c');
const xmlPath = z.string().max(L.maxPathLength).regex(XML_PATH_RE, 'XML paths look like /a/b/c or /a/b/@attr');

// ── Spec sections ────────────────────────────────────────────────────────────

const matchListKeys = ['vendorContains', 'macPrefixes', 'deviceTypes', 'itemIds'] as const;

export const deviceCheckMatchSchema = z.object({
  vendorContains: z.array(label(64).refine((s) => s.length >= 2, 'At least 2 characters')).max(L.maxMatchEntries).optional(),
  macPrefixes: z.array(macPrefix).max(L.maxMatchEntries).optional(),
  deviceTypes: z.array(deviceType).max(L.maxMatchEntries).optional(),
  itemIds: z.array(dbId).max(L.maxMatchEntries).optional(),
  excludeItemIds: z.array(dbId).max(L.maxMatchEntries).optional(),
  excludeDeviceTypes: z.array(deviceType).max(L.maxMatchEntries).optional(),
  requireMac: z.boolean(),
}).strict().superRefine((m, ctx) => {
  // No match-all rule: at least one positive criterion with at least one entry.
  if (!matchListKeys.some((k) => (m[k]?.length ?? 0) > 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Target devices by vendor, MAC prefix, device type or explicit devices (at least one entry)',
    });
  }
});

const scheduleSchema = z.object({
  intervalSeconds: z.number().int().min(L.minIntervalSeconds).max(L.maxIntervalSeconds),
  jitterSeconds: z.number().int().min(0).max(L.maxJitterSeconds),
  timeoutMs: z.number().int().min(L.minTimeoutMs).max(L.maxTimeoutMs),
}).strict();

const toneSchema = z.enum(['ok', 'warn', 'bad', 'neutral']);

const fieldSchema = z.object({
  key: fieldKey,
  label: label(64),
  valueType: z.enum(['string', 'number', 'boolean', 'enum']),
  enumValues: z.array(z.object({
    value: z.string().min(1, 'Required').max(128).refine((s) => !CONTROL_RE.test(s), 'Control characters are not allowed'),
    label: label(64),
    tone: toneSchema,
  }).strict()).min(1).max(L.maxFields).optional(),
  maxLength: z.number().int().min(1).max(L.maxValueLength).optional(),
  sensitive: z.boolean().optional(),
  historize: z.boolean().optional(),
}).strict();

const transformValue = text(L.maxValueLength);

const transformSchema = z.discriminatedUnion('op', [
  z.object({ op: z.enum(['trim', 'collapseSpaces', 'htmlUnescape', 'stripTags', 'lowercase', 'uppercase', 'toNumber']) }).strict(),
  z.object({
    op: z.literal('map'),
    values: z.record(transformValue, transformValue)
      .refine((o) => Object.keys(o).length >= 1, 'A map needs at least one entry')
      .refine((o) => Object.keys(o).length <= 32, 'A map holds at most 32 entries'),
    default: transformValue.optional(),
  }).strict(),
  z.object({ op: z.literal('truncate'), max: z.number().int().min(1).max(L.maxValueLength) }).strict(),
  z.object({ op: z.literal('default'), value: transformValue }).strict(),
]);

const transforms = z.array(transformSchema).max(L.maxTransforms).optional();

const extractorSchema = z.discriminatedUnion('type', [
  z.object({
    field: fieldKey,
    type: z.literal('regex'),
    source: z.enum(['body', 'header']),
    header: z.string().regex(HEADER_NAME_RE, 'Invalid header name').optional(),
    pattern: re2Pattern,
    group: z.number().int().min(0).max(99),
    transforms,
    required: z.boolean().optional(),
  }).strict(),
  z.object({ field: fieldKey, type: z.literal('json'), path: jsonPath, transforms, required: z.boolean().optional() }).strict(),
  z.object({ field: fieldKey, type: z.literal('xml'), path: xmlPath, transforms, required: z.boolean().optional() }).strict(),
  z.object({ field: fieldKey, type: z.literal('httpStatus') }).strict(),
  z.object({ field: fieldKey, type: z.literal('durationMs') }).strict(),
]);

const requestSchema = z.object({
  scheme: z.enum(['http', 'https']),
  port: z.number().int().min(1).max(65535),
  method: z.enum(['GET', 'HEAD']),
  path: requestPath,
  accept: z.enum(['text/html', 'application/json', 'application/xml', 'text/plain', '*/*']),
  auth: z.enum(['none', 'basic']),
  maxBodyBytes: z.number().int().min(L.minBodyBytes).max(L.maxBodyBytes),
  followRedirects: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  tlsSkipVerify: z.boolean(),
  expectStatus: z.array(z.number().int().min(100).max(599)).min(1).max(5),
  charset: z.enum(['auto', 'utf-8', 'iso-8859-1', 'windows-1252']),
}).strict();

const variantSchema = z.object({
  id: variantId,
  label: text(128).optional(),
  request: requestSchema,
  extract: z.array(extractorSchema).min(1, 'At least one extractor').max(L.maxExtractorsPerVariant),
}).strict();

const assertionScalar = z.union([z.string().max(L.maxValueLength), z.number().finite(), z.boolean()]);

const assertionSchema = z.object({
  id: assertionId,
  label: label(128),
  field: fieldKey,
  op: z.enum(DEVICE_CHECK_ASSERTION_OPS as unknown as [DeviceCheckAssertionOp, ...DeviceCheckAssertionOp[]]),
  value: z.union([
    assertionScalar,
    z.array(z.union([z.string().max(L.maxValueLength), z.number().finite()])).max(20),
  ]).optional(),
  pattern: re2Pattern.optional(),
  seconds: z.number().int().min(60).max(86400).optional(),
  optional: z.boolean().optional(),
  enabled: z.boolean(),
}).strict();

const displaySchema = z.object({
  icon: z.enum(DEVICE_CHECK_ICONS as unknown as [DeviceCheckIcon, ...DeviceCheckIcon[]]),
  primary: fieldKey.optional(),
  secondary: fieldKey.optional(),
  badge: fieldKey.optional(),
}).strict();

const templateText = text(L.maxTemplateLength);

const alertingSchema = z.object({
  enabled: z.boolean(),
  severity: z.enum(['down', 'warning']),
  failAfterRuns: z.number().int().min(1).max(60),
  failForSeconds: z.number().int().min(0).max(86400),
  recoverAfterRuns: z.number().int().min(1).max(60),
  recoverForSeconds: z.number().int().min(0).max(3600),
  treatErrorAs: z.enum(['fail', 'ignore']),
  skipWhenDeviceOffline: z.boolean(),
  window: z.enum(['always', 'businessHours']),
  graceAfterOpenSeconds: z.number().int().min(0).max(7200),
  onWindowClose: z.enum(['silent', 'notify']),
  renotifyEverySeconds: z.number().int().min(0).max(86400)
    .refine((v) => v === 0 || v >= 900, 'Renotify every 0 (never) or at least 900 seconds'),
  notify: z.boolean(),
  notifyRecovery: z.boolean(),
  liveAlert: z.boolean(),
  titleTemplate: templateText.optional(),
  messageTemplate: templateText.optional(),
}).strict();

const specObjectSchema = z.object({
  schemaVersion: z.literal(1),
  match: deviceCheckMatchSchema,
  schedule: scheduleSchema,
  fields: z.array(fieldSchema).min(1, 'At least one field').max(L.maxFields),
  variants: z.array(variantSchema).min(1, 'At least one variant').max(L.maxVariants),
  assertions: z.array(assertionSchema).max(L.maxAssertions),
  display: displaySchema,
  alerting: alertingSchema,
}).strict();

type SpecObject = z.infer<typeof specObjectSchema>;

// Compile-time guard: what the schema accepts is a DeviceCheckSpec.
type SpecCompatible = SpecObject extends DeviceCheckSpec ? true : never;
const specCompatible: SpecCompatible = true;
void specCompatible;

const NUMERIC_OPS: ReadonlySet<DeviceCheckAssertionOp> = new Set(['gt', 'gte', 'lt', 'lte']);
const SCALAR_OPS: ReadonlySet<DeviceCheckAssertionOp> = new Set(['equals', 'notEquals', 'contains', 'notContains']);

/** Cross-field rules of a spec whose shape is valid. */
function checkSpec(s: SpecObject, ctx: z.RefinementCtx): void {
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

  // Fields
  const fields = new Map<string, SpecObject['fields'][number]>();
  s.fields.forEach((f, i) => {
    if (fields.has(f.key)) issue(['fields', i, 'key'], `Duplicate field key "${f.key}"`);
    fields.set(f.key, f);
    if (f.valueType === 'enum') {
      if (!f.enumValues?.length) issue(['fields', i, 'enumValues'], 'An enum field needs its list of values');
      const seen = new Set<string>();
      f.enumValues?.forEach((ev, j) => {
        if (seen.has(ev.value)) issue(['fields', i, 'enumValues', j, 'value'], `Duplicate enum value "${ev.value}"`);
        seen.add(ev.value);
      });
    } else if (f.enumValues !== undefined) {
      issue(['fields', i, 'enumValues'], 'enumValues is only allowed on enum fields');
    }
  });

  // Variants and extractors
  const variantIds = new Set<string>();
  s.variants.forEach((v, i) => {
    if (variantIds.has(v.id)) issue(['variants', i, 'id'], `Duplicate variant id "${v.id}"`);
    variantIds.add(v.id);
    v.extract.forEach((e, j) => {
      if (!fields.has(e.field)) issue(['variants', i, 'extract', j, 'field'], `Unknown field "${e.field}"`);
      if (e.type === 'regex' && e.source === 'header' && !e.header) {
        issue(['variants', i, 'extract', j, 'header'], 'Name the response header to read');
      }
      if (e.type === 'regex') {
        // The probe refuses a group the pattern does not have (every run would error).
        const info = re2PatternInfo(e.pattern);
        if (info.problem === null && e.group > info.groups) {
          issue(['variants', i, 'extract', j, 'group'], `The pattern has ${info.groups} capturing group(s): group ${e.group} does not exist`);
        }
      }
    });
  });

  // Assertions
  const assertionIds = new Set<string>();
  s.assertions.forEach((a, i) => {
    if (assertionIds.has(a.id)) issue(['assertions', i, 'id'], `Duplicate assertion id "${a.id}"`);
    assertionIds.add(a.id);
    if (!fields.has(a.field)) issue(['assertions', i, 'field'], `Unknown field "${a.field}"`);
    if ((a.op === 'matches' || a.op === 'notMatches') && !a.pattern) {
      issue(['assertions', i, 'pattern'], 'This check needs a pattern');
    }
    if (a.op === 'changedWithin' && a.seconds === undefined) {
      issue(['assertions', i, 'seconds'], 'This check needs a duration (60-86400 seconds)');
    }
    if ((a.op === 'in' || a.op === 'notIn') && (!Array.isArray(a.value) || a.value.length === 0)) {
      issue(['assertions', i, 'value'], 'This check needs a list of 1-20 values');
    }
    if (SCALAR_OPS.has(a.op) && (a.value === undefined || Array.isArray(a.value))) {
      issue(['assertions', i, 'value'], 'This check needs a value');
    }
    if (NUMERIC_OPS.has(a.op) && (typeof a.value !== 'number')) {
      issue(['assertions', i, 'value'], 'This check needs a number');
    }
  });

  // Display slots
  for (const slot of ['primary', 'secondary', 'badge'] as const) {
    const key = s.display[slot];
    if (key !== undefined && !fields.has(key)) issue(['display', slot], `Unknown field "${key}"`);
  }

  // Templates: allowlisted variables; {{value.<key>}} of a declared, non-sensitive field.
  for (const tpl of ['titleTemplate', 'messageTemplate'] as const) {
    const t = s.alerting[tpl];
    if (!t) continue;
    for (const ref of templateReferences(t)) {
      if (ref.kind === 'unknown') {
        issue(['alerting', tpl], `Unknown variable {{${ref.name.slice(0, 40)}}}`);
      } else if (ref.kind === 'value') {
        const f = fields.get(ref.key);
        if (!f) issue(['alerting', tpl], `{{value.${ref.key}}}: unknown field`);
        else if (f.sensitive) issue(['alerting', tpl], `{{value.${ref.key}}}: sensitive fields cannot be sent in alerts`);
      }
    }
  }
}

/** True when a variant sends Basic auth credentials. */
export function specUsesBasicAuth(spec: Pick<DeviceCheckSpec, 'variants'>): boolean {
  return spec.variants.some((v) => v.request.auth === 'basic');
}

/**
 * A full rule spec. Output: the validated spec with match.requireMac forced
 * to true when a variant uses Basic auth (credentials are only sent to a
 * device whose MAC was verified).
 */
export const deviceCheckSpecSchema = specObjectSchema
  .superRefine(checkSpec)
  .transform((s): DeviceCheckSpec => {
    const spec = s as DeviceCheckSpec;
    if (specUsesBasicAuth(spec) && !spec.match.requireMac) {
      return { ...spec, match: { ...spec.match, requireMac: true } };
    }
    return spec;
  });

// ── Rule API bodies ──────────────────────────────────────────────────────────

const ruleName = label(128);
const description = z.string().max(2000)
  .refine((s) => !CONTROL_EXCEPT_NEWLINES_RE.test(s), 'Control characters are not allowed')
  .nullable().optional()
  .transform((v) => (v === undefined ? undefined : (v?.trim() || null)));
const PRESET_KEY_RE = /^[a-z][a-zA-Z0-9]{0,31}(\.[a-zA-Z][a-zA-Z0-9]{0,31}){0,3}$/;
const presetKey = z.string().max(64).regex(PRESET_KEY_RE, 'Invalid preset key');
const presetVersion = z.number().int().min(1).max(100_000);

const oneScope = (v: { groupId?: number | null; siteId?: number | null }) => !(v.groupId != null && v.siteId != null);
const oneScopeIssue = { message: 'A rule is scoped to a group or to a site, not both', path: ['siteId'] };

export const createRuleSchema = z.object({
  name: ruleName,
  description,
  groupId: dbId.nullable().optional(),
  siteId: dbId.nullable().optional(),
  presetKey: presetKey.nullable().optional(),
  presetVersion: presetVersion.nullable().optional(),
  spec: deviceCheckSpecSchema,
}).strict().refine(oneScope, oneScopeIssue);

export const updateRuleSchema = z.object({
  name: ruleName.optional(),
  description,
  groupId: dbId.nullable().optional(),
  siteId: dbId.nullable().optional(),
  presetKey: presetKey.nullable().optional(),
  presetVersion: presetVersion.nullable().optional(),
  spec: deviceCheckSpecSchema.optional(),
}).strict().refine(oneScope, oneScopeIssue);

// RFC 7617: the user-id of Basic auth cannot contain a colon.
const credentialUsername = z.string().min(1, 'Required').max(128)
  .refine((s) => !CONTROL_RE.test(s), 'Control characters are not allowed')
  .refine((s) => !s.includes(':'), 'A Basic auth username cannot contain ":"');
const credentialPassword = z.string().min(1, 'Required').max(256)
  .refine((s) => !CONTROL_RE.test(s), 'Control characters are not allowed');

export const credentialsSchema = z.object({
  siteId: dbId.nullable().optional(),
  username: credentialUsername,
  password: credentialPassword,
}).strict();

export const testSchema = z.object({
  spec: deviceCheckSpecSchema,
  ruleId: dbId.nullable().optional(),
  siteItemId: dbId,
  // Inline credentials are sent to the probe for this run only, never stored.
  credentials: z.union([
    z.literal('stored'),
    z.object({ username: credentialUsername, password: credentialPassword }).strict(),
  ]).optional(),
}).strict();

export const previewSchema = z.object({
  match: deviceCheckMatchSchema,
  groupId: dbId.nullable().optional(),
  siteId: dbId.nullable().optional(),
}).strict().refine(oneScope, oneScopeIssue);

// POST /validate only reads `spec` (validated with deviceCheckSpecSchema by
// the controller, issues returned with a 200); other keys the editor may send
// along (ruleId, scope) are ignored.
export const validateSpecSchema = z.object({ spec: z.unknown() });

// ── Platform policy (app_config device_checks_policy) ───────────────────────

export const deviceChecksPolicySchema = z.object({
  allowedPorts: z.array(z.number().int().min(1).max(65535)).min(1).max(32)
    .refine((a) => new Set(a).size === a.length, 'Duplicate port'),
  maxTargetsPerProbe: z.number().int().min(1).max(L.maxTargetsPerProbe),
  minIntervalSeconds: z.number().int().min(L.minIntervalSeconds).max(L.maxIntervalSeconds),
  eventRetentionDays: z.number().int().min(1).max(3650),
  valueEventRetentionDays: z.number().int().min(1).max(365),
}).strict().partial();

// ── Probe → server ───────────────────────────────────────────────────────────

/** Caps a string instead of refusing it (probe data: keep the result, bound the size). */
function cappedString(max: number) {
  return z.string().transform((s) => (s.length > max ? s.slice(0, max) : s));
}

function boundedRecord<T extends z.ZodTypeAny>(value: T, maxKeys: number) {
  return z.record(z.string().max(64), value)
    .refine((o) => Object.keys(o).length <= maxKeys, `At most ${maxKeys} entries`);
}

const PROBE_CHECK_ERROR_CODES = [
  'timeout', 'conn_refused', 'unreachable', 'tls', 'http_status', 'mac_mismatch', 'mac_unverified',
  'target_not_allowed', 'extract_failed', 'regex_compile', 'overrun', 'credentials_unavailable',
  'insecure_transport', 'policy_denied', 'internal',
] as const satisfies readonly ProbeCheckErrorCode[];

const isoDate = z.string().max(40).refine((s) => Number.isFinite(Date.parse(s)), 'Invalid date');

const checkValueSchema = z.union([cappedString(1024), z.number().finite(), z.boolean(), z.null()]);

const traceStepSchema = z.object({
  step: cappedString(64),
  status: z.enum(['ok', 'failed', 'skipped']).catch('failed'),
  ms: z.number().finite().catch(0).transform((n) => Math.max(0, Math.min(Math.round(n), 600_000))),
  detail: cappedString(300).optional().catch(undefined),
});

/** One ProbeCheckResult (check_results batches, check_test_result replies). */
export const probeCheckResultSchema = z.object({
  ruleId: z.number().int().min(0).max(INT4_MAX),
  ruleRev: z.number().int().min(0).max(INT4_MAX),
  itemId: z.number().int().min(1).max(INT4_MAX),
  ip: z.string().max(45),
  variantId: z.string().max(32).nullable().optional().transform((v) => v ?? null),
  startedAt: isoDate,
  durationMs: z.number().finite().catch(0).transform((n) => Math.max(0, Math.min(Math.round(n), 600_000))),
  status: z.enum(['ok', 'error']),
  attempts: z.number().int().min(0).max(1000).catch(0),
  httpStatus: z.number().int().min(0).max(999).optional().catch(undefined),
  bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional().catch(undefined),
  truncated: z.boolean().optional().catch(undefined),
  macCheck: z.enum(['match', 'unverified']).catch('unverified'),
  values: boundedRecord(checkValueSchema, 64).nullable().optional().transform((v) => v ?? {}),
  regex: boundedRecord(z.boolean().nullable(), 64).nullable().optional().transform((v) => v ?? {}),
  error: z.object({
    code: z.enum(PROBE_CHECK_ERROR_CODES).catch('internal'),
    message: cappedString(500).catch(''),
  }).nullable().optional().transform((v) => v ?? undefined),
  trace: z.array(traceStepSchema).max(64).nullable().optional().transform((v) => v ?? undefined),
  // check_test only (redacted by the probe); never stored.
  bodySnippet: cappedString(8192).optional().catch(undefined),
});

export type ParsedProbeCheckResult = z.infer<typeof probeCheckResultSchema>;

/**
 * POST /api/probe/check-results body and the WS check_results message (which
 * also carries `type`, stripped here like any unknown key).
 */
export const probeCheckResultsBatchSchema = z.object({
  v: z.literal(1),
  sentAt: isoDate,
  results: z.array(probeCheckResultSchema).max(L.maxResultsPerBatch),
});

export type ParsedProbeCheckResultsBatch = z.infer<typeof probeCheckResultsBatchSchema>;

/** WS hello: {type:'hello', probeVersion, capabilities, serverScheme}. Informational fields never fail it. */
export const helloSchema = z.object({
  probeVersion: z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/).nullable().optional().catch(null)
    .transform((v) => v ?? null),
  // Well-formed "name:version" strings, deduplicated, at most 16.
  capabilities: z.unknown().transform((v) => filterProbeCapabilities(v) ?? []),
  serverScheme: z.unknown().transform((v): 'http' | 'https' | null => {
    const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
    return s === 'http' || s === 'https' ? s : null;
  }),
});

export type ProbeHello = z.infer<typeof helloSchema>;

// ── Types ────────────────────────────────────────────────────────────────────

export type CreateRuleInput = z.infer<typeof createRuleSchema>;
export type UpdateRuleInput = z.infer<typeof updateRuleSchema>;
export type CredentialsInput = z.infer<typeof credentialsSchema>;
export type TestInput = z.infer<typeof testSchema>;
export type PreviewInput = z.infer<typeof previewSchema>;
export type DeviceChecksPolicyInput = z.infer<typeof deviceChecksPolicySchema>;
