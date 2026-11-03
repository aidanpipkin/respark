// Fresh premium trucker lead webhook (vendor -> GHL -> Respark, instant first text).
// Paste into the vendor's "GHL Webhook URL" box (leave their GHL API Key / Location ID blank so this function owns the whole flow):
//   https://vesper-4e3ffdf5.base44.app/functions/rileyPremiumTruckerWebhook?token=rLy7Qn3VtKx9ZbW2eHs8MdPc4Fj6AgUo
// Vendor: Closrleads (payload {order, lead:{first_name,last_name,phone,state,dob,email,timezone}, buyer, items, is_test}). Also accepts GOAT-style or generic keys.
// Test leads (is_test=true) are logged + confirmed to Riley by text, never pushed to GHL. On each real lead: parses the payload, upserts the GHL contact (E.164 phone, proper-case names,
// state, email, DOB, trucker custom fields), opens an opportunity in "Riley Fresh Premium Truckers" > New Lead, writes a note,
// enrolls the lead in Respark as a FRESH lead (different first text: "the request you just put in"), fires the first text right away
// when inside the 9am-7:30pm local Mon-Sat window (otherwise it queues for the next morning), logs to GoatLead, and texts Riley.
// Idempotent: same phone again reuses the contact/opportunity and never double-enrolls. GET ?token=...&ping=1 returns ok.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
// Shared constants + helpers for the Respark campaign (copied into each function at deploy time).
const GHL_API_KEY = Deno.env.get('RILEY_GHL_API_KEY') || '';
const LOC = 'ORVsDMoAeYZQlMKJNMip';
const RILEY_CONTACT_ID = 'UoNX3lf0OSK3LKvenVcI';
const RILEY_EMAIL = 'riley@usnaturalinsurance.com';
const RILEY_TZ = 'America/Chicago';

// Pipelines in scope for RILEY (Respark SMS sequence). Only these two clean pipelines are ever texted; his older dated pipelines are untouched.
const PIPES: Record<string, { name: string; newLead: string[]; appointment: string; notInterested: string }> = {
  kq9QT4chftvYo3oth31j: { name: 'Riley Fresh Premium Truckers', newLead: ['42e8daa3-20b8-462b-a056-061bb64d9736'], appointment: '7ed2035f-52ca-4d69-aa08-743de77170bb', notInterested: '2f80707d-e769-451b-930c-7bb5adc4f5bd' },
  lJoFbIxhnuo4iPT8q9Xa: { name: 'Riley Fresh Leads', newLead: ['857de8c2-4d9a-4b70-ae93-996967f8450a'], appointment: '6c2efe60-a4c5-4b96-8459-687d326e0843', notInterested: 'ce4b2ed3-04e1-4c7a-9987-932d231dd490' },
};

// Custom field ids (Riley's location ORVsDMoAeYZQlMKJNMip)
const CF = { driver_type: 'MlnuvS9vILJYJ85um3Va', age: 'nQto7zmJrOV0z1bLvqRU', marital: 'WGK3nqWxThx9789pX2PE', beneficiary_rel: '6kPBtd6j5nPyHo9ubqpW' };

