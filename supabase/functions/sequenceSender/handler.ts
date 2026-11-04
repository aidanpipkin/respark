import { isInfraError } from '../_shared/entityRetry.ts';
// Sequence sender, built to scale to 1,000+ agents.
//  - Worker ({agent_email, hop}): sends that agent's due follow-ups and autopilot replies, under a short
//    lock so overlapping runs never process the same agent twice. Stops at WORKER_DEADLINE_MS and, when
//    work is left, chains one more call to itself (hop + 1, at most 6 hops) after releasing the lock.
//  - Fan-out: pg_cron calls public.sequence_fanout() every minute, which invokes one worker per live
//    agent straight from Postgres (no dispatcher function on the hot path).
//  - Housekeeping ({housekeeping: true}, every 5 minutes): welcome emails, stuck-dispatch reaper, heartbeat.
//  - Legacy dispatcher (no body): still pages through agents and fans out from inside the function, for
//    the parked 5-minute cron and manual runs.
import { adminContext } from '../_shared/agentAccess.ts';
import { isRehearsal, isTestLead, TEST_PHONE_RE } from '../_shared/rehearsal.ts';
import { heartbeat, bump, flushBumps } from '../_shared/signals.ts';
import { failure } from '../_shared/ghl.ts';
import { runSequenceLead } from '../_shared/messageSequence.ts';
import { flagHuman, logMessage } from '../_shared/messageJobs.ts';
import { deliverDraft } from '../_shared/messageDrafts.ts';
import { clockOpen } from '../_shared/messageClock.ts';
import { loadCursor, saveCursor } from '../_shared/sweepCursor.ts';
import { waitUntil } from '../_shared/runtime.ts';
import { freshSettings } from '../_shared/ghlAuth.ts';
import { canSend, billingContext } from '../_shared/credits.ts';
import { runPersistence } from '../_shared/persistence.ts';
import { runTracks } from '../_shared/trackEngine.ts';
import { sweepUnanswered } from '../_shared/aiReplyCore.ts';
import { syncChangedLeads } from '../_shared/crmSync.ts';
import { sendWelcomes } from '../_shared/agentEmails.ts';
import { dayBounds } from '../_shared/messageClock.ts';
import { raise } from '../_shared/signals.ts';

/**
 * How many follow-ups this agent may still send today, after three brakes:
 *  - the daily cap (carrier limits for the agent's brand),
 *  - a ramp for new agents (a sudden spike from a new number gets filtered),
 *  - an automatic pause when opt-outs spike (carriers throttle senders whose opt-outs run high).
 */
async function budget(base44: any, E: any, s: any) {
  if (isRehearsal(s)) return 250;
  if (s.throttle_until && Date.parse(s.throttle_until) > Date.now()) return 0;
  const tz = s.home_timezone || 'America/Chicago';
  const { start } = dayBounds(Date.now(), tz);
  const sentToday = await E.MessageLog.count({ agent_email: s.agent_email, event_type: 'sms_sent', source: { $in: ['sequence', 'nudge', 'nurture'] }, occurred_at: { $gte: start } });
  if (sentToday >= 150) {
    const optOuts = await E.Lead.count({ agent_email: s.agent_email, status: 'opted_out', updated_date: { $gte: start } });
    if (optOuts / sentToday > 0.04) {
      const until = new Date(Date.now() + 20 * 3600000).toISOString();
      await E.AgentSettings.update(s.id, { throttle_until: until }).catch(() => {});
      await raise(base44, { key: `optout_spike:${s.agent_email}:${start.slice(0, 10)}`, kind: 'send_failures', severity: 'critical', scope: 'agent', agent_email: s.agent_email, notifyOwner: true, agent_visible: true,
        title: 'Follow-ups paused for today: opt-outs are high', detail: `${optOuts} of ${sentToday} people texted today opted out. Carriers throttle numbers above about 5%, so follow-ups pause until tomorrow to protect your number. Consider the Recommended cadence on the Campaigns page.`, action_label: 'Open campaigns', action_href: '/campaigns' }).catch(() => {});
      return 0;
    }
  }
  const daysLive = s.live_at ? Math.floor((Date.now() - Date.parse(s.live_at)) / 86400000) : 0;
  const ramp = Math.min(DEFAULT_DAILY_CAP * 10, 300 * 2 ** Math.min(daysLive, 6)); // 300, 600, 1,200 ... per day for a new agent
  const cap = Math.min(Number(s.daily_send_cap) || DEFAULT_DAILY_CAP, ramp);
  return Math.max(0, cap - sentToday);
}

