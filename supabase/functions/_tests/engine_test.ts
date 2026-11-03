// End-to-end test of the ported messaging engine on a throwaway Postgres (scripts/test.sh).
//
// Seeds a platform, an admin who is also the agent (onboarding, connected, review mode), installs the
// Life Insurance Respark playbook, then drives the ported handlers as plain Requests with every outside
// HTTP call (Supabase auth, Anthropic, GHL, Twilio, Resend) answered by a mocked fetch:
//   importLeads test_leads → sequenceSender worker sends the openers → simulateInbound "yes, what times"
//   drafts an offer with two calendar slots → reviewDraft approve sends it → simulateInbound "1" books
//   (autopilot) → simulateInbound "STOP" opts out → a later text gets no reply.
import { deepStrictEqual, ok } from 'node:assert/strict';

const SERVICE_KEY = 'service-role-test-key';
const AGENT = 'owner@example.com';
const ADMIN_UID = '44444444-4444-4444-4444-444444444444';
const LOCATION = 'loc_test_1';
const CALENDAR = 'cal_test_1';
Deno.env.set('SUPABASE_URL', 'https://proj.supabase.co');
Deno.env.set('SUPABASE_ANON_KEY', 'anon-test-key');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', SERVICE_KEY);
Deno.env.set('PLATFORM_OWNER_EMAIL', AGENT);
Deno.env.set('ANTHROPIC_API_KEY', 'sk-ant-test');
Deno.env.set('RESEND_API_KEY', 're_test');
Deno.env.set('FROM_EMAIL', 'hello@leadrespark.test');
Deno.env.set('APP_URL', 'https://app.example.com');
Deno.env.set('ENTITIES_STRICT', '1');
const dbUrl = Deno.env.get('TEST_DATABASE_URL');
if (!dbUrl) throw new Error('TEST_DATABASE_URL is not set; run scripts/test.sh');
Deno.env.set('DATABASE_URL', dbUrl);

import { closeSql, getSql, serviceEntities } from '../_shared/entities.ts';
import { ENTITIES } from '../_shared/schema.ts';
import { installPlaybook } from '../_shared/playbooks.ts';
import importLeads from '../importLeads/handler.ts';
import sequenceSender from '../sequenceSender/handler.ts';
import simulateInbound from '../simulateInbound/handler.ts';
import reviewDraft from '../reviewDraft/handler.ts';
import getThread from '../getThread/handler.ts';

// ---------------------------------------------------------------------------
// Mocked outside world
// ---------------------------------------------------------------------------
type Call = { url: string; method: string; body: any };
const calls: Call[] = [];
const unexpected: string[] = [];
const realFetch = globalThis.fetch;

/** Two open calendar times: about 2 and 4 hours from now, rounded to the half hour (same local day when possible). */
function slotPair() {
  const half = 30 * 60000;
  const a = Math.ceil((Date.now() + 2 * 3600000) / half) * half;
  return [new Date(a).toISOString(), new Date(a + 2 * 3600000).toISOString(), new Date(a + 26 * 3600000).toISOString()];
}

globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  let body: any = init.body;
  try { body = JSON.parse(String(init.body)); } catch { /* raw */ }
  calls.push({ url, method, body });
  // Supabase auth: the UI's JWT resolves to the admin (who is also the agent in this scenario).
  if (url.endsWith('/auth/v1/user')) {
    return Response.json({ id: ADMIN_UID, email: AGENT, user_metadata: { full_name: 'Riley Owner' }, aud: 'authenticated', role: 'authenticated', app_metadata: {}, created_at: '2026-01-01T00:00:00Z' });
  }
  // Anthropic: answer by tool use, shaped for whichever schema was requested.
  if (url.startsWith('https://api.anthropic.com/')) {
    const props = body?.tools?.[0]?.input_schema?.properties || {};
    let input: any;
    if (props.reply_text) {
      const inbound = String(body.messages?.[0]?.content || '').match(/LATEST INBOUND\n"([^"\n]*)"/)?.[1] || '';
      input = { reply_text: 'Happy to help.', intent: /time|call|yes/i.test(inbound) ? 'booking' : 'question', sentiment: 'positive', stage: 4, action: 'get_free_slots', chosen_slot_iso: '', needs_human_reason: '', summary: 'Lead asked for call times.' };
    } else {
      input = { text: "Hi there, this is Riley's assistant at Acme Life. You asked about coverage a while back and I wanted to check in. Would a quick call help? Reply STOP to opt out.", angle: 'check-in', facts_used: [] };
    }
    return Response.json({ id: 'msg_test', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'tool_use', id: 'tu_1', name: 'respond', input }], stop_reason: 'tool_use' });
  }
  // GHL
  if (url.startsWith('https://services.leadconnectorhq.com/')) {
    if (url.includes('/free-slots')) { const [a, b, c] = slotPair(); return Response.json({ [a.slice(0, 10)]: { slots: [a, b] }, [c.slice(0, 10)]: { slots: [c] } }); }
    if (url.includes('/customFields')) return Response.json({ customFields: [] });
    if (url.includes('/contacts/')) return Response.json({ contact: { id: 'c_x', locationId: LOCATION } });
    return Response.json({});
  }
  if (url.startsWith('https://api.twilio.com/')) return Response.json({ sid: 'SM00000000000000000000000000000000', status: 'queued' });
  if (url.startsWith('https://api.resend.com/')) return Response.json({ id: 'em_test' });
  unexpected.push(`${method} ${url}`);
  return new Response('unexpected call in test', { status: 500 });
}) as typeof fetch;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const sql = getSql();
const E: any = serviceEntities(sql);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function reset() {
  const tables = Object.values(ENTITIES).map((m) => m.table).filter((t) => t !== 'profiles');
  await sql.unsafe(`TRUNCATE ${tables.map((t) => `public."${t}"`).join(', ')}`);
  await sql.unsafe(`DELETE FROM public.profiles`);
  await sql.unsafe(`DELETE FROM auth.users`);
}

