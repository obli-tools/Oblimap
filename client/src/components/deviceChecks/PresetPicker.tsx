/**
 * PresetPicker — "New check" dialog: the shipped presets as
 * cards grouped by category (icon, title, description, validation status),
 * plus a "Blank" card. Picking a preset only chooses what the editor starts
 * from. No probe version number is shown: support is detected from the
 * probe's capabilities, never from its version.
 */

import { useTranslation } from 'react-i18next';
import { BadgeCheck, FilePlus2, FlaskConical } from 'lucide-react';
import { DEVICE_CHECK_PRESETS, type DeviceCheckPreset } from '@oblimap/shared';
import { Modal } from '@/components/common/Modal';
import { cn } from '@/utils/cn';
import { DeviceCheckIconGlyph } from './DeviceCheckChip';

const CATEGORY_ORDER: DeviceCheckPreset['category'][] = ['audio', 'generic'];
const CATEGORY_FALLBACKS: Record<DeviceCheckPreset['category'], string> = {
  audio: 'Audio players',
  generic: 'Generic templates',
};

interface PresetPickerProps {
  open: boolean;
  onClose: () => void;
  /** null = blank rule. */
  onPick: (presetKey: string | null) => void;
}

export function PresetPicker({ open, onClose, onPick }: PresetPickerProps) {
  const { t } = useTranslation();

  if (!open) return null;

  const categories = CATEGORY_ORDER
    .map((c) => ({ category: c, presets: DEVICE_CHECK_PRESETS.filter((p) => p.category === c) }))
    .filter((g) => g.presets.length > 0);

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title={t('deviceChecks.presetPicker.title', 'New device check')}
      bodyClassName="space-y-5 px-5 pb-5"
    >
      <p className="text-sm text-text-secondary">
        {t('deviceChecks.presetPicker.intro', 'Start from a preset and adapt it, or from a blank rule. The rule is created disabled: test it on a real device before enabling it.')}
      </p>

      {categories.map((g) => (
        <section key={g.category}>
          <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-text-muted">
            {t(`deviceChecks.presetPicker.category.${g.category}`, CATEGORY_FALLBACKS[g.category])}
          </h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {g.presets.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => onPick(p.key)}
                className="group flex flex-col gap-2 rounded-xl bg-bg-tertiary p-3 text-left transition-colors hover:bg-bg-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              >
                <div className="flex items-start gap-2.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
                    <DeviceCheckIconGlyph icon={p.icon} size={16} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-text-primary group-hover:text-accent">
                      {t(p.titleKey, p.titleFallback)}
                    </div>
                    {p.vendor && <div className="text-[11px] text-text-muted">{p.vendor}</div>}
                  </div>
                </div>
                <p className="line-clamp-3 text-xs text-text-secondary">{t(p.descriptionKey, p.descriptionFallback)}</p>
                <div className="mt-auto flex flex-wrap items-center gap-1.5">
                  {p.validated ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] text-accent">
                      <BadgeCheck size={11} />{t('deviceChecks.presetPicker.validated', 'Validated')}
                    </span>
                  ) : (
                    <span
                      className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-400"
                      title={t(`deviceChecks.presets.${p.key}.validationNotes`, p.validationNotes)}
                    >
                      <FlaskConical size={11} />{t('deviceChecks.presetPicker.needsValidation', 'Validate on one device per model')}
                    </span>
                  )}
                  <span
                    className="text-[11px] text-text-muted"
                    title={t('deviceChecks.presetPicker.probeSupportHint', 'The server detects device check support from what each probe advertises. The coverage of a check shows the devices whose probe needs an update.')}
                  >
                    {t('deviceChecks.presetPicker.probeSupport', 'Needs a probe with device check support')}
                  </span>
                  <span className="ml-auto font-mono text-[10px] text-text-muted">
                    {t('deviceChecks.presetPicker.version', { version: p.version, defaultValue: 'v{{version}}' })}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </section>
      ))}

      <section>
        <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-text-muted">
          {t('deviceChecks.presetPicker.other', 'Other')}
        </h3>
        <button
          type="button"
          onClick={() => onPick(null)}
          className={cn(
            'flex w-full items-center gap-2.5 rounded-xl bg-bg-tertiary/50 p-3 text-left transition-colors sm:w-1/2',
            'hover:bg-bg-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-accent',
          )}
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-bg-tertiary text-text-muted">
            <FilePlus2 size={16} />
          </span>
          <div>
            <div className="text-sm font-medium text-text-primary">{t('deviceChecks.presetPicker.blank', 'Blank')}</div>
            <div className="text-xs text-text-muted">{t('deviceChecks.presetPicker.blankHint', 'One empty HTTP variant, no field')}</div>
          </div>
        </button>
      </section>
    </Modal>
  );
}
