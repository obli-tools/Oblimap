import { create } from 'zustand';
import type { TenantWithRole } from '@oblimap/shared';
import { useGroupStore } from './groupStore';
import { useAuthStore } from './authStore';
import apiClient from '../api/client';

interface TenantState {
  currentTenantId: number | null;
  tenants: TenantWithRole[];
  isLoading: boolean;
  /**
   * Tenant data version, incremented after every successful switch. Loaders
   * of tenant-scoped data depend on it (useTenantEpoch, useIpamLiveRefresh)
   * and compare it to drop responses of a tenant the user has left meanwhile.
   */
  epoch: number;
  fetchTenants: () => Promise<void>;
  /** Switches the session's tenant. Rejects when the server refuses the switch. */
  setCurrentTenant: (tenantId: number) => Promise<void>;
}

export const useTenantStore = create<TenantState>((set) => ({
  currentTenantId: null,
  tenants: [],
  isLoading: false,
  epoch: 0,

  fetchTenants: async () => {
    try {
      set({ isLoading: true });
      // apiClient, not raw fetch: it carries the ObliTools X-Auth-Token and
      // goes through the account-policy interceptor.
      const res = await apiClient.get<{ data?: TenantWithRole[] }>('/tenants');
      set({ tenants: res.data?.data ?? [], isLoading: false });
    } catch {
      set({ isLoading: false });
    }
  },

  setCurrentTenant: async (tenantId: number) => {
    // A refused switch propagates: the session (and the data on screen) stay
    // on the current tenant, the caller tells the user.
    await apiClient.post('/tenant/switch', { tenantId });
    set((s) => ({ currentTenantId: tenantId, epoch: s.epoch + 1 }));
    // Reload group collapsed state for the new tenant context
    const userId = useAuthStore.getState().user?.id ?? null;
    useGroupStore.getState().reinitForTenant(userId, tenantId);
  },
}));

/** Tenant data version: changes after every successful tenant switch. */
export function useTenantEpoch(): number {
  return useTenantStore((s) => s.epoch);
}
