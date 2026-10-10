/**
 * MatchSection — which discovered devices the rule targets:
 * vendor text, MAC prefixes, device types, explicit devices,
 * exclusions and "Require MAC". "Preview matches" asks the server which
 * devices of the scope match, per site, and how many lack a capable probe.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Eye, Loader2, Plus, Minus, Search, X, AlertTriangle } from 'lucide-react';
import { DEVICE_CHECK_LIMITS, type DeviceCheckMatch, type DeviceType, type Site, type SiteItem } from '@oblimap/shared';
import { deviceChecksApi, describeDeviceCheckError, type DeviceCheckPreview } from '@/api/deviceChecks.api';
import { siteApi } from '@/api/site.api';
import { useAnonymize } from '@/utils/anonymize';
import { cn } from '@/utils/cn';
import {
  CheckRow, DEVICE_TYPE_FALLBACKS, DEVICE_TYPE_OPTIONS, FormRow, TagListInput, inputCls, type IssueIndex,
} from './GeneralSection';

const MAX_ENTRIES = DEVICE_CHECK_LIMITS.maxMatchEntries;
const MAC_PREFIX_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){2}$/;

/** "aa-bb-cc", "aabbcc", "AA:BB:CC" → "AA:BB:CC"; null when it is not an OUI prefix. */
export function normalizeMacPrefix(raw: string): string | null {
  const hex = raw.trim().toUpperCase().replace(/[-.\s]/g, ':');
  const v = /^[0-9A-F]{6}$/.test(hex) ? `${hex.slice(0, 2)}:${hex.slice(2, 4)}:${hex.slice(4, 6)}` : hex;
  return MAC_PREFIX_RE.test(v) ? v : null;
}

/** Drops empty lists so the rule never carries a list that matches nothing. */
export function cleanMatch(m: DeviceCheckMatch): DeviceCheckMatch {
  const out: DeviceCheckMatch = { requireMac: m.requireMac };
  if (m.vendorContains?.length) out.vendorContains = m.vendorContains;
  if (m.macPrefixes?.length) out.macPrefixes = m.macPrefixes;
  if (m.deviceTypes?.length) out.deviceTypes = m.deviceTypes;
  if (m.itemIds?.length) out.itemIds = m.itemIds;
  if (m.excludeItemIds?.length) out.excludeItemIds = m.excludeItemIds;
  if (m.excludeDeviceTypes?.length) out.excludeDeviceTypes = m.excludeDeviceTypes;
  return out;
}

/**
 * The match without its explicit devices: site_items ids only mean something
 * in the workspace they come from, so exports and imports leave them out.
 * `dropped` counts the ids removed (included and excluded).
 */
export function withoutExplicitDevices(m: DeviceCheckMatch): { match: DeviceCheckMatch; dropped: number } {
  const dropped = (m.itemIds?.length ?? 0) + (m.excludeItemIds?.length ?? 0);
  const match: DeviceCheckMatch = { ...m };
  delete match.itemIds;
  delete match.excludeItemIds;
  return { match, dropped };
}

function itemLabel(item: SiteItem): string {
  return item.customName || item.hostname || item.ip;
}

// ─── Device type chips ────────────────────────────────────────────────────────

function DeviceTypeChips({
  value, onChange, tone,
}: {
  value: DeviceType[];
  onChange: (v: DeviceType[]) => void;
  tone: 'include' | 'exclude';
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-1">
      {DEVICE_TYPE_OPTIONS.map((type) => {
        const on = value.includes(type);
        return (
          <button
            key={type}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((v) => v !== type) : [...value, type])}
            className={cn(
              'rounded-full border px-2 py-0.5 text-xs transition-colors',
              on
                ? tone === 'include'
                  ? 'border-accent bg-accent/15 text-accent'
                  : 'border-red-500/50 bg-red-500/10 text-red-400'
                : 'border-border text-text-secondary hover:border-accent/40 hover:text-text-primary',
            )}
          >
            {t(`deviceTypes.${type}`, DEVICE_TYPE_FALLBACKS[type])}
          </button>
        );
      })}
    </div>
  );
}