const PARALLEL = 60;
// New leads started per agent per run (a run is one minute tick, or one hop). Spreads first texts out, which carriers favor for new numbers.
const PER_AGENT_PER_RUN = 20;
// A partial worker chains itself at most this many times per tick before leaving the rest to the next minute.
const MAX_HOPS = 6;
// Default daily follow-up budget per agent: the T-Mobile cap for a new, unvetted 10DLC brand. Admins can raise it per agent.
const DEFAULT_DAILY_CAP = 2000;
const LOCK_MS = 4 * 60 * 1000;

/**
 * Per-agent lock in EngineCursor (`seqlock:<email>`, cursor = claim timestamp). A minute tick that
 * lands while a worker still holds the lock skips the agent (the running worker, or its hop chain,
 * carries on). A lock older than LOCK_MS is treated as abandoned by a killed isolate and taken over.
 * Returns the row id and the claim value, so the release can be conditional on still owning it.
 */
export async function claimAgent(E: any, email: string): Promise<{ id: string; claim: string } | false> {
  const key = `seqlock:${email}`;
  const now = Date.now();
  const row = (await E.EngineCursor.upsert([{ key }], { key: 'key' })).records[0];
  if (Number(row.cursor || 0) > now - LOCK_MS) return false;
  const claim = String(now);
  const claimed = await E.EngineCursor.updateMany({ id: row.id, cursor: row.cursor ?? null }, { $set: { cursor: claim } });
  return Number(claimed?.updated || 0) > 0 ? { id: row.id, claim } : false;
}

// Edge functions get a wall clock of about 150 s (EDGE_WALL_CLOCK_MS when the plan differs). A worker
// stops cleanly well inside it and returns partial counts; the chained hop picks up where it left off.
const WALL_MS = Number(Deno.env.get('EDGE_WALL_CLOCK_MS')) || 150000;
const WORKER_DEADLINE_MS = Math.max(15000, Math.min(90000, WALL_MS - 45000));
// Tests shorten the worker budget to force a partial run (SEQUENCE_WORKER_DEADLINE_MS); unset in production.
const workerDeadlineMs = () => Number(Deno.env.get('SEQUENCE_WORKER_DEADLINE_MS')) || WORKER_DEADLINE_MS;
// The legacy in-function dispatcher stops paging here and continues with a cursor.
const DISPATCH_DEADLINE_MS = Math.max(15000, Math.min(60000, WALL_MS - 60000));
// Dispatch jobs left 'working' this long with no carrier id were abandoned by a killed run.
const STUCK_MS = 10 * 60 * 1000;
const REAP_CAP = 200;

/** Resets MessageDispatch rows stuck in 'working' (no provider id, no result) so the next tick retries them. */
async function reapStuckDispatches(E: any) {
  let reaped = 0;
  try {
    const before = new Date(Date.now() - STUCK_MS).toISOString();
    const page = await E.MessageDispatch.filter({ state: 'working', updated_date: { $lte: before } }, { sort: 'updated_date', limit: REAP_CAP });
    const at = new Date().toISOString();
    for (const job of page.items) {
      if (job.ghl_message_id) continue;
      if (job.result && typeof job.result === 'object' && Object.keys(job.result).length && !job.result.reaped) continue;
      const r = await E.MessageDispatch.updateMany({ id: job.id, state: 'working' }, { $set: { state: 'new', token: '', result: { reaped: true, at } } }).catch(() => null);
      if (Number(r?.updated || 0) > 0) reaped++;
    }
  } catch (e) { console.error('[sequenceSender] reaper', (e as Error).message); }
  return reaped;
}

