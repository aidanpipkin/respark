// GOAT Leads (gotleads.com) inbound webhook -> GHL contact + opportunity + confirmation SMS
//
// URL to paste into GOAT CRM:  https://vesper-4e3ffdf5.base44.app/functions/goatLeadWebhook?token=GtQ-9nhHwOdazPAS-lGbY75wHB66wY3p
//
// Accepts JSON or form-encoded POST. Every payload is logged to the GoatLead entity (raw_payload) so field
// mapping can be verified. When PROCESSING_ENABLED is true, it also:
//   1. Upserts the GHL contact (tags: GOAT Lead, Fresh Lead, <lead type>)
//   2. Creates an opportunity in PIPELINE_ID at NEW_LEAD_STAGE_ID (skips if an open one already exists)
//   3. Texts FRESH leads the opener (T1) if inside 8am-8:30pm local, otherwise queues it for 8:30am
//   4. Texts Aidan a new-lead alert
// Follow-up texts (T2 on reply, T3 nudge, T4 final) are handled by goatLeadFollowup every 5 minutes.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const WEBHOOK_TOKEN = 'GtQ-9nhHwOdazPAS-lGbY75wHB66wY3p';
const PROCESSING_ENABLED = true;

const GHL_API_KEY = Deno.env.get('GHL_API_KEY') || 'pit-85b0f99f-d8cd-4e7d-9373-5213bd2548f0';
const LOC = 'P1m006Mt7YCXCAdiBBxC';
const AIDAN_CONTACT_ID = 'hLZmFD5Azf8WHCpBuk0d';

// GHL pipeline "GOAT Fresh Leads" (created 2026-10-01)
const PIPELINE_ID = 'Thff0j9pAbolXby28EbT';
const NEW_LEAD_STAGE_ID = 'e6e62abc-045f-4b65-80e8-2ee869e3e3d9';   // New Lead
// Other stages for reference: Contacted 14970631-0cfd-4958-a6da-e5d70cb32a74 | Lead Booked e53033ad-5b8d-47c6-bf03-a2e07d0d911e
//                             Not Interested e423de7a-cf26-49fc-a910-a9f6dbda4678 | Closed 62923a56-ebfa-4c24-9cc1-3556acbe3934

const BUSINESS_CARD_URL = 'https://myagentisverified.com/Website/apipkin';
const CALENDAR_URL = 'https://myagentisverified.com/Calendar/aidanpipkin';

