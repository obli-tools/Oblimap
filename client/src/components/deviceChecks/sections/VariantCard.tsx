/**
 * VariantCard — one request variant: the HTTP request
 * (scheme, port from the policy, method, path, Accept, auth, TLS, redirects,
 * body size, expected statuses, charset) and its "Extract" table.
 */

import { useTranslation } from 'react-i18next';
import { AlertTriangle, ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import {
  DEVICE_CHECK_LIMITS,
  type DeviceCheckExtractor,
  type DeviceCheckField,
  type DeviceCheckRequest,
  type DeviceCheckVariant,
} from '@oblimap/shared';
import { cn } from '@/utils/cn';
import { CheckRow, FormRow, NumberInput, TagListInput, inputCls, invalidCls, type IssueIndex } from './GeneralSection';
import { ExtractorRow } from './ExtractorRow';

const ACCEPTS: DeviceCheckRequest['accept'][] = ['text/html', 'application/json', 'application/xml', 'text/plain', '*/*'];
const CHARSETS: DeviceCheckRequest['charset'][] = ['auto', 'utf-8', 'iso-8859-1', 'windows-1252'];
const MAX_EXPECT_STATUS = 5;

/** A new extractor for the first field this variant does not extract yet. */
function newExtractor(variant: DeviceCheckVariant, fields: DeviceCheckField[]): DeviceCheckExtractor {
  const used = new Set(variant.extract.map((x) => x.field));
  const field = (fields.find((f) => !used.has(f.key)) ?? fields[0])?.key ?? '';
  if (variant.request.accept === 'application/json') return { field, type: 'json', path: '' };
  if (variant.request.accept === 'application/xml') return { field, type: 'xml', path: '' };
  return { field, type: 'regex', source: 'body', pattern: '', group: 1 };
}

interface VariantCardProps {
  variant: DeviceCheckVariant;
  index: number;
  count: number;
  onChange: (v: DeviceCheckVariant) => void;
  onRemove: () => void;
  onMove: (delta: -1 | 1) => void;
  fields: DeviceCheckField[];
  allowedPorts: number[];
  errors: IssueIndex;
  /** Index of the active extractor in this variant, or null. */
  activeExtractor: number | null;
  /** Makes an extractor of this variant the "copy to extractor" target; null clears the target. */
  onActivateExtractor: (index: number | null) => void;
}

export function VariantCard({
  variant, index, count, onChange, onRemove, onMove, fields, allowedPorts, errors, activeExtractor, onActivateExtractor,
}: VariantCardProps) {
  const { t } = useTranslation();
  const p = `variants.${index}`;
  const rp = `${p}.request`;
  const req = variant.request;
  const setReq = (patch: Partial<DeviceCheckRequest>) => onChange({ ...variant, request: { ...req, ...patch } });

  const ports = [...new Set([...allowedPorts, req.port])].sort((a, b) => a - b);
  const portAllowed = allowedPorts.includes(req.port);

  // The "copy to extractor" target follows its row: removing it clears the
  // target, removing a row above it shifts the index (like variants do).
  const removeExtractor = (i: number) => {
    onChange({ ...variant, extract: variant.extract.filter((_, j) => j !== i) });
    if (activeExtractor === i) onActivateExtractor(null);
    else if (activeExtractor !== null && activeExtractor > i) onActivateExtractor(activeExtractor - 1);
  };

  return (
    <div className="rounded-lg bg-bg-tertiary/40">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <span className="rounded bg-bg-hover px-1.5 py-0.5 font-mono text-[11px] text-text-muted">#{index + 1}</span>
        <input
          value={variant.id}
          maxLength={32}
          onChange={(e) => onChange({ ...variant, id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
          className={cn(inputCls, 'w-36 font-mono text-xs', errors.at(`${p}.id`) && invalidCls)}
          aria-label={t('deviceChecks.editor.variants.id', 'Variant id')}
          title={errors.at(`${p}.id`) ?? t('deviceChecks.editor.variants.idHint', 'Lowercase letters, digits and dashes')}
          spellCheck={false}
        />
        <input
          value={variant.label ?? ''}
          maxLength={128}
          onChange={(e) => onChange({ ...variant, label: e.target.value || undefined })}
          placeholder={t('deviceChecks.editor.variants.label', 'Description (optional)')}
          className={cn(inputCls, 'min-w-[10rem] flex-1 text-xs')}
        />
        <div className="ml-auto flex items-center gap-0.5">
          <button type="button" onClick={() => onMove(-1)} disabled={index === 0} className="rounded p-1.5 text-text-muted hover:bg-bg-hover hover:text-text-primary disabled:opacity-30" aria-label={t('deviceChecks.editor.variants.moveUp', 'Try earlier')} title={t('deviceChecks.editor.variants.moveUp', 'Try earlier')}>
            <ArrowUp size={13} />
          </button>
          <button type="button" onClick={() => onMove(1)} disabled={index === count - 1} className="rounded p-1.5 text-text-muted hover:bg-bg-hover hover:text-text-primary disabled:opacity-30" aria-label={t('deviceChecks.editor.variants.moveDown', 'Try later')} title={t('deviceChecks.editor.variants.moveDown', 'Try later')}>
            <ArrowDown size={13} />
          </button>
          <button type="button" onClick={onRemove} disabled={count <= 1} className="rounded p-1.5 text-text-muted hover:bg-bg-hover hover:text-red-400 disabled:opacity-30" aria-label={t('deviceChecks.editor.variants.remove', 'Remove variant')} title={t('deviceChecks.editor.variants.remove', 'Remove variant')}>
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      <div className="space-y-4 p-3">
        {errors.at(p) && <p className="text-xs text-status-down">{errors.at(p)}</p>}

        {/* Request */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <FormRow label={t('deviceChecks.editor.variants.scheme', 'Scheme')} error={errors.at(`${rp}.scheme`)}>
            <select
              value={req.scheme}
              onChange={(e) => {
                const scheme = e.target.value as DeviceCheckRequest['scheme'];
                const patch: Partial<DeviceCheckRequest> = { scheme };
                if (scheme === 'https' && req.port === 80 && allowedPorts.includes(443)) patch.port = 443;
                if (scheme === 'http' && req.port === 443 && allowedPorts.includes(80)) patch.port = 80;
                if (scheme === 'http') patch.tlsSkipVerify = false;
                setReq(patch);
              }}
              className={inputCls}
            >
              <option value="http">http</option>
              <option value="https">https</option>
            </select>
          </FormRow>
          <FormRow label={t('deviceChecks.editor.variants.port', 'Port')} error={errors.at(`${rp}.port`) ?? (!portAllowed ? t('deviceChecks.editor.variants.portNotAllowed', 'Not in the allowed ports of the policy') : undefined)}>
            <select
              value={req.port}
              onChange={(e) => setReq({ port: Number(e.target.value) })}
              className={cn(inputCls, (!portAllowed || errors.at(`${rp}.port`)) && invalidCls)}
            >
              {ports.map((port) => <option key={port} value={port}>{port}</option>)}
            </select>
          </FormRow>
          <FormRow label={t('deviceChecks.editor.variants.method', 'Method')} error={errors.at(`${rp}.method`)}>
            <select value={req.method} onChange={(e) => setReq({ method: e.target.value as DeviceCheckRequest['method'] })} className={inputCls}>
              <option value="GET">GET</option>
              <option value="HEAD">HEAD</option>
            </select>
          </FormRow>
          <FormRow label={t('deviceChecks.editor.variants.auth', 'Authentication')} error={errors.at(`${rp}.auth`)}>
            <select value={req.auth} onChange={(e) => setReq({ auth: e.target.value as DeviceCheckRequest['auth'] })} className={inputCls}>
              <option value="none">{t('deviceChecks.editor.variants.authNone', 'None')}</option>
              <option value="basic">{t('deviceChecks.editor.variants.authBasic', 'Basic')}</option>
            </select>
          </FormRow>
        </div>

        <FormRow
          label={t('deviceChecks.editor.variants.path', 'Path')}
          hint={t('deviceChecks.editor.variants.pathHint', 'Starts with /. The probe always calls the device IP, never a host name.')}
          error={errors.at(`${rp}.path`)}
        >
          <input
            value={req.path}
            maxLength={DEVICE_CHECK_LIMITS.maxPathLength}
            onChange={(e) => setReq({ path: e.target.value })}
            placeholder="/status.xml"
            spellCheck={false}
            className={cn(inputCls, 'font-mono', errors.at(`${rp}.path`) && invalidCls)}
          />
        </FormRow>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <FormRow label={t('deviceChecks.editor.variants.accept', 'Accept')} error={errors.at(`${rp}.accept`)}>
            <select value={req.accept} onChange={(e) => setReq({ accept: e.target.value as DeviceCheckRequest['accept'] })} className={inputCls}>
              {ACCEPTS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </FormRow>
          <FormRow label={t('deviceChecks.editor.variants.charset', 'Charset')} error={errors.at(`${rp}.charset`)}>
            <select value={req.charset} onChange={(e) => setReq({ charset: e.target.value as DeviceCheckRequest['charset'] })} className={inputCls}>
              {CHARSETS.map((c) => (
                <option key={c} value={c}>{c === 'auto' ? t('deviceChecks.editor.variants.charsetAuto', 'Automatic') : c}</option>
              ))}
            </select>
          </FormRow>
          <FormRow label={t('deviceChecks.editor.variants.redirects', 'Follow redirects')} error={errors.at(`${rp}.followRedirects`)}>
            <select
              value={req.followRedirects}
              onChange={(e) => setReq({ followRedirects: Number(e.target.value) as DeviceCheckRequest['followRedirects'] })}
              className={inputCls}
            >
              {[0, 1, 2, 3].map((n) => (
                <option key={n} value={n}>{n === 0 ? t('deviceChecks.editor.variants.noRedirect', 'No') : n}</option>
              ))}
            </select>
          </FormRow>
          <FormRow label={t('deviceChecks.editor.variants.maxBody', 'Max body (KiB)')} error={errors.at(`${rp}.maxBodyBytes`)}>
            <NumberInput
              value={Math.round(req.maxBodyBytes / 1024)}
              min={DEVICE_CHECK_LIMITS.minBodyBytes / 1024}
              max={DEVICE_CHECK_LIMITS.maxBodyBytes / 1024}
              onChange={(kib) => setReq({ maxBodyBytes: Math.round(kib * 1024) })}
              error={errors.at(`${rp}.maxBodyBytes`)}
            />
          </FormRow>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormRow
            label={t('deviceChecks.editor.variants.expectStatus', 'Expected HTTP statuses')}
            hint={t('deviceChecks.editor.variants.expectStatusHint', 'The variant succeeds only with one of these statuses (up to 5)')}
            error={errors.within(`${rp}.expectStatus`)}
          >
            <TagListInput
              values={req.expectStatus.map(String)}
              onChange={(v) => setReq({ expectStatus: v.map(Number) })}
              normalize={(raw) => (/^[1-5]\d\d$/.test(raw) ? String(Number(raw)) : null)}
              max={MAX_EXPECT_STATUS}
              mono
              placeholder="200"
              error={errors.within(`${rp}.expectStatus`)}
            />
          </FormRow>
          {req.scheme === 'https' && (
            <div className="space-y-1 sm:pt-5">
              <CheckRow
                id={`dc-variant-${index}-tls`}
                checked={req.tlsSkipVerify}
                onChange={(v) => setReq({ tlsSkipVerify: v })}
                label={t('deviceChecks.editor.variants.tlsSkipVerify', 'Accept any TLS certificate')}
              />
              {req.tlsSkipVerify && (
                <p className="flex items-start gap-1.5 text-[11px] text-amber-400">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                  {t('deviceChecks.editor.variants.tlsWarning', 'The certificate is not verified: anyone on the LAN who takes this IP can answer. The probe still checks the MAC address first.')}
                </p>
              )}
            </div>
          )}
        </div>

        {req.auth === 'basic' && (
          <p className="flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-400">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            {req.scheme === 'http'
              ? t('deviceChecks.editor.variants.basicOverHttp', 'Basic auth over HTTP is sent in clear on the shop LAN. Store the credentials in the Credentials section.')
              : t('deviceChecks.editor.variants.basicHint', 'Store the credentials in the Credentials section.')}
          </p>
        )}

        {/* Extract */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
              {t('deviceChecks.editor.variants.extract', 'Extract')}
            </p>
            <span className="text-[11px] text-text-muted">
              {variant.extract.length}/{DEVICE_CHECK_LIMITS.maxExtractorsPerVariant}
            </span>
          </div>
          {errors.at(`${p}.extract`) && <p className="text-xs text-status-down">{errors.at(`${p}.extract`)}</p>}
          {variant.extract.length === 0 && (
            <p className="text-xs text-text-muted">{t('deviceChecks.editor.variants.noExtractor', 'No extractor yet: add one per field this variant reads.')}</p>
          )}
          {variant.extract.map((x, i) => (
            <ExtractorRow
              key={i}
              extractor={x}
              fields={fields}
              errors={errors}
              path={`${p}.extract.${i}`}
              active={activeExtractor === i}
              onActivate={() => onActivateExtractor(i)}
              onChange={(nx) => onChange({ ...variant, extract: variant.extract.map((e, j) => (j === i ? nx : e)) })}
              onRemove={() => removeExtractor(i)}
            />
          ))}
          {variant.extract.length < DEVICE_CHECK_LIMITS.maxExtractorsPerVariant && (
            <button
              type="button"
              onClick={() => {
                onChange({ ...variant, extract: [...variant.extract, newExtractor(variant, fields)] });
                onActivateExtractor(variant.extract.length);
              }}
              disabled={fields.length === 0}
              className="inline-flex items-center gap-1 text-xs text-accent hover:underline disabled:cursor-not-allowed disabled:text-text-muted disabled:no-underline"
              title={fields.length === 0 ? t('deviceChecks.editor.variants.needField', 'Declare a field first') : undefined}
            >
              <Plus size={12} />{t('deviceChecks.editor.variants.addExtractor', 'Add an extractor')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
