import type { Request, Response, NextFunction } from 'express';
import type { NotificationChannel } from '@oblimap/shared';
import {
  notificationService,
  isBindingScope,
  MissingConfigFieldError,
  NOTIFICATION_LOG_DEFAULT_LIMIT,
  NOTIFICATION_LOG_MAX_LIMIT,
} from '../services/notification.service';
import { auditService } from '../services/audit.service';
import { getPluginMetas } from '../notifications/registry';
import { AppError } from '../middleware/errorHandler';
import { TargetNotAllowedError } from '../utils/ssrfGuard';
import { requireDbId, toDbId, toDbIds } from '../utils/dbId';
import { logger } from '../utils/logger';
import type {
  CreateChannelInput,
  UpdateChannelInput,
  AddBindingInput,
  RemoveBindingInput,
} from '../validators/notification.schema';

type ChannelAccessMode = 'read' | 'write';

/**
 * Tenant gate for every handler that exposes or acts on one channel (Obliance
 * notifications.controller.ts assertChannelVisible / assertChannelOwnedByCaller).
 * notificationService.getChannelById is not tenant-scoped, so it runs first:
 *   - write (edit, delete, sharing): the channel's own tenant only;
 *   - read  (view, test): the owner, or a tenant the channel is shared with.
 * Anything else is a 404, the same answer as a missing id.
 */
async function assertChannelAccess(
  req: Request,
  channel: NotificationChannel | null,
  mode: ChannelAccessMode,
): Promise<NotificationChannel> {
  if (!channel) throw new AppError(404, 'Channel not found');
  if (channel.tenantId === req.tenantId) return channel;
  if (mode === 'read' && await notificationService.isChannelSharedWith(channel.id, req.tenantId)) return channel;
  throw new AppError(404, 'Channel not found');
}

/** The channel of req.params.id, after the tenant gate. */
async function loadChannel(req: Request, mode: ChannelAccessMode): Promise<NotificationChannel> {
  const id = requireDbId(req.params.id, 'channel id');
  const channel = await notificationService.getChannelById(id, req.tenantId);
  return assertChannelAccess(req, channel, mode);
}