// ─── Explicit device picker ───────────────────────────────────────────────────

function ItemChips({
  ids, labels, onRemove, tone,
}: {
  ids: number[];
  labels: Map<number, SiteItem>;
  onRemove: (id: number) => void;
  tone: 'include' | 'exclude';
}) {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  if (ids.length === 0) {
    return <p className="text-xs text-text-muted">{t('deviceChecks.editor.match.noDevices', 'None')}</p>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {ids.map((id) => {
        const item = labels.get(id);
        const text = item ? `${anonymize(itemLabel(item), 'hostname')} · ${anonymize(item.ip, 'ip')}` : `#${id}`;
        return (
          <span
            key={id}
            className={cn(
              'inline-flex max-w-full items-center gap-1 rounded border px-1.5 py-0.5 text-xs',
              tone === 'include' ? 'border-accent/40 bg-accent/10 text-text-primary' : 'border-red-500/40 bg-red-500/10 text-text-primary',
            )}
          >
            <span className="truncate">{text}</span>
            <button
              type="button"
              onClick={() => onRemove(id)}
              className="text-text-muted hover:text-text-primary"
              aria-label={t('deviceChecks.editor.match.removeDevice', 'Remove device')}
            >
              <X size={11} />
            </button>
          </span>
        );
      })}
    </div>
  );
}

