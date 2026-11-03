-- ---------------------------------------------------------------------------
-- MessageLog
-- ---------------------------------------------------------------------------
create table if not exists public.message_log (
  id text primary key default gen_random_uuid()::text,
  created_date timestamptz(3) not null default now(),
  updated_date timestamptz(3) not null default now(),
  created_by_id text,
  is_sample boolean default false,
  "agent_email" text,
  "location_id" text,
  "lead_id" text,
  "campaign_id" text,
  "ghl_message_id" text,
  "event_type" text,
  "direction" text,
  "source" text,
  "body" text,
  "status" text,
  "occurred_at" text,
  "step_number" double precision,
  "dispatch_id" text,
  "number" text,
  "error_code" text
);
create trigger message_log_updated before update on public.message_log for each row execute function public.set_updated_date();
create index if not exists message_log_agent_email_idx on public.message_log ("agent_email");
create index if not exists message_log_agent_email_lead_id_event_type_occurred_at_idx on public.message_log ("agent_email", "lead_id", "event_type", "occurred_at");
create index if not exists message_log_agent_email_ghl_message_id_idx on public.message_log ("agent_email", "ghl_message_id");
create index if not exists message_log_event_type_occurred_at_idx on public.message_log ("event_type", "occurred_at");
alter table public.message_log enable row level security;
create policy message_log_admin_select on public.message_log for select to authenticated using (public.is_admin());
create policy message_log_admin_insert on public.message_log for insert to authenticated with check (public.is_admin());
create policy message_log_admin_update on public.message_log for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- PhoneNumber
-- ---------------------------------------------------------------------------
create table if not exists public.phone_number (
  id text primary key default gen_random_uuid()::text,
  created_date timestamptz(3) not null default now(),
  updated_date timestamptz(3) not null default now(),
  created_by_id text,
  is_sample boolean default false,
  "agent_email" text,
  "phone_number" text,
  "phone_sid" text,
  "subaccount_sid" text,
  "label" text,
  "area_code" text,
  "locality" text,
  "is_primary" boolean default false,
  "status" text default 'active',
  "in_messaging_service" boolean default false,
  "voice_configured" boolean default false,
  "profile_assigned" boolean default false,
  "shaken_assigned" boolean default false,
  "cnam_assigned" boolean default false,
  "vi_assigned" boolean default false,
  "monthly_fee_cents" double precision default 0,
  "paid_through" text,
  "purchased_at" text,
  "released_at" text,
  "health" jsonb,
  "health_checked_at" text,
  "last_error" text,
  constraint phone_number_status_check check ("status" is null or "status" in ('active', 'paused', 'unpaid', 'released'))
);
create trigger phone_number_updated before update on public.phone_number for each row execute function public.set_updated_date();
create index if not exists phone_number_agent_email_idx on public.phone_number ("agent_email");
create index if not exists phone_number_agent_email_status_idx on public.phone_number ("agent_email", "status");
alter table public.phone_number enable row level security;
create policy phone_number_select on public.phone_number for select to authenticated using (agent_email = public.jwt_email() or public.is_admin());
create policy phone_number_admin_insert on public.phone_number for insert to authenticated with check (public.is_admin());
create policy phone_number_admin_update on public.phone_number for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy phone_number_admin_delete on public.phone_number for delete to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- PlatformCredential
-- ---------------------------------------------------------------------------
create table if not exists public.platform_credential (
  id text primary key default gen_random_uuid()::text,
  created_date timestamptz(3) not null default now(),
  updated_date timestamptz(3) not null default now(),
  created_by_id text,
  is_sample boolean default false,
  "access_token" text,
  "company_id" text,
  "connected_at" text,
  "expires_at" text,
  "installed_by_user_id" text,
  "is_bulk_installation" boolean,
  "key" text,
  "last_error" text,
  "last_refresh_at" text,
  "refresh_token" text,
  "scope" text
);
create trigger platform_credential_updated before update on public.platform_credential for each row execute function public.set_updated_date();
create unique index if not exists platform_credential_key_idx on public.platform_credential ("key");
alter table public.platform_credential enable row level security;

