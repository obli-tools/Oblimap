/**
 * VariantsSection — the ordered request variants of a rule.
 * The probe tries them in order (the last one that worked on a
 * device first) until one answers with an expected status and finds every
 * required element.
 */

import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { DEVICE_CHECK_LIMITS, type DeviceCheckField, type DeviceCheckVariant } from '@oblimap/shared';
import type { IssueIndex } from './GeneralSection';
import { VariantCard } from './VariantCard';

export interface ExtractorPosition {
  variant: number;
  index: number;
}

/** A new GET / variant with a unique id, on the first allowed port. */
export function newVariant(existing: DeviceCheckVariant[], allowedPorts: number[]): DeviceCheckVariant {
  let n = existing.length + 1;
  while (existing.some((v) => v.id === `variant-${n}`)) n++;
  const port = allowedPorts.includes(80) ? 80 : (allowedPorts[0] ?? 80);
  return {
    id: `variant-${n}`,
    request: {
      scheme: port === 443 || port === 8443 ? 'https' : 'http',
      port,
      method: 'GET',
      path: '/',
      accept: 'text/html',
      auth: 'none',
      maxBodyBytes: 65536,
      followRedirects: 0,
      tlsSkipVerify: false,
      expectStatus: [200],
      charset: 'auto',
    },
    extract: [],
  };
}

interface VariantsSectionProps {
  variants: DeviceCheckVariant[];
  onChange: (v: DeviceCheckVariant[]) => void;
  fields: DeviceCheckField[];
  allowedPorts: number[];
  errors: IssueIndex;
  activeExtractor: ExtractorPosition | null;
  onActivateExtractor: (pos: ExtractorPosition | null) => void;
}

export function VariantsSection({
  variants, onChange, fields, allowedPorts, errors, activeExtractor, onActivateExtractor,
}: VariantsSectionProps) {
  const { t } = useTranslation();

  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= variants.length) return;
    const next = [...variants];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
    if (activeExtractor?.variant === i) onActivateExtractor({ ...activeExtractor, variant: j });
    else if (activeExtractor?.variant === j) onActivateExtractor({ ...activeExtractor, variant: i });
  };

  const remove = (i: number) => {
    onChange(variants.filter((_, j) => j !== i));
    if (activeExtractor?.variant === i) onActivateExtractor(null);
    else if (activeExtractor && activeExtractor.variant > i) onActivateExtractor({ ...activeExtractor, variant: activeExtractor.variant - 1 });
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-text-muted">
        {t('deviceChecks.editor.variants.intro', 'Variants are tried in order, the one that last worked on a device first. A variant succeeds when the status is expected and every required element is found.')}
      </p>
      {errors.at('variants') && <p className="text-xs text-status-down">{errors.at('variants')}</p>}

      {variants.map((v, i) => (
        <VariantCard
          key={i}
          variant={v}
          index={i}
          count={variants.length}
          fields={fields}
          allowedPorts={allowedPorts}
          errors={errors}
          onChange={(nv) => onChange(variants.map((x, j) => (j === i ? nv : x)))}
          onRemove={() => remove(i)}
          onMove={(d) => move(i, d)}
          activeExtractor={activeExtractor?.variant === i ? activeExtractor.index : null}
          onActivateExtractor={(index) => onActivateExtractor(index === null ? null : { variant: i, index })}
        />
      ))}

      {variants.length < DEVICE_CHECK_LIMITS.maxVariants && (
        <button
          type="button"
          onClick={() => onChange([...variants, newVariant(variants, allowedPorts)])}
          className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-3 py-1.5 text-sm text-text-muted hover:border-accent/50 hover:text-text-primary"
        >
          <Plus size={14} />{t('deviceChecks.editor.variants.add', 'Add a variant')}
        </button>
      )}
    </div>
  );
}
