import { useState, useRef, useCallback, useEffect, useMemo, type ReactNode } from 'react';
import { Download, Upload, FileJson, FileSpreadsheet, CheckCircle2, PackageOpen, ExternalLink, Eye } from 'lucide-react';
import type { TFunction } from 'i18next';
import { Button } from '@/components/common/Button';
import { PageContainer } from '@/components/common/PageContainer';
import { SegmentedTabs } from '@/components/common/SegmentedTabs';
import { TableScroll } from '@/components/common/TableScroll';
import { saveBlob } from '@/utils/download';
import { csvRow } from '@/utils/csv';
import { apiErrorBody, toastApiError } from '@/utils/apiError';
import { useAnonymize } from '@/utils/anonymize';
import { deviceTypeLabel } from '@/utils/deviceTypes';
import { cn } from '@/utils/cn';
import {
  importExportApi,
  IMPORT_EXPORT_SECTIONS,
  PLATFORM_ADMIN_SECTIONS,
  PLATFORM_EXPORT_SECTIONS,
  type ConflictStrategy,
  type CsvCommitResult,
  type CsvCommitStrategy,
  type CsvImportKind,
  type CsvPreview,
  type CsvRowStatus,
  type ImportExportSection,
  type ImportSectionResult,
} from '@/api/importExport.api';
import { siteApi, type SiteListItem } from '@/api/site.api';
import { useAuthStore, useTenantCapability } from '@/store/authStore';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';

// ── Types ─────────────────────────────────────────────────────────────────────

type Section = ImportExportSection;

const ALL_SECTIONS: readonly Section[] = IMPORT_EXPORT_SECTIONS;

/** The sections this user may export (MAC vendor overrides: platform admins only). */
function exportSectionsFor(isPlatformAdmin: boolean): Section[] {
  return ALL_SECTIONS.filter((s) => isPlatformAdmin || !PLATFORM_EXPORT_SECTIONS.includes(s));
}

/**
 * The sections this user may import: platform data for platform admins only,
 * vendor rules also need deviceChecks.manage (same gate as the vendor-rule routes).
 */
function importSectionsFor(isPlatformAdmin: boolean, canManageDeviceChecks: boolean): Section[] {
  return ALL_SECTIONS.filter((s) => {
    if (isPlatformAdmin) return true;
    if (PLATFORM_ADMIN_SECTIONS.includes(s)) return false;
    if (s === 'vendorRules') return canManageDeviceChecks;
    return true;
  });
}

function sectionLabels(t: TFunction): Record<Section, string> {
  return {
    siteGroups:           t('importExport.siteGroups', 'Site Groups'),
    sites:                t('importExport.sites', 'Sites'),
    settings:             t('importExport.settingsSection', 'Settings'),
    notificationChannels: t('importExport.notificationChannels', 'Notification Channels'),
    teams:                t('importExport.teams', 'Teams'),
    siteSubnets:          t('importExport.siteSubnets', 'Subnets'),
    reservations:         t('importExport.reservations', 'IP reservations'),
    siteItems:            t('importExport.siteItems', 'Devices'),
    vendorRules:          t('importExport.vendorRules', 'Vendor rules'),
    macVendorOverrides:   t('importExport.macVendorOverrides', 'MAC vendor overrides'),
    permissionSets:       t('importExport.permissionSets', 'Permission sets'),
  };
}

