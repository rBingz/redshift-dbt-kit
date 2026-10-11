import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, Catalog, Env, ModelCard, QueryResult, Running } from '../types'
import { CATALOG_SQL, ago, modelCard, modelPath, parseDbtShow, searchCatalog } from './catalog'
import type { Manifest } from './catalog'
import { RESOLVE_SQL, dbtCalls, destructiveSql, listProfiles, parseResolved, sqlCalls } from './guard'
import type { DbtCall, Resolved } from './guard'
import { SPINNER, areaCells, chip, conventions, explainPrompt, fixPrompt, heat, improvePrompt, isFailed, numericColumns, parseRunResults, parseStatementResult, smoothBar, sparkline, statusCounts, textTable } from './views'

const TIMED = new Set(['run', 'build', 'test', 'seed', 'snapshot'])
const BOARD = 'dbt-board'
const RESULTS = 'rs-results'
const SCHEMA = 'rs-schema'
const MODEL = 'dbt-model'
const board = atom({ plugin: 'redshift-dbt-guard', key: 'board' } as const, null)
const results = atom({ plugin: 'redshift-dbt-guard', key: 'results' } as const, null)
const page = atom({ plugin: 'redshift-dbt-guard', key: 'page' } as const, 0)
const running = atom({ plugin: 'redshift-dbt-guard', key: 'running' } as const, null)
const tick = atom({ plugin: 'redshift-dbt-guard', key: 'tick' } as const, 0)
const EMPTY: Catalog = { status: 'empty', columns: [] }
const catalog = atom({ plugin: 'redshift-dbt-guard', key: 'catalog' } as const, EMPTY)
const search = atom({ plugin: 'redshift-dbt-guard', key: 'search' } as const, '')
const card = atom({ plugin: 'redshift-dbt-guard', key: 'card' } as const, null)
const env = atom({ plugin: 'redshift-dbt-guard', key: 'env' } as const, null)
const NO_ENVS: Env[] = []
const envs = atom({ plugin: 'redshift-dbt-guard', key: 'envs' } as const, NO_ENVS)

const envLabel = (e: Env) => `${e.profile}.${e.target}`

const lastLines = (text: string) => text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(-2).join(' ')
const tempDir = async ($: EngineInterface) => `${(await $.env.get('TEMP')) ?? (await $.env.get('TMPDIR')) ?? '/tmp'}/redshift-dbt-guard`

// A dbt call with nothing on its command line: the session's own folder and settings.
const HERE: DbtCall = { verb: '', isWrite: false, hasShow: false, fullRefresh: false, cwd: '.' }

// The folder dbt reads profiles.yml from for a call, in dbt's own order: --profiles-dir (or
// DBT_PROFILES_DIR set in the command), then $DBT_PROFILES_DIR, then the folder it runs in, then ~/.dbt.
async function profilesDir($: EngineInterface, call: DbtCall): Promise<string | undefined> {
  if (call.profilesDir !== undefined) return call.profilesDir
  const fromEnv = await $.env.get('DBT_PROFILES_DIR')
  if (fromEnv) return fromEnv
  if (call.cwd !== undefined && (await $.fs.exists(`${call.cwd}/profiles.yml`))) return call.cwd
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return home ? `${home}/.dbt` : undefined
}

// The folder of the project a call runs, where its dbt_project.yml and target/ are; undefined after popd.
async function projectDir($: EngineInterface, call: DbtCall): Promise<string | undefined> {
  return call.projectDir ?? (await $.env.get('DBT_PROJECT_DIR')) ?? call.cwd
}

// dbt's own answer to "which target and database would this be?": it renders profiles.yml with
// its Jinja, env vars, anchors and merges, prints RESOLVE_SQL's line, and is stopped before it connects.
// Cached for the session while profiles.yml is unchanged: dbt takes seconds to start. The cache holds
// the pending answer, so callers asking at once (session start, the picker, a guarded call) share one dbt.
const resolvedCache = new Map<string, Promise<Resolved>>()
async function resolveTarget($: EngineInterface, dir: string, profile: string, target?: string): Promise<Resolved> {
  const changed = await $.fs.stat(`${dir}/profiles.yml`).then(s => s.mtimeMs, () => 0)
  const key = `${dir}|${changed}|${profile}|${target ?? ''}`
  let pending = resolvedCache.get(key)
  if (pending === undefined) {
    pending = askDbt($, dir, profile, target)
    resolvedCache.set(key, pending)
    pending.catch(() => resolvedCache.delete(key)) // a failure is asked again next time
  }
  return pending
}

async function askDbt($: EngineInterface, dir: string, profile: string, target?: string): Promise<Resolved> {
  const temp = await tempDir($)
  const argv = ['dbt', '--quiet', 'compile', '--project-dir', `${$.plugin.root}/runner`, '--profiles-dir', dir, '--profile', profile,
    ...(target ? ['--target', target] : []), '--no-introspect', '--target-path', temp, '--log-path', temp, '--inline', RESOLVE_SQL]
  let said = ''
  for await (const { text } of $.process.spawn({ argv })) {
    said += text
    const found = parseResolved(said)
    if (found) return found // leaving the loop stops dbt before it connects
  }
  throw new Error(lastLines(said) || 'dbt printed no target')
}

