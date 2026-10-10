import { useState, useCallback } from 'react';
import { Network, Plus } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import type { SiteItem, IpReservation, DeviceCheckSummary } from '@oblimap/shared';
import { siteApi, type SiteProbe } from '@/api/site.api';
import { siteSubnetsApi, useSiteSubnets } from '@/api/siteSubnets.api';
import { useAnonymize } from '@/utils/anonymize';
import { toastApiError } from '@/utils/apiError';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { Button } from '@/components/common/Button';
import { DeviceTable, sortChecks } from '@/components/ipam/DeviceTable';
import { DeviceModal } from './DeviceModal';
import { SiteProbeStrip, StaleProbesBanner } from './SiteProbesTab';
import { SubnetsDialog } from './SubnetsDialog';

// Devices tab of the site page: the probe strip and the shared DeviceTable
// (search, filters, grouping by the site's subnets — else /24 —, exports,
// device-check chips, selection and bulk actions for site writers), plus the
// add / edit / delete device actions and the Subnets dialog (site write).

// ─── Device checks helpers (live updates of the page) ─────────────────────────

export { sortChecks };

export function positiveInt(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^[1-9]\d{0,15}$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export const ALERT_STATES: ReadonlySet<string> = new Set(['ok', 'pending', 'alerting', 'suppressed']);
const CHECK_STATUSES: ReadonlySet<string> = new Set(['pending', 'ok', 'fail', 'error']);

/** Shape check of a DEVICE_CHECK_UPDATED summary before it is merged into the items. */
export function isCheckSummary(v: unknown): v is DeviceCheckSummary {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return positiveInt(s.stateId) !== null
    && positiveInt(s.ruleId) !== null
    && typeof s.ruleName === 'string'
    && typeof s.status === 'string' && CHECK_STATUSES.has(s.status)
    && typeof s.alertState === 'string' && ALERT_STATES.has(s.alertState);
}

/** The item's checks with `summary` replacing the one of the same rule (or appended). */
export function upsertCheck(checks: readonly DeviceCheckSummary[] | undefined, summary: DeviceCheckSummary): DeviceCheckSummary[] {
  const list = [...(checks ?? [])];
  const i = list.findIndex((c) => c.ruleId === summary.ruleId);
  if (i >= 0) list[i] = summary;
  else list.push(summary);
  return sortChecks(list);
}

// ─── Devices Tab ──────────────────────────────────────────────────────────────

export function DevicesTab({
  siteId,
  siteName,
  items,
  reservations,
  probes,
  canWrite,
  canManageProbes,
  onRefresh,
  onTunnel,
  onOpenChecks,
  onReserve,
}: {
  siteId: number;
  siteName: string;
  items: SiteItem[];
  reservations: IpReservation[];
  /** The site's probes (GET /sites/:id/probes); null until loaded or after a failed load. */
  probes: SiteProbe[] | null;
  /** Write permission on the site: add / edit / delete devices and subnets. */
  canWrite: boolean;
  /** 'probes.manage' tenant capability: the probe pages take it. */
  canManageProbes: boolean;
  onRefresh: () => void;
  onTunnel?: (ip: string, port: number) => void;
  /** Opens the device checks drawer (ruleId: the check to highlight). */
  onOpenChecks: (itemId: number, ruleId: number | null) => void;
  /** "Reserve this IP" of a device row (site write). */
  onReserve?: (item: SiteItem) => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { anonymize, isAnonymous } = useAnonymize();
  const [deviceModal, setDeviceModal] = useState<SiteItem | null | undefined>(undefined);
  const [subnetsOpen, setSubnetsOpen] = useState(false);
  const { subnets, loading: subnetsLoading, reload: reloadSubnets } = useSiteSubnets(siteId);

  const handleDelete = useCallback(async (item: SiteItem) => {
    const displayName = item.customName ?? item.hostname;
    const shown = displayName ? anonymize(displayName, 'hostname') : anonymize(item.ip, 'ip');
    if (!(await confirm({ message: t('siteDetail.device.confirmRemove', { name: shown }), danger: true }))) return;
    try {
      await siteApi.removeItem(siteId, item.id);
      toast.success(t('siteDetail.device.removed'));
      onRefresh();
    } catch (err) {
      toastApiError(err, t('siteDetail.device.failedRemove'));
    }
  }, [siteId, onRefresh, t, anonymize, confirm]);

  const onDeleteRow = useCallback((item: SiteItem) => { void handleDelete(item); }, [handleDelete]);
  const onEditRow = useCallback((item: SiteItem) => setDeviceModal(item), []);

  // Subnet header delete: the site's discovered devices of the whole CIDR.
  const handleDeleteSubnet = useCallback(async (_siteId: number, cidr: string, count: number) => {
    const [address, prefix] = cidr.split('/');
    const ok = await confirm({
      // Only discovered devices are deleted (manual ones are kept).
      message: t('siteDetail.device.confirmDeleteDiscoveredInSubnet', 'Delete the {{count}} discovered devices in {{subnet}}? Manually added devices are kept.', { subnet: `${anonymize(address, 'ip')}/${prefix}`, count }),
      danger: true,
      // Type-to-confirm with the CIDR; in anonymous mode the subnet is
      // masked on screen, so it is not asked for.
      requireText: isAnonymous ? undefined : cidr,
    });
    if (!ok) return;
    try {
      const { deleted } = await siteSubnetsApi.deleteItems(siteId, cidr);
      toast.success(t('siteDetail.device.subnetDeleted', { count: deleted }));
      onRefresh();
      reloadSubnets();
    } catch (err) {
      toastApiError(err, t('siteDetail.device.failedDeleteSubnet'));
    }
  }, [siteId, onRefresh, reloadSubnets, t, anonymize, isAnonymous, confirm]);

  const onDeleteSubnet = useCallback((sid: number, cidr: string, count: number) => {
    void handleDeleteSubnet(sid, cidr, count);
  }, [handleDeleteSubnet]);

  return (
    <div>
      <StaleProbesBanner probes={probes} />
      <SiteProbeStrip probes={probes} canManageProbes={canManageProbes} />
      <DeviceTable
        key={`site:${siteId}`}
        stateKey={`site:${siteId}`}
        items={items}
        siteId={siteId}
        canWrite={canWrite}
        // Bulk actions (selection column, per-subnet select-all): site write.
        onBulkDone={onRefresh}
        groupBySubnet
        subnets={subnets}
        probes={probes}
        canManageProbes={canManageProbes}
        reservations={reservations}
        exportName={siteName}
        onTunnel={onTunnel}
        onOpenChecks={onOpenChecks}
        onEdit={canWrite ? onEditRow : undefined}
        onDelete={canWrite ? onDeleteRow : undefined}
        onReserve={canWrite ? onReserve : undefined}
        onDeleteSubnet={canWrite ? onDeleteSubnet : undefined}
        toolbarActions={canWrite ? (
          <>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setSubnetsOpen(true)}
              className="gap-1.5"
            >
              <Network size={14} />
              {t('subnets.button', 'Subnets')}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setDeviceModal(null)}
              className="gap-1.5"
            >
              <Plus size={14} />
              {t('siteDetail.device.addManually')}
            </Button>
          </>
        ) : undefined}
      />

      {canWrite && subnetsOpen && (
        <SubnetsDialog
          siteId={siteId}
          subnets={subnets}
          loading={subnetsLoading}
          probes={probes}
          onChanged={reloadSubnets}
          onClose={() => setSubnetsOpen(false)}
        />
      )}

      {canWrite && deviceModal !== undefined && (
        <DeviceModal
          siteId={siteId}
          item={deviceModal}
          onClose={() => setDeviceModal(undefined)}
          onSaved={() => { setDeviceModal(undefined); onRefresh(); }}
        />
      )}
    </div>
  );
}
