-- Schedules the Base44 workflows as pg_cron jobs and replaces the one live entity trigger
-- ("Appointment Booked Journey") with a Postgres trigger. Both call edge functions over pg_net
-- with a shared cron secret (header x-cron-secret), which runtime.ts maps to the platform admin.
--
-- Before applying, store two secrets in Vault (Dashboard → Integrations → Vault → Secrets, or SQL):
--   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--   select vault.create_secret('<long random string>', 'cron_secret');   -- same value as the edge function secret CRON_SECRET
create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.invoke_edge_function(fn text, body jsonb default '{}'::jsonb) returns bigint
language plpgsql security definer set search_path = public as $$
declare base_url text; secret text; request_id bigint;
begin
  select decrypted_secret into base_url from vault.decrypted_secrets where name = 'project_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'cron_secret';
  if base_url is null or secret is null then raise exception 'vault secrets project_url / cron_secret are missing'; end if;
  select net.http_post(
    url := base_url || '/functions/v1/' || fn,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', secret),
    body := body,
    timeout_milliseconds := 150000
  ) into request_id;
  return request_id;
end $$;
revoke all on function public.invoke_edge_function(text, jsonb) from public, anon, authenticated;

-- Workflows → crons. pg_cron runs in UTC; the Base44 schedules were America/Chicago, so the three
-- daily jobs are placed at their CDT hour (one hour earlier in CST). Adjust if that matters.
select cron.unschedule(jobname) from cron.job where jobname like 'respark_%';
select cron.schedule('respark_sequence_sender',       '*/5 * * * *',  $$select public.invoke_edge_function('sequenceSender')$$);
select cron.schedule('respark_appointment_reminders', '*/5 * * * *',  $$select public.invoke_edge_function('appointmentReminders')$$);
select cron.schedule('respark_platform_health',       '*/15 * * * *', $$select public.invoke_edge_function('health')$$);
select cron.schedule('respark_a2p_status',            '*/30 * * * *', $$select public.invoke_edge_function('a2pAdvance')$$);
select cron.schedule('respark_daily_brief',           '0 13 * * *',   $$select public.invoke_edge_function('dailyBrief')$$);                                   -- 8:00 Chicago (CDT)
select cron.schedule('respark_subscription_sync',     '15 10 * * *',  $$select public.invoke_edge_function('adminSubscriptions', '{"action":"sync"}')$$);     -- 5:15 Chicago (CDT)
select cron.schedule('respark_twilio_check',          '0 11 * * *',   $$select public.invoke_edge_function('adminTwilio', '{"action":"status","record":true}')$$); -- 6:00 Chicago (CDT)

-- "Appointment Booked Journey": status == booked and (created, or start_time changed, or was not booked).
create or replace function public.appointment_booked_journey() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'booked' and (tg_op = 'INSERT' or new.start_time is distinct from old.start_time or old.status is distinct from 'booked') then
    perform public.invoke_edge_function('appointmentJourney', jsonb_build_object('appointment_id', new.id));
  end if;
  return new;
end $$;
drop trigger if exists appointment_booked_journey on public.appointment;
create trigger appointment_booked_journey after insert or update on public.appointment
  for each row execute function public.appointment_booked_journey();
