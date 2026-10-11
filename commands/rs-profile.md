---
description: Profile a Redshift table on a dev dbt target (row count, nulls, distincts, min/max)
argument-hint: <schema.table>
---
Profile the Redshift table `$ARGUMENTS` through dbt, on a **dev** target. Read-only: run SELECT statements only.

1. Pick the target: the default target of the profile in `dbt_project.yml`, if its database is not a prod database. Otherwise ask which dev target to use.
2. Get the columns: `dbt show --target <dev target> --output json --limit 1000 --inline "select column_name, data_type from svv_columns where table_schema || '.' || table_name = '$ARGUMENTS' order by ordinal_position"`.
3. Run one aggregate query the same way. Per column, it returns the null count and null %, the approximate distinct count (`approximate count(distinct ...)`), and min/max for numeric and date/time columns. Include the total row count.
4. Report a compact table, one row per column. Then flag columns that are all null, all one value, or have a suspicious null %.
