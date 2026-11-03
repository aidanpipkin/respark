-- ---------------------------------------------------------------------------
-- Owner-safe views for tables whose jsonc hides fields ("rls": {"read": false}).
-- Views run as their owner (postgres) so they see past RLS; the where clause scopes rows.
-- ---------------------------------------------------------------------------
create or replace view public.v_a2p_registration with (security_barrier) as
  select "id", "created_date", "updated_date", "created_by_id", "is_sample", "agent_email", "approved_at", "attested", "brand_status", "business_address", "business_email", "business_phone", "business_type", "campaign_status", "city", "description", "ein_last4", "entity_type", "first_name", "help_response", "identity_status", "last_checked_at", "last_name", "legal_business_name", "mobile_phone", "npn", "opt_in_flow", "postal_code", "privacy_url", "provider_step", "region", "rep_position", "rep_title", "review_note", "resubmit_requested", "last_rejection", "resubmitted_at", "sample_message_1", "sample_message_2", "status", "stop_response", "street", "submitted_at", "terms_url", "website" from public.a2p_registration where agent_email = public.jwt_email() or public.is_admin();
grant select on public.v_a2p_registration to authenticated;
create or replace view public.v_agent_settings with (security_barrier) as
  select "id", "created_date", "updated_date", "created_by_id", "is_sample", "a2p_notes", "a2p_status", "about_text", "accent_color", "address_city", "address_state", "address_street", "address_zip", "agency_name", "agent_email", "agent_title", "alert_mobile", "beta_access", "blocked_dates", "booking_url", "brand_name", "business_address", "business_email", "business_phone", "busy_cache", "busy_calendar_url", "calendar_hours", "calendar_id", "completed_steps", "connected", "custom_field_ids", "custom_value_ids", "display_name", "domain", "first_name", "hard_ceiling", "hard_floor", "headshot_url", "home_timezone", "invite_status", "invited_at", "last_name", "lead_webhook_campaign_id", "lead_webhook_key", "legal_business_name", "licensed_states", "live_at", "logo_url", "max_calls_per_day", "mode", "notification_email", "notification_phone", "npn", "onboarding_checks", "onboarding_complete", "onboarding_step", "opt_out_keywords", "owner_user_id", "phone_number", "pipeline_id", "preferred_area_code", "primary_color", "products", "products_offered", "provisioning", "public_slug", "quiet_end", "quiet_start", "self_serve", "send_window_1", "send_window_2", "setup_checklist", "stage_ids", "status", "test_leads_at", "daily_send_cap", "throttle_until", "meeting_link", "reply_alerts", "tag_ids", "chat_widget_id", "test_phone_numbers" from public.agent_settings where agent_email = public.jwt_email() or public.is_admin();
grant select on public.v_agent_settings to authenticated;
create or replace view public.v_ai_draft with (security_barrier) as
  select "id", "created_date", "updated_date", "created_by_id", "is_sample", "agent_email", "campaign_id", "chosen_slot_iso", "edit_reason", "final_text", "guardrail_flags", "inbound_message_id", "intent", "lead_id", "offered_slots", "personalization", "proposed_action", "send_after", "proposed_text", "reviewed_by", "sentiment", "source", "stage", "status", "step_number", "template_text", "trigger_at", "variant" from public.ai_draft where agent_email = public.jwt_email() or public.is_admin();
grant select on public.v_ai_draft to authenticated;
create or replace view public.v_appointment with (security_barrier) as
  select "id", "created_date", "updated_date", "created_by_id", "is_sample", "agent_email", "ai_summary", "booked_via", "campaign_id", "campaign_name", "confirmation", "confirmed_at", "email_status", "journey", "lead_id", "lead_name", "lead_timezone", "outcome", "outcome_at", "outcome_note", "phone_to_call", "reminders_sent", "start_time", "status" from public.appointment where agent_email = public.jwt_email() or public.is_admin();
grant select on public.v_appointment to authenticated;
create or replace view public.v_billing_account with (security_barrier) as
  select "id", "created_date", "updated_date", "created_by_id", "is_sample", "agent_email", "auto_recharge", "auto_recharge_consent_at", "balance_cents", "brand", "card_consent_at", "exp_month", "exp_year", "last4", "last_recharge_at", "last_recharge_error", "lifetime_texts", "recharge_amount_cents", "recharge_threshold_cents", "status", "subscription_amount_cents", "subscription_cancel_at_period_end", "subscription_checked_at", "subscription_consent_at", "subscription_discount", "subscription_period_end", "subscription_status" from public.billing_account where agent_email = public.jwt_email() or public.is_admin();
grant select on public.v_billing_account to authenticated;
create or replace view public.v_calendar_connection with (security_barrier) as
  select "id", "created_date", "updated_date", "created_by_id", "is_sample", "agent_email", "provider", "status", "connected_at", "disconnected_at" from public.calendar_connection where agent_email = public.jwt_email() or public.is_admin();
grant select on public.v_calendar_connection to authenticated;
create or replace view public.v_campaign with (security_barrier) as
  select "id", "created_date", "updated_date", "created_by_id", "is_sample", "ab_enabled", "ab_lead_cap", "ab_locked", "ab_winner", "agent_email", "ai_model", "knowledge_doc", "mode", "archived", "review_sequence", "cadence", "name", "persona", "personalize_sequence", "product", "prompt_version", "status", "system_prompt", "writer_prompt" from public.campaign where agent_email = public.jwt_email() or public.is_admin();
