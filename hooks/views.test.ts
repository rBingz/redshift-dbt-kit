import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { fakeDbt } from './fake-dbt'
import { conventions, improvePrompt, numericColumns, parseRunResults, parseStatementResult, sparkline, textTable } from './views'

// A dev build whose profile is named, so the guard resolves it through the fake dbt.
const DEV_BUILD = ['dbt', 'build', '--profile', 'shop', '--target', 'dev'].join(' ')

const RUN_RESULTS = JSON.stringify({
  metadata: { generated_at: '2026-10-10T12:00:00.123456Z' },
  elapsed_time: 42.5,
  results: [
    { unique_id: 'model.dw.orders', status: 'success', execution_time: 30.2, adapter_response: { rows_affected: 1200 } },
    { unique_id: 'model.dw.customers', status: 'error', execution_time: 1.1, message: 'relation "raw.cust" does not exist' },
    { unique_id: 'test.dw.not_null_orders_id.ab12', status: 'pass', execution_time: 0.4 },
  ],
})

const STATEMENT = JSON.stringify({
  ColumnMetadata: [
    { name: 'day', typeName: 'date' },
    { name: 'orders', typeName: 'int8' },
    { name: 'note', typeName: 'varchar' },
  ],
  Records: Array.from({ length: 30 }, (_, i) => [
    { stringValue: `2026-10-${String(i + 1).padStart(2, '0')}` },
    { longValue: 100 + i * 10 },
    i % 2 ? { isNull: true } : { stringValue: 'ok' },
  ]),
  TotalNumRows: 30,
})

const RESULT_CMD = 'aws redshift-data get-statement-result --id 7f3c-11aa'

// Beneath the plugin: env, clock, dbt, files, and a Bash that prints query JSON for get-statement-result.
function engine(on: On) {
  mock.env(on, { USERPROFILE: 'C:/home' })
  mock.clock(on)
  fakeDbt(on)
  on('fs.exists', () => ({ value: false }))
  on('fs.read', ($, e) =>
    e.path.replace(/\\/g, '/').endsWith('/target/run_results.json') ? { value: RUN_RESULTS }
    : e.path.endsWith('big.txt') ? { value: STATEMENT }
    : { deny: `ENOENT ${e.path}` },
  )
  // `--id big` prints more than Claude Code shows inline: a cut preview, the whole of it in a file.
  on('tool.call', { tool: 'Bash' }, ($, e) => ({
    result: e.command.includes('--id big')
      ? { stdout: STATEMENT.slice(0, 200), stderr: '', interrupted: false, persistedOutputPath: 'C:/session/tool-results/big.txt', persistedOutputSize: STATEMENT.length }
      : { stdout: e.command.includes('get-statement-result') ? STATEMENT : '', stderr: '', interrupted: false },
  }))
}

const pane = (requestId: string, title: string) => ({
  plugin: 'redshift-dbt-kit',
  component: 'Pane' as const,
  requestId,
  props: { title, isFocused: false, bodyColumns: 100, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 20 }, view: {} },
  viewport: { columns: 100, rows: 20 },
})

describe('view helpers', () => {
  test('parse run_results.json, skip a stale one', () => {
    const board = parseRunResults(RUN_RESULTS, 'dbt build', Date.parse('2026-10-10T11:59:00Z'))!
    expect(board.rows.map(r => r.name)).toEqual(['orders', 'customers', 'not_null_orders_id.ab12'])
    expect(board.rows[0]!.rowsAffected).toBe(1200)
    expect(parseRunResults(RUN_RESULTS, 'dbt build', Date.parse('2026-10-10T13:00:00Z'))).toBeUndefined()
  })

  test('parse get-statement-result, reject other output', () => {
    const result = parseStatementResult(STATEMENT, 'x')!
    expect(result.rows[0]).toEqual(['2026-10-01', '100', 'ok'])
    expect(result.rows[1]![2]).toBeNull()
    expect(numericColumns(result)).toEqual([1])
    expect(parseStatementResult('{"Id": "x"}', 'x')).toBeUndefined()
    expect(parseStatementResult('not json', 'x')).toBeUndefined()
  })

  test('table drops columns that do not fit; sparkline rises', () => {
    const result = parseStatementResult(STATEMENT, 'x')!
    const narrow = textTable(result, result.rows.slice(0, 2), 20)
    expect(narrow.hidden).toBe(1)
    expect(narrow.header).toBe('day         orders')
    expect(sparkline([1, 2, 3, 4, 5, 6, 7, 8], 8)).toBe('▁▂▃▄▅▆▇█')
    expect(sparkline([5, 5], 10)).toBe('▁▁')
  })
})