function sectionDescriptions(t: TFunction): Partial<Record<Section, string>> {
  return {
    siteSubnets:        t('importExport.siteSubnetsDesc', 'Named subnets of each site (name, VLAN, gateway).'),
    reservations:       t('importExport.reservationsDesc', 'IP reservations of each site, with the MAC they are reserved for.'),
    siteItems:          t('importExport.siteItemsDesc', 'Manual devices, plus the names, types, notes and alert modes set on discovered devices.'),
    vendorRules:        t('importExport.vendorRulesDesc', 'Vendor → device type rules (importing them also needs the device checks capability).'),
    macVendorOverrides: t('importExport.macVendorOverridesDesc', 'Custom vendor names of MAC prefixes (shared by every workspace, platform administrators only).'),
    permissionSets:     t('importExport.permissionSetsDesc', 'Custom permission sets (shared by every workspace; importing them is for platform administrators only).'),
  };
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Toggle({
  checked,
  indeterminate = false,
  onChange,
}: {
  checked:        boolean;
  indeterminate?: boolean;
  onChange:       (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={[
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent',
        'transition-colors duration-200 focus:outline-none focus-visible:ring-2',
        'focus-visible:ring-accent focus-visible:ring-offset-2',
        checked
          ? 'bg-accent'
          : indeterminate
            ? 'bg-accent/40'
            : 'bg-bg-tertiary',
      ].join(' ')}
    >
      <span
        className={[
          'pointer-events-none inline-block h-4 w-4 transform rounded-full',
          'bg-white shadow-lg ring-0 transition-transform duration-200',
          checked ? 'translate-x-4' : 'translate-x-0',
        ].join(' ')}
      />
    </button>
  );
}

function SectionSelector({
  sections,
  enabled,
  onToggle,
  onToggleAll,
  descriptions = {},
  extra,
}: {
  sections:      readonly Section[];
  enabled:       Set<Section>;
  onToggle:      (s: Section) => void;
  onToggleAll:   (on: boolean) => void;
  descriptions?: Partial<Record<Section, string>>;
  extra?:        ReactNode;
}) {
  const { t } = useTranslation();

  const SECTION_LABELS = sectionLabels(t);

  const allOn  = sections.length > 0 && sections.every(s => enabled.has(s));
  const someOn = sections.some(s => enabled.has(s));

  return (
    <div className="space-y-1">
      {/* All toggle */}
      <div className="flex items-center justify-between py-2 border-b border-border">
        <span className="text-sm font-medium text-text-primary">{t('importExport.all')}</span>
        <Toggle
          checked={allOn}
          indeterminate={!allOn && someOn}
          onChange={onToggleAll}
        />
      </div>

      {/* Individual sections */}
      {sections.map((s) => (
        <div key={s} className="py-1.5">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm text-text-secondary">{SECTION_LABELS[s]}</span>
              {descriptions[s] && (
                <p className="text-[11px] text-text-muted mt-0.5">{descriptions[s]}</p>
              )}
            </div>
            <Toggle checked={enabled.has(s)} onChange={() => onToggle(s)} />
          </div>
        </div>
      ))}

      {/* Extra content (sub-options) */}
      {extra}
    </div>
  );
}

// ── CSV import (reservations / devices of one site) ───────────────────────────

// Below the server's 1 MB JSON body limit once the CSV is wrapped in JSON.
const CSV_MAX_BYTES = 800 * 1024;

const CSV_TEMPLATE_HEADERS: Record<CsvImportKind, string[]> = {
  reservations: ['ip', 'name', 'description', 'deviceType', 'reservedMac'],
  devices: ['ip', 'mac', 'name', 'deviceType', 'notes'],
};

const CSV_TEMPLATE_ROWS: Record<CsvImportKind, string[][]> = {
  reservations: [
    ['192.0.2.10', 'Example printer', 'Reserved for the printer', 'printer', '02:00:00:00:00:10'],
    ['192.0.2.20', 'Example spare address', '', '', ''],
  ],
  devices: [
    ['192.0.2.30', '02:00:00:00:00:30', 'Example NAS', 'nas', 'Example notes'],
    ['192.0.2.31', '', 'Example sensor', 'iot', ''],
  ],
};

const STATUS_CLASSES: Record<CsvRowStatus, string> = {
  new:      'bg-green-500/15 text-green-400',
  update:   'bg-blue-500/15 text-blue-400',
  conflict: 'bg-amber-500/15 text-amber-400',
  invalid:  'bg-red-500/15 text-red-400',
};

function csvStatusLabel(t: TFunction, status: CsvRowStatus): string {
  switch (status) {
    case 'new':      return t('importExport.csv.status.new', 'New');
    case 'update':   return t('importExport.csv.status.update', 'Update');
    case 'conflict': return t('importExport.csv.status.conflict', 'Conflict');
    case 'invalid':  return t('importExport.csv.status.invalid', 'Invalid');
  }
}

const CSV_ERROR_FALLBACKS: Record<string, string> = {
  ip_required:            'IP address missing',
  invalid_ip:             'Invalid IPv4 address',
  invalid_mac:            'Invalid MAC address',
  name_required:          'Name missing',
  name_too_long:          'Name too long',
  description_too_long:   'Description too long',
  notes_too_long:         'Notes too long',
  invalid_device_type:    'Unknown device type',
  duplicate_in_file:      'Same address earlier in the file',
  reserved_for_other_mac: 'Already reserved for another MAC address',
  mac_on_other_ip:        'This MAC address is known at another IP address',
  ip_used_by_other_mac:   'The IP address is used by a device with another MAC address',
  ambiguous_ip:           'Several devices use this IP address: add the MAC address',
  csv_empty:              'The file has no data rows.',
  csv_header_missing:     'No IP column found: add a header row (ip, name, mac…).',
  csv_unterminated_quote: 'A quoted field is not closed.',
  csv_too_many_rows:      'The file has more than 5000 rows.',
};

function csvMessage(t: TFunction, code: string): string {
  return t(`importExport.csv.errors.${code}`, CSV_ERROR_FALLBACKS[code] ?? code);
}

function CsvImportPanel() {
  const { t } = useTranslation();
  const { anonymize } = useAnonymize();
  const canWriteSite = useAuthStore((s) => s.canWriteSite);
  // Re-evaluate the writable sites when the permissions reload.
  const permissions = useAuthStore((s) => s.permissions);

  const [sites, setSites] = useState<SiteListItem[] | null>(null);
  const [siteId, setSiteId] = useState<number | ''>('');
  const [kind, setKind] = useState<CsvImportKind>('reservations');
  const [file, setFile] = useState<File | null>(null);
  const [csv, setCsv] = useState<string | null>(null);
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [strategy, setStrategy] = useState<CsvCommitStrategy>('update');
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [result, setResult] = useState<CsvCommitResult | null>(null);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    siteApi.list()
      .then((r) => { if (!cancelled) setSites(r.sites); })
      .catch((err: unknown) => {
        if (!cancelled) setSites([]);
        toastApiError(err, t('importExport.csv.sitesFailed', 'Could not load the sites'));
      });
    return () => { cancelled = true; };
  }, [t]);

  const writableSites = useMemo(
    () => (sites ?? [])
      .filter((s) => canWriteSite(s.id, s.groupId ?? null))
      .sort((a, b) => a.name.localeCompare(b.name)),
    // permissions: canWriteSite reads them from the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sites, canWriteSite, permissions],
  );

  // Any change of the inputs makes the preview stale.
  const resetPreview = useCallback(() => {
    setPreview(null);
    setResult(null);
  }, []);

  const handleFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    resetPreview();
    if (f.size > CSV_MAX_BYTES) {
      toast.error(t('importExport.csv.tooLarge', 'The file is too large (800 KB at most).'));
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    setFile(f);
    const reader = new FileReader();
    reader.onload = (ev) => setCsv(typeof ev.target?.result === 'string' ? ev.target.result : null);
    reader.onerror = () => {
      setCsv(null);
      toast.error(t('importExport.readFailed', 'Could not read the file.'));
    };
    reader.readAsText(f);
  }, [resetPreview, t]);

  const showCsvError = useCallback((err: unknown, fallback: string) => {
    const body = apiErrorBody(err) as { error?: string; line?: number | null } | undefined;
    const code = body?.error;
    if (code && code in CSV_ERROR_FALLBACKS) {
      const msg = csvMessage(t, code);
      toast.error(body?.line ? t('importExport.csv.errorAtLine', '{{message}} (line {{line}})', { message: msg, line: body.line }) : msg);
      return;
    }
    toastApiError(err, fallback);
  }, [t]);

  const handlePreview = useCallback(async () => {
    if (siteId === '' || !csv) return;
    setLoadingPreview(true);
    setResult(null);
    try {
      setPreview(await importExportApi.csvPreview({ siteId, kind, csv }));
    } catch (err) {
      setPreview(null);
      showCsvError(err, t('importExport.csv.previewFailed', 'Preview failed'));
    } finally {
      setLoadingPreview(false);
    }
  }, [siteId, kind, csv, showCsvError, t]);

  const handleCommit = useCallback(async () => {
    if (siteId === '' || !csv || !preview) return;
    setCommitting(true);
    try {
      const r = await importExportApi.csvCommit({ siteId, kind, csv, strategy });
      setResult(r);
      setPreview(null);
      toast.success(t('importExport.importOk', 'Import completed successfully'));
    } catch (err) {
      showCsvError(err, t('importExport.failedImport', 'Import failed'));
    } finally {
      setCommitting(false);
    }
  }, [siteId, kind, csv, preview, strategy, showCsvError, t]);

  const handleTemplate = useCallback(async () => {
    const lines = [CSV_TEMPLATE_HEADERS[kind], ...CSV_TEMPLATE_ROWS[kind]].map(csvRow);
    const saved = await saveBlob(
      `oblimap-${kind}-template.csv`,
      new Blob([`﻿${lines.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' }),
      'text/csv;charset=utf-8',
    );
    if (!saved) toast.error(t('importExport.failedExport', 'Export failed'));
  }, [kind, t]);

  /** The preview as a CSV (status and reason per line), formula-neutralised. */
  const handleExportPreview = useCallback(async () => {
    if (!preview) return;
    const header = [
      t('importExport.csv.colLine', 'Line'),
      t('importExport.csv.colStatus', 'Status'),
      t('importExport.csv.colIssue', 'Issue'),
      'IP',
      'MAC',
      t('importExport.csv.colName', 'Name'),
      t('importExport.csv.colType', 'Type'),
    ];
    const lines = [header, ...preview.rows.map((r) => [
      r.line,
      csvStatusLabel(t, r.status),
      [...r.errors, ...(r.reason ? [r.reason] : [])].map((c) => csvMessage(t, c)).join('; '),
      r.ip,
      r.mac ?? '',
      r.name ?? '',
      r.deviceType ? deviceTypeLabel(t, r.deviceType) : '',
    ])].map(csvRow);
    const saved = await saveBlob(
      `oblimap-${kind}-preview.csv`,
      new Blob([`﻿${lines.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' }),
      'text/csv;charset=utf-8',
    );
    if (!saved) toast.error(t('importExport.failedExport', 'Export failed'));
  }, [preview, kind, t]);

  const shownRows = useMemo(
    () => (preview?.rows ?? []).filter((r) => !onlyProblems || r.status === 'conflict' || r.status === 'invalid'),
    [preview, onlyProblems],
  );
  const toWrite = preview
    ? preview.counts.new + (strategy === 'update' ? preview.counts.update : 0)
    : 0;

  const selectClass = 'w-full rounded-lg bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-accent/60';

  return (
    <div className="rounded-xl bg-bg-secondary p-4 sm:p-6">
      <div className="flex items-center gap-2 mb-1">
        <FileSpreadsheet size={15} className="text-accent" />
        <h2 className="text-base font-semibold text-text-primary">{t('importExport.csv.title', 'CSV import')}</h2>
      </div>
      <p className="text-xs text-text-muted mb-5">
        {t('importExport.csv.description', 'Load IP reservations or devices of one site from a spreadsheet (CSV, at most 5000 rows). Check the preview, then import. Columns: ip, then name, mac, deviceType, description or notes — a header row is recommended.')}
      </p>

      <div className="grid gap-4 sm:grid-cols-2 mb-4">
        <label className="block">
          <span className="mb-1.5 block text-sm text-text-muted">{t('importExport.csv.site', 'Site')}</span>
          <select
            value={siteId}
            onChange={(e) => { setSiteId(e.target.value ? Number(e.target.value) : ''); resetPreview(); }}
            className={selectClass}
            disabled={sites === null}
          >
            <option value="">{sites === null ? t('common.loading', 'Loading…') : t('importExport.csv.chooseSite', 'Choose a site…')}</option>
            {writableSites.map((s) => (
              <option key={s.id} value={s.id}>{anonymize(s.name, 'hostname')}</option>
            ))}
          </select>
          {sites !== null && writableSites.length === 0 && (
            <span className="mt-1 block text-xs text-amber-400">
              {t('importExport.csv.noWritableSite', 'You cannot edit any site: the CSV import needs write access to the target site.')}
            </span>
          )}
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm text-text-muted">{t('importExport.csv.kind', 'Content')}</span>
          <select
            value={kind}
            onChange={(e) => { setKind(e.target.value as CsvImportKind); resetPreview(); }}
            className={selectClass}
          >
            <option value="reservations">{t('importExport.csv.kindReservations', 'IP reservations')}</option>
            <option value="devices">{t('importExport.csv.kindDevices', 'Devices (manual)')}</option>
          </select>
        </label>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Button variant="secondary" size="sm" onClick={() => fileInputRef.current?.click()}>
          <Upload size={14} className="mr-1.5" />
          {t('importExport.csv.chooseFile', 'Choose a CSV file')}
        </Button>
        <span className="min-w-0 truncate text-sm text-text-secondary">
          {file ? file.name : t('importExport.csv.noFile', 'No file chosen')}
        </span>
        <button type="button" onClick={handleTemplate} className="ml-auto inline-flex items-center gap-1.5 text-xs text-accent hover:underline">
          <ExternalLink size={11} />
          {t('importExport.csv.downloadTemplate', 'Download a CSV template')}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.txt,text/csv"
          className="hidden"
          onChange={handleFile}
        />
      </div>

      <div className="flex justify-end">
        <Button
          variant="secondary"
          onClick={handlePreview}
          loading={loadingPreview}
          disabled={siteId === '' || !csv}
        >
          <Eye size={14} className="mr-1.5" />
          {t('importExport.csv.preview', 'Preview')}
        </Button>
      </div>

      {preview && (
        <div className="mt-5">
          <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
            {(['new', 'update', 'conflict', 'invalid'] as const).map((s) => (
              <span key={s} className={cn('rounded-full px-2 py-0.5 font-medium tabular-nums', STATUS_CLASSES[s])}>
                {csvStatusLabel(t, s)} · {preview.counts[s]}
              </span>
            ))}
            <label className="ml-auto inline-flex items-center gap-1.5 text-text-muted">
              <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} className="accent-accent" />
              {t('importExport.csv.onlyProblems', 'Conflicts and errors only')}
            </label>
            <button type="button" onClick={handleExportPreview} className="inline-flex items-center gap-1 text-accent hover:underline">
              <Download size={11} />
              {t('importExport.csv.exportPreview', 'Export the preview (CSV)')}
            </button>
          </div>

          <TableScroll className="rounded-lg bg-bg-tertiary" innerClassName="max-h-96 overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-bg-tertiary text-left text-text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">{t('importExport.csv.colLine', 'Line')}</th>
                  <th className="px-3 py-2 font-medium">{t('importExport.csv.colStatus', 'Status')}</th>
                  <th className="px-3 py-2 font-medium">IP</th>
                  <th className="px-3 py-2 font-medium">MAC</th>
                  <th className="px-3 py-2 font-medium">{t('importExport.csv.colName', 'Name')}</th>
                  <th className="px-3 py-2 font-medium">{t('importExport.csv.colType', 'Type')}</th>
                  <th className="px-3 py-2 font-medium">{t('importExport.csv.colIssue', 'Issue')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {shownRows.map((r) => (
                  <tr key={r.line}>
                    <td className="px-3 py-1.5 tabular-nums text-text-muted">{r.line}</td>
                    <td className="px-3 py-1.5">
                      <span className={cn('rounded-full px-2 py-0.5 font-medium', STATUS_CLASSES[r.status])}>
                        {csvStatusLabel(t, r.status)}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 font-mono text-text-secondary">{anonymize(r.ip, 'ip')}</td>
                    <td className="px-3 py-1.5 font-mono text-text-secondary">{r.mac ? anonymize(r.mac, 'mac') : '—'}</td>
                    <td className="px-3 py-1.5 text-text-primary">{r.name ? anonymize(r.name, 'hostname') : '—'}</td>
                    <td className="px-3 py-1.5 text-text-secondary">{r.deviceType ? deviceTypeLabel(t, r.deviceType) : '—'}</td>
                    <td className="px-3 py-1.5 text-text-muted">
                      {[...r.errors, ...(r.reason ? [r.reason] : [])].map((c) => csvMessage(t, c)).join(' · ') || '—'}
                    </td>
                  </tr>
                ))}
                {shownRows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-4 text-center text-text-muted">
                      {t('importExport.csv.noRows', 'Nothing to show.')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </TableScroll>

          <div className="mt-5">
            <p className="text-xs font-medium text-text-muted uppercase tracking-wider mb-3">
              {t('importExport.csv.strategyLabel', 'Existing records')}
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {([
                {
                  value: 'update' as const,
                  label: t('importExport.csv.strategyUpdate', 'Create and update'),
                  description: t('importExport.csv.strategyUpdateDesc', 'New rows are created; rows matching an existing record update it (empty cells keep the stored value).'),
                },
                {
                  value: 'ignore' as const,
                  label: t('importExport.csv.strategyIgnore', 'Create only'),
                  description: t('importExport.csv.strategyIgnoreDesc', 'Only new rows are created; existing records are left unchanged.'),
                },
              ]).map((opt) => (
                <label
                  key={opt.value}
                  className={cn(
                    'flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors',
                    strategy === opt.value ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/40',
                  )}
                >
                  <input
                    type="radio"
                    name="csvStrategy"
                    value={opt.value}
                    checked={strategy === opt.value}
                    onChange={() => setStrategy(opt.value)}
                    className="mt-0.5 accent-accent"
                  />
                  <div>
                    <div className="text-sm font-medium text-text-primary">{opt.label}</div>
                    <div className="text-xs text-text-muted mt-0.5">{opt.description}</div>
                  </div>
                </label>
              ))}
            </div>
            <p className="mt-2 text-xs text-text-muted">
              {t('importExport.csv.skippedNote', 'Conflicts and invalid rows are never imported: fix them in the file and preview again.')}
            </p>
          </div>

          <div className="mt-4 flex justify-end">
            <Button onClick={handleCommit} loading={committing} disabled={toWrite === 0}>
              <Upload size={14} className="mr-1.5" />
              {t('importExport.csv.commit', 'Import {{count}} rows', { count: toWrite })}
            </Button>
          </div>
        </div>
      )}

      {result && (
        <div className="mt-5 rounded-lg bg-bg-tertiary p-4">
          <div className="flex items-center gap-2 mb-2 text-green-400">
            <CheckCircle2 size={15} />
            <span className="text-sm font-medium">{t('importExport.importOk', 'Import completed successfully')}</span>
          </div>
          <p className="text-xs text-text-muted tabular-nums">
            <span className="text-green-400">{t('importExport.statCreated', '{{count}} created', { count: result.created })}</span>
            {' · '}
            <span className="text-blue-400">{t('importExport.statUpdated', '{{count}} updated', { count: result.updated })}</span>
            {' · '}
            <span className="text-yellow-400">{t('importExport.statSkipped', '{{count}} skipped', { count: result.skipped + result.conflicts + result.invalid })}</span>
          </p>
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export interface ImportExportPageProps {
  /**
   * Rendered as a section of another page (Settings): no padding, no page
   * header. Default: the EmbeddedContext (see PageContainer).
   */
  embedded?: boolean;
}

type PageTab = 'json' | 'csv';

export function ImportExportPage({ embedded }: ImportExportPageProps = {}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<PageTab>('json');

  return (
    <PageContainer
      embedded={embedded}
      title={t('importExport.title', 'Import / Export')}
      subtitle={t('importExport.description', 'Export your configuration to a portable JSON file, or import a previously saved file.')}
      icon={<PackageOpen className="h-5 w-5" />}
    >
      <SegmentedTabs<PageTab>
        className="mb-4"
        value={tab}
        onChange={setTab}
        fill={false}
        ariaLabel={t('importExport.title', 'Import / Export')}
        tabs={[
          { id: 'json', label: t('importExport.tabJson', 'Configuration (JSON)'), icon: <FileJson size={14} /> },
          { id: 'csv', label: t('importExport.tabCsv', 'CSV import'), icon: <FileSpreadsheet size={14} /> },
        ]}
      />
      {tab === 'json' ? <JsonImportExport /> : <CsvImportPanel />}
    </PageContainer>
  );
}

function JsonImportExport() {
  const { t } = useTranslation();
  const isPlatformAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const canManageDeviceChecks = useTenantCapability('deviceChecks.manage');
  const userSections = useMemo(() => exportSectionsFor(isPlatformAdmin), [isPlatformAdmin]);
  const importableSections = useMemo(
    () => importSectionsFor(isPlatformAdmin, canManageDeviceChecks),
    [isPlatformAdmin, canManageDeviceChecks],
  );

  const SECTION_LABELS = sectionLabels(t);
  const SECTION_DESCRIPTIONS = sectionDescriptions(t);

  const CONFLICT_OPTIONS: { value: ConflictStrategy; label: string; description: string }[] = [
    {
      value:       'update',
      label:       t('importExport.conflictUpdate', 'Update existing'),
      description: t('importExport.conflictUpdateDesc', 'When a UUID matches an existing record, overwrite it with the imported data.'),
    },
    {
      value:       'generateNew',
      label:       t('importExport.conflictCopy', 'Generate new copy'),
      description: t('importExport.conflictCopyDesc', 'When a UUID matches an existing record, create a brand-new duplicate with a fresh UUID.'),
    },
    {
      value:       'ignore',
      label:       t('importExport.conflictSkip', 'Skip duplicates'),
      description: t('importExport.conflictSkipDesc', 'When a UUID matches an existing record, skip that item entirely.'),
    },
  ];

  // ── Export state ──
  const [exportSections, setExportSections] = useState<Set<Section>>(() => new Set(userSections));
  const [exporting,      setExporting]      = useState(false);

  // A platform-admin section never stays selected for someone else.
  useEffect(() => {
    setExportSections((prev) => new Set([...prev].filter((s) => userSections.includes(s))));
  }, [userSections]);

  // ── Import state ──
  const [importFile,        setImportFile]        = useState<File | null>(null);
  const [importData,        setImportData]        = useState<Record<string, unknown> | null>(null);
  const [availableSections, setAvailableSections] = useState<Section[]>([]);
  const [importSections,    setImportSections]    = useState<Set<Section>>(new Set());
  const [conflictStrategy,  setConflictStrategy]  = useState<ConflictStrategy>('update');
  const [importing,         setImporting]         = useState(false);
  const [importResults,     setImportResults]     = useState<Record<string, ImportSectionResult> | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  // ── Export handlers ──────────────────────────────────────────────────────

  const toggleExportSection = useCallback((s: Section) => {
    setExportSections(prev => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      return next;
    });
  }, []);

  const toggleAllExport = useCallback((on: boolean) => {
    setExportSections(on ? new Set(userSections) : new Set());
  }, [userSections]);

  const handleExport = useCallback(async () => {
    if (exportSections.size === 0) {
      toast.error(t('importExport.selectSection', 'Select at least one section to export'));
      return;
    }
    setExporting(true);
    try {
      const sections = userSections.filter((s) => exportSections.has(s));
      const blob = await importExportApi.exportJson(sections);
      const saved = await saveBlob(
        `oblimap-export-${new Date().toISOString().slice(0, 10)}.json`,
        blob,
        'application/json',
      );
      if (saved) toast.success(t('importExport.exported', 'Export downloaded'));
      else toast.error(t('importExport.failedExport', 'Export failed'));
    } catch (err) {
      toastApiError(err, t('importExport.failedExport', 'Export failed'));
    } finally {
      setExporting(false);
    }
  }, [exportSections, userSections, t]);

  // ── Import handlers ──────────────────────────────────────────────────────

  /** Shared file-processing logic used by both click-select and drag-drop */
  const processFile = useCallback((file: File) => {
    setImportFile(file);
    setImportResults(null);

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const json = JSON.parse(ev.target?.result as string) as Record<string, unknown>;
        if (typeof json !== 'object' || Array.isArray(json)) throw new Error('Not an object');

        // Sections the server would refuse (platform data, vendor rules
        // without deviceChecks.manage) are not offered.
        const available = importableSections.filter(s => Array.isArray(json[s]));
        setAvailableSections(available);
        setImportSections(new Set(available));
        setImportData(json);
      } catch {
        toast.error(t('importExport.invalidFile', 'Invalid export file: an Oblimap JSON export is expected.'));
        setImportFile(null);
        setImportData(null);
        setAvailableSections([]);
        setImportSections(new Set());
        // Reset file input so the same file can be re-selected after error
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    };
    reader.onerror = () => {
      toast.error(t('importExport.readFailed', 'Could not read the file.'));
    };
    reader.readAsText(file);
  }, [t, importableSections]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    processFile(file);
  }, [processFile]);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (!file) return;
    if (!file.name.endsWith('.json') && file.type !== 'application/json') {
      toast.error(t('importExport.dropJsonOnly', 'Drop a .json file.'));
      return;
    }
    processFile(file);
  }, [processFile, t]);

  const toggleImportSection = useCallback((s: Section) => {
    setImportSections(prev => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      return next;
    });
  }, []);

  const toggleAllImport = useCallback((on: boolean) => {
    setImportSections(on ? new Set(availableSections) : new Set());
  }, [availableSections]);

  const handleImport = useCallback(async () => {
    if (!importData) {
      toast.error(t('importExport.noFile', 'Please choose an export file first'));
      return;
    }
    if (importSections.size === 0) {
      toast.error(t('importExport.noSections', 'Select at least one section to import'));
      return;
    }
    setImporting(true);
    setImportResults(null);
    try {
      const results = await importExportApi.importJson({
        sections:         availableSections.filter((s) => importSections.has(s)),
        data:             importData,
        conflictStrategy,
      });
      setImportResults(results);
      toast.success(t('importExport.importOk', 'Import completed successfully'));
    } catch (err) {
      toastApiError(err, t('importExport.failedImport', 'Import failed'));
    } finally {
      setImporting(false);
    }
  }, [importData, importSections, availableSections, conflictStrategy, t]);

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <>
      {/* Example file (also shown when embedded: the host page has no header for it) */}
      <div className="mb-4">
        <a
          href="/oblimap-import-example.json"
          download="oblimap-import-example.json"
          className="inline-flex items-center gap-1.5 text-xs text-accent hover:underline"
        >
          <ExternalLink size={11} />
          {t('importExport.downloadTemplate', 'Download example / template JSON')}
        </a>
      </div>

      {/* ── Export card ── */}
      <div className="mb-6 rounded-xl bg-bg-secondary p-4 sm:p-6">
        <div className="flex items-center gap-2 mb-1">
          <Download size={15} className="text-accent" />
          <h2 className="text-base font-semibold text-text-primary">{t('importExport.exportTitle', 'Export')}</h2>
        </div>
        <p className="text-xs text-text-muted mb-5">
          {t('importExport.exportDesc', 'Choose what to include in the exported file, then download it.')}
        </p>

        <SectionSelector
          sections={userSections}
          enabled={exportSections}
          onToggle={toggleExportSection}
          onToggleAll={toggleAllExport}
          descriptions={SECTION_DESCRIPTIONS}
        />

        <div className="mt-5 flex justify-end">
          <Button
            onClick={handleExport}
            loading={exporting}
            disabled={exportSections.size === 0}
          >
            <Download size={14} className="mr-1.5" />
            {t('importExport.downloadJson', 'Download JSON')}
          </Button>
        </div>
      </div>

      {/* ── Import card ── */}
      <div className="rounded-xl bg-bg-secondary p-4 sm:p-6">
        <div className="flex items-center gap-2 mb-1">
          <Upload size={15} className="text-accent" />
          <h2 className="text-base font-semibold text-text-primary">{t('importExport.importTitle', 'Import')}</h2>
        </div>
        <p className="text-xs text-text-muted mb-5">
          {t('importExport.importDesc', 'Upload an Oblimap export file.')}
        </p>

        {/* File drop zone */}
        <div
          onClick={() => fileInputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputRef.current?.click(); } }}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={[
            'mb-5 flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed',
            'px-6 py-6 transition-colors',
            isDragging
              ? 'border-accent bg-accent/10 scale-[1.01]'
              : importFile
                ? 'border-accent/50 bg-accent/5'
                : 'border-border bg-bg-tertiary hover:border-accent hover:bg-accent/5',
          ].join(' ')}
        >
          <FileJson size={28} className={importFile || isDragging ? 'text-accent' : 'text-text-muted'} />
          <span className="text-sm text-text-secondary text-center">
            {isDragging
              ? t('importExport.dropzoneActive', 'Drop the file here')
              : importFile
                ? importFile.name
                : t('importExport.dropzone', 'Click or drag & drop an export file (.json)')}
          </span>
          {importFile && (
            <span className="text-xs text-text-muted">
              {t('importExport.fileSizeKb', '{{size}} KB', { size: (importFile.size / 1024).toFixed(1) })}
              {availableSections.length > 0 && (
                <> · {t('importExport.sectionsFound', '{{count}} section(s) found', { count: availableSections.length })}</>
              )}
            </span>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={handleFileChange}
          />
        </div>

        {/* Options shown only once a file is loaded */}
        {importData && availableSections.length > 0 && (
          <>
            {/* Section selector */}
            <div className="mb-5">
              <p className="text-xs font-medium text-text-muted uppercase tracking-wider mb-3">
                {t('importExport.sectionsToImport', 'Sections to import')}
              </p>
              <SectionSelector
                sections={availableSections}
                enabled={importSections}
                onToggle={toggleImportSection}
                onToggleAll={toggleAllImport}
              />
            </div>

            {/* Conflict strategy */}
            <div className="mb-5">
              <p className="text-xs font-medium text-text-muted uppercase tracking-wider mb-3">
                {t('importExport.conflictLabel', 'When a UUID already exists in the database')}
              </p>
              <div className="space-y-2">
                {CONFLICT_OPTIONS.map(opt => (
                  <label
                    key={opt.value}
                    className={[
                      'flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors',
                      conflictStrategy === opt.value
                        ? 'border-accent bg-accent/5'
                        : 'border-border hover:border-accent/40',
                    ].join(' ')}
                  >
                    <input
                      type="radio"
                      name="conflictStrategy"
                      value={opt.value}
                      checked={conflictStrategy === opt.value}
                      onChange={() => setConflictStrategy(opt.value)}
                      className="mt-0.5 accent-accent"
                    />
                    <div>
                      <div className="text-sm font-medium text-text-primary">{opt.label}</div>
                      <div className="text-xs text-text-muted mt-0.5">{opt.description}</div>
                    </div>
                  </label>
                ))}
              </div>
              <p className="mt-2 text-xs text-text-muted">
                {t('importExport.ipamStrategyNote', 'Subnets, reservations and devices are matched by site and address; with "Generate new copy" they are added only to the sites this import creates.')}
              </p>
            </div>

            <div className="flex justify-end">
              <Button
                onClick={handleImport}
                loading={importing}
                disabled={importSections.size === 0}
              >
                <Upload size={14} className="mr-1.5" />
                {t('importExport.importBtn', 'Import')}
              </Button>
            </div>
          </>
        )}

        {/* No sections found */}
        {importData && availableSections.length === 0 && (
          <p className="text-sm text-text-muted text-center py-4">
            {t('importExport.noImportable', 'No importable sections found in this file.')}
          </p>
        )}

        {/* Results summary */}
        {importResults && (
          <div className="mt-5 rounded-lg bg-bg-tertiary p-4">
            <div className="flex items-center gap-2 mb-3 text-green-400">
              <CheckCircle2 size={15} />
              <span className="text-sm font-medium">{t('importExport.importOk', 'Import completed successfully')}</span>
            </div>
            <div className="space-y-1.5">
              {Object.entries(importResults).map(([section, r]) => (
                <div key={section} className="flex items-center justify-between gap-3 text-xs">
                  <span className="text-text-secondary">
                    {SECTION_LABELS[section as Section] ?? section}
                  </span>
                  <span className="text-text-muted tabular-nums text-right">
                    <span className="text-green-400">{t('importExport.statCreated', '{{count}} created', { count: r.created })}</span>
                    {' · '}
                    <span className="text-blue-400">{t('importExport.statUpdated', '{{count}} updated', { count: r.updated })}</span>
                    {r.skipped > 0 && (
                      <>{' · '}<span className="text-yellow-400">{t('importExport.statSkipped', '{{count}} skipped', { count: r.skipped })}</span></>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
