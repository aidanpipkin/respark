# Porting the Base44 backend to Supabase

What exists already:

| Piece | Where | Notes |
|---|---|---|
| Postgres schema, indexes, RLS, `profiles` | `supabase/migrations/0001_schema.sql` | Generated from `legacy_base44/entities/*.jsonc` by `scripts/gen-schema.ts`; edit the generator or the jsonc, never the SQL. |
| Crons and the booked-appointment trigger | `supabase/migrations/0002_cron_and_triggers.sql` | pg_cron + pg_net; needs two Vault secrets (below). |
| Legacy Respark fold-in columns (verbatim steps, campaign send rules, Microsoft 365 connection) | `supabase/migrations/0003_legacy_respark_fold_in.sql` | Hand-written; `schema.ts` edited to match. See `docs/LEGACY_RESPARK_FOLD_IN.md`. |
| Base44 entity SDK on Postgres | `supabase/functions/_shared/entities.ts` | `filter/list/get/create/bulkCreate/update/bulkUpdate/updateMany/upsert/count/delete/deleteMany`, Mongo-style queries, cursors. |
| Base44 runtime (`createClientFromRequest`, `secrets`, `waitUntil`, integrations) | `supabase/functions/_shared/runtime.ts` | Also `serve()` (CORS + Deno.serve) and `corsHeaders`. |
| Column metadata used by the adapter | `supabase/functions/_shared/schema.ts` | Generated; `ENTITIES[name] = {table, columns, hidden, ownerField}`. |
| Legacy shared modules, imports swapped | `supabase/functions/_shared/*.ts` (69 files) | Copied by `scripts/port-function.ts`; otherwise untouched (one fix, see Known issues). |
| Worked example | `supabase/functions/health/` | `handler.ts` is the legacy entry with imports swapped, `index.ts` serves it. |
| Email templates (MJML compiled to HTML) | `supabase/functions/_shared/emails/` | `{{var}}` placeholders kept; subject in `*.subject.txt`. |
| Data import | `scripts/import-base44.ts`, `scripts/export-base44.md` | Upsert on id, keeps timestamps. |
| Tests | `scripts/test.sh` | Starts a throwaway Postgres, applies the migration, runs `deno test` for the adapter and runtime. |

## 1. Port one function

```
deno run -A scripts/port-function.ts <name>        # e.g. sequenceSender
```

That creates `supabase/functions/<name>/handler.ts` (the legacy `entry.ts` with these import swaps) and `index.ts`:

| Legacy import | Becomes |
|---|---|
| `import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52'` | `from '../_shared/runtime.ts'` |
| `import { secrets, waitUntil } from 'base44:runtime'` | `from '../_shared/runtime.ts'` |
| `from '../../shared/x.ts'` | `from '../_shared/x.ts'` |

```ts
// supabase/functions/<name>/index.ts
import { serve } from '../_shared/runtime.ts';
import handler from './handler.ts';
serve(handler);
```

Nothing else in the handler needs to change for the common cases:

