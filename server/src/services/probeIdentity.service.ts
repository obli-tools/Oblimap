import type { IncomingHttpHeaders } from 'http';
import { db } from '../db';
import { logger } from '../utils/logger';
import { auditService } from './audit.service';
import { obligateService } from './obligate.service';
import { probeCredentialsMatch, type ProbeRow } from './probeAuth.service';

// Obli* device identity v2 — Oblimap server side (same model as
// Obliance, adapted to probes).
//
// An upgraded probe keeps its legacy UUID (X-Probe-UUID) until we answer its
// push with X-Obli-Device-Id-Ack. Until then it sends the shared ID it wants
// (X-Obli-Device-Id) and the IDs it claims to have used before
// (X-Obli-Previous-Ids). A claimed row is re-keyed ("adopted") only when the
// request's credentials may act for it (API key binding + the row's identity
// token) AND the hostname matches: a machine sharing a junk SMBIOS UUID with
// another must not take over the other's history.
//
// The identity token belongs to the probes row (token_hash / pending hash,
// keyed by probes.id), not to the UUID string: re-keying probes.uuid keeps it
// valid, and the probe goes on presenting the same token under the new UUID.

export const IDENTITY_HEADER_TARGET = 'x-obli-device-id';
export const IDENTITY_HEADER_PREVIOUS = 'x-obli-previous-ids';
export const IDENTITY_HEADER_ACK = 'X-Obli-Device-Id-Ack';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_CLAIMS = 8;

export interface IdentityClaim {
  target: string;
  claims: string[];
}

/**
 * What the push is about:
 *  - ignore: the v2 headers are ignored for this push (no ack) — the probe
 *    stays on its legacy UUID, exactly as a v1 probe would: never worse than v1;
 *  - probe: this row, keyed by the shared ID (already, or adopted just now);
 *  - register: nothing adoptable — register a new row under the shared ID.
 */
export type PushIdentityResult =
  | { kind: 'ignore' }
  | { kind: 'probe'; probe: ProbeRow; adoptedFrom: string | null }
  | { kind: 'register'; uuid: string };

function normUuid(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return UUID_RE.test(s) ? s : null;
}

function shortHost(h: unknown): string {
  return typeof h === 'string' ? h.trim().toLowerCase().split('.')[0] : '';
}

// Refused claims are audited once an hour per (row, target, reason): the
// probe repeats the same claim on every push until something changes.
const REFUSAL_AUDIT_MS = 60 * 60 * 1000;
const lastRefusalAt = new Map<string, number>();
function refusalAuditDue(key: string): boolean {
  const now = Date.now();
  const last = lastRefusalAt.get(key);
  if (last !== undefined && now - last < REFUSAL_AUDIT_MS) return false;
  if (lastRefusalAt.size >= 5_000) lastRefusalAt.clear();
  lastRefusalAt.set(key, now);
  return true;
}

async function refuseClaim(
  row: { id: number; tenant_id: number },
  old: string,
  target: string,
  reason: 'api_key' | 'token' | 'hostname' | 'status',
  extra: Record<string, unknown>,
  ip: string | null,
): Promise<void> {
  if (!refusalAuditDue(`${row.id}:${target}:${reason}`)) return;
  logger.warn({ probeId: row.id, old, target, reason, ...extra }, 'identity v2: probe claim refused');
  await auditService.log({
    tenantId: row.tenant_id,
    probeId: row.id,
    action: 'probe.identity_claim_refused',
    resourceType: 'probe',
    resourceId: row.id,
    details: { from: old, to: target, reason, ...extra },
    ipAddress: ip,
  });
}

/** Moves the live control WebSocket(s) of the probe to its new UUID. */
async function followHub(probeId: number, newUuid: string): Promise<void> {
  try {
    const { rekeyProbeConnections } = await import('./probeHub.service');
    rekeyProbeConnections(probeId, newUuid);
  } catch (err) {
    logger.warn({ err: (err as Error)?.message, probeId }, 'identity v2: probe WS re-key failed');
  }
}