export const notificationsController = {
  // GET /api/notifications/plugins — list available plugin types
  async plugins(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const metas = getPluginMetas();
      res.json({ success: true, data: metas });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/notifications/channels — own + shared channels, secrets redacted
  async listChannels(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const channels = await notificationService.getAllChannels(req.tenantId);
      res.json({ success: true, data: channels });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/notifications/channels/:id — secrets redacted
  async getChannel(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const channel = await loadChannel(req, 'read');
      res.json({ success: true, data: channel });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/notifications/channels/:id/log?limit=50 (max 200) — latest
  // deliveries, sanitized: status, time, short error code. Same gate as the
  // channel GET (owner, or a tenant the channel is shared with). A tenant the
  // channel is shared with only sees the deliveries of its own events; the
  // owner tenant and platform admins see every delivery.
  async getChannelLog(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const channel = await loadChannel(req, 'read');
      const raw = req.query.limit;
      let limit = NOTIFICATION_LOG_DEFAULT_LIMIT;
      if (raw !== undefined) {
        const parsed = typeof raw === 'string' && /^\d{1,4}$/.test(raw) ? Number(raw) : NaN;
        if (!Number.isInteger(parsed) || parsed < 1) throw new AppError(400, 'Invalid limit');
        limit = Math.min(parsed, NOTIFICATION_LOG_MAX_LIMIT);
      }
      const fullView = channel.tenantId === req.tenantId || req.session.role === 'admin';
      const entries = await notificationService.getChannelLog(channel.id, limit, fullView ? null : req.tenantId);
      res.json({ success: true, data: entries });
    } catch (err) {
      next(err);
    }
  },

  // POST /api/notifications/channels
  async createChannel(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = req.body as CreateChannelInput;
      const channel = await notificationService.createChannel({
        ...data,
        createdBy: req.session.userId!,
      }, req.tenantId);
      void auditService.logReq(req, {
        action: 'notification.channel_created',
        resourceType: 'notification_channel',
        resourceId: channel.id,
        details: { name: channel.name, type: channel.type },
      });
      res.status(201).json({ success: true, data: channel });
    } catch (err) {
      if (err instanceof MissingConfigFieldError) {
        res.status(400).json({ success: false, error: 'missing_config_field', field: err.field });
        return;
      }
      next(err);
    }
  },

  // PUT /api/notifications/channels/:id — owner tenant only; '__REDACTED__' keeps a stored secret
  async updateChannel(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const existing = await loadChannel(req, 'write');
      const data = req.body as UpdateChannelInput;
      const channel = await notificationService.updateChannel(existing.id, data, req.tenantId);
      if (!channel) throw new AppError(404, 'Channel not found');
      void auditService.logReq(req, {
        action: 'notification.channel_updated',
        resourceType: 'notification_channel',
        resourceId: channel.id,
        details: {
          name: channel.name,
          fields: Object.keys(data),
          ...(data.isEnabled !== undefined && { isEnabled: data.isEnabled }),
        },
      });
      res.json({ success: true, data: channel });
    } catch (err) {
      if (err instanceof MissingConfigFieldError) {
        res.status(400).json({ success: false, error: 'missing_config_field', field: err.field });
        return;
      }
      next(err);
    }
  },

  // DELETE /api/notifications/channels/:id — owner tenant only
  async deleteChannel(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const existing = await loadChannel(req, 'write');
      const deleted = await notificationService.deleteChannel(existing.id, req.tenantId);
      if (!deleted) throw new AppError(404, 'Channel not found');
      void auditService.logReq(req, {
        action: 'notification.channel_deleted',
        resourceType: 'notification_channel',
        resourceId: existing.id,
        details: { name: existing.name, type: existing.type },
      });
      res.json({ success: true, message: 'Channel deleted' });
    } catch (err) {
      next(err);
    }
  },

  // POST /api/notifications/channels/:id/test — owner or shared tenant
  async testChannel(req: Request, res: Response, next: NextFunction): Promise<void> {
    let channel: NotificationChannel;
    try {
      channel = await loadChannel(req, 'read');
    } catch (err) {
      next(err);
      return;
    }
    try {
      await notificationService.testChannel(channel.id);
      void auditService.logReq(req, {
        action: 'notification.channel_tested',
        resourceType: 'notification_channel',
        resourceId: channel.id,
        details: { ok: true },
      });
      res.json({ success: true, message: 'Test notification sent' });
    } catch (err: unknown) {
      void auditService.logReq(req, {
        action: 'notification.channel_tested',
        resourceType: 'notification_channel',
        resourceId: channel.id,
        details: { ok: false },
      });
      // The failure details (resolved address, remote status / body, library
      // message) stay in the server log: echoing them would turn the test
      // button into an internal network probe.
      if (err instanceof TargetNotAllowedError) {
        logger.warn({ channelId: channel.id, type: channel.type, reason: err.reason }, 'Notification test refused: target not allowed');
        next(err);
      } else if (err instanceof AppError) {
        next(err);
      } else {
        logger.warn(
          { channelId: channel.id, type: channel.type, err: err instanceof Error ? err.message : String(err) },
          'Notification test failed',
        );
        next(new AppError(400, 'Delivery failed'));
      }
    }
  },

  // GET /api/notifications/channels/:id/tenants — list tenant IDs the channel is shared to (owner only)
  async getChannelTenants(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const channel = await loadChannel(req, 'write');
      const tenantIds = await notificationService.getChannelTenants(channel.id);
      res.json({ success: true, data: tenantIds });
    } catch (err) {
      next(err);
    }
  },

  // PUT /api/notifications/channels/:id/tenants — replace sharing list (owner only)
  async setChannelTenants(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const channel = await loadChannel(req, 'write');
      const tenantIds = toDbIds(req.body?.tenantIds ?? []);
      if (tenantIds === null || tenantIds.length > 1000) {
        throw new AppError(400, 'tenantIds must be an array of tenant ids');
      }
      const applied = await notificationService.setChannelTenants(channel.id, req.tenantId, tenantIds);
      void auditService.logReq(req, {
        action: 'notification.channel_sharing_changed',
        resourceType: 'notification_channel',
        resourceId: channel.id,
        details: { tenantIds: applied },
      });
      res.json({ success: true, message: 'Channel tenants updated' });
    } catch (err) {
      next(err);
    }
  },

  // ── Bindings ──

  // GET /api/notifications/bindings?scope=global|group|site&scopeId=... — this tenant's bindings
  async listBindings(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const scope = req.query.scope;
      if (!isBindingScope(scope)) throw new AppError(400, 'Invalid scope');
      let scopeId: number | null = null;
      if (scope !== 'global') {
        scopeId = toDbId(req.query.scopeId);
        if (scopeId === null) throw new AppError(400, 'Invalid scopeId');
      }
      const bindings = await notificationService.getBindings(scope, scopeId, req.tenantId);
      res.json({ success: true, data: bindings });
    } catch (err) {
      next(err);
    }
  },

  // POST /api/notifications/bindings — channel owned by / shared to the tenant, scope in the tenant
  async addBinding(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = req.body as AddBindingInput;
      const binding = await notificationService.addBinding(
        data.channelId,
        data.scope,
        data.scopeId,
        req.tenantId,
        data.overrideMode,
      );
      void auditService.logReq(req, {
        action: 'notification.binding_added',
        resourceType: 'notification_channel',
        resourceId: data.channelId,
        details: { scope: data.scope, scopeId: data.scopeId, overrideMode: binding.overrideMode },
      });
      res.status(201).json({ success: true, data: binding });
    } catch (err) {
      next(err);
    }
  },

  // DELETE /api/notifications/bindings — this tenant's binding only
  async removeBinding(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = req.body as RemoveBindingInput;
      const removed = await notificationService.removeBinding(data.channelId, data.scope, data.scopeId, req.tenantId);
      if (removed) {
        void auditService.logReq(req, {
          action: 'notification.binding_removed',
          resourceType: 'notification_channel',
          resourceId: data.channelId,
          details: { scope: data.scope, scopeId: data.scopeId },
        });
      }
      res.json({ success: true, message: removed ? 'Binding removed' : 'Binding not found' });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/notifications/bindings/resolved?scope=group|site&scopeId=N
  async resolvedBindings(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const scope = req.query.scope;
      const scopeId = toDbId(req.query.scopeId);

      if ((scope !== 'group' && scope !== 'site') || scopeId === null) {
        throw new AppError(400, 'Missing or invalid scope / scopeId');
      }

      // Site scope: global → group hierarchy → site. Group scope: global → parent groups → group.
      const resolved = scope === 'site'
        ? await notificationService.resolveBindingsWithSourcesForSite(scopeId, req.tenantId)
        : await notificationService.resolveBindingsWithSources('group', scopeId, req.tenantId);
      res.json({ success: true, data: resolved });
    } catch (err) {
      next(err);
    }
  },
};
