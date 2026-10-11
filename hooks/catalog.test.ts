import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { ago, modelCard, modelPath, parseDbtShow, searchCatalog } from './catalog'
import { PROFILES_YML, fakeDbt } from './fake-dbt'
import type { Manifest } from './catalog'

const COLUMNS = [
  'mart.orders.customer_id\tinteger',
  'mart.orders.order_id\tbigint',
  'mart.customers.customer_id\tinteger',
  'raw.customer_events.payload\tsuper',
]

const MANIFEST: Manifest = {
  metadata: { generated_at: '2026-10-10T12:00:00.000000Z' },
  nodes: {
    'model.dw.orders': {
      name: 'orders',
      resource_type: 'model',
      description: 'One row per order.',
      relation_name: '"dw"."mart"."orders"',
      config: { materialized: 'incremental' },
      tags: ['daily'],
      depends_on: { nodes: ['model.dw.stg_orders', 'source.dw.raw.payments'] },
      columns: { order_id: { description: 'PK' }, customer_id: { description: '' } },
    },
    'model.dw.stg_orders': { name: 'stg_orders', resource_type: 'model' },
    'test.dw.unique_orders_order_id.ab12': { name: 'unique_orders_order_id', resource_type: 'test' },
  },
  child_map: { 'model.dw.orders': ['model.dw.fct_revenue', 'test.dw.unique_orders_order_id.ab12'] },
}

const PROJECT = 'C:/work/dw'
const OK = { exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
// dbt show prints a log line, then the JSON, as dbt can.
const SHOW = `12:00:00  Running with dbt=1.10.11\n${JSON.stringify({ show: COLUMNS.map(c => ({ c })) }, null, 2)}\n`
const RUN_SCHEMA = { command: 'rs-schema', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } }

// Beneath the plugin: env, clock, dbt, profiles.yml, the dbt project's files, prompt fills and plain tool answers.
// `manifestSize` over 4 MiB sends the card through runner/model_card.py, where only `py` works:
// `python3` is a stub that says Python is missing, and `python` is not there at all.
function engine(on: On, filled: string[] = [], runs: string[][] = [], dbtSays = { exitCode: 0, stdout: SHOW }, manifestSize = 2048) {
  mock.env(on, { USERPROFILE: 'C:/home' })
  mock.clock(on)
  mock.store(on)
  fakeDbt(on)
  on('process.run', ($, e) => {
    runs.push([...e.argv])
    if (!e.argv[1]?.endsWith('/runner/model_card.py')) return { value: { ...OK, ...dbtSays } }
    if (e.argv[0] === 'python3') return { value: { ...OK, exitCode: 9009, stdout: '', stderr: 'Python was not found' } }
    if (e.argv[0] === 'python') return { deny: 'spawn python ENOENT' }
    return { value: { ...OK, stdout: JSON.stringify(MANIFEST) } }
  })
  on('fs.exists', ($, e) => ({ value: e.path.replace(/\\/g, '/').startsWith(PROJECT) }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: manifestSize, mtimeMs: 1, isLink: false } }))
  on('fs.read', ($, e) => {
    const path = e.path.replace(/\\/g, '/')
    if (path.endsWith('manifest.json')) return { value: JSON.stringify(MANIFEST) }
    if (path.endsWith('/home/.dbt/profiles.yml')) return { value: PROFILES_YML }
    return { deny: 'ENOENT' }
  })
  on('prompt.fill', ($, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', () => ({ result: {} }))
}

const pane = (requestId: string, title: string) => ({
  plugin: 'redshift-dbt-guard',
  component: 'Pane' as const,
  requestId,
  props: { title, isFocused: true, bodyColumns: 100, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 20 }, view: {} },
  viewport: { columns: 100, rows: 24 },
})