export const probeIdentityService = {
  /** Reads the v2 headers; null when absent or malformed (v1 probe). */
  parseHeaders(headers: IncomingHttpHeaders): IdentityClaim | null {
    const t = headers[IDENTITY_HEADER_TARGET];
    const target = normUuid(Array.isArray(t) ? t[0] : t);
    if (!target) return null;
    const raw = headers[IDENTITY_HEADER_PREVIOUS];
    const list = (Array.isArray(raw) ? raw.join(',') : (raw ?? '')).slice(0, 2048).split(',');
    const claims: string[] = [];
    for (const c of list) {
      const u = normUuid(c);
      if (u && u !== target && !claims.includes(u)) claims.push(u);
      if (claims.length >= MAX_CLAIMS) break;
    }
    return { target, claims };
  },

  /**
   * Decides which row the push is about, adopting a claimed row when
   * allowed. Called by the HTTP push only, after authenticateProbe resolved
   * `authProbe` (the row of X-Probe-UUID, or of the shared ID through its
   * alias for a replayed push; null when unknown) and once the payload —
   * hence the hostname — is validated.
   */
  async resolvePush(opts: {
    tenantId: number;
    apiKeyId: number;
    probeToken: string | undefined;
    hostname: string;
    claim: IdentityClaim;
    authProbe: ProbeRow | null;
    ip: string | null;
  }): Promise<PushIdentityResult> {
    const { tenantId, apiKeyId, probeToken, hostname, claim, authProbe, ip } = opts;
    const { target, claims } = claim;

    // 1. Already keyed by the shared ID (normal case after the switch, or a
    //    replay after a lost ack). probes.uuid is unique across tenants.
    const existing = await db('probes').where({ uuid: target }).first() as ProbeRow | undefined;
    if (existing) {
      if (existing.tenant_id !== tenantId) {
        logger.warn({ target, tenantId, ownerTenant: existing.tenant_id },
          'identity v2: shared ID already enrolled in another tenant — switch not acknowledged');
        return { kind: 'ignore' };
      }
      if (authProbe?.id !== existing.id && !probeCredentialsMatch(existing, apiKeyId, probeToken)) {
        logger.warn({ probeId: existing.id, target, apiKeyId },
          'identity v2: shared ID held by a probe these credentials may not act for — switch not acknowledged');
        return { kind: 'ignore' };
      }
      return { kind: 'probe', probe: existing, adoptedFrom: null };
    }

    // 2. Adopt the first claimable row.
    const host = shortHost(hostname);
    for (const old of claims) {
      const row = await db('probes').where({ uuid: old, tenant_id: tenantId }).first() as ProbeRow | undefined;
      if (!row) continue;
      if (row.status === 'refused' || row.status === 'suspended') {
        await refuseClaim(row, old, target, 'status', { status: row.status }, ip);
        continue;
      }
      if (row.api_key_id != null && row.api_key_id !== apiKeyId) {
        await refuseClaim(row, old, target, 'api_key', {}, ip);
        continue;
      }
      // The row authenticateProbe resolved already passed the token check;
      // any other claimed row must accept this request's identity token.
      if (authProbe?.id !== row.id && !probeCredentialsMatch(row, apiKeyId, probeToken)) {
        await refuseClaim(row, old, target, 'token', {}, ip);
        continue;
      }
      if (!host || shortHost(row.hostname) !== host) {
        await refuseClaim(row, old, target, 'hostname', { rowHostname: row.hostname ?? null, hostname: hostname || null }, ip);
        continue;
      }
      let adopted: ProbeRow | null = null;
      try {
        adopted = await db.transaction(async (trx) => {
          // Re-check under lock: two pushes racing for the same row.
          const locked = await trx('probes').where({ id: row.id, uuid: old, tenant_id: tenantId }).forUpdate().first('id');
          if (!locked) return null;
          await trx('probe_uuid_aliases').insert({ probe_id: row.id, tenant_id: tenantId, uuid: old, reason: 'migrated' });
          const updates: Record<string, unknown> = { uuid: target, updated_at: new Date() };
          // Same re-bind authenticateProbe does for a probe whose key was deleted.
          if (row.api_key_id == null) updates.api_key_id = apiKeyId;
          const [updated] = await trx('probes').where({ id: row.id }).update(updates).returning('*') as ProbeRow[];
          return updated ?? null;
        });
      } catch (err) {
        // 23505: the shared ID was registered concurrently — treated as case 1 on the next push.
        logger.warn({ err: (err as Error)?.message, probeId: row.id, old, target }, 'identity v2: probe re-key failed');
        return { kind: 'ignore' };
      }
      if (!adopted) continue;
      logger.info({ probeId: row.id, from: old, to: target }, 'identity v2: probe re-keyed to the shared device ID');
      await followHub(row.id, target);
      await auditService.log({
        tenantId,
        probeId: row.id,
        action: 'probe.identity_migrated',
        resourceType: 'probe',
        resourceId: row.id,
        details: { from: old, to: target },
        ipAddress: ip,
      });
      // The old link stays registered: apps that have not migrated yet still
      // match this machine through it.
      if (adopted.status === 'approved') {
        obligateService.registerDeviceLink(target, `/manage/probes/${row.id}`).catch(() => {});
      }
      return { kind: 'probe', probe: adopted, adoptedFrom: old };
    }

    // 3. Nothing adoptable: the caller registers a new row under the shared ID.
    return { kind: 'register', uuid: target };
  },

  /** Previous UUIDs of a probe (newest first). */
  async aliasesOf(probeId: number): Promise<string[]> {
    const rows = await db('probe_uuid_aliases').where({ probe_id: probeId })
      .orderBy('created_at', 'desc').orderBy('id', 'desc').select('uuid') as Array<{ uuid: string }>;
    return [...new Set(rows.map((r) => String(r.uuid).toLowerCase()))];
  },

  /** Every UUID the probe is or was known by: current first. */
  async allUuidsOf(probe: { id: number; uuid: string }): Promise<string[]> {
    const current = String(probe.uuid).toLowerCase();
    return [current, ...(await this.aliasesOf(probe.id)).filter((u) => u !== current)];
  },
};
