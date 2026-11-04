# `_shared`: runtime shims and legacy modules

`runtime.ts`, `entities.ts` and `schema.ts` replace the Base44 SDK (see `docs/PORTING.md`). Every other
file is a legacy `shared/` module with its imports swapped. Each function group documents the environment
variables its functions read below; set them in Dashboard → Edge Functions → Secrets.

## Engine, inbox, webhooks and public site

Functions: `sequenceSender`, `twilioWebhook`, `ghlWebhook`, `aiReply`, `sendMessage`, `inbox`, `getThread`,
`syncInbox`, `syncLead`, `leads`, `importLeads`, `simulateInbound`, `contactNotes`, `conversationControl`,
`reviewDraft`, `previewSequence`, `testConversation`, `tryMyAI`, `campaignProgress`, `saveCampaign`,
`playbooks`, `upgradeCampaign`, `leadWebhook`, `leadWebhookSettings`, `submitGetInfo`, `getPublicSite`,
`publicDemo`, `rehearsal`.

Deploy with `--no-verify-jwt`: `twilioWebhook`, `ghlWebhook`, `leadWebhook`, `submitGetInfo`, `getPublicSite`,
`publicDemo` (they verify the Twilio signature, the GHL signature or `?secret=`, the agent's webhook key, or
resolve a public agent themselves) and `sequenceSender` (pg_cron and the per-agent fan-out call it with the
service role key, which `auth.me()` maps to the platform admin).

| Variable | Read by | Purpose |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL` | runtime, entities | Injected by Supabase. Auth verification, service-role detection, `functions.invoke`, Postgres. `DATABASE_URL` is the local-test fallback for `SUPABASE_DB_URL`. |
| `SUPABASE_DB_POOLER_URL` | entities | **Set this in production.** Supavisor transaction-mode DSN (port 6543), preferred over `SUPABASE_DB_URL`: `postgresql://postgres.<ref>:<db-password>@aws-0-<region>.pooler.supabase.com:6543/postgres`. Hundreds of worker isolates run per minute; direct connections would exhaust Postgres. |
| `DB_POOL_MAX` (optional) | entities | Connections per isolate; default 2 (idle 10 s, connect timeout 5 s, lifetime 15 min, `prepare: false`). |
| `ENTITY_RETRY_TRIES` (optional) | entityRetry | Attempts per entity call on connection blips; default 2 (250 ms base, 1.5 s cap, ≤250 ms jitter). |
| `EDGE_WALL_CLOCK_MS` (optional) | sequenceSender | The platform's edge-function wall clock; default 150000. Worker budget is `min(90 s, wall − 45 s)`, legacy dispatcher `min(60 s, wall − 60 s)`. |
| `SEQUENCE_WORKER_DEADLINE_MS` (tests only) | sequenceSender | Forces a short worker budget to exercise hop chaining. Never set in production. |
| `PLATFORM_OWNER_EMAIL` | runtime | Email reported by `auth.me()` for service-role (cron) calls. |
| `CRON_SECRET` (optional) | runtime | Overrides the Vault `cron_secret` that pg_cron / triggers send as `x-cron-secret`; treated like the service role. |
| `APP_URL` | runtime `serve()`, `agentSite.ts`, `appointmentJourney.ts` | Public web-app origin: stands in for `x-base44-app-url`, and builds inbox / calendar links in texts and emails. |
| `FUNCTIONS_URL` (optional) | runtime `functionUrl()` | Public base of the edge functions when not `${SUPABASE_URL}/functions/v1` (custom domain). Used for the lead webhook URL shown in `leadWebhookSettings`. |
| `FUNCTION_INVOKE_TIMEOUT_MS` (optional) | runtime | Timeout for `functions.invoke` (sequenceSender hop chaining, legacy fan-out); default 120000. |
| `CORS_ORIGIN` (optional) | runtime | `Access-Control-Allow-Origin`; default `*`. |
| `ANTHROPIC_API_KEY` | `llm.ts`, runtime InvokeLLM | AI replies (`aiReplyCore`), the sequence writer, `previewSequence`, `testConversation`, `tryMyAI`, `publicDemo`. |
| `OPENAI_API_KEY` (optional) | `llm.ts` | Used instead of Anthropic when `ANTHROPIC_API_KEY` is unset. |
| `LLM_MODEL`, `LLM_WRITER_MODEL` (optional) | `llm.ts`, runtime | Model overrides for replies and the follow-up writer; default `claude-sonnet-5-5` everywhere. A campaign's `ai_model` is honoured only when it is one of `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-opus-5-5`, `claude-sonnet-4-5`, `claude-haiku-4-5`; anything else falls back to `LLM_MODEL`. |
| `LLM_MAX_INFLIGHT` (optional) | `llm.ts` | Concurrent provider calls per isolate; default 6. 429/5xx retries honour `Retry-After` (capped at 8 s). |
| `ANTHROPIC_WORKSPACE_ID` (optional) | `llm.ts` | Sent as `anthropic-workspace-id`. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | `twilio.ts` | Master Twilio credentials: subaccount credential lookup (`twilioWebhook` signature check, outbound texts via `smsTransport`, agent alert texts). Legacy aliases `TWILIO_SID`/`TWILIO_AUTH`/`Twillio_SID`/`Twillio_Auth` are still accepted. |
| `RESPARK_WEBHOOK_SECRET` | `webhookAuth.ts` | Shared secret for `ghlWebhook?secret=…` (custom GHL automations; marketplace events are verified by signature). |
| `RESPARK_GHL_AGENCY_TOKEN` | `ghlAuth.ts` | GHL agency token used to mint location tokens (`freshSettings` on OAuth workspaces). |
| `GHL_CLIENT_ID`, `GHL_CLIENT_SECRET` | `ghlAuth.ts` | GHL marketplace app credentials for token refresh. |
| `STRIPE_SECRET_KEY` | `stripeRest.ts` via `credits.ts` | Auto-recharge of text credits when a send drains the balance (`maybeRecharge`). |
| `RESEND_API_KEY`, `FROM_EMAIL` | runtime SendEmail | `submitGetInfo` (WebsiteInquiry email), agent emails from the engine (`agentEmails`, `appointmentJourney`). |
| `STORAGE_BUCKET` (default `uploads`) | runtime | `getPublicSite` signed URLs for logos/headshots. |
| `ENTITIES_STRICT` (tests only) | entities | `1` makes unknown fields throw instead of warn. |

