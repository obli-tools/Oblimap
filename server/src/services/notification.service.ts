import type { Knex } from 'knex';
import { db } from '../db';
import type { NotificationChannel, NotificationBinding, NotificationOverrideMode } from '@oblimap/shared';
import type { NotificationPayload } from '../notifications/types';
import { getPlugin } from '../notifications/registry';
import { smtpServerService } from './smtpServer.service';
import { config } from '../config';
import { logger } from '../utils/logger';
import { AppError } from '../middleware/errorHandler';
import { assertPublicHttpUrl, TargetNotAllowedError } from '../utils/ssrfGuard';
import { toDbId } from '../utils/dbId';
import { liveAlertService } from './liveAlert.service';

type OverrideMode = NotificationOverrideMode;

/** Binding scopes of the IPAM model: Global → Group chain (root→leaf) → Site. */
export const BINDING_SCOPES = ['global', 'group', 'site'] as const;
export type BindingScope = typeof BINDING_SCOPES[number];

export function isBindingScope(scope: unknown): scope is BindingScope {
  return typeof scope === 'string' && (BINDING_SCOPES as readonly string[]).includes(scope);
}

/**
 * Outcome of one channel delivery in sendForSite. `error` is a generic label
 * ('Target not allowed', 'Delivery failed', ...): the details go to the server
 * log and to notification_log, never to API callers.
 */
export interface ChannelSendResult {
  channelId: number;
  ok: boolean;
  error?: string;
}

export interface ResolvedBindingSource {
  channelId: number;
  channelName: string;
  channelType: string;
  source: 'global' | 'group' | 'site';
  sourceId: number | null;
  sourceName: string;
  isDirect: boolean;
  isExcluded: boolean;
}

/** One level of the inheritance chain, for resolution with sources. */
interface ResolveLevel {
  bindings: NotificationBinding[];
  source: ResolvedBindingSource['source'];
  sourceId: number | null;
  sourceName: string;
  isDirect: boolean;
}

interface ChannelRow {
  id: number;
  name: string;
  type: string;
  config: Record<string, unknown> | string;
  is_enabled: boolean;
  created_by: number | null;
  tenant_id: number;
  created_at: Date;
  updated_at: Date;
}

interface BindingRow {
  id: number;
  tenant_id: number;
  channel_id: number;
  scope: string;
  scope_id: number | null;
  override_mode: string;
}

/** A channel as the dispatch code needs it: full (unredacted) config and owner tenant. */
interface SendableChannel {
  id: number;
  name: string;
  type: string;
  tenantId: number;
  config: Record<string, unknown>;
}

// ── Secret redaction ─────────────────────────────────────────────────────────
// (Obliance notification.service.ts redactConfig.) Channel configs carry bot
// tokens, API keys, webhook secrets... API responses and exports replace them
// with REDACTED; an update that sends REDACTED back keeps the stored value.

/** Placeholder returned instead of a stored secret. Sent back on update: "keep the stored value". */
export const REDACTED = '__REDACTED__';

// Keys whose name looks like a credential, on top of the plugin's `password`
// fields (covers legacy inline SMTP configs and hand-written imports).
// Discord / Slack / Teams `webhookUrl` values embed the posting token: they
// are credentials too. The generic webhook `url` and the Gotify / ntfy
// `serverUrl` stay visible (their secrets live in separate fields).
const SECRET_KEY_RE = /(secret|token|password|webhook|webhook_?url|api[_-]?key|pass)$/i;

// Keys that decide where a channel's secrets are delivered: the generic
// webhook URL, the Gotify / ntfy server, a legacy inline SMTP host, a chat
// webhook URL (itself a secret: sent back as REDACTED it is unchanged).
const TARGET_KEYS = ['url', 'serverUrl', 'webhookUrl', 'host'] as const;

function isSecretConfigKey(type: string, key: string): boolean {
  if (SECRET_KEY_RE.test(key)) return true;
  const plugin = getPlugin(type);
  return !!plugin?.configFields.some((f) => f.key === key && f.type === 'password');
}

/** The stored config as an object (jsonb column, or a JSON string from older rows). */
export function parseChannelConfig(raw: unknown): Record<string, unknown> {
  let value = raw;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

/** Copy of the config with every non-empty secret value replaced by REDACTED. */
export function redactChannelConfig(type: string, cfg: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cfg)) {
    const isSet = value !== null && value !== undefined && value !== '';
    out[key] = isSet && isSecretConfigKey(type, key) ? REDACTED : value;
  }
  return out;
}

