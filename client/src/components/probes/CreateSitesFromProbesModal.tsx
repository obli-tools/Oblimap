import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { Building2, MapPin, Star } from 'lucide-react';
import type { Probe, Site } from '@oblimap/shared';
import { probeApi } from '@/api/probe.api';
import { siteApi } from '@/api/site.api';
import { useGroupStore } from '@/store/groupStore';
import { useFullAccess } from '@/store/authStore';
import { useAnonymize } from '@/utils/anonymize';
import { toastApiError } from '@/utils/apiError';
import { Modal } from '@/components/common/Modal';
import { Button } from '@/components/common/Button';
import { GroupPicker } from '@/components/common/GroupPicker';

type CutMode = 'none' | 'text' | 'length';

interface Props {
  open: boolean;
  /** Selected probes; only the unassigned pending / approved ones are used. */
  probes: Probe[];
  onClose: () => void;
  onDone: () => void;
}

const SEPARATORS_RE = /^[\s\-_.]+|[\s\-_.]+$/g;

function sourceName(p: Probe): string {
  return (p.name?.trim() || p.hostname || '').trim();
}

function splitList(raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
    // Longest first: "C10" must win over "C1".
    .sort((a, b) => b.length - a.length);
}

/** The site name derived from a probe name, or null with the reason. */
export function deriveSiteName(
  name: string,
  prefix: { mode: CutMode; text: string; length: number },
  suffix: { mode: CutMode; text: string; length: number },
  trimSeparators: boolean,
): { site: string | null; reason?: 'prefix' | 'suffix' | 'empty' } {
  let rest = name;
  if (prefix.mode === 'text') {
    const hit = splitList(prefix.text).find((p) => rest.toLowerCase().startsWith(p.toLowerCase()));
    if (!hit) return { site: null, reason: 'prefix' };
    rest = rest.slice(hit.length);
  } else if (prefix.mode === 'length') {
    if (rest.length <= prefix.length) return { site: null, reason: 'empty' };
    rest = rest.slice(prefix.length);
  }
  if (suffix.mode === 'text') {
    const hit = splitList(suffix.text).find((s) => rest.toLowerCase().endsWith(s.toLowerCase()));
    if (!hit) return { site: null, reason: 'suffix' };
    rest = rest.slice(0, rest.length - hit.length);
  } else if (suffix.mode === 'length') {
    if (rest.length <= suffix.length) return { site: null, reason: 'empty' };
    rest = rest.slice(0, rest.length - suffix.length);
  }
  if (trimSeparators) rest = rest.replace(SEPARATORS_RE, '');
  rest = rest.trim();
  if (!rest) return { site: null, reason: 'empty' };
  return { site: rest.slice(0, 128) };
}

const byName = (a: Probe, b: Probe) => sourceName(a).localeCompare(sourceName(b), undefined, { numeric: true, sensitivity: 'base' });

