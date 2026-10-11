import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { PROFILES_YML, fakeDbt } from './fake-dbt'

const OK = { exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
const RUN_RESULTS = JSON.stringify({ metadata: { generated_at: '2026-10-10T12:00:00.123456Z' }, elapsed_time: 42.5, results: [
  { unique_id: 'model.dw.orders_with_a_long_model_name', status: 'success', execution_time: 30.2, adapter_response: { rows_affected: 1200 } },
  { unique_id: 'model.dw.customers', status: 'error', execution_time: 1.1, message: 'relation "raw.cust" does not exist and this message is long' },
  { unique_id: 'test.dw.not_null_orders_id.ab12', status: 'pass', execution_time: 0.4 } ] })
const SHOW = `x\n${JSON.stringify({ show: Array.from({ length: 30 }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, '0')}`, orders: 100 + i * 10, customer_name: 'a long customer name here' })) }, null, 2)}\n`

function engine(on: On) {
  mock.env(on, { USERPROFILE: 'C:/home' })
  mock.clock(on)
  mock.store(on)
  fakeDbt(on)
  on('process.run', () => ({ value: { ...OK, stdout: 'installed: 1.10.11' } }))
  on('fs.exists', () => ({ value: false }))
  on('fs.stat', ($, e) => (e.path.endsWith('manifest.json') ? { deny: 'ENOENT' } : { value: { kind: 'file' as const, size: 100, mtimeMs: 1, isLink: false } }))
  on('fs.read', ($, e) => {
    const p = e.path.split('\\').join('/')
    if (p.endsWith('/home/.dbt/profiles.yml')) return { value: PROFILES_YML }
    if (p.endsWith('dbt_project.yml')) return { value: 'name: shop\nprofile: shop\n' }
    if (p.endsWith('run_results.json')) return { value: RUN_RESULTS }
    return { deny: 'ENOENT' }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.call', { tool: 'Bash' }, ($, e) => ({ result: { stdout: e.command.includes('dbt show') ? SHOW : '', stderr: '', interrupted: false } }))
}

const paneAt = (requestId: string, columns: number) => ({
  plugin: 'redshift-dbt-kit',
  component: 'Pane' as const,
  requestId,
  props: { title: requestId, isFocused: true, bodyColumns: columns, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 20 }, view: {} },
  viewport: { columns, rows: 24 },
})

// Narrow panes: widths the mod works out (bars, tables, charts) must never go negative and throw.
describe('narrow panes', () => {
  test('every pane, and every tour page, draws from 20 columns up', async ($, on) => {
    engine(on)
    await $.command.run({ command: 'kit', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } })
    await $.tool.call({ tool: 'Bash', command: 'dbt build --profile shop --target dev' })
    await $.tool.call({ tool: 'Bash', command: 'dbt show --target dev --output json --inline "select * from t order by day"' })
    for (const columns of [20, 30, 45, 60]) {
      for (const id of ['dbt-board', 'rs-results']) {
        const ui = await $.ui.mount({ surface: 'terminal', ...paneAt(id, columns) })
        expect(await ui.find({ type: 'Button', key: 'close' })).toBeDefined()
        await ui.unmount()
      }
      const ui = await $.ui.mount({ surface: 'terminal', ...paneAt('kit', columns) })
      for (let page = 0; page < 9; page++) {
        expect(await ui.find({ type: 'Button', key: 'close' })).toBeDefined()
        await ui.press({ key: 'next' })
      }
      await ui.unmount()
    }
  })
})
