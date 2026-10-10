import type { Knex } from 'knex';
import { db } from '../db';
import type { NetworkFlow, FlowEntry, FlowPeriod } from '@oblimap/shared';

function rowToFlow(row: Record<string, unknown>): NetworkFlow {
  return {
    id: row.id as number,
    siteId: row.site_id as number,
    tenantId: row.tenant_id as number,
    sourceIp: row.source_ip as string,
    sourcePort: row.source_port as number | null,
    destIp: row.dest_ip as string,
    destPort: row.dest_port as number,
    protocol: row.protocol as string,
    sourceProcess: row.source_process as string | null,
    connectionCount: row.connection_count as number,
    discoveredByProbeId: row.discovered_by_probe_id as number | null,
    firstSeenAt: (row.first_seen_at as Date).toISOString(),
    lastSeenAt: (row.last_seen_at as Date).toISOString(),
  };
}

function periodToInterval(period: FlowPeriod): string {
  switch (period) {
    case '1h': return '1 hour';
    case '24h': return '24 hours';
    case '30d': return '30 days';
    case '1y': return '365 days';
  }
}

/** Rows per INSERT … ON CONFLICT statement of processFlows. */
const FLOW_UPSERT_CHUNK = 500;
/** Columns of the unique dedup index (migration 046_network_flow_dedup). */
const FLOW_DEDUP_COLUMNS = ['site_id', 'source_ip', 'dest_ip', 'dest_port', 'protocol'] as const;
const MAX_INT4 = 2_147_483_647;

/**
 * Private IPv4 as the probe filters flows (probe/flows.go isPrivateIPv4):
 * RFC 1918 and link-local. Both endpoints of a stored flow must be private.
 */
export function isPrivateFlowIPv4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return false;
  return o[0] === 10
    || (o[0] === 172 && o[1] >= 16 && o[1] <= 31)
    || (o[0] === 192 && o[1] === 168)
    || (o[0] === 169 && o[1] === 254);
}

interface FlowInsertRow {
  site_id: number;
  tenant_id: number;
  source_ip: string;
  source_port: number | null;
  dest_ip: string;
  dest_port: number;
  protocol: string;
  source_process: string | null;
  connection_count: number;
  discovered_by_probe_id: number;
  first_seen_at: Date;
  last_seen_at: Date;
}

/**
 * One row per dedup key of the push (ON CONFLICT cannot touch a row twice in
 * one statement): each duplicate counts one more connection and the last
 * process name wins, as the former per-flow loop did. Sorted by key, so two
 * pushes on one site lock their rows in the same order.
 */