/**
 * The incoming config with every REDACTED value replaced by the stored value
 * of the same key; a REDACTED value with nothing stored is dropped.
 */
export function restoreRedactedConfig(
  incoming: Record<string, unknown>,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value === REDACTED) {
      const previous = stored[key];
      if (previous !== undefined && previous !== REDACTED) out[key] = previous;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/** True when the config holds at least one REDACTED placeholder. */
export function hasRedactedValues(cfg: Record<string, unknown>): boolean {
  return Object.values(cfg).some((v) => v === REDACTED);
}

/**
 * True when `incoming` sends REDACTED placeholders back while moving the
 * channel to another destination than `stored` (a target key changed or was
 * left out). Restoring the placeholders would then deliver the stored secrets
 * (Authorization header, app token...) to a host chosen by someone who never
 * saw them: they must be re-entered instead.
 */
export function redactedSecretsRetargeted(
  incoming: Record<string, unknown>,
  stored: Record<string, unknown>,
): boolean {
  if (!hasRedactedValues(incoming)) return false;
  return TARGET_KEYS.some((key) => {
    const next = incoming[key];
    if (next === REDACTED) return false; // kept as stored
    return String(next ?? '') !== String(stored[key] ?? '');
  });
}

// ── Required config fields ─────────────────────────────────────────

/**
 * 400 { error: 'missing_config_field', field }: a required field of the
 * plugin (configFields[].required) is missing from the config being saved.
 */
export class MissingConfigFieldError extends AppError {
  constructor(public readonly field: string) {
    super(400, 'missing_config_field');
    this.name = 'MissingConfigFieldError';
  }
}

function isConfigValuePresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

/**
 * The first required config field of the plugin that `cfg` does not fill
 * (null when complete, or for an unknown type). Pure. Check the config as it
 * will be stored: on update, after restoring REDACTED placeholders (a
 * placeholder with nothing stored is dropped, so it counts as missing).
 */
export function missingRequiredConfigField(type: string, cfg: Record<string, unknown>): string | null {
  const plugin = getPlugin(type);
  if (!plugin) return null;
  for (const field of plugin.configFields) {
    if (field.required && !isConfigValuePresent(cfg[field.key])) return field.key;
  }
  return null;
}

/**
 * Copy of `incoming` where every secret key stored with a value but left out
 * of the update is sent as REDACTED (= keep the stored secret). Pure.
 */
export function withOmittedSecretsKept(
  type: string,
  incoming: Record<string, unknown>,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...incoming };
  for (const [key, value] of Object.entries(stored)) {
    if (Object.prototype.hasOwnProperty.call(incoming, key)) continue;
    if (!isConfigValuePresent(value) || value === REDACTED) continue;
    if (isSecretConfigKey(type, key)) out[key] = REDACTED;
  }
  return out;
}

/**
 * The config an update stores (pure): REDACTED placeholders restored from
 * `stored`; secrets left out of the update are kept as well, unless the
 * update moves the channel to another target (then they are dropped, as
 * before: stored secrets never follow to a new destination). Throws 400 when
 * explicit placeholders are sent back with a new target (unchanged rule).
 */
export function mergeUpdatedChannelConfig(
  type: string,
  incoming: Record<string, unknown>,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  if (redactedSecretsRetargeted(incoming, stored)) {
    throw new AppError(400, 'Secret fields must be re-entered when the target changes');
  }
  const withKept = withOmittedSecretsKept(type, incoming, stored);
  if (redactedSecretsRetargeted(withKept, stored)) return restoreRedactedConfig(incoming, stored);
  return restoreRedactedConfig(withKept, stored);
}

/** True when an smtp channel config does not reference an SMTP server (legacy inline host / credentials). */
function isInlineSmtpConfig(type: string, cfg: Record<string, unknown>): boolean {
  const id = cfg.smtpServerId;
  return type === 'smtp' && (id === undefined || id === null || id === '');
}

// ── Row mapping ──────────────────────────────────────────────────────────────

/** API view of a channel: secrets redacted; tenantId / isShared relative to currentTenantId. */
function rowToChannel(row: ChannelRow, currentTenantId?: number): NotificationChannel {
  const ch: NotificationChannel = {
    id: row.id,
    name: row.name,
    type: row.type,
    config: redactChannelConfig(row.type, parseChannelConfig(row.config)),
    isEnabled: row.is_enabled,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
  if (currentTenantId !== undefined) {
    ch.tenantId = row.tenant_id;
    ch.isShared = row.tenant_id !== currentTenantId;
  }
  return ch;
}

function rowToSendable(row: ChannelRow): SendableChannel {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    tenantId: row.tenant_id,
    config: parseChannelConfig(row.config),
  };
}