async function runAgent(base44: any, E: any, raw: any) {
  const out = { sent: 0, drafted: 0, skipped: 0, failed: 0, partial: false };
  const lock = await claimAgent(E, raw.agent_email);
  if (!lock) { out.skipped++; return out; }
  const deadline = Date.now() + workerDeadlineMs();
  const timeLeft = () => Date.now() < deadline;
  const stop = () => { out.partial = true; return out; };
  try {
    let s;
    try { s = await freshSettings(base44, raw); } catch { out.failed++; return out; }
    const billing = await billingContext(E, s.agent_email);
    const paying = await canSend(E, s.agent_email, billing);
    const testOnly = !paying || raw.a2p_status !== 'approved' || !raw.phone_number || raw.status !== 'live';
    // Test leads run against draft campaigns too, so an agent can watch the AI work before going live.
    const campaigns = await E.Campaign.filter({ agent_email: s.agent_email, location_id: s.location_id, ...(testOnly ? { status: { $in: ['active', 'draft'] } } : { status: 'active' }) }, { limit: 50 });
    // Safety nets that don't depend on credits: unanswered inbound texts and the GHL pipeline mirror.
    if (!isRehearsal(s)) {
      try { await sweepUnanswered(base44, s); } catch { /* next run */ }
      if (!timeLeft()) return stop();
      try { await syncChangedLeads(base44, s); } catch { /* next run */ }
      if (!timeLeft()) return stop();
    }
    // Fictional 555-01xx test leads need no number, carrier approval or credits. An agent who cannot
    // send real texts yet (or has run out of credits) still runs their test leads.
    if (!testOnly) {
      // Post-appointment tracks run even if no campaign is active (clients must still be cared for).
      try {
        const t = await runTracks(base44, s, campaigns.items);
        out.sent += t.sent; out.drafted += t.drafted; out.skipped += t.skipped; out.failed += t.failed;
      } catch { out.failed++; }
      if (!timeLeft()) return stop();
    }
    if (!campaigns.items.length) { if (testOnly) out.skipped++; return out; }
    const left = testOnly ? PER_AGENT_PER_RUN : await budget(base44, E, s);
    const now = new Date().toISOString();
    const due: any = { agent_email: s.agent_email, campaign_id: { $in: campaigns.items.map((c: any) => c.id) }, status: { $in: ['queued', 'in_sequence'] }, sequence_paused: false, sequence_waiting_review: { $ne: true }, $or: [{ next_send_at: { $lte: now } }, { next_send_at: { $exists: false } }, { next_send_at: '' }, { next_send_at: null }] };
    if (testOnly) due.phone = { $regex: TEST_PHONE_RE.source };
    const leads = left <= 0 ? { items: [] } : await E.Lead.filter(due, { sort: 'next_send_at', limit: isRehearsal(s) ? 250 : Math.min(PER_AGENT_PER_RUN, left) });
    if (testOnly && !leads.items.length) { out.skipped++; return out; }
    // Every step of the campaigns with due leads, read once for the whole run (per-lead reads were the bulk of the load).
    let steps: any[] | undefined;
    if (leads.items.length) {
      const ids = [...new Set(leads.items.map((l: any) => l.campaign_id))];
      const page = await E.SequenceStep.filter({ campaign_id: { $in: ids } }, { limit: 1000 }).catch(() => null);
      if (page && !page.has_more) steps = page.items;
    }
    for (let i = 0; i < leads.items.length; i += 6) {
      if (!timeLeft()) return stop();
      const results = await Promise.allSettled(leads.items.slice(i, i + 6).map(async (lead: any) => {
        const campaign = campaigns.items.find((c: any) => c.id === lead.campaign_id);
        try { return await runSequenceLead(base44, s, lead, campaign, { steps, campaign, billing }); }
        catch (error: any) { if (error?.name === 'CampaignInactive') { await E.Lead.update(lead.id, { next_send_at: new Date(Date.now() + 3600000).toISOString() }).catch(() => {}); return { skipped: true }; } if (error?.name === 'OutOfCredits' || error?.name === 'Transient' || error?.name === 'Busy' || isInfraError(error)) { await bump(base44, 'engine_transient').catch(() => {}); return { skipped: true }; } await flagHuman(base44, s, lead, error.message); return { failed: true }; }
      }));
      for (const r of results) { if (r.status === 'rejected') { out.failed++; continue; } const v: any = r.value || {}; out.sent += v.sent ? 1 : 0; out.drafted += v.drafted ? 1 : 0; out.skipped += v.skipped ? 1 : 0; out.failed += v.failed ? 1 : 0; }
    }
    if (testOnly) return out;
    if (!timeLeft()) return stop();
    // Persistent follow-up: quiet conversations and long-term check-ins.
    try {
      const p = await runPersistence(base44, s, campaigns.items);
      out.sent += p.sent; out.drafted += p.drafted; out.skipped += p.skipped; out.failed += p.failed;
    } catch { out.failed++; }
    if (!timeLeft()) return stop();
    if (s.mode === 'autopilot') {
      const pending = await E.AIDraft.filter({ agent_email: s.agent_email, status: 'pending', source: 'ai', campaign_id: { $in: campaigns.items.filter((c: any) => c.mode === 'autopilot').map((c: any) => c.id) } }, { sort: 'created_date', limit: 10 });
      for (const draft of pending.items) {
        if (!timeLeft()) return stop();
        const lead = await E.Lead.get(draft.lead_id);
        if (lead.last_inbound_at !== draft.trigger_at || lead.ai_paused) { await E.AIDraft.update(draft.id, { status: 'discarded', edit_reason: 'No longer current' }); continue; }
        if (!lead.timezone || (!isTestLead(lead) && !clockOpen(s, lead.timezone))) continue;
        if (draft.send_after && Date.parse(draft.send_after) > Date.now()) continue; // still inside its human-like delay
        try { const r = await deliverDraft(base44, draft, 'automatic'); out.sent += r.sent ? 1 : 0; }
        catch (error: any) { out.failed++; await logMessage(base44, s, lead, { event_type: 'draft_held', source: 'engine', direction: 'internal', body: error.message, status: 'pending' }); }
      }
    }
    return out;
  } finally {
    // Release only if the lock still carries our claim (a takeover after LOCK_MS must not be undone).
    await E.EngineCursor.updateMany({ id: lock.id, cursor: lock.claim }, { $set: { cursor: '0' } }).catch(() => {});
    await flushBumps(E).catch(() => {});
  }
}

