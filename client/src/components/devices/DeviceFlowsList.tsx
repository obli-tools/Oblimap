import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowDownLeft, ArrowUpRight, Loader2, Waypoints } from 'lucide-react';
import type { FlowPeriod, NetworkFlow } from '@oblimap/shared';
import { itemsApi } from '@/api/items.api';
import { useAnonymize } from '@/utils/anonymize';
import { formatRelative } from '@/utils/formatRelative';
import { EmptyState } from '@/components/common/EmptyState';
import { LoadError } from '@/components/common/LoadError';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { TableScroll } from '@/components/common/TableScroll';

/** Service name of the well-known TCP ports (same list as the network map). */
export const WELL_KNOWN_PORT_NAMES: Readonly<Record<number, string>> = {
  20: 'FTP-DATA', 21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP',
  53: 'DNS', 67: 'DHCP', 68: 'DHCP', 80: 'HTTP', 88: 'Kerberos',
  110: 'POP3', 111: 'RPC', 123: 'NTP', 135: 'RPC', 137: 'NetBIOS',
  138: 'NetBIOS', 139: 'NetBIOS', 143: 'IMAP', 161: 'SNMP', 162: 'SNMP-Trap',
  389: 'LDAP', 443: 'HTTPS', 445: 'SMB', 465: 'SMTPS', 514: 'Syslog',
  587: 'SMTP-TLS', 636: 'LDAPS', 993: 'IMAPS', 995: 'POP3S',
  1433: 'MSSQL', 1521: 'Oracle', 2049: 'NFS', 3000: 'Dev/Grafana',
  3001: 'Dev', 3306: 'MySQL', 3389: 'RDP', 5432: 'PostgreSQL',
  5060: 'SIP', 5061: 'SIP-TLS', 5222: 'XMPP',
  5900: 'VNC', 5985: 'WinRM', 5986: 'WinRM-S', 6379: 'Redis',
  6443: 'K8s-API', 8080: 'HTTP-Alt', 8443: 'HTTPS-Alt', 8883: 'MQTT-S',
  9090: 'Prometheus', 9200: 'Elasticsearch', 9300: 'ES-Transport',
  27017: 'MongoDB', 1883: 'MQTT', 11211: 'Memcached',
};

/** Periods offered by the list (the API also knows 1h / 1y). */
const PERIODS: readonly FlowPeriod[] = ['24h', '30d'];

export interface DeviceFlowsListProps {
  itemId: number;
  /** The device's IP: tells outbound (it is the source) from inbound flows. */
  ip: string;
  siteId: number;
  /** IP → device of the site (name and page link of the peers). */
  peers?: ReadonlyMap<string, { itemId: number; name: string | null }>;
  /** Changing it reloads the list silently (live refresh). */
  refreshKey?: number;
}

/**
 * TCP flows of the site involving the device's IP (collected by the probes
 * when flow analysis is on), over the last 24 h or 30 d: direction, peer,
 * service port, process, connections and last seen. Addresses and names
 * are masked in anonymous mode.
 */
