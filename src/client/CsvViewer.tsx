/**
 * CSV / TSV table viewer.
 *
 * The file tree's editor claims every text extension, so a `.csv` used to
 * open as one CodeMirror document: correct bytes, useless shape. This viewer
 * is registered for `csv`/`tsv` ahead of the `code` catch-all and renders the
 * parsed grid by default, with the original text one toggle away (the same
 * lazy TextEditor component every other text file uses, so editing/saving
 * keeps working).
 *
 * Parsing is pure (see csv.ts); this file owns only presentation state:
 * table/text mode, the delimiter override, the truncation notice, and the
 * incremental row window that keeps a 5000-row table from mounting 5000
 * rows at once.
 */
import { useMemo, useState, type ComponentType, type ReactNode } from 'react'
import { CSV_MAX_ROWS, parseCsv, type CsvDelimiter } from './csv.ts'
import { lazyChunkComponent } from './lazy-chunk.tsx'
import type { FileViewerProps } from './service.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

/** Rows mounted per "show more" step; the first page is deliberately small. */
const ROW_PAGE = 200

const LazyTextEditor = lazyChunkComponent<FileViewerProps>('editor', (mod) => mod.TextEditor as ComponentType<FileViewerProps> | undefined)

type DelimiterChoice = 'auto' | CsvDelimiter

/** Human label for one choice in the delimiter select. */
function delimiterLabel(choice: DelimiterChoice): string {
  if (choice === 'auto') return t('csvAuto')
  if (choice === ',') return t('csvComma')
  if (choice === '\t') return t('csvTab')
  return t('csvSemicolon')
}

/** Human label for the delimiter actually used. */
function activeDelimiterLabel(delimiter: CsvDelimiter): string {
  return delimiterLabel(delimiter)
}

export function CsvViewer(props: FileViewerProps): ReactNode {
  const { content, largeFile, onReload } = props
  const [mode, setMode] = useState<'table' | 'text'>('table')
  const [choice, setChoice] = useState<DelimiterChoice>('auto')
  const [rowLimit, setRowLimit] = useState(ROW_PAGE)

  const { parsed, parseError } = useMemo(() => {
    if (content === undefined) return { parsed: null, parseError: null as string | null }
    try {
      return {
        parsed: parseCsv(content, choice === 'auto' ? {} : { delimiter: choice }),
        parseError: null as string | null,
      }
    } catch (error: unknown) {
      return { parsed: null, parseError: error instanceof Error ? error.message : String(error) }
    }
  }, [content, choice])

  // A new delimiter can make the old "show more" window meaningless; every
  // parse result starts at the first page again.
  const visibleRows = parsed === null ? [] : parsed.rows.slice(0, rowLimit)

  const toolbar = (
    <div className={css.csvToolbar} role="toolbar" aria-label={t('viewerCsv')}>
      <div className={css.csvSegmented} role="group">
        <button
          type="button"
          className={css.csvSegment}
          aria-pressed={mode === 'table'}
          onClick={() => { setMode('table') }}
        >
          {t('csvTable')}
        </button>
        <button
          type="button"
          className={css.csvSegment}
          aria-pressed={mode === 'text'}
          onClick={() => { setMode('text') }}
        >
          {t('csvText')}
        </button>
      </div>
      <label className={css.csvField}>
        <span>{t('csvDelimiter')}</span>
        <select
          className={css.csvSelect}
          value={choice}
          onChange={(event) => { setChoice(event.target.value as DelimiterChoice); setRowLimit(ROW_PAGE) }}
        >
          <option value="auto">{delimiterLabel('auto')}</option>
          <option value=",">{delimiterLabel(',')}</option>
          <option value="\t">{delimiterLabel('\t')}</option>
          <option value=";">{delimiterLabel(';')}</option>
        </select>
      </label>
      <span className={css.csvMeta}>{t('csvEncoding')}: {t('csvUtf8')}</span>
      {parsed !== null && (
        <span className={css.csvMeta}>{t('csvRowsColumns', { rows: parsed.rowCount, columns: parsed.columns })}</span>
      )}
      <span className={css.csvMeta}>{t('csvDelimiter')}: {parsed === null ? '—' : activeDelimiterLabel(parsed.delimiter)}</span>
      {onReload !== undefined && (
        <button type="button" className={css.csvReload} onClick={onReload}>{t('csvReload')}</button>
      )}
    </div>
  )

  let body: ReactNode
  if (mode === 'text') {
    // The existing CodeMirror viewer owns text editing/saving entirely; the
    // toolbar above stays so the reader can return to the table.
    body = <div className={css.csvTextPane}><LazyTextEditor {...props} /></div>
  } else if (largeFile !== undefined) {
    body = <div className={css.csvNotice}>{t('csvTooLargeForTable')}</div>
  } else if (content === undefined) {
    body = <div className={css.csvNotice}>{t('loading')}</div>
  } else if (parseError !== null) {
    body = <div className={css.csvError} role="alert">{t('csvParseError', { message: parseError })}</div>
  } else if (parsed === null || parsed.rowCount === 0) {
    body = <div className={css.csvEmpty}>{t('csvEmpty')}</div>
  } else {
    const header = parsed.rows[0] ?? []
    // The first record is the header; when a file is a single record it is
    // still shown as the header row (and the count says 1 row).
    const bodyRows = visibleRows.slice(1)
    const width = Math.max(parsed.columns, header.length, 1)
    body = (
      <>
        {parsed.truncated && (
          <div className={css.csvNotice}>
            {parsed.truncatedBy === 'bytes'
              ? t('csvTruncatedBytes', { rows: parsed.rowCount })
              : t('csvTruncated', { rows: parsed.rowCount })}
          </div>
        )}
        <div className={css.csvScroll}>
          <table className={css.csvTable}>
            <thead>
              <tr>
                <th className={css.csvRowNumber} scope="col">#</th>
                {Array.from({ length: width }, (_, index) => (
                  <th key={index} className={css.csvHeaderCell} scope="col">{header[index] ?? ''}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {bodyRows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  <th className={css.csvRowNumber} scope="row">{rowIndex + 2}</th>
                  {Array.from({ length: width }, (_, columnIndex) => (
                    <td key={columnIndex} className={css.csvCell}>{row[columnIndex] ?? ''}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {parsed.rowCount > rowLimit && (
          <button type="button" className={css.csvShowMore} onClick={() => { setRowLimit(current => Math.min(CSV_MAX_ROWS, current + ROW_PAGE)) }}>
            {t('csvShowMore')}
          </button>
        )}
      </>
    )
  }

  return (
    <div className={css.csvViewer} data-csv-viewer={mode} data-csv-delimiter={parsed?.delimiter ?? ''} data-csv-rows={parsed?.rowCount ?? 0} data-csv-columns={parsed?.columns ?? 0}>
      {toolbar}
      {body}
    </div>
  )
}