const STATE_TZ: Record<string, string> = {
  alabama: 'America/Chicago', alaska: 'America/Anchorage', arizona: 'America/Phoenix', arkansas: 'America/Chicago', california: 'America/Los_Angeles',
  colorado: 'America/Denver', connecticut: 'America/New_York', delaware: 'America/New_York', florida: 'America/New_York', georgia: 'America/New_York',
  hawaii: 'Pacific/Honolulu', idaho: 'America/Boise', illinois: 'America/Chicago', indiana: 'America/Indiana/Indianapolis', iowa: 'America/Chicago',
  kansas: 'America/Chicago', kentucky: 'America/New_York', louisiana: 'America/Chicago', maine: 'America/New_York', maryland: 'America/New_York',
  massachusetts: 'America/New_York', michigan: 'America/Detroit', minnesota: 'America/Chicago', mississippi: 'America/Chicago', missouri: 'America/Chicago',
  montana: 'America/Denver', nebraska: 'America/Chicago', nevada: 'America/Los_Angeles', 'new hampshire': 'America/New_York', 'new jersey': 'America/New_York',
  'new mexico': 'America/Denver', 'new york': 'America/New_York', 'north carolina': 'America/New_York', 'north dakota': 'America/Chicago', ohio: 'America/New_York',
  oklahoma: 'America/Chicago', oregon: 'America/Los_Angeles', pennsylvania: 'America/New_York', 'rhode island': 'America/New_York', 'south carolina': 'America/New_York',
  'south dakota': 'America/Chicago', tennessee: 'America/Chicago', texas: 'America/Chicago', utah: 'America/Denver', vermont: 'America/New_York',
  virginia: 'America/New_York', washington: 'America/Los_Angeles', 'west virginia': 'America/New_York', wisconsin: 'America/Chicago', wyoming: 'America/Denver',
};
const STATE_ABBR: Record<string, string> = { al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california', co: 'colorado', ct: 'connecticut', de: 'delaware', fl: 'florida', ga: 'georgia', hi: 'hawaii', id: 'idaho', il: 'illinois', in: 'indiana', ia: 'iowa', ks: 'kansas', ky: 'kentucky', la: 'louisiana', me: 'maine', md: 'maryland', ma: 'massachusetts', mi: 'michigan', mn: 'minnesota', ms: 'mississippi', mo: 'missouri', mt: 'montana', ne: 'nebraska', nv: 'nevada', nh: 'new hampshire', nj: 'new jersey', nm: 'new mexico', ny: 'new york', nc: 'north carolina', nd: 'north dakota', oh: 'ohio', ok: 'oklahoma', or: 'oregon', pa: 'pennsylvania', ri: 'rhode island', sc: 'south carolina', sd: 'south dakota', tn: 'tennessee', tx: 'texas', ut: 'utah', vt: 'vermont', va: 'virginia', wa: 'washington', wv: 'west virginia', wi: 'wisconsin', wy: 'wyoming' };
function tzForState(state: string | null | undefined): string {
  const k = (state || '').trim().toLowerCase().replace(/\.$/, '');
  return STATE_TZ[STATE_ABBR[k] || k] || RILEY_TZ;
}
// States that require upfront AI disclosure in sales conversations
const AI_DISCLOSE_STATES = ['california', 'ca', 'utah', 'ut', 'colorado', 'co'];

const H = { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28', 'Accept': 'application/json', 'Content-Type': 'application/json' };
async function ghl(path: string, init: RequestInit = {}, version = '2021-07-28') {
  const r = await fetch(`https://services.leadconnectorhq.com${path}`, { ...init, headers: { ...H, Version: version, ...(init.headers || {}) } });
  const text = await r.text();
  let json: any = {};
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { ok: r.ok, status: r.status, json };
}
async function sendSms(contactId: string, message: string) {
  const r = await ghl('/conversations/messages', { method: 'POST', body: JSON.stringify({ type: 'SMS', contactId, message }) });
  return { ok: r.ok, id: r.json.messageId || '', err: r.ok ? '' : `${r.status} ${JSON.stringify(r.json).slice(0, 160)}` };
}
async function alertRiley(message: string) {
  try { await sendSms(RILEY_CONTACT_ID, message.slice(0, 1500)); } catch (_) {}
}
async function addTags(contactId: string, tags: string[]) {
  try { await ghl(`/contacts/${contactId}/tags`, { method: 'POST', body: JSON.stringify({ tags }) }); } catch (_) {}
}
async function removeTags(contactId: string, tags: string[]) {
  try { await ghl(`/contacts/${contactId}/tags`, { method: 'DELETE', body: JSON.stringify({ tags }) }); } catch (_) {}
}

// ---- time helpers ----
function localParts(d: Date, tz: string) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d);
  const g = (t: string) => p.find(x => x.type === t)!.value;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday'));
  return { y: +g('year'), mo: +g('month'), d: +g('day'), h: +g('hour') % 24, mi: +g('minute'), wd };
}
function localToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  let guess = new Date(Date.UTC(y, mo - 1, d, h, mi));
  for (let i = 0; i < 2; i++) {
    const lp = localParts(guess, tz);
    const asUtc = Date.UTC(lp.y, lp.mo - 1, lp.d, lp.h, lp.mi);
    guess = new Date(Date.UTC(y, mo - 1, d, h, mi) - (asUtc - guess.getTime()));
  }
  return guess;
}
// Compliance window for OUTBOUND campaign texts (Aidan, Nov 2 2026): 9:00am-9:00pm recipient local time, Monday-Saturday (TCPA federal window),
// with an 8:00pm cap in states whose own law stops at 8pm (FL, OK, WA, MD). TX 9am start and AL/LA/MS/TX Sunday rules still apply.
const SEND_START_MIN = 9 * 60, SEND_END_MIN = 21 * 60;
const STATE_END_CAP: Record<string, number> = { fl: 20 * 60, florida: 20 * 60, ok: 20 * 60, oklahoma: 20 * 60, wa: 20 * 60, washington: 20 * 60, md: 20 * 60, maryland: 20 * 60 };
function sendEndMin(state?: string | null): number { return STATE_END_CAP[(state || '').trim().toLowerCase()] ?? SEND_END_MIN; }
// Sundays: allowed 12:00pm-9:00pm local (8pm-capped states apply) (covers the Texas noon rule) EXCEPT states that prohibit Sunday solicitation outright.
const SUNDAY_BLACKOUT_STATES = ['alabama', 'al', 'louisiana', 'la', 'mississippi', 'ms', 'utah', 'ut', 'rhode island', 'ri'];
const SUNDAY_START_MIN = 12 * 60;
function sundayAllowed(state: string | null | undefined): boolean { return !SUNDAY_BLACKOUT_STATES.includes((state || '').trim().toLowerCase()); }
function inSendWindow(now: Date, tz: string, state?: string | null): boolean {
  const lp = localParts(now, tz);
  const m = lp.h * 60 + lp.mi;
  if (lp.wd === 0) return sundayAllowed(state) && m >= SUNDAY_START_MIN && m <= sendEndMin(state);
  return m >= SEND_START_MIN && m <= sendEndMin(state);
}
// Next moment texting opens for this lead, on or after `from` (9:30am Mon-Sat, 12:15pm Sunday where allowed). Used when a text is due outside the window.
function nextSendWindowStart(from: Date, tz: string, state?: string | null): Date {
  for (let d = 0; d < 8; d++) {
    const probe = new Date(from.getTime() + d * 86400000);
    const lp = localParts(probe, tz);
    if (lp.wd === 0 && !sundayAllowed(state)) continue;
    const [h, mi] = lp.wd === 0 ? [12, 15] : [9, 30];
    const t = localToUtc(lp.y, lp.mo, lp.d, h, mi, tz);
    if (t.getTime() > from.getTime()) return t;
  }
  return scheduleLocal(from, 1, 9, 30, tz);
}
// Frequency cap: at most this many SEQUENCE texts to one lead in any rolling 24 hours (one a day; the day-0 burst was too much).
const MAX_SEQ_TEXTS_PER_24H = 1;
function seqTextsLast24h(conversation: any[], now: Date): Date[] {
  return (conversation || []).filter((m: any) => m.role === 'riley_sequence' && m.at && now.getTime() - new Date(m.at).getTime() < 86400000).map((m: any) => new Date(m.at)).sort((a: Date, b: Date) => a.getTime() - b.getTime());
}
// Next instant at local h:mi on or after `from` that is not a Sunday; `dayOffset` days after `from`'s local date
function scheduleLocal(from: Date, dayOffset: number, h: number, mi: number, tz: string): Date {
  const lp = localParts(from, tz);
  let t = localToUtc(lp.y, lp.mo, lp.d, h, mi, tz);
  t = new Date(t.getTime() + dayOffset * 86400000);
  // re-anchor to exact local time after DST shifts
  const tp = localParts(t, tz); t = localToUtc(tp.y, tp.mo, tp.d, h, mi, tz);
  if (dayOffset === 0 && t.getTime() <= from.getTime()) { const np = localParts(new Date(t.getTime() + 86400000), tz); t = localToUtc(np.y, np.mo, np.d, h, mi, tz); }
  while (localParts(t, tz).wd === 0) { const np = localParts(new Date(t.getTime() + 86400000), tz); t = localToUtc(np.y, np.mo, np.d, h, mi, tz); }
  return t;
}
function fmtLocal(d: Date, tz: string, withDay = true) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: withDay ? 'short' : undefined, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(d);
}
function stamp() { return new Date().toLocaleString('en-US', { timeZone: RILEY_TZ }) + ' CT'; }

