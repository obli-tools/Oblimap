import type { Request, Response, NextFunction } from 'express';
import { settingsService } from '../services/settings.service';
import { auditService } from '../services/audit.service';
import { tenantAdminEventRooms } from '../services/tenant.service';
import { SOCKET_EVENTS } from '@oblimap/shared';
import type { SettingsScope } from '@oblimap/shared';
import type { SettingsKey } from '@oblimap/shared';
import { AppError } from '../middleware/errorHandler';
import { requireDbId, toDbId } from '../utils/dbId';
import type { SetSettingInput, SetSettingsBulkInput } from '../validators/settings.schema';
import {
  invalidateSiteCheckSettings,
  pushConfigToAffectedProbes,
  scopeSiteIds,
} from '../services/deviceChecks/config.service';
import { logger } from '../utils/logger';
import { db } from '../db';
import { EFFECTIVE_SCAN_KEYS, probeService } from '../services/probe.service';

/** Settings that are part of the scan config a probe receives. */
const SCAN_SETTING_KEYS = new Set<string>(EFFECTIVE_SCAN_KEYS);

/**
 * After a write touching a scan key (interval, subnets, port scan, flows):
 * send a fresh config_update to the WS-connected probes the scope covers, so
 * they apply it now instead of at their next scan report. HTTP-mode probes
 * get it with their next push. Not awaited; never throws.
 */
function refreshProbeScanConfig(tenantId: number, scope: SettingsScope, scopeId: number | null, keys: string[]): void {
  if (!keys.some((k) => SCAN_SETTING_KEYS.has(k))) return;
  void (async () => {
    let probeIds: number[];
    if (scope === 'monitor') {
      if (scopeId === null) return;
      probeIds = [scopeId];
    } else {
      const siteIds = scope === 'site' && scopeId !== null
        ? [scopeId]
        : scope === 'group' && scopeId !== null
          ? await scopeSiteIds(tenantId, { groupId: scopeId, siteId: null })
          : 'all' as const;
      if (siteIds !== 'all' && siteIds.length === 0) return;
      const q = db('probes').where({ tenant_id: tenantId, status: 'approved' });
      if (siteIds !== 'all') q.whereIn('site_id', siteIds);
      const rows = await q.select('id') as Array<{ id: number | string }>;
      probeIds = rows.map((r) => Number(r.id));
    }
    if (probeIds.length > 0) await probeService.pushConfigToProbes(tenantId, probeIds);
  })().catch((err: unknown) =>
    logger.warn({ err: (err as Error)?.message, tenantId, scope }, 'Probe config push after a settings change failed'));
}

/** Settings that change which devices the probes check, and when alerts fire. */
const DEVICE_CHECK_SETTING_KEYS = new Set<string>(['deviceChecksEnabled', 'businessHours']);

/**
 * After a write touching deviceChecksEnabled / businessHours: drop the cached
 * site settings and re-send the Device Checks assignment to the connected
 * probes of the affected sites, instead of waiting for their next config
 * build. Probe-level ('monitor') overrides do not drive device checks.
 * Not awaited; never throws.
 */
function refreshDeviceChecks(tenantId: number, scope: SettingsScope, scopeId: number | null, keys: string[]): void {
  if (!keys.some((k) => DEVICE_CHECK_SETTING_KEYS.has(k))) return;
  invalidateSiteCheckSettings(tenantId);
  if (scope === 'monitor') return;
  void (async () => {
    const siteIds = scope === 'site' && scopeId !== null
      ? [scopeId]
      : scope === 'group' && scopeId !== null
        ? await scopeSiteIds(tenantId, { groupId: scopeId, siteId: null })
        : 'all' as const;
    await pushConfigToAffectedProbes(tenantId, siteIds);
  })().catch((err: unknown) =>
    logger.warn({ err: (err as Error)?.message, tenantId, scope }, 'Device checks config push after a settings change failed'));
}

function parseScope(req: Request): { scope: SettingsScope; scopeId: number | null } {
  const { scope, scopeId } = req.params;

  if (scope === 'global') return { scope: 'global', scopeId: null };
  // 'monitor' = probe-level overrides (historical scope name, read by resolveForProbe)
  if (scope === 'group' || scope === 'site' || scope === 'monitor') {
    const id = toDbId(scopeId);
    if (id === null) throw new AppError(400, 'Invalid scope ID');
    return { scope, scopeId: id };
  }
  throw new AppError(400, 'Invalid scope. Must be global, group, site, or monitor');
}

