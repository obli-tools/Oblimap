import { neutralizeMentions } from './html';

// Alert title / message templates of Device Checks rules.
//
// Substitution only: `{{name}}` tokens from a fixed allowlist are replaced,
// nothing is evaluated (no expressions, no filters, no nested lookups). The
// substituted values come from devices (titles, hostnames) and upstream
// stream metadata, so every value is flattened to one short line of plain
// text: control and bidi-override characters stripped, whitespace collapsed,
// truncated to 200 characters, @everyone / @here mass mentions defused.
// Channel plugins escape the result for their own format (HTML for SMTP and
// Telegram, ...).

/** Variables every template may use, besides {{value.<fieldKey>}}. */
export const TEMPLATE_VARIABLES = [
  'rule', 'site', 'device', 'ip', 'mac', 'status', 'failedAssertion', 'error', 'since',
] as const;

export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

/** Longest substituted value, in characters. */
export const TEMPLATE_VALUE_MAX = 200;
/** Longest rendered template (a 300-character template + substitutions). */
export const TEMPLATE_OUTPUT_MAX = 1000;

export interface TemplateVars extends Partial<Record<TemplateVariable, string | number | boolean | null | undefined>> {
  /**
   * Field values for {{value.<key>}}. Pass the NON-SENSITIVE values only: a
   * key that is absent renders as an empty string.
   */
  values?: Record<string, string | number | boolean | null | undefined>;
}

// {{ name }} — the name is validated separately (allowlist), so the token
// pattern stays permissive enough to find every mistyped variable.
const TOKEN_RE = /\{\{\s*([^{}\s]{1,80})\s*\}\}/g;
const VALUE_VAR_RE = /^value\.([a-zA-Z][a-zA-Z0-9_]{0,31})$/;

function hex4(n: number): string {
  return n.toString(16).padStart(4, '0');
}

/**
 * Code point ranges never kept in device-supplied text: C0 / C1 controls,
 * zero-width and bidi formatting characters (used to disguise text), line /
 * paragraph separators and the BOM.
 */
export const UNSAFE_TEXT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff],
];

/** A fresh global RegExp matching runs of UNSAFE_TEXT_RANGES characters. */
export function unsafeTextRegExp(): RegExp {
  return new RegExp(`[${UNSAFE_TEXT_RANGES.map(([a, b]) => `\\u${hex4(a)}-\\u${hex4(b)}`).join('')}]+`, 'g');
}

const UNSAFE_CHARS_RE = unsafeTextRegExp();

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * One substituted value as plain, single-line, bounded text. null /
 * undefined → ''. Objects are never expected; they render as ''.
 */
export function sanitizeTemplateValue(value: unknown, max = TEMPLATE_VALUE_MAX): string {
  if (value === null || value === undefined) return '';
  let s: string;
  if (typeof value === 'string') s = value;
  else if (typeof value === 'number') s = Number.isFinite(value) ? String(value) : '';
  else if (typeof value === 'boolean') s = String(value);
  else return '';
  s = s.replace(UNSAFE_CHARS_RE, ' ').replace(/\s+/g, ' ').trim();
  return neutralizeMentions(truncate(s, max));
}

export type TemplateReference =
  | { kind: 'var'; name: TemplateVariable }
  | { kind: 'value'; key: string }
  | { kind: 'unknown'; name: string };

/** Every {{…}} token of `tpl`, classified (for rule validation). */
export function templateReferences(tpl: string): TemplateReference[] {
  const out: TemplateReference[] = [];
  for (const m of tpl.matchAll(TOKEN_RE)) {
    const name = m[1];
    if ((TEMPLATE_VARIABLES as readonly string[]).includes(name)) {
      out.push({ kind: 'var', name: name as TemplateVariable });
      continue;
    }
    const v = VALUE_VAR_RE.exec(name);
    if (v) out.push({ kind: 'value', key: v[1] });
    else out.push({ kind: 'unknown', name });
  }
  return out;
}

/**
 * Renders `tpl`: allowlisted tokens are replaced by their sanitised value
 * ('' when not provided), anything else is left as written. The template
 * text itself (admin input) keeps its wording but loses its control
 * characters; whitespace is collapsed and the output bounded. Mass mentions
 * are defused once more on the whole output: adjacent values ('@' + 'everyone')
 * or a template '@' followed by a value must not assemble one.
 */
export function renderTemplate(tpl: string, vars: TemplateVars): string {
  if (typeof tpl !== 'string' || tpl === '') return '';
  // The template is cleaned BEFORE substitution: the zero-width space that
  // neutralizeMentions puts into values must survive.
  const cleanTpl = tpl.replace(UNSAFE_CHARS_RE, ' ');
  const rendered = cleanTpl.replace(TOKEN_RE, (token: string, name: string) => {
    if ((TEMPLATE_VARIABLES as readonly string[]).includes(name)) {
      return sanitizeTemplateValue(vars[name as TemplateVariable]);
    }
    const v = VALUE_VAR_RE.exec(name);
    if (v) {
      const values = vars.values ?? {};
      return Object.prototype.hasOwnProperty.call(values, v[1]) ? sanitizeTemplateValue(values[v[1]]) : '';
    }
    return token;
  });
  // Neutralised before truncation, so the output stays within the bound (a
  // prefix of a neutralised text cannot form a mention again).
  return truncate(neutralizeMentions(rendered.replace(/\s+/g, ' ').trim()), TEMPLATE_OUTPUT_MAX);
}
