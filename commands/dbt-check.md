---
description: Compile and test dbt models on a dev target, then summarize failures
argument-hint: [selector]
---
Check dbt models on a **dev** target. Selector: `$ARGUMENTS` (if empty, use `state:modified+` when a `target/manifest.json` from prod exists for `--state`, otherwise ask which models).

1. Pick the target: the default target of the profile in `dbt_project.yml`, if its database is not a prod database. Otherwise ask which dev target to use.
2. Run `dbt compile --target <dev target> --select <selector>`. On a compile error, show the error and the file, and stop.
3. Run `dbt test --target <dev target> --select <selector>`.
4. Summarize: tests passed and failed. For each failure: the test, the model, the failing row count, and a likely cause from the compiled SQL in `target/compiled/`.
5. Do not change any models unless asked.
