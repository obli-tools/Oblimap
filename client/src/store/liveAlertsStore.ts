import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { LiveAlertData, LiveAlertKind, LiveAlertParams } from '@oblimap/shared';
import apiClient from '../api/client';

export type AlertSeverity = 'down' | 'up' | 'warning' | 'info';

/**
 * Client-side alert object. Mirrors LiveAlertData but adds ephemeral UI state.
 * kind / params (structured alerts, migration 052) are normalized: null when
 * absent or malformed. Render the text with utils/alertText renderAlert /
 * useAlertText, never alert.title / alert.message directly (translation and
 * anonymous mode).
 */
export interface LiveAlert extends LiveAlertData {
  kind: LiveAlertKind | string | null;
  params: LiveAlertParams | null;
  /** True when the toast popup was dismissed (auto-timer or X button). Ephemeral — resets on reload. */
  toastDismissed: boolean;
}

// ─── Persistent preferences (localStorage) ───────────────────────────────────

interface AlertPrefs {
  /** Show toast popups for the current tenant's alerts */
  localEnabled: boolean;
  /** Show toast popups for other tenants' alerts (visible only when user has multiple tenants) */
  multiTenantEnabled: boolean;
  position: 'top-center' | 'bottom-right';
  /**
   * Hide resolved alerts (device / probe back online) — the default. When
   * off, they stay listed, greyed with a "resolved" pill.
   */
  hideResolved: boolean;
}

// ─── Full store state ─────────────────────────────────────────────────────────

interface LiveAlertsState extends AlertPrefs {
  alerts: LiveAlert[];

  // ── Preferences ──────────────────────────────────────────────────────────────
  setLocalEnabled: (v: boolean) => void;
  setMultiTenantEnabled: (v: boolean) => void;
  setPosition: (p: 'top-center' | 'bottom-right') => void;
  /** Backward-compat alias used by authStore (reads user.preferences.toastEnabled) */
  setEnabled: (v: boolean) => void;
  /** Hide (default) or show resolved alerts; showing them reloads the list. */
  setHideResolved: (v: boolean) => void;

  // ── Server sync ───────────────────────────────────────────────────────────────
  /** Fetch all alerts (all accessible tenants) from the server and replace local state. */
  fetchAlerts: () => Promise<void>;
  /**
   * Add a single alert received via socket (NOTIFICATION_NEW), or update the
   * one already listed with the same id (the server re-sends an alert when it
   * is resolved).
   */
  addAlertFromServer: (alert: LiveAlertData) => void;

  // ── Actions ───────────────────────────────────────────────────────────────────
  /** Dismiss the toast popup for one alert (keeps it in the bell, does NOT mark as read). */
  dismissToast: (id: number) => void;
  /** Mark one alert as read (server + local). Also dismisses the toast. */
  markAlertRead: (id: number) => Promise<void>;
  /**
   * Mark all current-tenant alerts as read ('settings' tenant capability on
   * the server). Nothing changes locally unless the server applied it; the
   * result is the server's answer (callers tell the user about a refusal).
   */
  markAllRead: () => Promise<LiveAlertActionResult>;
  /** Delete one alert ('settings' in the alert's tenant); removed locally once it succeeded. */
  removeAlert: (id: number) => Promise<LiveAlertActionResult>;
  /** Clear all alerts of the current tenant ('settings'); the list is reloaded once it succeeded. */
  clearAll: () => Promise<LiveAlertActionResult>;
}

/** Outcome of a live alert action that the server may refuse. */
export type LiveAlertActionResult = { ok: true } | { ok: false; status: number | null };

function refused(err: unknown): LiveAlertActionResult {
  const status = (err as { response?: { status?: number } } | null)?.response?.status;
  return { ok: false, status: typeof status === 'number' ? status : null };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** The problem the alert reported is over. */
export function isResolved(alert: Pick<LiveAlertData, 'resolvedAt'>): boolean {
  return !!alert.resolvedAt;
}

/**
 * Params of a structured alert kept only when they are a flat object of
 * strings / numbers / nulls (renderAlert falls back to the stored text
 * otherwise).
 */
function normalizeParams(params: unknown): LiveAlertParams | null {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  const out: LiveAlertParams = {};
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (value === null || typeof value === 'string' || typeof value === 'number') out[key] = value;
  }
  return out;
}

