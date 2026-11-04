-- Scale and audit fixes (hand-written; schema.ts edited to match for the new column).
-- Everything here is idempotent. The pg_cron / pg_net half of this change set lives in
-- 20261104180100_sequence_fanout_cron.sql (skipped by scripts/test.sh like every *_cron* file).

-- ---------------------------------------------------------------------------
-- 1. One row per agent for the per-agent tables the code upserts/filters by email.
--    (Production holds exactly one row per email; the retired duplicate was renamed beforehand.)
-- ---------------------------------------------------------------------------
create unique index if not exists agent_settings_agent_email_uq on public.agent_settings (lower(agent_email));
create unique index if not exists agent_settings_public_slug_uq on public.agent_settings (public_slug) where public_slug is not null and public_slug <> '';
create unique index if not exists billing_account_agent_email_uq on public.billing_account (lower(agent_email));
create unique index if not exists a2p_registration_agent_email_uq on public.a2p_registration (lower(agent_email));
create unique index if not exists twilio_account_agent_email_uq on public.twilio_account (lower(agent_email));

-- ---------------------------------------------------------------------------
-- 2. Per-agent GHL webhook secret (hidden: not added to v_agent_settings; schema.ts lists it under hidden).
-- ---------------------------------------------------------------------------
alter table public.agent_settings add column if not exists ghl_webhook_secret text;
create index if not exists agent_settings_ghl_webhook_secret_idx on public.agent_settings (ghl_webhook_secret);

-- ---------------------------------------------------------------------------
-- 3. Storage: private "uploads" bucket, admin-only object access. Guarded so the migration also
--    applies on a plain Postgres (the local test harness has no storage schema).
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') and to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values ('uploads', 'uploads', false) on conflict (id) do nothing;
    execute 'drop policy if exists uploads_admin_select on storage.objects';
    execute 'drop policy if exists uploads_admin_insert on storage.objects';
    execute 'drop policy if exists uploads_admin_update on storage.objects';
    execute 'drop policy if exists uploads_admin_delete on storage.objects';
    execute $p$create policy uploads_admin_select on storage.objects for select to authenticated using (bucket_id = 'uploads' and public.is_admin())$p$;
    execute $p$create policy uploads_admin_insert on storage.objects for insert to authenticated with check (bucket_id = 'uploads' and public.is_admin())$p$;
    execute $p$create policy uploads_admin_update on storage.objects for update to authenticated using (bucket_id = 'uploads' and public.is_admin()) with check (bucket_id = 'uploads' and public.is_admin())$p$;
    execute $p$create policy uploads_admin_delete on storage.objects for delete to authenticated using (bucket_id = 'uploads' and public.is_admin())$p$;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Anonymous role: no table or view access, now or for tables created later. Agents read their
--    own prompt versions (the view used to be admin-only).
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on tables from anon;

create or replace view public.v_prompt_version with (security_barrier) as
  select "id", "created_date", "updated_date", "created_by_id", "is_sample", "agent_email", "campaign_id", "knowledge_doc", "notes", "system_prompt", "version", "writer_prompt" from public.prompt_version where agent_email = public.jwt_email() or public.is_admin();
grant select on public.v_prompt_version to authenticated;

-- ---------------------------------------------------------------------------
-- 5. profiles ↔ auth.users email sync, and a sign-up that tolerates a stale profile email.
--    profiles.email always mirrors auth.users.email: a profile row whose email belongs to a
--    different auth user is stale and is corrected from auth.users before the insert/update.
-- ---------------------------------------------------------------------------
alter function public.set_updated_date() set search_path = public;
alter function public.jwt_email() set search_path = public;

