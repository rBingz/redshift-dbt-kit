// Test helper: a fake `dbt` for process.spawn that answers the guard's RESOLVE_SQL the way the
// real one does once it has rendered profiles.yml: the resolved line first, then a connection
// attempt the mod never waits for.
import type { On } from 'claude-code'

export const RESOLVES: Record<string, { default: string; dbs: Record<string, string> }> = {
  shop: { default: 'dev', dbs: { dev: 'dev_alice', bobdev: 'dev_bob', prod: 'analytics' } },
  billing: { default: 'dev', dbs: { dev: 'analytics' } },
}

// The same profiles as a teammate might write them: anchors, a merge, Jinja, quoting.
export const PROFILES_YML = [
  '.redshift: &redshift',
  '  type: redshift',
  '  host: "{{ env_var(\'DBT_HOST\') }}"',
  'shop:',
  '  outputs:',
  '    dev:',
  '      <<: *redshift',
  '      dbname: "{{ env_var(\'DBT_DEV_DB\', \'dev_alice\') }}"',
  '    bobdev:',
  '      <<: *redshift',
  '      dbname: dev_bob',
  '    prod:',
  '      <<: *redshift',
  "      dbname: 'analytics'",
  '  target: "{{ env_var(\'DBT_TARGET\', \'dev\') }}"',
  'billing: # writes to the prod database from its dev target',
  '  outputs:',
  '    dev:',
  '      <<: *redshift',
  '      dbname: analytics',
  '  target: dev',
  '',
].join('\n')

export function fakeDbt(on: On, calls: string[][] = []) {
  on('process.spawn', async function* ($, e) {
    calls.push([...e.argv])
    const arg = (flag: string) => {
      const i = e.argv.indexOf(flag)
      return i >= 0 ? e.argv[i + 1] : undefined
    }
    const profile = arg('--profile') ?? ''
    const p = RESOLVES[profile]
    if (p === undefined) {
      yield { stream: 'stdout' as const, text: `Runtime Error\n  Could not find profile named '${profile}'\n` }
      return { value: { code: 2, signal: null } }
    }
    const target = arg('--target') ?? p.default
    const db = p.dbs[target]
    if (db === undefined) {
      yield { stream: 'stdout' as const, text: `Runtime Error\n  The profile '${profile}' does not have a target named '${target}'.\n` }
      return { value: { code: 2, signal: null } }
    }
    yield { stream: 'stdout' as const, text: `DBTGUARD ${JSON.stringify({ profile, target, db })}\n` }
    yield { stream: 'stdout' as const, text: 'Database Error\n  connection time out\n' }
    return { value: { code: 2, signal: null } }
  })
}
