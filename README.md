# redshift-dbt-guard

A Claude Code mod for teams on Redshift + dbt.

- **Guard**: checks every command Claude runs in Bash or PowerShell. Prod is a target named `prod` **and the database it points at**: any other target that points at that database is prod too, with nothing to set. `prodDatabases` adds more.
  - dbt itself resolves the target, so any `profiles.yml` dbt accepts works: Jinja, `env_var()`, YAML anchors and merges, and every place dbt looks for the file. If dbt cannot resolve the target, writes are blocked with dbt's error.
  - It reads the whole command: chained calls (`&&`, `;`, `|`, new lines), flags before the dbt command, `cd` and `Set-Location`, and `DBT_TARGET`, `DBT_PROFILE`, `DBT_PROFILES_DIR`, `DBT_PROJECT_DIR` and `DBT_FULL_REFRESH`, whether set inline, with `export`, or with `$env:`.
  - On prod it blocks:
    - `dbt run|build|seed|snapshot|run-operation|retry|clone` and `--full-refresh`.
    - `DROP`, `TRUNCATE`, `DELETE`/`UPDATE` without `WHERE`, `ALTER TABLE ... DROP` and `GRANT`/`REVOKE`, whether in `dbt show --inline`, or sent through `aws redshift-data` or `psql` to a prod database (inline or in SQL files). That SQL with no database named is blocked too.
  - It does not block `dbt compile|test|ls|docs|show` with read-only SQL.
- **Status line**: shows the live dbt target and its database, for example `✻  dbt:shop.dev (dev_alice)`, or `⚠ PROD  dbt:shop.prod (analytics)`.
- **dbt run board** (pane): opens with a Claude-style spinner while dbt runs. After each `dbt run`, `build`, `test`, `seed` or `snapshot`, it shows counts by status, failures with their messages, and the slowest models with status chips and bars colored green to red by run time. It reads `target/run_results.json`. Reopen it with `/dbt-board`.
- **Query results** (pane): after `dbt show --output json` (or `aws redshift-data get-statement-result`), it shows the rows as a table you page through with `p` and `n`, plus a small area chart per numeric column (a sparkline outside the terminal). Reopen it with `/rs-results`.
- **Schema browser** (pane, `/rs-schema`):
  - Pick any `profile.target` from your `profiles.yml`. Prod ones are marked ⚠.
  - Search every column as you type, e.g. `orders cust`. Exact column names get a ✓, and "no column matches" tells you a field does not exist.
  - Press a row to put `schema.table.column` in your prompt.
  - Columns come from `svv_columns`, read through `dbt show` with your own dbt login. They are cached per target across sessions, and reload with the refresh button.
- **dbt model card** (pane, `/dbt-model`): when Claude reads or edits `models/**/*.sql`, it shows the model's materialization, relation, description, upstream and downstream models, tests, documented columns and last run. It reads `target/manifest.json`; run `dbt parse` to refresh it.
- **Ask Claude buttons**: they put a prompt in your prompt box for you to read and send. Nothing is sent on its own.
  - `fix` on each failed model or test in the dbt run board.
  - `explain` (`e`) in the query results pane.
  - "ask Claude to fill the gaps" on a model card missing a description, tests or column docs.
- **Team conventions for Claude**: a short section at the end of Claude's system prompt. It says to query through `dbt show --output json` on a dev target, so the results pane fills, and to pass `--target`. It also names the prod databases from your settings, and tells Claude not to work around a block.
- **Toast**: fires when a `dbt run|build|test` takes longer than the threshold.
- **Slash commands**:
  - `/rs-profile <schema.table>` profiles a table on a dev target through `dbt show`.
  - `/dbt-check [selector]` compiles and tests models on dev, then summarizes failures.

## Install

Private repo: you need read access, and `gh auth login` done on your machine.

Type this at the prompt of a terminal Claude Code session:

```
/plugin install redshift-dbt-guard --marketplace rBingz/redshift-dbt-guard
```

Answer `y` to add the marketplace. Pick the **user** scope.

`dbt` must be on your PATH, with your `profiles.yml` in `~/.dbt` or `$DBT_PROFILES_DIR`.

## Configure

Run `/config` to change these:

| Setting | Default | Meaning |
| --- | --- | --- |
| `prodDatabases` | (none) | More databases treated as prod, comma-separated, beyond those your `prod` targets point at |
| `prodDbtTarget` | `prod` | dbt target name also treated as prod |
| `toastSeconds` | `60` | Toast when a dbt run takes at least this long |

Most teams need no settings: the guard asks dbt where each profile's `prod` target points, and treats that database as prod. If no profile has a target named `prod` (or `prodDbtTarget`) and `prodDatabases` is empty, the mod shows a warning at session start, because then it knows no prod database.

## Limits

- The SQL check is a regex scan, not a parser. A script that hides SQL (`bash run.sh`), a GUI client, or SQL built at run time slips past. The guard is a seatbelt, not a permission system. Keep real prod rights in database grants.
- The guard finds a command's profile from `--profile` or the `dbt_project.yml` it runs in. When it cannot, it checks every profile with that target name, and prod wins: `dbt run --target dev` outside a project is blocked if any profile's `dev` points at a prod database.
- The first dbt write per target waits for dbt to start and resolve the target (about 8 seconds on Windows). The answer is kept until `profiles.yml` changes; an environment variable that `profiles.yml` reads takes effect in the next session. Reads (`dbt test`, `ls`, `compile`, `show` with a SELECT) never wait.
- Quoted text is never read as a command, but each line of a heredoc body is. A dbt write written there is checked as if it ran.
- After `popd` the guard cannot tell the folder, so it checks every profile and prod wins.
- The schema browser keeps only the newest target's columns between sessions: the shared store holds 4 MiB.
- The schema picker lists targets written in block-style YAML. Outputs written in flow style (`outputs: {dev: ...}`) or as an alias do not show in the picker; the guard still covers them.
- Panes open on their own only when the terminal is wide enough (about 110–144 columns); otherwise use `/dbt-board` or `/rs-results`. The results pane keeps the first 1,000 rows.
- The model card cannot read a `manifest.json` over 4 MiB, and the schema browser refuses a catalog over 4 MiB of output.

## Develop

```
claude plugin validate .
claude plugin test .
```
