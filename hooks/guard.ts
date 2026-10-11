// Pure command checks. No `$` here, so tests can call them directly.

// shortcut: regex scan, not a SQL parser; SQL in comments or string literals can trip it, and a
// script that hides the SQL slips past. Upgrade to a real parser if the team hits false positives or misses.
const DESTRUCTIVE: [RegExp, string][] = [
  [/\bdrop\s+(table|schema|view|materialized\s+view|database|function|procedure|user|group)\b/i, 'DROP'],
  [/\btruncate\b/i, 'TRUNCATE'],
  [/\balter\s+table\b[^;]*\bdrop\b/i, 'ALTER TABLE ... DROP'],
  [/\b(grant|revoke)\b/i, 'GRANT/REVOKE'],
]

export function destructiveSql(sql: string): string | undefined {
  for (const stmt of sql.split(';')) {
    for (const [re, label] of DESTRUCTIVE) if (re.test(stmt)) return label
    if (/\b(delete|update)\b/i.test(stmt) && !/\bwhere\b/i.test(stmt)) return 'DELETE/UPDATE without WHERE'
  }
}

// Words of one shell command, in parts between &&, ||, ;, |, newlines, parentheses and backticks,
// quotes kept together and removed. Works for bash and PowerShell alike, which share these separators,
// and a subshell such as `$(dbt run)` is read as a part of its own.
// shortcut: no expansion of variables or heredoc bodies (a heredoc's lines read as
// commands, which can only block more, never less).
export function shellParts(cmd: string): string[][] {
  const parts: string[][] = []
  let words: string[] = []
  let word: string | undefined
  let quote: string | undefined
  const endWord = () => {
    if (word !== undefined) words.push(word)
    word = undefined
  }
  const endPart = () => {
    endWord()
    if (words.length) parts.push(words)
    words = []
  }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!
    if (quote) {
      if (c === quote) quote = undefined
      else word = (word ?? '') + c
    } else if (c === '"' || c === "'") {
      quote = c
      word = word ?? ''
    } else if (';\n|()`'.includes(c) || (c === '&' && cmd[i + 1] === '&')) {
      if (c === '&' || (c === '|' && cmd[i + 1] === '|')) i++
      endPart()
    } else if (/\s/.test(c)) {
      endWord()
    } else {
      word = (word ?? '') + c
    }
  }
  endPart()
  return parts
}

export const DBT_WRITES = new Set(['run', 'build', 'seed', 'snapshot', 'run-operation', 'retry', 'clone'])
const DBT_COMMANDS = new Set([...DBT_WRITES, 'clean', 'compile', 'debug', 'deps', 'docs', 'init', 'list', 'ls', 'parse', 'show', 'source', 'test'])
// Flags whose value can be a command's name (`--resource-type seed`, `--select run`): that value is no command.
const VALUE_FLAGS = new Set(['-s', '--select', '--exclude', '-m', '--models', '--selector', '--resource-type', '--resource-types', '--exclude-resource-type', '--exclude-resource-types'])
const DBT_ENV = ['DBT_TARGET', 'DBT_PROFILE', 'DBT_PROFILES_DIR', 'DBT_PROJECT_DIR', 'DBT_FULL_REFRESH'] as const
export const isTruthy = (v: string | undefined) => v !== undefined && /^(1|true|yes|y|on)$/i.test(v.trim())

export type DbtCall = {
  verb: string // its dbt command, for the panes; '' when none is named
  isWrite: boolean // any write command among its words, wherever flags put it
  hasShow: boolean
  target?: string
  profile?: string
  profilesDir?: string
  projectDir?: string
  fullRefresh: boolean
  inlineSql?: string
  cwd?: string // the folder it runs in, joined from every cd before it; undefined after popd
}

const isAbsolute = (p: string) => /^([A-Za-z]:)?[\\/]/.test(p) || p.startsWith('~')
export const joinPath = (base: string | undefined, p: string) => (base === undefined || base === '.' || isAbsolute(p) ? p : `${base}/${p}`)
const isProgram = (word: string, name: string) => new RegExp(`(^|[\\\\/])${name}(\\.exe)?$`, 'i').test(word)

// What a shell command changes for the parts after it: the folder (cd, pushd, Set-Location)
// and environment variables (export X=v, $env:X = 'v'). Inline `X=v cmd` is that part's alone.
type Shell = { cwd: string | undefined; env: Record<string, string> }