describe('catalog helpers', () => {
  test('search needs every term, puts exact column names first, marks hits', () => {
    const { total, matches } = searchCatalog(COLUMNS, 'cust id', 10)
    expect(total).toBe(2)
    expect(matches.map(m => m.name)).toEqual(['mart.orders.customer_id', 'mart.customers.customer_id'])
    expect(searchCatalog(COLUMNS, 'customer_id', 10).matches.every(m => m.isExact)).toBe(true)
    expect(searchCatalog(COLUMNS, 'payload', 10).matches[0]!.parts).toEqual([
      { text: 'raw.customer_events.', isHit: false },
      { text: 'payload', isHit: true },
    ])
    expect(searchCatalog(COLUMNS, 'nope', 10).total).toBe(0)
    expect(searchCatalog(COLUMNS, '   ', 10).total).toBe(0)
  })

  test('dbt show output: JSON after log lines', () => {
    expect(parseDbtShow(SHOW)?.length).toBe(4)
    // dbt 1.10 prints a deprecation summary after the JSON.
    expect(parseDbtShow(`${SHOW}\x1b[0m13:15:53  [WARNING][DeprecationsSummary]: Deprecated functionality\nSummary: {x}\n`)?.length).toBe(4)
    expect(parseDbtShow('Runtime Error\n  boom')).toBeUndefined()
  })

  test('model card from the manifest', () => {
    const card = modelCard(MANIFEST, 'orders')
    expect(card).toMatchObject({
      materialized: 'incremental',
      upstream: ['stg_orders', 'src:raw.payments'],
      downstream: ['fct_revenue'],
      tests: ['unique_orders_order_id'],
      columns: 2,
      documented: 1,
    })
    expect(modelCard(MANIFEST, 'missing').error).toContain('dbt parse')
  })

  test('model paths and ages', () => {
    expect(modelPath('C:\\work\\dw\\models\\marts\\orders.sql')).toEqual({ project: 'C:/work/dw', name: 'orders' })
    expect(modelPath('C:/work/dw/macros/x.sql')).toBeUndefined()
    expect(ago(30_000)).toBe('just now')
    expect(ago(3 * 3_600_000)).toBe('3h ago')
  })
})

describe('schema pane', () => {
  test('loads columns through dbt, searches, inserts a row into the prompt', async ($, on) => {
    const filled: string[] = []
    const runs: string[][] = []
    engine(on, filled, runs)
    await $.command.run(RUN_SCHEMA)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ surface, ...pane('rs-schema', '✻ Schema') })
      expect(await ui.find({ type: 'Text', text: /✻ Schema · 4 columns · shop\.dev \(dev_alice\)/ })).toBeDefined()
      await ui.input({ key: 'q', text: 'orders cust', kind: 'change' })
      expect(await ui.find({ type: 'Text', text: /^1 matches$/ })).toBeDefined()
      await ui.press({ key: 'mart.orders.customer_id' })
      await ui.input({ key: 'q', text: 'nope', kind: 'change' })
      expect(await ui.find({ type: 'Text', text: /no column matches "nope"/ })).toBeDefined()
      await ui.input({ key: 'q', text: '', kind: 'change' })
      await ui.unmount()
    }
    expect(filled).toEqual(['mart.orders.customer_id', 'mart.orders.customer_id'])
    expect(runs[0]).toEqual(expect.arrayContaining(['dbt', 'show', '--profile', 'shop', '--target', 'dev', '--output', 'json']))
  })

  test('the target picker lists profiles.yml targets and loads the one picked', async ($, on) => {
    const runs: string[][] = []
    engine(on, [], runs)
    await $.command.run(RUN_SCHEMA)
    const ui = await $.ui.mount({ surface: 'terminal', ...pane('rs-schema', '✻ Schema') })
    // Databases fill in behind the pane as dbt resolves each target.
    let labels = ''
    for (let i = 0; i < 50 && !labels.includes('billing.dev'); i++) {
      await ui.redraw()
      labels = JSON.stringify((await ui.find({ type: 'Select', key: 'env' }))?.props.options)
    }
    expect(labels).toContain('shop.dev · dev_alice')
    expect(labels).toContain('⚠ shop.prod · analytics')
    expect(labels).toContain('⚠ billing.dev · analytics')
    await ui.select({ key: 'env', value: 'shop.prod' })
    expect(await ui.find({ type: 'Text', text: /shop\.prod \(analytics\)/ })).toBeDefined()
    expect(runs.at(-1)).toEqual(expect.arrayContaining(['--profile', 'shop', '--target', 'prod']))
  })

  test('the store keeps only the newest catalog, so it never fills up', async ($, on) => {
    const runs: string[][] = []
    engine(on, [], runs)
    await $.command.run(RUN_SCHEMA) // shop.dev
    const ui = await $.ui.mount({ surface: 'terminal', ...pane('rs-schema', '✻ Schema') })
    await ui.select({ key: 'env', value: 'shop.prod' })
    await ui.select({ key: 'env', value: 'shop.prod' }) // still the newest: served from the store
    expect(runs).toHaveLength(2)
    await ui.select({ key: 'env', value: 'shop.dev' }) // dropped when shop.prod was saved: asked again
    expect(runs).toHaveLength(3)
  })

  test('says what dbt said when dbt show fails', async ($, on) => {
    engine(on, [], [], { exitCode: 1, stdout: 'Runtime Error\n  Could not find profile named shop' })
    await $.command.run(RUN_SCHEMA)
    const ui = await $.ui.mount({ surface: 'terminal', ...pane('rs-schema', '✻ Schema') })
    expect(await ui.find({ type: 'Text', text: /✗ dbt show failed: Runtime Error Could not find profile named shop/ })).toBeDefined()
  })
})

