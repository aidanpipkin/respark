# Respark migration: Base44 -> Supabase + Anthropic (Claude)

Package built Nov 3, 2026 by Vesper for Aidan Pipkin. Hand this folder to Claude Code with the prompt in `CLAUDE_CODE_PROMPT.md`.

## What is in here
- `functions/aidan_respark/` Aidan's stack (My Trucker Wealth, GHL location P1m006Mt7YCXCAdiBBxC). Source modules: `resparkShared.ts` (GHL client, timezones, send window, compliance), `resparkCopy.ts` (the 30-day text sequence + fresh-lead burst), `resparkBooking.ts` (Outlook/Graph booking), and one entry file per function. `bundle_respark.py` inlines the shared modules into `dist/` because Base44 does not allow imports between functions. On Supabase you can use normal imports instead and delete the bundler.
- `functions/riley_respark/` Riley Lyng's stack, same architecture, GHL location ORVsDMoAeYZQlMKJNMip, table RileyResparkLead. Riley's number +14794466932 is NOT A2P registered yet (SMS fails with GHL error 30034 until his brand+campaign are approved).
- `functions/shared_guards/` `closedGuard.ts` (never text a closed client) and `sendCustomTexts.ts` (one-off texts with the same guard).
- `workflows/` the 15 Base44 workflows as JSON + `SCHEDULES.md` with every cron to recreate.
- `schema/schema.sql` Postgres tables inferred from live records. `data/*.jsonl` full exports (ResparkLead 556 rows, GoatLead 117, DripCampaign newest 1000, others small). Import with COPY or a small script; keep the `id` column.

## Runtime pieces to replace
| Base44 thing | Replacement |
|---|---|
| `createClientFromRequest(req).asServiceRole.entities.X.filter/list/create/update` | supabase-js (service role) against the tables in schema.sql. Call sites: ~60. Positional `list('-created_date', 500, skip)` = `order(created_date desc).range(skip, skip+499)`. |
| `integrations.Core.InvokeLLM({prompt, response_json_schema})` (aidanReply.ts:187, rileyReply.ts:159) | Anthropic Messages API, model claude-sonnet-4-5, with the same prompt and a JSON schema via tool-use or `response_format`. Temperature low. |
| `connectors.getConnection('outlook')` (resparkBooking.ts:5) | Microsoft Graph with your own Azure app registration (Calendars.ReadWrite, Mail.Send) and a stored refresh token for aidan@usnaturalinsurance.com. Riley's stack books on his GHL calendar instead; no Graph needed there. |
| Workflows (cron) | pg_cron -> `net.http_post` to each edge function, or Supabase scheduled functions. Crons in `workflows/SCHEDULES.md`. |
| `invoke_superagent_step` (morning brief, calling list email) | A `dailyBrief` edge function: run `resparkReport` + `sendAppointmentSummary` logic, feed the JSON to Claude with the brief prompt, send the result to Aidan by GHL SMS (contact hLZmFD5Azf8WHCpBuk0d) or email. |
| iMessage alerts to Aidan | Already mostly GHL SMS to his contact; make all alerts go that way. |
| Secrets | GHL_API_KEY, RILEY_GHL_API_KEY, GHL_PRIVATE_INTEGRATION_TOKEN (agency), ANTHROPIC_API_KEY, MS_CLIENT_ID / MS_CLIENT_SECRET / MS_REFRESH_TOKEN, webhook tokens for premiumTruckerWebhook and rileyPremiumTruckerWebhook (currently in the vendor URLs; keep the same values so Closr Tech / GOAT do not need changes, or update their endpoints). |

## Business rules baked into the code (do not lose these)
1. HARD RULE: never text a closed client. closedGuard / rileyClosedGuard retire any lead whose GHL opp sits in Closed / App Submitted / Policy Issued / won (Lost at Banking excluded) and tag "Client - Do Not Text". sendCustomTexts checks stage before every send.
2. Identity: Aidan is "Aidan" only, never "Aidan Pipkin" or "Pipkin" in any lead-facing text or email. Riley is "Riley".
3. Send windows. Aidan: 9:00am-7:30pm lead-local Mon-Sat, Sunday 12:00-7:30pm except AL/LA/MS/UT/RI (no Sunday). Riley (Nov 2 change, in riley_src): 9:00am-9:00pm, 8:00pm cap in FL/OK/WA/MD, same Sunday rule. Max 3 sequence texts per lead per rolling 24h.
4. Fresh leads (vendor webhooks, hand-dropped into Fresh Premium Truckers pipelines) get the fresh-track opener immediately when inside the window, else at the next opening; aged New Lead opps enroll after 3 days with no reply.
5. Any inbound text pauses the sequence and hands the thread to the reply bot; any outbound text written by the human (not by the bot) marks "took over" and pauses the bot. STOP/negative/second no closes the file and moves the opp to Not Interested. First "not interested" gets one honest leveling reply, never a second push.
6. Reminders for booked calls are toned down: nothing within 3h of our last text, day-before text only when the call is on a later calendar day, at most one of T-1h / T-10m. Riley: SMS only, the only emails are the calendar invite and the booking confirmation.
7. Approval Recovery drip (Lost at Banking stage): 6 texts over 14 days in Aidan's voice; any reply stops it and alerts Aidan.
8. Missed-call text-back in GHL is OFF on purpose. Do not add auto-replies on missed calls.
9. Lead data to GHL in proper case and E.164 phones; WAVV dialer tags ("Ready to Call").

## Suggested order for Claude Code
1. `supabase init`, apply schema.sql, import data/*.jsonl.
2. Port resparkShared/resparkCopy/resparkBooking to `supabase/functions/_shared/`; swap the entity client for supabase-js; swap InvokeLLM for Anthropic.
3. Port resparkSend, aidanReply, resparkEnroll, resparkAppointmentFlow, premiumTruckerWebhook, closedGuard, approvalRecovery, aidanBook, sendCustomTexts, goatLeadWebhook, goatLeadFollowup. Then the Riley set.
4. Recreate crons from SCHEDULES.md. Run every function with `dry_run: true` first (all of them support it).
5. Point the vendor webhooks (Closr Tech for Riley, GOAT + Closr for Aidan) at the new URLs, then deactivate the Base44 workflows last.