function rowToBinding(row: BindingRow): NotificationBinding {
  return {
    id: row.id,
    channelId: row.channel_id,
    scope: row.scope as NotificationBinding['scope'],
    scopeId: row.scope_id,
    overrideMode: row.override_mode as OverrideMode,
  };
}

/** Channels a tenant may use: its own plus those shared to it (notification_channel_tenants). */
function whereAccessibleTo(tenantId: number) {
  return (qb: Knex.QueryBuilder): void => {
    qb.where('notification_channels.tenant_id', tenantId)
      .orWhereIn(
        'notification_channels.id',
        db('notification_channel_tenants').select('channel_id').where({ tenant_id: tenantId }),
      );
  };
}

/** Config key holding the URL each HTTP plugin sends to (plugins/webhook.ts fetchNotificationTarget). */
const CHANNEL_TARGET_KEY: Readonly<Record<string, string>> = {
  webhook: 'url',
  gotify: 'serverUrl',
  ntfy: 'serverUrl',
  discord: 'webhookUrl',
  slack: 'webhookUrl',
  teams: 'webhookUrl',
};

/** Generic label for a delivery failure (API results); the details stay server-side. */
function publicSendError(err: unknown): string {
  return err instanceof TargetNotAllowedError ? 'Target not allowed' : 'Delivery failed';
}

/** Server-side description of a delivery failure (logs, notification_log). */
function describeSendError(err: unknown): string {
  if (err instanceof TargetNotAllowedError) return `Target not allowed: ${err.reason}`;
  return err instanceof Error ? err.message : 'Unknown error';
}

/** One delivery of a channel, as the API shows it (no target, no message). */
export interface NotificationLogEntry {
  id: number;
  status: 'sent' | 'failed';
  createdAt: string;
  /** null when sent; else 'ssrf_blocked' | 'timeout' | 'http_<status>' | 'auth_failed' | 'error'. */
  errorCode: string | null;
}

export const NOTIFICATION_LOG_DEFAULT_LIMIT = 50;
export const NOTIFICATION_LOG_MAX_LIMIT = 200;

/**
 * Short code of a stored delivery error (describeSendError text). The stored
 * text may hold target URLs or server answers: only the code leaves the
 * server.
 */
export function notificationErrorCode(error: string | null | undefined): string {
  const text = String(error ?? '');
  if (/^Target not allowed/i.test(text)) return 'ssrf_blocked';
  const status = /\breturned (\d{3})\b/.exec(text);
  if (status) return `http_${status[1]}`;
  if (/\b(EAUTH|Invalid login|authentication (failed|unsuccessful)|535)\b/i.test(text)) return 'auth_failed';
  if (/time(d)?[ -]?out|ETIMEDOUT|ESOCKETTIMEDOUT|aborted/i.test(text)) return 'timeout';
  return 'error';
}

