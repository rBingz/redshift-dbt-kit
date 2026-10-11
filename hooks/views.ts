// Pure parsing and layout for the two panes. No `$` here, so tests can call them directly.
import type { Board, BoardRow, QueryResult } from '../types'

const MAX_ROWS = 1000
const FAILED = new Set(['error', 'fail', 'runtime error'])

type RunResults = {
  metadata?: { generated_at?: string }
  elapsed_time?: number
  results?: { unique_id: string; status: string; execution_time: number; message?: string | null; adapter_response?: { rows_affected?: number } }[]
}

// run_results.json to a board; undefined when the file is older than this run (dbt died before writing it).
export function parseRunResults(json: string, command: string, startedAt: number): Board | undefined {
  const doc = JSON.parse(json) as RunResults
  // dbt writes microseconds; trim to milliseconds so every Date.parse reads it.
  const at = Date.parse((doc.metadata?.generated_at ?? '').replace(/(\.\d{3})\d+/, '$1'))
  if (!(at >= startedAt - 2000) || doc.results === undefined) return
  const rows: BoardRow[] = doc.results.map(r => ({
    name: r.unique_id.split('.').slice(2).join('.') || r.unique_id,
    status: r.status,
    seconds: r.execution_time,
    rowsAffected: r.adapter_response?.rows_affected,
    message: r.message ?? undefined,
  }))
  return { command, elapsed: doc.elapsed_time ?? 0, rows }
}

export const isFailed = (row: BoardRow) => FAILED.has(row.status)

export function statusCounts(rows: BoardRow[]): string {
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1)
  return [...counts].map(([status, n]) => `${n} ${status}`).join(' · ')
}

type Cell = { stringValue?: string; longValue?: number; doubleValue?: number; booleanValue?: boolean; isNull?: boolean }
type StatementResult = { ColumnMetadata?: { name: string; typeName: string }[]; Records?: Cell[][]; TotalNumRows?: number }

// `aws redshift-data get-statement-result` JSON to a result; undefined for any other output.
export function parseStatementResult(stdout: string, id: string): QueryResult | undefined {
  let doc: StatementResult
  try {
    doc = JSON.parse(stdout) as StatementResult
  } catch {
    return
  }
  if (doc.ColumnMetadata === undefined || doc.Records === undefined) return
  const cell = (c: Cell) => (c.isNull ? null : String(c.stringValue ?? c.longValue ?? c.doubleValue ?? c.booleanValue ?? '(blob)'))
  return {
    id,
    columns: doc.ColumnMetadata.map(c => ({ name: c.name, type: c.typeName })),
    rows: doc.Records.slice(0, MAX_ROWS).map(r => r.map(cell)),
    total: doc.TotalNumRows ?? doc.Records.length,
  }
}

// Fixed-width text table: columns capped at 30 wide; trailing columns that do not fit are dropped.
export function textTable(result: QueryResult, rows: (string | null)[][], width: number): { header: string; lines: string[]; hidden: number } {
  const show = (v: string | null) => v ?? '∅'
  const widths = result.columns.map((c, i) => Math.min(30, Math.max(c.name.length, ...rows.map(r => show(r[i] ?? null).length))))
  let used = -2 // no gap before the first column
  let fit = 0
  while (fit < widths.length && used + 2 + widths[fit]! <= width) used += 2 + widths[fit++]!
  fit = Math.max(1, fit)
  const line = (cells: string[]) => cells.slice(0, fit).map((v, i) => (v.length > widths[i]! ? v.slice(0, widths[i]! - 1) + '…' : v.padEnd(widths[i]!))).join('  ')
  return {
    header: line(result.columns.map(c => c.name)),
    lines: rows.map(r => line(r.map(show))),
    hidden: result.columns.length - fit,
  }
}

const NUMERIC = /int|float|numeric|decimal|double|real/i

// Columns typed numeric whose values all parse, with at least two values.
export function numericColumns(result: QueryResult): number[] {
  return result.columns.flatMap((c, i) => {
    if (!NUMERIC.test(c.type)) return []
    const values = result.rows.map(r => r[i]).filter((v): v is string => v != null)
    return values.length >= 2 && values.every(v => Number.isFinite(Number(v))) ? [i] : []
  })
}

const TICKS = '▁▂▃▄▅▆▇█'

// Row-order sparkline, averaged into at most `width` buckets.
export function sparkline(values: number[], width: number): string {
  const n = Math.max(1, Math.min(width, values.length))
  const buckets = Array.from({ length: n }, (_, b) => {
    const part = values.slice(Math.floor((b * values.length) / n), Math.floor(((b + 1) * values.length) / n))
    return part.reduce((s, v) => s + v, 0) / Math.max(1, part.length)
  })
  const lo = Math.min(...buckets)
  const span = Math.max(...buckets) - lo || 1
  return buckets.map(v => TICKS[Math.round(((v - lo) / span) * (TICKS.length - 1))]).join('')
}

// Claude Code's own spinner glyphs, there and back.
export const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢']
export const CLAUDE_ORANGE = 0xd77757

const EIGHTHS = ' ▏▎▍▌▋▊▉'

// Bar in eighth-cell steps: `width` cells at most, never empty.
export function smoothBar(value: number, max: number, width: number): string {
  const eighths = Math.max(1, Math.round((value / (max || 1)) * width * 8))
  return '█'.repeat(Math.floor(eighths / 8)) + (eighths % 8 ? EIGHTHS[eighths % 8] : '')
}

