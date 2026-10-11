// The /kit tour: one page per feature after the setup check. No `$` here, so tests can call it directly.
import type { Board, QueryResult } from '../types'

export type Preview = 'guard' | 'status' | 'board' | 'results' | 'schema' | 'card' | 'buttons' | 'commands'

export type TourPage = {
  icon: string
  title: string
  tagline: string
  bullets: string[]
  // A miniature of the feature, drawn from the sample data below.
  preview: Preview
  // A "try it" button: puts `prompt` in the prompt box for the person to send.
  tryIt?: { label: string; prompt: string }
}

export function tourPages(prodTarget: string, dev?: { profile: string; target: string }): TourPage[] {
  const devFlags = dev ? `--profile ${dev.profile} --target ${dev.target}` : '--target <your dev target>'
  return [
    {
      icon: '🛡',
      title: 'Guard',
      tagline: 'Keeps Claude off prod, with nothing to set up.',
      bullets: [
        'Blocks dbt run, build, seed, snapshot, run-operation, retry, clone and --full-refresh on prod',
        'Blocks destructive SQL on prod: DROP, TRUNCATE, DELETE without WHERE, GRANT…',
        `Prod is the target "${prodTarget}" and every database a prod target points at`,
        'Claude cannot override a block: prod runs stay with you or your scheduler',
      ],
      preview: 'guard',
      tryIt: {
        label: 'see a block',
        prompt: `Show me the redshift-dbt-kit guard: run \`echo dbt run --target ${prodTarget}\`. It is only echo, so nothing runs even if it were allowed.`,
      },
    },
    {
      icon: '✻',
      title: 'Status line',
      tagline: 'Always know which target and database you are on.',
      bullets: ['Shown at the bottom of the screen', 'Follows the project you start Claude Code in, and each dbt write Claude runs'],
      preview: 'status',
    },
    {
      icon: '▦',
      title: 'dbt run board',
      tagline: 'Every dbt run at a glance: failures first, then the slowest models.',
      bullets: ['After each dbt run, build, test, seed or snapshot', 'A spinner while dbt runs, and a toast when a long run ends', 'Reopen it with /dbt-board'],
      preview: 'board',
      tryIt: { label: 'run a test', prompt: `Run \`dbt test ${devFlags}\` on one small model that has tests, and show me the run board.` },
    },
    {
      icon: '▤',
      title: 'Query results',
      tagline: 'Rows you can page through, with a chart per numeric column.',
      bullets: ['Fills after `dbt show --output json`: Claude queries this way on its own', 'Page with p and n; reopen it with /rs-results'],
      preview: 'results',
      tryIt: { label: 'query a table', prompt: `Ask me which table I want to look at, then show me 20 rows of it with \`dbt show ${devFlags} --output json --limit 20\`.` },
    },
    {
      icon: '🔍',
      title: 'Schema search',
      tagline: 'Does this field exist? Search every column as you type.',
      bullets: ['Exact column names get a ✓; press a row to put it in your prompt', 'Pick any target from your profiles.yml; prod ones are marked ⚠', 'Open it with /rs-schema'],
      preview: 'schema',
      tryIt: { label: 'open schema search', prompt: '/rs-schema' },
    },
    {
      icon: '◈',
      title: 'Model card',
      tagline: "A model's lineage, tests and docs, beside the code.",
      bullets: ['Shows when Claude reads or edits a model; reopen it with /dbt-model', 'Reads target/manifest.json: run dbt parse to refresh it'],
      preview: 'card',
      tryIt: { label: 'see a card', prompt: 'Open one of my dbt models and tell me what it does. I want to see its model card.' },
    },
    {
      icon: '💬',
      title: 'Ask Claude buttons',
      tagline: 'Ready-made prompts, one press away.',
      bullets: ['They fill your prompt box: you read and send them, nothing is sent on its own'],
      preview: 'buttons',
    },
    {
      icon: '⌘',
      title: 'Slash commands',
      tagline: 'Common jobs in one command.',
      bullets: ['/rs-profile <schema.table>: row count, nulls, distincts, min/max on dev', '/dbt-check [selector]: compile and test on dev, then a summary', '/kit: this tour and the setup check, any time'],
      preview: 'commands',
      tryIt: { label: 'profile a table', prompt: '/rs-profile ' },
    },
  ]
}

// The version `dbt --version` prints: `installed: 1.10.11`, or a bare version on old dbt.
export function dbtVersion(text: string): string | undefined {
  return text.match(/installed:\s*v?(\d+\.\d+\.\d+)/)?.[1] ?? text.match(/\b(\d+\.\d+\.\d+)\b/)?.[1]
}

// Made-up data the previews draw, so a new user sees each pane before running anything.
export const SAMPLE_BOARD: Board = {
  command: 'dbt build',
  elapsed: 43,
  rows: [
    { name: 'customers', status: 'error', seconds: 1.1, message: 'relation "raw.cust" does not exist' },
    { name: 'orders', status: 'success', seconds: 30.2, rowsAffected: 1200 },
    { name: 'payments', status: 'success', seconds: 9.8 },
    { name: 'not_null_orders_id', status: 'pass', seconds: 0.4 },
  ],
}

export const SAMPLE_RESULT: QueryResult = {
  id: 'dbt show · dev',
  columns: [
    { name: 'day', type: 'date' },
    { name: 'orders', type: 'numeric' },
    { name: 'revenue', type: 'numeric' },
  ],
  rows: Array.from({ length: 30 }, (_, i) => [
    `2026-10-${String(i + 1).padStart(2, '0')}`,
    String(Math.round(120 + i * 4 + 25 * Math.sin(i / 2))),
    String(Math.round(2400 + i * 90 + 500 * Math.sin(i / 2))),
  ]),
  total: 30,
}

export const SAMPLE_COLUMNS = [
  'mart.orders.customer_id\tinteger',
  'mart.orders.order_id\tbigint',
  'mart.customers.customer_id\tinteger',
  'staging.stg_orders.customer_name\tcharacter varying',
]
