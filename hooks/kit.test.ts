import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { PROFILES_YML, fakeDbt } from './fake-dbt'
import { dbtVersion, tourPages } from './kit'

const OK = { exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
const DBT_VERSION = 'Core:\n  - installed: 1.10.11\n  - latest:    1.10.11 - Up to date!\n\nPlugins:\n  - redshift: 1.9.5\n'
const RUN_KIT = { command: 'kit', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } }
const START = { cwd: '.', surface: 'terminal' as const, isInteractive: true }

// A teammate's machine: shop and billing profiles (billing.dev writes to the prod database, and
// shop.dev logs in as prod's user), started in the shop project. `dbtWorks: false` has no dbt on PATH.
function engine(on: On, opts: { dbtWorks?: boolean } = {}) {
  const seen = { toasts: [] as string[], opened: [] as string[], filled: [] as string[], closed: [] as string[] }
  mock.env(on, { USERPROFILE: 'C:/home' })
  mock.clock(on)
  mock.store(on)
  fakeDbt(on)
  on('process.run', ($, e) => (e.argv[0] === 'dbt' && opts.dbtWorks !== false ? { value: { ...OK, stdout: DBT_VERSION } } : { deny: `spawn ${e.argv[0]} ENOENT` }))
  on('fs.exists', () => ({ value: false }))
  on('fs.stat', ($, e) => (e.path.endsWith('manifest.json') ? { deny: 'ENOENT' } : { value: { kind: 'file' as const, size: 100, mtimeMs: 1, isLink: false } }))
  on('fs.read', ($, e) => {
    const path = e.path.replace(/\\/g, '/')
    if (path.endsWith('/home/.dbt/profiles.yml')) return { value: PROFILES_YML }
    if (path.endsWith('dbt_project.yml')) return { value: 'name: shop\nprofile: shop\n' }
    return { deny: `ENOENT ${path}` }
  })
  on('ui.open', ($, e) => {
    seen.opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    seen.closed.push(e.id)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.fill', ($, e) => {
    seen.filled.push(e.text)
    return { isFilled: true }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  return seen
}

const pane = {
  plugin: 'redshift-dbt-kit',
  component: 'Pane' as const,
  requestId: 'kit',
  props: { title: '✻ redshift-dbt-kit', isFocused: true, bodyColumns: 100, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} },
  viewport: { columns: 100, rows: 30 },
}

describe('tour content', () => {
  test('try-it prompts use the dev target found, and never run anything on prod', () => {
    const pages = tourPages('prod', { profile: 'shop', target: 'dev' })
    expect(pages.map(p => p.title)).toEqual(['Guard', 'Status line', 'dbt run board', 'Query results', 'Schema search', 'Model card', 'Ask Claude buttons', 'Slash commands'])
    expect(pages[0]!.tryIt!.prompt).toContain('`echo dbt run --target prod`')
    expect(pages[2]!.tryIt!.prompt).toContain('dbt test --profile shop --target dev')
    expect(tourPages('live')[3]!.tryIt!.prompt).toContain('--target <your dev target>')
  })

  test('dbt --version', () => {
    expect(dbtVersion(DBT_VERSION)).toBe('1.10.11')
    expect(dbtVersion('installed version: 0.21.0')).toBe('0.21.0')
    expect(dbtVersion('command not found')).toBeUndefined()
  })
})

describe('/kit', () => {
  test('the first session after install opens the tour, once', async ($, on) => {
    const seen = engine(on)
    await $.session.start(START)
    await $.session.start(START)
    expect(seen.opened).toEqual(['kit'])
    expect(seen.toasts.filter(t => t.includes('installed'))).toEqual(['✻ redshift-dbt-kit is installed: a short tour is open beside the chat.'])
  })

  test('the setup check says what is set up, and how to fix what is not', async ($, on) => {
    engine(on)
    await $.command.run(RUN_KIT)
    const ui = await $.ui.mount({ surface: 'terminal', ...pane })
    // Each row: the chip and label, then the detail beside them.
    expect(await ui.find({ type: 'Text', text: /OK\s+dbt\s*$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^dbt 1\.10\.11 on PATH$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^C:\/home\/\.dbt\/profiles\.yml: 2 profiles, 4 targets$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^started in a dbt project \(profile shop\)$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /WARN\s+prod\s*$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^analytics \(targets shop\.prod, billing\.dev\)$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^billing\.dev points at a prod database/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /WARN\s+logins\s*$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^shop\.dev logs in as alice, the same user as shop\.prod/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /OK\s+Python\s*$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^not needed/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /4 ok · 2 to look at/ })).toBeDefined()
  })

  test('with no dbt on PATH, it says how to fix that', async ($, on) => {
    engine(on, { dbtWorks: false })
    await $.command.run(RUN_KIT)
    const ui = await $.ui.mount({ surface: 'terminal', ...pane })
    expect(await ui.find({ type: 'Text', text: /FAIL\s+dbt\s*$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^dbt did not start/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Install dbt, or start Claude Code from a terminal where dbt works/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /FAIL\s+prod\s*$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^needs dbt/ })).toBeDefined()
  })

  test('next walks through each feature; try it fills the prompt for the person to send', async ($, on) => {
    const seen = engine(on)
    await $.command.run(RUN_KIT)
    const ui = await $.ui.mount({ surface: 'terminal', ...pane })
    await ui.press({ key: 'next' })
    expect(await ui.find({ type: 'Text', text: /2\/9$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /🛡 Guard/ })).toBeDefined()
    await ui.press({ key: 'try' })
    expect(seen.filled).toEqual([expect.stringContaining('`echo dbt run --target prod`')])
    await ui.press({ key: 'next' })
    await ui.press({ key: 'next' })
    expect(await ui.find({ type: 'Text', text: /▦ dbt run board/ })).toBeDefined()
    await ui.press({ key: 'try' })
    expect(seen.filled[1]).toContain('dbt test --profile shop --target dev')
    await ui.press({ key: 'back' })
    expect(await ui.find({ type: 'Text', text: /✻ Status line/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'try' })).toBeUndefined() // nothing to try there
  })

  test('the close button closes the pane', async ($, on) => {
    const seen = engine(on)
    await $.command.run(RUN_KIT)
    const ui = await $.ui.mount({ surface: 'terminal', ...pane })
    await ui.press({ key: 'close' })
    expect(seen.closed).toEqual(['kit'])
  })

  test('every page draws its preview, on every surface', async ($, on) => {
    engine(on)
    await $.command.run(RUN_KIT)
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ surface, ...pane })
      for (let i = 0; i < 9; i++) await ui.press({ key: 'back' }) // the page is shared state: back to the start
      expect(await ui.find({ type: 'Text', text: /1\/9$/ })).toBeDefined()
      for (const title of ['Guard', 'Status line', 'dbt run board', 'Query results', 'Schema search', 'Model card', 'Ask Claude buttons', 'Slash commands']) {
        await ui.press({ key: 'next' })
        expect(await ui.find({ type: 'Text', text: new RegExp(` ${title}$`) })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: /preview · sample data/ })).toBeDefined()
      }
      if (surface === 'terminal') {
        await ui.press({ key: 'back' })
        await ui.press({ key: 'back' })
        await ui.press({ key: 'back' })
        await ui.press({ key: 'back' })
        expect(await ui.find({ type: 'Raster', key: 'kit-chart' })).toBeDefined() // Query results' chart
      }
      await ui.unmount()
    }
  })
})