- **Request/response.** Base44 handlers are `export default async function (req: Request): Promise<Response>`; Supabase edge functions receive the same `Request` and return a `Response`. `Response.json(...)` works in Deno. `serve()` answers `OPTIONS` preflights, adds the CORS headers (`corsHeaders`, origin from `CORS_ORIGIN` or `*`), and returns a 500 JSON error if the handler throws.
- **`x-base44-app-url`.** Several handlers read this header for the public origin. `serve()` injects it from the `APP_URL` env var when the caller did not send it.
- **Auth.** `base44.auth.me()` reads the `Authorization: Bearer` header. A Supabase user JWT is verified with `supabase.auth.getUser` and the role comes from `public.profiles` (`admin` | `agent` | `user`); the result is `{ id, email, full_name, role, roles }` as before. The **service role key** (what pg_cron and `functions.invoke` send) resolves to `{ role: 'admin', email: PLATFORM_OWNER_EMAIL }`, which is how the `adminContext(req)` paths used by crons keep working. No token → `null` (legacy code throws "Please sign in.").
- **Entities.** `base44.asServiceRole.entities.X` is unrestricted. `base44.entities.X` is scoped to the signed-in user: non-admins only see rows with their `agent_email`, never see `"rls": {"read": false}` fields, and rows they create are stamped with their email. Both forms of `filter` are supported: `filter(query, { sort, limit, cursor, fields, skip })` → `{ items, has_more, next_cursor }`, and `filter(query, '-created_date', 1)` → array (used for `User`).
- **`User`** maps to `public.profiles` (`id` is the auth uuid, `email`, `full_name`, `role`). `base44.users.inviteUser(email)` calls `auth.admin.inviteUserByEmail`.
- **Integrations.** `SendEmail({to, subject, body, from_name})` or `SendEmail({to, template_name, variables})` → Resend. `InvokeLLM({prompt, response_json_schema})` → Anthropic Messages API, structured output via a forced tool call. `CreateFileSignedUrl({file_uri})` / `UploadFile({file})` → Supabase Storage bucket `STORAGE_BUCKET`. `functions.invoke(name, body)` → `POST ${SUPABASE_URL}/functions/v1/<name>` with the service key, returns `{ data, status }`.
- **Webhook addresses shown in the UI.** Base44 served functions under the app origin (`${app}/functions/<name>`); Supabase serves them at `${SUPABASE_URL}/functions/v1/<name>`. `runtime.functionUrl(name)` builds the public address (`FUNCTIONS_URL` overrides the base); `adminGhl` (webhook_url), `adminMessaging` (webhook) and `leadWebhookSettings` use it. `ghlAuth.redirectUri` (shown by `adminGhl`, used by `ghlOAuth`) does the same with an app-origin fallback.
- **`waitUntil(p)`** uses `EdgeRuntime.waitUntil` when present (deployed), otherwise lets the promise run and logs a rejection.
- **Secrets** come from `Deno.env` (set them in Dashboard → Edge Functions → Secrets). The names are unchanged: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY`, `RESPARK_WEBHOOK_SECRET`, `RESPARK_GHL_AGENCY_TOKEN`, `GHL_CLIENT_SECRET`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `GOOGLE_OAUTH_CLIENT_SECRET`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `LLM_MODEL`, `LLM_WRITER_MODEL`. New: `RESEND_API_KEY`, `FROM_EMAIL`, `APP_URL`, `PLATFORM_OWNER_EMAIL`, `STORAGE_BUCKET`, `CORS_ORIGIN`, `FUNCTIONS_URL` (optional; public base for webhook addresses shown to admins/agents, default `${SUPABASE_URL}/functions/v1`), `MS_CLIENT_ID` / `MS_CLIENT_SECRET` / `MS_TENANT` (optional, Microsoft 365 calendar). Injected by Supabase: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`.

Then:

```
cd supabase/functions && deno check <name>/index.ts      # imports must resolve; legacy typing noise is expected (see below)
supabase functions deploy <name> --no-verify-jwt          # webhooks / public endpoints
supabase functions deploy <name>                          # UI-called functions (gateway checks the JWT first)
```

Deploy with `--no-verify-jwt` for every function that is called without a Supabase user token: webhooks (Stripe, Twilio, GHL, lead vendors), the public site endpoints, OAuth callbacks, and the cron targets (the service key passes gateway verification either way, but `--no-verify-jwt` keeps the function reachable if the key is rotated to the new `sb_secret_` format). The handlers do their own auth (`adminContext`, `authenticWebhook`, Stripe/Twilio signatures) exactly as before.

### Check the handler for