function step(shell: Shell, words: string[]): { words: string[]; env: Record<string, string> } {
  const env = { ...shell.env }
  let i = 0
  for (; i < words.length && /^\w+=/.test(words[i]!); i++) env[words[i]!.split('=')[0]!] = words[i]!.slice(words[i]!.indexOf('=') + 1)
  if (words[i] === 'env') for (i++; i < words.length && /^\w+=/.test(words[i]!); i++) env[words[i]!.split('=')[0]!] = words[i]!.slice(words[i]!.indexOf('=') + 1)
  const rest = words.slice(i)
  const head = rest[0]?.toLowerCase()
  if (head === 'export' || head === 'set') {
    for (const w of rest.slice(1)) if (/^\w+=/.test(w)) shell.env[w.split('=')[0]!] = w.slice(w.indexOf('=') + 1)
  } else if (head !== undefined && /^\$env:\w+/i.test(rest[0]!)) {
    // $env:X = 'v', $env:X='v' or $env:X= 'v'
    const joined = rest.join(' ')
    const m = joined.match(/^\$env:(\w+)\s*=\s*(.*)$/i)
    // An empty value was set from a subshell, `$env:X = (...)`: keep `$`, a name no target has, as bash's `X=$(...)` does.
    if (m) shell.env[m[1]!.toUpperCase()] = m[2]!.trim() || '$'
  } else if (head && ['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location'].includes(head)) {
    // No path we can read (bare `cd`, or `Set-Location (Join-Path ...)`): the folder is unknown.
    const to = rest.slice(1).find(w => !w.startsWith('-'))
    shell.cwd = to === undefined || shell.cwd === undefined ? undefined : joinPath(shell.cwd, to)
  } else if (head === 'popd' || head === 'pop-location') {
    shell.cwd = undefined
  }
  return { words: rest, env }
}

// Every dbt call in a shell command, wherever it sits: chained, after flags with values, under
// `uv run` or `python -m`, with DBT_* variables set before it or inline.
export function dbtCalls(cmd: string): DbtCall[] {
  const shell: Shell = { cwd: '.', env: {} }
  const calls: DbtCall[] = []
  for (const part of shellParts(cmd)) {
    const { words, env } = step(shell, part)
    const at = words.findIndex(w => isProgram(w, 'dbt'))
    if (at < 0) continue
    const after = words.slice(at + 1)
    const flag = (...names: string[]) => {
      for (let i = 0; i < after.length; i++) {
        for (const n of names) {
          if (after[i] === n) return after[i + 1]
          if (after[i]!.startsWith(`${n}=`)) return after[i]!.slice(n.length + 1)
        }
      }
    }
    const fromEnv = Object.fromEntries(DBT_ENV.map(k => [k, env[k]]))
    const known = after.filter((w, i) => DBT_COMMANDS.has(w) && !VALUE_FLAGS.has(after[i - 1] ?? ''))
    const profilesDir = flag('--profiles-dir') ?? fromEnv.DBT_PROFILES_DIR
    const projectDir = flag('--project-dir') ?? fromEnv.DBT_PROJECT_DIR
    calls.push({
      verb: known.find(w => DBT_WRITES.has(w)) ?? known.find(w => w !== 'debug') ?? known[0] ?? '',
      isWrite: known.some(w => DBT_WRITES.has(w)),
      hasShow: known.includes('show'),
      target: flag('--target', '-t') ?? fromEnv.DBT_TARGET,
      profile: flag('--profile') ?? fromEnv.DBT_PROFILE,
      profilesDir: profilesDir && joinPath(shell.cwd, profilesDir),
      projectDir: projectDir && joinPath(shell.cwd, projectDir),
      fullRefresh: after.includes('--full-refresh') || after.includes('-f') || isTruthy(fromEnv.DBT_FULL_REFRESH),
      inlineSql: flag('--inline'),
      cwd: shell.cwd,
    })
  }
  return calls
}

// SQL a shell command sends straight to Redshift: `aws redshift-data execute-statement` and psql.
export type SqlCall = { tool: string; database?: string; sql: string; files: string[] }