/**
 * Settings events stay inside the tenant: its admins and the members holding
 * the 'settings' capability (who may read and write them through the API).
 */
function emitSettingsUpdated(req: Request, payload: Record<string, unknown>): void {
  const io = req.app.get('io');
  if (io) {
    io.to(tenantAdminEventRooms(req.tenantId, 'settings')).emit(SOCKET_EVENTS.SETTINGS_UPDATED, payload);
  }
}

async function auditSettingsUpdated(
  req: Request,
  scope: SettingsScope,
  scopeId: number | null,
  keys: string[],
  extra?: Record<string, unknown>,
): Promise<void> {
  await auditService.logReq(req, {
    action: 'settings.updated',
    resourceType: 'settings',
    resourceId: scopeId === null ? scope : `${scope}:${scopeId}`,
    details: { scope, scopeId, keys, ...extra },
  });
}

export const settingsController = {
  // GET /api/settings/global/resolved
  async getGlobalResolved(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await settingsService.resolveGlobal(req.tenantId);
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/settings/group/:scopeId/resolved
  async getGroupResolved(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const groupId = requireDbId(req.params.scopeId, 'group ID');
      const result = await settingsService.resolveForGroup(req.tenantId, groupId);
      res.json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/settings/site/:scopeId/resolved
  async getSiteResolved(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const siteId = requireDbId(req.params.scopeId, 'site ID');
      await settingsService.assertScope(req.tenantId, 'site', siteId);

      const resolved = await settingsService.resolveForSite(req.tenantId, siteId);
      const overrides = await settingsService.getByScope(req.tenantId, 'site', siteId);

      res.json({ success: true, data: { resolved, overrides } });
    } catch (err) {
      next(err);
    }
  },

  // PUT /api/settings/:scope/:scopeId
  async set(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { scope, scopeId } = parseScope(req);
      const { key, value } = req.body as SetSettingInput;

      const stored = await settingsService.set(req.tenantId, scope, scopeId, key as SettingsKey, value);

      await auditSettingsUpdated(req, scope, scopeId, [key]);
      emitSettingsUpdated(req, { scope, scopeId, key, value: stored });
      refreshDeviceChecks(req.tenantId, scope, scopeId, [key]);
      refreshProbeScanConfig(req.tenantId, scope, scopeId, [key]);

      res.json({ success: true, message: 'Setting saved' });
    } catch (err) {
      next(err);
    }
  },

  // PUT /api/settings/:scope/:scopeId/bulk
  async setBulk(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { scope, scopeId } = parseScope(req);
      const { overrides } = req.body as SetSettingsBulkInput;

      const stored = await settingsService.setBulk(
        req.tenantId,
        scope,
        scopeId,
        overrides.map((o) => ({ key: o.key as SettingsKey, value: o.value })),
      );

      const keys = [...new Set(stored.map((o) => o.key))];
      await auditSettingsUpdated(req, scope, scopeId, keys);
      emitSettingsUpdated(req, { scope, scopeId, overrides: stored });
      refreshDeviceChecks(req.tenantId, scope, scopeId, keys);
      refreshProbeScanConfig(req.tenantId, scope, scopeId, keys);

      res.json({ success: true, message: 'Settings saved' });
    } catch (err) {
      next(err);
    }
  },

  // DELETE /api/settings/:scope/:scopeId/:key  (reset to inherited)
  async remove(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { scope, scopeId } = parseScope(req);
      const { key } = req.params;

      const deleted = await settingsService.remove(req.tenantId, scope, scopeId, key);

      if (deleted) {
        await auditSettingsUpdated(req, scope, scopeId, [key], { removed: true });
        emitSettingsUpdated(req, { scope, scopeId, key, removed: true });
        refreshDeviceChecks(req.tenantId, scope, scopeId, [key]);
        refreshProbeScanConfig(req.tenantId, scope, scopeId, [key]);
      }

      res.json({ success: true, message: deleted ? 'Setting reset to inherited' : 'No override found' });
    } catch (err) {
      next(err);
    }
  },
};
