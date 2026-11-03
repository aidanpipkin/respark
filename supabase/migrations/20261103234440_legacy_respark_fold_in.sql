-- Columns added while folding the per-agent Respark stack (legacy_respark) into the product.
-- See docs/LEGACY_RESPARK_FOLD_IN.md. Hand-written: the jsonc generator (scripts/gen-schema.ts)
-- does not know these columns, so supabase/functions/_shared/schema.ts was edited by hand to match.
--
--   sequence_step.verbatim       true: send the step body as written (name/state tokens only), skip the AI writer
--   sequence_step.offset_minutes send N minutes after the previous text instead of day_offset + slot (same-day bursts)
--   sequence_step.fresh_only     only for leads that arrived through the lead webhook within the last day
--   campaign.send_rules          campaign-level send window overrides, e.g. Sunday hours and no-Sunday states
--   agent_settings.ms_*          Microsoft 365 (Graph) calendar connection; the refresh token is never readable by the UI
--   appointment.ms_event_id      the Outlook event created for a booking, so a move or cancel can remove it

alter table public.sequence_step add column if not exists "verbatim" boolean;
alter table public.sequence_step add column if not exists "offset_minutes" double precision;
alter table public.sequence_step add column if not exists "fresh_only" boolean;

alter table public.campaign add column if not exists "send_rules" jsonb;

alter table public.agent_settings add column if not exists "ms_refresh_token" text;
alter table public.agent_settings add column if not exists "ms_connected_email" text;
alter table public.agent_settings add column if not exists "ms_connected_at" text;

alter table public.appointment add column if not exists "ms_event_id" text;

-- completeRegistration writes A2PRegistration.licensed_states, never declared in the Base44 jsonc.
alter table public.a2p_registration add column if not exists "licensed_states" jsonb;

-- Views: the new agent-visible columns are appended (create or replace view only allows appending).
create or replace view public.v_sequence_step with (security_barrier) as
  select "id", "created_date", "updated_date", "created_by_id", "is_sample", "agent_email", "cadence", "slot", "kind", "body", "brief", "campaign_id", "day_offset", "lever", "requires_step1_delivered", "step_number", "variant", "verbatim", "offset_minutes", "fresh_only" from public.sequence_step where agent_email = public.jwt_email() or public.is_admin();

create or replace view public.v_campaign with (security_barrier) as
  select "id", "created_date", "updated_date", "created_by_id", "is_sample", "ab_enabled", "ab_lead_cap", "ab_locked", "ab_winner", "agent_email", "ai_model", "knowledge_doc", "mode", "archived", "review_sequence", "cadence", "name", "persona", "personalize_sequence", "product", "prompt_version", "status", "system_prompt", "writer_prompt", "send_rules" from public.campaign where agent_email = public.jwt_email() or public.is_admin();

create or replace view public.v_appointment with (security_barrier) as
  select "id", "created_date", "updated_date", "created_by_id", "is_sample", "agent_email", "ai_summary", "booked_via", "campaign_id", "campaign_name", "confirmation", "confirmed_at", "email_status", "journey", "lead_id", "lead_name", "lead_timezone", "outcome", "outcome_at", "outcome_note", "phone_to_call", "reminders_sent", "start_time", "status", "ms_event_id" from public.appointment where agent_email = public.jwt_email() or public.is_admin();

-- ms_refresh_token stays out of v_agent_settings (hidden, like ghl_token); the connection state is visible.
create or replace view public.v_agent_settings with (security_barrier) as
  select "id", "created_date", "updated_date", "created_by_id", "is_sample", "a2p_notes", "a2p_status", "about_text", "accent_color", "address_city", "address_state", "address_street", "address_zip", "agency_name", "agent_email", "agent_title", "alert_mobile", "beta_access", "blocked_dates", "booking_url", "brand_name", "business_address", "business_email", "business_phone", "busy_cache", "busy_calendar_url", "calendar_hours", "calendar_id", "completed_steps", "connected", "custom_field_ids", "custom_value_ids", "display_name", "domain", "first_name", "hard_ceiling", "hard_floor", "headshot_url", "home_timezone", "invite_status", "invited_at", "last_name", "lead_webhook_campaign_id", "lead_webhook_key", "legal_business_name", "licensed_states", "live_at", "logo_url", "max_calls_per_day", "mode", "notification_email", "notification_phone", "npn", "onboarding_checks", "onboarding_complete", "onboarding_step", "opt_out_keywords", "owner_user_id", "phone_number", "pipeline_id", "preferred_area_code", "primary_color", "products", "products_offered", "provisioning", "public_slug", "quiet_end", "quiet_start", "self_serve", "send_window_1", "send_window_2", "setup_checklist", "stage_ids", "status", "test_leads_at", "daily_send_cap", "throttle_until", "meeting_link", "reply_alerts", "tag_ids", "chat_widget_id", "test_phone_numbers", "ms_connected_email", "ms_connected_at" from public.agent_settings where agent_email = public.jwt_email() or public.is_admin();
