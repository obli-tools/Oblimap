import { io, Socket } from 'socket.io-client';
import { useSocketStore } from '../store/socketStore';
import { getObliToolsToken } from '../api/client';

let socket: Socket | null = null;

/** Guards against registering the visibilitychange listener more than once. */
let visibilityListenerAdded = false;

/**
 * Timestamp (ms) at which the page was last hidden.
 * Used to decide whether a re-visible page has been asleep long enough
 * to suspect a stale WebSocket connection.
 */
let hiddenAt: number | null = null;

/**
 * If the page was hidden for longer than this threshold we force a
 * disconnect → reconnect on wake-up so the stale connection is replaced
 * immediately rather than waiting up to 45 s for the ping-timeout to fire.
 */
const STALE_THRESHOLD_MS = 30_000;

export function getSocket(): Socket | null {
  return socket;
}

/**
 * Connect to Socket.io. The server takes the user and the current tenant from
 * the session (cookie, sent thanks to withCredentials) — no identity is sent
 * from here. Inside ObliTools only, where cookies are blocked, the session
 * token (the value the API client sends as X-Auth-Token) goes in
 * handshake.auth.token. The auth callback runs on every (re)connect, so a
 * reconnect after a tenant switch reads the session's new tenant.
 *
 * The arguments are ignored (kept so existing callers still compile).
 */
export function connectSocket(_legacyUserId?: number, _legacyTenantId?: number | null): Socket {
  if (socket?.connected) {
    return socket;
  }
  // A socket that is down (auto-reconnect in progress, or after a manual
  // disconnect) is reused rather than replaced: the listeners registered on
  // it (useSocket, useIpamLiveRefresh…) and its reconnect detection stay
  // attached. disconnectSocket() (logout) drops it for good.
  if (socket) {
    socket.connect();
    return socket;
  }

  socket = io(window.location.origin, {
    auth: (cb) => {
      const token = getObliToolsToken();
      cb(token ? { token } : {});
    },
    // Start with polling, then upgrade to WebSocket transparently.
    // ['websocket', 'polling'] would try WS first which fails behind some
    // reverse proxies (the direct WS handshake differs from the upgrade path).
    transports: ['polling', 'websocket'],
    withCredentials: true,
  });

  const { setStatus } = useSocketStore.getState();

  socket.on('connect', () => {
    console.log('Socket connected');
    setStatus('connected');
  });

  socket.on('disconnect', () => {
    setStatus('disconnected');
  });

  socket.on('connect_error', () => {
    setStatus('disconnected');
  });

  // socket.io is the Manager; these fire during auto-reconnect cycles.
  socket.io.on('reconnect_attempt', () => {
    setStatus('reconnecting');
  });

  socket.io.on('reconnect', () => {
    setStatus('connected');
  });

  // ── Sleep / wake detection ───────────────────────────────────────────────
  // When the OS suspends the machine the underlying TCP connection dies, but
  // socket.io can take up to ~45 s to notice (pingInterval + pingTimeout).
  // We track how long the page was hidden and, if it looks like a real sleep
  // rather than a quick tab-switch, we force a disconnect → reconnect so the
  // UI reflects reality immediately.
  if (!visibilityListenerAdded && typeof document !== 'undefined') {
    visibilityListenerAdded = true;

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        return;
      }

      // Page became visible again.
      const s = getSocket();
      if (!s) return;

      const wasHiddenForMs = hiddenAt !== null ? Date.now() - hiddenAt : 0;
      hiddenAt = null;

      if (!s.connected) {
        // Already detected as disconnected — update store immediately so the
        // indicator turns red without waiting for the next render cycle.
        useSocketStore.getState().setStatus('disconnected');
      } else if (wasHiddenForMs > STALE_THRESHOLD_MS) {
        // Hidden long enough to be suspicious of a stale connection.
        // Force a full reconnect so we know for sure.
        s.disconnect().connect();
      }
    });
  }

  return socket;
}

/**
 * Re-runs the handshake on the existing socket — e.g. after a tenant switch:
 * the server joins the rooms of the session's new tenant. Keeps the Socket
 * object, so listeners registered on it (useSocket…) stay attached.
 */
export function reconnectSocket(): Socket | null {
  if (!socket) return null;
  socket.disconnect().connect();
  return socket;
}

export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  useSocketStore.getState().setStatus('disconnected');
}
