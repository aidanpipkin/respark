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
| `PLATFORM_OWNER_EMAIL` | runtime | Email reported by `auth.me()` for service-role (cron) calls. |
| `APP_URL` | runtime `serve()`, `agentSite.ts`, `appointmentJourney.ts` | Public web-app origin: stands in for `x-base44-app-url`, and builds inbox / calendar links in texts and emails. |
| `FUNCTIONS_URL` (optional) | runtime `functionUrl()` | Public base of the edge functions when not `${SUPABASE_URL}/functions/v1` (custom domain). Used for the lead webhook URL shown in `leadWebhookSettings`. |
| `FUNCTION_INVOKE_TIMEOUT_MS` (optional) | runtime | Timeout for `functions.invoke` (sequenceSender fan-out); default 150000. |
| `CORS_ORIGIN` (optional) | runtime | `Access-Control-Allow-Origin`; default `*`. |
| `ANTHROPIC_API_KEY` | `llm.ts`, runtime InvokeLLM | AI replies (`aiReplyCore`), the sequence writer, `previewSequence`, `testConversation`, `tryMyAI`, `publicDemo`. |
| `OPENAI_API_KEY` (optional) | `llm.ts` | Used instead of Anthropic when `ANTHROPIC_API_KEY` is unset. |
| `LLM_MODEL`, `LLM_WRITER_MODEL` (optional) | `llm.ts`, runtime | Model overrides for replies and the follow-up writer. The legacy default string is `claude-sonnet-5-5`. |
| `ANTHROPIC_WORKSPACE_ID` (optional) | `llm.ts` | Sent as `anthropic-workspace-id`. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | `twilio.ts` | Master Twilio credentials: subaccount credential lookup (`twilioWebhook` signature check, outbound texts via `smsTransport`, agent alert texts). Legacy aliases `TWILIO_SID`/`TWILIO_AUTH`/`Twillio_SID`/`Twillio_Auth` are still accepted. |
| `RESPARK_WEBHOOK_SECRET` | `webhookAuth.ts` | Shared secret for `ghlWebhook?secret=…` (custom GHL automations; marketplace events are verified by signature). |
| `RESPARK_GHL_AGENCY_TOKEN` | `ghlAuth.ts` | GHL agency token used to mint location tokens (`freshSettings` on OAuth workspaces). |
| `GHL_CLIENT_ID`, `GHL_CLIENT_SECRET` | `ghlAuth.ts` | GHL marketplace app credentials for token refresh. |
| `STRIPE_SECRET_KEY` | `stripeRest.ts` via `credits.ts` | Auto-recharge of text credits when a send drains the balance (`maybeRecharge`). |
| `RESEND_API_KEY`, `FROM_EMAIL` | runtime SendEmail | `submitGetInfo` (WebsiteInquiry email), agent emails from the engine (`agentEmails`, `appointmentJourney`). |
| `STORAGE_BUCKET` (default `uploads`) | runtime | `getPublicSite` signed URLs for logos/headshots. |
| `ENTITIES_STRICT` (tests only) | entities | `1` makes unknown fields throw instead of warn. |

Tests: `scripts/test.sh` runs `_shared/*_test.ts` and `_tests/engine_test.ts` (end-to-end: import test leads,
sequence sender, inbound AI draft with calendar slots, approve, booking, STOP) against a throwaway Postgres
with every outside HTTP call mocked.
