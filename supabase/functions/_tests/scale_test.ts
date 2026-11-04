// Scale fixes (audit): cached clocks, legal-band clamp, worker hop chaining and lock, Transient AI
// failures handed back to the sweep, long reply delays deferred to the engine, a2pAdvance paging,
// duplicate inbound sids, LLM retry hints and model allow-list. Runs on the throwaway Postgres of
// scripts/test.sh after onboarding_test (same process; every outside call is mocked).
import { deepStrictEqual, ok, notDeepStrictEqual } from 'node:assert/strict';

const SERVICE_KEY = 'service-role-test-key';
const AGENT = 'scale-owner@example.com';
const ADMIN_UID = '55555555-5555-5555-5555-555555555555';
const LOCATION = 'loc_scale_1';
Deno.env.set('SUPABASE_URL', 'https://proj.supabase.co');
Deno.env.set('SUPABASE_ANON_KEY', 'anon-test-key');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', SERVICE_KEY);
Deno.env.set('PLATFORM_OWNER_EMAIL', AGENT);
Deno.env.set('ANTHROPIC_API_KEY', 'sk-ant-test');
Deno.env.set('RESEND_API_KEY', 're_test');
Deno.env.set('FROM_EMAIL', 'hello@leadrespark.test');
Deno.env.set('APP_URL', 'https://app.example.com');
Deno.env.set('ENTITIES_STRICT', '1');
Deno.env.set('TWILIO_ACCOUNT_SID', 'AC' + 'a'.repeat(32));
Deno.env.set('TWILIO_AUTH_TOKEN', 'twilio-test-token');
const dbUrl = Deno.env.get('TEST_DATABASE_URL');
if (!dbUrl) throw new Error('TEST_DATABASE_URL is not set; run scripts/test.sh');
Deno.env.set('DATABASE_URL', dbUrl);

import { closeSql, getSql, serviceEntities } from '../_shared/entities.ts';
import { ENTITIES } from '../_shared/schema.ts';
import { installPlaybook } from '../_shared/playbooks.ts';
import { localParts, labelSlot, clockOpen, dayBounds, zonedMidnight } from '../_shared/messageClock.ts';
import { cadenceOpen, stepTime, LEGAL_FLOOR, LEGAL_CEIL } from '../_shared/cadenceClock.ts';
import { retryAfterMs, anthropicModel, ANTHROPIC_MODELS, llmInflight } from '../_shared/llm.ts';
import { MAX_INLINE_WAIT_S } from '../_shared/messageTiming.ts';
import { recordInbound } from '../_shared/messageWebhook.ts';
import { replyToInbound } from '../_shared/aiReplyCore.ts';
import { createClientFromRequest } from '../_shared/runtime.ts';
import importLeads from '../importLeads/handler.ts';
import sequenceSender, { claimAgent } from '../sequenceSender/handler.ts';
import simulateInbound from '../simulateInbound/handler.ts';
import a2pAdvance from '../a2pAdvance/handler.ts';