Tests: `scripts/test.sh` runs `_shared/*_test.ts`, `_tests/engine_test.ts` (end-to-end: import test leads,
sequence sender, inbound AI draft with calendar slots, approve, booking, STOP) and `_tests/scale_test.ts`
(cached clocks, legal-band clamp, worker lock and hop chaining, Transient AI failures, deferred reply delays,
duplicate inbound sids, a2pAdvance paging, per-agent unique keys) against a throwaway Postgres with every
outside HTTP call mocked.

Scheduling (see `supabase/migrations/20261104180100_sequence_fanout_cron.sql`): pg_cron runs
`public.sequence_fanout()` every minute, which invokes `sequenceSender {agent_email, hop: 0}` per active agent;
a worker that runs out of its 90 s budget chains `{hop + 1}` (up to 6) after releasing its lock. `{housekeeping: true}`
every 5 minutes does welcome emails, the stuck-dispatch reaper and the heartbeat. Autopilot replies whose
human-like delay exceeds 45 s are written to `AIDraft.send_after` and delivered by the agent's worker.

## Onboarding, billing, numbers, A2P, appointments and provisioning

Functions: `workspace`, `selfSetup`, `getSetupStatus`, `launch`, `createSetupIntent`, `saveBillingCard`, `subscription`,
`billingCredits`, `getBillingConfig`, `stripeWebhook`, `searchNumbers`, `purchaseNumber`, `numbers`, `a2pDraft`, `a2pStatus`,
`a2pValidate`, `a2pSubmit`, `a2pAdvance`, `availability`, `calendarInvite`, `provisionCalendar`, `provisionSubAccount`,
`provisionCampaign`, `provisionDataModel`, `appointmentJourney`, `appointmentReminders`, `calls`, `outcomes`, `referral`,
`support`, `saveAgentSettings`, `dailyBrief`, `results`, `inviteAgent`, `checkConnection`, `ghlOAuth`.

Deploy with `--no-verify-jwt`: `stripeWebhook` (verifies `stripe-signature` with `STRIPE_WEBHOOK_SECRET`), `ghlOAuth`
(GHL OAuth redirect; the redirect URI shown by `adminGhl` and sent on the token exchange is `functionUrl('ghlOAuth')`),
`calendarInvite` (public .ics link; the per-appointment token in the URL is the key), and the cron / trigger targets
`a2pAdvance` (`*/30 * * * *`), `appointmentReminders` (`*/5 * * * *`), `dailyBrief` (daily, re-invokes itself with a
cursor) and `appointmentJourney` (the booked-appointment trigger in `0002`), which `adminContext` admits because the
service role key resolves to the platform admin. Twilio voice callbacks for `calls` arrive at `twilioWebhook` (other
group); `purchaseNumber` / `numbers` register `functionUrl('twilioWebhook')` on every bought number and on `TwilioAccount.webhook_url`
(numbers bought under Base44 keep the old URL in `webhook_url` until an admin re-points them).

