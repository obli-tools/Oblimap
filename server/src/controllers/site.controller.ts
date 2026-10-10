import type { Request, Response, NextFunction } from 'express';
import { SOCKET_EVENTS } from '@oblimap/shared';
import { db } from '../db';
import { siteService, DuplicateItemError, type SiteProbeRow } from '../services/site.service';
import { probeLiveState } from '../services/probe.service';
import { isProbeConnected, sendToProbe } from '../services/probeHub.service';
import { tenantAdminEventRooms } from '../services/tenant.service';
import { logger } from '../utils/logger';
import { flowService } from '../services/flow.service';
import { permissionService } from '../services/permission.service';
import { auditService } from '../services/audit.service';
import { recordBatch as recordItemEvents } from '../services/itemEvents.service';
import {
  clearRealtimeReadCacheForTenant, emitSiteUpdated, emitTreeChanged, realtimeIO,
} from '../services/realtime.service';
import { AppError } from '../middleware/errorHandler';
import { requireDbId, toDbId } from '../utils/dbId';
import type { FlowPeriod } from '@oblimap/shared';
import {
  FLOW_PERIODS,
  type CreateSiteInput,
  type UpdateSiteInput,
  type CreateSiteItemInput,
  type UpdateSiteItemInput,
  type CreateReservationInput,
  type UpdateReservationInput,
} from '../validators/site.schema';

// Access control is done by the routes (site.routes.ts): requireSiteRead /
// requireSiteWrite resolve the site in req.tenantId (404) and check the
// user's permission (403). Handlers still pass req.tenantId to every query.
// Bodies are validated by the zod schemas of validators/site.schema.ts.

function siteIdOf(req: Request): number {
  return requireDbId(req.params.id, 'site ID');
}

// Socket events: SITE_UPDATED {siteId} goes to the tenant's admins and to the
// sockets of the users who may read the site (realtime.service, readers
// computed after the change); the sidebar tree is announced with the
// payload-free TREE_CHANGED. A deleted site has no readers left to compute:
// SITE_DELETED carries its id only, to the tenant room.

/** "true" / "1" query flags. */
function queryFlag(v: unknown): boolean {
  return v === 'true' || v === '1';
}

function isoOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function ipList(v: unknown): string[] {
  let parsed = v;
  if (typeof v === 'string') {
    try { parsed = JSON.parse(v); } catch { return []; }
  }
  return Array.isArray(parsed) ? parsed.filter((ip): ip is string => typeof ip === 'string') : [];
}

/** Display name of a probe: its name, else its hostname. */
function probeDisplayName(row: SiteProbeRow): string {
  return (row.name && row.name.trim()) || row.hostname || `#${row.id}`;
}

/**
 * Site rescan limit: one request per site and minute (in memory, per server
 * process). Every rescan makes each probe of the site sweep its subnets.
 */
const RESCAN_INTERVAL_MS = 60_000;
const lastRescanAt = new Map<string, number>();

/** Seconds left before the site may be rescanned again (0 = now; records the attempt). */
function takeRescanSlot(tenantId: number, siteId: number, now = Date.now()): number {
  if (lastRescanAt.size > 1000) {
    for (const [key, at] of lastRescanAt) if (now - at >= RESCAN_INTERVAL_MS) lastRescanAt.delete(key);
  }
  const key = `${tenantId}:${siteId}`;
  const last = lastRescanAt.get(key);
  if (last !== undefined && now - last < RESCAN_INTERVAL_MS) {
    return Math.max(1, Math.ceil((RESCAN_INTERVAL_MS - (now - last)) / 1000));
  }
  lastRescanAt.set(key, now);
  return 0;
}

/** Gives the slot back (the rescan failed before any probe was asked). */
function releaseRescanSlot(tenantId: number, siteId: number): void {
  lastRescanAt.delete(`${tenantId}:${siteId}`);
}

/** The audited identity of a device row (the notes are compared, never logged). */
interface ItemAuditRow {
  ip: string | null;
  mac: string | null;
  hostname: string | null;
  custom_name: string | null;
  device_type: string | null;
  notes: string | null;
  status: string | null;
  /** Migration 052 (undefined before it has run). */
  alert_mode?: string | null;
}

async function itemAuditRow(tenantId: number, siteId: number, itemId: number): Promise<ItemAuditRow | undefined> {
  // Whole row: alert_mode only exists once migration 052 has run.
  return db('site_items')
    .where({ id: itemId, site_id: siteId, tenant_id: tenantId })
    .first() as Promise<ItemAuditRow | undefined>;
}

