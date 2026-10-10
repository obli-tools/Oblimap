import { useEffect, useRef } from 'react';
import { getSocket } from '../socket/socketClient';
import { useGroupStore } from '../store/groupStore';
import { useAuthStore } from '../store/authStore';
import { useLiveAlertsStore } from '../store/liveAlertsStore';
import { useTenantStore } from '../store/tenantStore';
import { SOCKET_EVENTS } from '@oblimap/shared';
import type { MonitorGroup, LiveAlertData } from '@oblimap/shared';

/** Dispatch a sound notification to the native desktop app overlay. */
function notifyNative(type: 'probe_down' | 'probe_up' | 'agent_alert' | 'agent_fixed') {
  window.dispatchEvent(new CustomEvent('oblimap:notify', { detail: { type } }));
}

/**
 * Fired on window after a socket REconnect: events emitted while the socket
 * was down are lost, page loaders (useIpamLiveRefresh…) re-read their data.
 */
export const RESYNC_EVENT = 'oblimap:resync';

export function useSocket() {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const { addGroup, updateGroup, removeGroup } = useGroupStore();

  // Track previous agent statuses to detect transitions (alert↔ok) for native sounds.
  const agentStatusRef = useRef<Map<number, string>>(new Map());

  const isNativeApp = typeof window !== 'undefined' && !!(window as Window & { __oblimap_is_native_app?: boolean }).__oblimap_is_native_app;

  useEffect(() => {
    if (userId === null) return;

    const socket = getSocket();
    if (!socket) return;

    // Every handler is kept by reference and removed with it: socket.off(event)
    // without a handler would also drop the listeners of other components
    // (useIpamLiveRefresh, GroupTree…).

    // ── Live alert (NOTIFICATION_NEW) ─────────────────────────────────────────
    const onNotificationNew = (alert: LiveAlertData) => {
      useLiveAlertsStore.getState().addAlertFromServer(alert);
    };

    // ── Group events (admin room: full payloads) ──────────────────────────────
    // The tree itself is refetched once, on the TREE_CHANGED the server always
    // sends right after each of these (groups.controller emitGroupEvent).
    const onGroupCreated = (data: { group: MonitorGroup }) => {
      addGroup(data.group);
    };
    const onGroupUpdated = (data: { group: MonitorGroup }) => {
      updateGroup(data.group.id, data.group);
    };
    const onGroupDeleted = (data: { groupId: number }) => {
      removeGroup(data.groupId);
    };
    const onGroupMoved = (data: { group: MonitorGroup }) => {
      updateGroup(data.group.id, data.group);
    };
    // Payload-free tree change (every member: the server filters the tree)
    // and sibling order change.
    const onTreeChanged = () => {
      void useGroupStore.getState().fetchTree();
    };

    // ── Permissions changed (user:<id>, payload-free) ─────────────────────────
    // A team grant, the tenant role or its permission set changed: refetch
    // the permissions (capabilities, write access), the tenant list (the
    // tenant-admin status reads its role) and the filtered tree.
    const onPermissionsChanged = () => {
      void Promise.allSettled([
        useTenantStore.getState().fetchTenants(),
        useAuthStore.getState().refreshPermissions(),
      ]).then(() => useGroupStore.getState().fetchTree());
    };

    // ── Probe status — native sounds ──────────────────────────────────────────
    const onProbeStatusChanged = (data: { probeId: number; status: string }) => {
      const prev = agentStatusRef.current.get(data.probeId);

      if (isNativeApp) {
        // Probe went offline → alert sound
        if (data.status === 'offline' && prev !== 'offline') {
          notifyNative('probe_down');
        }
        // Probe recovered (was offline, now sending data again)
        else if (prev === 'offline' && data.status !== 'offline') {
          notifyNative('probe_up');
        }
      }

      agentStatusRef.current.set(data.probeId, data.status);
    };

    // ── Reconnect resync ──────────────────────────────────────────────────────
    // Events emitted while the socket was down (sleep, network cut) are lost:
    // on every REconnect re-read the live alerts and the tree, and tell the
    // pages to reload their data. The first connect is covered by the
    // initial loads.
    let hadConnected = socket.connected;
    const onConnect = () => {
      if (hadConnected) {
        void useLiveAlertsStore.getState().fetchAlerts();
        void useGroupStore.getState().fetchTree();
        window.dispatchEvent(new Event(RESYNC_EVENT));
      }
      hadConnected = true;
    };

    socket.on(SOCKET_EVENTS.NOTIFICATION_NEW, onNotificationNew);
    socket.on(SOCKET_EVENTS.GROUP_CREATED, onGroupCreated);
    socket.on(SOCKET_EVENTS.GROUP_UPDATED, onGroupUpdated);
    socket.on(SOCKET_EVENTS.GROUP_DELETED, onGroupDeleted);
    socket.on(SOCKET_EVENTS.GROUP_MOVED, onGroupMoved);
    socket.on(SOCKET_EVENTS.GROUP_REORDERED, onTreeChanged);
    socket.on(SOCKET_EVENTS.TREE_CHANGED, onTreeChanged);
    socket.on(SOCKET_EVENTS.PROBE_STATUS_CHANGED, onProbeStatusChanged);
    socket.on(SOCKET_EVENTS.PERMISSIONS_CHANGED, onPermissionsChanged);
    socket.on('connect', onConnect);

    return () => {
      socket.off(SOCKET_EVENTS.NOTIFICATION_NEW, onNotificationNew);
      socket.off(SOCKET_EVENTS.GROUP_CREATED, onGroupCreated);
      socket.off(SOCKET_EVENTS.GROUP_UPDATED, onGroupUpdated);
      socket.off(SOCKET_EVENTS.GROUP_DELETED, onGroupDeleted);
      socket.off(SOCKET_EVENTS.GROUP_MOVED, onGroupMoved);
      socket.off(SOCKET_EVENTS.GROUP_REORDERED, onTreeChanged);
      socket.off(SOCKET_EVENTS.TREE_CHANGED, onTreeChanged);
      socket.off(SOCKET_EVENTS.PROBE_STATUS_CHANGED, onProbeStatusChanged);
      socket.off(SOCKET_EVENTS.PERMISSIONS_CHANGED, onPermissionsChanged);
      socket.off('connect', onConnect);
    };
  }, [userId, addGroup, updateGroup, removeGroup, isNativeApp]);
}