// The targets a dbt command would use. The profile comes from --profile or the project's
// dbt_project.yml; when neither names one, every profile with that target counts, so prod wins.
async function dbtTargets($: EngineInterface, dbt: DbtCall): Promise<{ envs: Resolved[]; dir: string } | { error: string }> {
  const dir = await profilesDir($, dbt)
  if (dir === undefined) return { error: 'no profiles.yml found' }
  // dbt's order: --profile (or DBT_PROFILE in the command), $DBT_PROFILE, then dbt_project.yml.
  let profile = dbt.profile ?? (await $.env.get('DBT_PROFILE'))
  const project = await projectDir($, dbt)
  if (profile === undefined && project !== undefined) {
    try {
      profile = (await $.fs.read(`${project}/dbt_project.yml`)).match(/^profile:\s*["']?([\w-]+)["']?\s*(#.*)?$/m)?.[1]
    } catch {
      // not in a dbt project
    }
  }
  let names = profile !== undefined ? [profile] : []
  if (names.length === 0) {
    let listed: Record<string, string[]>
    try {
      listed = listProfiles(await $.fs.read(`${dir}/profiles.yml`))
    } catch {
      return { error: `cannot read ${dir}/profiles.yml` }
    }
    // A profile whose outputs could not be listed may still hold the target: ask dbt about it too.
    names = Object.keys(listed).filter(p => dbt.target === undefined || listed[p]!.length === 0 || listed[p]!.includes(dbt.target))
    if (names.length === 0) return { error: dbt.target ? `no profile has a target named ${dbt.target}` : 'no profiles in profiles.yml' }
  }
  try {
    return { envs: await Promise.all(names.map(p => resolveTarget($, dir, p, dbt.target))), dir }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

// Add the databases the targets named `prodTarget` point at, as dbt resolves them, to `learned`. They
// are prod whatever other target reaches them, so a dev-named target writing to one is caught with no
// setting. A prod target dbt cannot resolve here (say its password is an env_var only CI sets) would
// leave its database unguarded, so that is said once rather than guarded less quietly.
// Returns the prod targets it resolved.
const warnedProd = new Set<string>()
async function learnProdDatabases($: EngineInterface, dir: string, prodTarget: string, learned: Set<string>): Promise<Resolved[]> {
  let listed: Record<string, string[]>
  try {
    listed = listProfiles(await $.fs.read(`${dir}/profiles.yml`))
  } catch {
    return []
  }
  const found = await Promise.all(
    Object.entries(listed)
      .filter(([, outputs]) => outputs.includes(prodTarget))
      .map(([profile]) =>
        resolveTarget($, dir, profile, prodTarget).then(
          r => {
            if (r.dbname !== undefined) learned.add(r.dbname)
            return r
          },
          (err: unknown) => {
            const label = `${profile}.${prodTarget}`
            if (!warnedProd.has(label)) {
              warnedProd.add(label)
              $.ui.toast(`⚠ redshift-dbt-guard: cannot tell which database ${label} points at (${err instanceof Error ? err.message : String(err)}), so other targets on it are not guarded. Set prodDatabases in /config.`)
            }
            return undefined
          },
        ),
      ),
  )
  return found.filter((r): r is Resolved => r !== undefined)
}

// A dev target that logs in as the same database user as a prod target can write prod whatever the
// guard misses. Say so once per user, ever: the fix (a dev login without prod rights) is the team's.
const tipped = new Set<string>()
async function loginTip($: EngineInterface, dev: Resolved, prods: Resolved[]) {
  const prod = prods.find(p => p.user !== undefined && p.user === dev.user)
  if (prod === undefined || tipped.has(prod.user!)) return
  tipped.add(prod.user!)
  const key = `tip:login:${prod.user}`
  if (await $.store.get(key)) return
  await $.store.set(key, true)
  $.ui.toast(`✻ redshift-dbt-guard tip: ${dev.profile}.${dev.target} and ${prod.profile}.${prod.target} log in as the same user (${prod.user}), so anything run on dev can also write prod. A dev login without write rights on prod closes that for good; the guard is only a seatbelt.`)
}

// Fill in each listed target's database for the picker, as dbt resolves it: three dbt processes
// at a time, so a profiles.yml with many targets does not start them all at once.
async function fillDatabases($: EngineInterface, dir: string, listed: Env[]) {
  const queue = [...listed]
  const worker = async () => {
    for (let e = queue.shift(); e !== undefined; e = queue.shift()) {
      const one = e
      try {
        const r = await resolveTarget($, dir, one.profile, one.target)
        await update($, envs, all => all.map(o => (envLabel(o) === envLabel(one) ? { ...o, dbname: r.dbname } : o)))
      } catch {
        // left without a database: the picker shows the name alone
      }
    }
  }
  await Promise.all([worker(), worker(), worker()])
}

// `dbt show --output json` rows in the results pane's shape; a column is numeric when its first value is.
function showResult(rows: Record<string, unknown>[], id: string): QueryResult | undefined {
  const first = rows[0]
  if (first === undefined) return
  const names = Object.keys(first)
  const cell = (v: unknown) => (v === null || v === undefined ? null : String(v))
  return {
    id,
    columns: names.map(name => ({ name, type: typeof rows.find(r => r[name] != null)?.[name] === 'number' ? 'numeric' : 'text' })),
    rows: rows.slice(0, 1000).map(r => names.map(n => cell(r[n]))),
    total: rows.length,
  }
}

// Feed the panes from a finished command. Never throws: a pane is not worth failing the call.
async function capture($: EngineInterface, cmd: string, dbt: DbtCall | undefined, stdout: string, startedAt: number) {
  try {
    let result: QueryResult | undefined
    const verb = dbt?.verb
    if (dbt !== undefined && verb !== undefined && TIMED.has(verb)) {
      // shortcut: ignores --target-path and DBT_TARGET_PATH; add them if the team moves target/.
      const project = await projectDir($, dbt)
      if (project === undefined) return
      const run = parseRunResults(await $.fs.read(`${project}/target/run_results.json`), `dbt ${verb}`, startedAt)
      if (run === undefined) return
      await update($, board, () => run)
      // A pane opened unasked waits in a narrow terminal; say where to find it.
      const { isPlaced } = await $.ui.open({ id: BOARD, title: '✻ dbt run' })
      if (!isPlaced) $.ui.toast('✻ dbt run results ready: /dbt-board to view')
      return
    }
    if (dbt?.hasShow) {
      const rows = parseDbtShow(stdout)
      result = rows && showResult(rows, dbt.target ? `dbt show · ${dbt.target}` : 'dbt show')
    } else if (/redshift-data\s+get-statement-result/.test(cmd)) {
      result = parseStatementResult(stdout, cmd.match(/--id[=\s]+["']?([\w-]+)/)?.[1] ?? '?')
    }
    if (result === undefined) return
    const shown = result
    await update($, results, () => shown)
    await update($, page, () => 0)
    const { isPlaced } = await $.ui.open({ id: RESULTS, title: '✻ Query results' })
    if (!isPlaced) $.ui.toast('✻ Query results ready: /rs-results to view')
  } catch {
    // no run_results.json, or output we cannot read: leave the panes as they were
  }
}

// Reads svv_columns through dbt itself (`dbt show` with the picked profile and target), so it logs
// in exactly as the team's dbt does. Runs from the mod's own empty project under runner/.
async function loadCatalog($: EngineInterface, picked: Env) {
  const source = envLabel(picked)
  const isPicked = async () => {
    const now = await read($, env)
    return now === null || envLabel(now) === source
  }
  const fail = async (message: string) => {
    if (await isPicked()) await update($, catalog, c => ({ ...c, status: 'error' as const, message }))
  }
  // A refresh keeps the old list on screen; a new source starts empty.
  await update($, catalog, c => (c.source === source ? { ...c, status: 'loading' as const, message: undefined } : { status: 'loading' as const, source, columns: [] }))
  try {
    const dir = await profilesDir($, HERE)
    if (dir === undefined) return void (await fail('no profiles.yml found'))
    const temp = await tempDir($)
    const ran = await $.process.run(
      ['dbt', '--quiet', 'show', '--project-dir', `${$.plugin.root}/runner`, '--profiles-dir', dir, '--profile', picked.profile, '--target', picked.target,
        '--inline', CATALOG_SQL, '--output', 'json', '--limit', '200000', '--target-path', temp, '--log-path', temp],
      { timeoutMs: 300_000 },
    )
    // shortcut: a catalog over 4 MiB of output is refused; add a schema filter to CATALOG_SQL if one ever is
    if (ran.isStdoutTruncated) return void (await fail('catalog is over 4 MiB of output'))
    const rows = parseDbtShow(ran.stdout)
    if (ran.exitCode !== 0 || rows === undefined) {
      return void (await fail(`dbt show failed: ${lastLines(`${ran.stdout}\n${ran.stderr}`) || `exit ${ran.exitCode}`}`))
    }
    const columns = rows.map(r => String(Object.values(r)[0] ?? '')).filter(Boolean).sort()
    const value: Catalog = { status: 'ready', source, fetchedAt: await $.clock.now(), columns }
    // The person may have picked another target while this one loaded: cache it, show it only if still picked.
    if (await isPicked()) await update($, catalog, () => value)
    // The store holds 4 MiB in all, so it keeps only the newest catalog: older ones would fill it
    // and make every later save fail, the picked target included. One too big stays for this session.
    for (const key of await $.store.keys()) if (key.startsWith('catalog:') && key !== `catalog:${source}`) await $.store.delete(key)
    await $.store.set(`catalog:${source}`, value).catch(() => {})
  } catch (err) {
    await fail(`cannot run dbt: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// Point the schema pane at a dbt target: its cached catalog when there is one, else a query.
async function switchEnv($: EngineInterface, picked: Env) {
  await update($, env, () => picked)
  await $.store.set('env', picked).catch(() => {})
  const saved = (await $.store.get(`catalog:${envLabel(picked)}`)) as Catalog | undefined
  if (saved?.status === 'ready') await update($, catalog, () => saved)
  else await loadCatalog($, picked)
}

let manifestCache:{ path: string; mtimeMs: number; doc: Manifest } | undefined

// The card for a model file Claude touched; opens the pane when it was an edit.
async function showModel($: EngineInterface, filePath: string, isEdit: boolean) {
  const model = modelPath(filePath)
  if (model === undefined || !(await $.fs.exists(`${model.project}/dbt_project.yml`))) return
  const path = `${model.project}/target/manifest.json`
  let value: ModelCard
  try {
    if (!(await $.fs.exists(path))) throw new Error('no target/manifest.json yet: run dbt parse')
    const stat = await $.fs.stat(path)
    if (stat.size > 4 * 1024 * 1024) throw new Error('target/manifest.json is over 4 MiB, more than a mod can read')
    if (manifestCache?.path !== path || manifestCache.mtimeMs !== stat.mtimeMs) {
      manifestCache = { path, mtimeMs: stat.mtimeMs, doc: JSON.parse(await $.fs.read(path)) as Manifest }
    }
    value = modelCard(manifestCache.doc, model.name)
  } catch (err) {
    value = { name: model.name, error: err instanceof Error ? err.message : String(err) }
  }
  await update($, card, () => value)
  if (isEdit) await $.ui.open({ id: MODEL, title: '✻ dbt model' })
}

export const register: Register = (on, options) => {
  const list = (v: unknown) => String(v ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const prodDatabases = list(options.prodDatabases)
  const prodTarget = String(options.prodDbtTarget ?? 'prod')
  const toastSeconds = Number.isFinite(Number(options.toastSeconds)) ? Number(options.toastSeconds) : 60
  // Prod databases learned from the targets named prodTarget, beside the configured ones.
  const learned = new Set<string>()
  const isProdDb = (db: string) => prodDatabases.includes(db) || learned.has(db)
  const isProdEnv = (e: Env) => e.target === prodTarget || (e.dbname !== undefined && isProdDb(e.dbname))
  const shown: { dbt?: Env } = {}

  const statusText = () => {
    if (shown.dbt === undefined) return undefined
    return `${isProdEnv(shown.dbt) ? '⚠ PROD' : '✻'}  dbt:${envLabel(shown.dbt)}${shown.dbt.dbname ? ` (${shown.dbt.dbname})` : ''}`
  }

  on('session.start', async ($, e, next) => {
    $.ui.status(statusText())
    // Nothing to learn prod from and nothing configured: say so once, rather than guard nothing quietly.
    const listed = await profilesDir($, HERE)
      .then(async dir => (dir === undefined ? {} : listProfiles(await $.fs.read(`${dir}/profiles.yml`))))
      .catch((): Record<string, string[]> => ({}))
    const hasDbt = Object.keys(listed).length > 0
    // A profile with no listed outputs (flow style, an alias) may hold a prod target: no warning then.
    if (hasDbt && prodDatabases.length === 0 && !Object.values(listed).some(outputs => outputs.length === 0 || outputs.includes(prodTarget))) {
      $.ui.toast(`⚠ redshift-dbt-guard: no prod database known. Set prodDatabases in /config, or name your prod target "${prodTarget}".`)
    }
    // In a dbt project: the status line's target and the prod databases, once dbt has started (seconds).
    if (hasDbt) void (async () => {
      const project = await $.fs.read('dbt_project.yml').catch(() => '')
      if (!/^profile:/m.test(project)) return
      const found = await dbtTargets($, HERE)
      if (!('envs' in found)) return
      await learnProdDatabases($, found.dir, prodTarget, learned)
      if (found.envs.length === 1) shown.dbt = found.envs[0]
      $.ui.status(statusText())
    })().catch(() => {})
    await $.command.register({ name: 'dbt-board', description: 'Show the last dbt run as a pane' })
    await $.command.register({ name: 'rs-results', description: 'Show the last query result as a pane' })
    await $.command.register({ name: 'rs-schema', description: 'Search Redshift columns: does this field exist?' })
    await $.command.register({ name: 'dbt-model', description: 'Show the card of the dbt model Claude last touched' })
    const lastEnv = (await $.store.get('env')) as Env | undefined
    if (typeof lastEnv?.profile === 'string' && typeof lastEnv.target === 'string') {
      await update($, env, () => lastEnv)
      const saved = (await $.store.get(`catalog:${envLabel(lastEnv)}`)) as Catalog | undefined
      if (saved?.status === 'ready') await update($, catalog, () => saved)
    }
    return next(e)
  })

  // The team's conventions, last in the system prompt (after the cache boundary: they vary with the settings).
  const section = { id: 'redshift-dbt-guard:conventions', text: conventions(prodDatabases, prodTarget), scope: 'session' } as const
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return { sections: [...composed.sections, section] }
  })

  on('command.run', { command: 'dbt-board' }, async $ => {
    await $.ui.open({ id: BOARD, title: '✻ dbt run' })
    return { text: 'dbt run pane opened.' }
  })

  on('command.run', { command: 'rs-results' }, async $ => {
    await $.ui.open({ id: RESULTS, title: '✻ Query results' })
    return { text: 'Query results pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: BOARD }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const run: Board | null = await read($, board)
    const live: Running | null = await read($, running)
    const spin = SPINNER[(await read($, tick)) % SPINNER.length]
    const busy = live && (
      <Text color="claude" bold>
        {spin} {live.command} running · {Math.round(((await $.clock.now()) - live.startedAt) / 1000)}s
      </Text>
    )
    if (run === null) return busy || <Text dimColor>✻ No dbt run yet. Runs of dbt run, build, test, seed and snapshot show here.</Text>

    const width = e.props.bodyColumns - 4 // round border + padding
    const room = Math.max(3, (e.viewport?.rows ?? 24) - 10)
    const failed = run.rows.filter(isFailed)
    const slowest = [...run.rows].sort((a, b) => b.seconds - a.seconds).slice(0, Math.max(1, room - failed.length))
    const nameWidth = Math.min(40, Math.max(...slowest.map(r => r.name.length)))
    const max = slowest[0]?.seconds ?? 1
    const chipWidth = Math.max(...slowest.map(r => chip(r.status).label.length))

    return (
      <Box flexDirection="column">
        {busy}
        <Box borderStyle="round" borderColor="claude" paddingX={1} flexDirection="column">
          <Text>
            <Text color="claude" bold>✻ {run.command}</Text>
            <Text dimColor> · {run.elapsed.toFixed(0)}s · </Text>
            {statusCounts(run.rows)}
          </Text>
        </Box>
        {failed.length > 0 && (
          <Box borderStyle="round" borderColor="error" paddingX={1} flexDirection="column">
            {failed.map(r => (
              <Box key={`failed-${r.name}`}>
                <Button key={`fix-${r.name}`} label="fix" onPress={() => $.prompt.fill({ text: fixPrompt(run.command, r), mode: 'append' })} />
                <Text color="error" wrap="truncate-end">
                  {' '}✗ <Text bold>{r.name}</Text> {r.message ?? ''}
                </Text>
              </Box>
            ))}
          </Box>
        )}
        <Box paddingX={1} flexDirection="column">
          <Text dimColor>Slowest</Text>
          {slowest.map(r => {
            const c = chip(r.status)
            return (
              <Text wrap="truncate-end">
                <Text backgroundColor={c.color} color="inverseText" bold>{c.label}</Text>
                {' '.repeat(chipWidth - c.label.length + 1)}
                {r.name.padEnd(nameWidth).slice(0, nameWidth)}{' '}
                <Text color={heat(r.seconds / max)}>{smoothBar(r.seconds, max, Math.max(1, width - nameWidth - chipWidth - 22))}</Text>
                {' '}{r.seconds.toFixed(1)}s
                {r.rowsAffected !== undefined && <Text dimColor> {r.rowsAffected.toLocaleString('en-US')} rows</Text>}
              </Text>
            )
          })}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: RESULTS }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const Raster = e.surface === 'terminal' ? $.ui.resolve(e).Raster : undefined
    const result: QueryResult | null = await read($, results)
    if (result === null) return <Text dimColor>✻ No query result yet. Results of dbt show --output json show here.</Text>

    const width = e.props.bodyColumns - 2
    const charts = numericColumns(result).slice(0, 3)
    const chartRows = Raster ? 2 : 1
    const size = Math.max(1, (e.viewport?.rows ?? 24) - 9 - charts.length * chartRows)
    const pages = Math.max(1, Math.ceil(result.rows.length / size))
    const at = Math.min(await read($, page), pages - 1)
    const table = textTable(result, result.rows.slice(at * size, (at + 1) * size), width)
    const label = (i: number) => result.columns[i]!.name.slice(0, 15).padEnd(16)
    const values = (i: number) => result.rows.map(r => Number(r[i])).filter(Number.isFinite)

    return (
      <Box flexDirection="column">
        <Box borderStyle="round" borderColor="claude" paddingX={1}>
          <Text wrap="truncate-end">
            <Text color="claude" bold>✻ {result.total.toLocaleString('en-US')} rows</Text>
            <Text dimColor> · {result.columns.length} columns · statement {result.id}</Text>
            {result.rows.length < result.total && <Text dimColor> (first {result.rows.length} kept)</Text>}
            {table.hidden > 0 && <Text color="warning"> · {table.hidden} columns off screen</Text>}
          </Text>
        </Box>
        <Box paddingX={1} flexDirection="column">
          <Text color="claude" bold wrap="truncate-end">{table.header}</Text>
          {table.lines.map((line, i) => (
            <Text wrap="truncate-end" dimColor={i % 2 === 1}>{line}</Text>
          ))}
        </Box>
        <Box paddingX={1} flexDirection="column">
          {charts.map(i =>
            Raster ? (
              <Box>
                <Text dimColor>{label(i)}</Text>
                <Raster key={`chart-${i}`} columns={Math.max(1, width - 18)} rows={chartRows} cells={areaCells(values(i), Math.max(1, width - 18), chartRows)} />
              </Box>
            ) : (
              <Text wrap="truncate-end">
                <Text dimColor>{label(i)}</Text>
                <Text color="claude">{sparkline(values(i), width - 18)}</Text>
              </Text>
            ),
          )}
        </Box>
        <Box paddingX={1}>
          <Button key="prev" hotkey="p" label="prev" onPress={() => update($, page, p => Math.max(0, Math.min(p, pages - 1) - 1))} />
          <Text dimColor> page {at + 1}/{pages} </Text>
          <Button key="next" hotkey="n" label="next" onPress={() => update($, page, p => Math.min(pages - 1, p + 1))} />
          <Text>  </Text>
          <Button key="explain" hotkey="e" label="explain" onPress={() => $.prompt.fill({ text: explainPrompt(result), mode: 'append' })} />
        </Box>
      </Box>
    )
  })

  on('command.run', { command: 'rs-schema' }, async $ => {
    await $.ui.open({ id: SCHEMA, title: '✻ Schema', focus: true })
    const fail = (message: string) => update($, catalog, c => ({ ...c, status: 'error' as const, message }))
    const dir = await profilesDir($, HERE)
    let listed: Record<string, string[]> = {}
    try {
      if (dir !== undefined) listed = listProfiles(await $.fs.read(`${dir}/profiles.yml`))
    } catch {
      // reported below as no targets
    }
    const known = await read($, envs)
    const all: Env[] = Object.entries(listed).flatMap(([profile, outputs]) =>
      outputs.map(target => known.find(k => k.profile === profile && k.target === target) ?? { profile, target }),
    )
    await update($, envs, () => all)
    if (dir === undefined || all.length === 0) {
      await fail(`no targets found in ${dir ?? '~/.dbt'}/profiles.yml`)
      return { text: 'Schema pane opened.' }
    }
    // Databases for the picker come from dbt, a few seconds each, so they fill in behind the pane.
    void fillDatabases($, dir, all.filter(e => e.dbname === undefined)).catch(() => {})

    // Last pick, else the first profile's default target as dbt resolves it.
    const last = await read($, env)
    let picked = last && all.some(e => envLabel(e) === envLabel(last)) ? last : undefined
    if (picked === undefined) {
      try {
        picked = await resolveTarget($, dir, Object.keys(listed)[0]!)
      } catch (err) {
        await fail(`dbt cannot resolve a target: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    if (picked !== undefined) {
      const current = await read($, catalog)
      // dbt show takes a while: the pane is already open and shows it loading meanwhile.
      if (current.source !== envLabel(picked) || current.status === 'error') await switchEnv($, picked)
      else await update($, env, () => picked)
    }
    return { text: 'Schema pane opened.' }
  })

  on('command.run', { command: 'dbt-model' }, async $ => {
    await $.ui.open({ id: MODEL, title: '✻ dbt model' })
    return { text: 'dbt model pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: SCHEMA }, async ($, e) => {
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>✻ Column search needs a keyboard.</Text>
    }
    const { Box, Text, Button, Input, Select } = $.ui.resolve(e)
    const cat = await read($, catalog)
    const query = await read($, search)
    const picked = await read($, env)
    const known = await read($, envs)
    const options = picked && !known.some(k => envLabel(k) === envLabel(picked)) ? [picked, ...known] : known
    // The picker has resolved every target, prod-named ones included: their databases are prod too.
    const prodDbs = new Set(known.filter(k => k.target === prodTarget && k.dbname !== undefined).map(k => k.dbname!))
    const isProdHere = (o: Env) => isProdEnv(o) || (o.dbname !== undefined && prodDbs.has(o.dbname))
    const room = Math.max(3, (e.viewport?.rows ?? 24) - 11)
    const { total, matches } = searchCatalog(cat.columns, query, room)
    const age = cat.fetchedAt !== undefined ? ` · refreshed ${ago((await $.clock.now()) - cat.fetchedAt)}` : ''
    const source = picked ? `${envLabel(picked)}${picked.dbname ? ` (${picked.dbname})` : ''}` : (cat.source ?? 'no target')

    const status =
      cat.status === 'loading' ? <Text color="claude">✻ loading columns from {source} through dbt…</Text>
      : cat.status === 'error' ? <Text color="error">✗ {cat.message}</Text>
      : cat.status === 'empty' ? <Text dimColor>No columns loaded yet. Pick a target or press refresh.</Text>
      : query.trim() === '' ? <Text dimColor>Type to search. Press a row to put it in your prompt.</Text>
      : total === 0 ? <Text color="error">✗ no column matches "{query.trim()}"</Text>
      : <Text dimColor>{total.toLocaleString('en-US')} matches</Text>

    return (
      <Box flexDirection="column">
        <Box borderStyle="round" borderColor={picked && isProdHere(picked) ? 'warning' : 'claude'} paddingX={1}>
          <Text wrap="truncate-end">
            <Text color="claude" bold>✻ Schema</Text>
            <Text dimColor> · {cat.columns.length.toLocaleString('en-US')} columns · {source}{age}</Text>
          </Text>
        </Box>
        {options.length > 0 && (
          <Box paddingX={1}>
            <Select
              key="env"
              label="target"
              options={options.map(o => ({
                value: envLabel(o),
                label: `${isProdHere(o) ? '⚠ ' : ''}${envLabel(o)}${o.dbname ? ` · ${o.dbname}` : ''}`,
              }))}
              value={picked ? envLabel(picked) : undefined}
              onSelect={v => {
                const next = options.find(o => envLabel(o) === v)
                if (next) void switchEnv($, next).catch(() => {})
              }}
            />
          </Box>
        )}
        <Box paddingX={1} flexDirection="column">
          <Input key="q" placeholder="search columns, e.g. orders customer_id" value={query} autoFocus onInput={v => update($, search, () => v)} onSubmit={v => update($, search, () => v)} />
          {status}
          {matches.map(m => (
            <Button key={m.name} plain onPress={() => $.prompt.fill({ text: m.name, mode: 'insert' })}>
              {m.isExact ? <Text color="success">✓ </Text> : '  '}
              {m.parts.map(p => (p.isHit ? <Text color="claude" bold>{p.text}</Text> : p.text))}
              <Text dimColor>  {m.type}</Text>
            </Button>
          ))}
          {total > matches.length && <Text dimColor>… {(total - matches.length).toLocaleString('en-US')} more: add a term to narrow</Text>}
        </Box>
        <Box paddingX={1}>
          <Button
            key="refresh"
            label={cat.status === 'loading' ? 'loading…' : 'refresh'}
            onPress={() => {
              if (picked && cat.status !== 'loading') void loadCatalog($, picked).catch(() => {})
            }}
          />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: MODEL }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const c: ModelCard | null = await read($, card)
    if (c === null) return <Text dimColor>✻ No dbt model yet. Models Claude reads or edits show here.</Text>
    if (c.error !== undefined) {
      return (
        <Box borderStyle="round" borderColor="error" paddingX={1} flexDirection="column">
          <Text bold>✻ {c.name}</Text>
          <Text color="error">✗ {c.error}</Text>
        </Box>
      )
    }
    const run = (await read($, board))?.rows.find(r => r.name === c.name)
    const generated = c.generatedAt ? Date.parse(c.generatedAt.replace(/(\.\d{3})\d+/, '$1')) : NaN
    const age = Number.isFinite(generated) ? ago((await $.clock.now()) - generated) : undefined
    const list = (xs: string[] = []) => (xs.length ? xs.join(', ') : '—')
    const runChip = run && chip(run.status)
    const improve = improvePrompt(c)

    return (
      <Box flexDirection="column">
        <Box borderStyle="round" borderColor="claude" paddingX={1} flexDirection="column">
          <Text wrap="truncate-end">
            <Text color="claude" bold>✻ {c.name}</Text>
            <Text dimColor> · {c.materialized ?? '?'}{c.relation ? ` · ${c.relation}` : ''}</Text>
          </Text>
          {c.description ? <Text>{c.description}</Text> : <Text color="warning">no description</Text>}
        </Box>
        <Box paddingX={1} flexDirection="column">
          <Text wrap="truncate-end"><Text color="claude">↑ </Text>{list(c.upstream)}</Text>
          <Text wrap="truncate-end"><Text color="claude">↓ </Text>{c.downstream?.length ?? 0} downstream: {list(c.downstream)}</Text>
          <Text wrap="truncate-end"><Text color={c.tests?.length ? 'success' : 'warning'}>✓ </Text>{c.tests?.length ?? 0} tests: {list(c.tests)}</Text>
          <Text><Text color="claude">▤ </Text>{c.documented ?? 0}/{c.columns ?? 0} columns documented</Text>
          {(c.tags?.length ?? 0) > 0 && <Text dimColor># {c.tags!.join(' ')}</Text>}
          {run && runChip && (
            <Text>
              <Text backgroundColor={runChip.color} color="inverseText" bold>{runChip.label}</Text> last run {run.seconds.toFixed(1)}s
              {run.rowsAffected !== undefined && <Text dimColor> · {run.rowsAffected.toLocaleString('en-US')} rows</Text>}
            </Text>
          )}
          {age && <Text dimColor>manifest built {age}</Text>}
          {improve && <Button key="improve" label="ask Claude to fill the gaps" onPress={() => $.prompt.fill({ text: improve, mode: 'append' })} />}
        </Box>
      </Box>
    )
  })

  // After a Read, Edit or Write of a dbt model, refresh its card. Matched per tool so these
  // pass-through hooks never wrap Bash, where a pass-through .catch would undo the guard's deny.
  // Three copies: the tool matcher takes one literal name, so a loop over the names does not type-check.
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined) await showModel($, e.file_path, false).catch(() => {})
    return ran
  }).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined) await showModel($, e.file_path, true).catch(() => {})
    return ran
  }).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined) await showModel($, e.file_path, true).catch(() => {})
    return ran
  }).catch(($, e, next) => next(e))

  // The guard, over every shell Claude has: Bash, and PowerShell on Windows. Other tools pass untouched.
  const isShell = (tool: string) => tool === 'Bash' || tool === 'PowerShell'
  on('tool.call', async ($, e, next) => {
    const cmd = e.tool === 'Bash' || e.tool === 'PowerShell' ? e.command : undefined
    if (cmd === undefined) return next(e)
    const deny = (why: string) => ({ deny: `${$.plugin.name}: ${why} Run it on dev, or have a human run it on prod.` })

    // SQL sent straight to Redshift (aws redshift-data, psql): prod by the database it names.
    for (const call of sqlCalls(cmd)) {
      // A SQL file that cannot be read throws, and the .catch below blocks the call.
      let sql = call.sql
      for (const file of call.files) sql += ';' + (await $.fs.read(file))
      const bad = destructiveSql(sql)
      if (bad === undefined) continue
      if (call.database === undefined) return deny(`${bad} through ${call.tool} with no database named is blocked.`)
      if (!isProdDb(call.database)) {
        const dir = await profilesDir($, HERE)
        if (dir !== undefined) await learnProdDatabases($, dir, prodTarget, learned)
      }
      if (isProdDb(call.database)) return deny(`${bad} through ${call.tool} on prod database ${call.database} is blocked.`)
    }

    // dbt: prod is the database dbt itself resolves for the target (or a target named prodDbtTarget).
    // Asked only for calls that could write: dbt takes seconds to start.
    // A session-wide DBT_FULL_REFRESH is not read: it changes only writes, which are checked anyway.
    const calls = dbtCalls(cmd)
    let resolved: Env[] = []
    for (const dbt of calls) {
      const showSql = dbt.hasShow ? destructiveSql(dbt.inlineSql ?? '') : undefined
      if (!dbt.isWrite && !dbt.fullRefresh && showSql === undefined) continue
      // The command's targets and the prod targets' databases, asked of dbt at once: each takes seconds.
      const dir = await profilesDir($, dbt)
      const [found, prods] = await Promise.all([dbtTargets($, dbt), dir === undefined ? [] : learnProdDatabases($, dir, prodTarget, learned)])
      // Fail closed: what cannot be told apart from prod is treated as prod.
      if ('error' in found) return { deny: `${$.plugin.name}: cannot tell which database this dbt command would use (${found.error}). Pass --profile and --target, or fix profiles.yml.` }
      for (const dev of found.envs.filter(e => !isProdEnv(e))) await loginTip($, dev, prods).catch(() => {}) // a tip is never worth failing the call
      resolved = found.envs
      const prod = found.envs.find(isProdEnv)
      const where = prod && `${envLabel(prod)}${prod.dbname ? ` (database ${prod.dbname})` : ''}`
      if (where && dbt.isWrite) return deny(`dbt ${dbt.verb} against ${where} is blocked.`)
      if (where && dbt.fullRefresh) return deny(`--full-refresh against ${where} is blocked.`)
      if (where && showSql) return deny(`${showSql} through dbt show on ${where} is blocked.`)
    }
    if (resolved.length === 1) {
      shown.dbt = resolved[0]
      $.ui.status(statusText())
    }

    // The panes follow the command's main dbt call: its write, else its first.
    const primary = calls.find(c => c.isWrite) ?? calls[0]
    const startedAt = await $.clock.now()
    const isTimed = primary !== undefined && TIMED.has(primary.verb)
    let spinner: { cancel: () => void } | undefined
    if (isTimed) {
      await update($, running, () => ({ command: `dbt ${primary.verb}`, startedAt }))
      spinner = $.clock.every(150, () => void update($, tick, t => t + 1))
      $.ui.open({ id: BOARD, title: '✻ dbt run' }).catch(() => {})
    }
    const stop = async () => {
      spinner?.cancel()
      if (isTimed) await update($, running, () => null)
    }
    const ran = await next(e).catch(async (err: unknown) => {
      await stop()
      throw err
    })
    await stop()
    const seconds = Math.round(((await $.clock.now()) - startedAt) / 1000)
    if (isTimed && ran.deny === undefined && seconds >= toastSeconds) {
      $.ui.toast(`${ran.isError ? '✗' : '✻'} dbt ${primary.verb} ${ran.isError ? 'FAILED' : 'passed'} in ${seconds}s`)
    }
    if (ran.deny === undefined) {
      const out: unknown = ran.result
      const stdout = typeof out === 'object' && out !== null && 'stdout' in out ? String(out.stdout) : ''
      await capture($, cmd, primary, stdout, startedAt)
    }
    return ran
  }).catch(($, e, next) =>
    next.called ? next(e) : isShell(e.tool) ? { deny: 'redshift-dbt-guard: its guard failed, so the command is blocked.' } : next(e),
  )
}
