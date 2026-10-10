import apiClient from './client';
import type { VendorTypeRule, DeviceType, ObservedVendor } from '@oblimap/shared';
import type { AxiosResponse } from 'axios';

export interface VendorRuleCreate {
  vendorPattern: string;
  deviceType: DeviceType;
  label?: string | null;
  priority?: number;
  groupId?: number | null;
}

/** Scope of a re-apply: the whole tenant (full access), a group (and sub-groups) or a site. */
export type VendorRuleReapplyScope =
  | { scope: 'tenant' }
  | { scope: 'group'; id: number }
  | { scope: 'site'; id: number };

export interface VendorRuleReapplyResult {
  /** Devices re-typed. */
  updated: number;
  /** Devices examined (vendor known, type not set by hand). */
  scanned: number;
}

export const vendorRulesApi = {
  list: (groupId?: number): Promise<{ rules: VendorTypeRule[] }> =>
    apiClient
      .get('/vendor-rules', { params: groupId !== undefined ? { groupId } : undefined })
      .then((r: AxiosResponse) => r.data as { rules: VendorTypeRule[] }),

  create: (data: VendorRuleCreate): Promise<{ rule: VendorTypeRule }> =>
    apiClient.post('/vendor-rules', data).then((r: AxiosResponse) => r.data as { rule: VendorTypeRule }),

  update: (
    id: number,
    data: Partial<Pick<VendorTypeRule, 'vendorPattern' | 'deviceType' | 'label' | 'priority'>>,
  ): Promise<{ rule: VendorTypeRule }> =>
    apiClient.patch(`/vendor-rules/${id}`, data).then((r: AxiosResponse) => r.data as { rule: VendorTypeRule }),

  remove: (id: number): Promise<void> =>
    apiClient.delete(`/vendor-rules/${id}`).then(() => undefined),

  /** Vendor names of the devices of the readable sites, most frequent first. */
  observedVendors: (): Promise<{ vendors: ObservedVendor[] }> =>
    apiClient.get('/vendor-rules/observed-vendors').then((r: AxiosResponse) => r.data as { vendors: ObservedVendor[] }),

  /** "Auto rules": tenant-wide rules created in one go (patterns already used are skipped). */
  bulkCreate: (rules: Array<Omit<VendorRuleCreate, 'groupId'>>): Promise<{ rules: VendorTypeRule[]; skipped: number }> =>
    apiClient.post('/vendor-rules/bulk', { rules }).then((r: AxiosResponse) => r.data as { rules: VendorTypeRule[]; skipped: number }),

  /** Re-classifies the existing devices of the scope (never those typed by hand). */
  reapply: (target: VendorRuleReapplyScope): Promise<VendorRuleReapplyResult> =>
    apiClient.post('/vendor-rules/reapply', target).then((r: AxiosResponse) => r.data as VendorRuleReapplyResult),
};
