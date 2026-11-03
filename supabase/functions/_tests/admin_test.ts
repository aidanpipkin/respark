// Admin group + legacy Respark fold-in, on the throwaway Postgres from scripts/test.sh.
//   adminAgents approve → beta_access on agent_settings, signup signal resolved, approval email
//   health (service key, as pg_cron) → runs every check and writes heartbeat:health
//   commandCenter → funnel/activity counts from the seeded rows
//   leadWebhook ?vendor=closr / ?vendor=goat → Closr and GOAT payloads mapped onto the standard intake
//   trucker_aidan playbook → verbatim steps skip the AI writer; fresh burst only for webhook leads; Sunday rules
//   scripts/import-legacy-respark.ts → legacy ResparkLead rows become lead + message_log rows (idempotent)
import { deepStrictEqual, ok, match } from 'node:assert/strict';

const SERVICE_KEY = 'service-role-test-key';
const OWNER = 'owner@example.com';
const AGENT = 'aidan@example.com';
const OWNER_UID = '55555555-5555-5555-5555-555555555555';
const AGENT_UID = '66666666-6666-6666-6666-666666666666';
const LOCATION = 'loc_admin_1';
const KEY = 'a'.repeat(32);
Deno.env.set('SUPABASE_URL', 'https://proj.supabase.co');
Deno.env.set('SUPABASE_ANON_KEY', 'anon-test-key');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', SERVICE_KEY);
Deno.env.set('PLATFORM_OWNER_EMAIL', OWNER);
Deno.env.set('ANTHROPIC_API_KEY', 'sk-ant-test');
Deno.env.set('RESEND_API_KEY', 're_test');
Deno.env.set('FROM_EMAIL', 'hello@leadrespark.test');
Deno.env.set('APP_URL', 'https://app.example.com');
Deno.env.set('ENTITIES_STRICT', '1');
const dbUrl = Deno.env.get('TEST_DATABASE_URL');
if (!dbUrl) throw new Error('TEST_DATABASE_URL is not set; run scripts/test.sh');
Deno.env.set('DATABASE_URL', dbUrl);

import { getSql, serviceEntities } from '../_shared/entities.ts';
import { ENTITIES } from '../_shared/schema.ts';
import { installPlaybook, PLAYBOOKS } from '../_shared/playbooks.ts';
import { composeStep, freshSeries } from '../_shared/messageSequence.ts';
import { cadenceOpen, stepTime } from '../_shared/cadenceClock.ts';
import { SEND_RULES } from '../_shared/truckerAidanSeed.ts';
import { adaptClosr, adaptGoat } from '../_shared/vendorLeads.ts';
import { TRACK_STEPS, verbatimTrackText } from '../_shared/tracks.ts';
import adminAgents from '../adminAgents/handler.ts';
import health from '../health/handler.ts';
import commandCenter from '../commandCenter/handler.ts';
import leadWebhook, { normalize } from '../leadWebhook/handler.ts';
import leadWebhookSettings from '../leadWebhookSettings/handler.ts';

// ---------------------------------------------------------------------------
// Mocked outside world
// ---------------------------------------------------------------------------
type Call = { url: string; method: string; body: any };
const calls: Call[] = [];
const unexpected: string[] = [];
let jwtEmail = OWNER, jwtUid = OWNER_UID;
globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  let body: any = init.body;
  try { body = JSON.parse(String(init.body)); } catch { /* raw */ }
  calls.push({ url, method, body });
  if (url.endsWith('/auth/v1/user')) return Response.json({ id: jwtUid, email: jwtEmail, user_metadata: {}, aud: 'authenticated', role: 'authenticated', app_metadata: {}, created_at: '2026-01-01T00:00:00Z' });
  if (url.startsWith('https://api.anthropic.com/')) {
    unexpected.push(`AI call: ${JSON.stringify(body?.messages?.[0]?.content || '').slice(0, 80)}`);
    return Response.json({ id: 'msg_test', type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'respond', input: { text: 'REWRITTEN BY AI', angle: 'x', facts_used: [] } }], stop_reason: 'tool_use' });
  }
  if (url.startsWith('https://services.leadconnectorhq.com/')) {
    if (url.includes('/contacts/upsert')) return Response.json({ contact: { id: `c_${String(body?.phone || '').slice(-4)}`, locationId: LOCATION, firstName: body?.firstName, lastName: body?.lastName, phone: body?.phone, email: body?.email, state: body?.state, tags: body?.tags || [] }, new: true });
    return Response.json({});
  }
  if (url.startsWith('https://api.resend.com/')) return Response.json({ id: 'em_test' });
  unexpected.push(`${method} ${url}`);
  return new Response('unexpected call in test', { status: 500 });
}) as typeof fetch;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const sql = getSql();
const E: any = serviceEntities(sql);

