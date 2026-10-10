/**
 * ExtractorRow — one row of a variant's "Extract" table:
 * target field, source type (regex / JSON path / XML path / HTTP
 * status / duration), expression, regex group, required, transforms.
 *
 * The row the admin last focused is the "active" extractor: the Test panel's
 * "copy to extractor" helpers fill its pattern or path.
 */

import { useTranslation } from 'react-i18next';
import { Crosshair, Trash2 } from 'lucide-react';
import { DEVICE_CHECK_LIMITS, type DeviceCheckExtractor, type DeviceCheckField } from '@oblimap/shared';
import { Checkbox } from '@/components/ui/Checkbox';
import { cn } from '@/utils/cn';
import { NumberInput, inputCls, invalidCls, type IssueIndex } from './GeneralSection';
import { TransformChips } from './TransformChips';

export type ExtractorType = DeviceCheckExtractor['type'];

export const EXTRACTOR_TYPES: ExtractorType[] = ['regex', 'json', 'xml', 'httpStatus', 'durationMs'];

export const EXTRACTOR_TYPE_FALLBACKS: Record<ExtractorType, string> = {
  regex: 'Regex',
  json: 'JSON path',
  xml: 'XML path',
  httpStatus: 'HTTP status',
  durationMs: 'Response time (ms)',
};

/** Converts an extractor to another type, keeping what still applies. */
export function convertExtractor(x: DeviceCheckExtractor, type: ExtractorType): DeviceCheckExtractor {
  if (x.type === type) return x;
  const base = 'transforms' in x || 'required' in x
    ? { transforms: 'transforms' in x ? x.transforms : undefined, required: 'required' in x ? x.required : undefined }
    : {};
  const oldPath = x.type === 'json' || x.type === 'xml' ? x.path : '';
  switch (type) {
    case 'regex':
      return { field: x.field, type: 'regex', source: 'body', pattern: x.type === 'regex' ? x.pattern : '', group: 1, ...base };
    case 'json':
      return { field: x.field, type: 'json', path: x.type === 'xml' ? '' : oldPath, ...base };
    case 'xml':
      return { field: x.field, type: 'xml', path: x.type === 'json' ? '' : oldPath, ...base };
    case 'httpStatus':
      return { field: x.field, type: 'httpStatus' };
    case 'durationMs':
      return { field: x.field, type: 'durationMs' };
  }
}

interface ExtractorRowProps {
  extractor: DeviceCheckExtractor;
  onChange: (x: DeviceCheckExtractor) => void;
  onRemove: () => void;
  fields: DeviceCheckField[];
  errors: IssueIndex;
  /** Issue path of this extractor ("variants.0.extract.1"). */
  path: string;
  active: boolean;
  onActivate: () => void;
}

