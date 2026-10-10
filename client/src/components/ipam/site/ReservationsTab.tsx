import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Pencil, Trash2, Info } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import type { IpReservation, IpReservationState, SiteItem } from '@oblimap/shared';
import { clsx } from 'clsx';
import { siteApi } from '@/api/site.api';
import { useAnonymize } from '@/utils/anonymize';
import { toastApiError } from '@/utils/apiError';
import { deviceTypeLabel } from '@/utils/deviceTypes';
import { reservationStateLabel, reservationStateOf } from '@/utils/exportSite';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { EmptyState } from '@/components/common/EmptyState';
import { TableScroll } from '@/components/common/TableScroll';
import { IconButton } from '@/components/common/IconButton';
import { Button } from '@/components/common/Button';
import { ReservationModal } from './ReservationModal';

/** Badge colours of the reservation states (the heatmap uses the same hues). */
export const RESERVATION_STATE_BADGE: Record<IpReservationState, string> = {
  free: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  held: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  conflict: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  owner_offline: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
};

const STATE_HINT_FALLBACK: Record<IpReservationState, string> = {
  free: 'No device holds this IP.',
  held: 'The device it is reserved for holds this IP.',
  conflict: 'Another device holds this IP.',
  owner_offline: 'The device it is reserved for is offline.',
};

/** Reservations tab of the site page: the site's IP reservations, their owner and state. */
export function ReservationsTab({
  siteId,
  reservations,
  items,
  canWrite,
  onRefresh,
}: {
  siteId: number;
  reservations: IpReservation[];
  /** The site's devices: owner names and the device picker. */
  items: SiteItem[];
  /** Write permission on the site: create / edit / delete reservations. */
  canWrite: boolean;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [modal, setModal] = useState<IpReservation | null | undefined>(undefined);
  const { anonymize } = useAnonymize();

  const itemsById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  async function handleDelete(res: IpReservation) {
    const ok = await confirm({
      message: t('siteDetail.reservation.confirmRemove', { ip: anonymize(res.ip, 'ip'), name: anonymize(res.name, 'hostname') }),
      danger: true,
    });
    if (!ok) return;
    try {
      await siteApi.removeReservation(siteId, res.id);
      toast.success(t('siteDetail.reservation.removed'));
      onRefresh();
    } catch (err) {
      toastApiError(err, t('siteDetail.reservation.failedRemove'));
    }
  }

  const sorted = useMemo(() => {
    const num = (ip: string) => {
      const p = ip.split('.').map(Number);
      return p.length === 4 ? ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0 : 0;
    };
    return [...reservations].sort((a, b) => num(a.ip) - num(b.ip));
  }, [reservations]);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-text-muted">
          {t('siteDetail.reservation.count', { count: reservations.length })}
        </p>
        {canWrite && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setModal(null)}
            className="gap-1.5"
          >
            <Plus size={14} />
            {t('siteDetail.reservation.newBtn')}
          </Button>
        )}
      </div>

      {reservations.length === 0 ? (
        <EmptyState
          icon={<Info className="h-6 w-6" />}
          title={t('siteDetail.reservation.noReservations')}
          description={t('siteDetail.reservation.noReservationsDesc')}
        />
      ) : (
        <TableScroll className="bg-bg-secondary">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border text-text-muted text-xs uppercase tracking-wide">
                <th className="px-4 py-3 text-left">{t('siteDetail.reservation.colIp')}</th>
                <th className="px-4 py-3 text-left">{t('siteDetail.reservation.colName')}</th>
                <th className="px-4 py-3 text-left hidden lg:table-cell">{t('siteDetail.reservation.colOwner', 'Reserved for')}</th>
                <th className="px-4 py-3 text-left hidden md:table-cell">{t('siteDetail.reservation.colDescription')}</th>
                <th className="px-4 py-3 text-left hidden sm:table-cell">{t('siteDetail.reservation.colType')}</th>
                <th className="px-4 py-3 text-left">{t('siteDetail.reservation.colStatus')}</th>
                <th className="px-4 py-3 text-right">{t('siteDetail.reservation.colActions')}</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((res) => {
                const state = reservationStateOf(res);
                const owner = res.itemId != null ? itemsById.get(res.itemId) : undefined;
                const ownerName = owner ? owner.customName ?? owner.hostname : null;
                return (
                  <tr
                    key={res.id}
                    className="border-b border-border last:border-0 hover:bg-bg-tertiary/50 transition-colors"
                  >
                    <td className="px-4 py-3">
                      <span className="text-sm font-mono text-text-primary">{anonymize(res.ip, 'ip')}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-sm text-text-primary">{anonymize(res.name, 'hostname')}</span>
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell">
                      {owner ? (
                        <Link
                          to={`/sites/${siteId}/devices/${owner.id}`}
                          className="text-sm text-text-secondary hover:text-accent transition-colors"
                        >
                          {ownerName ? anonymize(ownerName, 'hostname') : anonymize(owner.ip, 'ip')}
                        </Link>
                      ) : null}
                      {res.reservedMac ? (
                        <p className="text-xs font-mono text-text-muted">{anonymize(res.reservedMac, 'mac')}</p>
                      ) : !owner ? (
                        <span className="text-sm text-text-muted">—</span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      <span className="text-sm text-text-secondary">{res.description ?? '—'}</span>
                    </td>
                    <td className="px-4 py-3 hidden sm:table-cell">
                      <span className="text-xs text-text-secondary">
                        {res.deviceType ? deviceTypeLabel(t, res.deviceType) : '—'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={clsx('text-xs font-medium px-2 py-0.5 rounded border whitespace-nowrap', RESERVATION_STATE_BADGE[state])}
                        title={t(`siteDetail.reservation.stateHint.${state}`, STATE_HINT_FALLBACK[state])}
                      >
                        {reservationStateLabel(t, state)}
                      </span>
                      {state === 'conflict' && res.occupiedByMac && (
                        <p className="text-xs font-mono text-text-muted mt-0.5">{anonymize(res.occupiedByMac, 'mac')}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {canWrite && (
                        <div className="flex items-center justify-end gap-1">
                          <IconButton
                            label={t('common.edit')}
                            icon={<Pencil size={14} />}
                            size="sm"
                            onClick={() => setModal(res)}
                          />
                          <IconButton
                            label={t('common.delete')}
                            icon={<Trash2 size={14} />}
                            size="sm"
                            variant="danger"
                            onClick={() => void handleDelete(res)}
                          />
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>
      )}

      {canWrite && modal !== undefined && (
        <ReservationModal
          siteId={siteId}
          reservation={modal}
          items={items}
          onClose={() => setModal(undefined)}
          onSaved={() => { setModal(undefined); onRefresh(); }}
        />
      )}
    </div>
  );
}
