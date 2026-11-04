# Cutover runbook: Base44 → Supabase + Vercel

State on 2026-11-03 evening (all done from the Claude session):

- Supabase project `respark` (ref `xteheymihhnsgpsxulcg`, us-east-1): schema, RLS, views, Vault (`project_url`, `cron_secret`, `import_token`), bucket `uploads`, 79 edge functions deployed by GitHub Actions on every push to `master`.
- Vercel project `respark` (team `aidan-1924`, root `web`, framework vite): https://respark-aidan-1924.vercel.app, env `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`.
- Owner login `pipkinaidan@outlook.com` exists and is `admin` (profile created by the auth trigger; email confirmed by hand because the default mailer sends a link, not the 6-digit code the app asks for).
- First full data copy done through `exportToSupabase` (Base44 workflow "Migration: push data to Supabase") → `importRows`: 5,439 leads, 10,426 message log rows, 5,011 conversations, 5,093 dispatches, 4 workspaces, 3 A2P registrations, 2 numbers, 3 billing accounts, 6 campaigns / 206 steps. The empty workspace auto-created by the first dashboard load was retired (`retired-2f47fb43@leadrespark.internal`).
- pg_cron jobs are defined but **unscheduled** until cutover (Base44 is still the live engine).

## Before cutover (owner)

1. Edge Function secrets (Dashboard → Edge Functions → Secrets): `APP_URL`, `PLATFORM_OWNER_EMAIL`, `ANTHROPIC_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `RESEND_API_KEY`, `FROM_EMAIL`, `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `GHL_CLIENT_ID`, `GHL_CLIENT_SECRET`, `RESPARK_GHL_AGENCY_TOKEN` (new token), `RESPARK_WEBHOOK_SECRET`. Later: `STRIPE_WEBHOOK_SECRET`.
2. Auth → URL configuration: site URL + redirect URLs for the Vercel host, the custom domain and localhost. Providers: Email on, Google with the "Respark" OAuth client (callback `https://xteheymihhnsgpsxulcg.supabase.co/auth/v1/callback`).
3. Auth → SMTP: custom SMTP via Resend (`smtp.resend.com`, port 465, user `resend`, password = Resend API key, sender = `FROM_EMAIL`). Then Email Templates → Confirm signup / Magic Link bodies use `{{ .Token }}` (the app asks for the 6-digit code).

## Cutover (Claude, with the owner watching)

1. Parity test on the new stack with test leads (`importLeads` test_leads → `sequenceSender` → `simulateInbound` → booking) for the owner workspace.
2. Re-run the Base44 workflow "Migration: push data to Supabase" with `reset: true` (edit args) to copy everything changed since the first pass. Idempotent upsert on id.
3. Re-point inbound integrations:
   - Twilio: every number's SMS/voice webhook → `https://xteheymihhnsgpsxulcg.supabase.co/functions/v1/twilioWebhook` (`adminTwilio` / `numbers` can re-register; also `twilio_account.webhook_url`).
   - Stripe: new endpoint `…/functions/v1/stripeWebhook` (events: customer.subscription.*, invoice.*, payment_intent.*, setup_intent.*), paste its signing secret as `STRIPE_WEBHOOK_SECRET`.
   - GHL marketplace app: redirect URI `…/functions/v1/ghlOAuth`; custom automations → `…/functions/v1/ghlWebhook?secret=<RESPARK_WEBHOOK_SECRET>`.
   - Lead vendors (Closr/GOAT) → the URLs `leadWebhookSettings` shows per agent.
4. Schedule the crons: run the `cron.schedule(...)` block from `supabase/migrations/20261103234618_cron_and_triggers.sql`.
5. Domain: add `respark-pipkingroup.com` to the Vercel project, update DNS at the registrar (A/CNAME as Vercel shows), set `APP_URL` and Auth site URL to the domain, update the Vercel env if needed.
6. Base44: pause every workflow in LeadRespark (A2P tracker last, after confirming `a2pAdvance` ran once on Supabase), then unpublish.
7. Delete the Vault `import_token` and archive the migration workflow.

## Rollback

Base44 keeps running untouched until step 6; rolling back is re-pointing the webhooks and DNS at Base44 again.
