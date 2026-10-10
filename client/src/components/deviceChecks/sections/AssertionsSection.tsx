/**
 * AssertionsSection — the checks evaluated on every result:
 * label, field, operator, then a value, a pattern or a duration
 * depending on the operator, optional, enabled. Patterns run on the probe
 * (RE2); the server evaluates the other operators.
 */

import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';
import {
  DEVICE_CHECK_ASSERTION_OPS,
  DEVICE_CHECK_LIMITS,
  type DeviceCheckAssertion,
  type DeviceCheckAssertionOp,
  type DeviceCheckField,
} from '@oblimap/shared';
import { Checkbox } from '@/components/ui/Checkbox';
import { cn } from '@/utils/cn';
import { NumberInput, TagListInput, inputCls, invalidCls, type IssueIndex } from './GeneralSection';

export const ASSERTION_OP_FALLBACKS: Record<DeviceCheckAssertionOp, string> = {
  exists: 'is present',
  notEmpty: 'is not empty',
  equals: 'equals',
  notEquals: 'is not',
  in: 'is one of',
  notIn: 'is none of',
  contains: 'contains',
  notContains: 'does not contain',
  matches: 'matches the pattern',
  notMatches: 'does not match the pattern',
  gt: 'is greater than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  changedWithin: 'changed within',
};

const NUMERIC_OPS: DeviceCheckAssertionOp[] = ['gt', 'gte', 'lt', 'lte'];
const MAX_IN_VALUES = 20;

function nextAssertionId(list: DeviceCheckAssertion[]): string {
  for (let n = list.length + 1; ; n++) {
    const id = `check${n}`;
    if (!list.some((a) => a.id === id)) return id;
  }
}

/** Resets the operand of an assertion when its operator (or field type) changes. */
function withOp(a: DeviceCheckAssertion, op: DeviceCheckAssertionOp, field: DeviceCheckField | undefined): DeviceCheckAssertion {
  const next: DeviceCheckAssertion = { id: a.id, label: a.label, field: a.field, op, enabled: a.enabled };
  if (a.optional) next.optional = true;
  const numeric = field?.valueType === 'number';
  switch (op) {
    case 'exists':
    case 'notEmpty':
      break;
    case 'matches':
    case 'notMatches':
      next.pattern = a.pattern ?? '';
      break;
    case 'changedWithin':
      next.seconds = a.seconds ?? 3600;
      break;
    case 'in':
    case 'notIn':
      next.value = Array.isArray(a.value) ? a.value : [];
      break;
    case 'gt': case 'gte': case 'lt': case 'lte':
      next.value = typeof a.value === 'number' ? a.value : 0;
      break;
    default: {
      // equals / notEquals / contains / notContains: keep the operand, typed like the field.
      const v = a.value;
      const equality = op === 'equals' || op === 'notEquals';
      if (numeric && equality) {
        next.value = typeof v === 'number' ? v : v !== '' && Number.isFinite(Number(v)) ? Number(v) : 0;
      } else if (field?.valueType === 'boolean' && equality) {
        next.value = typeof v === 'boolean' ? v : true;
      } else {
        next.value = v !== undefined && !Array.isArray(v) ? String(v) : '';
      }
    }
  }
  return next;
}

