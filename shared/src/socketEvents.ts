// Socket.io event names for Oblimap

export const SOCKET_EVENTS = {
  // Probe events
  PROBE_STATUS_CHANGED: 'PROBE_STATUS_CHANGED',       // probe went online/offline
  PROBE_APPROVED: 'PROBE_APPROVED',                   // probe was approved
  PROBE_DEVICE_UPDATED: 'PROBE_DEVICE_UPDATED',       // probe row changed (name, site, role…)
  PROBE_DEVICE_DELETED: 'PROBE_DEVICE_DELETED',

  // Site events
  SITE_UPDATED: 'SITE_UPDATED',                       // site config changed
  SITE_DELETED: 'SITE_DELETED',                       // {siteId} to tenant:<id> (ids only)

  // Item events
  ITEM_STATUS_CHANGED: 'ITEM_STATUS_CHANGED',         // device went online/offline
  NEW_DEVICE_DISCOVERED: 'NEW_DEVICE_DISCOVERED',     // new device found on network
  DEVICE_IP_CHANGED: 'DEVICE_IP_CHANGED',             // MAC moved to new IP
  IP_CONFLICT_DETECTED: 'IP_CONFLICT_DETECTED',       // IP instability alert

  // Group events
  GROUP_CREATED: 'GROUP_CREATED',
  GROUP_UPDATED: 'GROUP_UPDATED',
  GROUP_DELETED: 'GROUP_DELETED',
  GROUP_MOVED: 'GROUP_MOVED',
  GROUP_REORDERED: 'group:reordered',                 // {items} (admin room)

  // Tree events
  TREE_CHANGED: 'tree:changed',                       // payload-free, tenant:<id>: refetch /groups/tree

  // Settings events
  SETTINGS_UPDATED: 'settings:updated',               // {scope, scopeId, ...} (admins + 'settings' holders)

  // Permission events
  PERMISSIONS_CHANGED: 'permissions:changed',         // payload-free, user:<id>: refetch the permissions and the tree

  // Tunnel events
  TUNNEL_CHANGED: 'tunnel:changed',                   // {tunnelId, status}: admins, probes.manage holders and the opener (user:<id>)

  // Agent compat aliases
  AGENT_STATUS_CHANGED: 'PROBE_STATUS_CHANGED',
  AGENT_DEVICE_UPDATED: 'PROBE_DEVICE_UPDATED',
  AGENT_DEVICE_DELETED: 'PROBE_DEVICE_DELETED',

  // Notification events
  NOTIFICATION_NEW: 'NOTIFICATION_NEW',               // new live alert (also carries resolutions)

  // Device check events
  DEVICE_CHECK_UPDATED: 'device_check:updated',       // latest values/status of a (rule, item) changed
  DEVICE_CHECK_ALERT: 'device_check:alert',           // alert opened / closed / reminder
  DEVICE_CHECK_RULES_CHANGED: 'device_check:rules_changed', // rule created/updated/enabled/deleted (admin room)

  // System events
  CONNECT: 'connect',
  DISCONNECT: 'disconnect',
} as const;

export type SocketEvent = typeof SOCKET_EVENTS[keyof typeof SOCKET_EVENTS];

/**
 * Probe WebSocket message types — the real wire names.
 * Probes use a raw WebSocket at /api/probe/ws carrying JSON `{ type, ... }`
 * (no Socket.io namespace). Unknown types are ignored by both sides, so new
 * types are only sent to probes that advertised the matching capability.
 */
export const PROBE_WS_MESSAGES = {
  // Probe → Server
  SCAN_RESULT: 'scan_result',
  HEARTBEAT: 'heartbeat',
  TUNNEL_READY: 'tunnel_ready',
  TUNNEL_ERROR: 'tunnel_error',
  HELLO: 'hello',                         // {probeVersion, capabilities, serverScheme} right after connect
  CHECK_RESULTS: 'check_results',         // ProbeCheckResultsBatch
  CHECK_TEST_RESULT: 'check_test_result', // reply to CHECK_TEST
  PROBE_TOKEN_ACK: 'probe_token_ack',     // {persisted} after storing PROBE_TOKEN
  UPDATE_ABORTED: 'update_aborted',       // self-update refused (e.g. checksum_mismatch)

  // Server → Probe
  HEARTBEAT_ACK: 'heartbeat_ack',
  CONFIG_UPDATE: 'config_update',
  COMMAND: 'command',
  TUNNEL_OPEN: 'tunnel_open',
  TUNNEL_CLOSE: 'tunnel_close',
  PROBE_TOKEN: 'probe_token',             // per-probe identity token, issued once
  CHECK_TEST: 'check_test',
  CHECK_RUN_NOW: 'check_run_now',
} as const;

export type ProbeWsMessageType = typeof PROBE_WS_MESSAGES[keyof typeof PROBE_WS_MESSAGES];

/**
 * Probe WebSocket namespace events (/probe).
 * Used for persistent WS connections between probes and server.
 * These names never matched the wire protocol; kept for backwards compat only.
 *
 * @deprecated wire names are PROBE_WS_MESSAGES
 */
export const PROBE_WS_EVENTS = {
  // Probe → Server
  SCAN_RESULT: 'probe:scan_result',
  HEARTBEAT: 'probe:heartbeat',
  TUNNEL_READY: 'probe:tunnel_ready',
  TUNNEL_ERROR: 'probe:tunnel_error',

  // Server → Probe
  HEARTBEAT_ACK: 'probe:heartbeat_ack',
  CONFIG_UPDATE: 'server:config_update',
  COMMAND: 'server:command',
  TUNNEL_OPEN: 'server:tunnel_open',
  TUNNEL_CLOSE: 'server:tunnel_close',
} as const;
