/**
 * TransformChips — the ordered transforms of one extractor, as chips.
 * Clicking a chip opens its settings (map table,
 * truncate length, default value) and lets the admin reorder it.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight, Plus, Trash2, X } from 'lucide-react';
import { DEVICE_CHECK_LIMITS, type DeviceCheckTransform } from '@oblimap/shared';
import { cn } from '@/utils/cn';
import { NumberInput, inputCls, invalidCls, type IssueIndex } from './GeneralSection';

type TransformOp = DeviceCheckTransform['op'];

export const TRANSFORM_OPS: TransformOp[] = [
  'trim', 'collapseSpaces', 'htmlUnescape', 'stripTags', 'lowercase', 'uppercase', 'toNumber', 'map', 'truncate', 'default',
];

export const TRANSFORM_FALLBACKS: Record<TransformOp, string> = {
  trim: 'Trim',
  collapseSpaces: 'Collapse spaces',
  htmlUnescape: 'Decode HTML entities',
  stripTags: 'Strip HTML tags',
  lowercase: 'Lowercase',
  uppercase: 'Uppercase',
  toNumber: 'To number',
  map: 'Map values',
  truncate: 'Truncate',
  default: 'Default value',
};

const MAX_MAP_ENTRIES = 32;

function newTransform(op: TransformOp): DeviceCheckTransform {
  switch (op) {
    case 'map': return { op: 'map', values: {} };
    case 'truncate': return { op: 'truncate', max: 100 };
    case 'default': return { op: 'default', value: '' };
    default: return { op };
  }
}

// ─── Map editor (key → value table + default) ────────────────────────────────

function MapEditor({
  transform, onChange, errors, path,
}: {
  transform: Extract<DeviceCheckTransform, { op: 'map' }>;
  onChange: (t: DeviceCheckTransform) => void;
  errors: IssueIndex;
  path: string;
}) {
  const { t } = useTranslation();
  // Rows are edited locally so a half-typed or duplicate key never loses a row.
  const [rows, setRows] = useState<Array<[string, string]>>(() => Object.entries(transform.values));

  useEffect(() => {
    const local = JSON.stringify(Object.fromEntries(rows.filter(([k]) => k !== '')));
    // Resync only when the value changed from outside (import, another chip).
    if (local !== JSON.stringify(transform.values)) setRows(Object.entries(transform.values));
  }, [transform.values]); // eslint-disable-line react-hooks/exhaustive-deps

  const push = (next: Array<[string, string]>) => {
    setRows(next);
    onChange({ ...transform, values: Object.fromEntries(next.filter(([k]) => k !== '')) });
  };

  const keys = rows.map(([k]) => k);
  return (
    <div className="space-y-1.5">
      {errors.at(`${path}.values`) && <p className="text-xs text-status-down">{errors.at(`${path}.values`)}</p>}
      {rows.map(([k, v], i) => {
        const dup = k !== '' && keys.indexOf(k) !== i;
        return (
          <div key={i} className="flex items-center gap-1.5">
            <input
              value={k}
              maxLength={DEVICE_CHECK_LIMITS.maxValueLength}
              onChange={(e) => push(rows.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))}
              placeholder={t('deviceChecks.editor.transforms.mapFrom', 'Device value')}
              className={cn(inputCls, 'flex-1 font-mono text-xs', dup && invalidCls)}
              title={dup ? t('deviceChecks.editor.transforms.duplicateKey', 'Duplicate value: only the last row is kept') : undefined}
            />
            <span className="text-text-muted">→</span>
            <input
              value={v}
              maxLength={DEVICE_CHECK_LIMITS.maxValueLength}
              onChange={(e) => push(rows.map((r, j) => (j === i ? [r[0], e.target.value] : r)))}
              placeholder={t('deviceChecks.editor.transforms.mapTo', 'Becomes')}
              className={cn(inputCls, 'flex-1 font-mono text-xs')}
            />
            <button
              type="button"
              onClick={() => push(rows.filter((_, j) => j !== i))}
              className="rounded p-1 text-text-muted hover:text-red-400"
              aria-label={t('deviceChecks.editor.transforms.removeEntry', 'Remove entry')}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
      {rows.length < MAX_MAP_ENTRIES && (
        <button
          type="button"
          onClick={() => setRows([...rows, ['', '']])}
          className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
        >
          <Plus size={11} />{t('deviceChecks.editor.transforms.addEntry', 'Add an entry')}
        </button>
      )}
      <div className="flex items-center gap-1.5 pt-1">
        <span className="shrink-0 text-xs text-text-muted">{t('deviceChecks.editor.transforms.mapDefault', 'Anything else becomes')}</span>
        <input
          value={transform.default ?? ''}
          maxLength={DEVICE_CHECK_LIMITS.maxValueLength}
          onChange={(e) => {
            const next = { ...transform };
            if (e.target.value === '') delete next.default; else next.default = e.target.value;
            onChange(next);
          }}
          placeholder={t('deviceChecks.editor.transforms.mapKeep', '(unchanged)')}
          className={cn(inputCls, 'flex-1 font-mono text-xs', errors.at(`${path}.default`) && invalidCls)}
        />
      </div>
    </div>
  );
}

// ─── Chips ────────────────────────────────────────────────────────────────────

interface TransformChipsProps {
  transforms: DeviceCheckTransform[] | undefined;
  onChange: (next: DeviceCheckTransform[] | undefined) => void;
  errors: IssueIndex;
  /** Issue path of the transforms list ("variants.0.extract.2.transforms"). */
  path: string;
}

