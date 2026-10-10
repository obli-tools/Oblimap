import type { Request, Response, NextFunction } from 'express';
import { appConfigService, type ObligateConfigPatch } from '../services/appConfig.service';
import { auditService } from '../services/audit.service';
import { obligateService } from '../services/obligate.service';
import { AppError } from '../middleware/errorHandler';

/** Length bounds of the Obligate inbound secret (the UI applies the same rule). */
const INBOUND_SECRET_MIN = 32;
const INBOUND_SECRET_MAX = 256;

const ALLOWED_KEYS = [
  'allow_2fa', 'force_2fa', 'otp_smtp_server_id',
  'obligate_enabled',
] as const;

export const appConfigController = {
  async getAll(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const cfg = await appConfigService.getAll();
      res.json({ success: true, data: cfg });
    } catch (err) { next(err); }
  },

  async set(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const key = req.params.key as typeof ALLOWED_KEYS[number];
      if (!ALLOWED_KEYS.includes(key)) throw new AppError(400, `Unknown config key: ${key}`);
      const { value } = req.body;
      if (value === undefined) throw new AppError(400, 'Missing value');
      const before = key === 'obligate_enabled' ? await appConfigService.get(key) : null;
      await appConfigService.set(key, String(value));
      if (key === 'obligate_enabled' && (before === 'true') !== (String(value) === 'true')) {
        await auditService.logReq(req, {
          tenantId: null, // platform-wide setting
          action: 'obligate.config_updated',
          resourceType: 'obligate',
          details: { fields: ['enabled'] },
        });
      }
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  // ── Obligate SSO gateway ───────────────────────────────────────────────────

  async getObligateConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const cfg = await appConfigService.getObligateConfig();
      res.json({ success: true, data: cfg });
    } catch (err) { next(err); }
  },

  /**
   * PUT /admin/config/obligate — every field optional (absent = unchanged):
   *   url, apiKey ('' / null keep the key), enabled (boolean only),
   *   inboundSecret: 32-256 visible ASCII characters sets it, null clears it
   *     ('' keeps it); never the API key nor its public client id (400).
   *     Write-only: the answer only says inboundSecretSet.
   * The browser-facing client_id is always sha256(API key): the former
   * clientIdMode field is gone, 'raw' is refused (400), any other value is
   * ignored.
   * Audited (obligate.config_updated) with the names of the changed settings,
   * never their values.
   */
  async setObligateConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: ObligateConfigPatch = {};
      if ('url' in body) patch.url = optionalString(body.url, 'url');
      if ('apiKey' in body) patch.apiKey = optionalString(body.apiKey, 'apiKey');
      // Strict boolean: a truthy non-boolean (e.g. the string "false") must
      // not switch SSO on.
      if ('enabled' in body) {
        if (typeof body.enabled !== 'boolean') throw new AppError(400, 'enabled must be a boolean');
        patch.enabled = body.enabled;
      }
      // The client_id is always the public id sha256(API key): an older client
      // asking for the raw form is told so; any other value is ignored.
      if (typeof body.clientIdMode === 'string' && body.clientIdMode.trim().toLowerCase() === 'raw') {
        throw new AppError(400, 'The raw API key can no longer be sent as client_id: the client_id is always sha256(API key)');
      }
      // Distinct inbound secret (Obligate → this server): a non-empty string
      // sets it, null clears it (the API key is then expected again), an
      // empty string keeps it (same as the API key field).
      if ('inboundSecret' in body) {
        const s = body.inboundSecret;
        if (s !== null && typeof s !== 'string') throw new AppError(400, 'inboundSecret must be a string or null');
        if (s === null) {
          patch.inboundSecret = null;
        } else {
          const trimmed = s.trim();
          if (trimmed) {
            if (trimmed.length < INBOUND_SECRET_MIN || trimmed.length > INBOUND_SECRET_MAX) {
              throw new AppError(400, `inboundSecret must be ${INBOUND_SECRET_MIN} to ${INBOUND_SECRET_MAX} characters long`);
            }
            if (!/^[\x21-\x7e]+$/.test(trimmed)) {
              throw new AppError(400, 'inboundSecret must only contain visible ASCII characters (no spaces)');
            }
            patch.inboundSecret = trimmed;
          }
        }
      }

      // patchObligateConfig also refuses (400) an inbound secret equal to the
      // API key or to its public client id, under its lock with the write.
      const { config: updated, changed } = await appConfigService.patchObligateConfig(patch);
      if (changed.length > 0) {
        await auditService.logReq(req, {
          tenantId: null, // platform-wide setting
          action: 'obligate.config_updated',
          resourceType: 'obligate',
          details: { fields: changed },
        });
        // New Obligate URL / key: announce our accent color there (non-blocking).
        void obligateService.announceSelfInfo();
      }
      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  },
};

/** A string setting of the Obligate PUT: trimmed; null / '' → null. */
function optionalString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new AppError(400, `${field} must be a string or null`);
  return value.trim() || null;
}