export function CreateSitesFromProbesModal({ open, probes, onClose, onDone }: Props) {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const tree = useGroupStore((s) => s.tree);
  const fullAccess = useFullAccess();

  const [prefixMode, setPrefixMode] = useState<CutMode>('text');
  const [prefixText, setPrefixText] = useState('');
  const [prefixLength, setPrefixLength] = useState(3);
  const [suffixMode, setSuffixMode] = useState<CutMode>('length');
  const [suffixText, setSuffixText] = useState('');
  const [suffixLength, setSuffixLength] = useState(2);
  const [trimSeparators, setTrimSeparators] = useState(true);
  const [groupId, setGroupId] = useState<number | null>(null);
  const [approvePending, setApprovePending] = useState(true);
  const [primaryOverride, setPrimaryOverride] = useState<Record<string, number>>({});
  const [existingSites, setExistingSites] = useState<Site[]>([]);
  const [saving, setSaving] = useState(false);

  const eligible = useMemo(
    () => probes.filter((p) => p.siteId == null && (p.status === 'pending' || p.status === 'approved')).sort(byName),
    [probes],
  );
  const skippedAssigned = probes.length - eligible.length;

  useEffect(() => {
    if (!open) return;
    setPrimaryOverride({});
    siteApi.list().then(({ sites }) => setExistingSites(sites)).catch(() => setExistingSites([]));
  }, [open]);

  const prefix = { mode: prefixMode, text: prefixText, length: prefixLength };
  const suffix = { mode: suffixMode, text: suffixText, length: suffixLength };

  const rows = eligible.map((p) => ({ probe: p, ...deriveSiteName(sourceName(p), prefix, suffix, trimSeparators) }));
  const unmatched = rows.filter((r) => r.site === null);

  // Sites keyed by lower-case name (two probes "1097" and "1097 " go together).
  const plan = useMemo(() => {
    const map = new Map<string, { name: string; probes: Probe[] }>();
    for (const r of rows) {
      if (!r.site) continue;
      const key = r.site.toLowerCase();
      const entry = map.get(key) ?? { name: r.site, probes: [] };
      entry.probes.push(r.probe);
      map.set(key, entry);
    }
    const existing = new Map(existingSites.map((s) => [s.name.trim().toLowerCase(), s]));
    return [...map.entries()]
      .map(([key, e]) => {
        const sorted = [...e.probes].sort(byName);
        const override = primaryOverride[key];
        const primaryId = override && sorted.some((p) => p.id === override) ? override : sorted[0].id;
        return { key, name: e.name, probes: sorted, primaryId, existing: existing.get(key) ?? null };
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(rows.map((r) => [r.probe.id, r.site])), existingSites, primaryOverride]);

  const pendingCount = plan.reduce((n, s) => n + s.probes.filter((p) => p.status === 'pending').length, 0);
  const canSubmit = plan.length > 0 && !saving && (fullAccess || groupId !== null);

  async function submit() {
    setSaving(true);
    try {
      const res = await probeApi.createSites({
        groupId,
        approvePending,
        sites: plan.map((s) => ({ name: s.name, probeIds: s.probes.map((p) => p.id), primaryProbeId: s.primaryId })),
      });
      const created = res.sites.filter((s) => s.created).length;
      toast.success(t('probesPage.createSites.done', {
        created, reused: res.sites.length - created,
        defaultValue: '{{created}} site(s) created, {{reused}} existing site(s) used',
      }));
      onDone();
      onClose();
    } catch (err) {
      toastApiError(err, t('probesPage.createSites.failed', 'Could not create the sites'));
    } finally {
      setSaving(false);
    }
  }

  const modeSelect = (value: CutMode, onChange: (m: CutMode) => void, id: string) => (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value as CutMode)}
      className="rounded-lg bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/60"
    >
      <option value="none">{t('probesPage.createSites.modeNone', 'None')}</option>
      <option value="text">{t('probesPage.createSites.modeText', 'Text')}</option>
      <option value="length">{t('probesPage.createSites.modeLength', 'Length')}</option>
    </select>
  );
  const fieldClass = 'w-full rounded-lg bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/60';

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="2xl"
      icon={<Building2 className="h-4 w-4 text-accent" />}
      title={t('probesPage.createSites.title', 'Create sites from probe names')}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>{t('common.cancel', 'Cancel')}</Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {t('probesPage.createSites.apply', { count: plan.length, defaultValue: 'Create {{count}} site(s)' })}
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        <p className="text-sm text-text-muted">
          {t('probesPage.createSites.intro', 'The site name is the probe name without its prefix and suffix. Probes giving the same name go to the same site: the first one (by name) is the primary, the others are secondaries.')}
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="cs-prefix-mode" className="block text-xs text-text-muted">{t('probesPage.createSites.prefix', 'Prefix to remove')}</label>
            <div className="flex gap-2">
              {modeSelect(prefixMode, setPrefixMode, 'cs-prefix-mode')}
              {prefixMode === 'text' && (
                <input className={fieldClass} value={prefixText} onChange={(e) => setPrefixText(e.target.value)}
                  placeholder={t('probesPage.createSites.textPlaceholder', 'e.g. TPV (several: TPV, POS)')} />
              )}
              {prefixMode === 'length' && (
                <input className={fieldClass} type="number" min={1} max={64} value={prefixLength}
                  onChange={(e) => setPrefixLength(Math.max(1, Math.min(64, Number(e.target.value) || 1)))} />
              )}
            </div>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="cs-suffix-mode" className="block text-xs text-text-muted">{t('probesPage.createSites.suffix', 'Suffix to remove')}</label>
            <div className="flex gap-2">
              {modeSelect(suffixMode, setSuffixMode, 'cs-suffix-mode')}
              {suffixMode === 'text' && (
                <input className={fieldClass} value={suffixText} onChange={(e) => setSuffixText(e.target.value)}
                  placeholder={t('probesPage.createSites.suffixPlaceholder', 'e.g. C1, C2')} />
              )}
              {suffixMode === 'length' && (
                <input className={fieldClass} type="number" min={1} max={64} value={suffixLength}
                  onChange={(e) => setSuffixLength(Math.max(1, Math.min(64, Number(e.target.value) || 1)))} />
              )}
            </div>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <span className="block text-xs text-text-muted">{t('probesPage.createSites.group', 'Group of the new sites')}</span>
            <GroupPicker value={groupId} onChange={setGroupId} tree={tree} allowNone={fullAccess}
              placeholder={t('probesPage.createSites.groupPlaceholder', 'No group')} />
          </div>
          <div className="space-y-2 pt-5 text-sm text-text-secondary">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={trimSeparators} onChange={(e) => setTrimSeparators(e.target.checked)} />
              {t('probesPage.createSites.trim', 'Trim separators (- _ . spaces) around the name')}
            </label>
            {pendingCount > 0 && (
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={approvePending} onChange={(e) => setApprovePending(e.target.checked)} />
                {t('probesPage.createSites.approve', { count: pendingCount, defaultValue: 'Approve the {{count}} pending probe(s)' })}
              </label>
            )}
          </div>
        </div>

        {skippedAssigned > 0 && (
          <p className="text-xs text-text-muted">
            {t('probesPage.createSites.skipped', { count: skippedAssigned, defaultValue: '{{count}} selected probe(s) ignored: already in a site, refused or suspended.' })}
          </p>
        )}

        {/* Preview: probe name → site name, grouped by site */}
        <div className="rounded-lg bg-bg-tertiary/40">
          <div className="border-b border-border px-3 py-2 text-xs uppercase tracking-wide text-text-muted">
            {t('probesPage.createSites.preview', { count: plan.length, defaultValue: 'Preview — {{count}} site(s)' })}
          </div>
          {plan.length === 0 ? (
            <p className="px-3 py-4 text-sm text-text-muted">{t('probesPage.createSites.nothing', 'No site name can be derived with these settings.')}</p>
          ) : (
            <ul className="max-h-80 divide-y divide-border overflow-y-auto">
              {plan.map((s) => (
                <li key={s.key} className="px-3 py-2">
                  <div className="flex items-center gap-2 text-sm">
                    <MapPin size={14} className="shrink-0 text-accent" />
                    <span className="font-medium text-text-primary">{anonymize(s.name, 'hostname')}</span>
                    {s.existing ? (
                      <span className="rounded bg-yellow-500/10 px-1.5 py-0.5 text-[10px] text-yellow-500">
                        {t('probesPage.createSites.existing', 'existing site')}
                      </span>
                    ) : (
                      <span className="rounded bg-status-up-bg px-1.5 py-0.5 text-[10px] text-status-up">
                        {t('probesPage.createSites.new', 'new site')}
                      </span>
                    )}
                  </div>
                  <ul className="mt-1 space-y-0.5 pl-6">
                    {s.probes.map((p) => {
                      const primary = p.id === s.primaryId;
                      return (
                        <li key={p.id} className="flex items-center gap-2 text-xs text-text-secondary">
                          <button
                            type="button"
                            disabled={s.probes.length < 2 || !!s.existing}
                            onClick={() => setPrimaryOverride((o) => ({ ...o, [s.key]: p.id }))}
                            title={t('probesPage.createSites.makePrimary', 'Make primary')}
                            className="disabled:cursor-default"
                          >
                            <Star size={12} className={primary && !s.existing ? 'fill-accent text-accent' : 'text-text-muted'} />
                          </button>
                          <span className="font-mono">{anonymize(sourceName(p), 'hostname')}</span>
                          <span className="text-text-muted">
                            {s.existing
                              ? t('probesPage.createSites.joins', 'joins as secondary unless the site has no primary')
                              : primary ? t('probesPage.createSites.primary', 'primary') : t('probesPage.createSites.secondary', 'secondary')}
                          </span>
                          {p.status === 'pending' && (
                            <span className="text-[10px] text-text-muted">· {t('probesPage.createSites.pending', 'pending')}</span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>

        {unmatched.length > 0 && (
          <div className="text-xs text-text-muted">
            <p className="mb-1">{t('probesPage.createSites.unmatched', { count: unmatched.length, defaultValue: '{{count}} probe(s) left out (no site name):' })}</p>
            <p className="font-mono">
              {unmatched.map((r) => `${anonymize(sourceName(r.probe), 'hostname')} (${r.reason === 'prefix'
                ? t('probesPage.createSites.noPrefix', 'prefix not found')
                : r.reason === 'suffix' ? t('probesPage.createSites.noSuffix', 'suffix not found') : t('probesPage.createSites.empty', 'nothing left')})`).join(', ')}
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}