function ItemPicker({
  sites, defaultSiteId, match, onChange, onItemsLoaded,
}: {
  sites: Site[];
  defaultSiteId: number | null;
  match: DeviceCheckMatch;
  onChange: (m: DeviceCheckMatch) => void;
  onItemsLoaded: (items: SiteItem[]) => void;
}) {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const [siteId, setSiteId] = useState<number | null>(defaultSiteId);
  const [items, setItems] = useState<SiteItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');

  useEffect(() => {
    if (siteId === null) { setItems([]); return; }
    let cancelled = false;
    setLoading(true);
    siteApi.listItems(siteId)
      .then(({ items: list }) => {
        if (cancelled) return;
        setItems(list);
        onItemsLoaded(list);
      })
      .catch(() => { if (!cancelled) toast.error(t('deviceChecks.editor.match.loadDevicesFailed', 'Failed to load the devices of this site')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [siteId, onItemsLoaded, t]);

  const include = match.itemIds ?? [];
  const exclude = match.excludeItemIds ?? [];
  const query = q.trim().toLowerCase();
  const shown = items
    .filter((i) => !query
      || i.ip.includes(query)
      || (i.hostname ?? '').toLowerCase().includes(query)
      || (i.customName ?? '').toLowerCase().includes(query)
      || (i.vendor ?? '').toLowerCase().includes(query)
      || (i.mac ?? '').toLowerCase().includes(query))
    .slice(0, 100);

  const toggle = (list: 'itemIds' | 'excludeItemIds', id: number) => {
    const current = list === 'itemIds' ? include : exclude;
    const other = list === 'itemIds' ? exclude : include;
    if (current.includes(id)) {
      onChange({ ...match, [list]: current.filter((v) => v !== id) });
      return;
    }
    if (current.length >= MAX_ENTRIES) {
      toast.error(t('deviceChecks.editor.match.tooMany', { max: MAX_ENTRIES, defaultValue: 'At most {{max}} devices per list' }));
      return;
    }
    const otherKey = list === 'itemIds' ? 'excludeItemIds' : 'itemIds';
    onChange({ ...match, [list]: [...current, id], [otherKey]: other.filter((v) => v !== id) });
  };

  return (
    <div className="space-y-2 rounded-md bg-bg-primary/40 p-2">
      <div className="flex flex-col gap-2 sm:flex-row">
        <select
          value={siteId ?? ''}
          onChange={(e) => setSiteId(e.target.value ? Number(e.target.value) : null)}
          className={cn(inputCls, 'sm:w-56')}
        >
          <option value="">{t('deviceChecks.editor.match.pickSite', 'Pick a site…')}</option>
          {sites.map((s) => <option key={s.id} value={s.id}>{anonymize(s.name, 'hostname')}</option>)}
        </select>
        <div className="relative flex-1">
          <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('deviceChecks.editor.match.searchDevices', 'Search IP, name, vendor, MAC…')}
            className={cn(inputCls, 'pl-7')}
            disabled={siteId === null}
          />
        </div>
      </div>
      {loading ? (
        <div className="flex items-center gap-2 py-3 text-xs text-text-muted"><Loader2 size={13} className="animate-spin" />{t('common.loading', 'Loading…')}</div>
      ) : siteId !== null && (
        <div className="max-h-56 overflow-y-auto">
          {shown.length === 0 ? (
            <p className="py-2 text-xs text-text-muted">{t('common.noResults', 'No results')}</p>
          ) : (
            <ul className="divide-y divide-border">
              {shown.map((item) => {
                const inc = include.includes(item.id);
                const exc = exclude.includes(item.id);
                return (
                  <li key={item.id} className="flex items-center gap-2 py-1 text-xs">
                    <span className="w-28 shrink-0 font-mono text-text-secondary">{anonymize(item.ip, 'ip')}</span>
                    <span className="min-w-0 flex-1 truncate text-text-primary">
                      {anonymize(itemLabel(item), 'hostname')}
                      {item.vendor && <span className="ml-1.5 text-text-muted">{item.vendor}</span>}
                    </span>
                    <button
                      type="button"
                      onClick={() => toggle('itemIds', item.id)}
                      className={cn('inline-flex items-center gap-0.5 rounded px-1.5 py-0.5', inc ? 'bg-accent/15 text-accent ring-1 ring-accent/40' : 'bg-bg-tertiary text-text-muted hover:bg-bg-hover hover:text-text-primary')}
                      aria-pressed={inc}
                    >
                      <Plus size={10} />{t('deviceChecks.editor.match.include', 'Include')}
                    </button>
                    <button
                      type="button"
                      onClick={() => toggle('excludeItemIds', item.id)}
                      className={cn('inline-flex items-center gap-0.5 rounded px-1.5 py-0.5', exc ? 'bg-red-500/10 text-red-400 ring-1 ring-red-500/40' : 'bg-bg-tertiary text-text-muted hover:bg-bg-hover hover:text-text-primary')}
                      aria-pressed={exc}
                    >
                      <Minus size={10} />{t('deviceChecks.editor.match.exclude', 'Exclude')}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Section ──────────────────────────────────────────────────────────────────

interface MatchSectionProps {
  match: DeviceCheckMatch;
  onChange: (m: DeviceCheckMatch) => void;
  /** A variant uses Basic auth: "Require MAC" is forced on. */
  requireMacForced: boolean;
  errors: IssueIndex;
  sites: Site[];
  scope: { groupId: number | null; siteId: number | null };
}

export function MatchSection({ match, onChange, requireMacForced, errors, sites, scope }: MatchSectionProps) {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [labels, setLabels] = useState<Map<number, SiteItem>>(new Map());
  const [preview, setPreview] = useState<DeviceCheckPreview | null>(null);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const siteNames = useMemo(() => new Map(sites.map((s) => [s.id, s.name])), [sites]);

  const rememberItems = useCallback((items: SiteItem[]) => {
    setLabels((prev) => {
      const next = new Map(prev);
      for (const i of items) next.set(i.id, i);
      return next;
    });
  }, []);

  const requestKey = JSON.stringify({ m: cleanMatch(match), g: scope.groupId, s: scope.siteId });
  const outdated = preview !== null && previewKey !== requestKey;

  const runPreview = async () => {
    setPreviewing(true);
    setPreviewError(null);
    try {
      const res = await deviceChecksApi.previewMatches({
        match: { ...cleanMatch(match), requireMac: match.requireMac || requireMacForced },
        groupId: scope.groupId,
        siteId: scope.siteId,
      });
      setPreview(res);
      setPreviewKey(requestKey);
      rememberItems(res.sample);
    } catch (err) {
      setPreviewError(describeDeviceCheckError(err, t, t('deviceChecks.editor.match.previewFailed', 'Preview failed')));
    } finally {
      setPreviewing(false);
    }
  };

  const sitesNeedingProbe = preview?.sitesWithoutCapableProbe ?? 0;

  return (
    <div className="space-y-4">
      {errors.at('match') && (
        <p className="rounded-md border border-status-down/40 bg-status-down/10 px-3 py-2 text-xs text-status-down">{errors.at('match')}</p>
      )}
      <p className="text-xs text-text-muted">
        {t('deviceChecks.editor.match.intro', 'A device is targeted when it matches ANY of the criteria below and none of the exclusions. At least one criterion is required.')}
      </p>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <FormRow
          label={t('deviceChecks.editor.match.vendorContains', 'Vendor contains')}
          hint={t('deviceChecks.editor.match.vendorHint', 'Case-insensitive text of the MAC vendor (e.g. barix)')}
          error={errors.within('match.vendorContains')}
        >
          <TagListInput
            values={match.vendorContains ?? []}
            onChange={(v) => onChange({ ...match, vendorContains: v })}
            normalize={(raw) => (raw.length >= 2 && raw.length <= 64 ? raw : null)}
            max={MAX_ENTRIES}
            placeholder={t('deviceChecks.editor.match.vendorPlaceholder', 'Type and press Enter')}
            error={errors.within('match.vendorContains')}
          />
        </FormRow>
        <FormRow
          label={t('deviceChecks.editor.match.macPrefixes', 'MAC prefixes (OUI)')}
          hint={t('deviceChecks.editor.match.macHint', 'First three bytes, e.g. 00:08:E1')}
          error={errors.within('match.macPrefixes')}
        >
          <TagListInput
            values={match.macPrefixes ?? []}
            onChange={(v) => onChange({ ...match, macPrefixes: v })}
            normalize={normalizeMacPrefix}
            max={MAX_ENTRIES}
            mono
            placeholder="AA:BB:CC"
            error={errors.within('match.macPrefixes')}
          />
        </FormRow>
      </div>

      <FormRow label={t('deviceChecks.editor.match.deviceTypes', 'Device types')} error={errors.within('match.deviceTypes')}>
        <DeviceTypeChips value={match.deviceTypes ?? []} onChange={(v) => onChange({ ...match, deviceTypes: v })} tone="include" />
      </FormRow>

      <FormRow label={t('deviceChecks.editor.match.excludeDeviceTypes', 'Never these device types')} error={errors.within('match.excludeDeviceTypes')}>
        <DeviceTypeChips value={match.excludeDeviceTypes ?? []} onChange={(v) => onChange({ ...match, excludeDeviceTypes: v })} tone="exclude" />
      </FormRow>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <FormRow label={t('deviceChecks.editor.match.itemIds', 'Explicit devices')} error={errors.within('match.itemIds')}>
          <ItemChips
            ids={match.itemIds ?? []}
            labels={labels}
            tone="include"
            onRemove={(id) => onChange({ ...match, itemIds: (match.itemIds ?? []).filter((v) => v !== id) })}
          />
        </FormRow>
        <FormRow label={t('deviceChecks.editor.match.excludeItemIds', 'Excluded devices')} error={errors.within('match.excludeItemIds')}>
          <ItemChips
            ids={match.excludeItemIds ?? []}
            labels={labels}
            tone="exclude"
            onRemove={(id) => onChange({ ...match, excludeItemIds: (match.excludeItemIds ?? []).filter((v) => v !== id) })}
          />
        </FormRow>
      </div>

      <div>
        <button
          type="button"
          onClick={() => setPickerOpen((v) => !v)}
          className="text-xs text-accent hover:underline"
        >
          {pickerOpen
            ? t('deviceChecks.editor.match.hidePicker', 'Hide the device picker')
            : t('deviceChecks.editor.match.showPicker', 'Pick devices to include or exclude…')}
        </button>
        {pickerOpen && (
          <div className="mt-2">
            <ItemPicker
              sites={sites}
              defaultSiteId={scope.siteId}
              match={match}
              onChange={onChange}
              onItemsLoaded={rememberItems}
            />
          </div>
        )}
      </div>

      <CheckRow
        id="dc-require-mac"
        checked={match.requireMac || requireMacForced}
        disabled={requireMacForced}
        onChange={(v) => onChange({ ...match, requireMac: v })}
        label={t('deviceChecks.editor.match.requireMac', 'Require a known MAC address (recommended)')}
        hint={requireMacForced
          ? t('deviceChecks.editor.match.requireMacForced', 'Forced on: a variant sends Basic auth credentials, so the probe must verify the MAC before sending anything.')
          : t('deviceChecks.editor.match.requireMacHint', 'Devices without a MAC are never targeted, and the probe checks the MAC before sending a request.')}
      />

      {/* Preview */}
      <div className="rounded-md bg-bg-tertiary/50 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void runPreview()}
            disabled={previewing}
            className="inline-flex items-center gap-1.5 rounded-md bg-bg-secondary px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-bg-hover disabled:opacity-50"
          >
            {previewing ? <Loader2 size={13} className="animate-spin" /> : <Eye size={13} />}
            {t('deviceChecks.editor.match.preview', 'Preview matches')}
          </button>
          {preview && (
            <span className={cn('text-xs', outdated ? 'text-text-muted line-through' : 'text-text-secondary')}>
              {t('deviceChecks.editor.match.previewTotal', {
                count: preview.total,
                sites: preview.bySite.length,
                defaultValue: '{{count}} devices on {{sites}} sites',
              })}
            </span>
          )}
          {outdated && (
            <span className="text-xs text-amber-400">{t('deviceChecks.editor.match.previewOutdated', 'The match changed: preview again')}</span>
          )}
        </div>
        {previewError && <p className="mt-2 text-xs text-status-down">{previewError}</p>}
        {preview && !outdated && (
          <div className="mt-3 space-y-3">
            {sitesNeedingProbe > 0 && (
              <p className="flex items-start gap-1.5 text-xs text-amber-400">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                {t('deviceChecks.editor.match.sitesNeedProbe', {
                  count: sitesNeedingProbe,
                  defaultValue: '{{count}} sites have no probe that supports device checks yet: update the probe there.',
                })}
              </p>
            )}
            {preview.bySite.length > 0 && (
              <div className="max-h-40 overflow-y-auto rounded border border-border">
                <table className="w-full text-xs">
                  <thead className="bg-bg-secondary text-text-muted">
                    <tr>
                      <th className="px-2 py-1 text-left font-medium">{t('deviceChecks.editor.match.colSite', 'Site')}</th>
                      <th className="px-2 py-1 text-right font-medium">{t('deviceChecks.editor.match.colDevices', 'Devices')}</th>
                      <th className="px-2 py-1 text-right font-medium">{t('deviceChecks.editor.match.colProbe', 'Probe')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.bySite.map((s) => (
                      <tr key={s.siteId} className="border-t border-border">
                        <td className="px-2 py-1 text-text-primary">{anonymize(siteNames.get(s.siteId) ?? s.siteName ?? `#${s.siteId}`, 'hostname')}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{s.count}</td>
                        <td className={cn('px-2 py-1 text-right', s.withoutCapableProbe ? 'text-amber-400' : 'text-text-muted')}>
                          {s.withoutCapableProbe
                            ? t('deviceChecks.editor.match.needsProbeUpdate', 'Update the probe')
                            : t('deviceChecks.editor.match.probeReady', 'Ready')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {preview.sample.length > 0 && (
              <div>
                <p className="mb-1 text-[11px] uppercase tracking-wide text-text-muted">
                  {t('deviceChecks.editor.match.sample', 'Sample')}
                </p>
                <ul className="max-h-48 space-y-0.5 overflow-y-auto text-xs">
                  {preview.sample.map((item) => (
                    <li key={item.id} className="flex items-center gap-2">
                      <span className="w-28 shrink-0 font-mono text-text-secondary">{anonymize(item.ip, 'ip')}</span>
                      <span className="min-w-0 flex-1 truncate text-text-primary">{anonymize(itemLabel(item), 'hostname')}</span>
                      <span className="hidden truncate text-text-muted sm:inline">{item.vendor ?? ''}</span>
                      <span className="hidden text-text-muted md:inline">{anonymize(siteNames.get(item.siteId) ?? '', 'hostname')}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
