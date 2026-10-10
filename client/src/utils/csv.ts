/**
 * CSV helpers shared by every client-side export (site devices, network flows).
 *
 * Every cell is wrapped in double quotes with embedded quotes doubled
 * (RFC 4180), so commas, quotes and newlines in a value can never shift the
 * columns. Values starting with a spreadsheet formula trigger
 * (= + - @ TAB CR) get a leading single quote so Excel / LibreOffice / Sheets
 * open them as text instead of evaluating them (CSV / formula injection).
 * Hostnames, custom names, notes and vendors are user- or probe-controlled,
 * so nothing may be written to an export without going through these helpers.
 */

const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/**
 * Prefix a value that starts with a formula trigger with a single quote.
 * Also used for XLSX string cells, where the quote is kept as a literal
 * character so re-editing the cell in Excel cannot turn it into a formula.
 */
export function neutralizeFormula(s: string): string {
  return FORMULA_TRIGGER.test(s) ? `'${s}` : s;
}

/** Encode one value as a quoted, formula-safe CSV cell. null/undefined → empty cell. */
export function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return `"${neutralizeFormula(s).replace(/"/g, '""')}"`;
}

/** Encode one CSV line (no line terminator). */
export function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(',');
}