function OperandEditor({
  a, field, onChange, errors, path,
}: {
  a: DeviceCheckAssertion;
  field: DeviceCheckField | undefined;
  onChange: (a: DeviceCheckAssertion) => void;
  errors: IssueIndex;
  path: string;
}) {
  const { t } = useTranslation();
  const valueError = errors.within(`${path}.value`);

  if (a.op === 'exists' || a.op === 'notEmpty') return null;

  if (a.op === 'matches' || a.op === 'notMatches') {
    return (
      <div className="min-w-[12rem] flex-1">
        <input
          value={a.pattern ?? ''}
          maxLength={DEVICE_CHECK_LIMITS.maxPatternLength}
          onChange={(e) => onChange({ ...a, pattern: e.target.value })}
          placeholder="(?i)^\s*(none|unknown)\s*$"
          spellCheck={false}
          aria-label={t('deviceChecks.editor.assertions.pattern', 'Pattern')}
          className={cn(inputCls, 'font-mono text-xs', errors.at(`${path}.pattern`) && invalidCls)}
        />
        {errors.at(`${path}.pattern`) && <p className="mt-0.5 text-xs text-status-down">{errors.at(`${path}.pattern`)}</p>}
      </div>
    );
  }

  if (a.op === 'changedWithin') {
    const s = a.seconds ?? 0;
    return (
      <div className="flex items-center gap-1.5">
        <NumberInput
          value={a.seconds}
          min={60}
          max={86400}
          onChange={(seconds) => onChange({ ...a, seconds })}
          error={errors.at(`${path}.seconds`)}
          className="w-28"
        />
        <span className="text-xs text-text-muted">
          {t('deviceChecks.editor.assertions.seconds', { minutes: Math.round(s / 60), defaultValue: 's (≈ {{minutes}} min)' })}
        </span>
        {errors.at(`${path}.seconds`) && <p className="text-xs text-status-down">{errors.at(`${path}.seconds`)}</p>}
      </div>
    );
  }

  if (a.op === 'in' || a.op === 'notIn') {
    const values = Array.isArray(a.value) ? a.value.map(String) : [];
    const numeric = field?.valueType === 'number';
    return (
      <div className="min-w-[12rem] flex-1">
        <TagListInput
          values={values}
          onChange={(v) => onChange({ ...a, value: numeric ? v.map(Number) : v })}
          normalize={(raw) => (numeric ? (Number.isFinite(Number(raw)) ? String(Number(raw)) : null) : raw.slice(0, DEVICE_CHECK_LIMITS.maxValueLength))}
          max={MAX_IN_VALUES}
          mono
          placeholder={t('deviceChecks.editor.assertions.values', 'Values, Enter to add')}
          error={valueError}
        />
        {valueError && <p className="mt-0.5 text-xs text-status-down">{valueError}</p>}
      </div>
    );
  }

  if (NUMERIC_OPS.includes(a.op) || ((a.op === 'equals' || a.op === 'notEquals') && field?.valueType === 'number')) {
    return (
      <div className="w-32">
        <NumberInput
          value={typeof a.value === 'number' ? a.value : undefined}
          step={0.01}
          onChange={(value) => onChange({ ...a, value })}
          error={valueError}
        />
        {valueError && <p className="mt-0.5 text-xs text-status-down">{valueError}</p>}
      </div>
    );
  }

  if ((a.op === 'equals' || a.op === 'notEquals') && field?.valueType === 'boolean') {
    return (
      <select
        value={String(a.value === true)}
        onChange={(e) => onChange({ ...a, value: e.target.value === 'true' })}
        className={cn(inputCls, 'w-28', valueError && invalidCls)}
      >
        <option value="true">{t('deviceChecks.value.true', 'Yes')}</option>
        <option value="false">{t('deviceChecks.value.false', 'No')}</option>
      </select>
    );
  }

  if ((a.op === 'equals' || a.op === 'notEquals') && field?.valueType === 'enum' && field.enumValues?.length) {
    const current = typeof a.value === 'string' ? a.value : '';
    const known = field.enumValues.some((ev) => ev.value === current);
    return (
      <select
        value={current}
        onChange={(e) => onChange({ ...a, value: e.target.value })}
        className={cn(inputCls, 'w-44', (valueError || !known) && invalidCls)}
        title={valueError}
      >
        {!known && <option value={current}>{current || '—'}</option>}
        {field.enumValues.map((ev) => (
          <option key={ev.value} value={ev.value}>{ev.label ? `${ev.label} (${ev.value})` : ev.value}</option>
        ))}
      </select>
    );
  }

  // equals / notEquals (text), contains / notContains
  return (
    <div className="min-w-[10rem] flex-1">
      <input
        value={typeof a.value === 'string' || typeof a.value === 'number' ? String(a.value) : ''}
        maxLength={DEVICE_CHECK_LIMITS.maxValueLength}
        onChange={(e) => onChange({ ...a, value: e.target.value })}
        aria-label={t('deviceChecks.editor.assertions.value', 'Value')}
        className={cn(inputCls, 'text-xs', valueError && invalidCls)}
      />
      {valueError && <p className="mt-0.5 text-xs text-status-down">{valueError}</p>}
    </div>
  );
}

interface AssertionsSectionProps {
  assertions: DeviceCheckAssertion[];
  onChange: (a: DeviceCheckAssertion[]) => void;
  fields: DeviceCheckField[];
  errors: IssueIndex;
}

