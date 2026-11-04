// End-to-end test of the self-serve onboarding path on a throwaway Postgres (scripts/test.sh).
//
// Drives the ported handlers as plain Requests, with every outside HTTP call answered by a mocked fetch
// (Supabase auth, GHL, Stripe, Twilio REST + Trust Hub + Messaging, Anthropic, Resend):
//   ghlOAuth callback connects the agency → a brand-new user opens `workspace` (agent_settings row,
//   needs_welcome) → selfSetup save_profile + build provisions the GHL workspace in the background →
//   createSetupIntent + saveBillingCard + subscription subscribe → searchNumbers + purchaseNumber →
//   a2pSubmit (brand_submitted) → a2pAdvance twice (campaign created, then approved) → launch send_test and
//   the agent's YES through twilioWebhook turns the agent live → availability book + appointmentJourney
//   emails → appointmentReminders sends the due reminders → stripeWebhook and inviteAgent.
import { deepStrictEqual, ok, match } from 'node:assert/strict';

const SERVICE_KEY = 'service-role-test-key';
const OWNER = 'owner@example.com';
const AGENT = 'agent@example.com';
const INVITEE = 'newagent@example.com';
const OWNER_UID = '44444444-4444-4444-4444-444444444444';
const AGENT_UID = '55555555-5555-5555-5555-555555555555';
const LOCATION = 'loc_self_1';
const CALENDAR = 'cal_self_1';
const SUB_SID = 'AC' + 'a1b2c3d4'.repeat(4);
const SUB_TOKEN = 'subaccount-auth-token';
const NUMBER = '+19185552000';
const AGENT_CELL = '+19185550199';
const APP_URL = 'https://app.example.com';
const SUPABASE_URL = 'https://proj.supabase.co';
Deno.env.set('SUPABASE_URL', SUPABASE_URL);
Deno.env.set('SUPABASE_ANON_KEY', 'anon-test-key');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', SERVICE_KEY);
Deno.env.set('PLATFORM_OWNER_EMAIL', OWNER);
Deno.env.set('ANTHROPIC_API_KEY', 'sk-ant-test');
Deno.env.set('RESEND_API_KEY', 're_test');
Deno.env.set('FROM_EMAIL', 'hello@leadrespark.test');
Deno.env.set('APP_URL', APP_URL);
Deno.env.set('STRIPE_SECRET_KEY', 'sk_test_123');
Deno.env.set('STRIPE_PUBLISHABLE_KEY', 'pk_test_123');
Deno.env.set('STRIPE_WEBHOOK_SECRET', 'whsec_test');
Deno.env.set('TWILIO_ACCOUNT_SID', 'AC' + '0'.repeat(32));
Deno.env.set('TWILIO_AUTH_TOKEN', 'master-token');
Deno.env.set('GHL_CLIENT_SECRET', 'ghl-secret');
// Base44 stored fields the jsonc schemas never declared; the adapter drops them with a warning. The test
// runs without ENTITIES_STRICT (other test files set it; env is process-wide) and lists the known drift below.
Deno.env.delete('ENTITIES_STRICT');
const KNOWN_DROPPED_FIELDS = new Set(['A2PRegistration.licensed_states']);
const dbUrl = Deno.env.get('TEST_DATABASE_URL');
if (!dbUrl) throw new Error('TEST_DATABASE_URL is not set; run scripts/test.sh');
Deno.env.set('DATABASE_URL', dbUrl);

import { closeSql, getSql, serviceEntities } from '../_shared/entities.ts';
import { ENTITIES } from '../_shared/schema.ts';
import { functionUrl } from '../_shared/runtime.ts';
import { stageNames } from '../_shared/dataModelSpec.ts';
import ghlOAuth from '../ghlOAuth/handler.ts';
import { signInstallState } from '../_shared/ghlAuth.ts';
import workspace from '../workspace/handler.ts';
import selfSetup from '../selfSetup/handler.ts';
import getSetupStatus from '../getSetupStatus/handler.ts';
import createSetupIntent from '../createSetupIntent/handler.ts';
import saveBillingCard from '../saveBillingCard/handler.ts';
import subscription from '../subscription/handler.ts';
import searchNumbers from '../searchNumbers/handler.ts';
import purchaseNumber from '../purchaseNumber/handler.ts';
import a2pSubmit from '../a2pSubmit/handler.ts';
import a2pStatus from '../a2pStatus/handler.ts';
import a2pAdvance from '../a2pAdvance/handler.ts';
import launch from '../launch/handler.ts';
import twilioWebhook from '../twilioWebhook/handler.ts';
import availability from '../availability/handler.ts';
import appointmentJourney from '../appointmentJourney/handler.ts';
import appointmentReminders from '../appointmentReminders/handler.ts';
import stripeWebhook from '../stripeWebhook/handler.ts';
import inviteAgent from '../inviteAgent/handler.ts';
import results from '../results/handler.ts';

// ---------------------------------------------------------------------------
// Background work: the runtime's waitUntil hands promises to EdgeRuntime when it exists.
// ---------------------------------------------------------------------------
const background: Promise<unknown>[] = [];
(globalThis as any).EdgeRuntime = { waitUntil: (p: Promise<unknown>) => { background.push(p); } };
async function settle() { while (background.length) { const batch = background.splice(0); await Promise.allSettled(batch); } }

// Dropped-field warnings from the entity adapter.
const dropped = new Set<string>();
const realWarn = console.warn;
console.warn = (...a: unknown[]) => {
  const m = /\[entities\] (\w+): dropping unknown field "([^"]+)"/.exec(String(a[0]));
  if (m) { dropped.add(`${m[1]}.${m[2]}`); return; }
  realWarn(...a);
};

// ---------------------------------------------------------------------------
// Mocked outside world
// ---------------------------------------------------------------------------
type Call = { url: string; method: string; body: any; form: URLSearchParams | null; headers: Record<string, string> };
const calls: Call[] = [];
const unexpected: string[] = [];
let n = 0;
const sid = (prefix: string) => `${prefix}${String(++n).padStart(32, '0').replace(/\d/g, (d) => 'abcdef0123'[Number(d)])}`;
const hex32 = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

// Mutable carrier state the A2P steps move through.
const carrier = { brand: 'PENDING', campaign: 'IN_PROGRESS' };
// Contacts the agent's GHL workspace knows (checkSafety re-reads them before every text).
const contacts: Record<string, { phone: string; state: string }> = {};
const stripeSubscription = () => ({
  id: 'sub_1', object: 'subscription', status: 'active', customer: 'cus_1', cancel_at_period_end: false,
  current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, items: { data: [{ price: { id: 'price_1', unit_amount: 10000, recurring: { interval: 'month' } } }] },
  latest_invoice: { payment_intent: { id: 'pi_1', status: 'succeeded' } },
});