- `base44.entities.X.filter(q, '-created_date', 1)` – fine (array form supported).
- Fields written that are not in the jsonc schema. Base44 stored them silently; the adapter drops them with a `console.warn` (`ENTITIES_STRICT=1` makes it throw, which the tests use). Add the field to the jsonc and rerun `deno run -A scripts/gen-schema.ts` → new migration.
- `$exists: false` vs `''`. Missing fields are `NULL` in Postgres; `''` is a value. The legacy code already treats both (`{$exists: true, $nin: ['', null]}`), so nothing to change.
- Dates. `created_date`/`updated_date` are `timestamptz(3)` and come back as ISO strings with milliseconds; the optimistic-lock pattern `updateMany({ id, updated_date: row.updated_date }, …)` round-trips exactly (tested). Every other date-ish field stays `text`.
- Type errors from `deno check`. Base44 never type-checked; the shared modules produce ~25 errors of the "parameter implicitly any / `input = {}` has no property" kind under `supabase/functions/deno.json` (strict off). Supabase does not type-check on deploy, so they are not blocking; fix them as you touch each module.

## 2. How cron reaches a function

`0002_cron_and_triggers.sql` schedules pg_cron jobs that run `public.invoke_edge_function('<name>', body)`, which `net.http_post`s to `${project_url}/functions/v1/<name>` with the header `x-cron-secret: <cron_secret>` read from Vault (the same value is the edge function secret `CRON_SECRET`). `auth.me()` matches it and returns the platform admin, so `adminContext(req)` passes. The same path backs the booked-appointment trigger (`appointmentJourney` with `{appointment_id}`) and `functions.invoke` between functions (`sequenceSender` fans out to itself per agent, `dailyBrief` continues with a cursor).

pg_cron runs in UTC. The three daily jobs are scheduled at their CDT hour (8:00 Chicago → 13:00 UTC); they drift an hour in winter. Change the cron expressions if that matters.

## 3. Data access from the web app

Agents read tables without hidden fields directly (RLS: `agent_email = jwt email`) and tables **with** hidden fields through `v_<table>` views (`v_lead`, `v_agent_settings`, `v_campaign`, `v_appointment`, `v_message_log`, …) which drop the `"rls": {"read": false}` columns. Admins read every base table. Authenticated users cannot write any entity table: the jsonc grants create/update/delete to admins only, and all writes already go through functions. `agent_settings` and `platform_credential` have `"read": false` in the jsonc; `platform_credential` is service-role only, `agent_settings` is readable by admins and through `v_agent_settings` by its owner (the admin UI needs it).

## 4. Local testing

```
scripts/test.sh                       # adapter + runtime tests on a throwaway Postgres (PATH or /usr/lib/postgresql/*/bin)
TEST_DATABASE_URL=... scripts/test.sh # against your own disposable database
```

`scripts/test/auth_stub.sql` stands in for the `auth` schema locally; never run it on a real project. For a full local stack use `supabase start`, which applies `supabase/migrations/*` to a real auth schema, then `supabase functions serve --env-file .env`.

## 5. What a human has to do in the Supabase dashboard

1. Create the project; run the migrations (`supabase db push` or paste `0001` then `0002`).
2. Vault: `select vault.create_secret('https://<ref>.supabase.co', 'project_url'); select vault.create_secret('<long random string>', 'cron_secret');` and set the edge function secret `CRON_SECRET` to the same string (required by `0002`).
3. Edge Function secrets: every name listed under *Secrets* above.
4. Storage: create the bucket named in `STORAGE_BUCKET` (default `uploads`); public read if logos/headshots are served publicly, otherwise signed URLs are used.
5. Auth: enable email (magic link / invite) sign-in, set the Site URL to `APP_URL`, add redirect URLs. Invite the platform owner first (their email must equal `platform_settings.owner_email` to be made admin by the trigger), then agents via `inviteAgent` or the dashboard. Promote extra admins: `update public.profiles set role = 'admin' where email = '…'`.
6. Deploy functions; point the external webhooks at the new URLs: Stripe (`stripeWebhook`, copy the new signing secret), Twilio messaging + status callbacks (`twilioWebhook`), GHL marketplace app redirect (`ghlOAuth`) and webhook (`ghlWebhook?secret=…`), lead vendors/Zapier (`leadWebhook`).
7. Import data (`scripts/export-base44.md`), re-import `Lead`/`MessageLog`/`ConversationSummary` at cut-over, then disable the Base44 workflows.

