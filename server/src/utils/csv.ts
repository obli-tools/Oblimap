/**
 * Small RFC 4180 CSV reader (CSV import of reservations / devices).
 *
 *  - fields separated by ',' — or ';' / TAB when the first line holds more of
 *    those (spreadsheets saved with a European locale use ';');
 *  - a field may be wrapped in double quotes; inside, '""' is one quote and
 *    separators / line breaks are literal;
 *  - records end with CRLF, LF or CR; a leading UTF-8 BOM is dropped; blank
 *    records are skipped;
 *  - an unterminated quoted field is an error (CsvParseError), as is a file
 *    with more records than maxRecords (the caller's row cap).
 *
 * Our own exports neutralise formulas with a leading single quote
 * (client/src/utils/csv.ts): unneutralizeCell() strips it again so an
 * exported file can be imported back unchanged.
 */

export class CsvParseError extends Error {
  constructor(public readonly code: 'csv_unterminated_quote' | 'csv_too_many_rows', message: string, public readonly line?: number) {
    super(message);
    this.name = 'CsvParseError';
  }
}

export type CsvDelimiter = ',' | ';' | '\t';

/** The delimiter of the first record: ',' unless ';' or TAB occur more often (outside quotes). */
export function detectDelimiter(text: string): CsvDelimiter {
  const counts: Record<CsvDelimiter, number> = { ',': 0, ';': 0, '\t': 0 };
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { inQuotes = !inQuotes; continue; }
    if (inQuotes) continue;
    if (c === '\n' || c === '\r') break;
    if (c === ',' || c === ';' || c === '\t') counts[c]++;
  }
  if (counts[';'] > counts[','] && counts[';'] >= counts['\t']) return ';';
  if (counts['\t'] > counts[',']) return '\t';
  return ',';
}

export interface ParsedCsvRecord {
  /** 1-based line of the file where the record starts. */
  line: number;
  cells: string[];
}

/**
 * Parses the text into records (cells untrimmed). maxRecords counts every
 * non-blank record, header included.
 */
export function parseCsv(input: string, opts: { delimiter?: CsvDelimiter; maxRecords?: number } = {}): ParsedCsvRecord[] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = opts.delimiter ?? detectDelimiter(text);
  const maxRecords = opts.maxRecords ?? Number.POSITIVE_INFINITY;

  const records: ParsedCsvRecord[] = [];
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  let quotedStartLine = 0;
  let line = 1;
  let recordLine = 1;
  let fieldWasQuoted = false;

  const endRecord = () => {
    cells.push(field);
    const blank = cells.length === 1 && cells[0] === '' && !fieldWasQuoted;
    if (!blank) {
      if (records.length >= maxRecords) {
        throw new CsvParseError('csv_too_many_rows', `The file has more than ${maxRecords} rows`, recordLine);
      }
      records.push({ line: recordLine, cells });
    }
    cells = [];
    field = '';
    fieldWasQuoted = false;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        if (c === '\n' || (c === '\r' && text[i + 1] !== '\n')) line++;
        field += c;
      }
      continue;
    }
    if (c === '"' && field === '') {
      inQuotes = true;
      fieldWasQuoted = true;
      quotedStartLine = line;
      continue;
    }
    if (c === delimiter) {
      cells.push(field);
      field = '';
      fieldWasQuoted = false;
      continue;
    }
    if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRecord();
      line++;
      recordLine = line;
      continue;
    }
    // A quote inside an unquoted field is kept literally (lenient, as spreadsheets do).
    field += c;
  }
  if (inQuotes) {
    throw new CsvParseError('csv_unterminated_quote', `Unterminated quoted field (line ${quotedStartLine})`, quotedStartLine);
  }
  if (field !== '' || cells.length > 0 || fieldWasQuoted) endRecord();
  return records;
}

const NEUTRALIZED_FORMULA = /^'[=+\-@\t\r]/;

/** "'=1+1" (formula neutralised by our exports) → "=1+1"; anything else unchanged. */
export function unneutralizeCell(s: string): string {
  return NEUTRALIZED_FORMULA.test(s) ? s.slice(1) : s;
}
