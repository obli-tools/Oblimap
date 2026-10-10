import apiClient from './client';
import type { DeviceType } from '@oblimap/shared';

// Import / export (server: routes/importExport.routes.ts, mounted at /admin).
// JSON export / import: the import gate (settings + groups.manage +
// sites.manage + notifications.manage + users.manage); MAC-vendor overrides
// and permission sets are platform-admin sections, the vendor-rule import also
// needs deviceChecks.manage. CSV import of reservations / devices: write
// permission on the target site.

export const IMPORT_EXPORT_SECTIONS = [
  'siteGroups',
  'sites',
  'settings',
  'notificationChannels',
  'teams',
  'siteSubnets',
  'reservations',
  'siteItems',
  'vendorRules',
  'macVendorOverrides',
  'permissionSets',
] as const;
export type ImportExportSection = typeof IMPORT_EXPORT_SECTIONS[number];

/** Sections only platform admins may import (platform-wide data). */
export const PLATFORM_ADMIN_SECTIONS: readonly ImportExportSection[] = ['macVendorOverrides', 'permissionSets'];

/** Sections only platform admins may export (custom permission sets are exportable by every holder of the import / export gate). */
export const PLATFORM_EXPORT_SECTIONS: readonly ImportExportSection[] = ['macVendorOverrides'];

export type ConflictStrategy = 'update' | 'generateNew' | 'ignore';

export interface ImportSectionResult {
  created: number;
  updated: number;
  skipped: number;
  disabled?: number;
}

export type CsvImportKind = 'reservations' | 'devices';
export type CsvRowStatus = 'new' | 'update' | 'conflict' | 'invalid';
export type CsvCommitStrategy = 'update' | 'ignore';

export interface CsvPreviewRow {
  line: number;
  status: CsvRowStatus;
  reason?: 'reserved_for_other_mac' | 'mac_on_other_ip' | 'ip_used_by_other_mac' | 'ambiguous_ip';
  existingId?: number;
  errors: string[];
  ip: string;
  mac: string | null;
  name: string | null;
  description: string | null;
  notes: string | null;
  deviceType: DeviceType | null;
}

export interface CsvPreview {
  kind: CsvImportKind;
  siteId: number;
  hasHeader: boolean;
  columns: string[];
  counts: Record<CsvRowStatus, number>;
  rows: CsvPreviewRow[];
}

export interface CsvCommitResult {
  created: number;
  updated: number;
  skipped: number;
  conflicts: number;
  invalid: number;
}

export const importExportApi = {
  /** The JSON export file (a Blob, saved with saveBlob). */
  exportJson: (sections: ImportExportSection[]): Promise<Blob> =>
    apiClient
      .get('/admin/export', { params: { sections: sections.join(',') }, responseType: 'blob' })
      .then((r) => r.data as Blob),

  importJson: (body: {
    sections: ImportExportSection[];
    data: Record<string, unknown>;
    conflictStrategy: ConflictStrategy;
  }): Promise<Record<string, ImportSectionResult>> =>
    apiClient
      .post('/admin/import', body)
      .then((r) => r.data.data as Record<string, ImportSectionResult>),

  csvPreview: (body: { siteId: number; kind: CsvImportKind; csv: string }): Promise<CsvPreview> =>
    apiClient
      .post('/admin/import/csv/preview', body)
      .then((r) => r.data.data as CsvPreview),

  csvCommit: (body: { siteId: number; kind: CsvImportKind; csv: string; strategy: CsvCommitStrategy }): Promise<CsvCommitResult> =>
    apiClient
      .post('/admin/import/csv/commit', body)
      .then((r) => r.data.data as CsvCommitResult),
};