const H = { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28', 'Accept': 'application/json', 'Content-Type': 'application/json' };

// ---------- helpers ----------
function pick(obj: any, keys: string[]): string {
  if (!obj || typeof obj !== 'object') return '';
  const lower: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) lower[k.toLowerCase().replace(/[\s_\-\.]/g, '')] = v;
  for (const k of keys) {
    const v = lower[k.toLowerCase().replace(/[\s_\-\.]/g, '')];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

function flatten(payload: any): any {
  // Merge common nesting containers so pick() sees everything
  const out: any = { ...(payload || {}) };
  for (const key of ['lead', 'data', 'contact', 'customer', 'fields', 'payload', 'record']) {
    if (payload && typeof payload[key] === 'object' && payload[key] !== null) Object.assign(out, payload[key]);
  }
  return out;
}

function toE164(raw: string): string {
  const d = (raw || '').replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  if (raw && raw.trim().startsWith('+') && d.length > 10) return `+${d}`;
  return '';
}

function properCase(s: string): string {
  return (s || '').trim().toLowerCase().replace(/(^|[\s'-])([a-z])/g, (m, p, c) => p + c.toUpperCase());
}

const STATE_TZ: Record<string, string> = {
  CT:'America/New_York',DE:'America/New_York',FL:'America/New_York',GA:'America/New_York',ME:'America/New_York',MD:'America/New_York',MA:'America/New_York',NH:'America/New_York',NJ:'America/New_York',NY:'America/New_York',NC:'America/New_York',OH:'America/New_York',PA:'America/New_York',RI:'America/New_York',SC:'America/New_York',VT:'America/New_York',VA:'America/New_York',WV:'America/New_York',DC:'America/New_York',MI:'America/New_York',IN:'America/New_York',KY:'America/New_York',
  AL:'America/Chicago',AR:'America/Chicago',IL:'America/Chicago',IA:'America/Chicago',KS:'America/Chicago',LA:'America/Chicago',MN:'America/Chicago',MS:'America/Chicago',MO:'America/Chicago',NE:'America/Chicago',ND:'America/Chicago',OK:'America/Chicago',SD:'America/Chicago',TN:'America/Chicago',TX:'America/Chicago',WI:'America/Chicago',
  AZ:'America/Phoenix',CO:'America/Denver',ID:'America/Denver',MT:'America/Denver',NM:'America/Denver',UT:'America/Denver',WY:'America/Denver',
  CA:'America/Los_Angeles',NV:'America/Los_Angeles',OR:'America/Los_Angeles',WA:'America/Los_Angeles',AK:'America/Anchorage',HI:'Pacific/Honolulu',
};
const STATE_NAMES: Record<string, string> = {alabama:'AL',alaska:'AK',arizona:'AZ',arkansas:'AR',california:'CA',colorado:'CO',connecticut:'CT',delaware:'DE',florida:'FL',georgia:'GA',hawaii:'HI',idaho:'ID',illinois:'IL',indiana:'IN',iowa:'IA',kansas:'KS',kentucky:'KY',louisiana:'LA',maine:'ME',maryland:'MD',massachusetts:'MA',michigan:'MI',minnesota:'MN',mississippi:'MS',missouri:'MO',montana:'MT',nebraska:'NE',nevada:'NV','new hampshire':'NH','new jersey':'NJ','new mexico':'NM','new york':'NY','north carolina':'NC','north dakota':'ND',ohio:'OH',oklahoma:'OK',oregon:'OR',pennsylvania:'PA','rhode island':'RI','south carolina':'SC','south dakota':'SD',tennessee:'TN',texas:'TX',utah:'UT',vermont:'VT',virginia:'VA',washington:'WA','west virginia':'WV',wisconsin:'WI',wyoming:'WY','district of columbia':'DC'};
function stateToCode(s: string): string { const t = (s || '').trim(); if (/^[A-Za-z]{2}$/.test(t)) return t.toUpperCase(); return STATE_NAMES[t.toLowerCase()] || ''; }
function tzForState(code: string): string { return STATE_TZ[code] || 'America/Chicago'; }
function localParts(d: Date, tz: string) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d);
  const g = (t: string) => parseInt(p.find(x => x.type === t)!.value, 10);
  return { y: g('year'), mo: g('month'), d: g('day'), h: g('hour') % 24, mi: g('minute') };
}
function localToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  let guess = new Date(Date.UTC(y, mo - 1, d, h, mi));
  for (let i = 0; i < 2; i++) { const lp = localParts(guess, tz); const diff = Date.UTC(lp.y, lp.mo - 1, lp.d, lp.h, lp.mi) - guess.getTime(); guess = new Date(Date.UTC(y, mo - 1, d, h, mi) - diff); }
  return guess;
}
function inSendWindow(now: Date, tz: string): boolean { const lp = localParts(now, tz); const m = lp.h * 60 + lp.mi; return m >= 8 * 60 && m <= 20 * 60 + 30; }
function nextMorning(now: Date, tz: string): Date {
  const lp = localParts(now, tz); const m = lp.h * 60 + lp.mi;
  if (m < 8 * 60) return localToUtc(lp.y, lp.mo, lp.d, 8, 30, tz);
  const n = localParts(new Date(now.getTime() + 86400000), tz); return localToUtc(n.y, n.mo, n.d, 8, 30, tz);
}

async function ghl(path: string, init: RequestInit = {}) {
  const r = await fetch(`https://services.leadconnectorhq.com${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } });
  const text = await r.text();
  let json: any = {};
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { ok: r.ok, status: r.status, json };
}

function confirmationSms(first: string): string {
  const hi = first ? `Hey ${first}, ` : 'Hey, ';
  return `${hi}this is Aidan \u2014 I\u2019m the licensed financial advisor who received your CDL/IUL request. I\u2019m looking at it now.\n` +
    `Quick question so I pull up the right options \u2014 are you a company driver or owner-operator?`;
}

// ---------- handler ----------
Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  if (req.method === 'GET') {
    return Response.json({ ok: true, service: 'goatLeadWebhook', message: 'POST lead data here' });
  }
  if (url.searchParams.get('token') !== WEBHOOK_TOKEN) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const base44 = createClientFromRequest(req);
  const now = new Date();
  const contentType = req.headers.get('content-type') || '';

  // Parse body: JSON, form-encoded, or query string
  let payload: any = {};
  try {
    const text = await req.text();
    if (text) {
      if (contentType.includes('application/json')) payload = JSON.parse(text);
      else if (contentType.includes('form')) payload = Object.fromEntries(new URLSearchParams(text));
      else { try { payload = JSON.parse(text); } catch { payload = Object.fromEntries(new URLSearchParams(text)); } }
    }
  } catch (e) { payload = { parse_error: String(e) }; }
  for (const [k, v] of url.searchParams.entries()) if (k !== 'token' && payload[k] === undefined) payload[k] = v;

  const f = flatten(payload);
  let first = pick(f, ['first_name', 'firstname', 'first', 'fname', 'given_name', 'contact_first_name']);
  let last = pick(f, ['last_name', 'lastname', 'last', 'lname', 'surname', 'family_name', 'contact_last_name']);
  const fullName = pick(f, ['name', 'full_name', 'fullname', 'contact_name', 'lead_name']);
  if (!first && fullName) { const parts = fullName.split(/\s+/); first = parts[0]; last = last || parts.slice(1).join(' '); }
  const phoneRaw = pick(f, ['phone', 'phone_number', 'phonenumber', 'mobile', 'cell', 'cell_phone', 'mobile_phone', 'primary_phone', 'telephone', 'contact_phone']);
  const email = pick(f, ['email', 'email_address', 'emailaddress', 'contact_email']).toLowerCase();
  const state = pick(f, ['state', 'st', 'state_code', 'region', 'province']);
  const city = pick(f, ['city', 'town']);
  const zip = pick(f, ['zip', 'zipcode', 'zip_code', 'postal_code', 'postalcode', 'postal']);
  const address = pick(f, ['address', 'street', 'address1', 'street_address', 'address_line_1']);
  const dob = pick(f, ['dob', 'date_of_birth', 'birthdate', 'birth_date', 'birthday']);
  const leadType = pick(f, ['lead_type', 'leadtype', 'type', 'campaign', 'campaign_name', 'product', 'vertical', 'lead_category', 'category', 'list', 'list_name', 'source_campaign']);
  const leadSource = pick(f, ['source', 'lead_source', 'vendor', 'provider']) || 'GOAT Leads';
  const vendorLeadId = pick(f, ['lead_id', 'leadid', 'id', 'record_id', 'external_id', 'uuid']);
  const notes = pick(f, ['notes', 'note', 'comments', 'message', 'details']);
  const phone = toE164(phoneRaw);
  const leadQuality = pick(f, ['lead_quality', 'quality']);
  const agedBucket = pick(f, ['aged_bucket', 'bucket']).toUpperCase();
  const trustedForm = pick(f, ['trusted_form_url', 'trustedform', 'trusted_form', 'trustedform_cert_url', 'xxTrustedFormCertUrl']);
  const stateCode = pick(f, ['rr_state', 'state_code', 'st']);
  const isFresh = !agedBucket || agedBucket === 'FRESH';
  // Type-specific details for the GHL note (only non-empty ones)
  const DETAIL_KEYS = ['Age','Gender','Marital Status','Military Status','Branch of Service','Has Life Insurance','Needed Coverage','Beneficiary','Beneficiary Name',
    'Best Time Of Day To Contact You','Driver Type','Current Retirement Plan','Desired Montly Contribution','Retirement Age','Employment Status','Mortgage Balance','Mortgage Payment',
    'IUL Goal','History of cancer, heart attack, diabetes or stroke','Favorite Hobby','Current Plan','Number of Dependents','Current Payment','Spouse Coinsured','Language','Lead Quality','Aged Bucket','Date/Time'];
  const details: string[] = [];
  for (const k of DETAIL_KEYS) { const v = (f as any)[k]; if (v !== null && v !== undefined && String(v).trim() !== '' && String(v) !== 'N/A') details.push(`${k}: ${v}`); }

  const rec: any = {
    first_name: properCase(first), last_name: properCase(last), phone, phone_raw: phoneRaw, email, state, city, zip, address, dob,
    lead_type: leadType, lead_source: leadSource, vendor_lead_id: vendorLeadId,
    notes: [notes, trustedForm ? `TrustedForm: ${trustedForm}` : '', ...details].filter(Boolean).join(' | '),
    raw_payload: payload, content_type: contentType, received_date: now.toISOString(),
    stage: 'received', status: 'logged_only', sms_sent: false, owner_alert_sent: false, call_count: 0,
  };

  // Duplicate check (same phone in last 24h)
  let duplicate = false;
  if (phone) {
    try {
      const recent: any[] = await (base44 as any).asServiceRole.entities.GoatLead.filter({ phone }, '-created_date', 5);
      duplicate = recent.some(r => r.status === 'processed' && (now.getTime() - new Date(r.received_date).getTime()) < 24 * 3600 * 1000);
    } catch (_) {}
  }

  const result: any = { received: true, processing_enabled: PROCESSING_ENABLED, parsed: { first: rec.first_name, last: rec.last_name, phone, email, state, zip, lead_type: leadType } };

  if (!PROCESSING_ENABLED || !PIPELINE_ID) {
    const saved = await (base44 as any).asServiceRole.entities.GoatLead.create(rec);
    return Response.json({ ...result, logged_id: saved.id, note: 'Logged only. Processing not yet enabled.' });
  }

  if (duplicate) {
    rec.status = 'duplicate';
    const saved = await (base44 as any).asServiceRole.entities.GoatLead.create(rec);
    return Response.json({ ...result, duplicate: true, logged_id: saved.id });
  }

  if (!phone) {
    rec.status = 'error'; rec.error = 'No valid phone number in payload';
    const saved = await (base44 as any).asServiceRole.entities.GoatLead.create(rec);
    return Response.json({ ...result, error: rec.error, logged_id: saved.id }, { status: 200 });
  }

  try {
    // 1. Upsert GHL contact
    const tags = ['GOAT Lead', isFresh ? 'Fresh Lead' : 'Aged Lead'];
    if (leadType) tags.push(`GOAT: ${leadType.replace(/ Lead$/i, '')}`);
    if (leadQuality) tags.push(`GOAT Quality: ${leadQuality}`);
    const upsertBody: any = {
      locationId: LOC, firstName: rec.first_name, lastName: rec.last_name, phone, source: 'GOAT Leads',
    };
    if (email) upsertBody.email = email;
    if (stateCode || state) upsertBody.state = stateCode || state;
    if (city) upsertBody.city = city;
    if (zip) upsertBody.postalCode = zip;
    if (address) upsertBody.address1 = address;
    if (dob) upsertBody.dateOfBirth = dob;
    const up = await ghl('/contacts/upsert', { method: 'POST', body: JSON.stringify(upsertBody) });
    if (!up.ok) throw new Error(`GHL upsert ${up.status}: ${JSON.stringify(up.json).slice(0, 200)}`);
    const contactId = up.json.contact?.id;
    rec.ghl_contact_id = contactId; rec.ghl_contact_new = !!up.json.new;
    // Add tags without wiping existing ones
    try { await ghl(`/contacts/${contactId}/tags`, { method: 'POST', body: JSON.stringify({ tags }) }); } catch (_) {}

    // 2. Opportunity (skip if an open one exists in this pipeline)
    const existing = await ghl(`/opportunities/search?location_id=${LOC}&contact_id=${contactId}&pipeline_id=${PIPELINE_ID}&status=open&limit=5`);
    const openOpp = (existing.json.opportunities || [])[0];
    if (openOpp) {
      rec.ghl_opportunity_id = openOpp.id;
    } else {
      const opp = await ghl('/opportunities/', {
        method: 'POST',
        body: JSON.stringify({
          pipelineId: PIPELINE_ID, locationId: LOC, contactId, status: 'open',
          pipelineStageId: NEW_LEAD_STAGE_ID,
          name: `${rec.first_name} ${rec.last_name}`.trim() || phone,
          source: 'GOAT Leads',
        }),
      });
      if (!opp.ok) throw new Error(`GHL opportunity ${opp.status}: ${JSON.stringify(opp.json).slice(0, 200)}`);
      rec.ghl_opportunity_id = opp.json.opportunity?.id;
    }
    rec.pipeline_id = PIPELINE_ID; rec.stage = 'new_lead';

    // 3. Note on contact
    try {
      const noteLines = [
        `GOAT ${isFresh ? 'FRESH' : 'AGED'} lead received ${now.toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT`,
        `Type: ${leadType || 'n/a'} | Quality: ${leadQuality || 'n/a'} | GOAT ID: ${vendorLeadId || 'n/a'}`,
        `State: ${state || 'n/a'} | DOB: ${dob || 'n/a'} | Email: ${email || 'n/a'}`,
        ...details.map(d => `- ${d}`),
        notes ? `Notes: ${notes}` : '',
        trustedForm ? `TrustedForm consent cert: ${trustedForm}` : '',
      ].filter(Boolean);
      await ghl(`/contacts/${contactId}/notes`, { method: 'POST', body: JSON.stringify({ body: noteLines.join('\n') }) });
    } catch (_) {}

    // 4. Opener text (T1) to FRESH leads, respecting 8am-8:30pm local send window
    const tz = tzForState(stateToCode(stateCode) || stateToCode(state));
    rec.timezone = tz;
    let queuedForMorning = false;
    if (isFresh) {
      if (inSendWindow(now, tz)) {
        const sms = await ghl('/conversations/messages', { method: 'POST', body: JSON.stringify({ type: 'SMS', contactId, message: confirmationSms(rec.first_name) }) });
        if (sms.ok) {
          rec.sms_sent = true; rec.sms_message_id = sms.json.messageId || '';
          rec.seq_step = 1; rec.seq_status = 'active'; rec.last_sms_at = now.toISOString();
          rec.seq_next_at = new Date(now.getTime() + 15 * 60000).toISOString();
          rec.seq_log = [`${now.toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT T1 sent on arrival`];
        } else {
          rec.sms_error = `${sms.status} ${JSON.stringify(sms.json).slice(0, 200)}`;
          rec.seq_step = 0; rec.seq_status = 'active'; rec.seq_next_at = new Date(now.getTime() + 10 * 60000).toISOString();
          rec.seq_log = [`${now.toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT T1 failed on arrival, retry queued: ${rec.sms_error}`];
        }
      } else {
        queuedForMorning = true;
        const at = nextMorning(now, tz);
        rec.sms_error = 'queued: outside send window';
        rec.seq_step = 0; rec.seq_status = 'active'; rec.seq_next_at = at.toISOString();
        rec.seq_log = [`${now.toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT arrived outside 8am-8:30pm ${tz}; T1 queued for ${at.toLocaleString('en-US', { timeZone: tz })}`];
      }
    } else {
      rec.sms_error = 'skipped: aged lead';
    }

    // 5. Alert Aidan
    try {
      const alert = await ghl('/conversations/messages', { method: 'POST', body: JSON.stringify({ type: 'SMS', contactId: AIDAN_CONTACT_ID, message: `New GOAT lead: ${rec.first_name} ${rec.last_name} | ${phone} | ${state || '?'} | ${leadType || 'n/a'}${rec.sms_sent ? ' | opener text sent' : (queuedForMorning ? ' | text queued for 8:30am their time' : (isFresh ? ' | TEXT FAILED, will retry' : ' | aged, no text'))}` }) });
      rec.owner_alert_sent = alert.ok;
    } catch (_) {}

    rec.status = 'processed';
    const saved = await (base44 as any).asServiceRole.entities.GoatLead.create(rec);
    return Response.json({ ...result, processed: true, logged_id: saved.id, ghl_contact_id: contactId, ghl_opportunity_id: rec.ghl_opportunity_id, sms_sent: rec.sms_sent, sms_error: rec.sms_error });
  } catch (e) {
    rec.status = 'error'; rec.error = String(e).slice(0, 500);
    const saved = await (base44 as any).asServiceRole.entities.GoatLead.create(rec);
    return Response.json({ ...result, error: rec.error, logged_id: saved.id }, { status: 200 });
  }
});
