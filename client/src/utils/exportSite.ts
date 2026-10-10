/**
 * Site export utilities — CSV and multi-sheet Excel (xlsx).
 * xlsx (SheetJS) is the only dependency; it handles the binary OOXML format.
 *
 * Headers and values are translated (the caller passes `t`). Exports always
 * carry the real values, also in anonymous mode (an anonymized export could
 * not be re-imported or used): the UI warns before exporting in that mode.
 * Files go through saveBlob (browser download, or the Android shell's
 * native save).
 */
import * as XLSX from 'xlsx';
import type { TFunction } from 'i18next';
import type { SiteItem, IpReservation, IpReservationState } from '@oblimap/shared';
import { csvRow, neutralizeFormula } from './csv';
import { deviceTypeLabel } from './deviceTypes';
import { saveBlob } from './download';

export interface SiteExportOptions {
  t: TFunction;
  /** Used in the filenames. */
  siteName: string;
  items: SiteItem[];
  /** Probe id → display name (the "discovered by" column). */
  probeNames?: ReadonlyMap<number, string>;
  /** Site id → name: adds a Site column (cross-site exports). */
  siteNames?: ReadonlyMap<number, string>;
}

export interface SiteExcelOptions extends SiteExportOptions {
  reservations: IpReservation[];
}

// ─── Column definitions ───────────────────────────────────────────────────────

function itemHeaders(t: TFunction, withSite: boolean): string[] {
  return [
    ...(withSite ? [t('siteExport.col.site', 'Site')] : []),
    t('siteExport.col.ip', 'IP'),
    t('siteExport.col.mac', 'MAC'),
    t('siteExport.col.hostname', 'Hostname'),
    t('siteExport.col.displayName', 'Display name'),
    t('siteExport.col.status', 'Status'),
    t('siteExport.col.type', 'Type'),
    t('siteExport.col.vendor', 'Vendor'),
    t('siteExport.col.manual', 'Manual'),
    t('siteExport.col.openPorts', 'Open ports'),
    t('siteExport.col.probe', 'Discovered by'),
    t('siteExport.col.failingChecks', 'Failing checks'),
    t('siteExport.col.firstSeen', 'First seen'),
    t('siteExport.col.lastSeen', 'Last seen'),
    t('siteExport.col.notes', 'Notes'),
  ];
}

function resvHeaders(t: TFunction): string[] {
  return [
    t('siteExport.col.ip', 'IP'),
    t('siteExport.col.name', 'Name'),
    t('siteExport.col.description', 'Description'),
    t('siteExport.col.type', 'Type'),
    t('siteExport.col.state', 'State'),
    t('siteExport.col.reservedMac', 'Reserved for MAC'),
    t('siteExport.col.occupiedByMac', 'Occupied by MAC'),
  ];
}

// ─── Row mappers ──────────────────────────────────────────────────────────────

function fmtDate(ts: string | null | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

const RESERVATION_STATE_FALLBACK: Record<IpReservationState, string> = {
  free: 'Free',
  held: 'Held by its device',
  conflict: 'Conflict',
  owner_offline: 'Owner offline',
};

/** The server's state; older payloads without it: occupied = conflict. */
export function reservationStateOf(r: IpReservation): IpReservationState {
  return r.state ?? (r.isOccupied ? 'conflict' : 'free');
}

export function reservationStateLabel(t: TFunction, state: IpReservationState): string {
  return t(`siteDetail.reservation.state.${state}`, RESERVATION_STATE_FALLBACK[state]);
}

function itemRow(item: SiteItem, opts: SiteExportOptions): string[] {
  const { t, probeNames, siteNames } = opts;
  const failing = (item.checks ?? []).filter((c) => c.status === 'fail' || c.status === 'error').length;
  const probe = item.discoveredByProbeId != null
    ? probeNames?.get(item.discoveredByProbeId) ?? `#${item.discoveredByProbeId}`
    : '';
  return [
    ...(siteNames ? [siteNames.get(item.siteId) ?? `#${item.siteId}`] : []),
    item.ip,
    item.mac ?? '',
    item.hostname ?? '',
    item.customName ?? '',
    t(`itemStatus.${item.status}`, item.status),
    deviceTypeLabel(t, item.deviceType),
    item.vendor ?? '',
    item.isManual ? t('common.yes', 'Yes') : t('common.no', 'No'),
    (item.openPorts ?? []).join(' '),
    probe,
    String(failing),
    fmtDate(item.firstSeenAt),
    fmtDate(item.lastSeenAt),
    item.notes ?? '',
  ];
}

function resvRow(r: IpReservation, t: TFunction): string[] {
  return [
    r.ip,
    r.name,
    r.description ?? '',
    r.deviceType ? deviceTypeLabel(t, r.deviceType) : '',
    reservationStateLabel(t, reservationStateOf(r)),
    r.reservedMac ?? '',
    r.occupiedByMac ?? '',
  ];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Convert headers + rows to a CSV string (CRLF line endings, UTF-8). */
function toCSV(headers: string[], rows: string[][]): string {
  return [headers, ...rows].map(csvRow).join('\r\n');
}

/**
 * Neutralise leading formula characters in every data cell of an XLSX sheet.
 * SheetJS already writes JS strings as text cells; this keeps them inert if
 * the cell is later re-edited in Excel.
 */
function xlsxSafeRows(rows: string[][]): string[][] {
  return rows.map((row) => row.map(neutralizeFormula));
}

/** Strip filesystem-unsafe characters from a site name for use in filenames. */
function safeName(name: string): string {
  return name.replace(/[/\\?%*:|"<>\x00-\x1f]/g, '_').trim() || 'site';
}

/** Excel sheet names: at most 31 characters, none of []:*?/\ */
function sheetName(name: string, fallback: string): string {
  const clean = name.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31);
  return clean || fallback;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Download the given devices as a UTF-8 CSV file. Resolves false when the save failed. */
export function exportSiteCSV(opts: SiteExportOptions): Promise<boolean> {
  const csv = toCSV(itemHeaders(opts.t, !!opts.siteNames), opts.items.map((i) => itemRow(i, opts)));
  // BOM so Excel opens it correctly without re-encoding
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  return saveBlob(`${safeName(opts.siteName)}_devices.csv`, blob, 'text/csv;charset=utf-8');
}

/**
 * Download a two-sheet Excel workbook:
 *   Sheet 1 — Devices
 *   Sheet 2 — Reservations
 * Resolves false when the save failed.
 */
export function exportSiteExcel(opts: SiteExcelOptions): Promise<boolean> {
  const { t } = opts;
  const wb = XLSX.utils.book_new();

  const wsDevices = XLSX.utils.aoa_to_sheet([
    itemHeaders(t, !!opts.siteNames),
    ...xlsxSafeRows(opts.items.map((i) => itemRow(i, opts))),
  ]);
  XLSX.utils.book_append_sheet(wb, wsDevices, sheetName(t('siteExport.sheetDevices', 'Devices'), 'Devices'));

  const wsResv = XLSX.utils.aoa_to_sheet([
    resvHeaders(t),
    ...xlsxSafeRows(opts.reservations.map((r) => resvRow(r, t))),
  ]);
  XLSX.utils.book_append_sheet(wb, wsResv, sheetName(t('siteExport.sheetReservations', 'Reservations'), 'Reservations'));

  const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const data = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return saveBlob(`${safeName(opts.siteName)}_export.xlsx`, new Blob([data], { type: mime }), mime);
}