function headerMap(init: RequestInit, input: RequestInfo | URL): Record<string, string> {
  const out: Record<string, string> = {};
  const h = init.headers || (input instanceof Request ? input.headers : undefined);
  if (!h) return out;
  if (h instanceof Headers) h.forEach((v, k) => { out[k.toLowerCase()] = v; });
  else if (Array.isArray(h)) for (const [k, v] of h) out[String(k).toLowerCase()] = String(v);
  else for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
  return out;
}

/** Anthropic: an answer shaped by whichever JSON schema was requested. */
function answerFor(schema: any): any {
  const out: any = {};
  for (const [k, def] of Object.entries<any>(schema?.properties || {})) {
    if (def.type === 'array') out[k] = def.items?.type === 'object' ? [answerFor(def.items)] : [`${k} one`, `${k} two`];
    else if (def.type === 'object') out[k] = answerFor(def);
    else if (def.type === 'number' || def.type === 'integer') out[k] = 1;
    else if (def.type === 'boolean') out[k] = false;
    else out[k] = def.enum ? def.enum[0] : `Test ${k.replace(/_/g, ' ')}.`;
  }
  return out;
}

function ghlMock(url: URL, method: string, body: any) {
  const p = url.pathname;
  if (p === '/oauth/token') return Response.json({ access_token: 'agency-access', refresh_token: 'agency-refresh', expires_in: 86000, userType: 'Company', companyId: 'comp_1', scope: 'locations.write', userId: 'u_owner' });
  if (p === '/oauth/locationToken') return Response.json({ access_token: 'loc-token', expires_in: 86400 });
  if (p === '/locations/' && method === 'POST') return Response.json({ location: { id: LOCATION, name: body?.name } });
  if (p === `/locations/${LOCATION}/customValues`) return method === 'POST' ? Response.json({ customValue: { id: `cv_${++n}`, name: body?.name } }) : Response.json({ customValues: [] });
  if (p.startsWith(`/locations/${LOCATION}/customValues/`)) return Response.json({ customValue: { id: p.split('/').pop() } });
  if (p === `/locations/${LOCATION}/customFields`) return method === 'POST' ? Response.json({ customField: { id: `cf_${++n}`, name: body?.name } }) : Response.json({ customFields: [] });
  if (p === `/locations/${LOCATION}/tags`) return method === 'POST' ? Response.json({ tag: { id: `tag_${++n}`, name: body?.name } }) : Response.json({ tags: [] });
  if (p === '/opportunities/pipelines') {
    if (method === 'POST') return Response.json({ pipeline: { id: 'pipe_1', name: 'Respark', stages: stageNames.map((name, i) => ({ id: `st_${i}`, name })) } });
    return Response.json({ pipelines: [] });
  }
  if (p === '/users/search') return Response.json({ users: [] });
  if (p === '/users/' && method === 'POST') return Response.json({ user: { id: 'u_agent', email: body?.email } });
  if (p === '/calendars/' && method === 'GET') return Response.json({ calendars: [] });
  if (p === '/calendars/' && method === 'POST') return Response.json({ calendar: { id: CALENDAR, name: body?.name } });
  if (p === `/calendars/${CALENDAR}/free-slots`) { const [a, b, c] = slotTriple(); return Response.json({ [a.slice(0, 10)]: { slots: [a, b] }, [c.slice(0, 10)]: { slots: [c] } }); }
  if (p === '/calendars/events/appointments' && method === 'POST') return Response.json({ appointment: { id: `apt_${++n}` } });
  if (p.startsWith('/calendars/events/appointments/')) return Response.json({});
  if (p.startsWith('/contacts/')) {
    const id = p.split('/')[2];
    const c = contacts[id];
    return Response.json({ contact: c ? { id, locationId: LOCATION, phone: c.phone, state: c.state, tags: [] } : { id, locationId: LOCATION } });
  }
  return Response.json({});
}

function stripeMock(url: URL, method: string, form: URLSearchParams | null) {
  const p = url.pathname.replace(/^\/v1\//, '');
  if (p === 'customers' && method === 'POST') return Response.json({ id: 'cus_1', email: form?.get('email') });
  if (p === 'customers/cus_1') return Response.json({ id: 'cus_1' });
  if (p === 'setup_intents' && method === 'POST') return Response.json({ id: 'seti_1', client_secret: 'seti_1_secret_abc', status: 'requires_payment_method', customer: form?.get('customer') });
  if (p === 'setup_intents/seti_1') return Response.json({ id: 'seti_1', customer: 'cus_1', status: 'succeeded', payment_method: 'pm_1', metadata: { agent_email: AGENT } });
  if (p === 'payment_methods/pm_1') return Response.json({ id: 'pm_1', customer: 'cus_1', card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2031 } });
  if (p === 'prices' && method === 'GET') return Response.json({ data: [] });
  if (p === 'products' && method === 'POST') return Response.json({ id: 'prod_1' });
  if (p === 'prices' && method === 'POST') return Response.json({ id: 'price_1', active: true, unit_amount: Number(form?.get('unit_amount')), recurring: { interval: 'month' } });
  if (p === 'prices/price_1') return Response.json({ id: 'price_1', active: true, unit_amount: 10000, recurring: { interval: 'month' } });
  if (p === 'subscriptions' && method === 'POST') return Response.json(stripeSubscription());
  if (p === 'subscriptions/sub_1') return Response.json(stripeSubscription());
  unexpected.push(`${method} ${url}`);
  return Response.json({ error: { message: `unexpected Stripe call ${method} ${p}` } }, { status: 500 });
}