export function ExtractorRow({ extractor: x, onChange, onRemove, fields, errors, path, active, onActivate }: ExtractorRowProps) {
  const { t } = useTranslation();
  const fieldKnown = fields.some((f) => f.key === x.field);
  const exprPath = x.type === 'regex' ? `${path}.pattern` : `${path}.path`;
  const exprError = errors.at(exprPath);

  return (
    <div
      className={cn(
        'rounded-md p-2 transition-colors',
        active ? 'bg-accent/5 ring-1 ring-accent/50' : 'bg-bg-secondary/60',
      )}
      onFocusCapture={onActivate}
    >
      <div className="flex flex-wrap items-start gap-2">
        <button
          type="button"
          onClick={onActivate}
          aria-pressed={active}
          title={t('deviceChecks.editor.extract.activate', 'Target of "copy to extractor" in the Test panel')}
          className={cn('mt-1 rounded p-1', active ? 'text-accent' : 'text-text-muted hover:text-text-primary')}
        >
          <Crosshair size={13} />
        </button>

        <div className="w-36 min-w-0">
          <select
            value={x.field}
            onChange={(e) => onChange({ ...x, field: e.target.value })}
            className={cn(inputCls, 'text-xs', (!fieldKnown || errors.at(`${path}.field`)) && invalidCls)}
            aria-label={t('deviceChecks.editor.extract.field', 'Field')}
            title={errors.at(`${path}.field`)}
          >
            {!fieldKnown && <option value={x.field}>{x.field || t('deviceChecks.editor.extract.pickField', 'Pick a field')}</option>}
            {fields.map((f) => (
              <option key={f.key} value={f.key}>{f.label ? `${f.label} (${f.key})` : f.key}</option>
            ))}
          </select>
        </div>

        <div className="w-36">
          <select
            value={x.type}
            onChange={(e) => onChange(convertExtractor(x, e.target.value as ExtractorType))}
            className={cn(inputCls, 'text-xs')}
            aria-label={t('deviceChecks.editor.extract.type', 'Source')}
          >
            {EXTRACTOR_TYPES.map((type) => (
              <option key={type} value={type}>{t(`deviceChecks.editor.extract.types.${type}`, EXTRACTOR_TYPE_FALLBACKS[type])}</option>
            ))}
          </select>
        </div>

        {(x.type === 'regex' || x.type === 'json' || x.type === 'xml') && (
          <div className="min-w-[12rem] flex-1">
            <input
              value={x.type === 'regex' ? x.pattern : x.path}
              maxLength={x.type === 'regex' ? DEVICE_CHECK_LIMITS.maxPatternLength : DEVICE_CHECK_LIMITS.maxPathLength}
              onChange={(e) => onChange(x.type === 'regex' ? { ...x, pattern: e.target.value } : { ...x, path: e.target.value })}
              placeholder={x.type === 'regex'
                ? '(?is)Now playing\\s*:\\s*([^<]+)'
                : x.type === 'json' ? 'player.metadata.title' : '/status/player/@state'}
              spellCheck={false}
              aria-label={x.type === 'regex'
                ? t('deviceChecks.editor.extract.pattern', 'Pattern')
                : t('deviceChecks.editor.extract.path', 'Path')}
              className={cn(inputCls, 'font-mono text-xs', exprError && invalidCls)}
            />
            {exprError && <p className="mt-0.5 text-xs text-status-down">{exprError}</p>}
          </div>
        )}

        {x.type === 'regex' && (
          <>
            <div className="w-24">
              <select
                value={x.source}
                onChange={(e) => {
                  const source = e.target.value as 'body' | 'header';
                  const next = { ...x, source };
                  if (source === 'body') delete next.header;
                  onChange(next);
                }}
                className={cn(inputCls, 'text-xs')}
                aria-label={t('deviceChecks.editor.extract.source', 'Read from')}
              >
                <option value="body">{t('deviceChecks.editor.extract.sourceBody', 'Body')}</option>
                <option value="header">{t('deviceChecks.editor.extract.sourceHeader', 'Header')}</option>
              </select>
            </div>
            {x.source === 'header' && (
              <div className="w-32">
                <input
                  value={x.header ?? ''}
                  maxLength={64}
                  onChange={(e) => onChange({ ...x, header: e.target.value })}
                  placeholder={t('deviceChecks.editor.extract.headerPlaceholder', 'Server')}
                  aria-label={t('deviceChecks.editor.extract.header', 'Header name')}
                  className={cn(inputCls, 'font-mono text-xs', errors.at(`${path}.header`) && invalidCls)}
                  title={errors.at(`${path}.header`)}
                />
              </div>
            )}
            <div className="flex w-20 items-center gap-1" title={t('deviceChecks.editor.extract.groupHint', 'Capture group whose text becomes the value (0 = whole match)')}>
              <span className="text-[11px] text-text-muted">{t('deviceChecks.editor.extract.group', 'Group')}</span>
              <NumberInput
                value={x.group}
                min={0}
                max={99}
                onChange={(group) => onChange({ ...x, group })}
                error={errors.at(`${path}.group`)}
                className="px-1.5 text-xs"
              />
            </div>
          </>
        )}

        {(x.type === 'regex' || x.type === 'json' || x.type === 'xml') && (
          <label className="mt-1.5 flex items-center gap-1.5 text-xs text-text-secondary" title={t('deviceChecks.editor.extract.requiredHint', 'The variant only succeeds when this element is found (an empty value still counts as found)')}>
            <Checkbox
              checked={!!x.required}
              onCheckedChange={(v) => onChange({ ...x, required: v || undefined })}
            />
            {t('deviceChecks.editor.extract.required', 'Required')}
          </label>
        )}

        <button
          type="button"
          onClick={onRemove}
          className="ml-auto mt-0.5 rounded p-1.5 text-text-muted hover:text-red-400"
          aria-label={t('deviceChecks.editor.extract.remove', 'Remove extractor')}
        >
          <Trash2 size={13} />
        </button>
      </div>

      {(x.type === 'regex' || x.type === 'json' || x.type === 'xml') && (
        <div className="mt-2 pl-8">
          <TransformChips
            transforms={x.transforms}
            onChange={(transforms) => onChange({ ...x, transforms })}
            errors={errors}
            path={`${path}.transforms`}
          />
        </div>
      )}
      {errors.at(path) && <p className="mt-1 pl-8 text-xs text-status-down">{errors.at(path)}</p>}
    </div>
  );
}
