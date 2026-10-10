import { z } from 'zod';
import { DEVICE_TYPES } from '@oblimap/shared';

// Vendor → device-type rules. A pattern matches a vendor name by
// case-insensitive substring: an empty (or one-letter) pattern would classify
// nearly every new device of the tenant.

/**
 * Every DeviceType: the shared DEVICE_TYPES list (exhaustiveness guarded at
 * compile time in shared/src/ipamTypes.ts). Kept under this name for the
 * validators that import it (site, device checks).
 */
export const VENDOR_RULE_DEVICE_TYPES = DEVICE_TYPES;

const vendorPattern = z.string().trim().min(2, 'vendorPattern must be at least 2 characters').max(128);
const deviceType = z.enum(VENDOR_RULE_DEVICE_TYPES);
// '' clears the label (stored as NULL).
const label = z.string().trim().max(64).nullable().optional()
  .transform((v) => (v === undefined ? undefined : v || null));
const priority = z.number().int().min(-1000).max(1000);

export const createVendorRuleSchema = z.object({
  vendorPattern,
  deviceType,
  label,
  priority: priority.optional(),
  groupId: z.number().int().positive().max(2_147_483_647).nullable().optional(),
});

export const updateVendorRuleSchema = z.object({
  vendorPattern: vendorPattern.optional(),
  deviceType: deviceType.optional(),
  label,
  priority: priority.optional(),
});

/** POST /vendor-rules/bulk ("Auto rules"): tenant-wide rules, existing patterns skipped. */
export const bulkCreateVendorRulesSchema = z.object({
  rules: z.array(z.object({
    vendorPattern,
    deviceType,
    label,
    priority: priority.optional(),
  }).strict()).min(1).max(200),
}).strict();

export type CreateVendorRuleInput = z.infer<typeof createVendorRuleSchema>;
export type BulkCreateVendorRulesInput = z.infer<typeof bulkCreateVendorRulesSchema>;
export type UpdateVendorRuleInput = z.infer<typeof updateVendorRuleSchema>;
