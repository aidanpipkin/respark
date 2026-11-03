# Exporting the Base44 data

`scripts/import-base44.ts` expects a folder with one file per entity, `<EntityName>.jsonl`
(`Lead.jsonl`, `AgentSettings.jsonl`, `MessageLog.jsonl`, ...), one record per line, with the
field names exactly as the Base44 entities API returns them (`id`, `created_date`, `updated_date`,
`created_by_id`, `created_by`, `is_sample`, then the schema fields). Unknown fields are reported and
dropped; `created_by` has no column and is dropped silently.

## How the exports are produced

The Base44 MCP connector in this chat (`query_entities` / `execute_api`) can read every entity of
the app, so the exports are pulled from the chat, not from inside Base44:

1. `list_entity_schemas` to confirm the 36 entity names match `legacy_base44/entities/*.jsonc`.
2. For each entity, page through `query_entities` (or `execute_api` on
   `GET /api/apps/{appId}/entities/{Entity}?limit=1000&skip=N&sort=created_date`) until a page
   comes back short. Use `sort=created_date` and `skip` so a re-run returns rows in the same order;
   Base44 pages cap at 1000 rows. Write each page's records as JSON lines to `exports/<Entity>.jsonl`.
3. Export order does not matter for the importer, but take `MessageLog`, `Lead` and
   `ConversationSummary` last so they are as fresh as possible, and re-export those three right
   before the final cut-over (the importer upserts on `id`, so re-importing is safe).
4. Keep the files out of git (`exports/` is a good folder name; add it to `.gitignore`).

Expected sizes: `MessageLog` and `MessageDispatch` are the big ones (thousands of rows per live
agent); everything else is small.

## Fields that need attention

- `User` is not imported. Supabase Auth owns users: invite each agent with
  `supabase.auth.admin.inviteUserByEmail` (the `inviteAgent` function does this) or from the
  dashboard. A `profiles` row is created by trigger; the platform owner (`PlatformSettings.owner_email`)
  becomes `admin` automatically, everyone else `agent`. Promote other admins with
  `update public.profiles set role = 'admin' where email = '...'`.
- Timestamps in exports look like `2026-08-19T01:27:12.951000` (UTC, no offset). The importer
  appends `Z`; the trigger that maintains `updated_date` is bypassed during import so the original
  value survives.
- Enum fields are CHECK-constrained from the jsonc enums. Rows with values outside the enum land
  in `exports/failed/<Entity>.jsonl` with the error; fix the value or extend the enum in the jsonc,
  rerun `scripts/gen-schema.ts`, and re-import.
- Fields with `"rls": {"read": false}` (tokens, GHL ids, Stripe ids) import as-is. They are only
  reachable through the service role and the admin policies; agents read the `v_<table>` views.

## Running the import

```
export DATABASE_URL='postgres://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres'
deno run -A scripts/import-base44.ts --dir ./exports --dry-run     # parse and report only
deno run -A scripts/import-base44.ts --dir ./exports               # upsert in batches of 200
deno run -A scripts/import-base44.ts --dir ./exports --only Lead,MessageLog   # refresh before cut-over
```

Use the direct connection string (port 5432) or the session pooler; the script sets a per-transaction
flag and works through the transaction pooler too. The exit code is non-zero when any row failed.