export function DeviceFlowsList({ itemId, ip, siteId, peers, refreshKey = 0 }: DeviceFlowsListProps) {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const [period, setPeriod] = useState<FlowPeriod>('24h');
  const [flows, setFlows] = useState<NetworkFlow[] | null>(null);
  const [error, setError] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const res = await itemsApi.flows(itemId, period);
      if (mine !== seq.current) return;
      setFlows(res.flows);
      setError(false);
    } catch {
      if (mine !== seq.current) return;
      setError(true);
    }
  }, [itemId, period]);

  // Another device or period: nothing of the previous list stays on screen.
  useEffect(() => {
    setFlows(null);
    setError(false);
  }, [itemId, period]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  useEffect(() => () => { seq.current += 1; }, []);

  const rows = useMemo(() => {
    if (!flows) return [];
    return flows
      .map((f) => {
        const outbound = f.sourceIp === ip;
        return { flow: f, outbound, peerIp: outbound ? f.destIp : f.sourceIp };
      })
      .sort((a, b) => b.flow.lastSeenAt.localeCompare(a.flow.lastSeenAt) || b.flow.connectionCount - a.flow.connectionCount);
  }, [flows, ip]);

  const periodTabs = PERIODS.map((p) => ({
    id: p,
    label: p === '24h' ? t('deviceDetail.flows.period24h', '24 h') : t('deviceDetail.flows.period30d', '30 days'),
  }));

  let body: JSX.Element;
  if (flows === null) {
    body = error ? (
      <LoadError message={t('deviceDetail.flows.failedLoad', 'Could not load the flows.')} onRetry={() => void load()} />
    ) : (
      <div className="flex justify-center py-10">
        <Loader2 size={22} className="animate-spin text-accent" />
      </div>
    );
  } else if (rows.length === 0) {
    body = (
      <EmptyState
        icon={<Waypoints className="h-6 w-6" />}
        title={t('deviceDetail.flows.empty', 'No flow over this period')}
        description={t('deviceDetail.flows.emptyHint', 'Flows are collected by the probes when flow analysis is enabled in the site settings.')}
      />
    );
  } else {
    body = (
      <div className="rounded-xl bg-bg-secondary shadow-[var(--shadow-card)]">
        <TableScroll>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-muted">
                <th className="px-4 py-2 font-medium">{t('deviceDetail.flows.colDirection', 'Direction')}</th>
                <th className="px-4 py-2 font-medium">{t('deviceDetail.flows.colPeer', 'Peer')}</th>
                <th className="px-4 py-2 font-medium">{t('deviceDetail.flows.colService', 'Service')}</th>
                <th className="hidden px-4 py-2 font-medium md:table-cell">{t('deviceDetail.flows.colProcess', 'Process')}</th>
                <th className="hidden px-4 py-2 text-right font-medium sm:table-cell">{t('deviceDetail.flows.colConnections', 'Connections')}</th>
                <th className="px-4 py-2 font-medium">{t('deviceDetail.flows.colLastSeen', 'Last seen')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ flow, outbound, peerIp }) => {
                const peer = peers?.get(peerIp);
                const service = WELL_KNOWN_PORT_NAMES[flow.destPort];
                return (
                  <tr key={flow.id} className="border-b border-border last:border-0">
                    <td className="whitespace-nowrap px-4 py-2 text-xs">
                      {outbound ? (
                        <span className="inline-flex items-center gap-1 text-blue-400">
                          <ArrowUpRight size={12} />
                          {t('deviceDetail.flows.outbound', 'Outbound')}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-accent">
                          <ArrowDownLeft size={12} />
                          {t('deviceDetail.flows.inbound', 'Inbound')}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      {peer && peer.itemId !== itemId ? (
                        <Link to={`/sites/${siteId}/devices/${peer.itemId}`} className="font-mono text-text-primary hover:text-accent">
                          {anonymize(peerIp, 'ip')}
                        </Link>
                      ) : (
                        <span className="font-mono text-text-primary">{anonymize(peerIp, 'ip')}</span>
                      )}
                      {peer?.name && (
                        <span className="block text-xs text-text-muted">{anonymize(peer.name, 'hostname')}</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-xs">
                      <span className="font-mono text-text-secondary">{flow.destPort}</span>
                      {service && <span className="ml-1 text-text-muted">{service}</span>}
                      {flow.protocol && flow.protocol.toLowerCase() !== 'tcp' && (
                        <span className="ml-1 uppercase text-text-muted">{flow.protocol}</span>
                      )}
                    </td>
                    <td className="hidden max-w-[12rem] truncate px-4 py-2 text-xs text-text-secondary md:table-cell" title={flow.sourceProcess ?? undefined}>
                      {outbound && flow.sourceProcess ? flow.sourceProcess : '—'}
                    </td>
                    <td className="hidden px-4 py-2 text-right text-xs text-text-secondary sm:table-cell">{flow.connectionCount}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-xs text-text-secondary" title={new Date(flow.lastSeenAt).toLocaleString()}>
                      {formatRelative(flow.lastSeenAt, t)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-text-muted">
          {flows !== null && rows.length > 0
            ? t('deviceDetail.flows.summary', { count: rows.length, defaultValue: '{{count}} flow(s) involving this device.' })
            : t('deviceDetail.flows.intro', 'TCP connections from and to this device.')}
        </p>
        <SegmentedTabs
          tabs={periodTabs}
          value={period}
          onChange={setPeriod}
          fill={false}
          size="sm"
          ariaLabel={t('deviceDetail.flows.periodLabel', 'Period')}
        />
      </div>
      {error && flows !== null && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-400">
          {t('deviceDetail.failedRefresh', 'Refresh failed: the data shown may be out of date.')}
        </p>
      )}
      {body}
    </div>
  );
}