/** API field → site_items column, for the audited item changes. */
const ITEM_AUDIT_FIELDS = {
  customName: 'custom_name',
  deviceType: 'device_type',
  notes: 'notes',
  status: 'status',
  alertMode: 'alert_mode',
} as const satisfies Partial<Record<keyof UpdateSiteItemInput, keyof ItemAuditRow>>;

/** Display name of a device row: its name, else its hostname, else its IP. */
function itemDisplayName(row: Pick<ItemAuditRow, 'custom_name' | 'hostname' | 'ip'>): string | null {
  return (row.custom_name && row.custom_name.trim()) || (row.hostname && row.hostname.trim()) || row.ip || null;
}

/**
 * A manual change of a device in its history (site_item_events),
 * with the acting user. Never the notes text. Never throws (recordBatch logs).
 */
async function recordManualItemEvent(
  req: Request,
  siteId: number,
  e: { kind: 'created' | 'edited' | 'deleted'; itemId: number | null; mac: string | null; ip: string | null; details: Record<string, unknown> },
): Promise<void> {
  await recordItemEvents([{
    tenantId: req.tenantId,
    siteId,
    actorUserId: req.session.userId ?? null,
    ...e,
  }]);
}

export const siteController = {
  // ── Sites ─────────────────────────────────────────────────────────────────

  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      let groupId: number | undefined;
      if (req.query.groupId !== undefined) {
        const id = toDbId(req.query.groupId);
        if (id === null) throw new AppError(400, 'Invalid group ID');
        groupId = id;
      }
      const ungrouped = req.query.ungrouped === 'true';
      // ?includeDescendants=true (with groupId): the sites of the sub-groups
      // too (group page). Default: direct children only (sidebar, tree).
      const includeDescendants = groupId !== undefined && queryFlag(req.query.includeDescendants);
      // Only the sites the user may read (team permissions; admins: all).
      const siteIds = await permissionService.getVisibleSiteIds(
        req.session.userId!, req.tenantId, req.session.role === 'admin',
      );
      const sites = await siteService.getSites(req.tenantId, { groupId, includeDescendants, ungrouped, siteIds });
      res.json({ sites });
    } catch (err) { next(err); }
  },

  async get(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const site = await siteService.getSite(req.tenantId, siteIdOf(req));
      if (!site) throw new AppError(404, 'Site not found');
      res.json({ site });
    } catch (err) { next(err); }
  },

  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { name, description, groupId } = req.body as CreateSiteInput;
      // groupId must be a group of this tenant (400 otherwise, siteService).
      const site = await siteService.createSite(req.tenantId, { name, description, groupId });
      await auditService.logReq(req, {
        action: 'site.created',
        resourceType: 'site',
        resourceId: site.id,
        details: { name: site.name, groupId: site.groupId },
      });
      emitSiteUpdated(req.tenantId, site.id);
      emitTreeChanged(req.tenantId);
      res.status(201).json({ site });
    } catch (err) { next(err); }
  },

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const siteId = siteIdOf(req);
      const data = req.body as UpdateSiteInput;
      const before = await siteService.getSite(req.tenantId, siteId);
      if (!before) throw new AppError(404, 'Site not found');

      // Taking the site out of every group: only admins see ungrouped sites,
      // so a member whose grant comes from the group would hide it from
      // everyone but the admins. Creation refuses it too.
      if (data.groupId === null && before.groupId != null) {
        const fullAccess = await permissionService.isFullAccess(
          req.session.userId!, req.tenantId, req.session.role === 'admin',
        );
        if (!fullAccess) throw new AppError(403, 'Choose a group you can write to');
      }

      // Moving the site into another group also needs write permission on
      // that group (as for group moves); the group must be in this tenant.
      if (data.groupId !== undefined && data.groupId !== null && data.groupId !== before.groupId) {
        const target = await permissionService.findGroup(data.groupId, req.tenantId);
        if (!target) throw new AppError(400, 'Group not found');
        const canWriteTarget = await permissionService.canWriteGroup(
          req.session.userId!, data.groupId, req.tenantId, req.session.role === 'admin',
        );
        if (!canWriteTarget) throw new AppError(403, 'No write permission on target group');
      }

      const site = await siteService.updateSite(req.tenantId, siteId, data);
      if (!site) throw new AppError(404, 'Site not found');
      await auditService.logReq(req, {
        action: 'site.updated',
        resourceType: 'site',
        resourceId: siteId,
        details: {
          name: site.name,
          fields: Object.keys(data),
          ...(before.groupId !== site.groupId ? { fromGroupId: before.groupId, toGroupId: site.groupId } : {}),
        },
      });
      // A move changes who reads the site: recompute the readers after it.
      if (before.groupId !== site.groupId) clearRealtimeReadCacheForTenant(req.tenantId);
      emitSiteUpdated(req.tenantId, siteId);
      if (before.groupId !== site.groupId || before.name !== site.name) emitTreeChanged(req.tenantId);
      res.json({ site });
    } catch (err) { next(err); }
  },

  async remove(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const siteId = siteIdOf(req);
      const site = await siteService.getSite(req.tenantId, siteId);
      if (!site) throw new AppError(404, 'Site not found');
      const deleted = await siteService.deleteSite(req.tenantId, siteId);
      if (!deleted) throw new AppError(404, 'Site not found');
      await auditService.logReq(req, {
        action: 'site.deleted',
        resourceType: 'site',
        resourceId: siteId,
        details: { name: site.name, groupId: site.groupId },
      });
      const io = req.app.get('io');
      if (io) io.to(`tenant:${req.tenantId}`).emit(SOCKET_EVENTS.SITE_DELETED, { siteId });
      emitTreeChanged(req.tenantId);
      res.status(204).send();
    } catch (err) { next(err); }
  },

  // ── Probes of the site ─────────────────────────────────────────────────────

  /**
   * GET /sites/:id/probes (site read): the site's approved probes with the
   * server's liveness verdict. The network identity (ip, ips, mac) only for
   * full access (platform admin or tenant admin), as GET /groups/:id/probes;
   * never the uuid, the API key or the token.
   */
  async listProbes(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const siteId = siteIdOf(req);
      const showIdentity = await permissionService.isFullAccess(
        req.session.userId!, req.tenantId, req.session.role === 'admin',
      );
      const rows = await siteService.getSiteProbeRows(req.tenantId, siteId);
      const probes = rows.map((row) => ({
        id: row.id,
        name: probeDisplayName(row),
        ...probeLiveState(row),
        lastSeenAt: isoOrNull(row.last_seen_at),
        isPrimary: Boolean(row.is_primary),
        probeVersion: row.probe_version ?? null,
        wsConnected: isProbeConnected(row.id),
        ...(showIdentity ? { ip: row.ip ?? null, ips: ipList(row.ips), mac: row.mac ?? null } : {}),
      }));
      res.json({ probes });
    } catch (err) { next(err); }
  },

  /**
   * GET /sites/:id/tunnel-probes (site write + tunnels.use): the probes a
   * tunnel of this site can go through: id, name, primary flag and
   * WebSocket state only.
   */
  async listTunnelProbes(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const rows = await siteService.getSiteProbeRows(req.tenantId, siteIdOf(req));
      const probes = rows.map((row) => ({
        id: row.id,
        name: probeDisplayName(row),
        isPrimary: Boolean(row.is_primary),
        wsConnected: isProbeConnected(row.id),
      }));
      res.json({ probes });
    } catch (err) { next(err); }
  },

  /**
   * POST /sites/:id/rescan (site write): sends 'rescan' to every approved
   * probe of the site, over its WebSocket now, else queued for its next
   * push. A probe with another command queued (uninstall / update) is
   * skipped, never overwritten. Once per site and minute (429). Answers
   * {sent, queued, skipped}.
   */
  async rescan(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const siteId = siteIdOf(req);
      const wait = takeRescanSlot(req.tenantId, siteId);
      if (wait > 0) {
        res.setHeader('Retry-After', String(wait));
        res.status(429).json({ error: 'rescan_rate_limited', retryAfterSeconds: wait });
        return;
      }
      let sent = 0;
      let queued = 0;
      const probeIds: number[] = [];
      const skippedProbeIds: number[] = [];
      try {
        const rows = await siteService.getSiteProbeRows(req.tenantId, siteId);
        for (const row of rows) {
          // Never replaces another queued command ('uninstall' / 'update' of
          // a probes.manage holder): conditional write, the probe is skipped.
          if (!(await siteService.queueSiteRescan(req.tenantId, siteId, row.id))) {
            skippedProbeIds.push(row.id);
            continue;
          }
          probeIds.push(row.id);
          if (sendToProbe(row.id, { type: 'command', command: 'rescan' })) {
            await siteService.clearDeliveredRescan(req.tenantId, row.id);
            sent++;
          } else {
            queued++;
          }
        }
      } catch (err) {
        // Nothing reached a probe: the site is not kept rate-limited.
        if (probeIds.length === 0) releaseRescanSlot(req.tenantId, siteId);
        throw err;
      }
      // Same event as probeService.sendCommand: probe pages show the queue.
      const io = realtimeIO();
      if (io && probeIds.length > 0) {
        const rooms = tenantAdminEventRooms(req.tenantId, 'probes.manage');
        for (const probeId of probeIds) io.to(rooms).emit(SOCKET_EVENTS.PROBE_DEVICE_UPDATED, { probeId });
      }
      try {
        await auditService.logReq(req, {
          action: 'site.rescan',
          resourceType: 'site',
          resourceId: siteId,
          details: { probeIds, sent, queued, skippedProbeIds },
        });
      } catch (err) {
        // The probes were asked already: a failed audit write is not a failed rescan.
        logger.warn({ err: (err as Error)?.message, siteId }, 'site.rescan audit write failed');
      }
      res.json({ sent, queued, skipped: skippedProbeIds.length });
    } catch (err) { next(err); }
  },

  // ── Flows ──────────────────────────────────────────────────────────────────

  async listFlows(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const siteId = siteIdOf(req);
      const period = typeof req.query.period === 'string' ? req.query.period : '24h';
      if (!(FLOW_PERIODS as readonly string[]).includes(period)) {
        throw new AppError(400, 'Invalid period. Use: 1h, 24h, 30d, 1y');
      }
      const flows = await flowService.getFlows(req.tenantId, siteId, period as FlowPeriod);
      res.json({ flows });
    } catch (err) { next(err); }
  },

  async clearFlows(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const siteId = siteIdOf(req);
      const deleted = await flowService.clearFlows(req.tenantId, siteId);
      await auditService.logReq(req, {
        action: 'site.flows_cleared',
        resourceType: 'site',
        resourceId: siteId,
        details: { deleted },
      });
      res.json({ deleted });
    } catch (err) { next(err); }
  },

  // ── Items ──────────────────────────────────────────────────────────────────

  async listItems(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const items = await siteService.getItems(req.tenantId, siteIdOf(req));
      res.json({ items });
    } catch (err) { next(err); }
  },

  async createItem(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const siteId = siteIdOf(req);
      const { ip, mac, customName, deviceType, notes } = req.body as CreateSiteItemInput;
      const item = await siteService.createManualItem(req.tenantId, siteId, {
        ip, mac, customName, deviceType, notes,
      });
      await auditService.logReq(req, {
        action: 'site_item.created',
        resourceType: 'site_item',
        resourceId: item.id,
        details: { siteId, ip: item.ip, mac: item.mac ?? null },
      });
      await recordManualItemEvent(req, siteId, {
        kind: 'created',
        itemId: item.id,
        mac: item.mac ?? null,
        ip: item.ip,
        details: { deviceType: item.deviceType },
      });
      emitSiteUpdated(req.tenantId, siteId);
      res.status(201).json({ item });
    } catch (err) {
      if (err instanceof DuplicateItemError) {
        res.status(409).json({ success: false, error: 'duplicate_item', existingId: err.existingId });
        return;
      }
      next(err);
    }
  },

  async updateItem(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const siteId = siteIdOf(req);
      const itemId = requireDbId(req.params.itemId, 'item ID');
      const data = req.body as UpdateSiteItemInput;
      const before = await itemAuditRow(req.tenantId, siteId, itemId);
      if (!before) throw new AppError(404, 'Item not found');
      const item = await siteService.updateItem(req.tenantId, siteId, itemId, data);
      if (!item) throw new AppError(404, 'Item not found');
      // Changed field names only; the notes text never reaches the log (its length does).
      const fields = (Object.keys(ITEM_AUDIT_FIELDS) as Array<keyof typeof ITEM_AUDIT_FIELDS>)
        .filter((f) => data[f] !== undefined && (data[f] ?? null) !== (before[ITEM_AUDIT_FIELDS[f]] ?? null));
      if (fields.length > 0) {
        await auditService.logReq(req, {
          action: 'site_item.updated',
          resourceType: 'site_item',
          resourceId: itemId,
          details: {
            siteId,
            ip: item.ip,
            mac: item.mac ?? null,
            fields,
            ...(fields.includes('notes') ? { notesLength: (item.notes ?? '').length } : {}),
          },
        });
        await recordManualItemEvent(req, siteId, {
          kind: 'edited',
          itemId,
          mac: item.mac ?? null,
          ip: item.ip,
          details: {
            fields,
            ...(fields.includes('deviceType') ? { deviceType: item.deviceType } : {}),
            ...(fields.includes('status') ? { status: item.status } : {}),
            ...(fields.includes('alertMode') ? { alertMode: item.alertMode ?? 'inherit' } : {}),
          },
        });
      }
      emitSiteUpdated(req.tenantId, siteId);
      res.json({ item });
    } catch (err) { next(err); }
  },

  async removeItem(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const siteId = siteIdOf(req);
      const itemId = requireDbId(req.params.itemId, 'item ID');
      const before = await itemAuditRow(req.tenantId, siteId, itemId);
      if (!before) throw new AppError(404, 'Item not found');
      const deleted = await siteService.deleteItem(req.tenantId, siteId, itemId);
      if (!deleted) throw new AppError(404, 'Item not found');
      await auditService.logReq(req, {
        action: 'site_item.deleted',
        resourceType: 'site_item',
        resourceId: itemId,
        details: { siteId, ip: before.ip, mac: before.mac },
      });
      // The row is gone: the event keeps its id in details (item_id NULL).
      await recordManualItemEvent(req, siteId, {
        kind: 'deleted',
        itemId: null,
        mac: before.mac,
        ip: before.ip,
        details: { itemId, name: itemDisplayName(before) },
      });
      emitSiteUpdated(req.tenantId, siteId);
      res.status(204).send();
    } catch (err) { next(err); }
  },

  async removeSubnet(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const siteId = siteIdOf(req);
      const prefix = req.query.prefix;
      if (typeof prefix !== 'string' || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(prefix)) {
        throw new AppError(400, 'prefix query param required (e.g. 192.168.1)');
      }
      const removed = await siteService.deleteItemsBySubnet(req.tenantId, siteId, prefix);
      const count = removed.length;
      await auditService.logReq(req, {
        action: 'site.subnet_deleted',
        resourceType: 'site',
        resourceId: siteId,
        details: { prefix, deleted: count },
      });
      // One 'deleted' event per device, written in one batch (the rows are gone: ids in details).
      if (count > 0) {
        await recordItemEvents(removed.map((r) => ({
          tenantId: req.tenantId,
          siteId,
          actorUserId: req.session.userId ?? null,
          kind: 'deleted' as const,
          itemId: null,
          mac: r.mac,
          ip: r.ip,
          details: { itemId: r.id, name: r.name, subnet: `${prefix}.0/24` },
        })));
      }
      res.json({ deleted: count });
    } catch (err) { next(err); }
  },

  // ── Reservations ──────────────────────────────────────────────────────────

  async listReservations(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const reservations = await siteService.getReservations(req.tenantId, siteIdOf(req));
      res.json({ reservations });
    } catch (err) { next(err); }
  },

  async createReservation(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const siteId = siteIdOf(req);
      const { ip, name, description, deviceType, reservedMac, itemId } = req.body as CreateReservationInput;
      const reservation = await siteService.createReservation(req.tenantId, siteId, {
        ip,
        name,
        description,
        deviceType,
        reservedMac,
        itemId,
        createdBy: req.session.userId!,
      });
      await auditService.logReq(req, {
        action: 'reservation.created',
        resourceType: 'site',
        resourceId: siteId,
        details: {
          reservationId: reservation.id,
          ip: reservation.ip,
          name: reservation.name,
          reservedMac: reservation.reservedMac ?? null,
          itemId: reservation.itemId ?? null,
        },
      });
      res.status(201).json({ reservation });
    } catch (err) { next(err); }
  },

  async updateReservation(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const siteId = siteIdOf(req);
      const data = req.body as UpdateReservationInput;
      const reservation = await siteService.updateReservation(
        req.tenantId,
        siteId,
        requireDbId(req.params.resId, 'reservation ID'),
        data,
      );
      if (!reservation) throw new AppError(404, 'Reservation not found');
      await auditService.logReq(req, {
        action: 'reservation.updated',
        resourceType: 'site',
        resourceId: siteId,
        details: { reservationId: reservation.id, ip: reservation.ip, name: reservation.name, fields: Object.keys(data) },
      });
      res.json({ reservation });
    } catch (err) { next(err); }
  },

  async removeReservation(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const siteId = siteIdOf(req);
      const removed = await siteService.deleteReservation(
        req.tenantId,
        siteId,
        requireDbId(req.params.resId, 'reservation ID'),
      );
      if (!removed) throw new AppError(404, 'Reservation not found');
      await auditService.logReq(req, {
        action: 'reservation.deleted',
        resourceType: 'site',
        resourceId: siteId,
        details: { reservationId: removed.id, ip: removed.ip, name: removed.name },
      });
      res.status(204).send();
    } catch (err) { next(err); }
  },
};