export function aggregateFlows(
  tenantId: number,
  siteId: number,
  probeId: number,
  flows: readonly FlowEntry[],
  now: Date,
): FlowInsertRow[] {
  const byKey = new Map<string, FlowInsertRow>();
  for (const flow of flows) {
    if (!isPrivateFlowIPv4(flow.sourceIp) || !isPrivateFlowIPv4(flow.destIp)) continue;
    const protocol = flow.protocol || 'tcp';
    const key = `${flow.sourceIp}|${flow.destIp}|${flow.destPort}|${protocol}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.connection_count = Math.min(MAX_INT4, existing.connection_count + 1);
      if (flow.process) existing.source_process = flow.process;
      continue;
    }
    byKey.set(key, {
      site_id: siteId,
      tenant_id: tenantId,
      source_ip: flow.sourceIp,
      source_port: flow.sourcePort || null,
      dest_ip: flow.destIp,
      dest_port: flow.destPort,
      protocol,
      source_process: flow.process || null,
      connection_count: 1,
      discovered_by_probe_id: probeId,
      first_seen_at: now,
      last_seen_at: now,
    });
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, row]) => row);
}

export const flowService = {
  async getFlows(tenantId: number, siteId: number, period: FlowPeriod): Promise<NetworkFlow[]> {
    const interval = periodToInterval(period);

    // Get all known IPs in this site for filtering
    const siteIps = await db('site_items')
      .where({ site_id: siteId, tenant_id: tenantId })
      .pluck('ip') as string[];
    const ipSet = new Set(siteIps);

    const rows = await db('network_flows')
      .where({ site_id: siteId, tenant_id: tenantId })
      .andWhereRaw(`last_seen_at >= NOW() - INTERVAL '${interval}'`)
      .orderBy('connection_count', 'desc');

    // Only include flows where at least one endpoint is a known device
    return rows.map(rowToFlow).filter(f => ipSet.has(f.sourceIp) || ipSet.has(f.destIp));
  },

  /**
   * Upserts the flows of one push: one row per (site, source, destination,
   * port, protocol). Duplicates inside the push are merged first (one
   * connection each), then the rows go out as batched INSERT … ON CONFLICT
   * statements of FLOW_UPSERT_CHUNK rows on the unique index of migration 046
   * (a 10 000-flow push = at most 20 statements, not 2 per flow).
   */
  async processFlows(
    tenantId: number,
    siteId: number,
    probeId: number,
    flows: FlowEntry[],
  ): Promise<void> {
    const rows = aggregateFlows(tenantId, siteId, probeId, flows, new Date());
    for (let i = 0; i < rows.length; i += FLOW_UPSERT_CHUNK) {
      const chunk = rows.slice(i, i + FLOW_UPSERT_CHUNK);
      await db('network_flows')
        .insert(chunk)
        .onConflict([...FLOW_DEDUP_COLUMNS])
        .merge({
          last_seen_at: db.raw('GREATEST(network_flows.last_seen_at, excluded.last_seen_at)'),
          connection_count: db.raw(`LEAST(network_flows.connection_count::bigint + excluded.connection_count, ${MAX_INT4})`),
          source_process: db.raw('COALESCE(excluded.source_process, network_flows.source_process)'),
          discovered_by_probe_id: db.raw('excluded.discovered_by_probe_id'),
        })
        // The key starts with the site, which belongs to one tenant: a row of
        // another tenant can never match, but the update stays tenant-scoped.
        .where('network_flows.tenant_id', tenantId);
    }
  },

  /**
   * Flows of one site where the IP is the source or the destination, newest
   * activity of the period, busiest first (device detail, GET
   * /api/items/:id/flows). At most `limit` rows.
   */
  async getFlowsForIp(
    tenantId: number,
    siteId: number,
    ip: string,
    period: FlowPeriod,
    limit = 1000,
  ): Promise<NetworkFlow[]> {
    const interval = periodToInterval(period);
    const rows = await db('network_flows')
      .where({ site_id: siteId, tenant_id: tenantId })
      .andWhere(function () {
        this.where('source_ip', ip).orWhere('dest_ip', ip);
      })
      .andWhereRaw(`last_seen_at >= NOW() - INTERVAL '${interval}'`)
      .orderBy([{ column: 'connection_count', order: 'desc' }, { column: 'id', order: 'asc' }])
      .limit(Math.max(1, Math.min(5000, Math.trunc(limit))));
    return rows.map(rowToFlow);
  },

  /**
   * Deletes the site's flows whose source or destination is one of the IPs
   * (devices removed in bulk; the caller passes only IPs no remaining device
   * of the site holds). Runs on `conn` (a transaction) when given.
   */
  async clearFlowsForIps(
    tenantId: number,
    siteId: number,
    ips: readonly string[],
    conn: Knex | Knex.Transaction = db,
  ): Promise<number> {
    const unique = [...new Set(ips.filter((ip) => typeof ip === 'string' && ip.length > 0))];
    if (unique.length === 0) return 0;
    let deleted = 0;
    for (let i = 0; i < unique.length; i += FLOW_UPSERT_CHUNK) {
      const chunk = unique.slice(i, i + FLOW_UPSERT_CHUNK);
      deleted += await conn('network_flows')
        .where({ site_id: siteId, tenant_id: tenantId })
        .andWhere(function () {
          this.whereIn('source_ip', chunk).orWhereIn('dest_ip', chunk);
        })
        .delete();
    }
    return deleted;
  },

  async clearFlows(tenantId: number, siteId: number): Promise<number> {
    return db('network_flows')
      .where({ site_id: siteId, tenant_id: tenantId })
      .delete();
  },

  /**
   * Delete flows where source_ip or dest_ip starts with the given /24 prefix.
   * @param prefix e.g. "192.168.1" — matches all IPs 192.168.1.*
   */
  async clearFlowsForSubnet(tenantId: number, siteId: number, prefix: string): Promise<number> {
    return db('network_flows')
      .where({ site_id: siteId, tenant_id: tenantId })
      .andWhere(function () {
        this.where('source_ip', 'like', `${prefix}.%`)
          .orWhere('dest_ip', 'like', `${prefix}.%`);
      })
      .delete();
  },
};