function twilioMock(url: URL, method: string) {
  const u = url.origin + url.pathname;
  const API = 'https://api.twilio.com/2010-04-01', TRUST = 'https://trusthub.twilio.com/v1', MSG = 'https://messaging.twilio.com/v1';
  if (u === `${API}/Accounts.json`) return method === 'POST' ? Response.json({ sid: SUB_SID, status: 'active', friendly_name: 'x' }) : Response.json({ accounts: [] });
  if (u === `${API}/Accounts/${SUB_SID}.json`) return Response.json({ sid: SUB_SID, auth_token: SUB_TOKEN, status: 'active' });
  if (u === `${API}/Accounts/${SUB_SID}/AvailablePhoneNumbers/US/Local.json`) return Response.json({ available_phone_numbers: [{ phone_number: NUMBER, friendly_name: '(918) 555-2000', locality: 'Tulsa', region: 'OK' }] });
  if (u === `${API}/Accounts/${SUB_SID}/IncomingPhoneNumbers.json`) return method === 'POST' ? Response.json({ sid: 'PN' + '1'.repeat(32), phone_number: NUMBER }) : Response.json({ incoming_phone_numbers: [{ sid: 'PN' + '1'.repeat(32), phone_number: NUMBER }] });
  if (u === `${API}/Accounts/${SUB_SID}/Messages.json`) return Response.json({ sid: `SM${hex32()}`, status: 'queued' });
  if (u === `${API}/Accounts/${SUB_SID}/Addresses.json`) return Response.json({ sid: sid('AD') });
  if (u === `${TRUST}/CustomerProfiles`) return Response.json({ sid: sid('BU'), status: 'draft' });
  if (u === `${TRUST}/TrustProducts`) return Response.json({ sid: sid('BU'), status: 'draft' });
  if (u === `${TRUST}/EndUsers`) return Response.json({ sid: sid('IT') });
  if (u === `${TRUST}/SupportingDocuments`) return Response.json({ sid: sid('RD') });
  if (/\/(CustomerProfiles|TrustProducts)\/BU[0-9a-f]+\/EntityAssignments$/.test(u)) return Response.json({ sid: sid('BV') });
  if (/\/(CustomerProfiles|TrustProducts)\/BU[0-9a-f]+\/Evaluations$/.test(u)) return Response.json({ sid: sid('EL'), status: 'compliant', results: [] });
  if (/\/(CustomerProfiles|TrustProducts)\/BU[0-9a-f]+$/.test(u)) return Response.json({ sid: u.split('/').pop(), status: method === 'POST' ? 'pending-review' : 'draft' });
  if (u === `${MSG}/a2p/BrandRegistrations`) return Response.json({ sid: 'BN1', status: 'PENDING', identity_status: 'UNVERIFIED' });
  if (u === `${MSG}/a2p/BrandRegistrations/BN1`) return Response.json({ sid: 'BN1', status: carrier.brand, identity_status: 'VERIFIED' });
  if (u === `${MSG}/Services`) return Response.json({ sid: 'MG1' });
  if (u === `${MSG}/Services/MG1/Compliance/Usa2p`) return Response.json({ sid: 'QE1', campaign_status: 'IN_PROGRESS' });
  if (u === `${MSG}/Services/MG1/Compliance/Usa2p/QE1`) return Response.json({ sid: 'QE1', campaign_status: carrier.campaign });
  if (u === `${MSG}/Services/MG1/PhoneNumbers`) return Response.json({ sid: 'PN' + '1'.repeat(32) });
  // Caller-trust and health sweeps probe many more endpoints; every one of them tolerates an empty answer.
  return Response.json({});
}

globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
  const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(urlStr);
  const method = (init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  const headers = headerMap(init, input);
  let body: any = init.body, form: URLSearchParams | null = null;
  if (typeof init.body === 'string') { try { body = JSON.parse(init.body); } catch { form = new URLSearchParams(init.body); } }
  else if (init.body instanceof URLSearchParams) form = init.body;
  calls.push({ url: urlStr, method, body, form, headers });
  if (url.origin === SUPABASE_URL) {
    if (url.pathname === '/auth/v1/user') {
      const token = (headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (token === 'admin-jwt') return Response.json({ id: OWNER_UID, email: OWNER, user_metadata: { full_name: 'Riley Owner' }, aud: 'authenticated', role: 'authenticated', app_metadata: {}, created_at: '2026-01-01T00:00:00Z' });
      if (token === 'agent-jwt') return Response.json({ id: AGENT_UID, email: AGENT, user_metadata: { full_name: 'Sam Agent' }, aud: 'authenticated', role: 'authenticated', app_metadata: {}, created_at: '2026-01-01T00:00:00Z' });
      return Response.json({ message: 'invalid JWT' }, { status: 401 });
    }
    if (url.pathname === '/auth/v1/invite') return Response.json({ id: '66666666-6666-6666-6666-666666666666', email: body?.email, user_metadata: body?.data || {}, aud: 'authenticated', role: 'authenticated', created_at: new Date().toISOString() });
  }
  if (url.hostname === 'services.leadconnectorhq.com') return ghlMock(url, method, body);
  if (url.hostname === 'api.stripe.com') return stripeMock(url, method, form);
  if (url.hostname.endsWith('.twilio.com')) return twilioMock(url, method);
  if (url.hostname === 'api.anthropic.com') {
    const schema = body?.tools?.[0]?.input_schema;
    return Response.json({ id: 'msg_test', type: 'message', role: 'assistant', model: body?.model, content: [{ type: 'tool_use', id: 'tu_1', name: 'respond', input: answerFor(schema) }], stop_reason: 'tool_use' });
  }
  if (url.hostname === 'api.resend.com') return Response.json({ id: `em_${++n}` });
  unexpected.push(`${method} ${urlStr}`);
  return new Response('unexpected call in test', { status: 500 });
}) as typeof fetch;

/** Three open calendar times: about 2 and 4 hours from now, and one about 26 hours out, on the half hour. */
function slotTriple() {
  const half = 30 * 60000;
  const a = Math.ceil((Date.now() + 2 * 3600000) / half) * half;
  return [new Date(a).toISOString(), new Date(a + 2 * 3600000).toISOString(), new Date(a + 26 * 3600000).toISOString()];
}

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
function req(token: string, body: unknown, extra: RequestInit = {}) {
  return new Request('http://local/fn', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'x-base44-app-url': APP_URL }, body: JSON.stringify(body), ...extra });
}
const asAgent = (body: unknown) => req('agent-jwt', body);
const asAdmin = (body: unknown) => req('admin-jwt', body);
/** What pg_cron, the appointment trigger and functions.invoke send: the service role key. */
const asCron = (body: unknown) => req(SERVICE_KEY, body);
async function json(res: Response) {
  const text = await res.text();
  let data: any; try { data = JSON.parse(text); } catch { data = text; }
  if (res.status >= 400) throw new Error(`${res.status}: ${typeof data === 'object' ? data?.error : text}`);
  return data;
}
const settings = async () => (await E.AgentSettings.filter({ agent_email: AGENT }, { limit: 1 })).items[0];
const since = (i: number) => calls.slice(i);
const resendCalls = (from: number) => since(from).filter((c) => c.url.startsWith('https://api.resend.com/'));
const twilioTexts = (from: number) => since(from).filter((c) => c.url.endsWith('/Messages.json') && c.method === 'POST');

