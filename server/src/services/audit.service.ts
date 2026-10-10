import type { Request } from 'express';
import { db } from '../db';
import { logger } from '../utils/logger';
import { clientIp } from '../utils/clientIp';
import { toDbId } from '../utils/dbId';

// Audit trail (port of Obliance services/audit.service.ts, adapted: tenant is
// optional for platform events, probe_id instead of device_id, resource_id
// instead of resource_path, secrets redacted from details, cursor paging).
//
// Action names are dotted, domain first: 'auth.login', 'auth.login_failed',
// 'user.password_changed', 'probe.key_mismatch', 'tunnel.opened', ...
// Keep secrets out of `details`. As a safety net, every key ending in
// password / secret / token / apikey / api_key / key (or password/token hash)
// is replaced by '[redacted]' at any depth — so name non-secret identifiers
// accordingly (`keys`, `settingName`, `keyId` are kept; `key`, `stableKey`
// are redacted). Strings are truncated to 500 characters.

export interface AuditEntry {
  tenantId?: number | null;
  userId?: number | null;
  probeId?: number | null;
  action: string;
  resourceType?: string | null;
  resourceId?: string | number | null;
  details?: Record<string, unknown> | null;
  ipAddress?: string | null;
}

/** Row returned by the audit API (same shape as AuditLogEntry in @oblimap/shared). */
export interface AuditLogEntry {
  id: number;
  tenantId: number | null;
  userId: number | null;
  username: string | null;
  probeId: number | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
}

export interface AuditListFilter {
  /** Cursor: only rows with id < before (the previous page's nextCursor). */
  before?: number;
  /** Page size, 1..200 (default 50). */
  limit?: number;
  /** Prefix match on the action ('user.' → every user action). */
  action?: string;
  resourceType?: string;
  userId?: number;
}

// Secret key names, plus password/token hash spellings (a hash of a secret is not for the log either).
const SECRET_KEY_RE = /(password|passwd|secret|token|apikey|api_key|key|password_?hash|token_?hash)$/i;
const MAX_STRING = 500;
const MAX_DEPTH = 6;
const MAX_ARRAY = 100;
const MAX_KEYS = 100;
const MAX_DETAILS_JSON = 16_384;

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Redacts secret-looking keys and truncates strings, recursively. */
function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return truncate(value, MAX_STRING);
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY).map((v) => sanitizeValue(v, depth + 1));
    if (value.length > MAX_ARRAY) items.push(`[${value.length - MAX_ARRAY} more]`);
    return items;
  }
  if (typeof value === 'object') {
    if (Buffer.isBuffer(value)) return '[binary]';
    return sanitizeObject(value as Record<string, unknown>, depth + 1);
  }
  return null; // functions, symbols
}

function sanitizeObject(obj: Record<string, unknown>, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (n++ >= MAX_KEYS) { out._truncated = true; break; }
    if (v === undefined || typeof v === 'function') continue;
    out[k] = SECRET_KEY_RE.test(k) ? '[redacted]' : sanitizeValue(v, depth);
  }
  return out;
}

/** Exported for tests: the details object as it is stored. */
export function sanitizeAuditDetails(details: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const clean = sanitizeObject(details, 0);
  const json = JSON.stringify(clean);
  if (json.length > MAX_DETAILS_JSON) return { _truncated: true, size: json.length };
  return clean;
}

function optString(v: string | number | null | undefined, max: number): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s === '' ? null : truncate(s, max);
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function rowToEntry(r: Record<string, unknown>): AuditLogEntry {
  let details = r.details as unknown;
  if (typeof details === 'string') {
    try { details = JSON.parse(details); } catch { details = null; }
  }
  const created = r.created_at;
  return {
    id: Number(r.id),
    tenantId: (r.tenant_id as number | null) ?? null,
    userId: (r.user_id as number | null) ?? null,
    username: (r.username as string | null) ?? null,
    probeId: (r.probe_id as number | null) ?? null,
    action: r.action as string,
    resourceType: (r.resource_type as string | null) ?? null,
    resourceId: (r.resource_id as string | null) ?? null,
    details: (details && typeof details === 'object' ? details : null) as Record<string, unknown> | null,
    ipAddress: (r.ip_address as string | null) ?? null,
    createdAt: created instanceof Date ? created.toISOString() : new Date(String(created)).toISOString(),
  };
}