const lerp = (a: number, b: number, t: number) =>
  [16, 8, 0].reduce((rgb, shift) => rgb | (Math.round(((a >> shift) & 255) + (((b >> shift) & 255) - ((a >> shift) & 255)) * t) << shift), 0)

// Green to yellow to red as `t` goes 0 to 1.
export function heat(t: number): string {
  const c = t < 0.5 ? lerp(0x4eba65, 0xe5c07b, t * 2) : lerp(0xe5c07b, 0xe06c75, (t - 0.5) * 2)
  return `#${c.toString(16).padStart(6, '0')}`
}

export type Chip = { label: string; color: 'success' | 'error' | 'warning' | 'inactive' }

export function chip(status: string): Chip {
  if (FAILED.has(status)) return { label: ` ${status.toUpperCase()} `, color: 'error' }
  if (status === 'warn') return { label: ' WARN ', color: 'warning' }
  if (status === 'skipped') return { label: ' SKIP ', color: 'inactive' }
  return { label: ` ${status === 'success' ? 'OK' : status.toUpperCase()} `, color: 'success' }
}

const LOWER = [0x20, 0x2581, 0x2582, 0x2583, 0x2584, 0x2585, 0x2586, 0x2587, 0x2588]
const DEFAULT_BG = 0x01000000

// Filled area chart as Raster cells (base64): values bucketed to `columns`, `rows` tall, 8 steps a row,
// shaded from dim at the bottom to Claude orange at the top.
export function areaCells(values: number[], columns: number, rows: number): string {
  const n = Math.max(1, columns)
  const buckets = Array.from({ length: n }, (_, b) => {
    const part = values.slice(Math.floor((b * values.length) / n), Math.max(Math.floor(((b + 1) * values.length) / n), Math.floor((b * values.length) / n) + 1))
    return part.reduce((s, v) => s + v, 0) / Math.max(1, part.length)
  })
  const lo = Math.min(...buckets)
  const span = Math.max(...buckets) - lo || 1
  const words = new Uint32Array(n * rows * 3)
  for (let x = 0; x < n; x++) {
    const level = 1 + Math.round(((buckets[x]! - lo) / span) * (rows * 8 - 1))
    for (let y = 0; y < rows; y++) {
      const fromBottom = rows - 1 - y
      const fill = Math.min(8, Math.max(0, level - fromBottom * 8))
      const i = (y * n + x) * 3
      words[i] = LOWER[fill]!
      words[i + 1] = lerp(0x5a2e20, CLAUDE_ORANGE, rows === 1 ? 1 : fromBottom / (rows - 1) * 0.6 + 0.4)
      words[i + 2] = DEFAULT_BG
    }
  }
  return btoa(String.fromCharCode(...new Uint8Array(words.buffer)))
}

// Prompts the panes' "Ask Claude" buttons put in the prompt box. The person reads and sends them.
export function fixPrompt(command: string, row: BoardRow): string {
  return `\`${command}\` failed on ${row.name} (${row.status}): ${row.message ?? 'no message'}. Find the cause in its SQL and the compiled SQL under target/, fix it, then re-run only that node with --select on a dev target.`
}

export function improvePrompt(card: { name: string; description?: string; tests?: string[]; columns?: number; documented?: number }): string | undefined {
  const gaps = [
    !card.description && 'a model description',
    (card.tests?.length ?? 0) === 0 && 'tests (at least unique and not_null on its key)',
    (card.documented ?? 0) < (card.columns ?? 0) && `descriptions for its ${(card.columns ?? 0) - (card.documented ?? 0)} undocumented columns`,
  ].filter(Boolean)
  return gaps.length === 0 ? undefined : `dbt model ${card.name} is missing ${gaps.join(', ')}. Add them to the model's .yml file, following how the project documents its other models.`
}

export function explainPrompt(result: QueryResult): string {
  return `Explain the query result I am looking at (${result.id}: ${result.total} rows; columns ${result.columns.map(c => c.name).join(', ')}). Point out anything odd: nulls, duplicates, outliers, unexpected values.`
}

// The team's conventions, added to Claude's system prompt so the panes fill without anyone asking.
export function conventions(prodDatabases: string[], prodTarget: string): string {
  const also = prodDatabases.length ? `, plus database ${prodDatabases.map(d => `\`${d}\``).join(' and ')}` : ''
  return [
    '# Redshift + dbt (redshift-dbt-kit)',
    '- Query Redshift through dbt on a dev target: `dbt show --target <dev target> --output json --limit 200 --inline "<select ...>"`. JSON output fills the user\'s Query results pane; text output does not. Do not pipe it (`| head`, `| sed`): the pane reads what the command prints, so use --limit instead.',
    '- Pass --target on every dbt command, and --profile outside a dbt project, so the guard and the status line know the environment.',
    `- Prod is the target \`${prodTarget}\` and the database it points at${also}. Any target that points at a prod database is prod too, whatever it is called. On prod the guard blocks dbt run, build, seed, snapshot, run-operation and --full-refresh, and destructive SQL through dbt show. If a call is blocked, do not work around it: tell the user what to run on prod themselves.`,
    '- Explore with SELECT. Never DROP, TRUNCATE, DELETE or UPDATE without WHERE, ALTER ... DROP, GRANT or REVOKE on prod.',
    '- Avoid dbt commands on lines of a heredoc body: the guard reads each line as a command, so it checks them as if they ran. Quoted text is fine.',
    '- To check whether a column exists, the user can open /rs-schema.',
  ].join('\n')
}