export function AssertionsSection({ assertions, onChange, fields, errors }: AssertionsSectionProps) {
  const { t } = useTranslation();
  const opLabel = (op: DeviceCheckAssertionOp) => t(`deviceChecks.ops.${op}`, ASSERTION_OP_FALLBACKS[op]);
  const update = (i: number, a: DeviceCheckAssertion) => onChange(assertions.map((x, j) => (j === i ? a : x)));

  return (
    <div className="space-y-3">
      <p className="text-xs text-text-muted">
        {t('deviceChecks.editor.assertions.intro', 'A result is failing when an enabled check fails. A missing value fails the check, unless the check is optional.')}
      </p>
      {errors.at('assertions') && <p className="text-xs text-status-down">{errors.at('assertions')}</p>}

      {assertions.map((a, i) => {
        const p = `assertions.${i}`;
        const field = fields.find((f) => f.key === a.field);
        return (
          <div key={i} className={cn('rounded-md bg-bg-tertiary/40 p-2', !a.enabled && 'opacity-60')}>
            <div className="flex flex-wrap items-start gap-2">
              <input
                value={a.label}
                maxLength={128}
                onChange={(e) => update(i, { ...a, label: e.target.value })}
                placeholder={t('deviceChecks.editor.assertions.label', 'Label shown in alerts')}
                className={cn(inputCls, 'min-w-[12rem] flex-[2] text-xs', errors.at(`${p}.label`) && invalidCls)}
                title={errors.at(`${p}.label`)}
              />
              <select
                value={a.field}
                onChange={(e) => update(i, withOp({ ...a, field: e.target.value }, a.op, fields.find((f) => f.key === e.target.value)))}
                className={cn(inputCls, 'w-40 text-xs', (!field || errors.at(`${p}.field`)) && invalidCls)}
                aria-label={t('deviceChecks.editor.assertions.field', 'Field')}
                title={errors.at(`${p}.field`)}
              >
                {!field && <option value={a.field}>{a.field || t('deviceChecks.editor.extract.pickField', 'Pick a field')}</option>}
                {fields.map((f) => <option key={f.key} value={f.key}>{f.label ? `${f.label} (${f.key})` : f.key}</option>)}
              </select>
              <select
                value={a.op}
                onChange={(e) => update(i, withOp(a, e.target.value as DeviceCheckAssertionOp, field))}
                className={cn(inputCls, 'w-48 text-xs', errors.at(`${p}.op`) && invalidCls)}
                aria-label={t('deviceChecks.editor.assertions.op', 'Operator')}
              >
                {DEVICE_CHECK_ASSERTION_OPS.map((op) => <option key={op} value={op}>{opLabel(op)}</option>)}
              </select>
              <OperandEditor a={a} field={field} onChange={(na) => update(i, na)} errors={errors} path={p} />
              <button
                type="button"
                onClick={() => onChange(assertions.filter((_, j) => j !== i))}
                className="ml-auto rounded p-1.5 text-text-muted hover:text-red-400"
                aria-label={t('deviceChecks.editor.assertions.remove', 'Remove check')}
              >
                <Trash2 size={13} />
              </button>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-text-secondary">
              <label className="flex items-center gap-1.5">
                <Checkbox checked={a.enabled} onCheckedChange={(v) => update(i, { ...a, enabled: v })} />
                {t('deviceChecks.editor.assertions.enabled', 'Enabled')}
              </label>
              {a.op !== 'exists' && (
                <label className="flex items-center gap-1.5" title={t('deviceChecks.editor.assertions.optionalHint', 'Skipped (not failed) when the value is missing')}>
                  <Checkbox checked={!!a.optional} onCheckedChange={(v) => update(i, { ...a, optional: v || undefined })} />
                  {t('deviceChecks.editor.assertions.optional', 'Optional')}
                </label>
              )}
              <span className="font-mono text-[11px] text-text-muted">id: {a.id}</span>
              {errors.at(p) && <span className="text-status-down">{errors.at(p)}</span>}
            </div>
          </div>
        );
      })}

      {assertions.length < DEVICE_CHECK_LIMITS.maxAssertions && (
        <button
          type="button"
          disabled={fields.length === 0}
          onClick={() => {
            const f = fields[0];
            onChange([...assertions, { id: nextAssertionId(assertions), label: '', field: f?.key ?? '', op: 'notEmpty', enabled: true }]);
          }}
          className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-3 py-1.5 text-sm text-text-muted hover:border-accent/50 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus size={14} />{t('deviceChecks.editor.assertions.add', 'Add a check')}
        </button>
      )}
    </div>
  );
}