create or replace function public.repair_profile_email(p_id uuid, p_email text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_email is null then return; end if;
  -- Another profile holds this email: refresh it from its own auth user (auth emails are unique, so
  -- it cannot still equal p_email), or drop it when its auth user is gone.
  delete from public.profiles p where lower(p.email) = lower(p_email) and p.id <> p_id and not exists (select 1 from auth.users u where u.id = p.id);
  update public.profiles p set email = u.email from auth.users u where u.id = p.id and lower(p.email) = lower(p_email) and p.id <> p_id;
end $$;
revoke all on function public.repair_profile_email(uuid, text) from public, anon, authenticated;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare owner boolean;
begin
  -- The platform owner (PlatformSettings.owner_email) is an admin from the first sign-in; everyone else is an agent.
  select exists(select 1 from public.platform_settings where lower(owner_email) = lower(new.email)) into owner;
  perform public.repair_profile_email(new.id, new.email);
  insert into public.profiles (id, email, full_name, role)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', ''),
          case when owner then 'admin' when new.raw_user_meta_data->>'role' in ('agent', 'user') then new.raw_user_meta_data->>'role' else 'agent' end)
  on conflict (id) do update set email = excluded.email;
  return new;
end $$;

create or replace function public.handle_user_email_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.repair_profile_email(new.id, new.email);
  update public.profiles set email = new.email where id = new.id;
  return new;
end $$;
drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed after update of email on auth.users
  for each row when (old.email is distinct from new.email) execute function public.handle_user_email_change();

-- ---------------------------------------------------------------------------
-- 6. Trigger functions are not callable by clients. (is_admin stays callable: policies use it.)
-- ---------------------------------------------------------------------------
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.handle_user_email_change() from public, anon, authenticated;
do $$ begin
  if to_regprocedure('public.appointment_booked_journey()') is not null then
    execute 'revoke execute on function public.appointment_booked_journey() from public, anon, authenticated';
  end if;
end $$;

-- Advisor: evaluate auth.uid() once per statement, not once per row.
drop policy if exists profiles_self_select on public.profiles;
create policy profiles_self_select on public.profiles for select to authenticated using (id = (select auth.uid()) or public.is_admin());

-- ---------------------------------------------------------------------------
-- 7. Indexes for the engine's hot queries. The adapter sorts ascending with NULLS FIRST, so the
--    indexes that back a sorted scan on a nullable text column are declared `nulls first` too.
-- ---------------------------------------------------------------------------
create index if not exists message_log_agent_email_event_type_occurred_at_idx on public.message_log ("agent_email", "event_type", "occurred_at");
create index if not exists message_log_lead_id_event_type_occurred_at_idx on public.message_log ("lead_id", "event_type", "occurred_at");
-- One inbound row per carrier message id per agent. The webhook paths catch 23505 and answer {duplicate:true}.
-- Check production for existing duplicates before applying:
--   select agent_email, ghl_message_id, count(*) from public.message_log where event_type = 'inbound_sms' and ghl_message_id is not null group by 1, 2 having count(*) > 1;
create unique index if not exists message_log_inbound_sid_uniq on public.message_log (agent_email, ghl_message_id) where event_type = 'inbound_sms' and ghl_message_id is not null;
create index if not exists message_dispatch_receipts_idx on public.message_dispatch ("created_date") where kind = 'sms' and state = 'done' and ghl_message_id is not null and (delivery_status is null or delivery_status not in ('delivered', 'read', 'failed', 'undelivered'));
create index if not exists lead_last_inbound_at_idx on public.lead ("last_inbound_at") where last_inbound_at is not null;
create index if not exists lead_due_idx on public.lead ("agent_email", "next_send_at" nulls first, "id") where status in ('queued', 'in_sequence') and sequence_paused = false and sequence_waiting_review is distinct from true;
create index if not exists conversation_summary_agent_email_status_chip_idx on public.conversation_summary ("agent_email", "status_chip");
create index if not exists conversation_summary_agent_email_unread_idx on public.conversation_summary ("agent_email") where unread = true;
create index if not exists conversation_summary_agent_email_pending_draft_idx on public.conversation_summary ("agent_email") where has_pending_draft = true;
create index if not exists conversation_summary_agent_email_last_time_idx on public.conversation_summary ("agent_email", "last_time" nulls first, "id");
create index if not exists ai_draft_agent_email_status_created_date_idx on public.ai_draft ("agent_email", "status", "created_date" nulls first);

-- a2pSubmit takes a ProvisioningTask lock (kind 'a2p_submit') so two tabs cannot register two brands.
alter table public.provisioning_task drop constraint if exists provisioning_task_kind_check;
alter table public.provisioning_task add constraint provisioning_task_kind_check check ("kind" is null or "kind" in ('phone_number', 'a2p', 'a2p_submit'));
