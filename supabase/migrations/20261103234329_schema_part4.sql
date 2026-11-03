-- ---------------------------------------------------------------------------
-- SequenceStep
-- ---------------------------------------------------------------------------
create table if not exists public.sequence_step (
  id text primary key default gen_random_uuid()::text,
  created_date timestamptz(3) not null default now(),
  updated_date timestamptz(3) not null default now(),
  created_by_id text,
  is_sample boolean default false,
  "agent_email" text,
  "cadence" text,
  "slot" text,
  "kind" text,
  "body" text,
  "brief" text,
  "campaign_id" text,
  "day_offset" double precision,
  "lever" text,
  "location_id" text,
  "requires_step1_delivered" boolean,
  "step_number" double precision,
  "variant" text,
  constraint sequence_step_slot_check check ("slot" is null or "slot" in ('am', 'pm')),
  constraint sequence_step_kind_check check ("kind" is null or "kind" in ('opener', 'choice', 'breakup', 'close', 'normal')),
  constraint sequence_step_variant_check check ("variant" is null or "variant" in ('A', 'B', 'none'))
);
create trigger sequence_step_updated before update on public.sequence_step for each row execute function public.set_updated_date();
create index if not exists sequence_step_agent_email_idx on public.sequence_step ("agent_email");
create index if not exists sequence_step_campaign_id_step_number_idx on public.sequence_step ("campaign_id", "step_number");
alter table public.sequence_step enable row level security;
create policy sequence_step_admin_select on public.sequence_step for select to authenticated using (public.is_admin());
create policy sequence_step_admin_insert on public.sequence_step for insert to authenticated with check (public.is_admin());
create policy sequence_step_admin_update on public.sequence_step for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- StatsSnapshot
-- ---------------------------------------------------------------------------
create table if not exists public.stats_snapshot (
  id text primary key default gen_random_uuid()::text,
  created_date timestamptz(3) not null default now(),
  updated_date timestamptz(3) not null default now(),
  created_by_id text,
  is_sample boolean default false,
  "agent_email" text,
  "location_id" text,
  "campaign_id" text,
  "range" text,
  "computed_at" text,
  "metrics" jsonb
);
create trigger stats_snapshot_updated before update on public.stats_snapshot for each row execute function public.set_updated_date();
create index if not exists stats_snapshot_agent_email_idx on public.stats_snapshot ("agent_email");
create index if not exists stats_snapshot_agent_email_campaign_id_idx on public.stats_snapshot ("agent_email", "campaign_id");
alter table public.stats_snapshot enable row level security;
create policy stats_snapshot_admin_select on public.stats_snapshot for select to authenticated using (public.is_admin());
create policy stats_snapshot_admin_insert on public.stats_snapshot for insert to authenticated with check (public.is_admin());
create policy stats_snapshot_admin_update on public.stats_snapshot for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- SupportRequest
-- ---------------------------------------------------------------------------
create table if not exists public.support_request (
  id text primary key default gen_random_uuid()::text,
  created_date timestamptz(3) not null default now(),
  updated_date timestamptz(3) not null default now(),
  created_by_id text,
  is_sample boolean default false,
  "agent_email" text,
  "agent_name" text,
  "answered_at" text,
  "context" jsonb,
  "created_at" text,
  "message" text,
  "page" text,
  "replies" jsonb,
  "status" text default 'open',
  constraint support_request_status_check check ("status" is null or "status" in ('open', 'answered', 'closed'))
);
create trigger support_request_updated before update on public.support_request for each row execute function public.set_updated_date();
create index if not exists support_request_agent_email_idx on public.support_request ("agent_email");
create index if not exists support_request_agent_email_created_at_idx on public.support_request ("agent_email", "created_at");
create index if not exists support_request_status_idx on public.support_request ("status");
alter table public.support_request enable row level security;
create policy support_request_select on public.support_request for select to authenticated using (agent_email = public.jwt_email() or public.is_admin());
create policy support_request_admin_insert on public.support_request for insert to authenticated with check (public.is_admin());
create policy support_request_admin_update on public.support_request for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy support_request_admin_delete on public.support_request for delete to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- SystemEvent
-- ---------------------------------------------------------------------------
create table if not exists public.system_event (
  id text primary key default gen_random_uuid()::text,
  created_date timestamptz(3) not null default now(),
  updated_date timestamptz(3) not null default now(),
  created_by_id text,
  is_sample boolean default false,
  "action_href" text,
  "action_label" text,
  "agent_email" text,
  "agent_notified_at" text,
  "agent_visible" boolean,
  "data" jsonb,
  "detail" text,
  "first_seen_at" text,
  "key" text,
  "kind" text,
  "last_seen_at" text,
  "lead_id" text,
  "occurrences" double precision,
  "owner_notified_at" text,
  "resolved_at" text,
  "scope" text default 'platform',
  "severity" text default 'warning',
  "status" text default 'open',
  "title" text,
  constraint system_event_scope_check check ("scope" is null or "scope" in ('platform', 'agent')),
  constraint system_event_severity_check check ("severity" is null or "severity" in ('info', 'warning', 'critical')),
  constraint system_event_status_check check ("status" is null or "status" in ('open', 'resolved'))
);
create trigger system_event_updated before update on public.system_event for each row execute function public.set_updated_date();
create index if not exists system_event_agent_email_idx on public.system_event ("agent_email");
create index if not exists system_event_status_last_seen_at_idx on public.system_event ("status", "last_seen_at");
create index if not exists system_event_key_idx on public.system_event ("key");
create index if not exists system_event_agent_email_status_idx on public.system_event ("agent_email", "status");
alter table public.system_event enable row level security;
create policy system_event_select on public.system_event for select to authenticated using ((agent_email = public.jwt_email() and agent_visible = true) or public.is_admin());
create policy system_event_admin_insert on public.system_event for insert to authenticated with check (public.is_admin());
create policy system_event_admin_update on public.system_event for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy system_event_admin_delete on public.system_event for delete to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- TwilioAccount
-- ---------------------------------------------------------------------------
create table if not exists public.twilio_account (
  id text primary key default gen_random_uuid()::text,
  created_date timestamptz(3) not null default now(),
  updated_date timestamptz(3) not null default now(),
  created_by_id text,
  is_sample boolean default false,
  "agent_email" text,
  "created_at" text,
  "friendly_name" text,
  "location_id" text,
  "phone_number" text,
  "phone_sid" text,
  "source" text,
  "subaccount_sid" text,
  "webhook_url" text,
  "shaken_sid" text,
  "shaken_status" text,
  "cnam_sid" text,
  "cnam_status" text,
  "cnam_name" text,
  "vi_sid" text,
  "vi_status" text,
  "trust_note" text,
  "trust_checked_at" text,
  constraint twilio_account_source_check check ("source" is null or "source" in ('created', 'matched', 'admin'))
);
create trigger twilio_account_updated before update on public.twilio_account for each row execute function public.set_updated_date();
create index if not exists twilio_account_agent_email_idx on public.twilio_account ("agent_email");
create index if not exists twilio_account_phone_number_idx on public.twilio_account ("phone_number");
create index if not exists twilio_account_subaccount_sid_idx on public.twilio_account ("subaccount_sid");
alter table public.twilio_account enable row level security;
create policy twilio_account_select on public.twilio_account for select to authenticated using (public.is_admin());
create policy twilio_account_admin_insert on public.twilio_account for insert to authenticated with check (public.is_admin());
create policy twilio_account_admin_update on public.twilio_account for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- WebsiteSubmission
-- ---------------------------------------------------------------------------
create table if not exists public.website_submission (
  id text primary key default gen_random_uuid()::text,
  created_date timestamptz(3) not null default now(),
  updated_date timestamptz(3) not null default now(),
  created_by_id text,
  is_sample boolean default false,
  "request_key" text,
  "agent_email" text,
  "lead_id" text,
  "ip_hash" text,
  "submitted_at" text,
  "first_name" text,
  "last_name" text,
  "email" text,
  "phone" text,
  "state" text,
  "product_interest" text,
  "consent_checked" boolean,
  "consent_text" text,
  "contact_id" text,
  "opportunity_id" text,
  "sync_status" text,
  "notification_sent" boolean default false,
  constraint website_submission_sync_status_check check ("sync_status" is null or "sync_status" in ('received', 'pending', 'synced'))
);
create trigger website_submission_updated before update on public.website_submission for each row execute function public.set_updated_date();
create index if not exists website_submission_agent_email_idx on public.website_submission ("agent_email");
create index if not exists website_submission_agent_email_submitted_at_idx on public.website_submission ("agent_email", "submitted_at");
create index if not exists website_submission_request_key_idx on public.website_submission ("request_key");
create index if not exists website_submission_lead_id_idx on public.website_submission ("lead_id");
alter table public.website_submission enable row level security;
create policy website_submission_select on public.website_submission for select to authenticated using (agent_email = public.jwt_email() or public.is_admin());
create policy website_submission_admin_insert on public.website_submission for insert to authenticated with check (public.is_admin());
create policy website_submission_admin_update on public.website_submission for update to authenticated using (public.is_admin()) with check (public.is_admin());

