// Schema catalog and dbt manifest helpers. No `$` here, so tests can call them directly.
import type { ModelCard } from '../types'

// One row per column, `schema.table.column<TAB>type`. No ORDER BY: dbt show wraps it in a limited subquery.
export const CATALOG_SQL = `select table_schema || '.' || table_name || '.' || column_name || chr(9) || data_type as c
from svv_columns
where table_schema not in ('pg_catalog', 'information_schema', 'pg_internal') and table_schema not like 'pg_temp%'`

// Rows of `dbt show --output json`: the JSON object between log lines, under `show`. dbt indents
// it, so the first `}` that starts a line closes it; warnings such as a deprecation summary follow.
export function parseDbtShow(stdout: string): Record<string, unknown>[] | undefined {
  const start = stdout.search(/^{/m)
  if (start < 0) return
  const end = stdout.slice(start).search(/^}/m)
  try {
    const doc = JSON.parse(stdout.slice(start, end < 0 ? undefined : start + end + 1)) as { show?: unknown }
    return Array.isArray(doc.show) ? (doc.show as Record<string, unknown>[]) : undefined
  } catch {
    return
  }
}

export type Match = { name: string; type: string; parts: { text: string; isHit: boolean }[]; isExact: boolean }

// Every whitespace-separated term must appear in `schema.table.column`; exact column names sort first.
export function searchCatalog(columns: readonly string[], query: string, limit: number): { total: number; matches: Match[] } {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return { total: 0, matches: [] }
  const hits: Match[] = []
  let total = 0
  for (const line of columns) {
    const [name = '', type = ''] = line.split('\t')
    const lower = name.toLowerCase()
    if (!terms.every(t => lower.includes(t))) continue
    total++
    const column = lower.slice(lower.lastIndexOf('.') + 1)
    const isExact = terms.includes(column)
    // shortcut: keeps the first `limit` matches (exact ones moved up among them); fine for a field check
    if (hits.length < limit || isExact) hits.push({ name, type, parts: highlight(name, terms), isExact })
  }
  hits.sort((a, b) => Number(b.isExact) - Number(a.isExact))
  return { total, matches: hits.slice(0, limit) }
}

function highlight(name: string, terms: string[]): Match['parts'] {
  const lower = name.toLowerCase()
  const marked = new Array<boolean>(name.length).fill(false)
  for (const t of terms) for (let i = lower.indexOf(t); i >= 0; i = lower.indexOf(t, i + 1)) marked.fill(true, i, i + t.length)
  const parts: Match['parts'] = []
  for (let i = 0; i < name.length; i++) {
    const last = parts[parts.length - 1]
    if (last && last.isHit === marked[i]) last.text += name[i]
    else parts.push({ text: name[i]!, isHit: marked[i]! })
  }
  return parts
}

export type ManifestNode = {
  name: string
  resource_type: string
  description?: string
  relation_name?: string | null
  config?: { materialized?: string }
  tags?: string[]
  depends_on?: { nodes?: string[] }
  columns?: Record<string, { description?: string }>
}
export type Manifest = { metadata?: { generated_at?: string }; nodes?: Record<string, ManifestNode>; child_map?: Record<string, string[]> }

// `model.proj.orders` -> `orders`, `source.proj.raw.payments` -> `src:raw.payments`, `seed.proj.x` -> `seed:x`.
function label(manifest: Manifest, id: string): string {
  const [kind, , ...rest] = id.split('.')
  const name = manifest.nodes?.[id]?.name ?? rest.join('.')
  return kind === 'model' ? name : `${kind === 'source' ? 'src' : kind}:${kind === 'source' ? rest.join('.') : name}`
}

export function modelCard(manifest: Manifest, name: string): ModelCard {
  const entry = Object.entries(manifest.nodes ?? {}).find(([, n]) => n.resource_type === 'model' && n.name === name)
  if (entry === undefined) return { name, error: 'not in target/manifest.json yet: run dbt parse or dbt compile' }
  const [id, node] = entry
  const children = manifest.child_map?.[id] ?? []
  const columns = Object.values(node.columns ?? {})
  return {
    name,
    relation: node.relation_name ?? undefined,
    materialized: node.config?.materialized,
    description: node.description || undefined,
    tags: node.tags ?? [],
    upstream: (node.depends_on?.nodes ?? []).map(n => label(manifest, n)),
    downstream: children.filter(c => !c.startsWith('test.')).map(c => label(manifest, c)),
    tests: children.filter(c => c.startsWith('test.')).map(c => manifest.nodes?.[c]?.name ?? c),
    columns: columns.length,
    documented: columns.filter(c => c.description).length,
    generatedAt: manifest.metadata?.generated_at,
  }
}

// `<project>/models/.../<name>.sql` -> project dir and model name; undefined for any other path.
export function modelPath(filePath: string): { project: string; name: string } | undefined {
  const m = filePath.replace(/\\/g, '/').match(/^(.*?)\/models\/(?:.*\/)?([^/]+)\.sql$/)
  return m ? { project: m[1]!, name: m[2]! } : undefined
}

export function ago(ms: number): string {
  const m = Math.floor(ms / 60000)
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`
}
