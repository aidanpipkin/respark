-- ---------------------------------------------------------------------------
-- CallLog
-- ---------------------------------------------------------------------------
create table if not exists public.call_log (
  id text primary key default gen_random_uuid()::text,
  created_date timestamptz(3) not null default now(),
  updated_date timestamptz(3) not null default now(),
  created_by_id text,
  is_sample boolean default false,
  "agent_email" text,
  "lead_id" text,
  "direction" text,
  "from_number" text,
  "lead_phone" text,
  "agent_phone" text,
  "status" text,
  "agent_call_sid" text,
  "lead_call_sid" text,
  "started_at" text,
  "answered_at" text,
  "ended_at" text,
  "duration_sec" double precision default 0,
  "billed_cents" double precision default 0,
  "recording_sid" text,
  "recording_duration_sec" double precision,
  "note" text,
  constraint call_log_direction_check check ("direction" is null or "direction" in ('outbound', 'inbound'))
);
create trigger call_log_updated before update on public.call_log for each row execute function public.set_updated_date();
create index if not exists call_log_agent_email_idx on public.call_log ("agent_email");
create index if not exists call_log_agent_email_lead_id_started_at_idx on public.call_log ("agent_email", "lead_id", "started_at");
create index if not exists call_log_agent_email_started_at_idx on public.call_log ("agent_email", "started_at");
alter table public.call_log enable row level security;
create policy call_log_select on public.call_log for select to authenticated using (agent_email = public.jwt_email() or public.is_admin());
create policy call_log_admin_insert on public.call_log for insert to authenticated with check (public.is_admin());
create policy call_log_admin_update on public.call_log for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy call_log_admin_delete on public.call_log for delete to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Campaign
-- ---------------------------------------------------------------------------
create table if not exists public.campaign (
  id text primary key default gen_random_uuid()::text,
  created_date timestamptz(3) not null default now(),
  updated_date timestamptz(3) not null default now(),
  created_by_id text,
  is_sample boolean default false,
  "ab_enabled" boolean,
  "ab_lead_cap" double precision default 200,
  "ab_locked" boolean default false,
  "ab_winner" text,
  "agent_email" text,
  "ai_model" text default 'claude-sonnet-5',
  "ghl_tag" text,
  "knowledge_doc" text,
  "location_id" text,
  "mode" text default 'review',
  "archived" boolean,
  "review_sequence" boolean,
  "cadence" text,
  "name" text,
  "persona" text,
  "personalize_sequence" boolean default true,
  "pipeline_id" text,
  "product" text,
  "prompt_version" double precision,
  "stage_ids" jsonb,
  "status" text default 'draft',
  "system_prompt" text,
  "writer_prompt" text,
  constraint campaign_ab_winner_check check ("ab_winner" is null or "ab_winner" in ('A', 'B')),
  constraint campaign_mode_check check ("mode" is null or "mode" in ('review', 'autopilot')),
  constraint campaign_cadence_check check ("cadence" is null or "cadence" in ('daily', 'standard')),
  constraint campaign_persona_check check ("persona" is null or "persona" in ('assistant', 'agent_first_person')),
  constraint campaign_status_check check ("status" is null or "status" in ('draft', 'active', 'paused'))
);
create trigger campaign_updated before update on public.campaign for each row execute function public.set_updated_date();
create index if not exists campaign_agent_email_idx on public.campaign ("agent_email");
create index if not exists campaign_agent_email_location_id_idx on public.campaign ("agent_email", "location_id");
create index if not exists campaign_agent_email_name_idx on public.campaign ("agent_email", "name");
alter table public.campaign enable row level security;
create policy campaign_admin_select on public.campaign for select to authenticated using (public.is_admin());
create policy campaign_admin_insert on public.campaign for insert to authenticated with check (public.is_admin());
create policy campaign_admin_update on public.campaign for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- ConsentRecord
-- ---------------------------------------------------------------------------
create table if not exists public.consent_record (
  id text primary key default gen_random_uuid()::text,
  created_date timestamptz(3) not null default now(),
  updated_date timestamptz(3) not null default now(),
  created_by_id text,
  is_sample boolean default false,
  "agent_email" text,
  "lead_id" text,
  "submission_id" text,
  "ip" text,
  "user_agent" text,
  "page_url" text,
  "timestamp" text,
  "consent_checked" boolean,
  "consent_text" text,
  "location_id" text,
  "basis" text,
  "source" text,
  "wording" text,
  "consent_date" text,
  "seller_named" text,
  "attested_by" text,
  "attested_at" text,
  "batch_id" text,
  constraint consent_record_basis_check check ("basis" is null or "basis" in ('agent_attestation', 'web_form', 'webhook'))
);
create trigger consent_record_updated before update on public.consent_record for each row execute function public.set_updated_date();
create index if not exists consent_record_agent_email_idx on public.consent_record ("agent_email");
create index if not exists consent_record_agent_email_submission_id_idx on public.consent_record ("agent_email", "submission_id");
alter table public.consent_record enable row level security;
create policy consent_record_admin_select on public.consent_record for select to authenticated using (public.is_admin());
create policy consent_record_admin_insert on public.consent_record for insert to authenticated with check (public.is_admin());
create policy consent_record_admin_update on public.consent_record for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- ControlAudit
-- ---------------------------------------------------------------------------
create table if not exists public.control_audit (
  id text primary key default gen_random_uuid()::text,
  created_date timestamptz(3) not null default now(),
  updated_date timestamptz(3) not null default now(),
  created_by_id text,
  is_sample boolean default false,
  "agent_email" text,
  "location_id" text,
  "lead_id" text,
  "actor_email" text,
  "action" text,
  "details" jsonb,
  "occurred_at" text
);
create trigger control_audit_updated before update on public.control_audit for each row execute function public.set_updated_date();
create index if not exists control_audit_agent_email_idx on public.control_audit ("agent_email");
create index if not exists control_audit_agent_email_lead_id_occurred_at_idx on public.control_audit ("agent_email", "lead_id", "occurred_at");
alter table public.control_audit enable row level security;
create policy control_audit_admin_select on public.control_audit for select to authenticated using (public.is_admin());
create policy control_audit_admin_insert on public.control_audit for insert to authenticated with check (public.is_admin());
create policy control_audit_admin_update on public.control_audit for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- ConversationSummary
-- ---------------------------------------------------------------------------
create table if not exists public.conversation_summary (
  id text primary key default gen_random_uuid()::text,
  created_date timestamptz(3) not null default now(),
  updated_date timestamptz(3) not null default now(),
  created_by_id text,
  is_sample boolean default false,
  "agent_email" text,
  "campaign_id" text,
  "campaign_name" text,
  "ghl_contact_id" text,
  "ghl_conversation_id" text,
  "has_pending_draft" boolean,
  "last_direction" text,
  "last_message" text,
  "last_time" text,
  "lead_id" text,
  "lead_name" text,
  "location_id" text,
  "phone" text,
  "replied_at" text,
  "status_chip" text,
  "unread" boolean
);
create trigger conversation_summary_updated before update on public.conversation_summary for each row execute function public.set_updated_date();
create index if not exists conversation_summary_agent_email_idx on public.conversation_summary ("agent_email");
create index if not exists conversation_summary_agent_email_last_time_idx on public.conversation_summary ("agent_email", "last_time");
create index if not exists conversation_summary_agent_email_lead_id_idx on public.conversation_summary ("agent_email", "lead_id");
create index if not exists conversation_summary_agent_email_ghl_contact_id_idx on public.conversation_summary ("agent_email", "ghl_contact_id");
alter table public.conversation_summary enable row level security;
create policy conversation_summary_admin_select on public.conversation_summary for select to authenticated using (public.is_admin());
create policy conversation_summary_admin_insert on public.conversation_summary for insert to authenticated with check (public.is_admin());
create policy conversation_summary_admin_update on public.conversation_summary for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- CreditTransaction
-- ---------------------------------------------------------------------------
create table if not exists public.credit_transaction (
  id text primary key default gen_random_uuid()::text,
  created_date timestamptz(3) not null default now(),
  updated_date timestamptz(3) not null default now(),
  created_by_id text,
  is_sample boolean default false,
  "agent_email" text,
  "amount_cents" integer,
  "balance_after_cents" integer,
  "created_at" text,
  "description" text,
  "dispatch_id" text,
  "kind" text,
  "lead_id" text,
  "segments" integer,
  "stripe_payment_intent_id" text,
  constraint credit_transaction_kind_check check ("kind" is null or "kind" in ('purchase', 'auto_recharge', 'text_usage', 'refund', 'adjustment'))
);
create trigger credit_transaction_updated before update on public.credit_transaction for each row execute function public.set_updated_date();
create index if not exists credit_transaction_agent_email_idx on public.credit_transaction ("agent_email");
create index if not exists credit_transaction_agent_email_created_at_idx on public.credit_transaction ("agent_email", "created_at");
create index if not exists credit_transaction_stripe_payment_intent_id_idx on public.credit_transaction ("stripe_payment_intent_id");
alter table public.credit_transaction enable row level security;
create policy credit_transaction_admin_select on public.credit_transaction for select to authenticated using (public.is_admin());
create policy credit_transaction_admin_insert on public.credit_transaction for insert to authenticated with check (public.is_admin());
create policy credit_transaction_admin_update on public.credit_transaction for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- EngineCursor
-- ---------------------------------------------------------------------------
create table if not exists public.engine_cursor (
  id text primary key default gen_random_uuid()::text,
  created_date timestamptz(3) not null default now(),
  updated_date timestamptz(3) not null default now(),
  created_by_id text,
  is_sample boolean default false,
  "key" text,
  "cursor" text
);
create trigger engine_cursor_updated before update on public.engine_cursor for each row execute function public.set_updated_date();
create unique index if not exists engine_cursor_key_idx on public.engine_cursor ("key");
alter table public.engine_cursor enable row level security;
create policy engine_cursor_select on public.engine_cursor for select to authenticated using (public.is_admin());
create policy engine_cursor_admin_insert on public.engine_cursor for insert to authenticated with check (public.is_admin());
create policy engine_cursor_admin_update on public.engine_cursor for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- Lead
-- ---------------------------------------------------------------------------
create table if not exists public.lead (
  id text primary key default gen_random_uuid()::text,
  created_date timestamptz(3) not null default now(),
  updated_date timestamptz(3) not null default now(),
  created_by_id text,
  is_sample boolean default false,
  "agent_email" text,
  "ai_intent" text,
  "ai_paused" boolean default true,
  "ai_sentiment" text,
  "ai_summary" text,
  "cadence" text,
  "campaign_id" text,
  "consent_date" text,
  "consent_seller_named" text,
  "consent_source" text,
  "consent_text" text,
  "consent_wording" text,
  "crm_synced_status" text,
  "current_step" double precision default 0,
  "discovery_topic" text,
  "disposition_note" text,
  "dnc_checked" boolean,
  "dnc_basis" text,
  "eligibility_reason" text,
  "email" text,
  "first_name" text,
  "ghl_contact_id" text,
  "ghl_conversation_id" text,
  "ghl_opportunity_id" text,
  "import_batch" text,
  "inquiry_date" text,
  "last_disposition" text,
  "last_disposition_at" text,
  "last_inbound_at" text,
  "last_inbound_id" text,
  "last_name" text,
  "last_outbound_at" text,
  "lead_facts" jsonb,
  "lead_snapshot" jsonb,
  "lead_source" text,
  "location_id" text,
  "needs_human_reason" text,
  "next_nudge_at" text,
  "next_nurture_at" text,
  "next_send_at" text,
  "nudge_count" double precision default 0,
  "nurture_count" double precision default 0,
  "offered_at" text,
  "offered_slots" jsonb,
  "phone" text,
  "revisit_reason" text,
  "send_lock_token" text,
  "send_lock_until" text,
  "sequence_paused" boolean default true,
  "sequence_started_at" text,
  "sequence_waiting_review" boolean default false,
  "state" text,
  "state_eligible" boolean,
  "status" text,
  "status_before_takeover" text,
  "step1_delivered" boolean default false,
  "tags" jsonb,
  "texts_last_24h" double precision,
  "timezone" text,
  "track" text,
  "track_done" jsonb,
  "track_hold_until" text,
  "track_next_at" text,
  "track_started_at" text,
  "variant" text,
  "website_request_key" text,
  "from_number" text,
  "last_called_at" text,
  "call_count" double precision default 0,
  constraint lead_discovery_topic_check check ("discovery_topic" is null or "discovery_topic" in ('1', '2')),
  constraint lead_status_check check ("status" is null or "status" in ('queued', 'in_sequence', 'replied', 'engaged', 'booked', 'held', 'no_show', 'opted_out', 'not_interested', 'needs_human', 'closed', 'client')),
  constraint lead_track_check check ("track" is null or "track" in ('', 'no_show', 'follow_up', 'lost_banking', 'lost_social', 'client'))
);
create trigger lead_updated before update on public.lead for each row execute function public.set_updated_date();
create index if not exists lead_agent_email_idx on public.lead ("agent_email");
create index if not exists lead_agent_email_status_next_send_at_idx on public.lead ("agent_email", "status", "next_send_at");
create index if not exists lead_agent_email_campaign_id_idx on public.lead ("agent_email", "campaign_id");
create index if not exists lead_agent_email_phone_idx on public.lead ("agent_email", "phone");
create index if not exists lead_agent_email_ghl_contact_id_idx on public.lead ("agent_email", "ghl_contact_id");
create index if not exists lead_agent_email_track_track_next_at_idx on public.lead ("agent_email", "track", "track_next_at");
create index if not exists lead_agent_email_last_inbound_at_idx on public.lead ("agent_email", "last_inbound_at");
create index if not exists lead_agent_email_updated_date_idx on public.lead ("agent_email", "updated_date");
create index if not exists lead_agent_email_import_batch_idx on public.lead ("agent_email", "import_batch");
create index if not exists lead_status_last_inbound_at_idx on public.lead ("status", "last_inbound_at");
create index if not exists lead_agent_email_from_number_idx on public.lead ("agent_email", "from_number");
alter table public.lead enable row level security;
create policy lead_admin_select on public.lead for select to authenticated using (public.is_admin());
create policy lead_admin_insert on public.lead for insert to authenticated with check (public.is_admin());
create policy lead_admin_update on public.lead for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- LeadNote
-- ---------------------------------------------------------------------------
create table if not exists public.lead_note (
  id text primary key default gen_random_uuid()::text,
  created_date timestamptz(3) not null default now(),
  updated_date timestamptz(3) not null default now(),
  created_by_id text,
  is_sample boolean default false,
  "agent_email" text,
  "author_email" text,
  "body" text,
  "created_at" text,
  "kind" text default 'note',
  "lead_id" text,
  constraint lead_note_kind_check check ("kind" is null or "kind" in ('note', 'call', 'system'))
);
create trigger lead_note_updated before update on public.lead_note for each row execute function public.set_updated_date();
create index if not exists lead_note_agent_email_idx on public.lead_note ("agent_email");
create index if not exists lead_note_agent_email_lead_id_created_at_idx on public.lead_note ("agent_email", "lead_id", "created_at");
alter table public.lead_note enable row level security;
create policy lead_note_select on public.lead_note for select to authenticated using (agent_email = public.jwt_email() or public.is_admin());
create policy lead_note_admin_insert on public.lead_note for insert to authenticated with check (public.is_admin());
create policy lead_note_admin_update on public.lead_note for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy lead_note_admin_delete on public.lead_note for delete to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- MessageDispatch
-- ---------------------------------------------------------------------------
create table if not exists public.message_dispatch (
  id text primary key default gen_random_uuid()::text,
  created_date timestamptz(3) not null default now(),
  updated_date timestamptz(3) not null default now(),
  created_by_id text,
  is_sample boolean default false,
  "key" text,
  "agent_email" text,
  "lead_id" text,
  "location_id" text,
  "kind" text,
  "state" text default 'new',
  "token" text,
  "ghl_message_id" text,
  "delivery_status" text,
  "step_number" double precision,
  "body" text,
  "result" jsonb,
  "from_number" text,
  "error_code" text,
  constraint message_dispatch_state_check check ("state" is null or "state" in ('new', 'working', 'done', 'uncertain'))
);
create trigger message_dispatch_updated before update on public.message_dispatch for each row execute function public.set_updated_date();
create index if not exists message_dispatch_agent_email_idx on public.message_dispatch ("agent_email");
create unique index if not exists message_dispatch_key_idx on public.message_dispatch ("key");
create index if not exists message_dispatch_state_updated_date_idx on public.message_dispatch ("state", "updated_date");
create index if not exists message_dispatch_agent_email_kind_ghl_message_id_idx on public.message_dispatch ("agent_email", "kind", "ghl_message_id");
create index if not exists message_dispatch_kind_state_delivery_status_idx on public.message_dispatch ("kind", "state", "delivery_status");
alter table public.message_dispatch enable row level security;
create policy message_dispatch_select on public.message_dispatch for select to authenticated using (public.is_admin());
create policy message_dispatch_admin_insert on public.message_dispatch for insert to authenticated with check (public.is_admin());
create policy message_dispatch_admin_update on public.message_dispatch for update to authenticated using (public.is_admin()) with check (public.is_admin());

