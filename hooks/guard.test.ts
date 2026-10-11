import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

import { PROFILES_YML, fakeDbt } from './fake-dbt'
import { dbtCalls, destructiveSql, listProfiles, parseResolved, shellParts, sqlCalls } from './guard'

const FILES: Record<string, string> = {
  'home/.dbt/profiles.yml': PROFILES_YML,
  'shop/dbt_project.yml': 'name: shop\nprofile: shop\n',
  'billing/dbt_project.yml': "name: billing\nprofile: 'billing' # billing\n",
  'cleanup.sql': 'select 1;\ndrop table staging.orders;',
  'report.sql': 'select count(*) from mart.orders;',
}

// Stand in for the engine beneath the plugin: files, env, clock, dbt, and shells that always succeed.
// `mtime` is profiles.yml's last change, for the cache tests.
function engine(on: On, opts: { calls?: string[][]; withDbt?: boolean; mtime?: { value: number }; profiles?: string } = {}) {
  const files: Record<string, string> = { ...FILES, ...(opts.profiles === undefined ? {} : { 'home/.dbt/profiles.yml': opts.profiles }) }
  mock.env(on, { USERPROFILE: 'C:/home' })
  mock.clock(on)
  if (opts.withDbt !== false) fakeDbt(on, opts.calls)
  const find = (path: string) => Object.keys(files).find(k => path.replace(/\\/g, '/').endsWith(`/${k}`))
  on('fs.exists', ($, e) => ({ value: find(e.path) !== undefined }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 100, mtimeMs: opts.mtime?.value ?? 1, isLink: false } }))
  on('fs.read', ($, e) => {
    const key = find(e.path)
    return key === undefined ? { deny: `ENOENT ${e.path}` } : { value: files[key]! }
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
  on('tool.call', { tool: 'PowerShell' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
}

const bash = ($: Engine, command: string) => $.tool.call({ tool: 'Bash', command })
const denied = async ($: Engine, command: string) => (await bash($, command)).deny

describe('pure checks', () => {
  test('destructive SQL', () => {
    expect(destructiveSql('DROP TABLE x')).toBe('DROP')
    expect(destructiveSql('truncate staging.orders')).toBe('TRUNCATE')
    expect(destructiveSql('delete from x')).toBe('DELETE/UPDATE without WHERE')
    expect(destructiveSql('update x set a = 1')).toBe('DELETE/UPDATE without WHERE')
    expect(destructiveSql('alter table x drop column y')).toBe('ALTER TABLE ... DROP')
    expect(destructiveSql('grant select on x to y')).toBe('GRANT/REVOKE')
    expect(destructiveSql('delete from x where id = 1')).toBeUndefined()
    expect(destructiveSql('select last_updated, deleted_at from x')).toBeUndefined()
  })

  test('shell parts: separators split, quotes hold', () => {
    expect(shellParts(`cd a && dbt run; echo "x; y" | grep 'dbt run'\nls`)).toEqual([
      ['cd', 'a'],
      ['dbt', 'run'],
      ['echo', 'x; y'],
      ['grep', 'dbt run'],
      ['ls'],
    ])
    expect(shellParts('rows=$(dbt run --target prod); echo `dbt seed`')).toEqual([['rows=$'], ['dbt', 'run', '--target', 'prod'], ['echo'], ['dbt', 'seed']])
  })

  test('subshells and flag values', () => {
    expect(dbtCalls('rows=$(dbt run --target prod)')[0]).toMatchObject({ verb: 'run', isWrite: true, target: 'prod' })
    expect(dbtCalls('dbt ls --resource-type seed --target prod')[0]).toMatchObject({ verb: 'ls', isWrite: false })
    expect(dbtCalls('dbt test --select run')[0]!.isWrite).toBe(false)
    expect(dbtCalls('dbt --debug run')[0]!.isWrite).toBe(true) // a flag with no value hides nothing
    // A folder or target set from a subshell is unknown, never the session's own.
    expect(dbtCalls('Set-Location (Join-Path $root shop); dbt run')[0]!.cwd).toBeUndefined()
    expect(dbtCalls(`$env:DBT_TARGET = (Get-Content t.txt); dbt run`)[0]!.target).toBe('$')
    expect(dbtCalls('DBT_TARGET=$(cat .target) dbt run')[0]!.target).toBe('$')
    // Inside double quotes a substitution still runs; inside single quotes it is text.
    expect(dbtCalls('cd shop && out="$(dbt run --target prod)"')[0]).toMatchObject({ isWrite: true, target: 'prod', cwd: 'shop' })
    expect(dbtCalls('echo "rows: `dbt seed --target prod`"')[0]).toMatchObject({ isWrite: true, target: 'prod' })
    expect(dbtCalls('DBT_TARGET="$(cat .target)" dbt run')[0]!.target).toBe('$')
    expect(dbtCalls(`echo '$(dbt run --target prod)'`)).toEqual([])
  })

  test('every dbt call is found, wherever flags and chains put it', () => {
    expect(dbtCalls('dbt test --target dev && dbt run --target prod').map(c => [c.verb, c.isWrite, c.target])).toEqual([
      ['test', false, 'dev'],
      ['run', true, 'prod'],
    ])
    expect(dbtCalls('dbt --log-level info run -t prod')[0]).toMatchObject({ verb: 'run', isWrite: true, target: 'prod' })
    expect(dbtCalls('dbt --log-level debug test')[0]).toMatchObject({ verb: 'test', isWrite: false })
    expect(dbtCalls('dbt retry')[0]!.isWrite).toBe(true)
    expect(dbtCalls('dbt clone --state prod-artifacts')[0]!.isWrite).toBe(true)
    expect(dbtCalls('uv run dbt build -f')[0]).toMatchObject({ verb: 'build', fullRefresh: true })
    expect(dbtCalls('C:/venv/Scripts/dbt.exe seed')[0]!.isWrite).toBe(true)
    expect(dbtCalls('dbt test --select run_log --vars "{run: 1}"')[0]!.isWrite).toBe(false)
    expect(dbtCalls(`grep "dbt run --target prod" notes.md`)).toEqual([])
    expect(dbtCalls(`dbt show --inline "select 1 from t" --target dev`)[0]).toMatchObject({ hasShow: true, inlineSql: 'select 1 from t' })
  })

  test('DBT_* variables set in the command count as flags', () => {
    expect(dbtCalls('DBT_TARGET=prod dbt run')[0]!.target).toBe('prod')
    expect(dbtCalls('env DBT_PROFILE=billing dbt run')[0]!.profile).toBe('billing')
    expect(dbtCalls('export DBT_TARGET=prod && dbt run')[0]!.target).toBe('prod')
    expect(dbtCalls(`$env:DBT_TARGET = 'prod'; dbt run`)[0]!.target).toBe('prod')
    expect(dbtCalls(`$env:dbt_profiles_dir="ci"; dbt run`)[0]!.profilesDir).toBe('ci')
    expect(dbtCalls('DBT_FULL_REFRESH=true dbt run')[0]!.fullRefresh).toBe(true)
    expect(dbtCalls('DBT_TARGET=prod echo; dbt run')[0]!.target).toBeUndefined() // inline is for its own part only
    expect(dbtCalls('dbt run --target dev')[0]!.target).toBe('dev')
  })

  test('the folder a dbt call runs in', () => {
    expect(dbtCalls('cd ../billing; dbt run')[0]!.cwd).toBe('../billing')
    expect(dbtCalls('cd a && cd b && dbt run')[0]!.cwd).toBe('a/b')
    expect(dbtCalls('cd a\ndbt run')[0]!.cwd).toBe('a')
    expect(dbtCalls('Set-Location C:/work/billing; dbt run')[0]!.cwd).toBe('C:/work/billing')
    expect(dbtCalls('pushd a && popd && dbt run')[0]!.cwd).toBeUndefined()
    expect(dbtCalls('cd proj && dbt run --profiles-dir . --project-dir sub')[0]).toMatchObject({ profilesDir: 'proj/.', projectDir: 'proj/sub' })
  })

  test('SQL sent straight to Redshift names its database', () => {
    expect(sqlCalls('aws redshift-data execute-statement --workgroup-name wg --database analytics --sql "drop table x"')).toEqual([
      { tool: 'aws redshift-data', database: 'analytics', sql: 'drop table x', files: [] },
    ])
    expect(sqlCalls('cd sql && aws redshift-data execute-statement --database dev --sql file://cleanup.sql')[0]!.files).toEqual(['sql/cleanup.sql'])
    expect(sqlCalls('psql -h host -d analytics -c "truncate t"')[0]).toMatchObject({ tool: 'psql', database: 'analytics', sql: 'truncate t' })
    expect(sqlCalls('psql postgresql://u@host:5439/analytics -f cleanup.sql')[0]).toMatchObject({ database: 'analytics', files: ['cleanup.sql'] })
    expect(sqlCalls('aws redshift-data get-statement-result --id x')).toEqual([])
    expect(sqlCalls('cd sql && psql -d analytics < cleanup.sql')[0]!.files).toEqual(['sql/cleanup.sql'])
    expect(sqlCalls('psql -d analytics <cleanup.sql')[0]!.files).toEqual(['cleanup.sql'])
    expect(sqlCalls('psql -d analytics<cleanup.sql')[0]).toMatchObject({ database: 'analytics', files: ['cleanup.sql'] })
    expect(sqlCalls('psql -d analytics <<EOF')[0]!.files).toEqual([])
  })

  test('profiles.yml names: anchors, merges, Jinja and quoting do not get in the way', () => {
    expect(listProfiles(PROFILES_YML)).toEqual({ shop: ['dev', 'bobdev', 'prod'], billing: ['dev'] })
    expect(listProfiles('"my-profile":\n  outputs:\n    "ci":\n      type: postgres\nconfig:\n  partial_parse: true\n')).toEqual({ 'my-profile': ['ci'] })
  })

  test("dbt's resolved line", () => {
    expect(parseResolved('noise\nDBTGUARD {"profile": "shop", "target": "prod", "db": "analytics"}\nmore')).toEqual({ profile: 'shop', target: 'prod', dbname: 'analytics' })
    expect(parseResolved('DBTGUARD {"profile": "x", "target": "ci", "db": null}')).toEqual({ profile: 'x', target: 'ci', dbname: undefined })
    expect(parseResolved('Runtime Error')).toBeUndefined()
  })
})

describe('guard on SQL sent straight to Redshift', () => {
  const AWS = 'aws redshift-data execute-statement --workgroup-name wg'

  test('blocks destructive SQL on a prod database, inline and in files', async ($, on) => {
    engine(on)
    expect(await denied($, `${AWS} --database analytics --sql "drop table staging.orders"`)).toContain('DROP through aws redshift-data on prod database analytics')
    expect(await denied($, `${AWS} --database analytics --sql file://cleanup.sql`)).toContain('DROP')
    expect(await denied($, `${AWS} --database analytics --sql file://missing.sql`)).toContain('guard failed')
    expect(await denied($, 'psql -d analytics -c "delete from mart.orders"')).toContain('psql on prod database analytics')
    expect(await denied($, 'psql -d analytics < cleanup.sql')).toContain('DROP through psql on prod database analytics')
    expect(await denied($, 'cd shop && out="$(dbt run --target prod)"')).toContain('dbt run against shop.prod')
    expect(await denied($, 'cd shop && DBT_TARGET=$(cat .target) dbt run')).toContain("does not have a target named '$'")
    expect(await denied($, `${AWS} --sql "truncate x"`)).toContain('with no database named')
  })

  test('lets safe SQL and dev databases through', async ($, on) => {
    engine(on)
    expect(await denied($, `${AWS} --database analytics --sql "select * from mart.orders"`)).toBeUndefined()
    expect(await denied($, `${AWS} --database analytics --sql "delete from x where id = 1"`)).toBeUndefined()
    expect(await denied($, `${AWS} --database analytics --sql file://report.sql`)).toBeUndefined()
    expect(await denied($, `${AWS} --database dev_alice --sql "drop table staging.orders"`)).toBeUndefined()
  })
})

describe('guard on dbt', () => {
  test('prod is the database dbt resolves for the target, whatever the target is called', async ($, on) => {
    engine(on)
    expect(await denied($, 'cd shop && dbt run --target prod')).toContain('dbt run against shop.prod (database analytics)')
    expect(await denied($, 'cd billing && dbt run')).toContain('billing.dev (database analytics)')
    expect(await denied($, 'dbt build --profile billing --target dev')).toContain('billing.dev')
    expect(await denied($, 'cd shop && dbt run')).toBeUndefined()
    expect(await denied($, 'dbt run --profile shop --target dev')).toBeUndefined()
    // No project to name the profile: every profile with that target counts, and billing's dev is prod.
    expect(await denied($, 'dbt run --target dev')).toContain('billing.dev')
    expect(await denied($, 'dbt run --target bobdev')).toBeUndefined()
  })

  test('the bypasses the audit found are blocked', async ($, on) => {
    engine(on)
    expect(await denied($, 'cd shop && dbt test --target dev && dbt run --target prod')).toContain('shop.prod')
    expect(await denied($, 'cd shop && dbt --log-level info run --target prod')).toContain('shop.prod')
    expect(await denied($, 'cd shop && dbt retry --target prod')).toContain('dbt retry against shop.prod')
    expect(await denied($, 'cd shop && dbt clone --target prod')).toContain('dbt clone against shop.prod')
    expect(await denied($, 'cd shop && DBT_TARGET=prod dbt run')).toContain('shop.prod')
    expect(await denied($, 'export DBT_TARGET=prod && cd shop && dbt run')).toContain('shop.prod')
    expect(await denied($, 'cd shop && DBT_PROFILE=billing dbt run')).toContain('billing.dev')
    expect(await denied($, 'cd shop; cd ../billing; dbt run')).toContain('billing.dev')
  })

  test('PowerShell is guarded like Bash', async ($, on) => {
    engine(on)
    const ps = async (command: string) => (await $.tool.call({ tool: 'PowerShell', command })).deny
    expect(await ps('Set-Location billing; dbt run')).toContain('billing.dev (database analytics)')
    expect(await ps(`$env:DBT_TARGET = 'prod'; cd shop; dbt build`)).toContain('shop.prod')
    expect(await ps('cd shop; dbt run')).toBeUndefined()
  })

  test('fails closed when dbt cannot resolve the target', async ($, on) => {
    engine(on)
    expect(await denied($, 'dbt run --profile nosuch')).toContain("cannot tell which database this dbt command would use (Runtime Error Could not find profile named 'nosuch')")
    expect(await denied($, 'cd shop && dbt run --target qa')).toContain("does not have a target named 'qa'")
    expect(await denied($, 'dbt run --target qa')).toContain('no profile has a target named qa')
  })

  test('fails closed when dbt cannot start', async ($, on) => {
    on('process.spawn', async function* () {
      yield* []
      return { deny: 'spawn dbt ENOENT' }
    })
    engine(on, { withDbt: false })
    expect(await denied($, 'cd shop && dbt run')).toContain('spawn dbt ENOENT')
  })

  test('reads never wait on dbt, and each target is resolved once while profiles.yml is unchanged', async ($, on) => {
    const calls: string[][] = []
    const mtime = { value: 1 }
    engine(on, { calls, mtime })
    expect(await denied($, 'cd shop && dbt test --target prod')).toBeUndefined()
    expect(await denied($, 'cd shop && dbt show --target prod --inline "select * from mart.orders"')).toBeUndefined()
    expect(calls).toHaveLength(0)
    // Two at once share one dbt per target: the dev target, and shop.prod to learn the prod database.
    await Promise.all([bash($, 'cd shop && dbt run'), bash($, 'cd shop && dbt run')])
    await bash($, 'cd shop && dbt build')
    expect(calls).toHaveLength(2)
    expect(calls).toEqual(expect.arrayContaining([
      expect.arrayContaining(['compile', '--profile', 'shop', '--no-introspect']),
      expect.arrayContaining(['--profile', 'shop', '--target', 'prod']),
    ]))
    expect(calls.filter(c => c.includes('--target'))).toHaveLength(1)
    mtime.value = 2 // profiles.yml edited: ask dbt again
    await bash($, 'cd shop && dbt run')
    expect(calls).toHaveLength(4)
  })

  test('a prod target dbt cannot resolve here is said once, not skipped quietly', async ($, on) => {
    const toasts: string[] = []
    on('ui.toast', ($, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    // billing.prod is in profiles.yml, but the fake dbt cannot resolve it, as with a CI-only password.
    engine(on, { profiles: 'billing:\n  outputs:\n    dev:\n      dbname: analytics\n    prod:\n      dbname: analytics\n  target: dev\n' })
    expect(await denied($, 'cd billing && dbt run')).toBeUndefined()
    expect(await denied($, 'cd billing && dbt build')).toBeUndefined()
    expect(toasts).toEqual([expect.stringContaining("cannot tell which database billing.prod points at (Runtime Error The profile 'billing' does not have a target named 'prod'.)")])
  })

  test('full refreshes and destructive dbt show on prod are blocked', async ($, on) => {
    engine(on)
    expect(await denied($, 'cd shop && dbt test --target prod --full-refresh')).toContain('--full-refresh')
    expect(await denied($, 'cd shop && DBT_FULL_REFRESH=1 dbt test --target prod')).toContain('--full-refresh')
    expect(await denied($, 'cd shop && dbt show --target prod --inline "delete from mart.orders"')).toContain('through dbt show')
    expect(await denied($, 'cd shop && dbt show --inline "delete from mart.orders"')).toBeUndefined() // dev
  })

  test('honours custom prod settings', { options: { prodDbtTarget: 'bobdev', prodDatabases: '' } }, async ($, on) => {
    engine(on)
    expect(await denied($, 'cd billing && dbt run')).toBeUndefined()
    expect(await denied($, 'cd shop && dbt run --target bobdev')).toContain('shop.bobdev')
    expect(await denied($, 'aws redshift-data execute-statement --database analytics --sql "truncate x"')).toBeUndefined()
  })

  test('out of the box, the database a prod target points at is prod, whatever target reaches it', async ($, on) => {
    engine(on)
    expect(await denied($, 'cd billing && dbt run')).toContain('billing.dev (database analytics)')
    expect(await denied($, 'aws redshift-data execute-statement --database analytics --sql "truncate x"')).toContain('prod database analytics')
    expect(await denied($, 'cd shop && dbt run')).toBeUndefined()
  })

  test('prodDatabases adds databases no prod target points at', { options: { prodDatabases: 'dev_alice' } }, async ($, on) => {
    engine(on)
    expect(await denied($, 'cd shop && dbt run')).toContain('shop.dev (database dev_alice)')
  })

  test('with no prod target and no setting, a toast says nothing is known', async ($, on) => {
    const toasts: string[] = []
    on('ui.toast', ($, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    mock.store(on)
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    engine(on, { profiles: 'billing:\n  outputs:\n    dev:\n      dbname: analytics\n  target: dev\n' })
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    expect(toasts).toEqual([expect.stringContaining('no prod database known. Set prodDatabases with /plugin configure redshift-dbt-kit@redshift-dbt-kit')])
    expect(await denied($, 'cd billing && dbt run')).toBeUndefined()
  })

  test('a dev target on the prod login gets a tip, once ever', async ($, on) => {
    const toasts: string[] = []
    on('ui.toast', ($, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    const saved: string[] = []
    on('store.get', () => ({ value: undefined }))
    on('store.set', ($, e) => {
      saved.push(e.key)
      return { value: undefined }
    })
    engine(on)
    expect(await denied($, 'dbt run --profile shop --target bobdev')).toBeUndefined()
    expect(toasts).toEqual([]) // bob_dev is not prod's login
    expect(await denied($, 'cd shop && dbt run')).toBeUndefined()
    expect(await denied($, 'cd shop && dbt build')).toBeUndefined()
    expect(toasts).toEqual([expect.stringContaining('tip: shop.dev and shop.prod log in as the same user (alice)')])
    expect(saved).toEqual(['tip:login:alice']) // kept, so later sessions stay quiet
  })

  test('outputs the picker cannot list (flow style) may hold a prod target: no warning', async ($, on) => {
    const toasts: string[] = []
    on('ui.toast', ($, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    mock.store(on)
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    engine(on, { profiles: 'shop:\n  outputs: {dev: {dbname: dev_alice}, prod: {dbname: analytics}}\n  target: dev\n' })
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
    expect(toasts).toEqual([])
  })

  test('other tools pass untouched', async ($, on) => {
    engine(on)
    on('tool.call', { tool: 'Glob' }, () => ({ result: { filenames: [], durationMs: 0, numFiles: 0, truncated: false } }))
    expect((await $.tool.call({ tool: 'Glob', pattern: 'models/**/*.sql' })).deny).toBeUndefined()
  })
})