export function TransformChips({ transforms, onChange, errors, path }: TransformChipsProps) {
  const { t } = useTranslation();
  const list = transforms ?? [];
  const [open, setOpen] = useState<number | null>(null);
  const label = (op: TransformOp) => t(`deviceChecks.transforms.${op}`, TRANSFORM_FALLBACKS[op]);

  const set = (next: DeviceCheckTransform[]) => onChange(next.length > 0 ? next : undefined);
  const update = (i: number, tr: DeviceCheckTransform) => set(list.map((x, j) => (j === i ? tr : x)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    set(next);
    setOpen(j);
  };

  const summary = (tr: DeviceCheckTransform): string | null => {
    if (tr.op === 'map') return t('deviceChecks.editor.transforms.mapCount', { count: Object.keys(tr.values).length, defaultValue: '{{count}} entries' });
    if (tr.op === 'truncate') return `≤ ${tr.max}`;
    if (tr.op === 'default') return `"${tr.value}"`;
    return null;
  };

  const openTr = open !== null ? list[open] : undefined;

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-1">
        {list.map((tr, i) => {
          const bad = errors.under(`${path}.${i}`).length > 0;
          const extra = summary(tr);
          return (
            <span
              key={i}
              className={cn(
                'inline-flex items-center rounded-full text-[11px]',
                open === i ? 'bg-accent/10 text-accent' : 'bg-bg-tertiary text-text-secondary hover:bg-bg-hover',
                bad && 'ring-1 ring-status-down text-status-down',
              )}
            >
              <button
                type="button"
                onClick={() => setOpen(open === i ? null : i)}
                className="px-2 py-0.5"
                title={bad ? errors.under(`${path}.${i}`).map((x) => x.message).join(' · ') : undefined}
              >
                <span className="text-text-muted">{i + 1}.</span> {label(tr.op)}
                {extra && <span className="ml-1 font-mono text-text-muted">{extra}</span>}
              </button>
              <button
                type="button"
                onClick={() => { set(list.filter((_, j) => j !== i)); setOpen(null); }}
                className="pr-1.5 text-text-muted hover:text-red-400"
                aria-label={t('deviceChecks.editor.transforms.remove', 'Remove transform')}
              >
                <X size={10} />
              </button>
            </span>
          );
        })}
        {list.length < DEVICE_CHECK_LIMITS.maxTransforms && (
          <select
            value=""
            onChange={(e) => {
              if (!e.target.value) return;
              const tr = newTransform(e.target.value as TransformOp);
              set([...list, tr]);
              if (tr.op === 'map' || tr.op === 'truncate' || tr.op === 'default') setOpen(list.length);
            }}
            className="rounded-full border border-dashed border-border bg-transparent px-2 py-0.5 text-[11px] text-text-muted hover:border-accent/50 focus:outline-none"
            aria-label={t('deviceChecks.editor.transforms.add', 'Add a transform')}
          >
            <option value="">+ {t('deviceChecks.editor.transforms.add', 'Add a transform')}</option>
            {TRANSFORM_OPS.map((op) => <option key={op} value={op}>{label(op)}</option>)}
          </select>
        )}
      </div>
      {errors.at(path) && <p className="text-xs text-status-down">{errors.at(path)}</p>}

      {open !== null && openTr && (
        <div className="space-y-2 rounded-md bg-bg-primary/40 p-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-text-primary">{label(openTr.op)}</span>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => move(open, -1)} disabled={open === 0} className="rounded p-1 text-text-muted hover:text-text-primary disabled:opacity-30" aria-label={t('deviceChecks.editor.transforms.moveEarlier', 'Run earlier')}>
                <ChevronLeft size={13} />
              </button>
              <button type="button" onClick={() => move(open, 1)} disabled={open === list.length - 1} className="rounded p-1 text-text-muted hover:text-text-primary disabled:opacity-30" aria-label={t('deviceChecks.editor.transforms.moveLater', 'Run later')}>
                <ChevronRight size={13} />
              </button>
              <button type="button" onClick={() => { set(list.filter((_, j) => j !== open)); setOpen(null); }} className="rounded p-1 text-text-muted hover:text-red-400" aria-label={t('deviceChecks.editor.transforms.remove', 'Remove transform')}>
                <Trash2 size={13} />
              </button>
            </div>
          </div>
          {openTr.op === 'map' && (
            <MapEditor key={open} transform={openTr} onChange={(tr) => update(open, tr)} errors={errors} path={`${path}.${open}`} />
          )}
          {openTr.op === 'truncate' && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-text-muted">{t('deviceChecks.editor.transforms.truncateMax', 'Keep at most (characters)')}</span>
              <NumberInput
                value={openTr.max}
                min={1}
                max={DEVICE_CHECK_LIMITS.maxValueLength}
                onChange={(max) => update(open, { op: 'truncate', max })}
                error={errors.at(`${path}.${open}.max`)}
                className="w-24"
              />
            </div>
          )}
          {openTr.op === 'default' && (
            <div className="flex items-center gap-2">
              <span className="shrink-0 text-xs text-text-muted">{t('deviceChecks.editor.transforms.defaultValue', 'When empty, use')}</span>
              <input
                value={openTr.value}
                maxLength={DEVICE_CHECK_LIMITS.maxValueLength}
                onChange={(e) => update(open, { op: 'default', value: e.target.value })}
                className={cn(inputCls, 'font-mono text-xs', errors.at(`${path}.${open}.value`) && invalidCls)}
              />
            </div>
          )}
          {openTr.op !== 'map' && openTr.op !== 'truncate' && openTr.op !== 'default' && (
            <p className="text-xs text-text-muted">{t('deviceChecks.editor.transforms.noSettings', 'No settings. Transforms run in order, left to right.')}</p>
          )}
        </div>
      )}
    </div>
  );
}