describe('panes', () => {
  test('dbt board shows chips, failures and slowest models', async ($, on) => {
    engine(on)
    await $.tool.call({ tool: 'Bash', command: DEV_BUILD })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ surface, ...pane('dbt-board', '✻ dbt run') })
      expect(await ui.find({ type: 'Text', text: /✻ dbt build · 43s · 1 success · 1 error · 1 pass/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /✗ customers relation "raw.cust" does not exist/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: / ERROR / })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /1,200 rows/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /running/ })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('dbt board spins while dbt runs', async ($, on) => {
    let during: string | undefined
    on('tool.call', { tool: 'Bash' }, async () => {
      const ui = await $.ui.mount({ surface: 'terminal', ...pane('dbt-board', '✻ dbt run') })
      during = (await ui.find({ type: 'Text', text: /dbt build running/ }))?.text
      await ui.unmount()
      return { result: { stdout: '', stderr: '', interrupted: false } }
    })
    engine(on) // after the hook above, so that hook answers Bash first
    await $.tool.call({ tool: 'Bash', command: DEV_BUILD })
    expect(during).toMatch(/^[·✢✳✶✻✽] dbt build running · \d+s$/)
  })

  test('query results: table, charts per surface, paging', async ($, on) => {
    engine(on)
    await $.tool.call({ tool: 'Bash', command: RESULT_CMD })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ surface, ...pane('rs-results', '✻ Query results') })
      expect(await ui.find({ type: 'Text', text: /✻ 30 rows · 3 columns · statement 7f3c-11aa/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /page 1\/\d/ })).toBeDefined()
      if (surface === 'terminal') expect(await ui.find({ type: 'Raster', key: 'chart-1' })).toBeDefined()
      else expect(await ui.find({ type: 'Text', text: /▁.*█/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^2026-10-01/ })).toBeDefined()
      await ui.press({ key: 'next' })
      expect(await ui.find({ type: 'Text', text: /page 2\/\d/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^2026-10-01/ })).toBeUndefined()
      await ui.press({ key: 'prev' })
      await ui.unmount()
    }
  })

  test('query results too big to show inline are read from the saved output', async ($, on) => {
    engine(on)
    await $.tool.call({ tool: 'Bash', command: 'aws redshift-data get-statement-result --id big' })
    const ui = await $.ui.mount({ surface: 'terminal', ...pane('rs-results', '✻ Query results') })
    expect(await ui.find({ type: 'Text', text: /✻ 30 rows · 3 columns · statement big/ })).toBeDefined()
  })

  test('panes say so before anything ran', async ($, on) => {
    engine(on)
    const ui = await $.ui.mount({ surface: 'terminal', ...pane('rs-results', '✻ Query results') })
    expect(await ui.find({ type: 'Text', text: /No query result yet/ })).toBeDefined()
  })
})

describe('ask Claude', () => {
  const filling = (on: On) => {
    const filled: { text: string; mode: string }[] = []
    on('prompt.fill', ($, e) => {
      filled.push({ text: e.text, mode: e.mode })
      return { isFilled: true }
    })
    return filled
  }

  test('a failed model on the board fills a fix prompt, after any draft', async ($, on) => {
    engine(on)
    const filled = filling(on)
    await $.tool.call({ tool: 'Bash', command: DEV_BUILD })
    const ui = await $.ui.mount({ surface: 'terminal', ...pane('dbt-board', '✻ dbt run') })
    await ui.press({ key: 'fix-customers' })
    expect(filled).toHaveLength(1)
    expect(filled[0]!.mode).toBe('append')
    expect(filled[0]!.text).toContain('`dbt build` failed on customers (error): relation "raw.cust" does not exist')
    expect(await ui.find({ type: 'Button', key: 'fix-orders' })).toBeUndefined() // only failures get one
  })

  test('the results pane fills an explain prompt', async ($, on) => {
    engine(on)
    const filled = filling(on)
    await $.tool.call({ tool: 'Bash', command: RESULT_CMD })
    const ui = await $.ui.mount({ surface: 'terminal', ...pane('rs-results', '✻ Query results') })
    await ui.press({ key: 'explain' })
    expect(filled[0]!.text).toContain('7f3c-11aa: 30 rows; columns day, orders, note')
  })

  test('the model card asks only for what is missing', () => {
    expect(improvePrompt({ name: 'orders', description: 'x', tests: ['t'], columns: 3, documented: 1 })).toBe(
      "dbt model orders is missing descriptions for its 2 undocumented columns. Add them to the model's .yml file, following how the project documents its other models.",
    )
    expect(improvePrompt({ name: 'orders', tests: [], columns: 0, documented: 0 })).toContain('a model description, tests')
    expect(improvePrompt({ name: 'orders', description: 'x', tests: ['t'], columns: 2, documented: 2 })).toBeUndefined()
  })

  test('the conventions end the system prompt, with the configured prod', { options: { prodDatabases: 'analytics, archive' } }, async ($, on) => {
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const }] }))
    const { sections } = await $.prompt.compose({
      model: 'claude-opus-5-5',
      promptModel: 'claude-opus-5-5',
      surfaces: ['terminal'],
      tools: ['Bash'],
      outputStyle: { name: 'default', isKeepingCodingInstructions: true },
      traits: [],
    })
    expect(sections.map(s => s.id)).toEqual(['intro', 'redshift-dbt-kit:conventions'])
    expect(sections[1]!.scope).toBe('session')
    expect(sections[1]!.text).toContain('Prod is the target `prod` and the database it points at, plus database `analytics` and `archive`.')
    expect(conventions([], 'prod')).toContain('- Prod is the target `prod` and the database it points at. Any target')
  })
})