function driverGroup(driverType: string | null | undefined): 'owner_op' | 'company' | 'unknown' {
  const t = (driverType || '').toLowerCase();
  if (!t) return 'unknown';
  if (t.includes('owner') || t.includes('lease')) return 'owner_op';
  return 'company';
}

// ---- Thread scan: new inbound texts + any outbound text the bot did not send (= Riley jumped in manually) ----
const MANUAL_GRACE_MS = 5 * 60000;
function normText(s: string) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
async function scanThread(contactId: string, sinceMs: number, conversation: any[]): Promise<{ inbound: { at: number; text: string }[]; manual: { at: number; text: string }[] }> {
  const known = new Set((conversation || []).filter((m: any) => m.role !== 'lead').map((m: any) => normText(m.text)));
  const convs = (await ghl(`/conversations/search?locationId=${LOC}&contactId=${contactId}`, {}, '2021-04-15')).json.conversations || [];
  const inbound: { at: number; text: string }[] = []; const manual: { at: number; text: string }[] = [];
  for (const cv of convs) {
    if (!(Number(cv.lastMessageDate) > sinceMs)) continue;
    const ms = (await ghl(`/conversations/${cv.id}/messages?limit=40`, {}, '2021-04-15')).json;
    const list: any[] = ms.messages?.messages || ms.messages || [];
    for (const m of list) {
      const at = new Date(m.dateAdded).getTime();
      if (!(at > sinceMs) || !m.body || !String(m.messageType || m.type || '').includes('SMS')) continue;
      if (m.direction === 'inbound') inbound.push({ at, text: String(m.body).trim() });
      else if (m.direction === 'outbound' && contactId !== RILEY_CONTACT_ID && !known.has(normText(m.body)) && at < Date.now() - MANUAL_GRACE_MS) manual.push({ at, text: String(m.body).trim() }); // Riley's own contact receives bot alerts; never treat those as a manual takeover. Grace period: a text the sender/reply bot just sent may not be saved to the record yet (two runs overlapping), so only outbound texts older than a few minutes count as Riley's.
    }
  }
  inbound.sort((a, b) => a.at - b.at); manual.sort((a, b) => a.at - b.at);
  return { inbound, manual };
}
async function markManualTakeover(svc: any, L: any, log: string[], manual: { at: number; text: string }[]) {
  log.push(`${stamp()} Riley texted manually ("${manual[manual.length - 1].text.slice(0, 50)}"), bot paused`);
  await removeTags(L.ghl_contact_id, ['Respark Active']); await addTags(L.ghl_contact_id, ['Riley Took Over']);
  await svc.update(L.id, { status: 'manual', stop_reason: 'Riley took over the thread', next_send_at: null, seq_log: log });
}

