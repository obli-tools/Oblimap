/**
 * useIpamLiveRefresh — subscribe to IPAM socket events and call
 * `onRefresh` (debounced) whenever the network state changes.
 *
 * Covers:
 *   - ITEM_STATUS_CHANGED  — device went online/offline
 *   - NEW_DEVICE_DISCOVERED — probe found a new device
 *   - PROBE_STATUS_CHANGED  — probe came online or went offline
 *   - SITE_UPDATED          — site config changed (name, description, group)
 *   - SITE_DELETED          — site removed
 *   - 'tree:changed'        — group / site hierarchy changed
 *   - window 'oblimap:resync' — the socket reconnected: events may have been missed
 *   - a tenant switch (tenantStore epoch) — every tenant-scoped view reloads
 *
 * Multiple events within the debounce window are collapsed into a
 * single reload, so a probe push that transitions 50 devices at once
 * only triggers one HTTP request.
 */

import { useEffect, useRef } from 'react';
import { getSocket } from '../socket/socketClient';
import { useSocketStore } from '../store/socketStore';
import { useTenantEpoch } from '../store/tenantStore';
import { SOCKET_EVENTS } from '@oblimap/shared';

const DEBOUNCE_DEFAULT = 1500; // ms

/**
 * Wire name of SOCKET_EVENTS.TREE_CHANGED (group / site hierarchy changed),
 * spelled out so this hook does not depend on the shared build order.
 */
const TREE_CHANGED_EVENT = 'tree:changed';

/** Window event dispatched by useSocket after a socket reconnect. */
const RESYNC_EVENT = 'oblimap:resync';

export function useIpamLiveRefresh(
  onRefresh: () => void,
  debounceMs: number = DEBOUNCE_DEFAULT,
): void {
  // Keep a stable ref to the latest callback so the listener closure
  // doesn't become stale after re-renders.
  const callbackRef = useRef(onRefresh);
  callbackRef.current = onRefresh;

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debounceRef = useRef(debounceMs);
  debounceRef.current = debounceMs;

  const scheduleRef = useRef(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      callbackRef.current();
    }, debounceRef.current);
  });

  // Pending reload dropped on unmount.
  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  // Tenant switch: reload (the first render is the caller's own initial load).
  // Compare with the previous epoch rather than a "first run" flag, so the
  // StrictMode double-run of effects on mount does not schedule a reload.
  const epoch = useTenantEpoch();
  const prevEpochRef = useRef(epoch);
  useEffect(() => {
    if (prevEpochRef.current === epoch) return;
    prevEpochRef.current = epoch;
    scheduleRef.current();
  }, [epoch]);

  // Socket reconnect: events may have been missed while disconnected.
  useEffect(() => {
    const onResync = () => scheduleRef.current();
    window.addEventListener(RESYNC_EVENT, onResync);
    return () => window.removeEventListener(RESYNC_EVENT, onResync);
  }, []);

  // The socket object exists once connectSocket ran: re-attach when the
  // connection status changes so a hook mounted before it still subscribes.
  const socketStatus = useSocketStore((s) => s.status);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const schedule = () => scheduleRef.current();
    const events = [
      SOCKET_EVENTS.ITEM_STATUS_CHANGED,
      SOCKET_EVENTS.NEW_DEVICE_DISCOVERED,
      SOCKET_EVENTS.PROBE_STATUS_CHANGED,
      SOCKET_EVENTS.SITE_UPDATED,
      SOCKET_EVENTS.SITE_DELETED,
      TREE_CHANGED_EVENT,
    ];
    for (const ev of events) socket.on(ev, schedule);

    return () => {
      for (const ev of events) socket.off(ev, schedule);
    };
  }, [socketStatus]);
}