async function hmac(algo: 'SHA-1' | 'SHA-256', secret: string, data: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: algo }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
}
/** A Twilio-signed form POST to twilioWebhook, exactly as the subaccount would send it. */
async function twilioRequest(params: Record<string, string>) {
  const url = functionUrl('twilioWebhook');
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const mac = await hmac('SHA-1', SUB_TOKEN, data);
  const signature = btoa(String.fromCharCode(...mac));
  return new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature }, body: new URLSearchParams(params).toString() });
}
/** A Stripe-signed webhook POST. */
async function stripeRequest(event: unknown, secret = 'whsec_test') {
  const raw = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const mac = await hmac('SHA-256', secret, `${t}.${raw}`);
  const v1 = Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
  return new Request(functionUrl('stripeWebhook'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': `t=${t},v1=${v1}` }, body: raw });
}
/** A fixed-offset zone where the local clock reads 12:xx right now, so the texting window is open whenever the test runs. */
function middayZone() {
  const off = 12 - new Date().getUTCHours(); // local = UTC + off
  return off === 0 ? 'Etc/GMT' : off > 0 ? `Etc/GMT-${off}` : `Etc/GMT+${-off}`;
}

// Documented consent every real lead needs before a text can go out.
const CONSENT = { consent_source: 'web_form', consent_date: '2026-10-01', consent_text: 'I agree to receive text messages from Acme Life.', consent_seller_named: true, dnc_checked: true };

const REGISTRATION = {
  business_type: 'company', legal_business_name: 'Acme Life Agency LLC', entity_type: 'Limited Liability Corporation', first_name: 'Sam', last_name: 'Agent', npn: '1234567',
  rep_title: 'Owner', rep_position: 'CEO', mobile_phone: AGENT_CELL, business_email: 'sam@acmelife.test', business_phone: '(918) 555-0142',
  street: '100 Main St', city: 'Tulsa', region: 'OK', postal_code: '74103', website: '', privacy_url: '', terms_url: '',
  description: '', opt_in_flow: '', sample_message_1: '', sample_message_2: '', stop_response: '', help_response: '', attested: true, ein: '12-3456789',
};

Deno.test({ name: 'self-serve onboarding end to end', sanitizeOps: false, sanitizeResources: false }, async (t) => {
  await reset();
  let s: any, lead: any, appt: any, appt2: any;

  await t.step('seed: platform settings, owner (admin) and a brand-new agent sign-in', async () => {
    await E.PlatformSettings.create({
      singleton_key: 'platform', owner_email: OWNER, agency_company_id: 'comp_1', ghl_client_id: 'ghl-client', default_timezone: 'America/Chicago',
      credits_enforced: true, text_price_cents: 3, subscription_price_cents: 10000, stripe_mode: 'test', phone_number_setup_fee_cents: 0,
      a2p_provider: 'twilio', twilio_primary_profile_sid: 'BU_primary', twilio_isv_email: OWNER,
    });
    await sql`insert into auth.users (id, email, raw_user_meta_data) values (${OWNER_UID}::uuid, ${OWNER}, ${sql.json({ full_name: 'Riley Owner' })})`;
    await sql`insert into auth.users (id, email, raw_user_meta_data) values (${AGENT_UID}::uuid, ${AGENT}, ${sql.json({ full_name: 'Sam Agent' })})`;
    const roles = Object.fromEntries((await sql`select email, role from public.profiles`).map((r: any) => [r.email, r.role]));
    deepStrictEqual(roles, { [OWNER]: 'admin', [AGENT]: 'agent' }, 'the profiles trigger makes the owner an admin and everyone else an agent');
  });

  await t.step('ghlOAuth callback stores the agency OAuth credential and redirects to the app', async () => {
    // The callback refuses a code that was not started from Admin > Platform (no / forged / expired state).
    const noState = await ghlOAuth(new Request(`${functionUrl('ghlOAuth')}?code=auth-code-1`, { headers: { 'x-base44-app-url': APP_URL } }));
    deepStrictEqual(noState.status, 302);
    match(String(noState.headers.get('Location')), /ghl=error&message=.*not\+started\+from\+Admin/);
    deepStrictEqual(calls.filter((c) => c.url === 'https://services.leadconnectorhq.com/oauth/token').length, 0, 'no code exchange without a valid state');
    const state = await signInstallState(OWNER);
    const res = await ghlOAuth(new Request(`${functionUrl('ghlOAuth')}?code=auth-code-1&state=${encodeURIComponent(state)}`, { headers: { 'x-base44-app-url': APP_URL } }));
    deepStrictEqual(res.status, 302);
    deepStrictEqual(res.headers.get('Location'), `${APP_URL}/admin/platform?ghl=connected&bulk=0`);
    const tokenCall = calls.find((c) => c.url === 'https://services.leadconnectorhq.com/oauth/token');
    deepStrictEqual(tokenCall?.form?.get('redirect_uri'), `${SUPABASE_URL}/functions/v1/ghlOAuth`, 'the redirect URI is the Supabase function, not the Base44 path');
    const cred = (await E.PlatformCredential.filter({ key: 'ghl_agency' }, { limit: 1 })).items[0];
    deepStrictEqual(cred.company_id, 'comp_1');
    deepStrictEqual(cred.refresh_token, 'agency-refresh');
  });

  await t.step('workspace: a new user gets an agent_settings row and is sent to the welcome flow', async () => {
    const out = await json(await workspace(asAgent({})));
    deepStrictEqual(out.needs_welcome, true);
    deepStrictEqual(out.awaiting_setup, false);
    deepStrictEqual(out.user, { email: AGENT, full_name: 'Sam Agent', role: 'agent' });
    s = await settings();
    deepStrictEqual([s.status, s.self_serve, s.mode, s.onboarding_step, s.first_name, s.notification_email], ['onboarding', true, 'review', 1, 'Sam', AGENT]);
    ok(!('ghl_token' in out.settings), 'safeSettings hides the credential');
    // Second visit: no second row.
    await json(await workspace(asAgent({})));
    deepStrictEqual(await E.AgentSettings.count({ agent_email: AGENT }), 1);
  });

  await t.step('selfSetup save_profile validates and stores the profile', async () => {
    const profile = {
      first_name: 'Sam', last_name: 'Agent', brand_name: 'Acme Life', legal_business_name: 'Acme Life Agency LLC', npn: '1234567', address_street: '100 Main St', address_city: 'Tulsa', address_state: 'ok', address_zip: '74103',
      business_email: 'sam@acmelife.test', business_phone: '(918) 555-0142', alert_mobile: '918-555-0199', home_timezone: 'America/Chicago', licensed_states: ['OK', 'TX'], products_offered: ['IUL', 'Term'], preferred_area_code: '918',
    };
    const bad = await selfSetup(asAgent({ action: 'save_profile', profile: { ...profile, address_zip: '12' } }));
    deepStrictEqual((await bad.json()).error, 'Enter a 5-digit ZIP code.');
    const out = await json(await selfSetup(asAgent({ action: 'save_profile', profile })));
    deepStrictEqual(out.missing, []);
    deepStrictEqual(out.platform_connected, true);
    deepStrictEqual(out.provisioning.state, 'not_started');
    deepStrictEqual(out.profile.address_state, 'OK');
    deepStrictEqual(out.profile.business_phone, '+19185550142');
    deepStrictEqual(out.profile.alert_mobile, AGENT_CELL);
    s = await settings();
    deepStrictEqual(s.business_address, '100 Main St, Tulsa, OK 74103');
    deepStrictEqual(s.agency_name, 'Acme Life Agency LLC');
  });

  await t.step('selfSetup build provisions the GHL workspace (background) until provisioning.state is done', async () => {
    const out = await json(await selfSetup(asAgent({ action: 'build' })));
    ok(['running', 'done'].includes(out.provisioning.state), out.provisioning.state);
    await settle();
    s = await settings();
    deepStrictEqual(s.provisioning.state, 'done', JSON.stringify(s.provisioning));
    deepStrictEqual(s.provisioning.steps, { workspace: 'done', access: 'done', data_model: 'done', calendar: 'done', campaign: 'done' });
    deepStrictEqual([s.location_id, s.calendar_id, s.pipeline_id, s.connected, s.token_kind, s.ghl_token, s.agent_ghl_user_id], [LOCATION, CALENDAR, 'pipe_1', true, 'oauth', 'loc-token', 'u_agent']);
    deepStrictEqual(Object.keys(s.stage_ids).length, stageNames.length);
    ok(Object.keys(s.custom_field_ids).length > 0 && Object.keys(s.tag_ids).length > 0 && Object.keys(s.custom_value_ids).length > 0);
    const campaign = (await E.Campaign.filter({ agent_email: AGENT }, { limit: 5 })).items;
    deepStrictEqual(campaign.length, 1);
    deepStrictEqual([campaign[0].name, campaign[0].status, campaign[0].location_id, campaign[0].pipeline_id], ['Life Insurance Respark', 'draft', LOCATION, 'pipe_1']);
    const view = await json(await selfSetup(asAgent({})));
    deepStrictEqual(view.workspace_ready, true);
    deepStrictEqual(view.provisioning.steps.every((x: any) => x.status === 'done'), true);
    const w = await json(await workspace(asAgent({})));
    deepStrictEqual(w.needs_welcome, false);
  });

  await t.step('createSetupIntent + saveBillingCard save the card without a charge', async () => {
    const denied = await createSetupIntent(asAgent({}));
    deepStrictEqual((await denied.json()).error, 'Confirm permission to save your card first.');
    const out = await json(await createSetupIntent(asAgent({ consent: true })));
    deepStrictEqual(out.client_secret, 'seti_1_secret_abc');
    const a0 = (await E.BillingAccount.filter({ agent_email: AGENT }, { limit: 1 })).items[0];
    deepStrictEqual([a0.stripe_customer_id, a0.setup_intent_id, a0.status], ['cus_1', 'seti_1', 'not_started']);
    const saved = await json(await saveBillingCard(asAgent({ consent: true })));
    deepStrictEqual(saved.card, { status: 'card_saved', brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2031 });
    const a = (await E.BillingAccount.filter({ agent_email: AGENT }, { limit: 1 })).items[0];
    deepStrictEqual([a.payment_method_id, a.status, a.balance_cents], ['pm_1', 'card_saved', 0]);
    const defaultCard = calls.find((c) => c.url === 'https://api.stripe.com/v1/customers/cus_1' && c.method === 'POST');
    deepStrictEqual(defaultCard?.form?.get('invoice_settings[default_payment_method]'), 'pm_1');
    ok(!calls.some((c) => /\/v1\/(charges|payment_intents)/.test(c.url)), 'no charge was created');
    s = await settings();
    deepStrictEqual(s.setup_checklist, { billing: true });
  });

  await t.step('subscription subscribe starts the monthly plan and marks the billing account active', async () => {
    const before = await json(await subscription(asAgent({ action: 'view' })));
    deepStrictEqual([before.required, before.ok, before.status, before.price_cents], [true, false, 'none', 10000]);
    const out = await json(await subscription(asAgent({ action: 'subscribe', confirm: true, nonce: 'nonce-12345678' })));
    deepStrictEqual([out.ok, out.status, out.amount_cents, out.cancel_at_period_end], [true, 'active', 10000, false]);
    deepStrictEqual(out.client_secret, undefined);
    const a = (await E.BillingAccount.filter({ agent_email: AGENT }, { limit: 1 })).items[0];
    deepStrictEqual([a.subscription_id, a.subscription_status, a.status], ['sub_1', 'active', 'card_saved']);
    ok(a.subscription_consent_at && a.subscription_period_end);
    const sub = calls.find((c) => c.url === 'https://api.stripe.com/v1/subscriptions' && c.method === 'POST');
    deepStrictEqual([sub?.form?.get('customer'), sub?.form?.get('items[0][price]'), sub?.form?.get('default_payment_method'), sub?.headers['idempotency-key']], ['cus_1', 'price_1', 'pm_1', `subscribe:${a.id}:first`], 'the idempotency key is server-derived (billing account + previous subscription), not the client nonce');
    const config = (await E.PlatformSettings.filter({ singleton_key: 'platform' }, { limit: 1 })).items[0];
    deepStrictEqual(config.stripe_price_id, 'price_1');
    // Still onboarding: no number, no registration.
    deepStrictEqual((await settings()).status, 'onboarding');
  });

  await t.step('searchNumbers lists Twilio numbers in the agent subaccount; purchaseNumber buys one', async () => {
    const found = await json(await searchNumbers(asAgent({ area_code: '918' })));
    deepStrictEqual(found.manual, false);
    deepStrictEqual(found.numbers, [{ phone_number: NUMBER, friendly_name: '(918) 555-2000 · Tulsa, OK' }]);
    const acct0 = (await E.TwilioAccount.filter({ agent_email: AGENT }, { limit: 1 })).items[0];
    deepStrictEqual([acct0.subaccount_sid, acct0.source, acct0.location_id], [SUB_SID, 'created', LOCATION]);

    const out = await json(await purchaseNumber(asAgent({ confirmed: true, phone_number: NUMBER, area_code: '918' })));
    deepStrictEqual(out, { status: 'done', phone_number: NUMBER, charged_cents: 0 });
    const acct = (await E.TwilioAccount.filter({ agent_email: AGENT }, { limit: 1 })).items[0];
    deepStrictEqual([acct.phone_number, acct.phone_sid, acct.webhook_url], [NUMBER, 'PN' + '1'.repeat(32), `${SUPABASE_URL}/functions/v1/twilioWebhook`]);
    const rows = (await E.PhoneNumber.filter({ agent_email: AGENT }, { limit: 5 })).items;
    deepStrictEqual(rows.length, 1);
    deepStrictEqual([rows[0].phone_number, rows[0].is_primary, rows[0].status, rows[0].subaccount_sid, rows[0].in_messaging_service], [NUMBER, true, 'active', SUB_SID, false]);
    const bought = calls.find((c) => c.url.endsWith(`/Accounts/${SUB_SID}/IncomingPhoneNumbers.json`) && c.method === 'POST');
    deepStrictEqual(bought?.form?.get('SmsUrl'), `${SUPABASE_URL}/functions/v1/twilioWebhook`);
    ok(String(bought?.form?.get('VoiceUrl')).startsWith(`${SUPABASE_URL}/functions/v1/twilioWebhook?voice=`));
    s = await settings();
    deepStrictEqual([s.phone_number, s.preferred_area_code], [NUMBER, '918']);
    const task = (await E.ProvisioningTask.filter({ key: `number:${AGENT}` }, { limit: 1 })).items[0];
    deepStrictEqual(task.status, 'done');
    const again = await purchaseNumber(asAgent({ confirmed: true, phone_number: NUMBER, area_code: '918' }));
    deepStrictEqual((await again.json()).error, 'You already have a texting number.');
  });

  await t.step('a2pSubmit registers the brand with Twilio and ends brand_submitted', async () => {
    const draft = await json(await a2pSubmit(asAgent({ ...REGISTRATION, draft: true })));
    deepStrictEqual(draft.status, 'draft');
    const out = await json(await a2pSubmit(asAgent(REGISTRATION)));
    deepStrictEqual(out.status, 'brand_submitted');
    ok(/Brand submitted to the carriers/.test(out.review_note));
    const reg = (await E.A2PRegistration.filter({ agent_email: AGENT }, { limit: 1 })).items[0];
    deepStrictEqual([reg.status, reg.provider_step, reg.brand_sid, reg.brand_status, reg.twilio_subaccount_sid, reg.ein_last4, reg.business_type], ['brand_submitted', 'brand', 'BN1', 'PENDING', SUB_SID, '6789', 'company']);
    ok(/^BU/.test(reg.customer_profile_sid) && /^BU/.test(reg.trust_product_sid));
    // Program copy was pre-filled from the hosted site and names the brand.
    deepStrictEqual(reg.website, `${APP_URL}/a/${s.public_slug || (await settings()).public_slug}`);
    ok(reg.sample_message_1.includes('Acme Life Agency LLC') && /STOP/.test(reg.sample_message_1));
    ok(reg.opt_in_flow.includes(reg.website));
    // The EIN went to Twilio and nowhere else.
    const business = calls.find((c) => c.url === 'https://trusthub.twilio.com/v1/EndUsers' && c.form?.get('Type') === 'customer_profile_business_information');
    deepStrictEqual(JSON.parse(String(business?.form?.get('Attributes'))).business_registration_number, '123456789');
    ok(!JSON.stringify(reg).includes('123456789'), 'EIN is never stored');
    deepStrictEqual((await settings()).a2p_status, 'brand_submitted');
    const locked = await a2pSubmit(asAgent(REGISTRATION));
    deepStrictEqual((await locked.json()).error, 'Your registration is already in review or approved.');
    const status = await json(await a2pStatus(asAgent({})));
    deepStrictEqual(status.registration.status, 'brand_submitted');
  });

  await t.step('a2pAdvance (cron): APPROVED brand creates the messaging service and campaign', async () => {
    carrier.brand = 'APPROVED';
    const mark = calls.length;
    const out = await json(await a2pAdvance(asCron({})));
    deepStrictEqual([out.checked, out.approved, out.errors, out.resubmitted], [1, 0, 0, 0]);
    const reg = (await E.A2PRegistration.filter({ agent_email: AGENT }, { limit: 1 })).items[0];
    deepStrictEqual([reg.status, reg.provider_step, reg.brand_status, reg.messaging_service_sid, reg.campaign_sid, reg.campaign_status, reg.number_attached], ['campaign_submitted', 'campaign', 'APPROVED', 'MG1', 'QE1', 'IN_PROGRESS', NUMBER]);
    const campaign = since(mark).find((c) => c.url === 'https://messaging.twilio.com/v1/Services/MG1/Compliance/Usa2p' && c.method === 'POST');
    deepStrictEqual([campaign?.form?.get('BrandRegistrationSid'), campaign?.form?.get('UsAppToPersonUsecase'), campaign?.form?.getAll('MessageSamples').length], ['BN1', 'MARKETING', 4]);
    deepStrictEqual(since(mark).find((c) => c.url === 'https://messaging.twilio.com/v1/Services/MG1/PhoneNumbers')?.form?.get('PhoneNumberSid'), 'PN' + '1'.repeat(32));
    ok(resendCalls(mark).some((c) => c.body?.subject === 'Step 1 of 2 approved: your business is verified'), 'the agent is emailed about the progress');
    deepStrictEqual((await settings()).status, 'onboarding');
  });

  await t.step('a2pAdvance (cron): VERIFIED campaign approves texting', async () => {
    carrier.campaign = 'VERIFIED';
    const mark = calls.length;
    const out = await json(await a2pAdvance(asCron({})));
    deepStrictEqual([out.checked, out.approved, out.errors], [1, 1, 0]);
    const reg = (await E.A2PRegistration.filter({ agent_email: AGENT }, { limit: 1 })).items[0];
    deepStrictEqual([reg.status, reg.provider_step, reg.campaign_status], ['approved', 'done', 'VERIFIED']);
    ok(reg.approved_at);
    deepStrictEqual(reg.review_note, 'Approved. Your number is registered for texting.');
    s = await settings();
    deepStrictEqual(s.a2p_status, 'approved');
    deepStrictEqual(s.status, 'onboarding', 'not live yet: the two-way test text is still outstanding');
    ok(resendCalls(mark).some((c) => c.body?.subject === 'Texting is approved. You can go live.'));
    const heartbeat = (await E.EngineCursor.filter({ key: 'heartbeat:a2p_status' }, { limit: 1 })).items[0];
    deepStrictEqual(JSON.parse(heartbeat.cursor).approved, 1);
    const status = await json(await getSetupStatus(asAgent({})));
    deepStrictEqual(status.checklist, { billing: true, number: true, texting: true, calendar: false });
    deepStrictEqual(status.phone_number, NUMBER);
  });

  await t.step('launch send_test texts the agent; their YES through twilioWebhook turns the agent live', async () => {
    const mark = calls.length;
    const out = await json(await launch(asAgent({ action: 'send_test' })));
    deepStrictEqual(out.live, false);
    deepStrictEqual(out.ready, false);
    deepStrictEqual(out.items.filter((i: any) => !i.done).map((i: any) => i.key), ['test', 'leads']);
    ok(/Reply YES to the text we sent to/.test(out.items.find((i: any) => i.key === 'test').detail));
    const test = twilioTexts(mark)[0];
    deepStrictEqual([test?.form?.get('To'), test?.form?.get('From')], [AGENT_CELL, NUMBER]);
    ok(/Reply YES/.test(String(test?.form?.get('Body'))));
    s = await settings();
    ok(s.onboarding_checks.self_test_sent_at && /^SM/.test(s.onboarding_checks.self_test_sid));

    // Twilio delivers the agent's reply to the public webhook (signature over the stored webhook URL).
    const bad = await twilioWebhook(new Request(functionUrl('twilioWebhook'), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': 'nope' }, body: new URLSearchParams({ AccountSid: SUB_SID, From: AGENT_CELL, To: NUMBER, Body: 'YES', MessageSid: `SM${hex32()}` }).toString() }));
    deepStrictEqual(bad.status, 403);
    const res = await twilioWebhook(await twilioRequest({ AccountSid: SUB_SID, From: AGENT_CELL, To: NUMBER, Body: 'YES', MessageSid: `SM${hex32()}`, SmsStatus: 'received' }));
    deepStrictEqual(res.status, 200);
    ok((await res.text()).includes('<Response></Response>'));
    await settle();
    s = await settings();
    deepStrictEqual([s.status, s.onboarding_complete, s.mode], ['live', true, 'review']);
    ok(s.live_at && s.onboarding_checks.self_test_at && s.onboarding_checks.webhook_received === true);
    deepStrictEqual(await E.Lead.count({ agent_email: AGENT }), 0, 'the agent replying is not a lead');
    deepStrictEqual((await E.ControlAudit.filter({ agent_email: AGENT, action: 'account_activated' }, { limit: 1 })).items.length, 1);
    const after = await json(await launch(asAgent({})));
    deepStrictEqual([after.live, after.ready, after.automatic], [true, true, true]);
  });

  await t.step('availability book creates the appointment and the booking journey emails lead and agent', async () => {
    const tz = middayZone();
    // Credits for the texts the journey sends to leads (purchases are mocked elsewhere; this stands in for billingCredits buy).
    const a = (await E.BillingAccount.filter({ agent_email: AGENT }, { limit: 1 })).items[0];
    await E.BillingAccount.update(a.id, { balance_cents: 5000 });
    contacts.c_1 = { phone: '+14695551234', state: 'TX' };
    lead = await E.Lead.create({ agent_email: AGENT, location_id: LOCATION, ghl_contact_id: 'c_1', first_name: 'Dana', last_name: 'Lead', phone: '+14695551234', email: 'dana@example.test', state: 'TX', timezone: tz, status: 'engaged', ai_paused: false, ai_summary: 'Asked about term coverage for her family.', ...CONSENT });
    const view = await json(await availability(asAgent({})));
    deepStrictEqual([view.calendar_ready, view.timezone, view.max_calls_per_day], [true, 'America/Chicago', 6]);
    const slots = await json(await availability(asAgent({ action: 'slots', lead_id: lead.id })));
    deepStrictEqual(slots.slots.length, 3);
    const slot = slotTriple()[2];
    const mark = calls.length;
    const out = await json(await availability(asAgent({ action: 'book', lead_id: lead.id, slot, notify: false })));
    deepStrictEqual(out, { booked: true });
    const created = since(mark).find((c) => c.url === 'https://services.leadconnectorhq.com/calendars/events/appointments');
    deepStrictEqual([created?.body?.calendarId, created?.body?.contactId, created?.body?.startTime], [CALENDAR, 'c_1', slot]);
    appt = (await E.Appointment.filter({ agent_email: AGENT, lead_id: lead.id }, { limit: 1 })).items[0];
    deepStrictEqual([appt.status, appt.start_time, appt.phone_to_call, appt.lead_name, appt.lead_timezone], ['booked', slot, '+14695551234', 'Dana Lead', tz]);
    const l = await E.Lead.get(lead.id);
    deepStrictEqual([l.status, l.ai_paused, l.sequence_paused], ['booked', true, true]);
    // The booking starts the journey in the background (what the Postgres trigger also does via appointmentJourney).
    await settle();
    appt = await E.Appointment.get(appt.id);
    deepStrictEqual(appt.email_status, { lead: 'sent', agent: 'sent' });
    deepStrictEqual(appt.confirmation, 'pending');
    ok(/^[a-f0-9]{32}$/.test(appt.invite_token));
    ok(appt.journey[`booked@${slot}`]);
    const emails = resendCalls(mark);
    const toLead = emails.find((c) => c.body?.to?.[0] === 'dana@example.test');
    ok(toLead, 'lead got the confirmation email');
    ok(toLead.body.html.includes(`href="${SUPABASE_URL}/functions/v1/calendarInvite?a=${appt.id}&amp;t=${appt.invite_token}&amp;w=lead"`), 'calendar link points at the Supabase function');
    ok(toLead.body.from.startsWith('Sam at Acme Life <'));
    ok(emails.some((c) => c.body?.to?.[0] === AGENT && /Call booked: Dana Lead/.test(c.body.subject)), 'agent got the brief (notification_email)');
    // A second call for the same booking is a no-op.
    deepStrictEqual(await json(await appointmentJourney(asCron({ appointment_id: appt.id }))), { skipped: 'already handled' });
  });

  await t.step('appointmentJourney {appointment_id} (the booked-appointment trigger) emails for a call booked elsewhere', async () => {
    const tz = middayZone();
    contacts.c_2 = { phone: '+14695555678', state: 'TX' };
    const lead2 = await E.Lead.create({ agent_email: AGENT, location_id: LOCATION, ghl_contact_id: 'c_2', first_name: 'Lee', phone: '+14695555678', email: 'lee@example.test', state: 'TX', timezone: tz, status: 'booked', ai_paused: true, ...CONSENT });
    const start = new Date(Math.floor(Date.now() / 60000) * 60000 + 9 * 60000).toISOString();
    appt2 = await E.Appointment.create({ agent_email: AGENT, location_id: LOCATION, ghl_appointment_id: 'apt_ext_1', lead_id: lead2.id, lead_name: 'Lee', phone_to_call: '+14695555678', start_time: start, lead_timezone: tz, status: 'booked' });
    const mark = calls.length;
    const out = await json(await appointmentJourney(asCron({ appointment_id: appt2.id })));
    deepStrictEqual([out.lead_email, out.agent_email], ['sent', 'sent']);
    deepStrictEqual(resendCalls(mark).map((c) => c.body.to[0]).sort(), [AGENT, 'lee@example.test']);
    appt2 = await E.Appointment.get(appt2.id);
    deepStrictEqual(appt2.confirmation, 'confirmed', 'a call inside three hours needs no confirmation text');
    deepStrictEqual(Object.keys(appt2.journey), [`booked@${start}`]);
    // Pretend the booking happened half an hour ago so the pre-call steps are now due.
    await E.Appointment.update(appt2.id, { journey: { [`booked@${start}`]: new Date(Date.now() - 30 * 60000).toISOString() } });
  });

  await t.step('appointmentReminders (cron) sends the due pre-call texts and records them on the journey', async () => {
    const mark = calls.length;
    const out = await json(await appointmentReminders(asCron({})));
    deepStrictEqual(out.journey.scanned, 2, JSON.stringify(out));
    deepStrictEqual([out.sent, out.journey.failed], [2, 0], JSON.stringify(out));
    appt2 = await E.Appointment.get(appt2.id);
    deepStrictEqual(Object.keys(appt2.journey).sort(), [`agent_brief@${appt2.start_time}`, `booked@${appt2.start_time}`, `calling_soon@${appt2.start_time}`].sort());
    const texts = twilioTexts(mark).map((c) => ({ to: c.form?.get('To'), body: String(c.form?.get('Body')) }));
    ok(texts.some((x) => x.to === '+14695555678' && /will call you in about 10 minutes/.test(x.body)), JSON.stringify(texts));
    ok(texts.some((x) => x.to === AGENT_CELL && /Call in 15 min: Lee/.test(x.body)), JSON.stringify(texts));
    deepStrictEqual((await E.MessageLog.filter({ lead_id: appt2.lead_id, event_type: 'sms_sent', source: 'reminder' }, { limit: 5 })).items.length, 1);
    // The first appointment (26 hours out) has nothing due yet.
    deepStrictEqual(Object.keys((await E.Appointment.get(appt.id)).journey), [`booked@${appt.start_time}`]);
    const heartbeat = (await E.EngineCursor.filter({ key: 'heartbeat:appointment_reminders' }, { limit: 1 })).items[0];
    deepStrictEqual(JSON.parse(heartbeat.cursor).sent, 2);
    // Nothing is sent twice.
    const again = await json(await appointmentReminders(asCron({})));
    deepStrictEqual(again.sent, 0);
  });

  await t.step('stripeWebhook verifies the signature, syncs the account once per event id', async () => {
    const event = { id: 'evt_1', type: 'invoice.paid', data: { object: { id: 'in_1', customer: 'cus_1', amount_paid: 10000 } } };
    deepStrictEqual((await stripeWebhook(await stripeRequest(event, 'whsec_wrong'))).status, 400);
    deepStrictEqual(await json(await stripeWebhook(await stripeRequest(event))), { ok: true, result: 'synced' });
    deepStrictEqual(await json(await stripeWebhook(await stripeRequest(event))), { ok: true, duplicate: true });
    deepStrictEqual(await json(await stripeWebhook(await stripeRequest({ id: 'evt_2', type: 'invoice.paid', data: { object: { customer: 'cus_unknown' } } }))), { ok: true, result: 'no account' });
    const a = (await E.BillingAccount.filter({ agent_email: AGENT }, { limit: 1 })).items[0];
    deepStrictEqual(a.subscription_status, 'active');
    deepStrictEqual((await E.EngineCursor.filter({ key: 'stripe_evt:evt_1' }, { limit: 1 })).items.length, 1);
  });

  await t.step('inviteAgent (admin) invites through Supabase Auth; the profile comes from the trigger', async () => {
    await E.AgentSettings.create({ agent_email: INVITEE, first_name: 'New', display_name: 'New Agent', status: 'onboarding' });
    const denied = await inviteAgent(asAgent({ action: 'invite', agent_email: INVITEE }));
    deepStrictEqual((await denied.json()).error, 'Administrator access required.');
    const mark = calls.length;
    const out = await json(await inviteAgent(asAdmin({ action: 'invite', agent_email: INVITEE })));
    deepStrictEqual(out.settings.invite_status, 'Invitation sent (agent access)');
    ok(out.settings.invited_at);
    const invite = since(mark).find((c) => c.url.startsWith(`${SUPABASE_URL}/auth/v1/invite`));
    ok(String(invite?.url).includes(`redirect_to=${encodeURIComponent(`${APP_URL}/`)}`), 'the invite link lands on the app');
    deepStrictEqual([invite?.body?.email, invite?.body?.data?.role, invite?.headers.authorization], [INVITEE, 'agent', `Bearer ${SERVICE_KEY}`]);
    // What Supabase Auth does next: the new auth.users row makes a profile through the trigger.
    await sql`insert into auth.users (id, email, raw_user_meta_data) values ('66666666-6666-6666-6666-666666666666'::uuid, ${INVITEE}, ${sql.json({ role: 'agent' })})`;
    deepStrictEqual((await sql`select role from public.profiles where email = ${INVITEE}`)[0].role, 'agent');
    deepStrictEqual((await E.ProvisioningLog.filter({ agent_email: INVITEE, object_type: 'app_invite' }, { limit: 1 })).items.length, 1);
    // Already registered: no second invite, the existing profile is kept.
    const again = await json(await inviteAgent(asAdmin({ action: 'invite', agent_email: INVITEE })));
    deepStrictEqual(again.settings.invite_status, 'Invitation sent (agent access)');
    deepStrictEqual(since(mark).filter((c) => c.url.includes('/auth/v1/invite')).length, 1);
  });

  await t.step('results shows the booked calls; no unexpected outside calls; only known schema drift was dropped', async () => {
    const out = await json(await results(asAgent({})));
    deepStrictEqual([out.booked, out.texted, out.closed], [2, 1, 0]);
    deepStrictEqual(unexpected, []);
    const unknown = [...dropped].filter((f) => !KNOWN_DROPPED_FIELDS.has(f));
    deepStrictEqual(unknown, [], `fields written by the handlers that the schema does not declare: ${unknown.join(', ')}`);
  });

  await settle();
  await closeSql();
});