// ---- Lead profile: everything we know about the lead, by human-readable name, for the reply bot and the sequence ----
// Internal/system fields are dropped so the bot never sees (or mentions) IPs, TrustedForm, A2P, pipeline bookkeeping, etc.
const PROFILE_SKIP = /ip address|trusted form|otp code|a2p|sms optin|opt-out|opt out|wavv|campaign stage|email stage|test field|opportunity|pipeline|^stage$|^status$|^sold|^won$|sold\/won|closed\/won|lost reason|contact type|contact source|date created|landline|^time zone$|u\.s\. timezone|state full name|^u\.s\. state|aloha|producer license|dot number|mc number|secondary phone|^ad$|lead source|lead value|business name|disposition status/i;
async function cfNameMap(): Promise<Record<string, string>> {
  const r = await ghl(`/locations/${LOC}/customFields`);
  const m: Record<string, string> = {};
  for (const f of (r.json.customFields || [])) m[f.id] = String(f.name || '').trim();
  return m;
}
function ageFromDob(dob: string): string {
  const d = new Date(dob); if (isNaN(d.getTime())) return '';
  const now = new Date(); let a = now.getUTCFullYear() - d.getUTCFullYear();
  if (now.getUTCMonth() < d.getUTCMonth() || (now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() < d.getUTCDate())) a--;
  return a > 0 && a < 110 ? String(a) : '';
}
async function buildProfile(base44: any, c: any, cfNames: Record<string, string>) {
  const fields: Record<string, string> = {};
  const push = (k: string, v: any) => {
    if (v === null || v === undefined) return;
    const s = (Array.isArray(v) ? v.join(', ') : String(v)).replace(/\s+/g, ' ').trim();
    if (!s || /^(null|n\/a|none|undefined)$/i.test(s)) return;
    if (!fields[k]) fields[k] = s.slice(0, 200);
  };
  let lead_status = '', ad = '';
  for (const f of (c.customFields || [])) {
    const n = cfNames[f.id] || ''; if (!n) continue;
    if (/^status$/i.test(n)) { lead_status = String(f.value || ''); continue; }
    if (/^ad$/i.test(n)) { ad = String(f.value || ''); continue; }
    if (PROFILE_SKIP.test(n)) continue;
    push(n, f.value);
  }
  if (c.city) push('City', c.city);
  if (c.postalCode) push('Zip', c.postalCode);
  let dob = '';
  if (c.dateOfBirth) { dob = String(c.dateOfBirth).slice(0, 10); const a = ageFromDob(c.dateOfBirth); if (a) fields['Age'] = a; }
  // GOAT form payload (if this lead came through the webhook)
  try {
    const g = await base44.asServiceRole.entities.GoatLead.filter({ ghl_contact_id: c.id }, '-created_date', 1);
    const rp = g?.[0]?.raw_payload || {};
    const SKIP_G = /^(id|phone|email|name|first name|last name|state|rr state|ip address|trusted form url|otp code|vendor|cost per lead|lead order id|purchase date|desc|platform|campaign|search term|lead status|language|aged bucket|lead quality|date\/time|ad|dob)$/i;
    for (const [k, v] of Object.entries(rp)) { if (SKIP_G.test(k)) continue; push(k, v); }
    if (rp['Date/Time']) fields['Request submitted'] = String(rp['Date/Time']);
    if (!dob && rp['DOB']) dob = String(rp['DOB']);
  } catch (_) {}
  // Notes on the contact (URLs stripped)
  try {
    const n = (await ghl(`/contacts/${c.id}/notes`)).json.notes || [];
    let calls = 0, voicemails = 0; const bodies: string[] = [];
    for (const x of n) {
      const raw = String(x.body || '');
      if (/^\s*\[\s*WAVV/i.test(raw)) { calls++; if (/voicemail|voice message/i.test(raw)) voicemails++; continue; }
      const b = raw.replace(/https?:\/\/\S+/g, '').replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '').replace(/TrustedForm consent cert:?|TrustedForm:?|GOAT ID:\s*\d+|Quality:\s*\w+|Lead Quality:\s*\w+|Aged Bucket:\s*\w+|\|\s*\|/gi, '').replace(/\s+/g, ' ').trim();
      if (b.length > 3) bodies.push(b);
    }
    if (bodies.length) fields['Notes on file'] = bodies.slice(0, 3).join(' || ').slice(0, 500);
    if (calls) fields['Riley call attempts logged'] = `${calls}${voicemails ? ` (${voicemails} went to voicemail)` : ''}`;
  } catch (_) {}
  if (!fields['Request submitted'] && c.dateAdded) fields['Request submitted'] = new Date(c.dateAdded).toLocaleDateString('en-US', { timeZone: RILEY_TZ, month: 'short', day: 'numeric', year: 'numeric' });
  const goal = fields['IUL Goal'] || fields['What are your Goals for the IUL?'] || '';
  const bene = fields['Beneficiary Relationship'] || fields['Beneficiary'] || fields['Beneficiary Name'] || '';
  return { fields, lead_status, ad, dob, requested_at: c.dateAdded || '', city: c.city || '', gender: fields['Gender'] || '', iul_goal: goal, beneficiary: bene, age: fields['Age'] || '', marital: fields['Marital Status'] || '', driver_type: fields['Driver Type'] || '' };
}
// Fields the bot should treat as "already talked to Riley"
function talkedBefore(lead_status: string): boolean { return /pitch|follow|nurture|contacted|appointment|callback/i.test(lead_status || ''); }
// Beneficiary phrasing for the sequence: a relationship word -> "your wife and kids" etc., a real name -> the name, else "your family"
function familyPhrase(beneficiary: string, marital: string): string {
  const b = (beneficiary || '').trim();
  if (/^(me|self|myself|n\/a|none|estate)$/i.test(b) || !b) return /married/i.test(marital || '') ? 'your wife and kids' : 'your family';
  // A real first name anywhere in the field wins ("Katy", "Katy Smith", "my wife Katy", "KATY (spouse)")
  const REL = /^(my|the|spouse|wife|husband|partner|significant|other|fiancee?|girlfriend|boyfriend|kid|kids|child|children|son|daughter|mom|mother|dad|father|parent|parents|brother|sister|sibling|grand\w*|family|and|&|beneficiary|relationship|primary|contingent)$/i;
  const words = b.replace(/[()\[\],.;:/-]/g, ' ').split(/\s+/).filter(Boolean);
  const name = words.find(w => /^[A-Za-z][A-Za-z'-]{1,}$/.test(w) && !REL.test(w));
  if (name) return name[0].toUpperCase() + name.slice(1).toLowerCase();
  if (/spouse|wife|husband|partner|significant|fianc/i.test(b)) return 'your spouse and the family';
  if (/kid|child|son|daughter/i.test(b)) return 'your kids';
  if (/mom|mother|dad|father|parent|brother|sister|sibling|grand/i.test(b)) return 'your family';
  return 'your family';
}


const WEBHOOK_TOKEN = 'rLy7Qn3VtKx9ZbW2eHs8MdPc4Fj6AgUo';
const PIPELINE_ID = 'kq9QT4chftvYo3oth31j';                       // Riley Fresh Premium Truckers
const NEW_LEAD_STAGE_ID = '42e8daa3-20b8-462b-a056-061bb64d9736'; // New Lead
const SELF_URL = 'https://vesper-4e3ffdf5.base44.app/functions/rileySend';
const CF_STATE_FULL = 'EN8XwsxErZ5KDoCw9DZt';

function pick(obj: any, keys: string[]): string {
  if (!obj || typeof obj !== 'object') return '';
  const lower: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) lower[k.toLowerCase().replace(/[\s_\-\.]/g, '')] = v;
  for (const k of keys) { const v = lower[k.toLowerCase().replace(/[\s_\-\.]/g, '')]; if (v !== undefined && v !== null && String(v).trim() !== '' && String(v).trim().toLowerCase() !== 'n/a') return String(v).trim(); }
  return '';
}
const NEST_KEYS = ['lead', 'data', 'contact', 'customer', 'fields', 'payload', 'record', 'customData', 'custom_data', 'custom_fields', 'answers', 'questions', 'form', 'form_data', 'details', 'meta', 'attributes', 'extra'];
function flatten(payload: any): any {
  // Merge known nesting containers (two levels deep) so pick() sees everything, and turn [{label,value}] style arrays into fields.
  const out: any = {};
  const merge = (obj: any, depth: number) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v)) { for (const it of v) { if (it && typeof it === 'object' && !Array.isArray(it)) { const lab = it.label ?? it.name ?? it.question ?? it.key ?? it.field; const val = it.value ?? it.answer ?? it.val; if (lab !== undefined && val !== undefined && val !== null && String(val).trim() !== '') out[String(lab)] = val; } } continue; }
      if (v && typeof v === 'object') { if (depth < 2 && NEST_KEYS.includes(k)) merge(v, depth + 1); continue; }
      if (out[k] === undefined || out[k] === '' || out[k] === null) out[k] = v;
    }
  };
  merge(payload, 0);
  if (payload?.order?.campaign && out.campaign === undefined) out.campaign = payload.order.campaign;
  if (payload?.order?.number && out.order_number === undefined) out.order_number = payload.order.number;
  return out;
}
// NANP sanity: real area code + exchange (no 0/1 leading digits, no 555 exchange, not a repeated/sequential dummy)
function plausibleUsPhone(e164: string): boolean {
  const d = e164.replace(/^\+1/, ''); if (d.length !== 10) return false;
  if (!/^[2-9]/.test(d) || !/^[2-9]/.test(d.slice(3)) || d.slice(3, 6) === '555' || d.slice(0, 3) === '555') return false;
  if (/^(\d)\1{9}$/.test(d) || /0123456789|1234567890|9876543210/.test(d)) return false;
  return true;
}
function toE164(raw: string): string {
  const d = (raw || '').replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return '';
}
function properCase(s: string): string { return (s || '').trim().toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_m, p, c) => p + c.toUpperCase()); }
const STATE_NAMES: Record<string, string> = Object.fromEntries(Object.entries(STATE_ABBR).map(([a, n]) => [a, n.replace(/\b\w/g, c => c.toUpperCase())]));
function stateFull(s: string): string { const k = (s || '').trim().toLowerCase(); return STATE_NAMES[k] || properCase(s); }

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const base44 = createClientFromRequest(req);
  const now = new Date();
  // ---- parse body (JSON, form, or query string) ----
  let payload: any = {}; const contentType = req.headers.get('content-type') || '';
  try {
    const text = await req.text();
    if (text) { if (contentType.includes('json')) payload = JSON.parse(text); else if (contentType.includes('form')) payload = Object.fromEntries(new URLSearchParams(text)); else { try { payload = JSON.parse(text); } catch { payload = Object.fromEntries(new URLSearchParams(text)); } } }
  } catch (e) { payload = { parse_error: String(e) }; }
  if ((url.searchParams.get('token') || payload.token) !== WEBHOOK_TOKEN) return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (url.searchParams.get('ping') || payload.ping) return Response.json({ ok: true, pipeline: 'Riley Fresh Premium Truckers', now: stamp() });
  delete payload.token; delete payload.ping;
  for (const [k, v] of url.searchParams.entries()) if (!['token', 'ping', 'dry_run'].includes(k) && payload[k] === undefined) payload[k] = v;
  const dryRun = url.searchParams.get('dry_run') === '1' || payload.dry_run === true; delete payload.dry_run;
  const f = flatten(payload);
  // Vendor connectivity check (empty body) -> just say ok, nothing to log or alert
  if (!Object.keys(f).length) return Response.json({ ok: true, note: 'empty payload, nothing to process' });
  const isTest = payload.is_test === true || String(payload.is_test).toLowerCase() === 'true' || /^test$/i.test(String(payload?.order?.campaign || '')) || /test/i.test(String(payload?.lead?.email || '')) && /closrtech|closrleads/i.test(String(payload?.lead?.email || ''));
  const vendorName = String(payload?.tenant?.site_title || payload?.vendor_name || (Array.isArray(payload?.vendor) ? '' : payload?.vendor) || '').trim() || 'Closrleads';
  let first = pick(f, ['first_name', 'firstname', 'first', 'fname', 'given_name']);
  let last = pick(f, ['last_name', 'lastname', 'last', 'lname', 'surname']);
  const fullName = pick(f, ['name', 'full_name', 'fullname', 'contact_name', 'lead_name']);
  if (!first && fullName) { const parts = fullName.split(/\s+/); first = parts[0]; last = last || parts.slice(1).join(' '); }
  const phoneRaw = pick(f, ['phone', 'phone_number', 'phonenumber', 'mobile', 'cell', 'cell_phone', 'mobile_phone', 'primary_phone', 'telephone']);
  const phone = toE164(phoneRaw);
  const email = pick(f, ['email', 'email_address', 'emailaddress']).toLowerCase();
  const stateRaw = pick(f, ['rr_state', 'state', 'st', 'state_code', 'region']);
  const state = stateFull(stateRaw);
  const city = properCase(pick(f, ['city', 'town']));
  const zip = pick(f, ['zip', 'zipcode', 'zip_code', 'postal_code', 'postalcode']);
  const dob = pick(f, ['dob', 'date_of_birth', 'birthdate', 'birth_date']);
  const driverType = pick(f, ['driver_type', 'drivertype', 'driver', 'cdl_type']);
  const age = pick(f, ['age']);
  const marital = pick(f, ['marital_status', 'marital']);
  const beneficiary = pick(f, ['beneficiary', 'beneficiary_name', 'beneficiary_relationship']);
  const goal = pick(f, ['iul_goal', 'goal', 'what_are_your_goals_for_the_iul', 'goals']);
  const gender = pick(f, ['gender', 'sex']);
  const leadType = pick(f, ['lead_type', 'leadtype', 'type', 'campaign', 'product', 'vertical']) || 'Trucker IUL';
  const tzFromVendor = pick(f, ['timezone', 'time_zone', 'tz']);
  const leadQuality = pick(f, ['lead_quality', 'quality']);
  const vendorLeadId = pick(f, ['lead_id', 'leadid', 'id', 'record_id', 'external_id']);
  const trustedForm = pick(f, ['trusted_form_url', 'trustedform', 'trusted_form', 'xxTrustedFormCertUrl']);
  const vendor = vendorName;
  const orderNumber = pick(f, ['order_number']);
  const bestTime = pick(f, ['best_time_of_day_to_contact_you', 'best_time']);
  const details: string[] = [];
  for (const k of ['Driver Type', 'Age', 'Gender', 'Marital Status', 'Beneficiary', 'Beneficiary Name', 'IUL Goal', 'Has Life Insurance', 'Needed Coverage', 'Employment Status', 'Best Time Of Day To Contact You', 'History of cancer, heart attack, diabetes or stroke', 'Lead Quality', 'Date/Time']) {
    const v = (f as any)[k]; if (v !== null && v !== undefined && String(v).trim() !== '' && String(v) !== 'N/A') details.push(`${k}: ${v}`);
  }
  const rec: any = { first_name: properCase(first), last_name: properCase(last), phone, phone_raw: phoneRaw, email, state, city, zip, dob,
    lead_type: leadType, lead_source: 'Riley Premium Trucker Webhook', vendor_lead_id: vendorLeadId, notes: [trustedForm ? `TrustedForm: ${trustedForm}` : '', ...details].filter(Boolean).join(' | '),
    raw_payload: payload, content_type: contentType, received_date: now.toISOString(), stage: 'received', status: 'logged_only', sms_sent: false, owner_alert_sent: false, call_count: 0, pipeline_id: PIPELINE_ID };
  const parsed = { first: rec.first_name, last: rec.last_name, phone, email, state, city, driver_type: driverType, age, marital, beneficiary, goal };
  if (dryRun) return Response.json({ received: true, dry_run: true, is_test: isTest, parsed, keys_seen: Object.keys(f) });
  const GL = (base44 as any).asServiceRole.entities.GoatLead;
  if (isTest) {
    rec.status = 'test'; rec.notes = `Vendor test lead (${vendor}${orderNumber ? ' ' + orderNumber : ''}); not sent to GHL or Respark.`;
    const saved = await GL.create(rec);
    try { await alertRiley(`${vendor} sent a TEST lead to the premium trucker webhook and it parsed fine (${rec.first_name} ${rec.last_name}, ${phone || phoneRaw}, ${state}). Nothing was created in GHL. Real leads will flow automatically.`); } catch (_) {}
    return Response.json({ received: true, test: true, parsed, logged_id: saved.id });
  }
  if (!phone || !rec.first_name || !plausibleUsPhone(phone)) {
    rec.status = 'error'; rec.error = !phone ? 'No valid 10-digit US phone in payload' : !rec.first_name ? 'No first name in payload' : `Phone ${phone} is not a plausible US number`;
    const saved = await GL.create(rec);
    try { await alertRiley(`Premium trucker lead came in but could not be processed (${rec.error}). Logged id ${saved.id}. Keys: ${Object.keys(f).slice(0, 12).join(', ')}`); } catch (_) {}
    return Response.json({ received: true, error: rec.error, parsed, logged_id: saved.id });
  }
  const out: any = { received: true, parsed };
  try {
    // 1. Contact upsert (by phone) + trucker custom fields + tags
    const customFields: any[] = [];
    if (driverType) customFields.push({ id: CF.driver_type, value: driverType });
    if (age) customFields.push({ id: CF.age, value: age });
    if (marital) customFields.push({ id: CF.marital, value: marital });
    if (beneficiary) customFields.push({ id: CF.beneficiary_rel, value: beneficiary });
    if (state) customFields.push({ id: CF_STATE_FULL, value: state });
    const upsertBody: any = { locationId: LOC, firstName: rec.first_name, lastName: rec.last_name, phone, source: vendor, tags: ['Premium Trucker', 'Fresh Lead', 'Respark Active'] };
    if (email) upsertBody.email = email; if (state) upsertBody.state = state; if (city) upsertBody.city = city; if (zip) upsertBody.postalCode = zip; if (dob) upsertBody.dateOfBirth = dob; if (customFields.length) upsertBody.customFields = customFields;
    const up = await ghl('/contacts/upsert', { method: 'POST', body: JSON.stringify(upsertBody) });
    if (!up.ok) throw new Error(`GHL upsert ${up.status}: ${JSON.stringify(up.json).slice(0, 200)}`);
    const contactId: string = up.json.contact?.id; rec.ghl_contact_id = contactId; rec.ghl_contact_new = !!up.json.new; out.contact_id = contactId; out.contact_new = rec.ghl_contact_new;
    await addTags(contactId, ['Premium Trucker', 'Fresh Lead', 'Respark Active']);
    // 2. Opportunity in Riley Fresh Premium Truckers > New Lead (reuse an open one)
    const ex = await ghl(`/opportunities/search?location_id=${LOC}&contact_id=${contactId}&pipeline_id=${PIPELINE_ID}&status=open&limit=5`);
    let opp = (ex.json.opportunities || [])[0];
    if (!opp) {
      const cr = await ghl('/opportunities/', { method: 'POST', body: JSON.stringify({ pipelineId: PIPELINE_ID, locationId: LOC, contactId, status: 'open', pipelineStageId: NEW_LEAD_STAGE_ID, name: `${rec.first_name} ${rec.last_name}`.trim(), source: vendor }) });
      if (!cr.ok) throw new Error(`GHL opportunity ${cr.status}: ${JSON.stringify(cr.json).slice(0, 200)}`);
      opp = cr.json.opportunity;
    }
    rec.ghl_opportunity_id = opp.id; rec.stage = 'new_lead'; out.opportunity_id = opp.id;
    // 3. Note
    try { await ghl(`/contacts/${contactId}/notes`, { method: 'POST', body: JSON.stringify({ body: [`PREMIUM TRUCKER FRESH lead received ${stamp()}`, `Vendor: ${vendor}${orderNumber ? ' order ' + orderNumber : ''} | Type: ${leadType} | Quality: ${leadQuality || 'n/a'} | Vendor ID: ${vendorLeadId || 'n/a'}`, `State: ${state || 'n/a'} | DOB: ${dob || 'n/a'} | Email: ${email || 'n/a'}`, ...details.map(d => `- ${d}`), trustedForm ? `TrustedForm consent cert: ${trustedForm}` : '', 'Respark: enrolled as FRESH lead, first text fires immediately (inside 9am-7:30pm local).'].filter(Boolean).join('\n') }) }); } catch (_) {}
    // 4. Respark enrollment (fresh variant, instant first text)
    const svc = (base44 as any).asServiceRole.entities.RileyResparkLead;
    const already: any[] = await svc.filter({ ghl_contact_id: contactId }, '-created_date', 1);
    let tz = tzForState(state);
    if (tzFromVendor) { try { new Intl.DateTimeFormat('en-US', { timeZone: tzFromVendor }); tz = tzFromVendor; } catch (_) {} }
    rec.timezone = tz;
    // next_send_at = now; the sender owns the texting-hours policy and will defer to the next window itself if needed
    const firstSend = now;
    if (already.length) { out.respark = `already enrolled (${already[0].status})`; }
    else {
      const c = (await ghl(`/contacts/${contactId}`)).json.contact || {};
      let pr: any = { fields: {}, lead_status: '', requested_at: now.toISOString(), city, gender, iul_goal: goal, dob, age, marital, beneficiary, driver_type: driverType };
      try { pr = await buildProfile(base44, c, await cfNameMap()); } catch (_) {}
      const fields = { ...(pr.fields || {}) }; for (const d of details) { const [k, ...v] = d.split(': '); if (!fields[k]) fields[k] = v.join(': '); }
      await svc.create({ ghl_contact_id: contactId, ghl_opportunity_id: opp.id, pipeline_id: PIPELINE_ID, first_name: rec.first_name, last_name: rec.last_name, phone, email, state, timezone: tz,
        driver_type: driverType || pr.driver_type || '', age: age || pr.age || '', marital_status: marital || pr.marital || '', beneficiary_relationship: beneficiary || pr.beneficiary || '', city: city || pr.city || '', gender: gender || pr.gender || '', dob: dob || pr.dob || '', iul_goal: goal || pr.iul_goal || '',
        lead_status: 'Fresh Lead (vendor webhook)', requested_at: now.toISOString(), profile: fields, lead_added_date: c.dateAdded || now.toISOString(), enrolled_at: now.toISOString(), status: 'active', step: 0, messages_sent: 0, reply_count: 0, ashley_turns: 0,
        next_send_at: firstSend.toISOString(), conversation: [], seq_log: [`${stamp()} enrolled via premium trucker webhook (FRESH); first text requested immediately`] });
      out.respark = 'enrolled';
      // 5. Fire the first text immediately (single-lead run of the sender, which applies the texting-hours policy; the 15-minute sender is the backstop)
      try {
        const r = await fetch(SELF_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contact_id: contactId }) });
        const j = await r.json().catch(() => ({}));
        if (j.sent_count) { out.first_text = 'first text sent'; rec.sms_sent = true; rec.last_sms_at = now.toISOString(); }
        else if (j.deferred) out.first_text = `outside texting hours, first text queued for ${j.deferred_until || 'the next window'}`;
        else out.first_text = `not sent yet (${JSON.stringify(j).slice(0, 120)}); sender will retry within 15 min`;
      } catch (e) { out.first_text = `sender call failed, 15-min sender will pick it up: ${String(e).slice(0, 80)}`; }
    }
    rec.status = 'processed'; rec.seq_status = 'respark';
    // 6. Alert Riley
    try { await alertRiley(`NEW LEAD, CALL NOW (they just hit submit): ${rec.first_name} ${rec.last_name} | ${phone} | ${state}${city ? ', ' + city : ''} | ${driverType || 'driver type n/a'}${age ? ', age ' + age : ''}${beneficiary ? ' | beneficiary ' + beneficiary : ''}${goal ? ' | goal: ' + goal : ''}${bestTime ? ' | best time: ' + bestTime : ''}. Double dial inside 3 minutes beats everything else. Text: ${out.first_text || out.respark}. In Fresh Premium Truckers > New Lead.`); rec.owner_alert_sent = true; } catch (_) {}
  } catch (e) { rec.status = 'error'; rec.error = String(e).slice(0, 300); out.error = rec.error; try { await alertRiley(`Premium trucker lead ${rec.first_name} ${phone} hit an error: ${rec.error.slice(0, 160)}`); } catch (_) {} }
  const saved = await GL.create(rec); out.logged_id = saved.id;
  return Response.json(out);
});