export default async function (req: Request) {
  try {
    const { base44 } = await adminContext(req);
    const input = await req.json().catch(() => ({}));
    const E = base44.asServiceRole.entities;
    const totals = { sent: 0, drafted: 0, skipped: 0, failed: 0, agents: 0 };
    const add = (o: any) => { for (const k of ['sent', 'drafted', 'skipped', 'failed']) (totals as any)[k] += o[k] || 0; totals.agents++; };
    let reaped = 0;

    // Worker mode: one agent.
    if (typeof input.agent_email === 'string') {
      // No carrier-approval gate here: an approved agent runs everything, an unapproved one only their fictional test leads.
      const raw = (await E.AgentSettings.filter({ agent_email: input.agent_email, connected: true }, { limit: 1 })).items[0];
      if (!raw || !(raw.status === 'live' || raw.test_leads_at)) return Response.json({ skipped: 'not active' });
      const hop = Math.max(0, Math.floor(Number(input.hop) || 0));
      const out = await runAgent(base44, E, raw);
      add(out);
      // Work left over: chain one more worker for this agent. runAgent has released the lock (finally)
      // by now, so the chained call can claim it; a minute tick arriving meanwhile simply finds it taken.
      let chained = false;
      if (out.partial && hop < MAX_HOPS) {
        chained = true;
        waitUntil(base44.functions.invoke('sequenceSender', { agent_email: input.agent_email, hop: hop + 1 }).catch((e: Error) => console.error('[sequenceSender] hop chain failed', input.agent_email, e.message)));
      }
      return Response.json({ ...totals, partial: out.partial, hop, chained });
    }

    // Housekeeping mode (every 5 minutes): the once-per-platform chores the per-agent workers don't do.
    if (input.housekeeping === true) {
      try { await sendWelcomes(base44); } catch { /* next run */ }
      reaped = await reapStuckDispatches(E);
      await heartbeat(base44, 'sequence_sender', { housekeeping: true, reaped });
      await flushBumps(E).catch(() => {});
      return Response.json({ housekeeping: true, reaped });
    }

    // Legacy dispatcher mode (no body): fan out from inside the function.
    if (!input.cursor && input.dry_run !== true) { try { await sendWelcomes(base44); } catch { /* next run */ } }
    // Free dispatch jobs abandoned by a killed run, before any worker starts.
    if (!input.cursor && input.dry_run !== true) reaped = await reapStuckDispatches(E);
    // Rolling pool: up to PARALLEL agent workers run at once, and a new one starts the moment any
    // finishes (no waiting for the slowest agent in a batch). Each worker is its own function call
    // with its own time limit, and a per-agent lock means overlapping runs never double-send.
    const deadline = Date.now() + DISPATCH_DEADLINE_MS;
    let cursor = input.cursor || (input.dry_run ? undefined : await loadCursor(base44, 'sequence'));
    const inflight = new Set<Promise<void>>();
    let launched = 0;
    do {
      // Live, approved agents, plus anyone who created fictional test leads (they run in test-only mode).
      const page = await E.AgentSettings.filter({ connected: true, $or: [{ status: 'live', a2p_status: 'approved' }, { test_leads_at: { $exists: true, $nin: ['', null] } }] }, { sort: 'agent_email', limit: 100, cursor, fields: ['agent_email'] });
      if (input.dry_run === true) return Response.json({ scanned_accounts: page.items.length, has_more: page.has_more });
      for (const a of page.items) {
        const p: Promise<void> = base44.functions.invoke('sequenceSender', { agent_email: a.agent_email, hop: 0 })
          .then((r: any) => add(r?.data || {}), () => { totals.failed++; })
          .finally(() => { inflight.delete(p); });
        inflight.add(p); launched++;
        if (inflight.size >= PARALLEL) await Promise.race(inflight);
      }
      cursor = page.has_more ? page.next_cursor : undefined;
      await saveCursor(base44, 'sequence', cursor);
    } while (cursor && Date.now() < deadline);
    if (cursor) waitUntil(base44.functions.invoke('sequenceSender', { cursor }));
    // Let the last workers finish in the background; the schedule doesn't wait on them.
    if (inflight.size) waitUntil(Promise.allSettled([...inflight]));
    await heartbeat(base44, 'sequence_sender', { launched, sent: totals.sent, failed: totals.failed, reaped });
    await flushBumps(E).catch(() => {});
    return Response.json({ ...totals, launched, reaped, still_running: inflight.size, next_cursor: cursor || null });
  } catch (error) { return failure(error as Error); }
}
