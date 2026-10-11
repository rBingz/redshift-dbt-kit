// The /kit tour: one page per feature after the setup check. No `$` here, so tests can call it directly.

export type TourPage = {
  title: string
  lines: string[]
  // A "try it" button: puts `prompt` in the prompt box for the person to send.
  tryIt?: { label: string; prompt: string }
}

export function tourPages(prodTarget: string, dev?: { profile: string; target: string }): TourPage[] {
  const devFlags = dev ? `--profile ${dev.profile} --target ${dev.target}` : '--target <your dev target>'
  return [
    {
      title: 'Guard',
      lines: [
        'Checks every command Claude runs, before it runs.',
        'On prod it blocks dbt run, build, seed, snapshot, run-operation, retry, clone and --full-refresh, and destructive SQL (DROP, TRUNCATE, DELETE without WHERE...).',
        `Prod is the target "${prodTarget}" and every database a prod target points at: the Setup page lists them.`,
        'Claude cannot override a block. Prod runs stay with you or your scheduler.',
      ],
      tryIt: {
        label: 'see a block',
        prompt: `Show me the redshift-dbt-kit guard: run \`echo dbt run --target ${prodTarget}\`. It is only echo, so nothing runs even if it were allowed.`,
      },
    },
    {
      title: 'Status line',
      lines: [
        'The bottom of the screen shows the live dbt target and its database, for example:',
        '  ✻  dbt:shop.dev (dev_alice)',
        '  ⚠ PROD  dbt:shop.prod (analytics)',
        'It follows the dbt project you start Claude Code in, and each dbt write Claude runs.',
      ],
    },
    {
      title: 'dbt run board',
      lines: [
        'After each dbt run, build, test, seed or snapshot, a pane shows counts by status, each failure with its message, and the slowest models.',
        'A spinner shows while dbt runs. A toast tells you when a long run ends.',
        'Reopen it with /dbt-board.',
      ],
      tryIt: { label: 'run a test', prompt: `Run \`dbt test ${devFlags}\` on one small model that has tests, and show me the run board.` },
    },
    {
      title: 'Query results',
      lines: [
        'After `dbt show --output json`, a pane shows the rows as a table you page through with p and n, with a chart per numeric column.',
        'Claude queries this way on its own: ask it a question about your data.',
        'Reopen it with /rs-results.',
      ],
      tryIt: { label: 'query a table', prompt: `Ask me which table I want to look at, then show me 20 rows of it with \`dbt show ${devFlags} --output json --limit 20\`.` },
    },
    {
      title: 'Schema search',
      lines: [
        'Does this field exist? /rs-schema searches every column of a target as you type, e.g. "orders cust".',
        'Exact column names get a ✓. Press a row to put schema.table.column in your prompt.',
        'Pick any target from your profiles.yml; prod ones are marked ⚠.',
      ],
      tryIt: { label: 'open schema search', prompt: '/rs-schema' },
    },
    {
      title: 'Model card',
      lines: [
        'When Claude reads or edits a model, /dbt-model shows its materialization, relation, upstream and downstream models, tests, documented columns and last run.',
        'It reads target/manifest.json: run dbt parse to refresh it.',
      ],
      tryIt: { label: 'see a card', prompt: 'Open one of my dbt models and tell me what it does. I want to see its model card.' },
    },
    {
      title: 'Ask Claude buttons',
      lines: [
        'Panes put ready-made prompts in your prompt box. You read them and send them; nothing is sent on its own.',
        '  fix: on each failed model or test in the run board',
        '  explain: in the query results',
        '  fill the gaps: on a model card missing docs or tests',
      ],
    },
    {
      title: 'Slash commands',
      lines: [
        '/rs-profile <schema.table>: row count, nulls, distincts and min/max of a table, on a dev target.',
        '/dbt-check [selector]: compiles and tests models on dev, then summarizes failures.',
        '/kit: this tour and the setup check, any time.',
      ],
      tryIt: { label: 'profile a table', prompt: '/rs-profile ' },
    },
  ]
}

// The version `dbt --version` prints: `installed: 1.10.11`, or a bare version on old dbt.
export function dbtVersion(text: string): string | undefined {
  return text.match(/installed:\s*v?(\d+\.\d+\.\d+)/)?.[1] ?? text.match(/\b(\d+\.\d+\.\d+)\b/)?.[1]
}
