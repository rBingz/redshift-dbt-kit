export type BoardRow = { name: string; status: string; seconds: number; rowsAffected?: number; message?: string }
export type Board = { command: string; elapsed: number; rows: BoardRow[] }
export type Running = { command: string; startedAt: number }
export type QueryResult = { id: string; columns: { name: string; type: string }[]; rows: (string | null)[][]; total: number; isOrdered?: boolean }
export type Catalog = {
  status: 'empty' | 'loading' | 'ready' | 'error'
  message?: string
  source?: string
  fetchedAt?: number
  columns: string[]
}
export type Env = { profile: string; target: string; dbname?: string }
// One line of the /kit setup check: `fix` says what to do when it is not ok.
export type Check = { key: string; label: string; state: 'checking' | 'ok' | 'warn' | 'fail'; detail: string; fix?: string }
// `dev`: the target the tour's "try it" prompts use.
export type Setup = { checks: Check[]; dev?: { profile: string; target: string } }
export type ModelCard = {
  name: string
  error?: string
  relation?: string
  materialized?: string
  description?: string
  tags?: string[]
  upstream?: string[]
  downstream?: string[]
  tests?: string[]
  columns?: number
  documented?: number
  generatedAt?: string
}

declare module 'claude-code' {
  interface PluginState {
    'redshift-dbt-kit': {
      board: Board | null
      results: QueryResult | null
      page: number
      running: Running | null
      tick: number
      catalog: Catalog
      search: string
      card: ModelCard | null
      env: Env | null
      envs: Env[]
      setup: Setup
      tour: number
    }
  }
}