grant select on public.v_campaign to authenticated;
create or replace view public.v_consent_record with (security_barrier) as
  select "id", "created_date", "updated_date", "created_by_id", "is_sample", "agent_email", "lead_id", "submission_id", "ip", "user_agent", "page_url", "timestamp", "consent_checked", "consent_text", "basis", "source", "wording", "consent_date", "seller_named", "attested_by", "attested_at", "batch_id" from public.consent_record where agent_email = public.jwt_email() or public.is_admin();
grant select on public.v_consent_record to authenticated;
create or replace view public.v_control_audit with (security_barrier) as
  select "id", "created_date", "updated_date", "created_by_id", "is_sample", "agent_email", "lead_id", "actor_email", "action", "occurred_at" from public.control_audit where agent_email = public.jwt_email() or public.is_admin();
grant select on public.v_control_audit to authenticated;
create or replace view public.v_conversation_summary with (security_barrier) as
  select "id", "created_date", "updated_date", "created_by_id", "is_sample", "agent_email", "campaign_id", "campaign_name", "has_pending_draft", "last_direction", "last_message", "last_time", "lead_id", "lead_name", "phone", "replied_at", "status_chip", "unread" from public.conversation_summary where agent_email = public.jwt_email() or public.is_admin();
grant select on public.v_conversation_summary to authenticated;
create or replace view public.v_credit_transaction with (security_barrier) as
  select "id", "created_date", "updated_date", "created_by_id", "is_sample", "agent_email", "amount_cents", "balance_after_cents", "created_at", "description", "dispatch_id", "kind", "lead_id", "segments" from public.credit_transaction where agent_email = public.jwt_email() or public.is_admin();
grant select on public.v_credit_transaction to authenticated;
create or replace view public.v_lead with (security_barrier) as
  select "id", "created_date", "updated_date", "created_by_id", "is_sample", "agent_email", "ai_intent", "ai_paused", "ai_sentiment", "ai_summary", "cadence", "campaign_id", "consent_date", "consent_seller_named", "consent_source", "consent_text", "consent_wording", "crm_synced_status", "current_step", "discovery_topic", "disposition_note", "dnc_checked", "dnc_basis", "eligibility_reason", "email", "first_name", "import_batch", "inquiry_date", "last_disposition", "last_disposition_at", "last_inbound_at", "last_name", "last_outbound_at", "lead_facts", "lead_source", "needs_human_reason", "next_nudge_at", "next_nurture_at", "next_send_at", "nudge_count", "nurture_count", "offered_at", "offered_slots", "phone", "revisit_reason", "sequence_paused", "sequence_started_at", "sequence_waiting_review", "state", "state_eligible", "status", "status_before_takeover", "step1_delivered", "tags", "texts_last_24h", "timezone", "track", "track_done", "track_hold_until", "track_next_at", "track_started_at", "variant", "from_number", "last_called_at", "call_count" from public.lead where agent_email = public.jwt_email() or public.is_admin();
grant select on public.v_lead to authenticated;
create or replace view public.v_message_log with (security_barrier) as
  select "id", "created_date", "updated_date", "created_by_id", "is_sample", "agent_email", "lead_id", "campaign_id", "event_type", "direction", "source", "body", "status", "occurred_at", "step_number", "dispatch_id", "number", "error_code" from public.message_log where agent_email = public.jwt_email() or public.is_admin();
grant select on public.v_message_log to authenticated;
create or replace view public.v_prompt_version with (security_barrier) as
  select "id", "created_date", "updated_date", "created_by_id", "is_sample", "agent_email", "campaign_id", "knowledge_doc", "notes", "system_prompt", "version", "writer_prompt" from public.prompt_version where public.is_admin();
grant select on public.v_prompt_version to authenticated;
create or replace view public.v_provisioning_task with (security_barrier) as
  select "id", "created_date", "updated_date", "created_by_id", "is_sample", "key", "agent_email", "kind", "status", "requested_number", "registration_id", "public_note", "resolved_by", "resolved_at" from public.provisioning_task where agent_email = public.jwt_email() or public.is_admin();
grant select on public.v_provisioning_task to authenticated;
create or replace view public.v_sequence_step with (security_barrier) as
  select "id", "created_date", "updated_date", "created_by_id", "is_sample", "agent_email", "cadence", "slot", "kind", "body", "brief", "campaign_id", "day_offset", "lever", "requires_step1_delivered", "step_number", "variant" from public.sequence_step where agent_email = public.jwt_email() or public.is_admin();
grant select on public.v_sequence_step to authenticated;
create or replace view public.v_stats_snapshot with (security_barrier) as
  select "id", "created_date", "updated_date", "created_by_id", "is_sample", "agent_email", "campaign_id", "range", "computed_at", "metrics" from public.stats_snapshot where agent_email = public.jwt_email() or public.is_admin();
grant select on public.v_stats_snapshot to authenticated;

-- Create profile rows for new auth users. Must come after platform_settings exists.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

grant usage on schema public to anon, authenticated, service_role;
grant select on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
