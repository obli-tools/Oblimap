import './env';
import http from 'http';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer } from 'ws';
import type WebSocket from 'ws';
import { createApp } from './app';
import { createSocketServer } from './socket';
import { db } from './db';
import { config } from './config';
import { logger } from './utils/logger';
import { clientIp } from './utils/clientIp';
import { authService } from './services/auth.service';
import { setProbeServiceIO, probeService, cleanupDedupCache } from './services/probe.service';
import { tunnelService } from './services/tunnel.service';
import { setLiveAlertIO } from './services/liveAlert.service';
import { setDeviceChecksIO } from './services/deviceChecks/config.service';
import { startDeviceCheckSweeper } from './services/deviceChecks/sweeper';
import { notificationService } from './services/notification.service';
import { obligateService } from './services/obligate.service';
import { dashboardService } from './services/dashboard.service';
import { seedIfNeeded as seedOuiRegistryIfNeeded } from './services/ouiRegistry.service';
import { authenticateProbe } from './services/probeAuth.service';
import { probeIdentityService } from './services/probeIdentity.service';
import {
  registerProbeWs,
  registerTunnelDataWs,
  hasTunnelDataWs,
  canAcceptUnregisteredProbe,
} from './services/probeHub.service';

// ─── Probe WebSocket endpoints ──────────────────────────────────────────────

/** Largest WebSocket message accepted from a probe (control and tunnel data). */
const PROBE_WS_MAX_PAYLOAD = 4 * 1024 * 1024;
const PROBE_WS_PATH = /^\/api\/probe\/ws\/?$/;
const TUNNEL_WS_PATH = /^\/api\/probe\/ws\/tunnel\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

// Flood guards in front of the database lookups of a probe upgrade:
// - refused upgrades per client IP. Only refusals count: a whole fleet may
//   reconnect from one address (NAT, or a proxy chain missing from
//   TRUSTED_PROXIES) after a restart, and every tunnel open dials a data
//   socket — successful upgrades must never throttle the other probes;
// - every upgrade per (client IP, X-Probe-UUID): one probe, or a key holder
//   replaying one UUID, cannot keep the authentication busy on its own.
const UPGRADE_WINDOW_MS = 5 * 60 * 1000;
const UPGRADE_MAX_REFUSED_PER_IP = 1200;
const UPGRADE_MAX_PER_PROBE = 120;

/** Fixed-window counters per key, bounded in memory. */
class WindowCounter {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly windowMs: number, private readonly maxKeys = 10_000) {}

  get(key: string): number {
    const entry = this.entries.get(key);
    return entry && Date.now() < entry.resetAt ? entry.count : 0;
  }

  /** Counts one more event for `key`; returns the count in the current window. */
  add(key: string): number {
    const now = Date.now();
    let entry = this.entries.get(key);
    if (!entry || now >= entry.resetAt) {
      if (!entry && this.entries.size >= this.maxKeys) {
        for (const [k, e] of this.entries) if (now >= e.resetAt) this.entries.delete(k);
        if (this.entries.size >= this.maxKeys) this.entries.clear();
      }
      entry = { count: 0, resetAt: now + this.windowMs };
      this.entries.set(key, entry);
    }
    entry.count += 1;
    return entry.count;
  }
}

const refusedUpgradesByIp = new WindowCounter(UPGRADE_WINDOW_MS);
const upgradesByProbe = new WindowCounter(UPGRADE_WINDOW_MS);

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const v = request.headers[name];
  return typeof v === 'string' ? v : undefined;
}

