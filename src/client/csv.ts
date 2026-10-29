/**
 * RFC 4180-style delimited-text parsing for the CSV/TSV table viewer.
 *
 * The host hands the viewer one UTF-8 document (BOM included when the file
 * has one); this module turns it into rows without touching React or the DOM,
 * so the quoting/CRLF/empty-field rules are unit-testable on their own.
 *
 * The cap is a rendering budget, not a file-size gate: the viewer shows at
 * most {@link CSV_MAX_ROWS} rows and reads at most {@link CSV_MAX_BYTES}
 * characters (the file is UTF-8, so this is an upper bound on bytes). A
 * document beyond either bound is parsed up to the boundary and reported as
 * truncated, which keeps a pathological file from allocating a giant table.
 */

/** Delimiters the viewer can detect and the user can force. */
export type CsvDelimiter = ',' | '\t' | ';'

/** Rows shown before the viewer reports truncation. */
export const CSV_MAX_ROWS = 5000

/** Characters read before the viewer reports truncation (UTF-8 upper bound). */
export const CSV_MAX_BYTES = 2 * 1024 * 1024

/** One parsed document. */
export interface CsvParseResult {
  /** Data rows; the first row is the header as written in the file. */
  readonly rows: readonly (readonly string[])[]
  /** Delimiter actually used (detected or forced). */
  readonly delimiter: CsvDelimiter
  /** Widest row in `rows` (the table's column count). */
  readonly columns: number
  /** Rows included in `rows`. */
  readonly rowCount: number
  /** Whether the document was cut by the row or byte budget. */
  readonly truncated: boolean
  /** Present when `truncated`: which budget stopped the parse. */
  readonly truncatedBy?: 'rows' | 'bytes'
  /** Characters examined (after the BOM). */
  readonly chars: number
}

/** One parse request. */
export interface CsvParseOptions {
  /** Force a delimiter; omitted/undefined means auto-detect. */
  readonly delimiter?: CsvDelimiter
  /** Test seam: lower the row budget. */
  readonly maxRows?: number
  /** Test seam: lower the character budget. */
  readonly maxChars?: number
}

/** Delimiter candidates, in tie-break order (comma wins a flat tie). */
const CANDIDATES: readonly CsvDelimiter[] = [',', '\t', ';']

/**
 * Pick the delimiter from the first non-empty lines, counting only
 * separators outside quoted fields.
 * @param text - document text (BOM already stripped).
 * @returns the delimiter with the most consistent per-line count; comma when
 * nothing separates.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  const sample = text.split(/\r\n|\n|\r/).filter(line => line.trim() !== '').slice(0, 20)
  let best: CsvDelimiter = ','
  let bestScore = 0
  for (const delimiter of CANDIDATES) {
    const counts = sample.map(line => countOutsideQuotes(line, delimiter))
    const positive = counts.filter(count => count > 0)
    if (positive.length === 0) continue
    // Prefer a delimiter that appears on every sampled line with the same
    // count (a real table); otherwise fall back to the raw total.
    const consistent = positive.length === counts.length && new Set(positive).size === 1
    const score = (consistent ? 1_000_000 : 0) + positive.reduce((sum, count) => sum + count, 0)
    if (score > bestScore) { best = delimiter; bestScore = score }
  }
  return best
}

/** Count one delimiter outside double-quoted spans (quotes may be doubled). */
function countOutsideQuotes(line: string, delimiter: CsvDelimiter): number {
  let quoted = false
  let count = 0
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { index += 1; continue }
      quoted = !quoted
    } else if (!quoted && char === delimiter) count += 1
  }
  return count
}

/**
 * Parse a delimited document with RFC 4180 quoting.
 *
 * Rules pinned by tests: a quoted field may contain delimiters and newlines;
 * `""` inside a quoted field is one literal quote; CRLF, LF and a lone CR all
 * end a row; a leading BOM is dropped; blank lines are skipped; empty fields
 * (including a trailing empty field) survive.
 * @param text - the document text.
 * @param options - forced delimiter and test budgets.
 * @returns parsed rows plus the delimiter/count/truncation facts.
 */
export function parseCsv(text: string, options: CsvParseOptions = {}): CsvParseResult {
  const maxRows = options.maxRows ?? CSV_MAX_ROWS
  const maxChars = options.maxChars ?? CSV_MAX_BYTES
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text
  const examined = Math.min(source.length, maxChars)
  const delimiter = options.delimiter ?? detectDelimiter(source.slice(0, Math.min(source.length, 64 * 1024)))
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let sawQuote = false
  let rowTouched = false
  let limitReached = false
  let index = 0

  const endField = (): void => {
    row.push(field)
    field = ''
    sawQuote = false
  }
  const endRow = (): void => {
    endField()
    // A blank physical line is not a record. A line that produced fields
    // through delimiters or quotes (`a,,`, `,`, `""`) is a record and is kept.
    if (rowTouched) rows.push(row)
    row = []
    rowTouched = false
    if (rows.length >= maxRows && index < examined - 1) limitReached = true
  }

  for (; index < examined && !limitReached; index += 1) {
    const char = source[index]!
    if (!quoted && char === '\n') { endRow(); continue }
    if (!quoted && char === '\r') {
      endRow()
      if (source[index + 1] === '\n') index += 1
      continue
    }
    rowTouched = true
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') { field += '"'; index += 1 } else quoted = false
      } else field += char
      continue
    }
    if (char === '"' && field === '' && !sawQuote) { quoted = true; sawQuote = true; continue }
    if (char === delimiter) { endField(); continue }
    field += char
  }
  // The final record is emitted when the document did not end on a newline;
  // an unclosed quote still contributes its partial field rather than losing
  // the text the reader can see in the file.
  if (field !== '' || row.length > 0 || sawQuote) endRow()

  const truncatedBy = limitReached
    ? 'rows' as const
    : source.length > examined ? 'bytes' as const : undefined
  const visibleRows = rows
  let columns = 0
  for (const entry of visibleRows) columns = Math.max(columns, entry.length)
  return {
    rows: visibleRows,
    delimiter,
    columns,
    rowCount: visibleRows.length,
    truncated: truncatedBy !== undefined,
    ...(truncatedBy === undefined ? {} : { truncatedBy }),
    chars: examined,
  }
}
