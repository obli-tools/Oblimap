/**
 * AdminMacVendorsPage — view and manage the IEEE OUI vendor database.
 *
 * - Browse the IEEE MA-L / MA-M / MA-S prefixes with search
 * - Registry status (last download, rows per registry) and a refresh button
 * - Set a custom display-name override per prefix
 * - Clear overrides to revert to the IEEE default name
 * - "Overrides only" filter to see what has been customized
 */

import { useState, useEffect, useCallback, useRef, type FormEvent } from 'react';
import { Search, Edit2, Database, Tag, RefreshCw, Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { Trans, useTranslation } from 'react-i18next';
import type { MacVendor } from '@oblimap/shared';
import { macVendorsApi, type MacVendorStatsResponse } from '@/api/macVendors.api';
import { useAuthStore } from '@/store/authStore';
import { Button } from '@/components/common/Button';
import { PageContainer, useEmbedded } from '@/components/common/PageContainer';
import { Modal } from '@/components/common/Modal';
import { IconButton } from '@/components/common/IconButton';
import { TableScroll } from '@/components/common/TableScroll';
import { Checkbox } from '@/components/ui/Checkbox';
import { toastApiError } from '@/utils/apiError';
import { cn } from '@/utils/cn';

// ── Override editor ───────────────────────────────────────────────────────────

const OVERRIDE_FORM_ID = 'mac-vendor-override-form';

function OverrideModal({
  vendor,
  onClose,
  onSaved,
}: {
  /** The prefix being edited; null = closed. */
  vendor: MacVendor | null;
  onClose: () => void;
  onSaved: (updated: MacVendor) => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (vendor) setValue(vendor.customName ?? '');
  }, [vendor]);

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!vendor) return;
    setSaving(true);
    try {
      const trimmed = value.trim() || null;
      const { vendor: updated } = await macVendorsApi.updateCustomName(vendor.prefix, trimmed);
      onSaved(updated);
      toast.success(trimmed
        ? t('macVendors.overrideSaved', 'Override saved')
        : t('macVendors.overrideCleared', 'Override cleared'));
    } catch (err) {
      toastApiError(err, t('macVendors.saveFailed', 'Failed to save'));
    } finally {
      setSaving(false);
    }
  };

  const clearOverride = async () => {
    if (!vendor) return;
    setSaving(true);
    try {
      await macVendorsApi.clearOverride(vendor.prefix);
      onSaved({ ...vendor, customName: null, effectiveName: vendor.vendorName });
      toast.success(t('macVendors.overrideCleared', 'Override cleared'));
    } catch (err) {
      toastApiError(err, t('macVendors.clearFailed', 'Failed to clear override'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={vendor !== null}
      onClose={() => { if (!saving) onClose(); }}
      dismissible={!saving}
      size="sm"
      icon={<Tag className="h-4 w-4 text-accent" />}
      title={t('macVendors.editOverride', 'Edit override')}
      footer={
        <>
          {vendor?.customName && (
            <Button type="button" variant="danger" size="sm" className="mr-auto" onClick={() => void clearOverride()} disabled={saving}>
              {t('macVendors.clearOverride', 'Clear override')}
            </Button>
          )}
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" size="sm" form={OVERRIDE_FORM_ID} loading={saving}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      {vendor && (
        <form id={OVERRIDE_FORM_ID} onSubmit={(e) => void save(e)} className="space-y-4">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
            <dt className="text-text-muted">{t('macVendors.colPrefixOui', 'Prefix (OUI)')}</dt>
            <dd><code className="rounded bg-bg-tertiary px-1.5 py-0.5 text-xs font-mono text-text-primary">{vendor.prefix}</code></dd>
            <dt className="text-text-muted">{t('macVendors.colIeeeVendorName', 'IEEE Vendor Name')}</dt>
            <dd className="break-words text-text-secondary">{vendor.vendorName}</dd>
          </dl>
          <div className="space-y-1">
            <label htmlFor="mac-vendor-custom-name" className="block text-xs font-medium text-text-secondary">
              {t('macVendors.colCustomOverride', 'Custom Override')}
            </label>
            <input
              id="mac-vendor-custom-name"
              className="w-full rounded-md border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={t('macVendors.inputPlaceholder', 'Custom vendor name…')}
              maxLength={255}
              autoFocus
            />
            <p className="text-xs text-text-muted">
              {t('macVendors.overrideHint', 'Leave empty to use the IEEE name again.')}
            </p>
          </div>
        </form>
      )}
    </Modal>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function AdminMacVendorsPage() {
  const { t } = useTranslation();
  const embedded = useEmbedded();
  const [vendors, setVendors]           = useState<MacVendor[]>([]);
  const [total, setTotal]               = useState(0);
  const [pages, setPages]               = useState(1);
  const [page, setPage]                 = useState(1);
  const [loading, setLoading]           = useState(true);
  const [search, setSearch]             = useState('');
  const [overrideOnly, setOverrideOnly] = useState(false);
  const [stats, setStats]               = useState<MacVendorStatsResponse | null>(null);
  // The registry download is a platform function (server: platform admins only).
  const isPlatformAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const [statsError, setStatsError]     = useState(false);
  const [seeding, setSeeding]           = useState(false);
  const [editing, setEditing]           = useState<MacVendor | null>(null);

  // Debounce search
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedSearch, setDebouncedSearch] = useState('');

  useEffect(() => {
    if (searchDebounce.current) clearTimeout(searchDebounce.current);
    searchDebounce.current = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 300);
    return () => { if (searchDebounce.current) clearTimeout(searchDebounce.current); };
  }, [search]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await macVendorsApi.list({
        q: debouncedSearch || undefined,
        page,
        limit: 50,
        overrideOnly: overrideOnly || undefined,
      });
      setVendors(res.vendors);
      setTotal(res.total);
      setPages(res.pages);
    } catch (err) {
      toastApiError(err, t('macVendors.failedLoad', 'Failed to load vendor database'));
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, page, overrideOnly, t]);

  useEffect(() => { void load(); }, [load]);

  const loadStats = useCallback(() => {
    macVendorsApi.stats()
      .then((s) => { setStats(s); setStatsError(false); })
      .catch(() => { setStatsError(true); });
  }, []);

  useEffect(() => { loadStats(); }, [loadStats]);

  const handleVendorUpdated = (updated: MacVendor) => {
    setVendors((prev) => prev.map((v) => v.prefix === updated.prefix ? updated : v));
    setEditing(null);
    // Refresh stats if override status changed
    loadStats();
  };

  const handleSeed = async () => {
    setSeeding(true);
    const toastId = toast.loading(t('macVendors.seedingRegistries', 'Downloading the IEEE registries (MA-L, MA-M, MA-S)…'));
    try {
      const res = await macVendorsApi.seed();
      const failed = (res.registries ?? []).filter((r) => r.error).map((r) => r.key);
      if (failed.length > 0) {
        toast.success(t('macVendors.seededPartial', {
          n: res.inserted.toLocaleString(),
          failed: failed.join(', '),
          defaultValue: 'Seeded {{n}} entries from IEEE ({{failed}} could not be downloaded, retried automatically)',
        }), { id: toastId });
      } else {
        toast.success(t('macVendors.seeded', 'Seeded {{n}} entries from IEEE', { n: res.inserted.toLocaleString() }), { id: toastId });
      }
      // Refresh stats and list
      loadStats();
      void load();
    } catch {
      toast.error(t('macVendors.seedFailed', 'Failed to seed vendor database'), { id: toastId });
    } finally {
      setSeeding(false);
    }
  };

  const seedButton = isPlatformAdmin ? (
    <Button
      variant="secondary"
      size="sm"
      onClick={() => { void handleSeed(); }}
      disabled={seeding}
      title={t('macVendors.refreshRegistryHint', 'Download the latest IEEE registries (MA-L, MA-M, MA-S) and upsert all entries. Custom overrides are preserved. The server also refreshes them by itself every 30 days.')}
    >
      <RefreshCw size={14} className={cn('mr-1.5', seeding && 'animate-spin')} />
      {seeding ? t('macVendors.seedingShort', 'Seeding…') : t('macVendors.refreshRegistry', 'Refresh registry')}
    </Button>
  ) : null;

  const lastSeeded = stats?.lastSeededAt ?? stats?.lastUpdated ?? null;
  const registryCounts = stats?.byPrefixBits
    ? ([
      ['MA-L', 24, stats.byPrefixBits[24]],
      ['MA-M', 28, stats.byPrefixBits[28]],
      ['MA-S', 36, stats.byPrefixBits[36]],
    ] as const)
    : null;

  return (
    <PageContainer
      icon={<Database className="h-5 w-5" />}
      title={t('macVendors.pageTitle', 'MAC Vendor Database')}
      subtitle={t('macVendors.pageIntro', 'Browse the IEEE OUI database and override vendor names for specific MAC prefixes. Custom names are used when identifying devices on sites.')}
      actions={seedButton}
    >
      {/* Stats bar */}
      {statsError && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl bg-bg-secondary px-4 py-2 text-sm text-status-down">
          <span>{t('macVendors.statsLoadFailed', 'Could not load statistics')}</span>
          <Button type="button" variant="ghost" size="sm" onClick={loadStats}>
            <RefreshCw size={12} className="mr-1" />
            {t('common.retry', 'Retry')}
          </Button>
        </div>
      )}
      {(stats && !statsError) || embedded ? (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          {stats && !statsError && (
            <>
              <div className="rounded-xl bg-bg-secondary px-4 py-2">
                <div className="text-xs text-text-muted">{t('macVendors.statsTotal', 'Total Prefixes')}</div>
                <div className="text-lg font-semibold text-text-primary">{stats.total.toLocaleString()}</div>
              </div>
              <div className="rounded-xl bg-bg-secondary px-4 py-2">
                <div className="text-xs text-text-muted">{t('macVendors.statsOverrides', 'Custom Overrides')}</div>
                <div className="text-lg font-semibold text-accent">{stats.overrides.toLocaleString()}</div>
              </div>
              {registryCounts && (
                <div className="rounded-xl bg-bg-secondary px-4 py-2">
                  <div className="text-xs text-text-muted">{t('macVendors.statsByRegistry', 'Per registry')}</div>
                  <div className="flex flex-wrap gap-x-3 text-sm font-medium text-text-primary tabular-nums">
                    {registryCounts.map(([key, bits, count]) => (
                      <span key={key} title={t('macVendors.registryBits', '{{bits}}-bit prefixes', { bits })}>
                        <span className="text-text-muted">{key}</span> {count.toLocaleString()}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              <div className="rounded-xl bg-bg-secondary px-4 py-2">
                <div className="text-xs text-text-muted">{t('macVendors.statsLastSeeded', 'Last Seeded')}</div>
                <div className="text-sm font-medium text-text-primary">
                  {lastSeeded
                    ? new Date(lastSeeded).toLocaleDateString()
                    : t('macVendors.neverSeeded', 'Never (downloading in the background)')}
                </div>
              </div>
            </>
          )}
          {/* Inside a hub tab the page header (and its action) is not rendered. */}
          {embedded && <div className="ml-auto">{seedButton}</div>}
        </div>
      ) : null}

      {/* Toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-48">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            type="text"
            placeholder={t('macVendors.searchPlaceholder', 'Search prefix or vendor name…')}
            aria-label={t('macVendors.searchPlaceholder', 'Search prefix or vendor name…')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-md border border-border bg-bg-tertiary py-1.5 pl-8 pr-3 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </div>
        <label htmlFor="mac-vendors-overrides-only" className="flex cursor-pointer items-center gap-2 text-sm text-text-secondary coarse:py-2">
          <Checkbox
            id="mac-vendors-overrides-only"
            checked={overrideOnly}
            onCheckedChange={(v) => { setOverrideOnly(v); setPage(1); }}
          />
          <Tag size={13} className="text-accent" />
          {t('macVendors.overridesOnly', 'Overrides only')}
        </label>
        <span className="text-xs text-text-muted ml-auto">
          {t('macVendors.entryCount', '{{n}} entries', { n: total.toLocaleString() })}
        </span>
      </div>

      {/* Table */}
      <div className="rounded-xl bg-bg-secondary">
        <TableScroll>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wider text-text-muted">
                <th className="px-4 py-2.5 w-28">{t('macVendors.colPrefixOui', 'Prefix (OUI)')}</th>
                <th className="px-4 py-2.5">{t('macVendors.colIeeeVendorName', 'IEEE Vendor Name')}</th>
                <th className="px-4 py-2.5 w-72">{t('macVendors.colCustomOverride', 'Custom Override')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading && (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-text-muted text-xs">
                    <span className="inline-flex items-center gap-2">
                      <Loader2 size={13} className="animate-spin" />
                      {t('common.loading')}
                    </span>
                  </td>
                </tr>
              )}
              {!loading && vendors.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-8 text-center text-text-muted text-xs">
                    {overrideOnly
                      ? t('macVendors.noOverrides', 'No custom overrides set.')
                      : t('macVendors.noEntries', 'No entries found.')}
                  </td>
                </tr>
              )}
              {!loading && vendors.map((v) => (
                <tr
                  key={v.prefix}
                  className={cn(
                    'group hover:bg-bg-hover/40 transition-colors',
                    v.customName && 'bg-accent/5',
                  )}
                >
                  <td className="px-4 py-2">
                    <code className="rounded bg-bg-tertiary px-1.5 py-0.5 text-xs font-mono text-text-primary">
                      {v.prefix}
                    </code>
                  </td>
                  <td className="px-4 py-2 text-text-secondary text-xs">{v.vendorName}</td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-1.5">
                      {v.customName ? (
                        <>
                          <span className="text-xs text-text-primary">{v.customName}</span>
                          <span className="text-[10px] text-text-muted line-through">{v.vendorName}</span>
                        </>
                      ) : (
                        <span className="text-xs text-text-muted italic">—</span>
                      )}
                      <IconButton
                        label={t('macVendors.editOverride', 'Edit override')}
                        icon={<Edit2 size={11} />}
                        size="sm"
                        onClick={() => setEditing(v)}
                        className="ml-1 can-hover:opacity-0 can-hover:group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>

        {/* Pagination */}
        {pages > 1 && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2">
            <span className="text-xs text-text-muted">
              {t('macVendors.pageOf', 'Page {{page}} of {{pages}}', { page, pages })}
            </span>
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                ← {t('macVendors.prev', 'Prev')}
              </Button>
              {/* Show up to 5 page buttons around current */}
              {Array.from({ length: Math.min(5, pages) }, (_, i) => {
                const start = Math.max(1, Math.min(page - 2, pages - 4));
                const n = start + i;
                return (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setPage(n)}
                    aria-current={n === page ? 'page' : undefined}
                    className={cn(
                      'flex h-7 w-7 items-center justify-center rounded text-xs transition-colors coarse:h-10 coarse:w-10',
                      n === page
                        ? 'bg-accent text-white font-semibold'
                        : 'text-text-muted hover:bg-bg-hover hover:text-text-primary',
                    )}
                  >
                    {n}
                  </button>
                );
              })}
              <Button
                size="sm"
                variant="ghost"
                disabled={page >= pages}
                onClick={() => setPage((p) => p + 1)}
              >
                {t('common.next', 'Next')} →
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Info box */}
      <div className="mt-4 rounded-xl bg-bg-secondary p-4 text-xs text-text-muted">
        <strong className="text-text-secondary">{t('common.labelColon', { label: t('macVendors.infoTitle', 'How overrides work'), defaultValue: '{{label}}:' })}</strong>{' '}
        <Trans
          i18nKey="macVendors.infoBodyRegistry"
          defaults="When a probe discovers a device, its MAC address is looked up here by the longest registered prefix (MA-S 36 bits, then MA-M 28 bits, then MA-L 24 bits). If you set a custom override, that name is shown in the site device list and used in vendor-based type classification rules. The server downloads the IEEE registries by itself on a fresh install and every 30 days; <strong>Refresh registry</strong> does it now. Your custom overrides are always preserved."
          components={{ strong: <strong className="text-text-secondary" /> }}
        />
      </div>

      <OverrideModal vendor={editing} onClose={() => setEditing(null)} onSaved={handleVendorUpdated} />
    </PageContainer>
  );
}