/** Refuses an upgrade with a plain HTTP status (no WebSocket, no config). */
function rejectUpgrade(socket: Duplex, status: number): void {
  if (socket.destroyed) return;
  socket.on('error', () => socket.destroy());
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  socket.once('finish', () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] ?? 'Error'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Refuses an upgrade the probe (or caller) is responsible for: counted against its IP's budget. */
function refuseUpgrade(socket: Duplex, status: number, ip: string | null): void {
  refusedUpgradesByIp.add(ip ?? 'unknown');
  rejectUpgrade(socket, status);
}

/**
 * Authenticates a probe WebSocket upgrade (control channel, or the data
 * channel of one tunnel when tunnelId is set) BEFORE the handshake: a
 * refusal is a plain HTTP status, never a 101 followed by a close.
 */
async function handleProbeUpgrade(
  wss: WebSocketServer,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  tunnelId: string | null,
): Promise<void> {
  // Node removed its own 'error' listener before emitting 'upgrade': guard
  // the socket while we wait for the database, or a client reset would crash
  // the process.
  const onEarlyError = () => socket.destroy();
  socket.on('error', onEarlyError);
  const channel = tunnelId ? 'tunnel' : 'control';
  try {
    const ip = clientIp(request) || null;
    if (refusedUpgradesByIp.get(ip ?? 'unknown') >= UPGRADE_MAX_REFUSED_PER_IP) {
      logger.warn({ ip, channel }, 'Probe WS upgrade rejected: too many refused attempts from this address');
      rejectUpgrade(socket, 429);
      return;
    }
    const uuidHeader = (headerValue(request, 'x-probe-uuid') ?? '').trim().slice(0, 64).toLowerCase();
    const probeAttempts = upgradesByProbe.add(`${ip ?? 'unknown'}|${uuidHeader}`);
    if (probeAttempts > UPGRADE_MAX_PER_PROBE) {
      if (probeAttempts === UPGRADE_MAX_PER_PROBE + 1) {
        logger.warn({ ip, channel }, 'Probe WS upgrades throttled: too many attempts for this probe');
      }
      rejectUpgrade(socket, 429);
      return;
    }

    // Control channel: pending probes are accepted (the probe checks WS
    // support only at startup, so a refused upgrade would leave it on HTTP
    // polling until its next restart), and so are unknown ones — they
    // register with their first scan_result. The data channel of a tunnel
    // requires an approved probe.
    // Identity v2: a probe switching to the shared Obli* device ID dials with
    // its current UUID; the alias-aware lookup covers a dial racing the
    // re-key. The HTTP push does the re-keying, never the upgrade.
    let auth = await authenticateProbe({
      apiKey: headerValue(request, 'x-api-key'),
      probeUuid: headerValue(request, 'x-probe-uuid'),
      probeToken: headerValue(request, 'x-probe-token'),
      features: headerValue(request, 'x-probe-features'),
      requireApproved: tunnelId !== null,
      allowUnknownProbe: tunnelId === null,
      aliasFallback: true,
      ip,
    });
    if (auth.ok && !auth.probe && tunnelId === null) {
      // Unknown under its current UUID but announcing a shared ID that is
      // already registered (push acknowledged, ack lost): the same checks
      // (key binding, identity token) under the shared ID.
      const identity = probeIdentityService.parseHeaders(request.headers);
      if (identity) {
        const viaTarget = await authenticateProbe({
          apiKey: headerValue(request, 'x-api-key'),
          probeUuid: identity.target,
          probeToken: headerValue(request, 'x-probe-token'),
          features: headerValue(request, 'x-probe-features'),
          requireApproved: false,
          allowUnknownProbe: true,
          ip,
        });
        if (viaTarget.ok && viaTarget.probe) auth = viaTarget;
      }
    }
    if (!auth.ok) {
      logger.warn({ ip, channel, status: auth.status, code: auth.code }, 'Probe WS upgrade rejected');
      refuseUpgrade(socket, auth.status, ip);
      return;
    }
    const tenantId = auth.apiKey.tenant_id;
    const probe = auth.probe;
    // authenticateProbe accepted the header in this canonical form.
    const probeUuid = probe ? String(probe.uuid).toLowerCase() : String(headerValue(request, 'x-probe-uuid')).trim().toLowerCase();

    if (tunnelId) {
      if (!probe) {
        refuseUpgrade(socket, 404, ip);
        return;
      }
      // The tunnel must belong to this probe and tenant, still be open
      // ('active' too: older probes report tunnel_ready before dialing), and
      // have no data socket yet.
      const tunnel = await db('tunnels')
        .where({ id: tunnelId, probe_id: probe.id, tenant_id: tenantId })
        .whereIn('status', ['opening', 'active'])
        .first('id');
      if (!tunnel) {
        logger.warn({ ip, probeId: probe.id, tunnelId }, 'Tunnel WS upgrade rejected: no such open tunnel for this probe');
        refuseUpgrade(socket, 404, ip);
        return;
      }
      if (hasTunnelDataWs(tunnelId)) {
        logger.warn({ ip, probeId: probe.id, tunnelId }, 'Tunnel WS upgrade rejected: data channel already attached');
        refuseUpgrade(socket, 409, ip);
        return;
      }
      if (socket.destroyed) return;
      socket.removeListener('error', onEarlyError);
      wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
        if (!registerTunnelDataWs(tunnelId, ws, probe.id, tenantId)) {
          ws.on('error', () => ws.terminate());
          ws.close(4009, 'Tunnel already attached');
          return;
        }
        logger.info({ tunnelId, probeId: probe.id }, 'Tunnel WS upgraded');
      });
      return;
    }

    if (!probe && !canAcceptUnregisteredProbe(auth.apiKey.id)) {
      logger.warn({ ip, tenantId }, 'Probe WS upgrade rejected: too many unregistered probes for this API key');
      refuseUpgrade(socket, 429, ip);
      return;
    }
    if (socket.destroyed) return;
    socket.removeListener('error', onEarlyError);
    wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      logger.info({ probeId: probe?.id, probeUuid }, 'Probe WS upgraded successfully');
      registerProbeWs(ws, {
        probeId: probe ? probe.id : null,
        tenantId,
        probeUuid,
        apiKeyId: auth.apiKey.id,
        features: headerValue(request, 'x-probe-features'),
        ip,
        shouldIssueToken: auth.shouldIssueToken,
      }).catch((err: unknown) => logger.error(err, 'Probe WS registration failed'));
    });
  } catch (err) {
    logger.error(err, 'Probe WS upgrade handler error');
    rejectUpgrade(socket, 500);
  }
}

