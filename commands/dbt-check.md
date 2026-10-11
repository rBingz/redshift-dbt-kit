---
description: Compile and test dbt models on the dev target, then summarize failures
argument-hint: [selector]
---
Check dbt models on the **dev** target. Selector: `$ARGUMENTS` (if empty, use `state:modified+` when a `target/manifest.json` from prod exists for `--state`, otherwise ask which models).

1. Run `dbt compile --target dev --select <selector>`. On a compile error, show the error and the file, and stop.
2. Run `dbt test --target dev --select <selector>`.
3. Summarize: tests passed and failed. For each failure: the test, the model, the failing row count, and a likely cause from the compiled SQL in `target/compiled/`.
4. Do not change any models unless asked.
