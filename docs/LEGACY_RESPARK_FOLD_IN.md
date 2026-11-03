# Folding the per-agent Respark stack into the product

`legacy_respark/` is the hand-built Base44 stack Aidan Pipkin (My Trucker Wealth) and Riley Lyng ran as
GHL text automations: one copy of every function per agent, hard-coded location ids, phone numbers,
pipeline ids and tokens. Nothing from it runs as a separate stack any more. What was worth keeping is now a
feature of the multi-tenant product, on the same engine, pipeline, tracks and compliance rails every agent
uses. This file says what went where, what was left behind on purpose, and how to move the old lead rows.

## What moved where

| Legacy piece | Now | Notes |
|---|---|---|
| `resparkCopy.ts` (D1-D30 series + fresh burst) | Playbook **`trucker_aidan`** ("Trucker IUL, Aidan's voice"): `supabase/functions/_shared/truckerAidanSeed.ts`, registered in `_shared/playbooks.ts` | Copy carried word for word as `verbatim` SequenceSteps, cadence `standard`, original day offsets (0,1,2,3,4,6,8,10,13,16,19,23,26,29). Only `{first}` and `{state}` are filled; the AI writer is never asked to rewrite. Persona `agent_first_person`, so the installing agent texts as themselves ("this is {agent}"). |
| Fresh-lead day-0 burst (F2 +20 min, F3 +4 h) | Steps 2 and 3 of the same playbook, `fresh_only` + `offset_minutes` | Only leads that arrived through the lead webhook in the last 24 h (`messageSequence.freshSeries`) get them; aged leads skip straight from D1 to D2. The fresh opener ("the request you just put in") is a `fresh_only` twin of step 1; the aged opener ("Tried calling a couple times") is the regular one. |
| Send window (9:00-7:30pm lead-local Mon-Sat, Sunday 12:00-7:30pm except AL/LA/MS/UT/RI) | `campaign.send_rules` on that playbook's campaign; honored by `_shared/cadenceClock.ts` (`cadenceOpen`, `stepTime`, `nextCadenceWindow`) and `_shared/messageSequence.ts` | Other campaigns have no `send_rules` and behave exactly as before (Mon-Sat 9:30-6:30, no Sundays). Federal holidays are still skipped (product rule the legacy stack did not have). The 3-texts-per-24h cap is the product's and matches the legacy one. |
| `premiumTruckerWebhook.ts` (Closr Tech) and `goatLeadWebhook.ts` (GOAT) | `leadWebhook?key=<agent key>&vendor=closr` / `&vendor=goat`; adapters in `_shared/vendorLeads.ts`; URLs listed by `leadWebhookSettings` (`vendor_urls`) | Same per-agent key auth as the generic webhook. Vendor payload fields (incl. Closr `lead.custom_data` and GOAT title-case keys) map onto the standard intake; health-related form answers are dropped. Closr `is_test` deliveries and empty connectivity checks are acknowledged and not stored. GOAT "Aged Bucket" other than FRESH is imported but not given the instant opener (`import_batch` `vendor-aged:`). |
| Vendor consent | Lead `consent_*` fields + a `ConsentRecord` (`basis: webhook`, `attested_by: vendor:<name>:<key>`) | Both vendors sell consented leads from their own forms and the legacy stack treated every delivery as opted in. The adapters record that explicitly: consent flag true, wording naming the vendor form, campaign/source and, when sent, the TrustedForm certificate URL. The agent remains responsible for the vendor's TCPA language. |
| `approvalRecovery.ts` (6 texts over 14 days, "Lost at Banking") | `lost_banking` track in `_shared/tracks.ts` | Legacy copy replaced the AI briefs: each step carries `text` sent as written (`{first} {agent} {carrier} {coverage}`; carrier/product come from a Policy row when one exists, else "the carrier" / "the coverage we set up" exactly as the legacy fallbacks). Timing 0 h, 24 h, 72 h, 144 h, 216 h, 312 h after the outcome is logged (legacy days 1, 2, 4, 7, 10, 14). First reply stops the track (engine rule, unchanged). `_shared/trackEngine.ts` sends step `text` through `serviceCheck` without the AI writer, any permitted hour, automatically (it is the agent's own copy). |
| `resparkBooking.ts` (Outlook via the Base44 "outlook" connector) | `_shared/msGraph.ts`, new function `msOAuth`, hooks in `_shared/availability.ts`, `availability`, `_shared/appointmentJourney.ts`, `_shared/agentBooking.ts` | Behind `MS_CLIENT_ID` / `MS_CLIENT_SECRET` (+ optional `MS_TENANT`, default `common`). Each agent connects their own mailbox; refresh token on `agent_settings.ms_refresh_token` (hidden). Outlook busy times join the ICS-link busy source; a booked call creates an Outlook event with the lead invited (when they have an email), removed on cancel and replaced on reschedule. Migration `0003`. |
| 3-per-24h cap, STOP handling, "never text a closed client", takeover pause | Already product rules (`messageSequence.MAX_PER_24H`, `guardrails.stopRequested`, client track, `status_before_takeover`) | Nothing to port. |

### Schema (migration `0003_legacy_respark_fold_in.sql`)

`sequence_step.verbatim`, `sequence_step.offset_minutes`, `sequence_step.fresh_only`, `campaign.send_rules`,
`agent_settings.ms_refresh_token` (hidden), `ms_connected_email`, `ms_connected_at`, `appointment.ms_event_id`.
`_shared/schema.ts` was edited by hand to match; `scripts/gen-schema.ts` does not know these columns, so a
regeneration from the jsonc must be followed by re-applying them (or add them to the jsonc first).

### Behavior notes

- A `verbatim` step bypasses the AI writer and the wording guardrail block (flags are logged). Aidan's D7
  names "sleep apnea" and D14 says "tax free income", which the product's AI texts may not; the copy is sent
  as the agent wrote it. CA/UT openers still get the "(automated assistant)" disclosure the product requires.
- The legacy step clock times (9:30, 17:30, 12:15...) are mapped to the cadence slots (`am` 10:00-12:00 for
  hours before 1pm, `pm` 2:30-5:30 otherwise); day offsets are exact.
- The fresh-lead track depends on the lead arriving through `leadWebhook`; leads imported from the legacy
  tables are never "fresh".

## Intentionally not carried over

- **iMessage / GHL-SMS alerts to Aidan's own contact** (`alertAidan`, contact `hLZmFD5Azf8WHCpBuk0d`): the
  product texts/emails the agent through `agentNotify` (alert mobile, morning agenda).
- **Daily calling list email, daily appointment summary, morning brief** (`invoke_superagent_step` workflows):
  the product's `dailyBrief` covers this per agent.
- **Test monitor / `llmProbe`, `ghlAuditOpportunities`, `ashleyReply`, Ethos campaign functions**: diagnostics
  and one-off campaigns specific to the old stack. `adminDiagnostics` covers AI and workspace checks.
- **GoatLead / DripCampaign / CampaignSettings / GlobalSuppression tables**: raw vendor payload logs and
  per-stack settings. Vendor deliveries now land directly as leads + consent records; suppression is the
  product's opt-out handling (GHL DND, `respark-opted-out`, `opted_out` status).
- **Approval Recovery reply acknowledgement** ("Got you {first}, I'll give you a call shortly...") and the
  GHL-stage auto-enrollment of "Lost at Banking" opportunities: in the product the agent logs the outcome
  (`outcomes` → `lost_banking`) and the reply pipeline answers inbound texts.
- **Riley's variations** (9:00-9:00pm window with an 8pm cap in FL/OK/WA/MD, GHL-calendar booking): Riley installs
  the same playbook; his hours differ only by `send_rules`, which an admin can set on his campaign
  (`{"weekday":{"open":"09:00","close":"21:00"}, ...}`); per-state caps were not added. His number is not A2P
  registered yet (legacy note), which the product's readiness checks already enforce.
- **Hard-coded GHL custom-field ids, pipeline/stage ids, `bundle_respark.py`**: replaced by per-agent
  provisioning and normal imports.

## One-time migration of the lead rows

Prerequisites: the agent exists (`agent_settings` with `location_id`), and the `trucker_aidan` playbook is
installed for them (Playbooks in the app, or `adminDiagnostics {action:'install_playbook', agent_email, key:'trucker_aidan'}`).
GHL contact/opportunity ids are copied as-is: they are valid only if the agent's product workspace is the
same GHL sub-account the legacy stack used (Aidan: `P1m006Mt7YCXCAdiBBxC`, Riley: `ORVsDMoAeYZQlMKJNMip`).

```
DATABASE_URL=postgres://postgres:...@db.<ref>.supabase.co:5432/postgres \
deno run -A scripts/import-legacy-respark.ts --agent aidan@... --file legacy_respark/data/ResparkLead.jsonl \
    --consent legacy_respark/data/SMSConsent.jsonl --dry-run                 # look first
deno run -A scripts/import-legacy-respark.ts --agent aidan@... --file legacy_respark/data/ResparkLead.jsonl \
    --consent legacy_respark/data/SMSConsent.jsonl --assume-vendor-consent   # 556 rows, 3,768 messages
deno run -A scripts/import-legacy-respark.ts --agent riley@... --file legacy_respark/data/RileyResparkLead.jsonl --assume-vendor-consent
```

Idempotent: leads upsert on `(agent_email, phone)` keeping the legacy `id`; message_log rows get deterministic
ids. Re-running updates in place.

| Legacy `ResparkLead` | `lead` |
|---|---|
| `phone` | `phone` (E.164) |
| `first_name`, `last_name`, `email` | same |
| `state` ("Texas") | `state` ("TX"); `timezone` from the row or the state |
| `status` active (0 sent / >0 sent) | `queued` / `in_sequence` |
| `status` conversing / booked / manual | `replied` / `booked` / `needs_human` |
| `status` stopped with STOP/DND/declined in `stop_reason` | `opted_out` |
| `status` stopped (other), completed, recovery* | `closed` (`disposition_note` = `stop_reason`) |
| `step` / sequence messages sent | `current_step` on the playbook's numbering (fresh track 1:1; aged track k → k+2 because steps 2-3 are the fresh burst) |
| `enrolled_at`, `next_send_at`, `last_sms_at`, `last_inbound_at` | `sequence_started_at`, `next_send_at` (only when the lead can still be texted), `last_outbound_at`, `last_inbound_at` |
| `driver_type`, `age`, `dob`, `beneficiary_relationship`, `iul_goal`, `profile` | `lead_facts` (`occupation`, `age`, `date_of_birth`, `who_to_protect`, `reason_in_their_words`, `extra`) |
| `conversation[]` (`aidan_sequence` / `aidan_bot` / `lead`) | `message_log` rows: `sms_sent` (source `sequence` / `ai`) and `inbound_sms` |
| `SMSConsent.jsonl` row with the same phone | `consent_source` "Website form (...)", `consent_date`, `consent_wording`, `dnc_checked` |
| no consent row | without `--assume-vendor-consent` the lead is kept with empty consent and `sequence_paused`, so the engine never texts it; with the flag, consent is recorded as "Vendor lead form (legacy Respark import)" (what the legacy stack relied on). Only 3 SMSConsent rows exist and none match a lead. |

## Deploy / dashboard steps added by this fold-in

1. Apply `supabase/migrations/0003_legacy_respark_fold_in.sql`.
2. Deploy `msOAuth` with `--no-verify-jwt` (the Microsoft callback carries no user token); `leadWebhook` is
   already `--no-verify-jwt`.
3. For Microsoft 365: register an Azure app (delegated `Calendars.ReadWrite`, `User.Read`, `offline_access`),
   redirect URI `${SUPABASE_URL}/functions/v1/msOAuth`, and set `MS_CLIENT_ID`, `MS_CLIENT_SECRET`
   (and `MS_TENANT` if single-tenant). Agents connect from Availability; the UI toggle is still to be built:
   `availability` returns `ms_available`, `ms_connected`, `ms_email`, and `msOAuth` takes `{action:'start'}`
   (returns the URL to open), `{action:'status'}`, `{action:'disconnect'}`.
4. Point Closr Tech and GOAT at the `vendor_urls` from `leadWebhookSettings` for each agent, then deactivate
   the Base44 `premiumTruckerWebhook` / `goatLeadWebhook` workflows.