export const auditService = {
  /**
   * Writes one audit entry. NEVER throws: auditing must not break the request
   * being audited (table missing during an upgrade, FK race, ...). Failures
   * are logged as warnings.
   */
  async log(entry: AuditEntry): Promise<void> {
    try {
      const action = typeof entry.action === 'string' ? entry.action.trim().slice(0, 100) : '';
      if (!action) {
        logger.warn('Audit entry without action ignored');
        return;
      }
      const details = sanitizeAuditDetails(entry.details);
      await db('audit_logs').insert({
        tenant_id: toDbId(entry.tenantId),
        user_id: toDbId(entry.userId),
        probe_id: toDbId(entry.probeId),
        action,
        resource_type: optString(entry.resourceType, 50),
        resource_id: optString(entry.resourceId, 64),
        details: details ? JSON.stringify(details) : null,
        ip_address: optString(entry.ipAddress, 45),
      });
    } catch (err) {
      logger.warn({ err: (err as Error)?.message, action: entry?.action }, 'Audit log write failed');
    }
  },

  /**
   * Route helper: tenant from req.tenantId, else the session's current tenant
   * (null outside a tenant), user from the session, IP from clientIp(req).
   * A field given explicitly in `entry` (including null) wins. Never throws.
   */
  async logReq(req: Request, entry: AuditEntry): Promise<void> {
    let tenantId: number | null = null;
    let userId: number | null = null;
    let ipAddress: string | null = null;
    try {
      tenantId = toDbId(req.tenantId) ?? toDbId(req.session?.currentTenantId) ?? null;
      userId = toDbId(req.session?.userId);
      ipAddress = clientIp(req) || null;
    } catch { /* keep the defaults */ }
    await auditService.log({
      ...entry,
      tenantId: entry.tenantId !== undefined ? entry.tenantId : tenantId,
      userId: entry.userId !== undefined ? entry.userId : userId,
      ipAddress: entry.ipAddress !== undefined ? entry.ipAddress : ipAddress,
    });
  },

  /**
   * Newest first, cursor-paged on id. tenantId null = every tenant, including
   * platform events without a tenant (platform-admin view only).
   */
  async list(tenantId: number | null, f: AuditListFilter = {}): Promise<{ items: AuditLogEntry[]; nextCursor: number | null }> {
    const limit = Math.min(200, Math.max(1, Math.trunc(Number(f.limit) || 50)));

    const q = db('audit_logs as al')
      .leftJoin('users as u', 'u.id', 'al.user_id')
      .select('al.*', 'u.username');
    if (tenantId !== null) q.where('al.tenant_id', tenantId);
    if (f.before !== undefined) q.where('al.id', '<', f.before);
    // Backslash is PostgreSQL's default LIKE escape character.
    if (f.action) q.where('al.action', 'like', `${escapeLike(f.action)}%`);
    if (f.resourceType) q.where('al.resource_type', f.resourceType);
    if (f.userId !== undefined) q.where('al.user_id', f.userId);

    const rows = await q.orderBy('al.id', 'desc').limit(limit + 1) as Record<string, unknown>[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(rowToEntry);
    return { items, nextCursor: hasMore && items.length > 0 ? items[items.length - 1].id : null };
  },

  /** Retention: deletes entries older than `days` days. Returns the count. */
  async purgeOlderThan(days: number): Promise<number> {
    const d = Math.max(1, Math.trunc(Number(days) || 0));
    const deleted = await db('audit_logs')
      .where('created_at', '<', new Date(Date.now() - d * 86_400_000))
      .delete();
    return Number(deleted) || 0;
  },
};