export function sqlCalls(cmd: string): SqlCall[] {
  const shell: Shell = { cwd: '.', env: {} }
  const calls: SqlCall[] = []
  for (const part of shellParts(cmd)) {
    const { words } = step(shell, part)
    const values = (...names: string[]) =>
      words.flatMap((w, i) => names.flatMap(n => (w === n ? [words[i + 1] ?? ''] : w.startsWith(`${n}=`) ? [w.slice(n.length + 1)] : [])))
    const file = (p: string) => joinPath(shell.cwd, p)
    if (words.some(w => isProgram(w, 'aws')) && words.includes('redshift-data') && words.some(w => /execute-statement$/.test(w))) {
      const sqls = values('--sql', '--sqls')
      calls.push({
        tool: 'aws redshift-data',
        database: values('--database')[0],
        sql: sqls.filter(s => !s.startsWith('file://')).join(';'),
        files: sqls.filter(s => s.startsWith('file://')).map(s => file(s.slice('file://'.length))),
      })
    } else if (words.some(w => isProgram(w, 'psql'))) {
      const conn = words.find(w => /^postgres(ql)?:\/\//.test(w) || /\bdbname=/.test(w))
      const fromConn = conn?.match(/dbname=([\w-]+)/)?.[1] ?? conn?.match(/^postgres(?:ql)?:\/\/[^/]*\/([\w-]+)/)?.[1]
      // Files from -f, and from stdin: `< x.sql` or `<x.sql` (not a `<<` heredoc).
      const redirected = [...values('<'), ...words.filter(w => /^<[^<]/.test(w)).map(w => w.slice(1))]
      calls.push({ tool: 'psql', database: values('-d', '--dbname')[0] ?? fromConn, sql: values('-c', '--command').join(';'), files: [...values('-f', '--file'), ...redirected].map(file) })
    }
  }
  return calls
}

// Profile names and each profile's output names, for listing only. Every value (default target,
// database) comes from dbt itself, so Jinja, env_var(), anchors and merges resolve as dbt resolves them.
// shortcut: reads block-style keys; outputs written in flow style or as an alias are not listed,
// which hides them from the picker only: the guard asks dbt either way.
export function listProfiles(yml: string): Record<string, string[]> {
  const profiles: Record<string, string[]> = {}
  const hasOutputs = new Set<string>()
  let profile: string | undefined
  let outputsIndent = -1 // indent of `outputs:`, -1 outside that block
  let outputIndent = -1 // indent of the output names under it
  for (const raw of yml.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(raw) || /^(---|\.\.\.)\s*$/.test(raw)) continue
    const m = raw.match(/^(\s*)(?:"([^"]+)"|'([^']+)'|([^\s"'#:][^#:]*?))\s*:(?:\s|$)/)
    if (!m) continue
    const indent = m[1]!.length
    const key = m[2] ?? m[3] ?? m[4]!
    if (indent === 0) {
      profile = key === 'config' ? undefined : key
      if (profile !== undefined) profiles[profile] = []
      outputsIndent = -1
      continue
    }
    if (profile === undefined) continue
    if (outputsIndent >= 0 && indent <= outputsIndent) outputsIndent = -1 // left the outputs block
    if (outputsIndent < 0) {
      if (key === 'outputs') {
        hasOutputs.add(profile)
        outputsIndent = indent
        outputIndent = -1
      }
    } else if (key !== '<<' && (outputIndent < 0 || indent === outputIndent)) {
      outputIndent = indent
      profiles[profile]!.push(key)
    }
  }
  // A top-level key with no outputs is no profile (an anchor holder such as `.defaults: &d`).
  return Object.fromEntries(Object.entries(profiles).filter(([name]) => hasOutputs.has(name)))
}

// Inline Jinja that makes dbt print the target it resolved. dbt prints it before it connects,
// so the mod reads that one line and stops dbt.
export const RESOLVE_SQL =
  "{{ print('DBTGUARD ' ~ tojson({'profile': target.profile_name, 'target': target.name, 'db': target.get('dbname') or target.get('database')})) }}select 1"

export type Resolved = { profile: string; target: string; dbname?: string }

export function parseResolved(text: string): Resolved | undefined {
  const line = text.match(/^DBTGUARD (\{.*\})\s*$/m)?.[1]
  if (line === undefined) return
  try {
    const r = JSON.parse(line) as { profile?: unknown; target?: unknown; db?: unknown }
    if (typeof r.profile !== 'string' || typeof r.target !== 'string') return
    return { profile: r.profile, target: r.target, dbname: typeof r.db === 'string' && r.db ? r.db : undefined }
  } catch {
    return
  }
}