export const notificationService = {
  // ── Channel CRUD ──

  async getAllChannels(tenantId: number): Promise<NotificationChannel[]> {
    // Own channels + channels shared to this tenant via the junction table
    const rows = await db<ChannelRow>('notification_channels')
      .where(whereAccessibleTo(tenantId))
      .orderBy('name');
    return rows.map((row) => rowToChannel(row, tenantId));
  },

  /**
   * API view of one channel (secrets redacted). NOT tenant-gated: request
   * handlers must run assertChannelAccess (notifications.controller.ts) on
   * the result before exposing or mutating it.
   */
  async getChannelById(id: number, currentTenantId?: number): Promise<NotificationChannel | null> {
    const row = await db<ChannelRow>('notification_channels').where({ id }).first();
    return row ? rowToChannel(row, currentTenantId) : null;
  },

  /** True when the channel belongs to the tenant or is shared to it. */
  async isChannelAccessible(channelId: number, tenantId: number): Promise<boolean> {
    const row = await db('notification_channels')
      .where({ id: channelId })
      .where(whereAccessibleTo(tenantId))
      .first('id');
    return !!row;
  },

  /** True when the channel is shared to the tenant (not owned by it). */
  async isChannelSharedWith(channelId: number, tenantId: number): Promise<boolean> {
    const row = await db('notification_channel_tenants')
      .where({ channel_id: channelId, tenant_id: tenantId })
      .first('channel_id');
    return !!row;
  },

  /**
   * SMTP settings of a channel config being saved. An smtp channel must send
   * through an SMTP server of the channel's tenant (smtp_servers): inline
   * host / credentials (legacy format) are no longer accepted, so an arbitrary
   * host:port cannot be set on a channel. Legacy channels already stored keep
   * sending. An smtpServerId on any channel must belong to the tenant.
   */
  async _assertSmtpServerOwned(type: string, cfg: Record<string, unknown>, tenantId: number): Promise<void> {
    if (isInlineSmtpConfig(type, cfg)) throw new AppError(400, 'Select an SMTP server');
    const raw = cfg.smtpServerId;
    if (raw === undefined || raw === null || raw === '') return;
    const id = toDbId(raw);
    if (id === null) throw new AppError(400, 'Invalid SMTP server');
    const server = await db('smtp_servers').where({ id, tenant_id: tenantId }).first('id');
    if (!server) throw new AppError(400, 'SMTP server not found');
  },

  async createChannel(data: {
    name: string;
    type: string;
    config: Record<string, unknown>;
    isEnabled?: boolean;
    createdBy?: number;
  }, tenantId: number): Promise<NotificationChannel> {
    const plugin = getPlugin(data.type);
    if (!plugin) throw new AppError(400, `Unknown notification type: ${data.type}`);
    // A placeholder has nothing to stand for on a new channel.
    if (hasRedactedValues(data.config)) throw new AppError(400, 'Secret fields must be filled in');
    await this._assertSmtpServerOwned(data.type, data.config, tenantId);
    const missing = missingRequiredConfigField(data.type, data.config);
    if (missing) throw new MissingConfigFieldError(missing);

    const [row] = await db<ChannelRow>('notification_channels')
      .insert({
        name: data.name,
        type: data.type,
        config: JSON.stringify(data.config),
        is_enabled: data.isEnabled ?? true,
        created_by: data.createdBy ?? null,
        tenant_id: tenantId,
      })
      .returning('*');

    return rowToChannel(row, tenantId);
  },

  /**
   * Updates a channel owned by the tenant. REDACTED config values keep the
   * stored secret, unless the same request changes the channel's target.
   */
  async updateChannel(id: number, data: {
    name?: string;
    config?: Record<string, unknown>;
    isEnabled?: boolean;
  }, tenantId: number): Promise<NotificationChannel | null> {
    const existing = await db<ChannelRow>('notification_channels').where({ id, tenant_id: tenantId }).first();
    if (!existing) return null;

    const updateData: Record<string, unknown> = { updated_at: new Date() };
    if (data.name !== undefined) updateData.name = data.name;
    if (data.config !== undefined) {
      const stored = parseChannelConfig(existing.config);
      const merged = mergeUpdatedChannelConfig(existing.type, data.config, stored);
      await this._assertSmtpServerOwned(existing.type, merged, tenantId);
      const missing = missingRequiredConfigField(existing.type, merged);
      if (missing) throw new MissingConfigFieldError(missing);
      updateData.config = JSON.stringify(merged);
    }
    if (data.isEnabled !== undefined) updateData.is_enabled = data.isEnabled;

    const [row] = await db<ChannelRow>('notification_channels')
      .where({ id, tenant_id: tenantId })
      .update(updateData)
      .returning('*');
    return row ? rowToChannel(row, tenantId) : null;
  },

  async deleteChannel(id: number, tenantId: number): Promise<boolean> {
    const count = await db('notification_channels').where({ id, tenant_id: tenantId }).del();
    return count > 0;
  },

  // ── Cross-tenant channel sharing ──

  /** Returns the list of tenant IDs the channel is shared to (not including its own tenant). */
  async getChannelTenants(channelId: number): Promise<number[]> {
    const rows = await db('notification_channel_tenants')
      .where({ channel_id: channelId })
      .select('tenant_id');
    return rows.map((r: { tenant_id: number }) => r.tenant_id);
  },

  /**
   * Replaces the sharing list of a channel (full replace — not additive).
   * Unknown tenant ids and the owner tenant are ignored. Tenants that lose
   * access also lose their bindings to the channel. Returns the stored list.
   */
  async setChannelTenants(channelId: number, ownerTenantId: number, tenantIds: number[]): Promise<number[]> {
    const wanted = [...new Set(tenantIds)].filter((id) => id !== ownerTenantId);
    const existing: number[] = wanted.length > 0
      ? (await db('tenants').whereIn('id', wanted).pluck('id') as number[])
      : [];
    await db.transaction(async (trx) => {
      await trx('notification_channel_tenants').where({ channel_id: channelId }).del();
      if (existing.length > 0) {
        await trx('notification_channel_tenants').insert(
          existing.map((tenant_id) => ({ channel_id: channelId, tenant_id })),
        );
      }
      await trx('notification_bindings')
        .where({ channel_id: channelId })
        .whereNot({ tenant_id: ownerTenantId })
        .whereNotIn('tenant_id', existing)
        .del();
    });
    return existing;
  },

  /**
   * Resolve the effective config for a channel.
   * For smtp channels using smtpServerId, fetches the SMTP server (it must
   * belong to the channel's tenant) and injects its credentials.
   * For all other channels, returns config as-is (backward-compat).
   */
  async resolveChannelConfig(channel: SendableChannel): Promise<Record<string, unknown>> {
    if (channel.type === 'smtp' && channel.config.smtpServerId) {
      const serverId = toDbId(channel.config.smtpServerId);
      const server = serverId !== null
        ? await smtpServerService.getTransportConfig(serverId, channel.tenantId)
        : null;
      if (!server) throw new Error(`SMTP server #${String(channel.config.smtpServerId)} not found for the channel's tenant`);
      return {
        host: server.host,
        port: server.port,
        secure: server.secure,
        username: server.username,
        password: server.password,
        from: channel.config.fromOverride || server.fromAddress,
        to: channel.config.to,
      };
    }
    return channel.config;
  },

  /** Sends a test message. Access must have been checked by the caller (assertChannelAccess 'read'). */
  async testChannel(id: number): Promise<void> {
    const row = await db<ChannelRow>('notification_channels').where({ id }).first();
    if (!row) throw new AppError(404, 'Channel not found');

    const channel = rowToSendable(row);
    const plugin = getPlugin(channel.type);
    if (!plugin) throw new Error(`No plugin for type: ${channel.type}`);
    // A legacy inline SMTP config connects to whatever host:port it holds: the
    // test button must not turn it into an on-demand internal TCP probe.
    if (isInlineSmtpConfig(channel.type, channel.config)) throw new AppError(400, 'Select an SMTP server');

    const resolvedConfig = await this.resolveChannelConfig(channel);
    await plugin.sendTest(resolvedConfig);
  },

  // ── Bindings ──

  async getBindings(scope: string, scopeId: number | null, tenantId: number): Promise<NotificationBinding[]> {
    const rows = await db<BindingRow>('notification_bindings')
      .where({ tenant_id: tenantId, scope, scope_id: scopeId });
    return rows.map(rowToBinding);
  },

  /** Validates a binding target: global ⇔ no scopeId; a group / site must belong to the tenant. */
  async _assertScopeInTenant(scope: string, scopeId: number | null, tenantId: number): Promise<void> {
    if (!isBindingScope(scope)) throw new AppError(400, 'Invalid scope');
    if (scope === 'global') {
      if (scopeId !== null) throw new AppError(400, 'scopeId must be null for the global scope');
      return;
    }
    const id = toDbId(scopeId);
    if (id === null) throw new AppError(400, 'Invalid scopeId');
    const table = scope === 'group' ? 'monitor_groups' : 'sites';
    const row = await db(table).where({ id, tenant_id: tenantId }).first('id');
    if (!row) throw new AppError(404, scope === 'group' ? 'Group not found' : 'Site not found');
  },

  /**
   * Binds a channel at a scope of the tenant (upsert on the unique index of
   * migration 034). The channel must be owned by or shared to the tenant.
   */
  async addBinding(
    channelId: number,
    scope: string,
    scopeId: number | null,
    tenantId: number,
    overrideMode: OverrideMode = 'merge',
  ): Promise<NotificationBinding> {
    await this._assertScopeInTenant(scope, scopeId, tenantId);
    if (!(await this.isChannelAccessible(channelId, tenantId))) {
      throw new AppError(404, 'Channel not found');
    }

    const [row] = await db<BindingRow>('notification_bindings')
      .insert({
        tenant_id: tenantId,
        channel_id: channelId,
        scope,
        scope_id: scopeId,
        override_mode: overrideMode,
      })
      .onConflict(['tenant_id', 'channel_id', 'scope', 'scope_id'])
      .merge({ override_mode: overrideMode })
      .returning('*');
    return rowToBinding(row);
  },

  async removeBinding(channelId: number, scope: string, scopeId: number | null, tenantId: number): Promise<boolean> {
    const count = await db('notification_bindings')
      .where({ tenant_id: tenantId, channel_id: channelId, scope, scope_id: scopeId })
      .del();
    return count > 0;
  },

  // ── Resolution (merge/replace/exclude inheritance) ──

  /**
   * Apply a set of bindings to the current channel set.
   * 1. If any binding has 'replace' mode → clear the set first
   * 2. Add all 'merge' (and 'replace') bindings to the set
   * 3. Remove all 'exclude' bindings from the set
   */
  _applyBindings(channelIds: Set<number>, bindings: NotificationBinding[]): Set<number> {
    if (bindings.length === 0) return channelIds;

    const hasReplace = bindings.some((b) => b.overrideMode === 'replace');
    if (hasReplace) {
      channelIds = new Set();
    }

    // Add merge/replace bindings
    for (const b of bindings) {
      if (b.overrideMode !== 'exclude') {
        channelIds.add(b.channelId);
      }
    }

    // Remove exclude bindings
    for (const b of bindings) {
      if (b.overrideMode === 'exclude') {
        channelIds.delete(b.channelId);
      }
    }

    return channelIds;
  },

  /**
   * Ancestors of a group of the tenant, root → leaf, with their names.
   * includeSelf=false leaves the group itself out.
   */
  async _groupChain(groupId: number, tenantId: number, includeSelf: boolean): Promise<Array<{ id: number; name: string }>> {
    const q = db('group_closure as gc')
      .join('monitor_groups as g', 'g.id', 'gc.ancestor_id')
      .where('gc.descendant_id', groupId)
      .where('g.tenant_id', tenantId)
      .orderBy('gc.depth', 'desc')
      .select('gc.ancestor_id as id', 'g.name as name');
    if (!includeSelf) q.where('gc.depth', '>', 0);
    return await q as Array<{ id: number; name: string }>;
  },

  /**
   * Resolve channels for an IPAM site event.
   * Chain: Global → site's group ancestors (root→leaf, including self) → Site.
   * Every level reads the bindings of the site's tenant only.
   */
  async resolveChannelsForSite(tenantId: number, siteGroupId: number | null, siteId?: number | null): Promise<number[]> {
    let channelIds: Set<number> = new Set();

    // Always apply the tenant's global bindings
    const globalBindings = await this.getBindings('global', null, tenantId);
    channelIds = this._applyBindings(channelIds, globalBindings);

    // Apply group chain if site is assigned to a group
    if (siteGroupId !== null) {
      for (const group of await this._groupChain(siteGroupId, tenantId, true)) {
        const groupBindings = await this.getBindings('group', group.id, tenantId);
        channelIds = this._applyBindings(channelIds, groupBindings);
      }
    }

    // Apply site-level bindings
    if (siteId) {
      const siteBindings = await this.getBindings('site', siteId, tenantId);
      channelIds = this._applyBindings(channelIds, siteBindings);
    }

    return Array.from(channelIds);
  },

  // ── Send notifications ──

  /**
   * Dispatch an IPAM notification (new device, offline, IP conflict, device
   * check...) via the channels resolved for the site. Each channel is
   * delivered and logged independently: one failure never stops the others.
   * Returns one result per enabled channel the tenant may use.
   */
  async sendForSite(
    tenantId: number,
    siteGroupId: number | null,
    payload: NotificationPayload,
    siteId?: number | null,
  ): Promise<ChannelSendResult[]> {
    const channelIds = await this.resolveChannelsForSite(tenantId, siteGroupId, siteId);
    if (channelIds.length === 0) return [];

    const enriched: NotificationPayload = { ...payload, appName: config.appName, isIpamNotification: true };

    // A binding can outlive the sharing of its channel: only channels the
    // tenant owns or that are shared to it are used.
    const channels = await db<ChannelRow>('notification_channels')
      .whereIn('id', channelIds)
      .where({ is_enabled: true })
      .where(whereAccessibleTo(tenantId));

    const results: ChannelSendResult[] = [];
    for (const row of channels) {
      try {
        const channel = rowToSendable(row);
        const plugin = getPlugin(channel.type);
        if (!plugin) {
          logger.warn(`No plugin for notification type "${channel.type}"`);
          results.push({ channelId: row.id, ok: false, error: 'Unknown channel type' });
          continue;
        }

        const resolvedConfig = await this.resolveChannelConfig(channel);
        await plugin.send(resolvedConfig, enriched);
        results.push({ channelId: row.id, ok: true });
        logger.info(`IPAM notification sent: ${channel.name} (${channel.type}) — ${payload.monitorName}`);
        await this.logNotification(row.id, null, 'ipam_event', true, undefined, tenantId);
      } catch (error) {
        const errMsg = describeSendError(error);
        results.push({ channelId: row.id, ok: false, error: publicSendError(error) });
        logger.error(`IPAM notification failed: ${row.name} (${row.type}): ${errMsg}`);
        await this.logNotification(row.id, null, 'ipam_event', false, errMsg, tenantId);
      }
    }
    return results;
  },

  // ── Resolution with sources (for the UI) ──

  /**
   * Walks the inheritance levels and records, for each channel, the level it
   * comes from and whether a later level excludes it. Channels the tenant can
   * no longer use (sharing withdrawn) are left out.
   */
  async _resolveWithSources(tenantId: number, levels: ResolveLevel[]): Promise<ResolvedBindingSource[]> {
    type SourceInfo = Omit<ResolvedBindingSource, 'channelName' | 'channelType'>;
    const result: Map<number, SourceInfo> = new Map();

    for (const level of levels) {
      const { bindings } = level;
      if (bindings.length === 0) continue;

      if (bindings.some((b) => b.overrideMode === 'replace')) {
        result.clear();
      }

      for (const b of bindings) {
        if (b.overrideMode !== 'exclude') {
          result.set(b.channelId, {
            channelId: b.channelId,
            source: level.source,
            sourceId: level.sourceId,
            sourceName: level.sourceName,
            isDirect: level.isDirect,
            isExcluded: false,
          });
        }
      }

      // Excluded channels stay in the result (the UI shows them) but are flagged
      for (const b of bindings) {
        if (b.overrideMode === 'exclude') {
          const existing = result.get(b.channelId);
          if (existing) existing.isExcluded = true;
        }
      }
    }

    const channelIds = Array.from(result.keys());
    if (channelIds.length === 0) return [];

    const channels = await db<ChannelRow>('notification_channels')
      .whereIn('id', channelIds)
      .where(whereAccessibleTo(tenantId))
      .select('id', 'name', 'type');
    const channelMap = new Map(channels.map((c) => [c.id, c]));

    return Array.from(result.values())
      .filter((r) => channelMap.has(r.channelId))
      .map((r) => {
        const ch = channelMap.get(r.channelId)!;
        return { ...r, channelName: ch.name, channelType: ch.type };
      });
  },

  /**
   * Resolve bindings for a group WITH source info (for the UI).
   * Chain: Global → parent groups (root→leaf) → the group itself.
   */
  async resolveBindingsWithSources(
    scope: 'group',
    scopeId: number,
    tenantId: number,
  ): Promise<ResolvedBindingSource[]> {
    await this._assertScopeInTenant(scope, scopeId, tenantId);

    const levels: ResolveLevel[] = [];
    levels.push({ bindings: await this.getBindings('global', null, tenantId), source: 'global', sourceId: null, sourceName: 'Global', isDirect: false });
    for (const group of await this._groupChain(scopeId, tenantId, false)) {
      levels.push({
        bindings: await this.getBindings('group', group.id, tenantId),
        source: 'group',
        sourceId: group.id,
        sourceName: group.name || `Group #${group.id}`,
        isDirect: false,
      });
    }
    levels.push({ bindings: await this.getBindings('group', scopeId, tenantId), source: 'group', sourceId: scopeId, sourceName: 'Direct', isDirect: true });

    return this._resolveWithSources(tenantId, levels);
  },

  /**
   * Resolve bindings for a site WITH source info (for the UI).
   * Chain: Global → Group ancestors (root→leaf) → Site-level bindings.
   */
  async resolveBindingsWithSourcesForSite(siteId: number, tenantId: number): Promise<ResolvedBindingSource[]> {
    const siteRow = await db('sites').where({ id: siteId, tenant_id: tenantId }).select('group_id').first() as { group_id: number | null } | undefined;
    if (!siteRow) throw new AppError(404, 'Site not found');

    const levels: ResolveLevel[] = [];
    levels.push({ bindings: await this.getBindings('global', null, tenantId), source: 'global', sourceId: null, sourceName: 'Global', isDirect: false });
    if (siteRow.group_id) {
      for (const group of await this._groupChain(siteRow.group_id, tenantId, true)) {
        levels.push({
          bindings: await this.getBindings('group', group.id, tenantId),
          source: 'group',
          sourceId: group.id,
          sourceName: group.name || `Group #${group.id}`,
          isDirect: false,
        });
      }
    }
    levels.push({ bindings: await this.getBindings('site', siteId, tenantId), source: 'site', sourceId: siteId, sourceName: 'Direct', isDirect: true });

    return this._resolveWithSources(tenantId, levels);
  },

  /**
   * Latest deliveries of one channel, newest first, sanitized (status, time,
   * error code). The caller checks the channel access first
   * (notifications.controller.ts loadChannel 'read'). `onlyTenantId` set (a
   * tenant the channel is shared with) keeps the deliveries of that tenant's
   * events only; null (owner tenant, platform admin) = every delivery.
   */
  async getChannelLog(
    channelId: number,
    limit: number = NOTIFICATION_LOG_DEFAULT_LIMIT,
    onlyTenantId: number | null = null,
  ): Promise<NotificationLogEntry[]> {
    const n = Math.min(NOTIFICATION_LOG_MAX_LIMIT, Math.max(1, Math.trunc(Number(limit)) || NOTIFICATION_LOG_DEFAULT_LIMIT));
    const query = db('notification_log').where({ channel_id: channelId });
    if (onlyTenantId !== null) query.where({ tenant_id: onlyTenantId });
    const rows = await query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(n)
      .select('id', 'success', 'error', 'created_at') as Array<{ id: number | string; success: boolean; error: string | null; created_at: Date | string }>;
    return rows.map((r) => ({
      id: Number(r.id),
      status: r.success ? 'sent' : 'failed',
      createdAt: new Date(r.created_at).toISOString(),
      errorCode: r.success ? null : notificationErrorCode(r.error),
    }));
  },

  /** Records a delivery attempt. Never throws: logging must not stop the dispatch loop. */
  async logNotification(
    channelId: number,
    monitorId: number | null,
    eventType: string,
    success: boolean,
    error?: string,
    tenantId: number | null = null,
  ): Promise<void> {
    try {
      await db('notification_log').insert({
        channel_id: channelId,
        tenant_id: tenantId,
        monitor_id: monitorId,
        event_type: eventType.slice(0, 32),
        success,
        error: error ? error.slice(0, 2000) : null,
      });
    } catch (err) {
      logger.warn({ err: (err as Error)?.message, channelId }, 'notification_log insert failed');
    }
  },

  /**
   * Startup check (index.ts): enabled channels whose target the SSRF guard
   * refuses as local (LAN Gotify / ntfy / webhook…). They were delivered to
   * before the guard existed and now fail with "Target not allowed", which
   * only shows in the server log and notification_log: each one is reported
   * loudly in the log and by a live alert in the channel's tenant. The URL
   * itself is never logged (chat webhook URLs embed a token). Never throws.
   */
  async warnBlockedChannelTargets(): Promise<number> {
    let blocked = 0;
    try {
      const rows = await db<ChannelRow>('notification_channels')
        .where({ is_enabled: true })
        .whereIn('type', Object.keys(CHANNEL_TARGET_KEY))
        .select('id', 'name', 'type', 'config', 'tenant_id');
      for (const row of rows) {
        const target = parseChannelConfig(row.config)[CHANNEL_TARGET_KEY[row.type]];
        if (typeof target !== 'string' || !target.trim()) continue;
        try {
          await assertPublicHttpUrl(target, { allowPrivate: false });
          continue;
        } catch (err) {
          // Only local targets: an unresolvable host may be a transient DNS
          // failure, an invalid URL never worked.
          if (!(err instanceof TargetNotAllowedError)
            || !(err.reason === 'localhost' || err.reason.includes('private address'))) continue;
          blocked++;
          logger.warn(
            { channelId: row.id, tenantId: row.tenant_id, type: row.type, reason: err.reason },
            `[config] Notification channel "${row.name}" targets a local address and is blocked by the SSRF protection: nothing is delivered to it. If this internal target is intended, add its host to SSRF_ALLOWLIST.`,
          );
        }
        await liveAlertService.add(row.tenant_id, {
          severity: 'warning',
          title: `Notification channel blocked: ${row.name}`.slice(0, 255),
          message: `Notification channel "${row.name}" points to a local network address, which the server refuses (SSRF protection): its notifications are not delivered. `
            + 'If this target is intended, the server administrator must add its host to SSRF_ALLOWLIST and restart the server.',
          navigateTo: '/notifications',
          stableKey: `channel-target-blocked:${row.id}`,
          siteId: null,
          kind: 'channel_target_blocked',
          params: { channelName: String(row.name ?? '') },
        }).catch((err) => logger.warn({ err: (err as Error)?.message, channelId: row.id }, 'Blocked channel live alert failed'));
      }
    } catch (err) {
      logger.warn({ err: (err as Error)?.message }, 'Notification channel target check failed');
    }
    return blocked;
  },
};
