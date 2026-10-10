/**
 * DisplaySection — how a rule shows in the device list:
 * an icon from the fixed allowlist and the fields of the primary, secondary
 * and badge slots. The live preview renders a DeviceCheckChip with the values
 * of the last test (sample values before any test).
 */

import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import {
  DEVICE_CHECK_ICONS,
  type DeviceCheckDisplay,
  type DeviceCheckField,
  type DeviceCheckSlot,
  type DeviceCheckSummary,
  type DeviceCheckTestResponse,
  type DeviceCheckValue,
} from '@oblimap/shared';
import { useAnonymize } from '@/utils/anonymize';
import { cn } from '@/utils/cn';
import { DeviceCheckChip, DeviceCheckIconGlyph } from '../DeviceCheckChip';
import { FormRow, inputCls, invalidCls, type IssueIndex } from './GeneralSection';

type SlotKey = 'primary' | 'secondary' | 'badge';

const SLOT_FALLBACKS: Record<SlotKey, { label: string; hint: string }> = {
  primary: { label: 'Primary value', hint: 'Shown next to the icon (40 characters)' },
  secondary: { label: 'Secondary value', hint: 'Shown in the tooltip and the device drawer' },
  badge: { label: 'Badge', hint: 'Small pill colored by the tone of an enum value' },
};

interface DisplaySectionProps {
  display: DeviceCheckDisplay;
  onChange: (d: DeviceCheckDisplay) => void;
  fields: DeviceCheckField[];
  lastTest: DeviceCheckTestResponse | null;
  ruleName: string;
  intervalSeconds: number;
  errors: IssueIndex;
}

export function DisplaySection({ display, onChange, fields, lastTest, ruleName, intervalSeconds, errors }: DisplaySectionProps) {
  const { t } = useTranslation();
  const { anonymize, isAnonymous } = useAnonymize();

  const sampleValue = (f: DeviceCheckField): DeviceCheckValue => {
    switch (f.valueType) {
      case 'enum': return f.enumValues?.[0]?.value ?? null;
      case 'number': return 42;
      case 'boolean': return true;
      default: return f.label || t('deviceChecks.editor.display.sample', 'Sample');
    }
  };

  const slot = (key: string | undefined): DeviceCheckSlot | undefined => {
    if (!key) return undefined;
    const f = fields.find((x) => x.key === key);
    if (!f) return undefined;
    let value: DeviceCheckValue = lastTest ? (lastTest.result.values?.[key] ?? null) : sampleValue(f);
    if (f.sensitive && isAnonymous && typeof value === 'string') value = anonymize(value, 'hostname');
    const tone = f.valueType === 'enum'
      ? f.enumValues?.find((ev) => ev.value === value)?.tone ?? 'neutral'
      : undefined;
    return { label: f.label || f.key, value, tone };
  };

  const summary: DeviceCheckSummary = {
    stateId: 0,
    ruleId: 0,
    ruleName: ruleName || t('deviceChecks.editor.display.untitled', 'Untitled check'),
    icon: display.icon,
    status: lastTest ? lastTest.status : 'pending',
    alertState: 'ok',
    stale: false,
    primary: slot(display.primary),
    secondary: slot(display.secondary),
    badge: slot(display.badge),
    lastCheckedAt: lastTest?.result.startedAt ?? null,
    lastErrorCode: lastTest?.result.error?.code ?? null,
    intervalSeconds,
  };

  const sensitiveSlots = (['primary', 'secondary', 'badge'] as SlotKey[])
    .filter((k) => fields.find((f) => f.key === display[k])?.sensitive);

  return (
    <div className="space-y-4">
      <FormRow label={t('deviceChecks.editor.display.icon', 'Icon')} error={errors.at('display.icon')}>
        <div className="flex flex-wrap gap-1.5" role="radiogroup">
          {DEVICE_CHECK_ICONS.map((icon) => (
            <button
              key={icon}
              type="button"
              role="radio"
              aria-checked={display.icon === icon}
              onClick={() => onChange({ ...display, icon })}
              title={t(`deviceChecks.editor.display.icons.${icon}`, icon)}
              className={cn(
                'flex h-9 w-9 items-center justify-center rounded-md border transition-colors',
                display.icon === icon ? 'border-accent bg-accent/15 text-accent' : 'border-border text-text-muted hover:text-text-primary',
              )}
            >
              <DeviceCheckIconGlyph icon={icon} size={16} />
            </button>
          ))}
        </div>
      </FormRow>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {(['primary', 'secondary', 'badge'] as SlotKey[]).map((k) => {
          const err = errors.at(`display.${k}`);
          const known = !display[k] || fields.some((f) => f.key === display[k]);
          return (
            <FormRow
              key={k}
              label={t(`deviceChecks.editor.display.${k}`, SLOT_FALLBACKS[k].label)}
              hint={t(`deviceChecks.editor.display.${k}Hint`, SLOT_FALLBACKS[k].hint)}
              error={err}
            >
              <select
                value={display[k] ?? ''}
                onChange={(e) => {
                  const next = { ...display };
                  if (e.target.value) next[k] = e.target.value; else delete next[k];
                  onChange(next);
                }}
                className={cn(inputCls, (err || !known) && invalidCls)}
              >
                <option value="">{t('deviceChecks.editor.display.none', '(none)')}</option>
                {!known && <option value={display[k]}>{display[k]}</option>}
                {fields.map((f) => <option key={f.key} value={f.key}>{f.label ? `${f.label} (${f.key})` : f.key}</option>)}
              </select>
            </FormRow>
          );
        })}
      </div>

      {sensitiveSlots.length > 0 && (
        <p className="flex items-start gap-1.5 text-[11px] text-amber-400">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          {t('deviceChecks.editor.display.sensitiveSlot', 'Sensitive fields are never shown in the device list: pick a non-sensitive field for these slots.')}
        </p>
      )}

      <div className="rounded-md bg-bg-primary/40 p-3">
        <p className="mb-2 text-[11px] uppercase tracking-wide text-text-muted">
          {lastTest
            ? t('deviceChecks.editor.display.previewLast', 'Preview (values of the last test)')
            : t('deviceChecks.editor.display.previewSample', 'Preview (sample values: run a test for real ones)')}
        </p>
        <DeviceCheckChip summary={summary} />
      </div>
    </div>
  );
}
