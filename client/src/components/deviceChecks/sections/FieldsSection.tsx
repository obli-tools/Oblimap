/**
 * FieldsSection — the typed values a rule extracts:
 * key, label, type, enum values with a tone, max length, sensitive, historize.
 * Renaming a key follows every reference (extractors, assertions, display
 * slots, templates) once the key is committed (blur / Enter); removing a
 * field removes what used it.
 */

import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Plus, Trash2, X } from 'lucide-react';
import {
  DEVICE_CHECK_LIMITS,
  type DeviceCheckField,
  type DeviceCheckSpec,
  type DeviceCheckTone,
} from '@oblimap/shared';
import { DEVICE_CHECK_TONE_CLASSES } from '../DeviceCheckChip';
import { cn } from '@/utils/cn';
import { CheckRow, FormRow, NumberInput, inputCls, invalidCls, type IssueIndex } from './GeneralSection';

const MAX_ENUM_VALUES = 12;
/** Same rule as the spec schema (DeviceCheckField.key). */
const FIELD_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;
const VALUE_TYPES: DeviceCheckField['valueType'][] = ['string', 'number', 'boolean', 'enum'];
const VALUE_TYPE_FALLBACKS: Record<DeviceCheckField['valueType'], string> = {
  string: 'Text', number: 'Number', boolean: 'Yes / no', enum: 'List of values',
};
export const TONES: DeviceCheckTone[] = ['ok', 'warn', 'bad', 'neutral'];
export const TONE_FALLBACKS: Record<DeviceCheckTone, string> = {
  ok: 'OK (green)', warn: 'Warning (amber)', bad: 'Bad (red)', neutral: 'Neutral (gray)',
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Moves every reference to field `from` onto `to` (both valid keys). */
function renameFieldRefs(spec: DeviceCheckSpec, from: string, to: string): DeviceCheckSpec {
  if (!from || !to || from === to) return spec;
  const swap = (k: string | undefined) => (k === from ? to : k);
  const tpl = (s: string | undefined) => (s === undefined
    ? s
    : s.replace(new RegExp(`\\{\\{\\s*value\\.${escapeRegExp(from)}\\s*\\}\\}`, 'g'), `{{value.${to}}}`));
  return {
    ...spec,
    variants: spec.variants.map((v) => ({ ...v, extract: v.extract.map((x) => ({ ...x, field: swap(x.field) ?? x.field })) })),
    assertions: spec.assertions.map((a) => ({ ...a, field: swap(a.field) ?? a.field })),
    display: {
      ...spec.display,
      primary: swap(spec.display.primary),
      secondary: swap(spec.display.secondary),
      badge: swap(spec.display.badge),
    },
    alerting: { ...spec.alerting, titleTemplate: tpl(spec.alerting.titleTemplate), messageTemplate: tpl(spec.alerting.messageTemplate) },
  };
}

function nextFieldKey(fields: DeviceCheckField[]): string {
  for (let n = fields.length + 1; ; n++) {
    const k = `field${n}`;
    if (!fields.some((f) => f.key === k)) return k;
  }
}

interface FieldsSectionProps {
  spec: DeviceCheckSpec;
  onChange: (spec: DeviceCheckSpec) => void;
  errors: IssueIndex;
}

export function FieldsSection({ spec, onChange, errors }: FieldsSectionProps) {
  const { t } = useTranslation();
  const fields = spec.fields;
  // Key being edited and the key its references still use. The references
  // follow once, on commit, never the intermediate keys typed on the way
  // (an empty key, or one that briefly equals another field's key).
  const keyEdit = useRef<{ index: number; from: string } | null>(null);

  const setField = (index: number, patch: Partial<DeviceCheckField>) => {
    onChange({ ...spec, fields: fields.map((f, i) => (i === index ? { ...f, ...patch } : f)) });
  };

  const typeKey = (index: number, key: string) => {
    if (keyEdit.current?.index !== index) keyEdit.current = { index, from: fields[index].key };
    setField(index, { key });
  };

  const withKey = (index: number, key: string): DeviceCheckSpec =>
    ({ ...spec, fields: fields.map((f, i) => (i === index ? { ...f, key } : f)) });

  /** Blur / Enter: keeps a valid, unique key and moves the references; otherwise restores the previous key. */
  const commitKey = (index: number) => {
    const edit = keyEdit.current;
    keyEdit.current = null;
    if (!edit || edit.index !== index) return;
    const to = fields[index].key;
    if (to === edit.from) return;
    const taken = fields.some((f, i) => i !== index && f.key === to);
    if (!FIELD_KEY_RE.test(to) || taken) {
      onChange(withKey(index, edit.from));
      toast.error(taken
        ? t('deviceChecks.editor.fields.keyTaken', { key: to, defaultValue: 'Another field already uses the key "{{key}}": the previous key was kept' })
        : t('deviceChecks.editor.fields.keyInvalid', 'A key starts with a letter, then letters, digits or _ (32 max): the previous key was kept'));
      return;
    }
    // When another field still has the old key, the references stay with it.
    if (fields.some((f, i) => i !== index && f.key === edit.from)) return;
    onChange(renameFieldRefs(spec, edit.from, to));
  };

  const cancelKey = (index: number) => {
    const edit = keyEdit.current;
    keyEdit.current = null;
    if (edit && edit.index === index && fields[index].key !== edit.from) onChange(withKey(index, edit.from));
  };

  const setType = (index: number, valueType: DeviceCheckField['valueType']) => {
    const f = fields[index];
    const patch: Partial<DeviceCheckField> = { valueType };
    const nextField: DeviceCheckField = { ...f, ...patch };
    if (valueType === 'enum') {
      nextField.enumValues = f.enumValues?.length ? f.enumValues : [{ value: '', label: '', tone: 'neutral' }];
    } else {
      delete nextField.enumValues;
    }
    if (valueType === 'number' || valueType === 'boolean') delete nextField.maxLength;
    onChange({ ...spec, fields: fields.map((x, i) => (i === index ? nextField : x)) });
  };

  const addField = () => {
    if (fields.length >= DEVICE_CHECK_LIMITS.maxFields) return;
    onChange({ ...spec, fields: [...fields, { key: nextFieldKey(fields), label: '', valueType: 'string', maxLength: 200 }] });
  };

  const removeField = (index: number) => {
    keyEdit.current = null; // indexes shift
    const key = fields[index].key;
    const shared = fields.filter((f) => f.key === key).length > 1;
    if (shared) {
      onChange({ ...spec, fields: fields.filter((_, i) => i !== index) });
      return;
    }
    let extractors = 0;
    const variants = spec.variants.map((v) => {
      const extract = v.extract.filter((x) => x.field !== key);
      extractors += v.extract.length - extract.length;
      return { ...v, extract };
    });
    const assertions = spec.assertions.filter((a) => a.field !== key);
    const removedAssertions = spec.assertions.length - assertions.length;
    const drop = (k: string | undefined) => (k === key ? undefined : k);
    onChange({
      ...spec,
      fields: fields.filter((_, i) => i !== index),
      variants,
      assertions,
      display: { ...spec.display, primary: drop(spec.display.primary), secondary: drop(spec.display.secondary), badge: drop(spec.display.badge) },
    });
    if (extractors + removedAssertions > 0) {
      toast(t('deviceChecks.editor.fields.removedRefs', {
        extractors,
        assertions: removedAssertions,
        defaultValue: 'Also removed {{extractors}} extractor(s) and {{assertions}} check(s) that used this field',
      }));
    }
  };

  const setEnum = (index: number, values: NonNullable<DeviceCheckField['enumValues']>) => setField(index, { enumValues: values });

  return (
    <div className="space-y-3">
      {errors.at('fields') && <p className="text-xs text-status-down">{errors.at('fields')}</p>}
      {fields.length === 0 && (
        <p className="text-xs text-text-muted">{t('deviceChecks.editor.fields.empty', 'Declare at least one field: the values the probe extracts.')}</p>
      )}

      {fields.map((f, i) => {
        const p = `fields.${i}`;
        return (
          <div key={i} className="rounded-md bg-bg-tertiary/40 p-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)_6rem_auto]">
              <FormRow label={t('deviceChecks.editor.fields.key', 'Key')} error={errors.at(`${p}.key`)}>
                <input
                  value={f.key}
                  maxLength={32}
                  onChange={(e) => typeKey(i, e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
                  onBlur={() => commitKey(i)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); commitKey(i); }
                    else if (e.key === 'Escape') { e.preventDefault(); cancelKey(i); }
                  }}
                  className={cn(inputCls, 'font-mono', errors.at(`${p}.key`) && invalidCls)}
                  spellCheck={false}
                />
              </FormRow>
              <FormRow label={t('deviceChecks.editor.fields.label', 'Label')} error={errors.at(`${p}.label`)}>
                <input
                  value={f.label}
                  maxLength={64}
                  onChange={(e) => setField(i, { label: e.target.value })}
                  className={cn(inputCls, errors.at(`${p}.label`) && invalidCls)}
                />
              </FormRow>
              <FormRow label={t('deviceChecks.editor.fields.type', 'Type')} error={errors.at(`${p}.valueType`)}>
                <select
                  value={f.valueType}
                  onChange={(e) => setType(i, e.target.value as DeviceCheckField['valueType'])}
                  className={inputCls}
                >
                  {VALUE_TYPES.map((vt) => (
                    <option key={vt} value={vt}>{t(`deviceChecks.editor.fields.types.${vt}`, VALUE_TYPE_FALLBACKS[vt])}</option>
                  ))}
                </select>
              </FormRow>
              <FormRow label={t('deviceChecks.editor.fields.maxLength', 'Max length')} error={errors.at(`${p}.maxLength`)}>
                <NumberInput
                  value={f.maxLength}
                  min={1}
                  max={DEVICE_CHECK_LIMITS.maxValueLength}
                  disabled={f.valueType === 'number' || f.valueType === 'boolean'}
                  placeholder={String(DEVICE_CHECK_LIMITS.maxValueLength)}
                  onChange={(v) => setField(i, { maxLength: v })}
                  error={errors.at(`${p}.maxLength`)}
                />
              </FormRow>
              <div className="flex items-end justify-end">
                <button
                  type="button"
                  onClick={() => removeField(i)}
                  className="rounded p-2 text-text-muted hover:bg-bg-hover hover:text-red-400"
                  title={t('deviceChecks.editor.fields.remove', 'Remove field')}
                  aria-label={t('deviceChecks.editor.fields.remove', 'Remove field')}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
              <CheckRow
                id={`dc-field-${i}-sensitive`}
                checked={!!f.sensitive}
                onChange={(v) => setField(i, { sensitive: v || undefined })}
                label={t('deviceChecks.editor.fields.sensitive', 'Sensitive')}
                hint={t('deviceChecks.editor.fields.sensitiveHint', 'Masked in anonymous mode, never sent in notifications or live updates')}
              />
              <CheckRow
                id={`dc-field-${i}-historize`}
                checked={!!f.historize}
                onChange={(v) => setField(i, { historize: v || undefined })}
                label={t('deviceChecks.editor.fields.historize', 'Keep history')}
                hint={t('deviceChecks.editor.fields.historizeHint', 'Records every change of the value (kept 7 days)')}
              />
            </div>

            {f.valueType === 'enum' && (
              <div className="mt-3 space-y-2">
                <p className="text-xs font-medium text-text-secondary">{t('deviceChecks.editor.fields.enumValues', 'Allowed values')}</p>
                {errors.at(`${p}.enumValues`) && <p className="text-xs text-status-down">{errors.at(`${p}.enumValues`)}</p>}
                {(f.enumValues ?? []).map((ev, j) => {
                  const ep = `${p}.enumValues.${j}`;
                  const update = (patch: Partial<typeof ev>) =>
                    setEnum(i, (f.enumValues ?? []).map((x, k) => (k === j ? { ...x, ...patch } : x)));
                  return (
                    <div key={j} className="flex flex-wrap items-start gap-2">
                      <input
                        value={ev.value}
                        maxLength={DEVICE_CHECK_LIMITS.maxValueLength}
                        onChange={(e) => update({ value: e.target.value })}
                        placeholder={t('deviceChecks.editor.fields.enumValue', 'Value (as extracted)')}
                        className={cn(inputCls, 'w-40 font-mono', errors.at(`${ep}.value`) && invalidCls)}
                        title={errors.at(`${ep}.value`)}
                      />
                      <input
                        value={ev.label}
                        maxLength={64}
                        onChange={(e) => update({ label: e.target.value })}
                        placeholder={t('deviceChecks.editor.fields.enumLabel', 'Label')}
                        className={cn(inputCls, 'w-40', errors.at(`${ep}.label`) && invalidCls)}
                        title={errors.at(`${ep}.label`)}
                      />
                      <div className="flex items-center gap-1" role="radiogroup" aria-label={t('deviceChecks.editor.fields.tone', 'Tone')}>
                        {TONES.map((tone) => (
                          <button
                            key={tone}
                            type="button"
                            role="radio"
                            aria-checked={ev.tone === tone}
                            onClick={() => update({ tone })}
                            title={t(`deviceChecks.editor.fields.tones.${tone}`, TONE_FALLBACKS[tone])}
                            className={cn(
                              'rounded-full border px-2 py-0.5 text-[11px]',
                              DEVICE_CHECK_TONE_CLASSES[tone],
                              ev.tone === tone ? 'ring-1 ring-offset-1 ring-offset-bg-secondary ring-current' : 'opacity-50 hover:opacity-100',
                            )}
                          >
                            {t(`deviceChecks.editor.fields.toneShort.${tone}`, tone)}
                          </button>
                        ))}
                      </div>
                      <button
                        type="button"
                        onClick={() => setEnum(i, (f.enumValues ?? []).filter((_, k) => k !== j))}
                        className="rounded p-1.5 text-text-muted hover:text-red-400"
                        aria-label={t('deviceChecks.editor.fields.removeEnum', 'Remove value')}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  );
                })}
                {(f.enumValues?.length ?? 0) < MAX_ENUM_VALUES && (
                  <button
                    type="button"
                    onClick={() => setEnum(i, [...(f.enumValues ?? []), { value: '', label: '', tone: 'neutral' }])}
                    className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
                  >
                    <Plus size={12} />{t('deviceChecks.editor.fields.addEnum', 'Add a value')}
                  </button>
                )}
                <p className="text-[11px] text-text-muted">
                  {t('deviceChecks.editor.fields.enumHint', 'An extracted value that is not in this list becomes empty. Use a "map" transform to translate the device wording.')}
                </p>
              </div>
            )}
          </div>
        );
      })}

      {fields.length < DEVICE_CHECK_LIMITS.maxFields && (
        <button
          type="button"
          onClick={addField}
          className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-3 py-1.5 text-sm text-text-muted hover:border-accent/50 hover:text-text-primary"
        >
          <Plus size={14} />{t('deviceChecks.editor.fields.add', 'Add a field')}
        </button>
      )}
    </div>
  );
}