-- ---------------------------------------------------------------------------
-- PlatformSettings
-- ---------------------------------------------------------------------------
create table if not exists public.platform_settings (
  id text primary key default gen_random_uuid()::text,
  created_date timestamptz(3) not null default now(),
  updated_date timestamptz(3) not null default now(),
  created_by_id text,
  is_sample boolean default false,
  "a2p_packet_template" text,
  "a2p_provider" text default 'manual',
  "agency_company_id" text default 'ZqqdNc830ANRYPqW6rmi',
  "booking_documents" jsonb,
  "credits_enforced" boolean default true,
  "credits_exempt_emails" jsonb,
  "default_recharge_amount_cents" integer default 10000,
  "default_recharge_threshold_cents" integer default 2500,
  "default_send_windows" jsonb,
  "default_sequence_campaign_id" text,
  "default_timezone" text default 'America/Chicago',
  "ghl_client_id" text,
  "ghl_install_url" text,
  "google_oauth_client_id" text,
  "ms_oauth_client_id" text,
  "owner_email" text default 'aidan@usnaturalinsurance.com',
  "owner_alert_phone" text,
  "owner_alert_from_number" text,
  "auto_approve_on_payment" boolean default false,
  "llm_fallback_allowed" boolean default false,
  "phone_number_setup_fee_cents" integer default 0,
  "self_serve_enabled" boolean default true,
  "self_serve_requires_approval" boolean default false,
  "singleton_key" text default 'platform',
  "stripe_mode" text,
  "stripe_price_id" text,
  "subscription_price_cents" integer default 10000,
  "subscription_required" boolean default true,
  "test_plan_template" text,
  "text_price_cents" integer default 3,
  "twilio_isv_email" text,
  "twilio_primary_profile_sid" text,
  "website_spec_template" text,
  "extra_number_monthly_cents" double precision default 300,
  "voice_price_cents_per_min" double precision default 4,
  "max_numbers_per_agent" double precision default 10,
  constraint platform_settings_a2p_provider_check check ("a2p_provider" is null or "a2p_provider" in ('manual', 'twilio')),
  constraint platform_settings_stripe_mode_check check ("stripe_mode" is null or "stripe_mode" in ('test', 'live'))
);
create trigger platform_settings_updated before update on public.platform_settings for each row execute function public.set_updated_date();
create unique index if not exists platform_settings_singleton_key_idx on public.platform_settings ("singleton_key");
alter table public.platform_settings enable row level security;
create policy platform_settings_select on public.platform_settings for select to authenticated using (public.is_admin());
create policy platform_settings_admin_insert on public.platform_settings for insert to authenticated with check (public.is_admin());
create policy platform_settings_admin_update on public.platform_settings for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- Policy
-- ---------------------------------------------------------------------------
create table if not exists public.policy (
  id text primary key default gen_random_uuid()::text,
  created_date timestamptz(3) not null default now(),
  updated_date timestamptz(3) not null default now(),
  created_by_id text,
  is_sample boolean default false,
  "agent_email" text,
  "appointment_id" text,
  "approved_at" text,
  "beneficiary" text,
  "carrier" text,
  "client_name" text,
  "coverage_amount_cents" double precision,
  "coverage_start_date" text,
  "created_at" text,
  "first_draft_date" text,
  "lead_id" text,
  "notes" text,
  "policy_number" text,
  "premium_amount_cents" double precision,
  "premium_frequency" text,
  "product" text,
  "status" text,
  "submitted_at" text,
  constraint policy_premium_frequency_check check ("premium_frequency" is null or "premium_frequency" in ('monthly', 'quarterly', 'semi_annual', 'annual')),
  constraint policy_status_check check ("status" is null or "status" in ('submitted', 'approved', 'declined', 'lapsed', 'cancelled'))
);
create trigger policy_updated before update on public.policy for each row execute function public.set_updated_date();
create index if not exists policy_agent_email_idx on public.policy ("agent_email");
create index if not exists policy_agent_email_lead_id_idx on public.policy ("agent_email", "lead_id");
create index if not exists policy_agent_email_status_idx on public.policy ("agent_email", "status");
alter table public.policy enable row level security;
create policy policy_select on public.policy for select to authenticated using (agent_email = public.jwt_email() or public.is_admin());
create policy policy_admin_insert on public.policy for insert to authenticated with check (public.is_admin());
create policy policy_admin_update on public.policy for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- PreviewRun
-- ---------------------------------------------------------------------------
create table if not exists public.preview_run (
  id text primary key default gen_random_uuid()::text,
  created_date timestamptz(3) not null default now(),
  updated_date timestamptz(3) not null default now(),
  created_by_id text,
  is_sample boolean default false,
  "agent_email" text,
  "campaign_id" text,
  "error" text,
  "model" text,
  "profile" jsonb,
  "prompt_version" double precision,
  "results" jsonb,
  "source" text
);
create trigger preview_run_updated before update on public.preview_run for each row execute function public.set_updated_date();
create index if not exists preview_run_agent_email_idx on public.preview_run ("agent_email");
create index if not exists preview_run_campaign_id_idx on public.preview_run ("campaign_id");
alter table public.preview_run enable row level security;
create policy preview_run_select on public.preview_run for select to authenticated using (public.is_admin());
create policy preview_run_admin_insert on public.preview_run for insert to authenticated with check (public.is_admin());
create policy preview_run_admin_update on public.preview_run for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy preview_run_admin_delete on public.preview_run for delete to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- PromptVersion
-- ---------------------------------------------------------------------------
create table if not exists public.prompt_version (
  id text primary key default gen_random_uuid()::text,
  created_date timestamptz(3) not null default now(),
  updated_date timestamptz(3) not null default now(),
  created_by_id text,
  is_sample boolean default false,
  "agent_email" text,
  "campaign_id" text,
  "knowledge_doc" text,
  "location_id" text,
  "notes" text,
  "system_prompt" text,
  "version" double precision,
  "writer_prompt" text
);
create trigger prompt_version_updated before update on public.prompt_version for each row execute function public.set_updated_date();
create index if not exists prompt_version_agent_email_idx on public.prompt_version ("agent_email");
create index if not exists prompt_version_campaign_id_version_idx on public.prompt_version ("campaign_id", "version");
alter table public.prompt_version enable row level security;
create policy prompt_version_admin_select on public.prompt_version for select to authenticated using (public.is_admin());
create policy prompt_version_admin_insert on public.prompt_version for insert to authenticated with check (public.is_admin());
create policy prompt_version_admin_update on public.prompt_version for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- ProvisioningLog
-- ---------------------------------------------------------------------------
create table if not exists public.provisioning_log (
  id text primary key default gen_random_uuid()::text,
  created_date timestamptz(3) not null default now(),
  updated_date timestamptz(3) not null default now(),
  created_by_id text,
  is_sample boolean default false,
  "agent_email" text,
  "location_id" text,
  "step" text,
  "object_type" text,
  "object_name" text,
  "object_id" text,
  "request_summary" text,
  "response_status" integer,
  "created_at" text
);
create trigger provisioning_log_updated before update on public.provisioning_log for each row execute function public.set_updated_date();
create index if not exists provisioning_log_agent_email_idx on public.provisioning_log ("agent_email");
alter table public.provisioning_log enable row level security;
create policy provisioning_log_select on public.provisioning_log for select to authenticated using (public.is_admin());
create policy provisioning_log_admin_insert on public.provisioning_log for insert to authenticated with check (public.is_admin());
create policy provisioning_log_admin_update on public.provisioning_log for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- ProvisioningTask
-- ---------------------------------------------------------------------------
create table if not exists public.provisioning_task (
  id text primary key default gen_random_uuid()::text,
  created_date timestamptz(3) not null default now(),
  updated_date timestamptz(3) not null default now(),
  created_by_id text,
  is_sample boolean default false,
  "key" text,
  "agent_email" text,
  "kind" text,
  "status" text default 'queued',
  "requested_number" text,
  "registration_id" text,
  "public_note" text,
  "admin_note" text,
  "resolved_by" text,
  "resolved_at" text,
  constraint provisioning_task_kind_check check ("kind" is null or "kind" in ('phone_number', 'a2p')),
  constraint provisioning_task_status_check check ("status" is null or "status" in ('queued', 'working', 'done', 'needs_attention'))
);
create trigger provisioning_task_updated before update on public.provisioning_task for each row execute function public.set_updated_date();
create index if not exists provisioning_task_agent_email_idx on public.provisioning_task ("agent_email");
create unique index if not exists provisioning_task_key_idx on public.provisioning_task ("key");
create index if not exists provisioning_task_agent_email_created_date_idx on public.provisioning_task ("agent_email", "created_date");
alter table public.provisioning_task enable row level security;
create policy provisioning_task_admin_select on public.provisioning_task for select to authenticated using (public.is_admin());
create policy provisioning_task_admin_insert on public.provisioning_task for insert to authenticated with check (public.is_admin());
create policy provisioning_task_admin_update on public.provisioning_task for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- QuickReply
-- ---------------------------------------------------------------------------
create table if not exists public.quick_reply (
  id text primary key default gen_random_uuid()::text,
  created_date timestamptz(3) not null default now(),
  updated_date timestamptz(3) not null default now(),
  created_by_id text,
  is_sample boolean default false,
  "agent_email" text,
  "label" text,
  "text" text,
  "position" double precision,
  "uses" double precision default 0
);
create trigger quick_reply_updated before update on public.quick_reply for each row execute function public.set_updated_date();
create index if not exists quick_reply_agent_email_idx on public.quick_reply ("agent_email");
create index if not exists quick_reply_agent_email_position_idx on public.quick_reply ("agent_email", "position");
alter table public.quick_reply enable row level security;
create policy quick_reply_select on public.quick_reply for select to authenticated using (agent_email = public.jwt_email() or public.is_admin());
create policy quick_reply_admin_insert on public.quick_reply for insert to authenticated with check (public.is_admin());
create policy quick_reply_admin_update on public.quick_reply for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy quick_reply_admin_delete on public.quick_reply for delete to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Referral
-- ---------------------------------------------------------------------------
create table if not exists public.referral (
  id text primary key default gen_random_uuid()::text,
  created_date timestamptz(3) not null default now(),
  updated_date timestamptz(3) not null default now(),
  created_by_id text,
  is_sample boolean default false,
  "code" text,
  "joined_at" text,
  "referee_email" text,
  "referee_reward_cents" double precision,
  "referrer_email" text,
  "referrer_reward_cents" double precision,
  "rewarded_at" text,
  "status" text default 'joined',
  constraint referral_status_check check ("status" is null or "status" in ('joined', 'rewarding', 'rewarded'))
);
create trigger referral_updated before update on public.referral for each row execute function public.set_updated_date();
create index if not exists referral_referrer_email_idx on public.referral ("referrer_email");
create index if not exists referral_referee_email_idx on public.referral ("referee_email");
create index if not exists referral_status_idx on public.referral ("status");
alter table public.referral enable row level security;
create policy referral_select on public.referral for select to authenticated using (public.is_admin());
create policy referral_admin_insert on public.referral for insert to authenticated with check (public.is_admin());
create policy referral_admin_update on public.referral for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy referral_admin_delete on public.referral for delete to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- SavedView
-- ---------------------------------------------------------------------------
create table if not exists public.saved_view (
  id text primary key default gen_random_uuid()::text,
  created_date timestamptz(3) not null default now(),
  updated_date timestamptz(3) not null default now(),
  created_by_id text,
  is_sample boolean default false,
  "agent_email" text,
  "created_at" text,
  "name" text,
  "position" double precision,
  "search" text,
  "sort" text,
  "stage" text,
  "tag" text
);
create trigger saved_view_updated before update on public.saved_view for each row execute function public.set_updated_date();
create index if not exists saved_view_agent_email_idx on public.saved_view ("agent_email");
create index if not exists saved_view_agent_email_position_idx on public.saved_view ("agent_email", "position");
alter table public.saved_view enable row level security;
create policy saved_view_select on public.saved_view for select to authenticated using (agent_email = public.jwt_email() or public.is_admin());
create policy saved_view_admin_insert on public.saved_view for insert to authenticated with check (public.is_admin());
create policy saved_view_admin_update on public.saved_view for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy saved_view_admin_delete on public.saved_view for delete to authenticated using (public.is_admin());