| Variable | Read by | Purpose |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL` | runtime, entities | Injected by Supabase. `SUPABASE_URL` also builds the public function URLs (`functionUrl`) and backs `users.inviteUser` (`auth.admin.inviteUserByEmail`, used by `inviteAgent`). |
| `PLATFORM_OWNER_EMAIL` | runtime | Identity of cron / trigger calls (`a2pAdvance`, `appointmentReminders`, `appointmentJourney`, `dailyBrief`). |
| `APP_URL` | runtime `serve()`, `agentSite.ts` (`appOrigin`), `appointmentJourney.ts` (`APP_ORIGIN`) | Web-app origin for the hosted agent site links in A2P registrations (`/a/<slug>`, privacy and SMS-terms pages), dashboard / contacts / credits links in texts and emails, the referral link, the `ghlOAuth` redirect back to `/admin/platform`, and the invite redirect. Falls back to the legacy domain when unset. |
| `FUNCTIONS_URL` (optional) | runtime `functionUrl()` | Custom base for the public function URLs: Twilio webhook on bought numbers, calendar-invite links in booking emails, the GHL OAuth redirect URI. |
| `FUNCTION_INVOKE_TIMEOUT_MS` (optional) | runtime | `dailyBrief` continuing itself with a cursor; default 120000. |
| `SUPABASE_DB_POOLER_URL`, `DB_POOL_MAX`, `ENTITY_RETRY_TRIES` | entities, entityRetry | See the engine group: the pooler DSN is required in production. |
| `CORS_ORIGIN` (optional) | runtime | CORS header on every UI-called function. |
| `STRIPE_SECRET_KEY` | `stripeRest.ts` | Customers, SetupIntents, payment methods (`createSetupIntent`, `saveBillingCard`), products/prices/subscriptions/promotion codes (`subscription`, `stripeWebhook` sync), credit purchases and auto-recharge (`billingCredits`, `numbers`, `calls`). |
| `STRIPE_PUBLISHABLE_KEY` | `getBillingConfig`, `billingCredits` | Returned to the UI; must match `PlatformSettings.stripe_mode` (`pk_test_` / `pk_live_`). |
| `STRIPE_WEBHOOK_SECRET` | `stripeWebhook` | Signing secret of the Stripe endpoint `…/functions/v1/stripeWebhook`; the function answers 503 until it is set. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | `twilio.ts` | Master account: agent subaccounts (`searchNumbers`, `purchaseNumber`, `numbers`), Trust Hub bundles and brand/campaign registration (`a2pSubmit`, `a2pStatus`, `a2pAdvance`), click-to-call and recordings (`calls`), the self-test and reminder texts (`launch`, `appointmentReminders`, `appointmentJourney`), owner alert texts. `twilioConfigured()` decides between the Twilio path and the manual (admin-queued) path for numbers and A2P. Legacy aliases `TWILIO_SID` / `TWILIO_AUTH` / `Twillio_SID` / `Twillio_Auth` are accepted. |
| `RESPARK_GHL_AGENCY_TOKEN` | `ghlAuth.ts`, `provisioning.ts` | Agency private-integration token, used for sub-account and user creation when the marketplace OAuth app is not connected (`provisionSubAccount`, `selfSetup` build). |
| `GHL_CLIENT_ID` (fallback for `PlatformSettings.ghl_client_id`), `GHL_CLIENT_SECRET` | `ghlAuth.ts` | Marketplace app: code exchange in `ghlOAuth`, token refresh and location-token minting during `selfSetup` builds and on every settings read of an OAuth workspace. |
| `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`), `LLM_MODEL`, `LLM_WRITER_MODEL`, `ANTHROPIC_WORKSPACE_ID` (optional) | `llm.ts` | `a2pDraft` program copy; booking-email personalization and lead profiles in `appointmentJourney` / `appointmentReminders` / `availability` bookings. |
| `RESEND_API_KEY`, `FROM_EMAIL` | runtime SendEmail | Booking emails to leads and agents, A2P progress notices, daily briefs, approval and support replies, owner alerts, the Twilio ISV notice in `a2pSubmit`. |
| `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_TENANT` (optional) | `msGraph.ts` | Outlook calendar (other group); reached from `availability` and the booking journey only when an agent connected Microsoft 365. |
| `STORAGE_BUCKET` (default `uploads`) | runtime | Only through shared imports; no function in this group reads files. |
| `ENTITIES_STRICT` (tests only) | entities | Unknown fields throw instead of warn. `_tests/onboarding_test.ts` runs without it and lists the known schema drift (`A2PRegistration.licensed_states`, written by `completeRegistration` and never declared in the jsonc). |

Tests: `_tests/onboarding_test.ts` drives the whole self-serve path (ghlOAuth → workspace → selfSetup build → card,
subscription → number → A2P brand/campaign/approval → launch test text and the YES through `twilioWebhook` → booking,
journey emails, reminders → stripeWebhook, inviteAgent) with Supabase auth, GHL, Stripe, Twilio, Anthropic and Resend mocked.
