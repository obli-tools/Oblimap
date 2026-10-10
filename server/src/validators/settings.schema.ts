import { z } from 'zod';
import { SETTINGS_DEFINITIONS, SETTINGS_KEYS, SCAN_SUBNET_MIN_PREFIX } from '@oblimap/shared';

const settingsKeyValues = Object.values(SETTINGS_KEYS) as [string, ...string[]];

// Shape only: settingsService.normalizeSettingValue() validates the value
// against its key (CIDRs, ports, ranges, businessHours).
const settingValue = z.union([
  z.number(),
  z.boolean(),
  z.string().max(16_384),
  z.array(z.union([z.string().max(1024), z.number()])).max(1024),
  // businessHours: { tz?, days?, closedDates? } (also accepted as a JSON string)
  z.record(z.string(), z.unknown()),
]);

/** Entries of a subnet list value as given (array, JSON array text, or a separated string). */
function subnetEntries(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  const s = value.trim();
  if (s.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(s);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return []; // malformed: refused by settingsService.normalizeSettingValue
    }
  }
  return s.split(/[\s,;]+/).filter(Boolean);
}

/**
 * Index of the first extraSubnets entry wider than SCAN_SUBNET_MIN_PREFIX
 * (e.g. 10.0.0.0/8), or -1. The probe cannot sweep such a network host by
 * host; it would be skipped silently. Excluded subnets may stay wide
 * (excluding 10.0.0.0/8 is legitimate). Malformed entries are left to the
 * settings service, which refuses them with its own message.
 */
export function firstTooWideSubnet(value: unknown): number {
  const entries = subnetEntries(value);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (typeof entry !== 'string') continue;
    const m = /\/(\d{1,2})$/.exec(entry.trim());
    if (m && Number(m[1]) < SCAN_SUBNET_MIN_PREFIX) return i;
  }
  return -1;
}

function refuseWideSubnets(v: { key: string; value: unknown }, ctx: z.RefinementCtx, path: (string | number)[]): void {
  if (v.key !== 'extraSubnets') return;
  const i = firstTooWideSubnet(v.value);
  if (i >= 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'subnet_too_wide', path: [...path, 'value', i] });
}

/**
 * 'select' settings (probeUpdatePolicy) take one of their definition's
 * options; anything else is refused with 'invalid_option'.
 */
export function invalidSelectValue(key: string, value: unknown): boolean {
  const def = SETTINGS_DEFINITIONS.find((d) => d.key === key);
  if (!def || def.type !== 'select') return false;
  return typeof value !== 'string' || !(def.options ?? []).includes(value);
}

function refuseInvalidOptions(v: { key: string; value: unknown }, ctx: z.RefinementCtx, path: (string | number)[]): void {
  if (invalidSelectValue(v.key, v.value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid_option', path: [...path, 'value'] });
  }
}

export const setSettingSchema = z.object({
  key: z.enum(settingsKeyValues),
  value: settingValue,
}).superRefine((v, ctx) => {
  refuseWideSubnets(v, ctx, []);
  refuseInvalidOptions(v, ctx, []);
});

export const setSettingsBulkSchema = z.object({
  overrides: z.array(
    z.object({
      key: z.enum(settingsKeyValues),
      value: settingValue,
    }),
  ).max(100),
}).superRefine((v, ctx) => {
  v.overrides.forEach((o, i) => {
    refuseWideSubnets(o, ctx, ['overrides', i]);
    refuseInvalidOptions(o, ctx, ['overrides', i]);
  });
});

export const deleteSettingSchema = z.object({
  key: z.enum(settingsKeyValues),
});

export type SetSettingInput = z.infer<typeof setSettingSchema>;
export type SetSettingsBulkInput = z.infer<typeof setSettingsBulkSchema>;
export type DeleteSettingInput = z.infer<typeof deleteSettingSchema>;
