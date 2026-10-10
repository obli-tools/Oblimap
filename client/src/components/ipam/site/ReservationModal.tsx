import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import type { DeviceType, IpReservation, SiteItem } from '@oblimap/shared';
import { Wand2 } from 'lucide-react';
import { siteApi } from '@/api/site.api';
import {
  siteSubnetsApi, useSiteSubnets, parseSiteSubnets, longestMatch, parseCidr, NEXT_FREE_MIN_PREFIX,
} from '@/api/siteSubnets.api';
import { toastApiError } from '@/utils/apiError';
import { useAnonymize } from '@/utils/anonymize';
import { DEVICE_TYPE_OPTIONS, deviceTypeLabel } from '@/utils/deviceTypes';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { fieldClass } from './DeviceModal';

/** Values of a new reservation (e.g. "Reserve this IP" of a device, a free heatmap cell). */
export interface ReservationPrefill {
  ip?: string;
  name?: string;
  mac?: string | null;
  itemId?: number | null;
  deviceType?: DeviceType | null;
}

/** Same format as the server (validators: AA:BB:CC:DD:EE:FF or with dashes). */
const MAC_RE = /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i;

function ipNum(ip: string): number {
  const p = ip.split('.').map(Number);
  return p.length === 4 ? ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0 : 0;
}

/**
 * Create a reservation (reservation null) or edit one: name, type,
 * description, and its owner — the device it is reserved for (MAC and / or
 * site item). The owner holding the IP is no conflict. A new reservation
 * offers "Next free IP": the first address of the chosen site subnet held
 * by no device and no reservation (network, broadcast and gateway skipped).
 */