function asUser(body: unknown) {
  return new Request('http://local/fn', { method: 'POST', headers: { Authorization: 'Bearer user-jwt', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
/** What pg_cron (and functions.invoke) send: the service role key. */
function asCron(body: unknown) {
  return new Request('http://local/fn', { method: 'POST', headers: { Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
async function json(res: Response) {
  const text = await res.text();
  let data: any; try { data = JSON.parse(text); } catch { data = text; }
  if (res.status >= 400) throw new Error(`${res.status}: ${typeof data === 'object' ? data?.error : text}`);
  return data;
}

Deno.test({ name: 'engine end to end', sanitizeOps: false, sanitizeResources: false }, async (t) => {
  await reset();
  let s: any, campaign: any, leads: any[] = [], lead: any;

  await t.step('seed: platform, admin profile, connected onboarding agent, Life playbook campaign', async () => {
    await E.PlatformSettings.create({ singleton_key: 'platform', owner_email: AGENT, credits_enforced: true, text_price_cents: 3, default_timezone: 'America/Chicago' });
    await sql`insert into auth.users (id, email, raw_user_meta_data) values (${ADMIN_UID}::uuid, ${AGENT}, ${sql.json({ full_name: 'Riley Owner' })})`;
    const profile = (await sql`select role from public.profiles where id = ${ADMIN_UID}::uuid`)[0];
    deepStrictEqual(profile?.role, 'admin');
    s = await E.AgentSettings.create({
      agent_email: AGENT, location_id: LOCATION, connected: true, status: 'onboarding', mode: 'review', first_name: 'Riley', display_name: 'Riley Owner', brand_name: 'Acme Life',
      licensed_states: ['TX', 'FL', 'AR', 'OK'], home_timezone: 'America/Chicago', ghl_token: 'ghl-test-token', calendar_id: CALENDAR, max_calls_per_day: 6,
      send_window_1: '11:00-13:00', send_window_2: '17:00-19:00', hard_floor: '09:00', hard_ceiling: '20:00', opt_out_keywords: ['STOP', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'],
    });
    campaign = await installPlaybook(E, s, 'life_respark');
    deepStrictEqual(campaign.name, 'Life Insurance Respark');
    deepStrictEqual(campaign.status, 'draft');
    const fresh = await E.Campaign.get(campaign.id);
    deepStrictEqual(fresh.cadence, 'daily');
    const steps = await E.SequenceStep.filter({ campaign_id: campaign.id }, { limit: 300 });
    ok(steps.items.length > 10, 'playbook installed its follow-up series');
    ok(steps.items.some((st: any) => st.step_number === 1 && st.variant === 'A' && st.cadence === 'daily'));
  });

  await t.step('importLeads test_leads creates 4 queued test leads (one held, one duplicate)', async () => {
    const out = await json(await importLeads(asUser({ action: 'test_leads' })));
    deepStrictEqual(out.test, true);
    deepStrictEqual(out.imported, 4);
    deepStrictEqual(out.held, 1);
    deepStrictEqual(out.duplicate, 1);
    deepStrictEqual(out.errors, 0);
    leads = (await E.Lead.filter({ agent_email: AGENT, status: 'queued' }, { sort: 'created_date', limit: 10 })).items;
    deepStrictEqual(leads.length, 4);
    for (const l of leads) { ok(/^\+1\d{3}55501\d{2}$/.test(l.phone), 'reserved 555-01xx number'); ok(l.timezone); deepStrictEqual(l.sequence_paused, false); }
    s = (await E.AgentSettings.filter({ agent_email: AGENT }, { limit: 1 })).items[0];
    ok(s.test_leads_at, 'agent is marked for test-lead runs');
  });

  await t.step('sequenceSender worker (service key, as pg_cron) sends the 4 openers', async () => {
    const out = await json(await sequenceSender(asCron({ agent_email: AGENT })));
    deepStrictEqual(out.sent, 4, JSON.stringify(out));
    deepStrictEqual(out.failed, 0);
    const logs = await E.MessageLog.filter({ agent_email: AGENT, event_type: 'sms_sent', source: 'sequence' }, { limit: 20 });
    deepStrictEqual(logs.items.length, 4);
    for (const m of logs.items) { ok(/^DRY/.test(m.ghl_message_id), 'fake carrier id, nothing left the building'); deepStrictEqual(m.step_number, 1); ok(/reply stop to opt out\.?$/i.test(m.body), m.body); }
    const jobs = await E.MessageDispatch.filter({ agent_email: AGENT, kind: 'sms' }, { limit: 20 });
    deepStrictEqual(jobs.items.length, 4);
    for (const j of jobs.items) { deepStrictEqual(j.state, 'done'); deepStrictEqual(j.delivery_status, 'delivered'); deepStrictEqual(j.result?.sent, true); }
    for (const l of leads) {
      const cur = await E.Lead.get(l.id);
      deepStrictEqual(cur.status, 'in_sequence'); deepStrictEqual(cur.current_step, 1); deepStrictEqual(cur.step1_delivered, true); ok(cur.next_send_at > new Date().toISOString(), 'next step scheduled');
    }
    ok(!calls.some((c) => c.url.startsWith('https://api.twilio.com/')), 'test leads are never sent through Twilio');
    // A second run finds nothing due.
    const again = await json(await sequenceSender(asCron({ agent_email: AGENT })));
    deepStrictEqual(again.sent, 0);
    // Dispatcher mode (what the */5 cron calls) sees the agent through test_leads_at even before they are live.
    deepStrictEqual(await json(await sequenceSender(asCron({ dry_run: true }))), { scanned_accounts: 1, has_more: false });
    // Without the service key or a user, the cron entry point refuses.
    deepStrictEqual((await sequenceSender(new Request('http://local/fn', { method: 'POST', body: '{}' }))).status, 400);
  });

  await t.step('simulateInbound "yes, what times" drafts an offer with two calendar slots (review mode)', async () => {
    lead = leads[0];
    const out = await json(await simulateInbound(asUser({ lead_id: lead.id, body: 'yes, what times' })));
    deepStrictEqual(out.stopped, false);
    deepStrictEqual(out.duplicate, false);
    deepStrictEqual(out.reply, { drafted: true });
    ok(calls.some((c) => c.url.includes(`/calendars/${CALENDAR}/free-slots`)), 'asked the calendar for free slots');
    const drafts = await E.AIDraft.filter({ lead_id: lead.id, status: 'pending' }, { limit: 5 });
    deepStrictEqual(drafts.items.length, 1);
    const d = drafts.items[0];
    deepStrictEqual(d.proposed_action, 'get_free_slots');
    deepStrictEqual(d.offered_slots.length, 2);
    ok(/1\) .* or 2\) .*Just reply 1 or 2\./.test(d.proposed_text), d.proposed_text);
    const cur = await E.Lead.get(lead.id);
    deepStrictEqual(cur.status, 'replied');
    deepStrictEqual(cur.sequence_paused, true);
    deepStrictEqual(cur.ai_intent, 'booking');
    const summary = (await E.ConversationSummary.filter({ lead_id: lead.id }, { limit: 1 })).items[0];
    deepStrictEqual(summary.has_pending_draft, true);
    deepStrictEqual(summary.last_direction, 'inbound');
    deepStrictEqual(summary.unread, true);
  });

  await t.step('reviewDraft approve delivers the offer', async () => {
    const d = (await E.AIDraft.filter({ lead_id: lead.id, status: 'pending' }, { limit: 1 })).items[0];
    const out = await json(await reviewDraft(asUser({ action: 'approve', draft_id: d.id })));
    deepStrictEqual(out.sent, true);
    ok(/^DRY/.test(out.message_id));
    const sent = await E.AIDraft.get(d.id);
    deepStrictEqual(sent.status, 'sent');
    deepStrictEqual(sent.reviewed_by, AGENT);
    const cur = await E.Lead.get(lead.id);
    deepStrictEqual(cur.offered_slots, d.offered_slots);
    ok(cur.offered_at);
    const logs = await E.MessageLog.filter({ lead_id: lead.id, event_type: 'sms_sent', source: 'ai' }, { limit: 5 });
    deepStrictEqual(logs.items.length, 1);
    deepStrictEqual(logs.items[0].body, d.proposed_text);
    const audit = await E.ControlAudit.filter({ lead_id: lead.id, action: 'draft_approve' }, { limit: 1 });
    deepStrictEqual(audit.items.length, 1);
    // Approving twice is a no-op.
    deepStrictEqual(await json(await reviewDraft(asUser({ action: 'approve', draft_id: d.id }))), { sent: true });
  });

  await t.step('simulateInbound "1" books the first offered slot (autopilot)', async () => {
    await E.AgentSettings.update(s.id, { mode: 'autopilot' });
    await E.Campaign.update(campaign.id, { mode: 'autopilot' });
    const before = await E.Lead.get(lead.id);
    const out = await json(await simulateInbound(asUser({ lead_id: lead.id, body: '1' })));
    deepStrictEqual(out.reply?.sent, true, JSON.stringify(out));
    const cur = await E.Lead.get(lead.id);
    deepStrictEqual(cur.status, 'booked');
    deepStrictEqual(cur.ai_paused, true);
    deepStrictEqual(cur.sequence_paused, true);
    deepStrictEqual(cur.offered_slots, []);
    const appts = await E.Appointment.filter({ lead_id: lead.id }, { limit: 5 });
    deepStrictEqual(appts.items.length, 1);
    deepStrictEqual(appts.items[0].status, 'booked');
    deepStrictEqual(appts.items[0].start_time, before.offered_slots[0]);
    ok(/^test:/.test(appts.items[0].ghl_appointment_id), 'test-lead appointments never reach the calendar provider');
    const confirm = await E.MessageLog.filter({ lead_id: lead.id, event_type: 'sms_sent', source: 'booking' }, { limit: 5 });
    deepStrictEqual(confirm.items.length, 1);
    ok(/booked for/.test(confirm.items[0].body), confirm.items[0].body);
    const draft = (await E.AIDraft.filter({ lead_id: lead.id, proposed_action: 'book_appointment' }, { limit: 1 })).items[0];
    deepStrictEqual(draft.status, 'sent');
    deepStrictEqual(draft.reviewed_by, 'automatic');
    const booked = await E.MessageLog.filter({ lead_id: lead.id, event_type: 'status_changed', status: 'booked' }, { limit: 1 });
    deepStrictEqual(booked.items.length, 1);
    const summary = (await E.ConversationSummary.filter({ lead_id: lead.id }, { limit: 1 })).items[0];
    deepStrictEqual(summary.status_chip, 'booked');
    const thread = await json(await getThread(asUser({ summary_id: summary.id })));
    ok(Array.isArray(thread.messages) && thread.messages.length >= 4, 'thread lists the conversation');
    deepStrictEqual(thread.lead.status, 'booked');
    ok(!('send_lock_token' in thread.lead) && !('location_id' in thread.lead), 'internal fields are not exposed');
  });

  await t.step('simulateInbound "STOP" opts out, and a later message gets no reply', async () => {
    const out = await json(await simulateInbound(asUser({ lead_id: lead.id, body: 'STOP' })));
    deepStrictEqual(out.stopped, true);
    deepStrictEqual(out.reply, { stopped: true });
    let cur = await E.Lead.get(lead.id);
    deepStrictEqual(cur.status, 'opted_out');
    deepStrictEqual(cur.ai_paused, true);
    const sentBefore = await E.MessageLog.count({ lead_id: lead.id, event_type: 'sms_sent' });
    const draftsBefore = await E.AIDraft.count({ lead_id: lead.id });
    const anthropicBefore = calls.filter((c) => c.url.startsWith('https://api.anthropic.com/')).length;

    const later = await json(await simulateInbound(asUser({ lead_id: lead.id, body: 'actually, what times did you have?' })));
    deepStrictEqual(later.stopped, false);
    deepStrictEqual(later.reply, { stopped: true });
    cur = await E.Lead.get(lead.id);
    deepStrictEqual(cur.status, 'opted_out');
    deepStrictEqual(await E.MessageLog.count({ lead_id: lead.id, event_type: 'sms_sent' }), sentBefore, 'nothing was sent after STOP');
    deepStrictEqual(await E.AIDraft.count({ lead_id: lead.id }), draftsBefore, 'no draft was written after STOP');
    deepStrictEqual(calls.filter((c) => c.url.startsWith('https://api.anthropic.com/')).length, anthropicBefore, 'the AI was not even asked');
    deepStrictEqual(await E.MessageLog.count({ lead_id: lead.id, event_type: 'inbound_sms' }), 4);
    // The sender's safety net also leaves an opted-out lead alone.
    const run = await json(await sequenceSender(asCron({ agent_email: AGENT })));
    deepStrictEqual(run.sent, 0);
    deepStrictEqual(await E.MessageLog.count({ lead_id: lead.id, event_type: 'sms_sent' }), sentBefore);
  });

  await t.step('no outside call went anywhere unexpected', async () => {
    await sleep(300); // background work started with waitUntil (booked-call journey)
    deepStrictEqual(unexpected, []);
  });

  globalThis.fetch = realFetch;
  await closeSql();
});