// ---------------------------------------------------------------------------
// Mocked outside world
// ---------------------------------------------------------------------------
type Call = { url: string; method: string; body: any; headers: Headers };
const calls: Call[] = [];
const unexpected: string[] = [];
const realFetch = globalThis.fetch;
let anthropicMode: 'ok' | 'fail429' = 'ok';
let anthropicAttempts = 0;

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
  calls.push({ url, method, body, headers: new Headers(init.headers as HeadersInit) });
  if (url.endsWith('/auth/v1/user')) {
    return Response.json({ id: ADMIN_UID, email: AGENT, user_metadata: { full_name: 'Sam Scale' }, aud: 'authenticated', role: 'authenticated', app_metadata: {}, created_at: '2026-01-01T00:00:00Z' });
  }
  if (url.startsWith('https://api.anthropic.com/')) {
    anthropicAttempts++;
    if (anthropicMode === 'fail429') return new Response('{"error":{"type":"rate_limit_error"}}', { status: 429, headers: { 'retry-after': '0' } });
    const props = body?.tools?.[0]?.input_schema?.properties || {};
    let input: any;
    if (props.reply_text) input = { reply_text: 'Happy to help.', intent: 'booking', sentiment: 'positive', stage: 4, action: 'get_free_slots', chosen_slot_iso: '', needs_human_reason: '', summary: 'Lead asked for call times.' };
    else input = { text: "Hi there, this is Sam's assistant at Acme Life. You asked about coverage a while back and I wanted to check in. Would a quick call help? Reply STOP to opt out.", angle: 'check-in', facts_used: [] };
    return Response.json({ id: 'msg_test', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'tool_use', id: 'tu_1', name: 'respond', input }], stop_reason: 'tool_use' });
  }
  if (url.startsWith('https://services.leadconnectorhq.com/')) {
    if (url.includes('/free-slots')) { const [a, b, c] = slotPair(); return Response.json({ [a.slice(0, 10)]: { slots: [a, b] }, [c.slice(0, 10)]: { slots: [c] } }); }
    if (url.includes('/customFields')) return Response.json({ customFields: [] });
    if (url.includes('/contacts/')) return Response.json({ contact: { id: 'c_x', locationId: LOCATION } });
    return Response.json({});
  }
  // The worker chaining itself (functions.invoke → POST /functions/v1/sequenceSender).
  if (url === 'https://proj.supabase.co/functions/v1/sequenceSender') return Response.json({ sent: 0, drafted: 0, skipped: 0, failed: 0, agents: 1, hop: body?.hop });
  if (url.startsWith('https://api.twilio.com/') || url.includes('.twilio.com/')) return Response.json({});
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
function asCron(body: unknown) {
  return new Request('http://local/fn', { method: 'POST', headers: { Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
async function json(res: Response) {
  const text = await res.text();
  let data: any; try { data = JSON.parse(text); } catch { data = text; }
  if (res.status >= 400) throw new Error(`${res.status}: ${typeof data === 'object' ? data?.error : text}`);
  return data;
}
/** A time zone where it is mid-day right now, so the clock gates are open regardless of when the suite runs. */
function daytimeZone() {
  const zones = ['Pacific/Honolulu', 'America/Anchorage', 'America/Los_Angeles', 'America/Chicago', 'America/New_York', 'America/Sao_Paulo', 'Europe/London', 'Europe/Berlin', 'Europe/Moscow', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Shanghai', 'Asia/Tokyo', 'Australia/Sydney', 'Pacific/Auckland'];
  return zones.find((tz) => { const h = Number(localParts(Date.now(), tz).hour); return h >= 11 && h <= 17; }) || 'America/Chicago';
}

// ---------------------------------------------------------------------------
// Pure modules
// ---------------------------------------------------------------------------
Deno.test('messageClock: cached formatters give the same output as a fresh Intl.DateTimeFormat', () => {
  const zones = ['America/Chicago', 'America/New_York', 'America/Los_Angeles', 'Pacific/Honolulu', 'Europe/London', 'Asia/Kolkata'];
  const whens = ['2026-03-08T07:30:00Z', '2026-03-08T08:30:00Z', '2026-11-01T06:15:00Z', '2026-07-04T23:59:00Z', '2026-12-31T05:00:00Z', Date.now()];
  for (const tz of zones) for (const at of whens) {
    for (let i = 0; i < 2; i++) { // second pass hits the cache
      const fresh: any = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at)).map((p) => [p.type, p.value]));
      const got = localParts(at, tz);
      deepStrictEqual([got.year, got.month, got.day, got.hour, got.minute], [fresh.year, fresh.month, fresh.day, fresh.hour, fresh.minute]);
      deepStrictEqual(got.date, `${fresh.year}-${fresh.month}-${fresh.day}`);
      deepStrictEqual(got.minutes, Number(fresh.hour) * 60 + Number(fresh.minute));
      const iso = new Date(at).toISOString();
      deepStrictEqual(labelSlot(iso, tz), new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(iso)));
    }
  }
  // Derived helpers still agree with themselves across DST: midnight of a local day is 00:00 there.
  for (const tz of zones) for (const day of ['2026-03-08', '2026-11-01', '2026-06-15']) deepStrictEqual(localParts(zonedMidnight(day, tz), tz).minutes, 0);
  const b = dayBounds('2026-11-01T18:00:00Z', 'America/Chicago');
  deepStrictEqual([b.start, b.end], ['2026-11-01T05:00:00.000Z', '2026-11-02T06:00:00.000Z']); // the day DST ends: 25 hours
  const s = { hard_floor: '09:00', hard_ceiling: '20:00', quiet_start: '20:00', quiet_end: '09:00' };
  deepStrictEqual(clockOpen(s, 'America/Chicago', false, Date.parse('2026-06-15T17:00:00Z')), true);  // noon Chicago
  deepStrictEqual(clockOpen(s, 'America/Chicago', false, Date.parse('2026-06-15T03:00:00Z')), false); // 10pm Chicago
});

Deno.test('cadenceClock: campaign send_rules are clamped to the 8:00-21:00 legal band', () => {
  deepStrictEqual([LEGAL_FLOOR, LEGAL_CEIL], [8 * 60, 21 * 60]);
  const tz = 'America/Chicago', s = { agent_email: 'x@example.com' };
  const wide = { weekday: { open: '05:00', close: '23:30' }, sunday: { open: '06:00', close: '23:00' } };
  const at = (local: string) => Date.parse(`2026-06-16T${local}:00-05:00`); // a Tuesday, CDT
  deepStrictEqual(cadenceOpen(s, tz, at('07:30'), wide), false, 'never before 8am, whatever the rule says');
  deepStrictEqual(cadenceOpen(s, tz, at('08:00'), wide), true);
  deepStrictEqual(cadenceOpen(s, tz, at('20:59'), wide), true);
  deepStrictEqual(cadenceOpen(s, tz, at('21:00'), wide), false, 'never at or after 9pm');
  const sun = (local: string) => Date.parse(`2026-06-14T${local}:00-05:00`);
  deepStrictEqual(cadenceOpen(s, tz, sun('07:00'), wide), false);
  deepStrictEqual(cadenceOpen(s, tz, sun('12:00'), wide), true);
  deepStrictEqual(cadenceOpen(s, tz, sun('21:30'), wide), false);
  // Defaults (9:30-6:30) are inside the band and unchanged.
  deepStrictEqual(cadenceOpen(s, tz, at('09:29')), false);
  deepStrictEqual(cadenceOpen(s, tz, at('09:30')), true);
  deepStrictEqual(cadenceOpen(s, tz, at('18:30')), false);
  // A rule that is entirely outside the band means nothing may go out that day.
  deepStrictEqual(cadenceOpen(s, tz, at('23:00'), { weekday: { open: '22:00', close: '23:59' } }), false);
  // stepTime keeps a step inside the band even when the rule opens at 5am (slot am starts 10:00 anyway).
  const t = stepTime(s, { id: 'lead1', timezone: tz }, '2026-06-15T15:00:00Z', 1, 'am', false, wide);
  ok(t && localParts(t, tz).minutes >= LEGAL_FLOOR && localParts(t, tz).minutes < LEGAL_CEIL, String(t));
});

Deno.test('llm: Retry-After parsing, model allow-list, in-flight cap', () => {
  deepStrictEqual(retryAfterMs('3'), 3000);
  deepStrictEqual(retryAfterMs(''), null);
  deepStrictEqual(retryAfterMs(null), null);
  deepStrictEqual(retryAfterMs('garbage'), null);
  const soon = retryAfterMs(new Date(Date.now() + 5000).toUTCString());
  ok(soon !== null && soon > 0 && soon <= 5000, String(soon));
  for (const m of ANTHROPIC_MODELS) deepStrictEqual(anthropicModel({ model: m }), m);
  deepStrictEqual(anthropicModel({ model: 'claude-3-opus-20240229' }), 'claude-sonnet-5-5', 'unknown ids fall back to the default');
  deepStrictEqual(anthropicModel({}), 'claude-sonnet-5-5');
  Deno.env.set('LLM_MODEL', 'claude-haiku-5-5');
  deepStrictEqual(anthropicModel({ model: 'not-a-model' }), 'claude-haiku-5-5');
  Deno.env.delete('LLM_MODEL');
  deepStrictEqual(llmInflight().max, 6);
  deepStrictEqual(MAX_INLINE_WAIT_S, 45);
});

// ---------------------------------------------------------------------------
// Engine on Postgres
// ---------------------------------------------------------------------------
Deno.test({ name: 'scale fixes on the engine', sanitizeOps: false, sanitizeResources: false }, async (t) => {
  await reset();
  let s: any, campaign: any, leads: any[] = [];
  const base44: any = createClientFromRequest(asCron({}));

  await t.step('seed: platform, admin/agent, Life playbook campaign, 4 test leads with their openers sent', async () => {
    await E.PlatformSettings.create({ singleton_key: 'platform', owner_email: AGENT, credits_enforced: true, text_price_cents: 3, default_timezone: 'America/Chicago' });
    await sql`insert into auth.users (id, email, raw_user_meta_data) values (${ADMIN_UID}::uuid, ${AGENT}, ${sql.json({ full_name: 'Sam Scale' })})`;
    s = await E.AgentSettings.create({
      agent_email: AGENT, location_id: LOCATION, connected: true, status: 'onboarding', mode: 'review', first_name: 'Sam', display_name: 'Sam Scale', brand_name: 'Acme Life',
      licensed_states: ['TX', 'FL', 'AR', 'OK'], home_timezone: 'America/Chicago', ghl_token: 'ghl-test-token', calendar_id: 'cal_scale_1', max_calls_per_day: 6,
      send_window_1: '11:00-13:00', send_window_2: '17:00-19:00', hard_floor: '09:00', hard_ceiling: '20:00', opt_out_keywords: ['STOP', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'],
    });
    campaign = await installPlaybook(E, s, 'life_respark');
    deepStrictEqual((await json(await importLeads(asUser({ action: 'test_leads' })))).imported, 4);
    const out = await json(await sequenceSender(asCron({ agent_email: AGENT })));
    deepStrictEqual([out.sent, out.failed, out.partial, out.hop, out.chained], [4, 0, false, 0, false], JSON.stringify(out));
    leads = (await E.Lead.filter({ agent_email: AGENT, status: 'in_sequence' }, { sort: 'created_date', limit: 10 })).items;
    deepStrictEqual(leads.length, 4);
    s = (await E.AgentSettings.filter({ agent_email: AGENT }, { limit: 1 })).items[0];
  });

  await t.step('claimAgent: a second claim is refused while the lock is held; release is conditional on the claim', async () => {
    const lock = await claimAgent(E, AGENT);
    ok(lock && lock.id && lock.claim, 'claimed');
    deepStrictEqual(await claimAgent(E, AGENT), false, 'a minute tick that lands mid-run skips the agent');
    const skipped = await json(await sequenceSender(asCron({ agent_email: AGENT })));
    deepStrictEqual([skipped.sent, skipped.skipped, skipped.chained], [0, 1, false], 'the worker itself skips too');
    // A stale release (wrong claim value) must not clear a lock someone else holds.
    await E.EngineCursor.updateMany({ id: (lock as any).id, cursor: 'someone-else' }, { $set: { cursor: '0' } });
    deepStrictEqual((await E.EngineCursor.get((lock as any).id)).cursor, (lock as any).claim);
    await E.EngineCursor.updateMany({ id: (lock as any).id, cursor: (lock as any).claim }, { $set: { cursor: '0' } });
    ok(await claimAgent(E, AGENT), 'free again');
    await E.EngineCursor.updateMany({ key: `seqlock:${AGENT}` }, { $set: { cursor: '0' } });
  });

  await t.step('worker hop chaining: a partial run invokes itself with hop+1 after releasing the lock; hop 6 stops', async () => {
    Deno.env.set('SEQUENCE_WORKER_DEADLINE_MS', '1');
    try {
      const mark = calls.length;
      const out = await json(await sequenceSender(asCron({ agent_email: AGENT, hop: 2 })));
      deepStrictEqual([out.partial, out.hop, out.chained], [true, 2, true], JSON.stringify(out));
      await sleep(150); // waitUntil runs the chained call in the background
      const chained = calls.slice(mark).filter((c) => c.url === 'https://proj.supabase.co/functions/v1/sequenceSender');
      deepStrictEqual(chained.length, 1);
      deepStrictEqual(chained[0].body, { agent_email: AGENT, hop: 3 });
      deepStrictEqual(chained[0].headers.get('authorization'), `Bearer ${SERVICE_KEY}`, 'the chained worker is a service-role call');
      const lock = (await E.EngineCursor.filter({ key: `seqlock:${AGENT}` }, { limit: 1 })).items[0];
      deepStrictEqual(lock.cursor, '0', 'the lock was released before the chained call could claim it');
      const mark2 = calls.length;
      const last = await json(await sequenceSender(asCron({ agent_email: AGENT, hop: 6 })));
      deepStrictEqual([last.partial, last.hop, last.chained], [true, 6, false], 'the chain ends at the hop cap; the next minute tick continues');
      await sleep(100);
      deepStrictEqual(calls.slice(mark2).filter((c) => c.url.endsWith('/functions/v1/sequenceSender')).length, 0);
    } finally { Deno.env.delete('SEQUENCE_WORKER_DEADLINE_MS'); }
    // Housekeeping mode does the once-per-platform chores and never fans out.
    const mark3 = calls.length;
    const hk = await json(await sequenceSender(asCron({ housekeeping: true })));
    deepStrictEqual(hk, { housekeeping: true, reaped: 0 });
    deepStrictEqual(calls.slice(mark3).filter((c) => c.url.endsWith('/functions/v1/sequenceSender')).length, 0);
    const beat = (await E.EngineCursor.filter({ key: 'heartbeat:sequence_sender' }, { limit: 1 })).items[0];
    ok(beat, 'housekeeping writes the engine heartbeat');
  });

  await t.step('Transient AI failure: the job goes back to new (no agent flag, no text), the sweep retries it', async () => {
    const lead = leads[0];
    anthropicMode = 'fail429'; anthropicAttempts = 0;
    let out: any;
    try { out = await json(await simulateInbound(asUser({ lead_id: lead.id, body: 'yes, what times do you have' }))); } finally { anthropicMode = 'ok'; }
    ok(out.reply?.error && /temporarily unavailable/i.test(out.reply.error), JSON.stringify(out.reply));
    ok(anthropicAttempts >= 3 && anthropicAttempts % 3 === 0, `retried on 429 with Retry-After: 0 (3 tries per call), then gave up: ${anthropicAttempts}`);
    const inbound = await E.MessageLog.get(out.logged);
    const job = (await E.MessageDispatch.filter({ key: `ai:${AGENT}:${inbound.ghl_message_id}` }, { limit: 1 })).items[0];
    deepStrictEqual([job.state, job.token, job.result?.retry], ['new', '', true], JSON.stringify(job));
    const cur = await E.Lead.get(lead.id);
    deepStrictEqual(cur.status, 'replied', 'not flagged needs_human');
    deepStrictEqual(await E.AIDraft.count({ lead_id: lead.id }), 0);
    deepStrictEqual(await E.MessageLog.count({ lead_id: lead.id, event_type: 'needs_human' }), 0);
    // Make the inbound old enough for the sweep (which skips the last 60 s) and run the agent's worker.
    const earlier = new Date(Date.now() - 120000).toISOString();
    await E.MessageLog.update(inbound.id, { occurred_at: earlier });
    await E.Lead.update(lead.id, { last_inbound_at: earlier });
    const run = await json(await sequenceSender(asCron({ agent_email: AGENT })));
    deepStrictEqual(run.failed, 0, JSON.stringify(run));
    const retried = await E.MessageDispatch.get(job.id);
    deepStrictEqual(retried.state, 'done', JSON.stringify(retried));
    ok(retried.result?.draft_id, 'the sweep produced the draft');
    deepStrictEqual(await E.AIDraft.count({ lead_id: lead.id, status: 'pending' }), 1);
    // A second sweep leaves a finished job alone.
    const anthropicBefore = anthropicAttempts;
    await json(await sequenceSender(asCron({ agent_email: AGENT })));
    deepStrictEqual(anthropicAttempts, anthropicBefore);
  });

  await t.step('reply delay over 45 s is written to send_after and left to the engine, not awaited in the request', async () => {
    // A real (non-555) lead on a live, approved agent with an active autopilot campaign.
    await E.AgentSettings.update(s.id, { mode: 'autopilot', status: 'live', a2p_status: 'approved', phone_number: '+15125550100' });
    await E.Campaign.update(campaign.id, { mode: 'autopilot', status: 'active' });
    const tz = daytimeZone();
    const at = new Date().toISOString(), sid = 'SMreal00000000000000000000000000001';
    const lead = await E.Lead.create({ agent_email: AGENT, location_id: LOCATION, ghl_contact_id: 'real_1', phone: '+15125551234', first_name: 'Dana', state: 'TX', timezone: tz, status: 'replied', campaign_id: campaign.id, current_step: 1, sequence_paused: true, ai_paused: false, last_inbound_at: at, last_inbound_id: sid,
      consent_source: 'web form', consent_date: '2026-10-01', consent_wording: 'I agree to receive texts', consent_seller_named: true, dnc_checked: true });
    const log = await E.MessageLog.create({ agent_email: AGENT, location_id: LOCATION, lead_id: lead.id, campaign_id: campaign.id, ghl_message_id: sid, event_type: 'inbound_sms', direction: 'inbound', source: 'webhook', status: 'received', occurred_at: at, body: 'Yes I would like to talk about this, I have been thinking about coverage for my family for a while now and would love to understand what the options are and how much it would cost each month for someone my age with no major health problems.' });
    const realRandom = Math.random; Math.random = () => 0.999; // slowest human: read + think + type well over 45 s
    let out: any; const started = Date.now();
    try { out = await replyToInbound(base44, log.id); } finally { Math.random = realRandom; }
    ok(Date.now() - started < 10000, 'returned without sleeping through the delay');
    deepStrictEqual([out.drafted, out.deferred_to_engine], [true, true], JSON.stringify(out));
    const draft = (await E.AIDraft.filter({ lead_id: lead.id, status: 'pending' }, { limit: 1 })).items[0];
    ok(draft && draft.send_after === out.send_after, 'send_after written for the full human-like wait');
    ok(Date.parse(draft.send_after) - Date.now() > MAX_INLINE_WAIT_S * 1000, draft.send_after);
    deepStrictEqual(await E.MessageLog.count({ lead_id: lead.id, event_type: 'sms_sent' }), 0, 'nothing sent yet');
    // The engine sees the pending draft but respects send_after.
    await json(await sequenceSender(asCron({ agent_email: AGENT })));
    deepStrictEqual((await E.AIDraft.get(draft.id)).status, 'pending');
    await E.AgentSettings.update(s.id, { mode: 'review', status: 'onboarding', a2p_status: 'not_started', phone_number: '' });
    await E.Campaign.update(campaign.id, { mode: 'review', status: 'draft' });
  });

  await t.step('duplicate inbound sid: a concurrent second insert hits the unique index and answers {duplicate:true}', async () => {
    const lead = leads[1];
    const sid = 'SMdup000000000000000000000000000001';
    // Pretend the pre-insert lookup saw nothing (two deliveries racing): only the unique index can stop the second row.
    const noPrior = new Proxy(E, { get(t, p) { if (p !== 'MessageLog') return Reflect.get(t, p); return new Proxy(t.MessageLog, { get(ml, m) { if (m !== 'filter') return Reflect.get(ml, m); return (q: any, o: any) => (q?.event_type === 'inbound_sms' && q?.ghl_message_id ? Promise.resolve({ items: [], has_more: false, next_cursor: null }) : ml.filter(q, o)); } }); } });
    const racing = { ...base44, asServiceRole: { ...base44.asServiceRole, entities: noPrior } };
    const deferred: Promise<any>[] = [];
    const first = await recordInbound(racing, s, { from: lead.phone, to: '', body: 'hello again', messageSid: sid, at: new Date().toISOString() }, { defer: (p: Promise<any>) => deferred.push(p) });
    deepStrictEqual(first.accepted, true);
    const second = await recordInbound(racing, s, { from: lead.phone, to: '', body: 'hello again', messageSid: sid, at: new Date().toISOString() }, { defer: (p: Promise<any>) => deferred.push(p) });
    deepStrictEqual(second.duplicate, true, JSON.stringify(second));
    deepStrictEqual(await E.MessageLog.count({ agent_email: AGENT, ghl_message_id: sid, event_type: 'inbound_sms' }), 1);
    await Promise.allSettled(deferred);
    // The ordinary path (lookup first) still answers duplicate too.
    const third = await recordInbound(base44, s, { from: lead.phone, to: '', body: 'hello again', messageSid: sid, at: new Date().toISOString() }, { defer: (p: Promise<any>) => deferred.push(p) });
    deepStrictEqual(third, { duplicate: true, logged: first.logged });
  });

  await t.step('a2pAdvance pages in-flight and approved registrations separately; skipped approved rows still rotate', async () => {
    const old = '2026-01-01T00:00:00.000Z';
    for (const [i, status] of [['1', 'approved'], ['2', 'approved']] as const) {
      await E.AgentSettings.create({ agent_email: `a2p${i}@example.com`, location_id: `loc_a2p_${i}`, connected: true, status: 'live', a2p_status: 'approved', phone_number: `+1512555020${i}` });
      await E.A2PRegistration.create({ agent_email: `a2p${i}@example.com`, status, brand_sid: `BN${i}`, number_attached: `+1512555020${i}`, last_checked_at: old });
    }
    // In flight but no brand yet (nothing to poll): skipped and not touched.
    await E.AgentSettings.create({ agent_email: 'a2p3@example.com', location_id: 'loc_a2p_3', connected: true, status: 'onboarding' });
    await E.A2PRegistration.create({ agent_email: 'a2p3@example.com', status: 'brand_submitted', last_checked_at: old });
    const out = await json(await a2pAdvance(asCron({})));
    deepStrictEqual([out.checked, out.approved, out.errors, out.resubmitted], [0, 0, 0, 0], JSON.stringify(out));
    for (const i of ['1', '2']) {
      const reg = (await E.A2PRegistration.filter({ agent_email: `a2p${i}@example.com` }, { limit: 1 })).items[0];
      notDeepStrictEqual(reg.last_checked_at, old, 'approved and attached: bumped so the approved page rotates');
      deepStrictEqual(reg.status, 'approved');
    }
    deepStrictEqual((await E.A2PRegistration.filter({ agent_email: 'a2p3@example.com' }, { limit: 1 })).items[0].last_checked_at, old);
    ok(!calls.some((c) => c.url.includes('twilio.com') && c.url.includes('BrandRegistrations')), 'no carrier poll for rows with nothing to check');
  });

  await t.step('unique per-agent rows: a second agent_settings row for the same email (any case) is refused', async () => {
    let err: any = null;
    try { await E.AgentSettings.create({ agent_email: AGENT.toUpperCase(), location_id: 'loc_dup', connected: false }); } catch (e) { err = e; }
    deepStrictEqual(err?.code, '23505', String(err?.message));
  });

  await t.step('no outside call went anywhere unexpected', async () => {
    await sleep(300);
    deepStrictEqual(unexpected, []);
  });

  globalThis.fetch = realFetch;
  await closeSql();
});