export function ReservationModal({
  siteId,
  reservation,
  prefill,
  items,
  onClose,
  onSaved,
}: {
  siteId: number;
  reservation: IpReservation | null;
  /** Initial values of a new reservation. */
  prefill?: ReservationPrefill;
  /** The site's devices (device picker); none = no picker. */
  items?: SiteItem[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const { anonymize, isAnonymous } = useAnonymize();
  const formId = useId();
  const isEdit = reservation !== null;
  const [ip, setIp] = useState(reservation?.ip ?? prefill?.ip ?? '');
  const [name, setName] = useState(reservation?.name ?? prefill?.name ?? '');
  const [description, setDescription] = useState(reservation?.description ?? '');
  const [deviceType, setDeviceType] = useState<DeviceType | ''>(reservation?.deviceType ?? prefill?.deviceType ?? '');
  const [mac, setMac] = useState(reservation?.reservedMac ?? prefill?.mac ?? '');
  const [itemId, setItemId] = useState<number | null>(reservation?.itemId ?? prefill?.itemId ?? null);
  const [saving, setSaving] = useState(false);
  // Anonymous mode: the owner MAC is shown masked (read-only) until the field is focused.
  const [macRevealed, setMacRevealed] = useState(false);

  // ── Next free IP (new reservations): the site's subnets, narrow enough for next-free.
  const { subnets } = useSiteSubnets(isEdit ? null : siteId);
  const [subnetChoice, setSubnetChoice] = useState('');
  const [findingFree, setFindingFree] = useState(false);
  const freeOptions = useMemo(() => {
    const list = parseSiteSubnets(subnets)
      .filter((p) => p.net.prefix >= NEXT_FREE_MIN_PREFIX && p.net.prefix <= 30)
      .sort((a, b) => a.net.base - b.net.base || a.net.prefix - b.net.prefix);
    return list.map((p) => ({ cidr: p.subnet.cidr, name: p.subnet.name, parsed: p }));
  }, [subnets]);
  // Default: the most specific subnet holding the IP typed, else the first one.
  const autoCidr = useMemo(() => {
    const m = longestMatch(freeOptions.map((o) => o.parsed).sort((a, b) => b.net.prefix - a.net.prefix), ip.trim());
    return m?.subnet.cidr ?? freeOptions[0]?.cidr ?? '';
  }, [freeOptions, ip]);
  const freeCidr = subnetChoice && freeOptions.some((o) => o.cidr === subnetChoice) ? subnetChoice : autoCidr;

  async function fillNextFree() {
    if (!freeCidr || findingFree || !parseCidr(freeCidr)) return;
    setFindingFree(true);
    try {
      const res = await siteSubnetsApi.nextFree(siteId, freeCidr);
      if (res.ip) {
        setIp(res.ip);
        setSubnetChoice(freeCidr);
      } else {
        const [address, prefix] = freeCidr.split('/');
        toast.error(t('subnets.noFreeIp', {
          cidr: `${anonymize(address, 'ip')}/${prefix}`,
          defaultValue: 'No free address left in {{cidr}}',
        }));
      }
    } catch (err) {
      toastApiError(err, t('subnets.nextFreeFailed', 'The next free address could not be found'));
    } finally {
      setFindingFree(false);
    }
  }

  const sortedItems = useMemo(
    () => [...(items ?? [])].sort((a, b) => ipNum(a.ip) - ipNum(b.ip)),
    [items],
  );

  const macValue = mac.trim();
  const macInvalid = macValue !== '' && !MAC_RE.test(macValue);

  function pickDevice(value: string) {
    const previous = itemId !== null ? sortedItems.find((i) => i.id === itemId) : undefined;
    if (!value) {
      setItemId(null);
      // Drop a MAC that only came from the device unpicked now.
      if (previous?.mac && previous.mac.toLowerCase() === mac.trim().toLowerCase()) setMac('');
      return;
    }
    const item = sortedItems.find((i) => String(i.id) === value);
    if (!item) return;
    setItemId(item.id);
    // Always the picked device's MAC (none = none): a MAC left from another
    // device would make both devices owners of the reservation.
    setMac(item.mac ?? '');
    if (!isEdit && !ip.trim()) setIp(item.ip);
    if (!name.trim()) {
      const label = item.customName ?? item.hostname;
      if (label) setName(label);
    }
    if (!deviceType && item.deviceType && item.deviceType !== 'unknown') setDeviceType(item.deviceType);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!ip.trim() || !name.trim() || macInvalid || saving) return;
    setSaving(true);
    try {
      const owner = {
        reservedMac: macValue || null,
        itemId,
      };
      const data = {
        name: name.trim(),
        description: description.trim() || null,
        deviceType: (deviceType || null) as DeviceType | null,
      };
      if (isEdit) {
        await siteApi.updateReservation(siteId, reservation.id, { ...data, ...owner });
        toast.success(t('siteDetail.reservation.updated'));
      } else {
        await siteApi.createReservation(siteId, { ip: ip.trim(), ...data, ...owner });
        toast.success(t('siteDetail.reservation.created'));
      }
      onSaved();
    } catch (err) {
      // e.g. 409 "This IP is already reserved on this site"
      toastApiError(err, isEdit ? t('siteDetail.reservation.failedUpdate') : t('siteDetail.reservation.failedCreate'));
    } finally {
      setSaving(false);
    }
  }

  const deviceLabel = (i: SiteItem) => {
    const n = i.customName ?? i.hostname;
    return [
      anonymize(i.ip, 'ip'),
      n ? anonymize(n, 'hostname') : null,
      i.mac ? anonymize(i.mac, 'mac') : null,
    ].filter(Boolean).join(' — ');
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? t('siteDetail.reservationModal.editTitle') : t('siteDetail.reservationModal.newTitle')}
      size="sm"
      footer={
        <>
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" form={formId} size="sm" loading={saving} disabled={!ip.trim() || !name.trim() || macInvalid}>
            {isEdit ? t('siteDetail.reservationModal.saveBtn') : t('siteDetail.reservationModal.reserveBtn')}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor={`${formId}-ip`} className="block text-sm text-text-secondary mb-1.5">
              {t('siteDetail.reservationModal.ipLabel')} <span className="text-red-400">*</span>
            </label>
            <input
              id={`${formId}-ip`}
              type="text"
              value={ip}
              onChange={(e) => setIp(e.target.value)}
              placeholder="192.168.1.50"
              disabled={isEdit}
              autoFocus={!isEdit && !prefill?.ip}
              className={fieldClass}
            />
          </div>
          <div>
            <label htmlFor={`${formId}-name`} className="block text-sm text-text-secondary mb-1.5">
              {t('siteDetail.reservationModal.nameLabel')} <span className="text-red-400">*</span>
            </label>
            <input
              id={`${formId}-name`}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('siteDetail.reservationModal.namePlaceholder')}
              autoFocus={isEdit || !!prefill?.ip}
              className={fieldClass}
            />
          </div>
        </div>

        {!isEdit && freeOptions.length > 0 && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1">
              <label htmlFor={`${formId}-subnet`} className="block text-sm text-text-secondary mb-1.5">
                {t('subnets.pickSubnet', 'Subnet')}
              </label>
              <select
                id={`${formId}-subnet`}
                value={freeCidr}
                onChange={(e) => setSubnetChoice(e.target.value)}
                className={fieldClass}
              >
                {freeOptions.map((o) => {
                  const [address, prefix] = o.cidr.split('/');
                  const shown = `${anonymize(address, 'ip')}/${prefix}`;
                  return (
                    <option key={o.cidr} value={o.cidr}>
                      {o.name ? `${shown} — ${anonymize(o.name, 'hostname')}` : shown}
                    </option>
                  );
                })}
              </select>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="py-2"
              loading={findingFree}
              disabled={!freeCidr}
              onClick={() => void fillNextFree()}
              title={t('subnets.nextFreeHint', 'Fill in the first address of the subnet used by no device and no reservation')}
            >
              <Wand2 size={14} className="mr-1.5" />
              {t('subnets.nextFree', 'Next free IP')}
            </Button>
          </div>
        )}

        {sortedItems.length > 0 && (
          <div>
            <label htmlFor={`${formId}-device`} className="block text-sm text-text-secondary mb-1.5">
              {t('siteDetail.reservationModal.deviceLabel', 'Reserved for the device')}
            </label>
            <select
              id={`${formId}-device`}
              value={itemId !== null ? String(itemId) : ''}
              onChange={(e) => pickDevice(e.target.value)}
              className={fieldClass}
            >
              <option value="">{t('siteDetail.reservationModal.deviceNone', '— No device —')}</option>
              {itemId !== null && !sortedItems.some((i) => i.id === itemId) && (
                <option value={String(itemId)}>{t('siteDetail.reservationModal.deviceGone', 'A device no longer listed')}</option>
              )}
              {sortedItems.map((i) => (
                <option key={i.id} value={String(i.id)}>{deviceLabel(i)}</option>
              ))}
            </select>
          </div>
        )}

        <div>
          <label htmlFor={`${formId}-mac`} className="block text-sm text-text-secondary mb-1.5">
            {t('siteDetail.reservationModal.macLabel', 'Owner MAC address')}
          </label>
          <input
            id={`${formId}-mac`}
            type="text"
            value={isAnonymous && !macRevealed && mac ? anonymize(mac, 'mac') : mac}
            readOnly={isAnonymous && !macRevealed && !!mac}
            onFocus={() => setMacRevealed(true)}
            onBlur={() => setMacRevealed(false)}
            onChange={(e) => setMac(e.target.value)}
            placeholder="AA:BB:CC:DD:EE:FF"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={macInvalid}
            className={fieldClass}
          />
          <p className={macInvalid ? 'mt-1 text-xs text-red-400' : 'mt-1 text-xs text-text-muted'}>
            {macInvalid
              ? t('siteDetail.reservationModal.macInvalid', 'Expected a MAC address like AA:BB:CC:DD:EE:FF')
              : t('siteDetail.reservationModal.macHint', 'Optional. The device with this MAC (or the device chosen above) holds the IP without a conflict.')}
          </p>
        </div>

        <div>
          <label htmlFor={`${formId}-type`} className="block text-sm text-text-secondary mb-1.5">{t('siteDetail.reservationModal.typeLabel')}</label>
          <select
            id={`${formId}-type`}
            value={deviceType}
            onChange={(e) => setDeviceType(e.target.value as DeviceType | '')}
            className={fieldClass}
          >
            <option value="">{t('siteDetail.reservationModal.typeAny')}</option>
            {DEVICE_TYPE_OPTIONS.filter((type) => type !== 'unknown').map((type) => (
              <option key={type} value={type}>{deviceTypeLabel(t, type)}</option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor={`${formId}-desc`} className="block text-sm text-text-secondary mb-1.5">{t('siteDetail.reservationModal.descLabel')}</label>
          <textarea
            id={`${formId}-desc`}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('siteDetail.reservationModal.descPlaceholder')}
            rows={2}
            className={`${fieldClass} resize-none`}
          />
        </div>
      </form>
    </Modal>
  );
}
