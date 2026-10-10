import { matchVendorRule as firstMatchingRule, type VendorRuleRow } from './deviceClassification';

// Vendor → device type rules of a whole tenant, matched for one site (pure,
// unit-tested in tests/unit/services/ouiRegistry.test.ts). Same semantics as
// the scan pipeline (probe.service loadVendorRules + deviceClassification
// matchVendorRule):
//  - the rules that apply to a site are the tenant-wide ones (group_id NULL)
//    and those of the site's group and of its ancestor groups (the closure
//    table's ancestors of the site's group, depth 0 included);
//  - they are tried by priority descending, then id ascending;
//  - the first rule whose pattern is a case-insensitive substring of the
//    vendor wins; empty patterns never match.

export interface ScopedVendorRuleRow extends VendorRuleRow {
  id?: unknown;
  group_id?: unknown;
  priority?: unknown;
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The rules applying to a site whose group's ancestors (the group itself
 * included) are `siteGroupAncestors` (null / empty = a site without a
 * group: tenant-wide rules only), in evaluation order.
 */
export function rulesForSite<T extends ScopedVendorRuleRow>(
  rules: readonly T[],
  siteGroupAncestors: Iterable<number> | null | undefined,
): T[] {
  const ancestors = new Set<number>();
  if (siteGroupAncestors) for (const id of siteGroupAncestors) ancestors.add(num(id));
  return rules
    .filter((r) => r.group_id == null || ancestors.has(num(r.group_id)))
    .slice()
    .sort((a, b) => num(b.priority) - num(a.priority) || num(a.id) - num(b.id));
}

/** First matching rule for a device of that site, or null. */
export function matchVendorRule(
  vendor: string | null | undefined,
  rules: readonly ScopedVendorRuleRow[],
  siteGroupAncestors: Iterable<number> | null | undefined,
): { deviceType: string; label: string | null } | null {
  if (!vendor) return null;
  return firstMatchingRule(rulesForSite(rules, siteGroupAncestors), vendor);
}