describe('model card pane', () => {
  test('an edit of a model shows its card', async ($, on) => {
    engine(on)
    await $.tool.call({ tool: 'Edit', file_path: `${PROJECT}/models/marts/orders.sql`, old_string: 'a', new_string: 'b' })
    const ui = await $.ui.mount({ surface: 'terminal', ...pane('dbt-model', '✻ dbt model') })
    expect(await ui.find({ type: 'Text', text: /✻ orders · incremental · "dw"."mart"."orders"/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /One row per order/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /stg_orders, src:raw.payments/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 downstream: fct_revenue/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1\/2 columns documented/ })).toBeDefined()
  })

  test('a manifest over 4 MiB is read through Python, the first one that works kept', async ($, on) => {
    const runs: string[][] = []
    engine(on, [], runs, undefined, 5 * 1024 * 1024)
    await $.tool.call({ tool: 'Edit', file_path: `${PROJECT}/models/marts/orders.sql`, old_string: 'a', new_string: 'b' })
    const ui = await $.ui.mount({ surface: 'terminal', ...pane('dbt-model', '✻ dbt model') })
    expect(await ui.find({ type: 'Text', text: /1 downstream: fct_revenue/ })).toBeDefined()
    expect(runs.map(r => r[0])).toEqual(['python3', 'python', 'py'])
    expect(runs[2]!.slice(2)).toEqual([`${PROJECT}/target/manifest.json`, 'orders'])
    await $.tool.call({ tool: 'Read', file_path: `${PROJECT}/models/marts/customers.sql` })
    expect(runs.map(r => r[0])).toEqual(['python3', 'python', 'py', 'py'])
  })

  test('a model missing from the manifest says what to run', async ($, on) => {
    engine(on)
    await $.tool.call({ tool: 'Read', file_path: `${PROJECT}/models/new_model.sql` })
    const ui = await $.ui.mount({ surface: 'terminal', ...pane('dbt-model', '✻ dbt model') })
    expect(await ui.find({ type: 'Text', text: /✗ not in target\/manifest.json yet/ })).toBeDefined()
  })

  test('files outside a dbt project leave the card alone', async ($, on) => {
    engine(on)
    await $.tool.call({ tool: 'Read', file_path: 'C:/elsewhere/models/x.sql' })
    const ui = await $.ui.mount({ surface: 'terminal', ...pane('dbt-model', '✻ dbt model') })
    expect(await ui.find({ type: 'Text', text: /No dbt model yet/ })).toBeDefined()
  })
})
