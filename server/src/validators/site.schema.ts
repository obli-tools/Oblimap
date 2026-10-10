import { z } from 'zod';
import { ITEM_ALERT_MODES } from '@oblimap/shared';
import { VENDOR_RULE_DEVICE_TYPES } from './vendorRule.schema';
import { isIPv4, normalizeMacAddress } from './probe.schema';

// Site, manual device and IP reservation payloads.
// Column sizes: sites.name varchar(128), site_items.custom_name varchar(255),
// site_items.mac varchar(17), ip_reservations.name varchar(128).

const dbIdSchema = z.number().int().positive().max(2_147_483_647);

/** Every DeviceType (the shared union, compile-time checked in vendorRule.schema). */
const deviceTypeSchema = z.enum(VENDOR_RULE_DEVICE_TYPES);

export const SITE_ITEM_STATUSES = ['online', 'offline', 'reserved', 'unknown'] as const;

/** Optional nullable text: '' (after trim) is stored as NULL. */
function optionalText(max: number) {
  return z.string().trim().max(max).nullable().optional()
    .transform((v) => (v === undefined ? undefined : v || null));
}

/** Dotted-quad IPv4 (no leading zeros, what the probe reports). */
const ipv4Schema = z.string().trim().max(15).refine(isIPv4, 'Invalid IPv4 address');

/** "aa-bb-cc-dd-ee-ff" / "AA:BB:..." → "AA:BB:CC:DD:EE:FF" (probe format); '' / null → null. */
const macSchema = z.string().max(32).nullable().optional().transform((v, ctx) => {
  if (v === undefined) return undefined;
  if (v === null || v.trim() === '') return null;
  const mac = normalizeMacAddress(v);
  if (!mac) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid MAC address (expected AA:BB:CC:DD:EE:FF)' });
    return z.NEVER;
  }
  return mac;
});

// ── Sites ────────────────────────────────────────────────────────────────────

export const createSiteSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(128),
  description: optionalText(2000),
  // Must be a group of the current tenant (checked by siteService).
  groupId: dbIdSchema.nullable().optional(),
});

export const updateSiteSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(128).optional(),
  description: optionalText(2000),
  groupId: dbIdSchema.nullable().optional(),
});

// ── Manual devices ───────────────────────────────────────────────────────────

export const createSiteItemSchema = z.object({
  ip: ipv4Schema,
  mac: macSchema,
  customName: optionalText(255),
  deviceType: deviceTypeSchema.optional(),
  notes: optionalText(10_000),
});

export const updateSiteItemSchema = z.object({
  customName: optionalText(255),
  deviceType: deviceTypeSchema.optional(),
  notes: optionalText(10_000),
  status: z.enum(SITE_ITEM_STATUSES).optional(),
  // Offline / back-online alerts of the device (migration 052).
  alertMode: z.enum(ITEM_ALERT_MODES).optional(),
});

// ── IP reservations ──────────────────────────────────────────────────────────

// reservedMac: the device the IP is reserved for (holding it is no conflict);
// itemId: the site item it is reserved for — must be an item of the same site
// and tenant (checked by siteService). null clears either one.
export const createReservationSchema = z.object({
  ip: ipv4Schema,
  name: z.string().trim().min(1, 'Name is required').max(128),
  description: optionalText(2000),
  deviceType: deviceTypeSchema.nullable().optional(),
  reservedMac: macSchema,
  itemId: dbIdSchema.nullable().optional(),
});

export const updateReservationSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(128).optional(),
  description: optionalText(2000),
  deviceType: deviceTypeSchema.nullable().optional(),
  reservedMac: macSchema,
  itemId: dbIdSchema.nullable().optional(),
});

// ── Query strings ────────────────────────────────────────────────────────────

export const FLOW_PERIODS = ['1h', '24h', '30d', '1y'] as const;

export type CreateSiteInput = z.infer<typeof createSiteSchema>;
export type UpdateSiteInput = z.infer<typeof updateSiteSchema>;
export type CreateSiteItemInput = z.infer<typeof createSiteItemSchema>;
export type UpdateSiteItemInput = z.infer<typeof updateSiteItemSchema>;
export type CreateReservationInput = z.infer<typeof createReservationSchema>;
export type UpdateReservationInput = z.infer<typeof updateReservationSchema>;