function toLocalAlert(data: LiveAlertData, toastDismissed = false): LiveAlert {
  return {
    ...data,
    kind: typeof data.kind === 'string' && data.kind ? data.kind : null,
    params: normalizeParams(data.params),
    toastDismissed,
  };
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useLiveAlertsStore = create<LiveAlertsState>()(
  persist(
    (set, get) => ({
      // Default preferences
      localEnabled: true,
      multiTenantEnabled: true,
      position: 'bottom-right',
      hideResolved: true,

      alerts: [],

      // ── Preferences ────────────────────────────────────────────────────────
      setLocalEnabled: (v) => set({ localEnabled: v }),
      setMultiTenantEnabled: (v) => set({ multiTenantEnabled: v }),
      setPosition: (p) => set({ position: p }),
      setEnabled: (v) => set({ localEnabled: v }),
      setHideResolved: (v) => {
        if (v) {
          set((s) => ({ hideResolved: true, alerts: s.alerts.filter((a) => !isResolved(a)) }));
          return;
        }
        set({ hideResolved: false });
        void get().fetchAlerts();
      },

      // ── Server sync ────────────────────────────────────────────────────────
      fetchAlerts: async () => {
        try {
          const res = await apiClient.get<{ alerts: LiveAlertData[] }>('/live-alerts/all', {
            params: get().hideResolved ? undefined : { includeResolved: 1 },
          });
          const known = new Map(get().alerts.map((a) => [a.id, a.toastDismissed]));
          const hide = get().hideResolved;
          set({
            alerts: (res.data.alerts ?? [])
              .filter((a) => !(hide && isResolved(a)))
              .map((a) => toLocalAlert(a, known.get(a.id) ?? false)),
          });
        } catch {
          // Ignore network errors (user may not be logged in yet)
        }
      },

      addAlertFromServer: (alert) =>
        set((s) => {
          const hide = s.hideResolved && isResolved(alert);
          const index = s.alerts.findIndex((a) => a.id === alert.id);
          if (index >= 0) {
            if (hide) return { alerts: s.alerts.filter((a) => a.id !== alert.id) };
            const alerts = s.alerts.slice();
            const incoming = toLocalAlert(alert, s.alerts[index].toastDismissed);
            alerts[index] = {
              ...s.alerts[index],
              ...incoming,
              // A resolution payload without kind / params keeps the ones already held.
              kind: incoming.kind ?? s.alerts[index].kind,
              params: incoming.params ?? s.alerts[index].params,
            };
            return { alerts };
          }
          if (hide) return s;
          // A resolution of an alert this client did not list pops no toast.
          return { alerts: [toLocalAlert(alert, isResolved(alert)), ...s.alerts].slice(0, 200) };
        }),

      // ── Actions ────────────────────────────────────────────────────────────
      dismissToast: (id) =>
        set((s) => ({
          alerts: s.alerts.map((a) => a.id === id ? { ...a, toastDismissed: true } : a),
        })),

      markAlertRead: async (id) => {
        // Every member may mark the alerts they see as read: optimistic.
        set((s) => ({
          alerts: s.alerts.map((a) => a.id === id ? { ...a, read: true, toastDismissed: true } : a),
        }));
        try {
          await apiClient.patch(`/live-alerts/${id}/read`);
        } catch {
          await get().fetchAlerts();
        }
      },

      // Mark-all-read, delete and clear take the 'settings' tenant capability
      // on the server (403 otherwise; the read state is shared by the whole
      // tenant and alerts are evidence): nothing changes locally unless the
      // server applied them.
      markAllRead: async () => {
        try {
          await apiClient.post('/live-alerts/read-all');
        } catch (err) {
          return refused(err);
        }
        // The server marked the current tenant's alerts only.
        await get().fetchAlerts();
        return { ok: true };
      },

      removeAlert: async (id) => {
        try {
          await apiClient.delete(`/live-alerts/${id}`);
        } catch (err) {
          return refused(err);
        }
        set((s) => ({ alerts: s.alerts.filter((a) => a.id !== id) }));
        return { ok: true };
      },

      clearAll: async () => {
        try {
          await apiClient.delete('/live-alerts');
        } catch (err) {
          return refused(err);
        }
        // Reload: the other tenants' alerts stay.
        await get().fetchAlerts();
        return { ok: true };
      },
    }),
    {
      name: 'oblimap-alert-prefs',
      // Only persist preferences, NOT the alert list (alerts always fetched fresh from server)
      partialize: (s) => ({
        localEnabled: s.localEnabled,
        multiTenantEnabled: s.multiTenantEnabled,
        position: s.position,
        hideResolved: s.hideResolved,
      }),
    },
  ),
);

// ─── Computed helpers (exported for components) ───────────────────────────────

/** Count of unread, unresolved alerts, optionally filtered to a specific tenant. */
export function countUnread(alerts: LiveAlert[], tenantId?: number | null): number {
  return alerts.filter((a) => !a.read && !isResolved(a) && (tenantId == null || a.tenantId === tenantId)).length;
}