## 6. Every legacy function and what triggers it

Trigger legend: **cron** (workflow schedule, now pg_cron in `0002`), **webhook** (external system POSTs, deploy with `--no-verify-jwt`), **public** (no sign-in, called by the public site / links), **UI** (signed-in app call through `web/src/components/workspace/api.js`), **internal** (called by another function with the service key), **entity trigger** (Base44 workflow on a record change), **retired** (workflow condition `false`; not called by anything).

| Function | Trigger | Auth path in code | Notes |
|---|---|---|---|
| a2pAdvance | cron `*/30 * * * *` | adminContext | A2P Registration Status workflow |
| a2pDraft | UI | setupContext | |
| a2pStatus | UI | setupContext | |
| a2pSubmit | UI | setupContext | Twilio, Stripe |
| a2pValidate | UI | setupContext | |
| adminAgents | UI (admin) | adminContext | |
| adminDiagnostics | UI (admin) | adminContext | |
| adminDocuments | UI (admin) | adminContext | |
| adminGhl | UI (admin) | adminContext | reads `x-base44-app-url` |
| adminMessaging | UI (admin) | setup(req) | reads `x-base44-app-url`, `RESPARK_WEBHOOK_SECRET` |
| adminPhone | UI (admin) | setup(req) | |
| adminPlatform | UI (admin) | adminContext | |
| adminProvisioning | UI (admin) | adminContext | |
| adminSubscriptions | UI (admin) + cron `15 5 * * *` Chicago with `{action:'sync'}` | adminContext | Subscription Sync workflow |
| adminTwilio | UI (admin) + cron `0 6 * * *` Chicago with `{action:'status',record:true}` | adminContext | Twilio Connection Check workflow |
| adminWebsite | UI (admin) | setup(req) | |
| agentAlert | retired (Lead update workflow, condition false) | adminContext | engine texts agents directly now; port only if wanted |
| aiReply | retired (MessageLog create workflow, condition false) | adminContext | reply pipeline runs inside sequenceSender |
| appointmentJourney | entity trigger: Appointment create/update when `status == 'booked'` and new or moved | adminContext | now the Postgres trigger in `0002`; also `{action:'run'}` for manual runs |
| appointmentReminders | cron `*/5 * * * *` | adminContext | Appointment Reminders workflow; also runs the journey |
| availability | UI | setupContext | |
| billingCredits | UI | setupContext | Stripe, `STRIPE_PUBLISHABLE_KEY` |
| calendarInvite | public (link in emails, token in URL) | none | `--no-verify-jwt` |
| calls | UI | setupContext | Twilio voice |
| campaignProgress | UI | context(req) | |
| checkConnection | UI | context(req) | |
| commandCenter | UI (admin) | adminContext | The Admin Command page (`web/src/pages/AdminCommand.jsx`); there is no separate `adminCommand` function |
| contactNotes | UI | context(req) | |
| conversationControl | UI | context(req) | |
| createSetupIntent | UI | setupContext | Stripe |
| dailyBrief | cron `0 8 * * *` Chicago; internal (self, `{cursor}`) | adminContext | Daily Brief Preparation workflow; emails via SendEmail |
| getBillingConfig | UI | setupContext | |
| getPublicSite | public | resolvePublicAgent | `--no-verify-jwt`; uses CreateFileSignedUrl |
| getSetupStatus | UI | setupContext | |
| getThread | UI | context(req) | |
| ghlOAuth | webhook (GHL OAuth redirect) | none | `--no-verify-jwt`; reads `x-base44-app-url` |
| ghlWebhook | webhook (GHL events, `?secret=`) | authenticWebhook | `--no-verify-jwt` |
| health | cron `*/15 * * * *` | adminContext | Platform Health workflow; ported example |
| importLeads | UI | setupContext | |
| inbox | UI | setupContext | |
| inviteAgent | UI (admin) | setup(req) | uses `users.inviteUser` |
| launch | UI | setupContext | |
| leadWebhook | webhook (vendors / Zapier, key in URL) | none (own key check) | `--no-verify-jwt`; `?vendor=closr` / `?vendor=goat` adapters (`_shared/vendorLeads.ts`) |
| leadWebhookSettings | UI | setupContext | |
| leads | UI | setupContext | |
| msOAuth | UI (`{action}`) + webhook (Microsoft OAuth redirect, GET) | setupContext / HMAC state | New in the port; `--no-verify-jwt`; see `docs/LEGACY_RESPARK_FOLD_IN.md` |
| numbers | UI | setupContext | Twilio, Stripe |
| outcomes | UI | setupContext | |
| playbooks | UI | setupContext | |
| previewSequence | UI | context(req) | InvokeLLM |
| provisionCalendar | UI (admin) | setup(req) | |
| provisionCampaign | UI (admin) | setup(req) | |
| provisionDataModel | UI (admin) | setup(req) | |
| provisionSubAccount | UI (admin) | setup(req) | |
| publicDemo | public | none | `--no-verify-jwt`; InvokeLLM |
| purchaseNumber | UI | setupContext | Twilio, Stripe |
| referral | UI | setupContext | |
| rehearsal | UI (admin) | adminContext | uses deleteMany |
| results | UI | setupContext | |
| reviewDraft | UI | context(req) | |
| saveAgentSettings | UI | context(req) | |
| saveBillingCard | UI | setupContext | Stripe |
| saveCampaign | UI | context(req) | uses bulkUpdate |
| searchNumbers | UI | setupContext | Twilio |
| selfSetup | UI | context(req) | |
| sendMessage | UI | context(req) | |
| sequenceSender | cron `*/5 * * * *`; internal (self, `{agent_email}` fan-out and `{cursor}`) | adminContext | Sequence Sender workflow; the engine |
| simulateInbound | UI | context(req) | |
| stripeWebhook | webhook (Stripe) | Stripe signature (`STRIPE_WEBHOOK_SECRET`) | `--no-verify-jwt` |
| submitGetInfo | public (agent mini-site form) | resolvePublicAgent | `--no-verify-jwt`; SendEmail template `WebsiteInquiry` |
| subscription | UI | setupContext | Stripe |
| support | UI | context(req) | |
| syncInbox | UI | context(req) | |
| syncLead | retired (Lead / MessageLog workflows, condition false) | adminContext | handled inside the engine |
| testConversation | UI | context(req) | InvokeLLM |
| tryMyAI | UI | setupContext | InvokeLLM |
| twilioWebhook | webhook (Twilio inbound SMS + status callbacks) | Twilio signature | `--no-verify-jwt` |
| upgradeCampaign | UI | context(req) | |
| workspace | UI | context(req) | |

Retired workflows with condition `false` (Agent Attention Alert, Agent Go Live Welcome, Contact Status Sync, Daily Brief Email, Engine Status Changes, Inbound Suggested Reply) need nothing: their work moved into the functions above before the port.

## Known issues found while porting

- `_shared/messageBooking.ts` (`bookSlot`): the Base44 source assigns `attempted = true` without ever declaring `attempted`, so every booking through that path threw `ReferenceError` inside the try and again in the catch. The ported copy declares it (`let attempted = false`). Nothing else in `_shared/` was changed.
- `_shared/llm.ts` still prefers `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` from the environment and only falls back to `integrations.Core.InvokeLLM` (now also Anthropic). Its default model string (`claude-sonnet-5-5`) comes from the legacy code; set `LLM_MODEL` to the model you actually want.
- `scripts/test.sh` applies every migration except `0002` (pg_cron/pg_net) and runs `supabase/functions/_shared/` plus `supabase/functions/_tests/` (end-to-end tests that drive the ported handlers as plain Requests with a mocked fetch).
- `_shared/entityRetry.ts` retries on Base44 rate-limit messages. Harmless on Postgres (the adapter never raises them) and still useful for transient connection errors.