async function reset() {
  const tables = Object.values(ENTITIES).map((m) => m.table).filter((t) => t !== 'profiles');
  await sql.unsafe(`TRUNCATE ${tables.map((t) => `public."${t}"`).join(', ')}`);
  await sql.unsafe(`DELETE FROM public.profiles`);
  await sql.unsafe(`DELETE FROM auth.users`);
}
const asUser = (body: unknown, token = 'user-jwt') => new Request('http://local/fn', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const asCron = (body: unknown) => new Request('http://local/fn', { method: 'POST', headers: { Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const post = (url: string, body: unknown) => new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function json(res: Response) {
  const text = await res.text();
  let data: any; try { data = JSON.parse(text); } catch { data = text; }
  if (res.status >= 400) throw new Error(`${res.status}: ${typeof data === 'object' ? data?.error : text}`);
  return data;
}

// Real deliveries (shapes from legacy_respark/data/GoatLead.jsonl), with fictional people.
const CLOSR_PAYLOAD = {
  order: { id: null, number: 'Closrleads - 27085 (28-10-2026)', campaign: 'VND_TRUCKER_LEADS', spreadsheet_url: '' },
  lead: { id: 17645, phone: '+16605552123', state: 'TX', first_name: 'Tammy', last_name: 'Beth', full_name: 'Tammy Beth', dob: '1978-04-05', email: 'tammy@example.com', timezone: 'America/Chicago', address: '', city: '', zip: '', timestamp: '11/03/2026 5:48 AM EST', delivered_at: '2026-11-03T05:48:40-05:00',
    custom_data: { 'Who Would You Most Likely Want These Funds to Go to': 'Child / Children', 'Company Name': 'Durham School Services', 'How Many Years of Cdl Experience': 'under 2 years', 'What Kind of Cdl Driver Are You': 'Local or Regional', 'History of cancer, heart attack, diabetes or stroke': 'No', source: 'Meta Lead Form' } },
  buyer: { email: AGENT, name: 'Aidan', phone: '+19405550100' }, charge: [], vendor: [], items: [], merged_meta: { ghl_enabled: '1' }, meta_sources: 'manual', tenant: { name: '', site_title: 'Closrleads', stripe_mode: 'LIVE' },
};
const GOAT_PAYLOAD = { ID: 99999002, 'Lead Type': 'Index Universal Life Lead', 'Lead Quality': 'Premium', 'First Name': 'Dale', 'Last Name': 'Driver', Phone: '(501) 555-2177', Email: 'dale@example.com', State: 'Arkansas', 'RR State': 'AR', DOB: '01/01/1980', 'Driver Type': 'Owner Operator', 'IUL Goal': 'Retirement', 'Trusted Form URL': 'https://cert.trustedform.com/TEST2', 'Aged Bucket': 'FRESH', Vendor: 'goatleads' };

Deno.test({ name: 'admin group and legacy Respark fold-in', sanitizeOps: false, sanitizeResources: false }, async (t) => {
  await reset();
  let s: any, campaign: any;

  await t.step('seed: platform (approval required), owner admin, self-serve agent awaiting approval', async () => {
    await E.PlatformSettings.create({ singleton_key: 'platform', owner_email: OWNER, self_serve_enabled: true, self_serve_requires_approval: true, default_timezone: 'America/Chicago', subscription_price_cents: 10000 });
    await sql`insert into auth.users (id, email, raw_user_meta_data) values (${OWNER_UID}::uuid, ${OWNER}, ${sql.json({ full_name: 'Platform Owner' })})`;
    await sql`insert into auth.users (id, email, raw_user_meta_data) values (${AGENT_UID}::uuid, ${AGENT}, ${sql.json({ full_name: 'Aidan Agent' })})`;
    deepStrictEqual((await sql`select role from public.profiles where id = ${OWNER_UID}::uuid`)[0]?.role, 'admin');
    s = await E.AgentSettings.create({ agent_email: AGENT, self_serve: true, status: 'onboarding', mode: 'review', first_name: 'Aidan', last_name: 'Pipkin', display_name: 'Aidan', brand_name: 'My Trucker Wealth', legal_business_name: 'My Trucker Wealth LLC', licensed_states: ['TX', 'AR', 'MO', 'IL'], home_timezone: 'America/Chicago', lead_webhook_key: KEY });
    await E.SystemEvent.create({ key: `signup_approval:${AGENT}`, agent_email: AGENT, severity: 'info', status: 'open', title: 'Signup waiting for approval', first_seen_at: new Date().toISOString(), last_seen_at: new Date().toISOString() });
    deepStrictEqual(await json(await adminAgents(asUser({ action: 'pending_count' }))), { pending: 1 });
  });

  await t.step('adminAgents save + approve: agent_settings updated, beta_access granted, signal resolved, agent emailed', async () => {
    const out = await json(await adminAgents(asUser({ action: 'save', agent_email: AGENT, npn: '1234567', business_phone: '+19405550100', beta_access: true, licensed_states: ['TX', 'AR', 'MO', 'IL', 'OK'] })));
    deepStrictEqual(out.settings.beta_access, true);
    deepStrictEqual(out.settings.npn, '1234567');
    deepStrictEqual(out.settings.licensed_states, ['TX', 'AR', 'MO', 'IL', 'OK']);
    ok(!('ghl_token' in out.settings), 'adminSettings never returns the token');
    s = (await E.AgentSettings.filter({ agent_email: AGENT }, { limit: 1 })).items[0];
    deepStrictEqual(s.beta_access, true);
    deepStrictEqual(s.business_phone, '+19405550100');
    deepStrictEqual((await E.SystemEvent.filter({ key: `signup_approval:${AGENT}` }, { limit: 1 })).items[0]?.status, 'resolved');
    deepStrictEqual(await json(await adminAgents(asUser({ action: 'pending_count' }))), { pending: 0 });
    const mail = calls.find((c) => c.url.startsWith('https://api.resend.com/') && /approved/i.test(String(c.body?.subject)));
    ok(mail, 'approval email sent through Resend');
    deepStrictEqual(mail!.body.to, [AGENT]);
    // Validation still bites.
    deepStrictEqual((await adminAgents(asUser({ action: 'save', agent_email: AGENT, business_phone: '940-555' }))).status, 400);
    // Non-admin callers are refused.
    jwtEmail = AGENT; jwtUid = AGENT_UID;
    deepStrictEqual((await adminAgents(asUser({ action: 'list' }, 'agent-jwt'))).status, 403);
    jwtEmail = OWNER; jwtUid = OWNER_UID;
  });

  await t.step('health run (service key, as pg_cron) writes heartbeat:health', async () => {
    const out = await json(await health(asCron({})));
    ok(Object.keys(out).length >= 5, JSON.stringify(out));
    for (const [k, v] of Object.entries(out)) deepStrictEqual(v, 'ok', `${k}: ${v}`);
    const beat = (await E.EngineCursor.filter({ key: 'heartbeat:health' }, { limit: 1 })).items[0];
    ok(beat, 'heartbeat row');
    const info = JSON.parse(beat.cursor);
    ok(Date.now() - Date.parse(info.at) < 60000);
    deepStrictEqual((await health(post('http://local/fn', {}))).status, 400, 'no token → refused');
  });

  await t.step('commandCenter returns counts', async () => {
    const now = new Date().toISOString();
    await E.MessageLog.create({ agent_email: AGENT, location_id: LOCATION, lead_id: 'x', event_type: 'sms_sent', direction: 'outbound', source: 'sequence', body: 'hi', occurred_at: now });
    await E.MessageLog.create({ agent_email: AGENT, location_id: LOCATION, lead_id: 'x', event_type: 'inbound_sms', direction: 'inbound', source: 'lead', body: 'yes', occurred_at: now });
    const out = await json(await commandCenter(asUser({})));
    deepStrictEqual(Object.fromEntries(out.funnel), { 'Signed up': 1, Subscribed: 0, 'Got a number': 0, 'Submitted registration': 0, 'Registration approved': 0, 'Calendar set': 0, Live: 0 });
    deepStrictEqual(out.growth.signups_7d, 1);
    deepStrictEqual(out.activity.texts_7d, 1);
    deepStrictEqual(out.activity.replies_7d, 1);
    deepStrictEqual(out.activity.reply_rate_7d, 100);
    ok(out.health.jobs.find((j: any) => j.key === 'health')?.ok, 'health heartbeat is fresh');
    deepStrictEqual(out.health.jobs.find((j: any) => j.key === 'sequence_sender')?.ok, false);
    deepStrictEqual(out.signals.length, 0);
    const health2 = await json(await commandCenter(asUser({ action: 'run_health' })));
    ok(health2.results);
  });

  await t.step("trucker_aidan playbook installs Aidan's copy verbatim with the fresh burst and Sunday rules", async () => {
    s = await E.AgentSettings.update(s.id, { location_id: LOCATION, connected: true, ghl_token: 'ghl-test-token', status: 'live', a2p_status: 'approved', phone_number: '+19405550199' });
    const pb = PLAYBOOKS.find((p) => p.key === 'trucker_aidan')!;
    ok(pb && pb.persona === 'agent_first_person');
    campaign = await installPlaybook(E, s, 'trucker_aidan');
    campaign = await E.Campaign.update(campaign.id, { status: 'active' });
    deepStrictEqual(campaign.cadence, 'standard');
    deepStrictEqual(campaign.persona, 'agent_first_person');
    deepStrictEqual(campaign.send_rules, SEND_RULES);
    const steps = (await E.SequenceStep.filter({ campaign_id: campaign.id }, { sort: 'step_number', limit: 100 })).items;
    deepStrictEqual(steps.length, 4 + 2 + 13);
    ok(steps.every((st: any) => st.verbatim === true && st.cadence === 'standard'));
    const openers = steps.filter((st: any) => st.step_number === 1);
    deepStrictEqual(openers.length, 4);
    deepStrictEqual(openers.filter((st: any) => st.fresh_only).length, 2);
    const burst = steps.filter((st: any) => st.offset_minutes);
    deepStrictEqual(burst.map((b: any) => [b.step_number, b.offset_minutes, b.fresh_only]), [[2, 20, true], [3, 240, true]]);
    const d30 = steps.find((st: any) => st.kind === 'close');
    deepStrictEqual(d30.day_offset, 29);
    match(d30.body, /^\{first\}, I'm about to close your file so I quit bugging you\./);
    // Installing again adds nothing (fresh_only rows are recognised).
    await installPlaybook(E, s, 'trucker_aidan');
    deepStrictEqual((await E.SequenceStep.count({ campaign_id: campaign.id })), 19);
    // Sunday rule: allowed at 1pm in TX, never in AL; Saturday 7pm is inside Aidan's hours (product default would be closed).
    const sunday1pm = Date.parse('2026-11-08T19:00:00Z'); // Sunday 13:00 Chicago
    deepStrictEqual(cadenceOpen(s, 'America/Chicago', sunday1pm, SEND_RULES, 'TX'), true);
    deepStrictEqual(cadenceOpen(s, 'America/Chicago', sunday1pm, SEND_RULES, 'AL'), false);
    deepStrictEqual(cadenceOpen(s, 'America/Chicago', sunday1pm), false);
    const sat7pm = Date.parse('2026-11-08T01:00:00Z'); // Saturday 19:00 Chicago
    deepStrictEqual(cadenceOpen(s, 'America/Chicago', sat7pm, SEND_RULES, 'TX'), true);
    deepStrictEqual(cadenceOpen(s, 'America/Chicago', sat7pm), false);
    // A step landing on a Sunday is kept for TX (moved to the noon opening) and skipped for AL.
    const lead = { id: 'lead1', timezone: 'America/Chicago', state: 'TX' };
    const at = stepTime(s, lead, '2026-11-07T15:00:00Z', 1, 'am', false, SEND_RULES)!;
    ok(at && at >= '2026-11-08T18:00:00.000Z' && at < '2026-11-08T18:31:00.000Z', at);
    deepStrictEqual(stepTime(s, { ...lead, state: 'AL' }, '2026-11-07T15:00:00Z', 1, 'am', false, SEND_RULES), null);
  });

  await t.step('verbatim step path: composeStep fills name/state only and never calls the AI writer', async () => {
    const before = calls.length;
    const lead = await E.Lead.create({ agent_email: AGENT, location_id: LOCATION, ghl_contact_id: 'c_v1', campaign_id: campaign.id, first_name: 'Shawn', state: 'TX', phone: '+12145552101', timezone: 'America/Chicago', status: 'queued', import_batch: 'webhook:closr:2026-11-03' });
    const steps = (await E.SequenceStep.filter({ campaign_id: campaign.id }, { limit: 100 })).items;
    const freshOpener = steps.find((st: any) => st.step_number === 1 && st.variant === 'A' && st.fresh_only);
    const base44 = { asServiceRole: { entities: E } };
    const out = await composeStep(base44, s, lead, campaign, freshOpener);
    deepStrictEqual(out.text, "Hey Shawn, this is Aidan, the CDL financial advisor assigned to the Trucker IUL request you just put in. Got it on my end. Quick one so I don't call you mid shift: you're in TX, right?");
    deepStrictEqual(out.personalization.personalized, false);
    deepStrictEqual(out.personalization.model, 'verbatim');
    const d7 = steps.find((st: any) => st.lever?.startsWith('D7'));
    const out2 = await composeStep(base44, s, lead, campaign, d7); // mentions "sleep apnea": a verbatim step is still sent as written
    match(out2.text, /^Shawn, one thing that holds a lot of drivers back: blood pressure meds, sleep apnea/);
    ok(!calls.slice(before).some((c) => c.url.startsWith('https://api.anthropic.com/')), 'no AI call for verbatim steps');
    deepStrictEqual(freshSeries(lead), true);
    deepStrictEqual(freshSeries({ ...lead, import_batch: 'legacy-respark:x' }), false);
    deepStrictEqual(freshSeries({ ...lead, sequence_started_at: new Date(Date.now() - 2 * 86400000).toISOString() }), false);
  });

  await t.step('Closr and GOAT payload mappings', async () => {
    const closr = adaptClosr(CLOSR_PAYLOAD);
    deepStrictEqual(closr.test, false);
    deepStrictEqual(closr.fresh, true);
    const c = normalize(closr.generic);
    deepStrictEqual([c.first_name, c.last_name, c.phone, c.email, c.state], ['Tammy', 'Beth', '+16605552123', 'tammy@example.com', 'TX']);
    deepStrictEqual(c.lead_source, 'Closrleads');
    deepStrictEqual(c.consent_flag, true);
    deepStrictEqual(c.consented, true);
    match(c.consent_wording, /Closrleads lead form \(VND_TRUCKER_LEADS, Meta Lead Form\)/);
    deepStrictEqual(c.facts.product_interest, 'IUL');
    deepStrictEqual(c.facts.date_of_birth, '1978-04-05');
    deepStrictEqual(c.facts.who_to_protect, 'Child / Children');
    deepStrictEqual(c.facts.occupation, 'CDL driver (Local or Regional)');
    deepStrictEqual((c as any).extra['Company Name'], 'Durham School Services');
    ok(!Object.keys((c as any).extra).some((k) => /cancer/i.test(k)), 'health answers never reach the lead');
    deepStrictEqual(adaptClosr({ ...CLOSR_PAYLOAD, is_test: true }).test, true);
    deepStrictEqual(adaptClosr({ ...CLOSR_PAYLOAD, order: { number: 'TEST-1', campaign: 'TEST' } }).test, true);

    const goat = adaptGoat(GOAT_PAYLOAD);
    deepStrictEqual(goat.fresh, true);
    const g = normalize(goat.generic);
    deepStrictEqual([g.first_name, g.last_name, g.phone, g.email, g.state], ['Dale', 'Driver', '(501) 555-2177', 'dale@example.com', 'AR']);
    deepStrictEqual(g.lead_source, 'goatleads');
    deepStrictEqual(g.consent_url, 'https://cert.trustedform.com/TEST2');
    match(g.consent_wording, /GOAT Leads lead form \(Index Universal Life Lead\).*TrustedForm certificate: https:\/\/cert\.trustedform\.com\/TEST2/);
    deepStrictEqual(g.facts.product_interest, 'Index Universal Life');
    deepStrictEqual(g.facts.reason_in_their_words, 'Retirement');
    deepStrictEqual(g.facts.occupation, 'CDL driver (Owner Operator)');
    deepStrictEqual(adaptGoat({ ...GOAT_PAYLOAD, 'Aged Bucket': 'AGED_30' }).fresh, false);
  });

  await t.step('leadWebhook ?vendor=closr creates a consented, fresh, queued lead; ?vendor=goat too; test deliveries are dropped', async () => {
    const base = `http://local/leadWebhook?key=${KEY}`;
    const r1 = await json(await leadWebhook(post(`${base}&vendor=closr`, CLOSR_PAYLOAD)));
    deepStrictEqual([r1.ok, r1.status, r1.vendor], [true, 'imported', 'closr']);
    const lead = await E.Lead.get(r1.lead_id);
    deepStrictEqual(lead.status, 'queued');
    deepStrictEqual(lead.phone, '+16605552123');
    deepStrictEqual(lead.state, 'TX');
    deepStrictEqual(lead.timezone, 'America/Chicago');
    deepStrictEqual(lead.import_batch, `webhook:closr:${new Date().toISOString().slice(0, 10)}`);
    deepStrictEqual(lead.consent_source, 'Closr Tech (Closrleads) webhook (vendor consent)');
    deepStrictEqual(lead.consent_date, '2026-11-03');
    deepStrictEqual(lead.dnc_basis, 'written_consent');
    deepStrictEqual(lead.lead_facts.occupation, 'CDL driver (Local or Regional)');
    deepStrictEqual(lead.lead_facts.extra['Company Name'], 'Durham School Services');
    deepStrictEqual(freshSeries(lead), true);
    const consent = (await E.ConsentRecord.filter({ lead_id: lead.id }, { limit: 1 })).items[0];
    deepStrictEqual(consent.basis, 'webhook');
    deepStrictEqual(consent.attested_by, `vendor:closr:${KEY.slice(0, 8)}`);
    match(consent.wording, /Closrleads lead form/);
    const upsert = calls.find((c) => c.url.includes('/contacts/upsert') && c.body?.phone === '+16605552123');
    ok(upsert?.body.tags.includes('vendor-closr'));

    deepStrictEqual(await json(await leadWebhook(post(`${base}&vendor=closr`, { ...CLOSR_PAYLOAD, is_test: true }))), { ok: true, test: true, vendor: 'closr', note: 'Test delivery parsed; nothing was created.' });
    deepStrictEqual((await json(await leadWebhook(post(`${base}&vendor=closr`, {})))).note, 'Empty or connectivity-check payload, nothing to process.');
    deepStrictEqual((await leadWebhook(post(`${base}&vendor=nope`, GOAT_PAYLOAD))).status, 400);
    deepStrictEqual((await json(await leadWebhook(post(`${base}&vendor=closr`, CLOSR_PAYLOAD)))).status, 'duplicate');

    const r2 = await json(await leadWebhook(post(`${base}&vendor=goat`, GOAT_PAYLOAD)));
    deepStrictEqual([r2.status, r2.vendor], ['imported', 'goat']);
    const goat = await E.Lead.get(r2.lead_id);
    deepStrictEqual([goat.first_name, goat.phone, goat.state, goat.status], ['Dale', '+15015552177', 'AR', 'queued']);
    match(goat.consent_wording, /TrustedForm certificate/);
    // An aged GOAT lead is kept out of the fresh track.
    const r3 = await json(await leadWebhook(post(`${base}&vendor=goat`, { ...GOAT_PAYLOAD, Phone: '(501) 555-2178', 'Aged Bucket': 'AGED_90' })));
    const aged = await E.Lead.get(r3.lead_id);
    match(aged.import_batch, /^vendor-aged:goat:/);
    deepStrictEqual(freshSeries(aged), false);

    jwtEmail = AGENT; jwtUid = AGENT_UID;
    const settings = await json(await leadWebhookSettings(asUser({}, 'agent-jwt')));
    jwtEmail = OWNER; jwtUid = OWNER_UID;
    deepStrictEqual(settings.vendor_urls.map((v: any) => v.url), [`https://proj.supabase.co/functions/v1/leadWebhook?key=${KEY}&vendor=closr`, `https://proj.supabase.co/functions/v1/leadWebhook?key=${KEY}&vendor=goat`]);
    deepStrictEqual(settings.recent.length, 4); // 3 vendor arrivals + the webhook lead from the verbatim step
  });

  await t.step('lost_banking track carries the Approval Recovery drip word for word', async () => {
    const steps = TRACK_STEPS.lost_banking;
    deepStrictEqual(steps.map((x) => x.after_hours), [0, 24, 72, 144, 216, 312]);
    ok(steps.every((x) => x.text));
    deepStrictEqual(verbatimTrackText(steps[0], { first_name: 'Shawn' }, null, s), "Shawn, Aidan here. Good news, the carrier came back and you're fully approved for the coverage we set up we talked about. Congrats, that's the hard part done. I tried you back a couple times and missed you. I just need 10 minutes to go over it with you and make sure it's still what you want to do. What time works today or tomorrow?");
    deepStrictEqual(verbatimTrackText(steps[5], { first_name: 'Shawn' }, { carrier: 'Mutual of Omaha', product: 'IUL' }, s), "Shawn, last one from me on this. I'm going to close out your Mutual of Omaha application at the end of the week so your info isn't sitting out there. If you want to keep the IUL in place, text me back before then and we'll finish it in one quick call. Either way, I appreciate you. Aidan");
  });

  await t.step('scripts/import-legacy-respark.ts maps ResparkLead rows to lead + message_log rows, idempotently', async () => {
    const dir = await Deno.makeTempDir();
    const rows = [
      { id: 'legacy000000000000000001', ghl_contact_id: 'QAsW3LHMn6PgGR1YKA5r', ghl_opportunity_id: 'opp1', first_name: 'Shawn', last_name: 'Legacy', phone: '+12145552155', email: 'shawn@example.com', state: 'Texas', timezone: 'America/Chicago', driver_type: 'Owner Operator', age: '48', iul_goal: 'Retirement', lead_status: 'Fresh Lead (vendor webhook)', requested_at: '2026-11-03T10:48:40.995Z', profile: { Age: '48' }, enrolled_at: '2026-11-03T10:48:40.995Z', status: 'active', step: 2, messages_sent: 2, next_send_at: '2026-11-04T15:30:00.000Z', last_inbound_at: null,
        conversation: [{ role: 'aidan_sequence', text: 'Hey Shawn, this is Aidan...', at: '2026-11-03T15:30:01.000Z', label: 'D1 intro + state check' }, { role: 'aidan_sequence', text: 'Shawn, one more since you just put the request in...', at: '2026-11-03T15:50:15.000Z', label: 'F2 fresh nudge (+20m)' }], seq_log: ['enrolled via premium trucker webhook (FRESH)'] },
      { id: 'legacy000000000000000002', ghl_contact_id: 'c2', first_name: 'Rick', last_name: 'Quit', phone: '+12145552156', state: 'Illinois', timezone: 'America/Chicago', status: 'stopped', stop_reason: 'lead replied STOP', step: 3, messages_sent: 3, conversation: [{ role: 'aidan_sequence', text: 'Hey Rick...', at: '2026-10-01T15:30:01.000Z' }, { role: 'lead', text: 'STOP', at: '2026-10-01T16:00:00.000Z' }] },
      { id: 'legacy000000000000000003', ghl_contact_id: 'c3', first_name: 'Tom', phone: '+12145552157', state: 'Missouri', status: 'conversing', step: 4, messages_sent: 4, conversation: [{ role: 'aidan_sequence', text: 'Hey Tom...', at: '2026-10-20T15:30:01.000Z' }, { role: 'lead', text: 'who is this', at: '2026-10-20T16:00:00.000Z' }, { role: 'aidan_bot', text: 'Aidan here...', at: '2026-10-20T16:01:00.000Z' }] },
      { id: 'legacy000000000000000004', ghl_contact_id: 'c4', first_name: 'Nophone', phone: '', status: 'active' },
    ];
    await Deno.writeTextFile(`${dir}/ResparkLead.jsonl`, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    await Deno.writeTextFile(`${dir}/SMSConsent.jsonl`, JSON.stringify({ phone: '+12145552157', consent_text: 'I consent to receive texts from My Trucker Wealth.', consent_timestamp: '2026-10-19T12:00:00Z', prospect_source: 'website_form', revoked: false }) + '\n');
    const run = async (extra: string[]) => {
      const cmd = new Deno.Command(Deno.execPath(), { args: ['run', '-A', 'scripts/import-legacy-respark.ts', '--agent', AGENT, '--file', `${dir}/ResparkLead.jsonl`, '--consent', `${dir}/SMSConsent.jsonl`, ...extra], cwd: new URL('../../..', import.meta.url).pathname, env: { DATABASE_URL: dbUrl }, stdout: 'piped', stderr: 'piped' });
      const out = await cmd.output();
      const text = new TextDecoder().decode(out.stdout), err = new TextDecoder().decode(out.stderr);
      ok(out.success, `import failed: ${err}\n${text}`);
      return JSON.parse(text.split('\n').find((l) => l.startsWith('SUMMARY '))!.slice(8));
    };
    const dry = await run(['--dry-run']);
    deepStrictEqual([dry.dry_run, dry.leads, dry.skipped, dry.messages], [true, 3, 1, 7]);
    deepStrictEqual(await E.Lead.count({ import_batch: { $regex: '^legacy-respark' } }), 0);
    const real = await run(['--assume-vendor-consent']);
    deepStrictEqual([real.leads, real.skipped, real.messages, real.with_consent], [3, 1, 7, 3]);
    deepStrictEqual(real.statuses, { in_sequence: 1, opted_out: 1, replied: 1 });
    const shawn = (await E.Lead.filter({ agent_email: AGENT, phone: '+12145552155' }, { limit: 1 })).items[0];
    deepStrictEqual([shawn.id, shawn.status, shawn.state, shawn.current_step, shawn.step1_delivered, shawn.cadence, shawn.campaign_id], ['legacy000000000000000001', 'in_sequence', 'TX', 2, true, 'standard', campaign.id]);
    deepStrictEqual(shawn.lead_facts.occupation, 'CDL driver (Owner Operator)');
    deepStrictEqual(shawn.consent_source, 'Vendor lead form (legacy Respark import)');
    deepStrictEqual(shawn.next_send_at, '2026-11-04T15:30:00.000Z');
    const tom = (await E.Lead.filter({ agent_email: AGENT, phone: '+12145552157' }, { limit: 1 })).items[0];
    deepStrictEqual([tom.status, tom.current_step, tom.consent_date, tom.sequence_paused], ['replied', 3, '2026-10-19', true]);
    match(tom.consent_source, /^Website form/);
    deepStrictEqual(tom.last_inbound_at, '2026-10-20T16:00:00.000Z');
    const rick = (await E.Lead.filter({ agent_email: AGENT, phone: '+12145552156' }, { limit: 1 })).items[0];
    deepStrictEqual(rick.status, 'opted_out');
    const logs = (await E.MessageLog.filter({ lead_id: tom.id }, { sort: 'occurred_at', limit: 10 })).items;
    deepStrictEqual(logs.map((l: any) => [l.event_type, l.direction, l.source]), [['sms_sent', 'outbound', 'sequence'], ['inbound_sms', 'inbound', 'lead'], ['sms_sent', 'outbound', 'ai']]);
    // Second run: same rows, nothing duplicated.
    await run(['--assume-vendor-consent']);
    deepStrictEqual(await E.Lead.count({ import_batch: { $regex: '^legacy-respark' } }), 3);
    deepStrictEqual(await E.MessageLog.count({ lead_id: tom.id }), 3);
  });

  await t.step('no outside call went anywhere unexpected', () => {
    deepStrictEqual(unexpected, []);
  });
});
