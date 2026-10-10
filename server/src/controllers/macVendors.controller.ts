import type { Request, Response, NextFunction } from 'express';
import { db } from '../db';
import { AppError } from '../middleware/errorHandler';
import { auditService } from '../services/audit.service';
import {
  clearVendorLookupCache,
  normalizeOuiPrefix,
  registryStats,
  seedIfNeeded,
} from '../services/ouiRegistry.service';
import { clientIp } from '../utils/clientIp';
import { toDbId } from '../utils/dbId';
import type { MacVendor } from '@oblimap/shared';

// ── helpers ───────────────────────────────────────────────────────────────────

/** ':prefix' route parameter → the stored form ('AA:BB:CC', 'AA:BB:CC:D', 'AA:BB:CC:DD:E'). */
function prefixParam(raw: unknown): string {
  const norm = typeof raw === 'string' ? normalizeOuiPrefix(raw) : null;
  if (!norm) throw new AppError(404, 'OUI prefix not found');
  return norm.prefix;
}

function toMacVendor(row: Record<string, unknown>): MacVendor {
  const vendorName  = row.vendor_name as string;
  const customName  = (row.custom_name as string | null) ?? null;
  return {
    prefix:        row.prefix as string,
    vendorName,
    customName,
    effectiveName: customName ?? vendorName,
    updatedAt:     (row.updated_at as Date).toISOString(),
  };
}

// ── controller ────────────────────────────────────────────────────────────────

export const macVendorsController = {

  /**
   * GET /mac-vendors
   * Query params:
   *   q       — search term (prefix or vendor name)
   *   page    — 1-based page number (default: 1)
   *   limit   — items per page (default: 50, max: 200)
   *   overrideOnly — if "true", only return rows with a custom_name set
   */
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const q            = (req.query.q as string | undefined)?.trim() ?? '';
      const page         = Math.max(1, parseInt(req.query.page as string, 10) || 1);
      const limit        = Math.min(200, Math.max(1, parseInt(req.query.limit as string, 10) || 50));
      const overrideOnly = req.query.overrideOnly === 'true';
      const offset       = (page - 1) * limit;

      let query = db('mac_vendors');

      if (overrideOnly) {
        query = query.whereNotNull('custom_name');
      }

      if (q) {
        query = query.where(function () {
          this.where('prefix', 'ilike', `%${q}%`)
            .orWhere('vendor_name', 'ilike', `%${q}%`)
            .orWhere('custom_name', 'ilike', `%${q}%`);
        });
      }

      const [countRow] = await query.clone().count<[{ count: string }]>('prefix as count');
      const total = parseInt(countRow.count, 10);

      const rows = await query
        .orderByRaw("COALESCE(custom_name, vendor_name) ASC")
        .limit(limit)
        .offset(offset)
        .select('prefix', 'vendor_name', 'custom_name', 'updated_at');

      res.json({
        vendors: rows.map(toMacVendor),
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      });
    } catch (err) { next(err); }
  },

  /**
   * PATCH /mac-vendors/:prefix
   * Body: { customName: string | null }
   * Sets or clears the custom name override for a specific OUI prefix.
   * Returns 404 if the prefix doesn't exist in the IEEE table.
   */
  async updateCustomName(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const prefix = prefixParam(req.params.prefix);
      const existing = await db('mac_vendors').where({ prefix }).first();
      if (!existing) throw new AppError(404, 'OUI prefix not found');

      const { customName } = req.body as { customName?: string | null };
      const normalized = typeof customName === 'string' && customName.trim()
        ? customName.trim()
        : null;

      const [row] = await db('mac_vendors')
        .where({ prefix })
        .update({
          custom_name: normalized,
          updated_at: new Date(),
        })
        .returning('*');

      // Platform event (tenant_id NULL): the MAC-vendor table is shared by
      // every tenant (vendor-rule classification everywhere).
      const previous = (existing.custom_name as string | null) ?? null;
      if (previous !== normalized) {
        await auditService.logReq(req, {
          tenantId: null,
          action: normalized === null ? 'mac_vendor.override_cleared' : 'mac_vendor.override_set',
          resourceType: 'mac_vendor',
          resourceId: prefix,
          details: { prefix, vendorName: existing.vendor_name as string, from: previous, to: normalized },
        });
      }

      clearVendorLookupCache();
      res.json({ vendor: toMacVendor(row) });
    } catch (err) { next(err); }
  },

  /**
   * DELETE /mac-vendors/:prefix/override
   * Clears the custom name override (resets to IEEE default).
   */
  async clearOverride(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const prefix = prefixParam(req.params.prefix);
      const existing = await db('mac_vendors').where({ prefix }).first('custom_name', 'vendor_name') as
        { custom_name: string | null; vendor_name: string } | undefined;
      const updated = await db('mac_vendors')
        .where({ prefix })
        .update({ custom_name: null, updated_at: new Date() });
      if (!updated) throw new AppError(404, 'OUI prefix not found');
      if (existing?.custom_name) {
        await auditService.logReq(req, {
          tenantId: null,
          action: 'mac_vendor.override_cleared',
          resourceType: 'mac_vendor',
          resourceId: prefix,
          details: { prefix, vendorName: existing.vendor_name, from: existing.custom_name, to: null },
        });
      }
      clearVendorLookupCache();
      res.status(204).send();
    } catch (err) { next(err); }
  },

  /**
   * POST /mac-vendors/seed (platform admin)
   * Downloads the IEEE MA-L, MA-M and MA-S registries now and upserts them
   * (custom name overrides are preserved). Audited by the service
   * (mac_vendor.seeded, platform event). Returns { inserted, complete,
   * registries }; 502 when nothing could be downloaded.
   */
  async seed(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await seedIfNeeded({
        force: true,
        actor: { userId: toDbId(req.session?.userId), ipAddress: clientIp(req) || null },
      });
      if (result.registries.length === 0) {
        // Not a download problem (database error, logged by the service).
        res.status(500).json({ success: false, error: 'Registry seed failed' });
        return;
      }
      if (result.inserted === 0) {
        res.status(502).json({ success: false, error: 'IEEE registry download failed', registries: result.registries });
        return;
      }
      res.json({ inserted: result.inserted, complete: result.complete, registries: result.registries });
    } catch (err) { next(err); }
  },

  /**
   * GET /mac-vendors/stats
   * Returns aggregate stats: total entries, entries with overrides, last
   * updated, last complete IEEE download and rows per prefix length.
   */
  async stats(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // Two plain aggregates (knex .count({ x: db.raw('count(*) …') }) wraps
      // the raw expression in another count(): "aggregate function calls
      // cannot be nested").
      const totals = await db('mac_vendors')
        .select(
          db.raw('count(*)::int as total'),
          db.raw('count(*) filter (where custom_name is not null)::int as overrides'),
        )
        .first() as { total: number | string; overrides: number | string } | undefined;
      const lastRow = await db('mac_vendors')
        .orderBy('updated_at', 'desc')
        .first('updated_at');
      // Last complete IEEE download and rows per registry (24 = MA-L, 28 = MA-M, 36 = MA-S).
      const registry = await registryStats();

      res.json({
        total:     Number(totals?.total ?? 0) || 0,
        overrides: Number(totals?.overrides ?? 0) || 0,
        lastUpdated: lastRow ? (lastRow.updated_at as Date).toISOString() : null,
        lastSeededAt: registry.lastSeededAt,
        byPrefixBits: registry.byPrefixBits,
      });
    } catch (err) { next(err); }
  },
};
