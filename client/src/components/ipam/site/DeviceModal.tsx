import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import type { DeviceType, SiteItem } from '@oblimap/shared';
import { siteApi } from '@/api/site.api';
import { toastApiError } from '@/utils/apiError';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { DEVICE_TYPE_OPTIONS, deviceTypeLabel } from '@/utils/deviceTypes';

/** Where the current device type came from (SiteItem.deviceTypeSource). */
const TYPE_SOURCE_FALLBACK: Record<string, string> = {
  manual: 'Set manually: never reclassified automatically.',
  rule: 'Set by a vendor rule.',
  ports: 'Guessed from the open ports.',
  probe: 'Reported by the probe.',
};

export const fieldClass =
  'w-full bg-bg-tertiary border border-border rounded-lg px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent disabled:opacity-60';

/** Add a manual device (item null) or edit a device's name, type and notes. */
export function DeviceModal({
  siteId,
  item,
  onClose,
  onSaved,
}: {
  siteId: number;
  item: SiteItem | null; // null = new manual device
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const isEdit = item !== null;
  const [ip, setIp] = useState(item?.ip ?? '');
  const [mac, setMac] = useState(item?.mac ?? '');
  const [customName, setCustomName] = useState(item?.customName ?? '');
  const [deviceType, setDeviceType] = useState<DeviceType>(item?.deviceType ?? 'unknown');
  const [notes, setNotes] = useState(item?.notes ?? '');
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!ip.trim() || saving) return;
    setSaving(true);
    try {
      if (isEdit) {
        await siteApi.updateItem(siteId, item.id, {
          customName: customName.trim() || null,
          // Only a changed type is sent: the server pins a sent type as
          // 'manual' (no more automatic classification), a rename must not.
          ...(deviceType !== (item.deviceType ?? 'unknown') ? { deviceType } : {}),
          notes: notes.trim() || null,
        });
        toast.success(t('siteDetail.device.updated'));
      } else {
        await siteApi.createItem(siteId, {
          ip: ip.trim(),
          mac: mac.trim() || null,
          customName: customName.trim() || null,
          deviceType,
          notes: notes.trim() || null,
        });
        toast.success(t('siteDetail.device.added'));
      }
      onSaved();
    } catch (err) {
      toastApiError(err, isEdit ? t('siteDetail.device.failedUpdate') : t('siteDetail.device.failedAdd'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={isEdit ? t('siteDetail.deviceModal.editTitle') : t('siteDetail.deviceModal.addTitle')}
      size="sm"
      footer={
        <>
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" form={formId} size="sm" loading={saving} disabled={!ip.trim()}>
            {isEdit ? t('siteDetail.deviceModal.saveBtn') : t('siteDetail.deviceModal.addBtn')}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor={`${formId}-ip`} className="block text-sm text-text-secondary mb-1.5">
              {t('siteDetail.deviceModal.ipLabel')} <span className="text-red-400">*</span>
            </label>
            <input
              id={`${formId}-ip`}
              type="text"
              value={ip}
              onChange={(e) => setIp(e.target.value)}
              placeholder="192.168.1.10"
              disabled={isEdit}
              autoFocus={!isEdit}
              className={fieldClass}
            />
          </div>
          <div>
            <label htmlFor={`${formId}-mac`} className="block text-sm text-text-secondary mb-1.5">{t('siteDetail.deviceModal.macLabel')}</label>
            <input
              id={`${formId}-mac`}
              type="text"
              value={mac}
              onChange={(e) => setMac(e.target.value)}
              placeholder="AA:BB:CC:DD:EE:FF"
              disabled={isEdit}
              className={fieldClass}
            />
          </div>
        </div>

        <div>
          <label htmlFor={`${formId}-name`} className="block text-sm text-text-secondary mb-1.5">{t('siteDetail.deviceModal.nameLabel')}</label>
          <input
            id={`${formId}-name`}
            type="text"
            value={customName}
            onChange={(e) => setCustomName(e.target.value)}
            placeholder={t('siteDetail.deviceModal.namePlaceholder')}
            autoFocus={isEdit}
            className={fieldClass}
          />
        </div>

        <div>
          <label htmlFor={`${formId}-type`} className="block text-sm text-text-secondary mb-1.5">{t('siteDetail.deviceModal.typeLabel')}</label>
          <select
            id={`${formId}-type`}
            value={deviceType}
            onChange={(e) => setDeviceType(e.target.value as DeviceType)}
            className={fieldClass}
          >
            {DEVICE_TYPE_OPTIONS.map((type) => (
              <option key={type} value={type}>{deviceTypeLabel(t, type)}</option>
            ))}
          </select>
          {isEdit && deviceType !== (item.deviceType ?? 'unknown') ? (
            <p className="mt-1 text-xs text-text-muted">
              {t('siteDetail.deviceModal.typeWillBeManual', 'A type chosen here is kept: automatic classification no longer changes it.')}
            </p>
          ) : isEdit && item.deviceTypeSource && TYPE_SOURCE_FALLBACK[item.deviceTypeSource] ? (
            <p className="mt-1 text-xs text-text-muted">
              {t(`siteDetail.deviceModal.typeSource.${item.deviceTypeSource}`, TYPE_SOURCE_FALLBACK[item.deviceTypeSource])}
            </p>
          ) : null}
        </div>

        <div>
          <label htmlFor={`${formId}-notes`} className="block text-sm text-text-secondary mb-1.5">{t('siteDetail.deviceModal.notesLabel')}</label>
          <textarea
            id={`${formId}-notes`}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t('siteDetail.deviceModal.notesPlaceholder')}
            rows={2}
            className={`${fieldClass} resize-none`}
          />
        </div>
      </form>
    </Modal>
  );
}
