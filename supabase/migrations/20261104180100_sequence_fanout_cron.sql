-- Sequence engine scheduling, redesigned for 1,000+ agents (pg_cron + pg_net; skipped by scripts/test.sh).
--
-- Before: one 5-minute cron called sequenceSender with no body, and that function paged through every
-- agent and invoked a worker per agent from inside an edge isolate (a 150 s wall clock for a job
-- that grows with the agent count).
-- After: pg_cron fans out from Postgres every minute (public.sequence_fanout), each agent gets its own
-- short worker call (hop 0; the worker chains itself when it runs out of time), and the once-per-platform
-- chores run as a separate 5-minute housekeeping call. net._http_response is trimmed hourly: pg_net keeps
-- every response row and a per-minute fan-out writes one per agent per minute.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- One worker call per active agent: live and carrier-approved, or anyone with fictional test leads.
create or replace function public.sequence_fanout() returns integer
language plpgsql security definer set search_path = public as $$
declare a record; n integer := 0;
begin
  for a in
    select agent_email from public.agent_settings
    where connected = true
      and ((status = 'live' and a2p_status = 'approved') or coalesce(test_leads_at, '') <> '')
    order by agent_email
  loop
    begin
      perform public.invoke_edge_function('sequenceSender', jsonb_build_object('agent_email', a.agent_email, 'hop', 0));
      n := n + 1;
    exception when others then
      raise warning 'sequence_fanout: % failed: %', a.agent_email, sqlerrm;
    end;
  end loop;
  return n;
end $$;
revoke all on function public.sequence_fanout() from public, anon, authenticated;

-- Replace the engine cron; add housekeeping and the pg_net response garbage collector.
-- (`update cron.job` is not permitted on Supabase; only cron.schedule / cron.unschedule.)
select cron.unschedule(jobname) from cron.job where jobname in ('respark_sequence_sender', 'respark_sequence_housekeeping', 'respark_pgnet_gc');
select cron.schedule('respark_sequence_sender',       '* * * * *',   $$select public.sequence_fanout()$$);
select cron.schedule('respark_sequence_housekeeping', '*/5 * * * *', $$select public.invoke_edge_function('sequenceSender', '{"housekeeping":true}')$$);
select cron.schedule('respark_pgnet_gc',              '17 * * * *',  $$delete from net._http_response where created < now() - interval '6 hours'$$);

-- Parked until cutover (Base44 still runs the live engine); re-schedule by running the schedule block in docs/CUTOVER.md.
select cron.unschedule(jobname) from cron.job where jobname like 'respark_%';