async function main() {
  // 1. Run pending migrations
  logger.info('Running database migrations...');
  await db.migrate.latest();
  logger.info('Migrations complete');

  // 2. Ensure default admin user exists
  await authService.ensureDefaultAdmin(
    config.defaultAdminUsername,
    config.defaultAdminPassword,
  );

  // No tunnel survives a restart (their data sockets lived in this process).
  await tunnelService.closeOrphanedTunnels().catch((err) => logger.error(err, 'Closing orphaned tunnels failed'));

  // 3. Create Express app
  const app = createApp();

  // 4. Create HTTP server
  const server = http.createServer(app);

  // 5. Attach Socket.io
  const io = createSocketServer(server);

  // Store io instance for later use
  app.set('io', io);

  // Provide io to probe service for real-time push events
  setProbeServiceIO(io);
  // Provide io to live alert service for real-time notification delivery
  setLiveAlertIO(io);
  // Provide io to the Device Checks services (DEVICE_CHECK_* events)
  setDeviceChecksIO(io);

  // 6. Raw WebSocket for probes (/api/probe/ws, /api/probe/ws/tunnel/<id>) — like Obliance's agent WS.
  // Socket.io registered its own 'upgrade' listener, which ends any socket it
  // does not own that has not been written to within 1 s — shorter than a
  // probe authentication may take. Like Obliance, this listener becomes the
  // only dispatcher: probe paths are handled here, everything else is
  // forwarded to Socket.io's original listeners.
  const probeWss = new WebSocketServer({ noServer: true, maxPayload: PROBE_WS_MAX_PAYLOAD });
  const sioUpgradeListeners = server.rawListeners('upgrade').slice();
  server.removeAllListeners('upgrade');

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = (request.url ?? '').split('?')[0];

    if (pathname === '/api/probe/ws' || pathname.startsWith('/api/probe/ws/')) {
      const tunnelMatch = TUNNEL_WS_PATH.exec(pathname);
      if (!tunnelMatch && !PROBE_WS_PATH.test(pathname)) {
        rejectUpgrade(socket, 404);
        return;
      }
      void handleProbeUpgrade(probeWss, request, socket, head, tunnelMatch ? tunnelMatch[1].toLowerCase() : null);
      return;
    }

    for (const listener of sioUpgradeListeners) {
      (listener as (...args: unknown[]) => void).call(server, request, socket, head);
    }
  });

  // Safety net: one crash stops the server for every tenant. Errors of probe
  // and tunnel sockets are handled where they occur; anything that still
  // escapes is logged instead of terminating the process.
  process.on('uncaughtException', (err) => {
    logger.error(err, 'Uncaught exception (server kept running)');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection');
  });

  // 7. Listen
  server.listen(config.port, () => {
    logger.info(`Oblimap server listening on port ${config.port}`);
    logger.info(`Environment: ${config.nodeEnv}`);

    // Channels to a LAN target (internal Gotify / ntfy / webhook) stopped
    // being delivered when the SSRF guard came in: report them (non-blocking).
    void notificationService.warnBlockedChannelTargets();

    // Announce our accent color to Obligate (best-effort, non-blocking).
    void obligateService.announceSelfInfo();
  });

  // 7. Probe cleanup job — auto-delete probes whose uninstall command was delivered
  //    more than 10 minutes ago
  const PROBE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
  const probeCleanupTimer = setInterval(async () => {
    try {
      await probeService.cleanupUninstalledProbes();
      await probeService.cleanupStuckUpdating();
      cleanupDedupCache();
      await tunnelService.cleanupStaleTunnels();
    } catch (err) {
      logger.error(err, 'Probe cleanup job failed');
    }
  }, PROBE_CLEANUP_INTERVAL_MS);

  // Device Checks: 60 s alert sweep (business-hours windows, debounce without
  // new results) and hourly retention of events and audit logs.
  const stopDeviceCheckSweeper = startDeviceCheckSweeper();

  // Probe-offline job (every 60 s): approved probes silent for longer than
  // max(offlineThresholdMultiplier × scan interval, probeOfflineGraceMinutes)
  // are reported offline, probes seen again resolve it; then the
  // device-offline / probe-offline alerts whose problem is over are resolved.
  const PROBE_LIVENESS_INTERVAL_MS = 60 * 1000;
  let probeLivenessRunning = false;
  const probeLivenessTimer = setInterval(async () => {
    if (probeLivenessRunning) return;
    probeLivenessRunning = true;
    try {
      await probeService.checkProbeLiveness();
      await probeService.resolveStaleOfflineAlerts();
    } catch (err) {
      logger.error(err, 'Probe liveness job failed');
    } finally {
      probeLivenessRunning = false;
    }
  }, PROBE_LIVENESS_INTERVAL_MS);

  // Dashboard history: today's per-site IPAM snapshot (ipam_daily_snapshot),
  // once at boot and then hourly — an idempotent upsert per (site, day), so
  // restarts never duplicate rows — plus the 400-day purge. Never throws.
  const IPAM_SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000;
  void dashboardService.snapshotToday();
  const ipamSnapshotTimer = setInterval(() => {
    void dashboardService.snapshotToday();
  }, IPAM_SNAPSHOT_INTERVAL_MS);

  // IEEE MAC registries (MA-L / MA-M / MA-S) in mac_vendors: downloaded in
  // the background when the table is (nearly) empty or the last download is
  // older than 30 days — checked shortly after boot and then daily. Never
  // blocks startup, never throws (a failure is retried at the next check).
  const OUI_SEED_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const ouiSeedBootTimer = setTimeout(() => { void seedOuiRegistryIfNeeded(); }, 15 * 1000);
  const ouiSeedTimer = setInterval(() => { void seedOuiRegistryIfNeeded(); }, OUI_SEED_CHECK_INTERVAL_MS);

  // 8. Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    clearTimeout(ouiSeedBootTimer);
    clearInterval(ouiSeedTimer);
    clearInterval(probeCleanupTimer);
    clearInterval(probeLivenessTimer);
    clearInterval(ipamSnapshotTimer);
    stopDeviceCheckSweeper();
    server.close();
    await db.destroy();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal(err, 'Failed to start Oblimap server');
  process.exit(1);
});
