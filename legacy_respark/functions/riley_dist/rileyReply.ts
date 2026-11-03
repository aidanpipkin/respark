// Riley reply bot for the Respark campaign (replaces the Ashley persona). Runs every 5 minutes (or directly with { contact_id }).
// For every enrolled lead with a new inbound text it: logs the message, handles STOP, steps aside if Riley texted manually,
// and otherwise replies AS RILEY with the goal of booking a 30-minute phone call on Riley's GHL calendar (his calendar hours, Mon-Fri; pushes same-day and next-day slots first).
// Booking: creates the GHL appointment, texts a first-person confirmation, moves the GHL opportunity to the Appointment stage, alerts Riley.
// "Call me now": replies that Riley will wrap up and call, alerts Riley immediately, hands the thread to him.
// Human-touch delay: 2-6 minutes after a lead's text (1 min for fresh leads); none when GHL's Customer Replied webhook calls us with { contact_id, token }.
// Poll cost: one location-wide 'recently active conversations' list decides which threads to open, so a run is a handful of GHL calls, not one per lead.
// ASAP booking: when Riley's calendar is clear for the next 45 minutes inside booking hours, the bot can offer 'can I call you in 15?' and book it on the spot.
// Honesty rule: the bot never claims to be a human. If asked, it says it's Riley's number and Riley is the one calling, and that
// he uses a tool to keep up with texts between calls.
// Simulation: POST { simulate: { text, first_name, driver_type, state, history: [...] } } returns the reply without side effects.
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

// 30-day Respark sequence copy. Sender identity: Riley himself (first person). 14 touches: daily the first week, then spacing out.
// Rules: no links, no prices, no license number, no opt-out line (leads opted in), one easy question per text, built to pull a reply.
// Voice: casual, confirms what's on the form, "yall", plain words, no emojis.
// Emotional weight: every text ties back to the person they named on the form (by name when we have it) and what it would
// actually mean for that person if the driver did nothing. Real, not scare tactics. If they already have coverage, the angle
// is living benefits and tax free retirement income, never "your policy is bad".
type Ctx = { first: string; group: 'owner_op' | 'company' | 'unknown'; married: boolean; state: string; city?: string; fam?: string; goal?: string; talked?: boolean; fresh?: boolean };
type Step = { day: number; h: number; mi: number; label: string; text: (ctx: Ctx) => string; offsetMin?: number };  // offsetMin: send N minutes after the previous text (same-day bursts), instead of day/h/mi

const famOf = (c: Ctx) => c.fam || (c.married ? 'your wife and kids' : 'your family');
// true when fam is a person's name (one capitalized word) rather than a phrase like "your family"
const famIsName = (c: Ctx) => !!c.fam && /^[A-Z][a-z'-]+$/.test(c.fam);
const placeOf = (c: Ctx) => c.city || c.state || 'the same state';
const goalKind = (g?: string) => /retire/i.test(g || '') ? 'retirement' : /famil|protect|income|final|burial/i.test(g || '') ? 'family' : '';

const STEPS: Step[] = [
  { day: 0, h: 9, mi: 30, label: 'D1 intro + state check', text: (c) =>
    c.fresh
      ? `Hey ${c.first}, this is Riley, the CDL financial advisor assigned to the Trucker IUL request you just put in. Got it on my end. Quick one so I don't call you mid shift: you're in ${placeOf(c)}, right?`
      : c.talked
      ? `Hey ${c.first}, Riley here, the CDL financial advisor on your Trucker IUL request. We talked a bit ago and I didn't want to let it slide. You're still in ${placeOf(c)}, right?`
      : `Hey ${c.first}, this is Riley, the CDL financial advisor assigned to your Trucker IUL request. Tried calling a couple times, figured you were behind the wheel. You're still in ${placeOf(c)}, right?` },

  { day: 1, h: 17, mi: 30, label: 'D2 confirm driver type + OTR/regional', text: ({ first, group }) =>
    group === 'owner_op'
      ? `${first}, says here you're an owner operator, is that accurate? And are you OTR or running regional? Helps me know when you're actually parked so I'm not calling you mid shift.`
      : group === 'company'
        ? `${first}, says here you're a company driver, is that accurate? And are you OTR or running regional? Helps me know when you're actually parked so I'm not calling you mid shift.`
        : `${first}, quick one. Are you an owner operator or driving for a company? And OTR or regional? Helps me know when you're actually parked so I'm not calling you mid shift.` },

  { day: 3, h: 12, mi: 15, label: 'D3 who feels it first (beneficiary)', text: (c) => {
    const f = famOf(c);
    const named = famIsName(c) ? `you put ${f} down on the form` : '';
    if (goalKind(c.goal) === 'retirement') return `${c.first}, ${named ? named + ' and' : 'you put down'} retirement as the goal. Let me ask it straight: at 65 do you want to still be in the seat, or home with ${f}? That answer changes how I'd set this up.`;
    return `${c.first}, ${named ? named + '. ' : ''}Honest question, and I ask every driver this: if the truck stopped tomorrow, how long before ${f} would feel it? A month? Less?`; } },

  { day: 5, h: 10, mi: 0, label: 'D4 why I do this', text: ({ first }) =>
    `${first}, I'll be straight about why I do this. Drivers are the backbone of this country and yall get forgotten. Crazy schedules, always working, and nobody ever sits down with you to make sure the people at home are covered if you can't be. That's the whole reason I only work with CDL holders. Still want me to look at yours?` },

  { day: 7, h: 9, mi: 5, label: 'D5 buried or bad timing', text: ({ first }) =>
    `Morning ${first}. Did my texts get buried, or is this just bad timing right now? Either one's fine, just tell me which.` },

  { day: 9, h: 17, mi: 30, label: 'D7 health objection', text: ({ first }) =>
    `${first}, one thing that holds a lot of drivers back: blood pressure meds, sleep apnea, a few extra pounds. With the carriers I use for drivers, none of that is an automatic no. Is health part of what's had you on the fence?` },

  { day: 11, h: 10, mi: 0, label: 'D9 living benefits (works even if they already have a policy)', text: (c) => {
    const f = famOf(c);
    return c.group === 'company'
      ? `${c.first}, the part most company drivers never get told: the policy through work ends the day you leave or lose your med card, and almost none of them pay you anything while you're alive. The one I set drivers up with has living benefits, so if you get sick or hurt and can't drive, it pays you, not just ${f} after. Already got a policy? Worth checking if it does that. Want me to look?`
      : `${c.first}, the part most owner ops have never been told: the plan I set drivers up with has living benefits. If you get sick or hurt and can't drive, it pays you while you're alive, not just ${f} after. The truck note and the house note don't stop just because you did. Even if you've already got a policy, does yours do that?`; } },

  { day: 13, h: 9, mi: 30, label: 'D11 given up?', text: (c) =>
    `${c.first}, have you given up on this? No hard feelings if so. I just keep thinking you filled that form out for ${famOf(c)}, not for me, and I don't like leaving a driver hanging.` },

  { day: 15, h: 18, mi: 0, label: 'D14 the IUL: protection now, tax free income later', text: (c) =>
    `${c.first}, the IUL you asked about does two jobs. It protects ${famOf(c)} if something happens to you, and it builds cash you can pull as tax free income in retirement, with downside protection when the market drops. Most drivers have nothing doing that second job. I can show you how it works in 10 minutes. Want a spot this week?` },

  { day: 18, h: 12, mi: 15, label: 'D17 your schedule', text: ({ first }) =>
    `${first}, where you running this week? I work around driver schedules, not the other way around. Home time, 34 hour reset, sitting at a dock, I'll call whenever you say.` },

  { day: 21, h: 10, mi: 0, label: 'D20 price guess', text: ({ first }) =>
    `${first}, quick gut check. What do you figure something like this runs a month? Most drivers guess way high. Throw me a number and I'll tell you how close you are when we talk.` },

  { day: 24, h: 17, mi: 30, label: 'D24 after this run (the weight)', text: (c) => {
    const f = famOf(c);
    return `${c.first}, a lot of guys tell me "I'll get to it after this run." Then it's three runs later. If something happened on the next load, ${f} would have to figure out the truck note, the house, all of it, while grieving. That's not a sales line, it's the real question I'd ask you on the call. Would ${famIsName(c) ? f : 'they'} be alright?`; } },

  { day: 27, h: 9, mi: 30, label: 'D27 easy out: text the basics', text: ({ first }) =>
    `${first}, one of my last texts on this. Would it be easier if I just texted you the basics instead of calling? I can do that too, just say the word.` },

  { day: 30, h: 11, mi: 0, label: 'D30 close the file', text: (c) =>
    `${c.first}, I'm about to close your file so I quit bugging you. Before I do, was it bad timing, or did you get it handled somewhere else? One word is fine. Either way, drive safe out there, ${famOf(c)} needs you home.` },
];

// FRESH vendor leads (they just hit submit): D1 opener right away, then ONE text a day at most. Nudge the next morning,
// driver-type question the day after, the "reply YES" close on day 5, then the regular series (D3...D30) shifted two days later.
// Earlier version sent three texts on day 0 (opener, +20m, +4h); that was too many for one day, so the burst is gone.
// Any reply at any point hands the thread to the reply bot, so these only go out to leads who stayed silent.
const FRESH_STEPS: Step[] = [
  STEPS[0],
  { day: 1, h: 10, mi: 15, label: 'F2 fresh nudge (next morning)', text: (c) =>
    `${c.first}, one more since you just put the request in: the fastest way to get you real numbers is a 10 minute call, no pressure and no paperwork. Are you parked right now or still rolling?` },
  { ...STEPS[1], day: 2 },
  { day: 4, h: 10, mi: 0, label: 'F3 fresh reply-YES close (day 5)', text: (c) =>
    `${c.first}, I'll keep it simple. Reply YES and I'll call you at this number in the next few minutes, or tell me a better time. If you'd rather I hold off for now, that's fine too, just say so.` },
  ...STEPS.slice(2).map((s) => ({ ...s, day: s.day + 2 })),
];


const MAX_BOT_TURNS = 14;
const REPLY_HOUR_START = 7, REPLY_HOUR_END = 22;
const REPLY_HOOK_TOKEN = 'rK4mTz8WqLp2XsVn7bYd3cHf9gJe5uRa';   // GHL workflow "Customer Replied" -> webhook POST { contact_id, token }
const RECENT_LOOKBACK_MS = 6 * 3600000;                           // how far back the cheap change-detection list looks
const TIME_BUDGET_MS = 230000;                                    // stay under the workflow's 5-minute activity timeout
// Opt-out detection. Exact-ish one-liners ("Stop", "Stops", "stop it", "quit") OR any text that contains a clear "quit texting me" phrase.
const STOP_RE = /^\s*(stop\w*|stop (it|texting|messaging|calling|contacting)( me)?|unsubscribe|cancel|end|quit|remove( me)?|take me off|opt ?out|leave me alone|no more texts?|no more messages?|lose my number|wrong number|not me)\b[\s.!]*$/i;
const STOP_PHRASE_RE = /\b(stop (texting|messaging|contacting|calling|sending|bothering|harassing)|quit (texting|messaging|calling)|leave me alone|take me off|remove me|don'?t (text|message|contact|call) me|do not (text|message|contact|call)|no more (texts|messages)|unsubscribe|opt ?out|lose my number|f+u+c+k+ off|wrong number|wrong person|not (the right|that) person|never (signed|asked|requested))/i;
const isOptOut = (t: string) => STOP_RE.test(t) || STOP_PHRASE_RE.test(t);
// A booking is only real if the lead actually agreed. Either the bot had already offered times (so a short "yes"/"ok"/"the 4" is an answer),
// or the lead's own words name a time / say call me. Protects against a one-word reply like "Stops" being read as a yes.
const AFFIRM_RE = /\b(yes|yeah|yep|yup|ya|sure|ok|okay|sounds good|that works|works|fine|do it|book|go ahead|call me|that one|the (first|second|later|earlier) one|\d{1,2}(:\d{2})?\s*(am|pm|o'?clock)?|morning|afternoon|evening|tonight|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|now)\b/i;
// Lead's own words name a time or ask for a call (lets a first-message "call me now" / "3pm works" book without a prior offer)
const TIME_RE = /\b(\d{1,2}(:\d{2})?\s*(am|pm|o'?clock)|noon|midnight|(this |tomorrow )?(morning|afternoon|evening)|tonight|right now|call me|ring me|give me a call)\b/i;
// Marker for the one honest push-back the bot sends after a first "not interested"
const LEVEL_RE = /god forbid|devastated financially|income protection|took you off the road|couldn'?t drive/i;
function hashStr(x: string): number { let h = 0; for (let i = 0; i < x.length; i++) h = (h * 31 + x.charCodeAt(i)) >>> 0; return h; }

// Shared booking module for RILEY (copied into rileyReply + rileyAppointmentFlow at deploy time). Requires rileyShared helpers.
// Riley's build books on his GHL calendar ("Riley Lyng's Personal Calendar") instead of Outlook: free slots come from the GHL
// free-slots API (so his calendar hours/conflicts are the source of truth), the booking is a GHL appointment on the lead's contact,
// and the private prep block is a GHL blocked slot plus a contact note with the full file + thread.
const CALL_MINUTES = 30;
const RILEY_PHONE_DISPLAY = '479-446-6932';
const RILEY_TITLE = 'CDL Financial Advisor, My Trucker Wealth';
const CALENDAR_ID = 'UzHXKRyDyP5bXb303J03';   // Riley Lyng's Personal Calendar (30 min slots)
const RILEY_USER_ID = 'AbSahwCJZNX0e0yFDkKS';
const MIN_NOTICE_MIN = 60;
const ASAP_LEAD_MIN = 15;   // "I'm finishing up with another driver, can I call you in 15?"
function isAsap(d: Date | null | undefined): boolean { return !!(d && (d as any).asap); }
// No OAuth token needed for GHL; kept so callers stay identical to the Outlook build.
async function outlookToken(_base44: any): Promise<string> { return 'ghl'; }
function fmtPhone(p: string): string { const d = String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p; }
function esc(s: any): string { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function fullName(L: any): string { return `${L.first_name || ''} ${L.last_name || ''}`.replace(/\s+/g, ' ').trim(); }
function tzLabel(tz: string, d: Date): string { return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(d).find(p => p.type === 'timeZoneName')?.value || ''; }
function fmtLong(d: Date, tz: string): string { return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(d); }

// ---------- Availability from Riley's GHL calendar ----------
// Returns bookable slot starts (UTC Dates) for the next 8 days, honoring the calendar's hours, existing appointments and blocked slots.
// Adds an ASAP slot (~15 min from now, rounded to 5) when the calendar shows the next half hour open on a weekday.
async function freeSlots(_token: string, now: Date): Promise<Date[]> {
  const start = new Date(now.getTime() + MIN_NOTICE_MIN * 60000);
  const end = new Date(now.getTime() + 8 * 86400000);
  const q = `/calendars/${CALENDAR_ID}/free-slots?startDate=${now.getTime()}&endDate=${end.getTime()}&timezone=${encodeURIComponent(RILEY_TZ)}`;
  const r = await ghl(q);
  if (!r.ok) throw new Error(`GHL free-slots ${r.status} ${JSON.stringify(r.json).slice(0, 160)}`);
  const all: Date[] = [];
  for (const [k, v] of Object.entries<any>(r.json || {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
    for (const s of (v?.slots || [])) { const d = new Date(s); if (!isNaN(d.getTime())) all.push(d); }
  }
  all.sort((a, b) => a.getTime() - b.getTime());
  const slots: Date[] = [];
  // ASAP: the calendar has an open slot that begins within the next 30 minutes (so Riley is free right now) and it's a weekday.
  const asap = new Date(Math.ceil((now.getTime() + ASAP_LEAD_MIN * 60000) / 300000) * 300000);
  const ap = localParts(asap, RILEY_TZ);
  const soonOpen = all.some(s => s.getTime() >= now.getTime() - 15 * 60000 && s.getTime() <= now.getTime() + 30 * 60000);
  const nextOpen = all.some(s => s.getTime() > now.getTime() + 15 * 60000 && s.getTime() <= now.getTime() + 45 * 60000);
  if (ap.wd >= 1 && ap.wd <= 5 && soonOpen && nextOpen) { (asap as any).asap = true; slots.push(asap); }
  for (const s of all) if (s.getTime() >= start.getTime()) slots.push(s);
  return slots;
}

// Lead-facing appointment title + description (shows in Riley's GHL calendar and in any calendar notification GHL sends the lead)
function inviteSubject(L: any): string { return `Trucker IUL Strategy Call: ${fullName(L)} and Riley (My Trucker Wealth)`; }
function inviteBody(L: any, start: Date): string {
  const tz = L.timezone || RILEY_TZ;
  const g = driverGroup(L.driver_type);
  const goal = /retire/i.test(L.iul_goal || '') ? 'the retirement side of the IUL (cash value you can tap later, with downside protection)' : /famil|protect|income/i.test(L.iul_goal || '') ? 'making sure your family keeps their income if something happens to you' : 'what you were hoping the coverage would do for you and your family';
  const situ = g === 'owner_op' ? 'As an owner-operator you carry the truck note and the household without an employer safety net, so we will talk about living benefits that pay you if you cannot drive.' : g === 'company' ? 'As a company driver, the group life through work ends the day you leave or lose your med card, so we will look at coverage that is yours for life.' : 'We will look at coverage built around a driver\'s schedule and income.';
  return `30-minute phone call on ${fmtLong(start, tz)}. Riley calls ${fmtPhone(L.phone)}; nothing to join or download. The call may show from a different number than the one Riley texts from.

What we will cover:
- The Trucker IUL request you submitted, and ${goal}
- ${situ}
- Living benefits: how a policy can pay out to you while you are alive if a serious illness or injury takes you off the road
- Real numbers based on your age, health and budget, with no obligation

Need to move it? Reply to Riley's text or email riley@usnaturalinsurance.com.

Riley, ${RILEY_TITLE}, ${RILEY_PHONE_DISPLAY}`;
}
// Internal prep note for Riley (goes on the GHL contact as a note, and the blocked slot title points to it)
function prepBody(L: any, start: Date, convo: any[]): string {
  const tz = L.timezone || RILEY_TZ;
  const file = Object.entries(L.profile || {}).map(([k, v]) => `- ${k}: ${v}`).join('\n');
  const thread = (convo || []).slice(-16).map((m: any) => `${m.role === 'lead' ? L.first_name : 'You (bot)'}: ${m.text}`).join('\n');
  return `PREP: call ${fullName(L)} at ${fmtPhone(L.phone)} at ${fmtLocal(start, RILEY_TZ)} (${fmtLocal(start, tz)} their time). You call them.
Email: ${L.email || 'none on file'} | State: ${L.state || 'n/a'}${L.city ? ', ' + L.city : ''} | Driver: ${L.driver_type || 'n/a'} | Age ${L.age || 'n/a'} | ${L.marital_status || ''} | Beneficiary: ${L.beneficiary_relationship || 'n/a'} | Goal: ${L.iul_goal || 'n/a'}

FULL FILE
${file || '- only name and phone'}

TEXT THREAD (booked by the Respark bot in your name; pick up where "you" left off)
${thread}

After the call, move the opportunity out of the Appointment stage so the bot stops reminding.`;
}
async function createBooking(_token: string, L: any, start: Date, convo: any[]): Promise<{ eventId: string; prepEventId: string; inviteSent: boolean }> {
  const end = new Date(start.getTime() + CALL_MINUTES * 60000);
  const email = String(L.email || '').trim();
  const hasEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
  const appt = await ghl('/calendars/events/appointments', { method: 'POST', body: JSON.stringify({
    calendarId: CALENDAR_ID, locationId: LOC, contactId: L.ghl_contact_id, assignedUserId: RILEY_USER_ID,
    startTime: start.toISOString(), endTime: end.toISOString(),
    title: inviteSubject(L), appointmentStatus: 'confirmed', address: `Phone call: Riley calls ${fmtPhone(L.phone)}`,
    meetingLocationType: 'phone', meetingLocationId: 'default', overrideLocationConfig: true,
    ignoreDateRange: true, ignoreFreeSlotValidation: isAsap(start), toNotify: false,
  }) });
  if (!appt.ok) throw new Error(`GHL appointment ${appt.status} ${JSON.stringify(appt.json).slice(0, 200)}`);
  const eventId = appt.json?.id || appt.json?.event?.id || '';
  const prepStart = new Date(start.getTime() - 15 * 60000);
  let prepId = '';
  try {
    const blk = await ghl('/calendars/events/block-slots', { method: 'POST', body: JSON.stringify({
      calendarId: CALENDAR_ID, locationId: LOC, assignedUserId: RILEY_USER_ID,
      startTime: prepStart.toISOString(), endTime: start.toISOString(),
      title: `Prep: ${fullName(L)} (${L.driver_type || 'driver'}, ${L.state || ''}) ${fmtPhone(L.phone)}, see contact note`.replace(/\s+/g, ' '),
    }) });
    prepId = blk.json?.id || blk.json?.event?.id || '';
  } catch (_) {}
  await addNote(L.ghl_contact_id, prepBody(L, start, convo));
  let inviteSent = false;
  if (hasEmail) { const e = await sendEmail(L.ghl_contact_id, `Your call with Riley: ${fmtLong(start, L.timezone || RILEY_TZ)}`, confirmationEmailHtml(L, start)); inviteSent = e.ok; }
  try { await sendEmail(RILEY_CONTACT_ID, `Booked: ${fullName(L)}, ${fmtLocal(start, RILEY_TZ)}`, rileyBookedEmailHtml(L, start, convo)); } catch (_) {}
  return { eventId, prepEventId: prepId, inviteSent };
}
async function cancelBooking(_token: string, L: any) {
  for (const id of [L.appointment_event_id, L.prep_event_id]) { if (id) { try { await ghl(`/calendars/events/${id}`, { method: 'DELETE' }); } catch (_) {} } }
}
// GHL does not expose attendee accept/decline like Outlook; the appointment flow treats this as unknown and never nags about the invite.
async function inviteResponse(_token: string, _eventId: string, _email: string): Promise<string> { return 'unknown'; }
function confirmationText(L: any, start: Date, _inviteSent: boolean): string {
  const tz = L.timezone || RILEY_TZ;
  if (isAsap(start)) return `Perfect ${L.first_name}, give me about ${ASAP_LEAD_MIN} minutes to wrap up and I'll call you at this number. Heads up, it may show up from a different number than this one, so go ahead and pick up.`;
  return `You're set ${L.first_name}. I'll call you ${fmtLocal(start, tz)} at this number. If anything changes before then just text me and we'll move it. Drive safe.`;
}
async function addNote(contactId: string, body: string) { try { await ghl(`/contacts/${contactId}/notes`, { method: 'POST', body: JSON.stringify({ body: body.slice(0, 4000) }) }); } catch (_) {} }

// ---- branded emails (sent through Riley's GHL inbox so they show in the contact thread) ----
const EMAIL_FROM = RILEY_EMAIL;
const EMAIL_FROM_NAME = 'Riley | My Trucker Wealth';
async function sendEmail(contactId: string, subject: string, html: string) {
  const r = await ghl('/conversations/messages', { method: 'POST', body: JSON.stringify({ type: 'Email', contactId, subject, html, emailFrom: EMAIL_FROM, fromName: EMAIL_FROM_NAME }) });
  return { ok: r.ok, id: r.json.messageId || r.json.emailMessageId || '', err: r.ok ? '' : `${r.status} ${JSON.stringify(r.json).slice(0, 160)}` };
}
function icsStamp(d: Date): string { return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }
function calendarLinks(L: any, start: Date): { google: string; outlook: string } {
  const end = new Date(start.getTime() + CALL_MINUTES * 60000);
  const title = `Call with Riley (My Trucker Wealth)`;
  const details = `Riley calls ${fmtPhone(L.phone)}. Nothing to join or download. Questions: riley@usnaturalinsurance.com or ${RILEY_PHONE_DISPLAY}.`;
  const google = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(title)}&dates=${icsStamp(start)}/${icsStamp(end)}&details=${encodeURIComponent(details)}&location=${encodeURIComponent('Phone call')}`;
  const outlook = `https://outlook.live.com/calendar/0/deeplink/compose?path=%2Fcalendar%2Faction%2Fcompose&rru=addevent&subject=${encodeURIComponent(title)}&startdt=${encodeURIComponent(start.toISOString())}&enddt=${encodeURIComponent(end.toISOString())}&body=${encodeURIComponent(details)}&location=${encodeURIComponent('Phone call')}`;
  return { google, outlook };
}
function emailShell(preheader: string, inner: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>My Trucker Wealth</title></head>
<body style="margin:0;padding:0;background:#f3f5f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1f2937;">
<div style="display:none;max-height:0;overflow:hidden;color:#f3f5f8;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f5f8;"><tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e5e7eb;">
<tr><td style="background:#0f2a44;padding:22px 32px;">
  <div style="font-size:18px;font-weight:700;color:#ffffff;letter-spacing:0.3px;">My Trucker Wealth</div>
  <div style="font-size:12px;color:#b9c7d8;margin-top:3px;">Life insurance and retirement planning built for CDL drivers</div>
</td></tr>
<tr><td style="padding:30px 32px 8px 32px;font-size:16px;line-height:1.55;">${inner}</td></tr>
<tr><td style="padding:18px 32px 28px 32px;border-top:1px solid #eef0f3;font-size:13px;line-height:1.6;color:#6b7280;">
  <div style="font-weight:600;color:#1f2937;">Riley</div>
  <div>${RILEY_TITLE}</div>
  <div>${RILEY_PHONE_DISPLAY} &nbsp;|&nbsp; <a href="mailto:riley@usnaturalinsurance.com" style="color:#0f2a44;">riley@usnaturalinsurance.com</a></div>
</td></tr>
</table>
<div style="max-width:600px;margin:14px auto 0;font-size:11px;color:#9ca3af;line-height:1.5;">You received this because you requested information about life insurance for truck drivers. Reply to this email or text Riley at any time to make changes.</div>
</td></tr></table></body></html>`;
}
function whenBlock(L: any, start: Date): string {
  const tz = L.timezone || RILEY_TZ;
  const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }).format(start);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(start);
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:18px 0 20px 0;"><tr><td style="background:#f6f8fb;border-left:4px solid #0f2a44;padding:16px 20px;border-radius:6px;">
  <div style="font-size:13px;text-transform:uppercase;letter-spacing:1px;color:#6b7280;">Your call</div>
  <div style="font-size:20px;font-weight:700;color:#0f2a44;margin-top:4px;">${esc(day)}</div>
  <div style="font-size:17px;color:#1f2937;margin-top:2px;">${esc(time)} &middot; ${CALL_MINUTES} minutes</div>
  <div style="font-size:14px;color:#4b5563;margin-top:8px;">Riley will call you at <strong>${esc(fmtPhone(L.phone))}</strong>. Nothing to join or download.</div>
</td></tr></table>`;
}
function agendaList(L: any): string {
  const g = driverGroup(L.driver_type);
  const goal = /retire/i.test(L.iul_goal || '') ? 'The retirement side of the IUL: cash value you can draw on later, with protection when the market drops' : /famil|protect|income/i.test(L.iul_goal || '') ? 'Making sure your family keeps their income if something happens to you' : 'What you want the coverage to do for you and your family';
  const situ = g === 'owner_op' ? 'Living benefits for owner-operators: coverage that pays you if an illness or injury takes you off the road, so the truck note and the house note are covered' : g === 'company' ? 'Why group life through the carrier ends when you leave or lose your med card, and what coverage that stays with you looks like' : 'Coverage built around a driver\'s schedule and income';
  const items = ['The Trucker IUL request you submitted', goal, situ, 'Real numbers based on your age, health and budget, with no obligation'];
  return `<ul style="margin:8px 0 0 0;padding-left:20px;color:#1f2937;">${items.map(i => `<li style="margin:6px 0;">${esc(i)}</li>`).join('')}</ul>`;
}
function calendarButtons(L: any, start: Date): string {
  const k = calendarLinks(L, start);
  const btn = (href: string, label: string) => `<a href="${href}" style="display:inline-block;background:#0f2a44;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:11px 18px;border-radius:6px;margin:0 8px 8px 0;">${label}</a>`;
  return `<div style="margin:22px 0 6px 0;"><div style="font-size:13px;color:#6b7280;margin-bottom:10px;">Add it to your calendar so it pops up on your phone:</div>${btn(k.google, 'Google Calendar')}${btn(k.outlook, 'Outlook')}</div>`;
}
function confirmationEmailHtml(L: any, start: Date): string {
  const tz = L.timezone || RILEY_TZ;
  const inner = `<p style="margin:0 0 6px 0;font-size:22px;font-weight:700;color:#0f2a44;">You're set, ${esc(L.first_name)}.</p>
<p style="margin:0;">Thanks for grabbing a time. Here are the details so you have them in one place.</p>
${whenBlock(L, start)}
<div style="font-size:15px;font-weight:700;color:#0f2a44;">What we'll cover</div>
${agendaList(L)}
${calendarButtons(L, start)}
<p style="margin:22px 0 0 0;font-size:14px;color:#4b5563;">Schedule change? Just reply to Riley's text and he'll move it. The call may show up from a different number than the one he texts from, so go ahead and pick up.</p>
<p style="margin:16px 0 0 0;">Drive safe,<br><strong>Riley</strong></p>`;
  return emailShell(`Your call with Riley is ${fmtLocal(start, tz)}. He'll call ${fmtPhone(L.phone)}.`, inner);
}
function reminderEmailHtml(L: any, start: Date): string {
  const tz = L.timezone || RILEY_TZ;
  const inner = `<p style="margin:0 0 6px 0;font-size:22px;font-weight:700;color:#0f2a44;">Quick reminder, ${esc(L.first_name)}.</p>
<p style="margin:0;">We're on for tomorrow. Nothing you need to do, Riley will call you.</p>
${whenBlock(L, start)}
${calendarButtons(L, start)}
<p style="margin:22px 0 0 0;font-size:14px;color:#4b5563;">If anything comes up, reply to Riley's text and he'll find another time that works around your schedule.</p>
<p style="margin:16px 0 0 0;">Talk tomorrow,<br><strong>Riley</strong></p>`;
  return emailShell(`Reminder: your call with Riley is tomorrow, ${fmtLocal(start, tz)}.`, inner);
}
function cancellationEmailHtml(L: any, start: Date): string {
  const tz = L.timezone || RILEY_TZ;
  const inner = `<p style="margin:0 0 6px 0;font-size:22px;font-weight:700;color:#0f2a44;">No problem, ${esc(L.first_name)}.</p>
<p style="margin:0;">Your call that was set for <strong>${esc(fmtLong(start, tz))}</strong> has been cancelled. Nothing else on your end.</p>
<p style="margin:18px 0 0 0;">Whenever the timing is better, text Riley and he'll get you a new time that works around your runs.</p>
<p style="margin:16px 0 0 0;">Drive safe,<br><strong>Riley</strong></p>`;
  return emailShell(`Your call with Riley has been cancelled.`, inner);
}
function rileyBookedEmailHtml(L: any, start: Date, convo: any[]): string {
  const tz = L.timezone || RILEY_TZ;
  const file = Object.entries(L.profile || {}).map(([k, v]) => `<tr><td style="padding:3px 10px 3px 0;color:#6b7280;white-space:nowrap;vertical-align:top;">${esc(k)}</td><td style="padding:3px 0;">${esc(v)}</td></tr>`).join('');
  const thread = (convo || []).slice(-14).map((m: any) => `<div style="margin:4px 0;"><strong style="color:${m.role === 'lead' ? '#0f2a44' : '#6b7280'};">${m.role === 'lead' ? esc(L.first_name) : 'You (bot)'}:</strong> ${esc(m.text)}</div>`).join('');
  const inner = `<p style="margin:0 0 6px 0;font-size:22px;font-weight:700;color:#0f2a44;">Booked: ${esc(fullName(L))}</p>
<p style="margin:0;">The Respark bot booked this in your name. You call them.</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:18px 0;"><tr><td style="background:#f6f8fb;border-left:4px solid #0f2a44;padding:16px 20px;border-radius:6px;">
  <div style="font-size:20px;font-weight:700;color:#0f2a44;">${esc(fmtLocal(start, RILEY_TZ))}</div>
  <div style="font-size:14px;color:#4b5563;margin-top:4px;">${esc(fmtLocal(start, tz))} their time &middot; call <strong>${esc(fmtPhone(L.phone))}</strong></div>
  <div style="font-size:14px;color:#4b5563;margin-top:4px;">${esc([L.driver_type, L.state, L.city, L.age ? `age ${L.age}` : '', L.marital_status, L.beneficiary_relationship ? `beneficiary: ${L.beneficiary_relationship}` : '', L.iul_goal ? `goal: ${L.iul_goal}` : ''].filter(Boolean).join(' · '))}</div>
  <div style="font-size:14px;color:#4b5563;margin-top:4px;">Email: ${esc(L.email || 'none on file')} ${L.email ? '(confirmation sent)' : ''}</div>
</td></tr></table>
<div style="font-size:15px;font-weight:700;color:#0f2a44;margin-top:8px;">Their file</div>
<table role="presentation" cellspacing="0" cellpadding="0" style="font-size:14px;margin-top:6px;">${file || '<tr><td style="color:#6b7280;">Only name and phone on file</td></tr>'}</table>
<div style="font-size:15px;font-weight:700;color:#0f2a44;margin-top:20px;">Text thread</div>
<div style="font-size:14px;margin-top:6px;background:#f9fafb;border:1px solid #eef0f3;border-radius:6px;padding:12px 14px;">${thread || '<em>none</em>'}</div>
<p style="margin:20px 0 0 0;font-size:14px;color:#4b5563;">A 15-minute prep block is on your calendar before the call. After the call, move the opportunity out of the Appointment stage so the bot stops reminding.</p>`;
  return emailShell(`Booked: ${fullName(L)} at ${fmtLocal(start, RILEY_TZ)}`, inner);
}

// ---------- Availability: freeSlots() comes from the GHL booking module ----------
function slotMenu(slots: Date[], now: Date): Date[] {
  // Same-day / next-day first: up to 6 spread picks today, 5 tomorrow (next business day), then 2 per day for two more days.
  const byDay: Record<string, Date[]> = {};
  const asapSlot = slots.find(isAsap);
  for (const s of slots) { if (isAsap(s)) continue; const lp = localParts(s, RILEY_TZ); const k = `${lp.y}-${String(lp.mo).padStart(2, '0')}-${String(lp.d).padStart(2, '0')}`; (byDay[k] ||= []).push(s); }
  const spread = (d: Date[], n: number) => { if (d.length <= n) return d; const out: Date[] = []; for (let i = 0; i < n; i++) out.push(d[Math.round(i * (d.length - 1) / (n - 1))]); return out.filter((x, i, a) => a.indexOf(x) === i); };
  const quotas = [6, 5, 2, 2];
  const out: Date[] = [];
  if (asapSlot) out.push(asapSlot);
  Object.keys(byDay).sort().slice(0, quotas.length).forEach((k, i) => out.push(...spread(byDay[k], quotas[i])));
  return out;
}
function dayLabel(d: Date, now: Date, tz: string): string {
  const a = localParts(d, tz), b = localParts(now, tz);
  const dn = Date.UTC(a.y, a.mo - 1, a.d), tn = Date.UTC(b.y, b.mo - 1, b.d);
  const diff = Math.round((dn - tn) / 86400000);
  return diff === 0 ? 'TODAY' : diff === 1 ? 'TOMORROW' : `in ${diff} days`;
}
function fmtNowFull(d: Date, tz: string) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(d);
}
function profileLines(L: any): string {
  const f: Record<string, string> = { ...(L.profile || {}) };
  const base: [string, string][] = [['Name', `${L.first_name} ${L.last_name || ''}`.trim()], ['State', L.state || ''], ['City', L.city || f['City'] || ''], ['Driver type', L.driver_type || ''], ['Age', L.age || f['Age'] || ''], ['Gender', L.gender || ''], ['Marital status', L.marital_status || ''], ['Beneficiary (as they wrote it)', L.beneficiary_relationship || ''], ['Goal for the IUL', L.iul_goal || '']];
  for (const [k] of base) for (const kk of Object.keys(f)) if (kk.toLowerCase() === k.toLowerCase() || (k === 'Driver type' && kk === 'Driver Type') || (k === 'Beneficiary (as they wrote it)' && /^beneficiary/i.test(kk)) || (k === 'Goal for the IUL' && /iul goal|goals for the iul/i.test(kk)) || (k === 'Marital status' && /marital/i.test(kk))) delete f[kk];
  const lines = base.filter(([, v]) => v).map(([k, v]) => `- ${k}: ${v}`);
  for (const [k, v] of Object.entries(f)) if (v) lines.push(`- ${k}: ${v}`);
  if (L.requested_at) { const days = Math.round((Date.now() - new Date(L.requested_at).getTime()) / 86400000); lines.push(`- Submitted the request about ${days} day${days === 1 ? '' : 's'} ago`); }
  return lines.join('\n') || '- (only name and phone on file)';
}

// ---------- The brain (speaks as Riley) ----------
function systemPrompt(L: any, menu: Date[], now: Date, discloseUpfront: boolean) {
  const tz = L.timezone || RILEY_TZ;
  const fam = familyPhrase(L.beneficiary_relationship || '', L.marital_status || '');
  const famIsName = /^[A-Z][a-z'-]+$/.test(fam);
  const group = driverGroup(L.driver_type);
  const slotLines = menu.map(s => `- ${s.toISOString()} = ${isAsap(s) ? `ASAP (Riley can call in about ${ASAP_LEAD_MIN} minutes), ` : `${dayLabel(s, now, tz)}, `}${fmtLocal(s, tz)}${tz !== RILEY_TZ ? ` (${fmtLocal(s, RILEY_TZ, false)})` : ''}`).join('\n');
  const nextBiz = (() => { const d = new Date(now.getTime() + 86400000); while ([0, 6].includes(localParts(d, RILEY_TZ).wd)) d.setTime(d.getTime() + 86400000); return d; })();
  const todayWd = localParts(now, RILEY_TZ).wd;
  return `You are texting AS Riley, a licensed life insurance advisor and "CDL financial advisor" based in Flower Mound, Texas (Dallas-Fort Worth) who works only with truck drivers. Riley's brokerage serves company drivers for the big carriers plus owner-operators. You write in first person as Riley. Riley reads every thread before he calls, so whatever you say, he will stand behind.

CURRENT DATE AND TIME (trust this, not your training data)
- Right now it is ${fmtNowFull(now, RILEY_TZ)} where Riley is (Flower Mound, Texas, Central Time).
- For the lead it is ${fmtNowFull(now, tz)}.
- "Today" means ${new Intl.DateTimeFormat('en-US', { timeZone: RILEY_TZ, weekday: 'long', month: 'long', day: 'numeric' }).format(now)}. "Tomorrow" means ${new Intl.DateTimeFormat('en-US', { timeZone: RILEY_TZ, weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(now.getTime() + 86400000))}.${[0, 6].includes(todayWd) || [5].includes(todayWd) ? ` The next business day Riley books calls is ${new Intl.DateTimeFormat('en-US', { timeZone: RILEY_TZ, weekday: 'long', month: 'long', day: 'numeric' }).format(nextBiz)}.` : ''}
- The call-time list below was pulled live from Riley's calendar seconds ago; every slot on it is genuinely open, and anything not on it is busy or already past. Slots are marked TODAY / TOMORROW so you always know which day you're offering.

WHO YOU ARE TALKING TO
- Name: ${L.first_name} ${L.last_name || ''}. State: ${L.state || 'unknown'}. Local time zone: ${tz}. Right now it is ${fmtLocal(now, tz)} for them.
- Driver type (from their form): ${L.driver_type || 'unknown'} (${group === 'owner_op' ? 'owner-operator: no company benefits, truck payments, irregular income' : group === 'company' ? 'company driver: has basic group life through the carrier that ends when they leave or lose their med card' : 'unknown, ask'}).
- Age ${L.age || 'unknown'}, ${L.marital_status || 'marital status unknown'}, beneficiary they listed: ${L.beneficiary_relationship || 'unknown'}.
- They filled out an online form asking about a Trucker IUL (indexed universal life) for CDL drivers. ${/fresh/i.test(L.lead_status || '') ? 'They submitted the request very recently (the file shows when) and Riley has NOT called yet; the first text went out right after the request came in. Never say you tried calling.' : talkedBefore(L.lead_status) ? `Riley's notes say he already spoke with them once (status: ${L.lead_status}), so you two have talked before; reference that lightly, never re-pitch from zero.` : 'Riley called a few times with no answer.'} Then he sent the texts shown in the conversation below (as himself). They have now replied. Continue the same thread naturally; do not reintroduce yourself.

THEIR FILE (everything they put on the form plus what we know; this is your rapport fuel)
${profileLines(L)}
How to use the file: the request date tells you how long they've been sitting on this ("you put this in back in August"); the call attempts tell you how many times Riley has tried (say "I've tried you a bunch" not a number). Confirm, don't interrogate ("says here you put Katy down as beneficiary, that your wife?", "you were leaning retirement on the form, still the case?"). Pull ONE detail into a message when it makes the reply feel personal, never dump several. Use their goal, beneficiary, marital status, age range, driver type, employment, health notes and how long ago they asked to tailor what you say. If a detail looks off or they correct you, accept it and move on. Never read internal labels aloud (no "your lead status", "your file says New Lead"), never mention ads, IP, or where the lead came from.

WHY RILEY DOES THIS (use it when it fits, in your own words, never as a speech)
CDL holders are an underserved market. Yall have unpredictable schedules, you're always working, providing for your families and being the backbone of America, so you get forgotten. Nobody reaches out to set up life insurance and retirement properly. Especially living benefits, so if a driver can't work anymore the family still has income. That's the whole reason Riley only works with drivers.

YOUR ONE GOAL
Get a ${CALL_MINUTES}-minute phone call on the calendar. Riley calls them at this number. Available call times (pick from this list only, present them in THEIR local time, offer at most two at a time, match morning/afternoon to what they say about their schedule):
${slotLines || '- (no open slots in the next week: ask what day/time works and set intent handoff)'}

SCHEDULING STRATEGY (speed wins; a call in 15 minutes beats a call today, a call today beats a call next week)
${menu.some(isAsap) ? '- An ASAP slot IS on the list right now, so the "call you in about 15" offer is available.' : '- THERE IS NO ASAP SLOT RIGHT NOW (Riley is booked or outside his hours). Do NOT say "finishing up with another driver" and do NOT offer to call "in 15" or "in a few minutes". Start with a TODAY time instead.'}
- ASAP FIRST. If an ASAP slot is on the list and the lead sounds reachable right now (parked, home, off, on a reset, or just answering you easily), your first move is to get them on the phone now, in these words or close to them: "I'm actually finishing up with another driver right now. Could I call you in about 15 to get this taken care of for you?" If they say yes ("yeah", "sure", "ok", "go ahead", "call me", "sounds good"), set intent "book" with the ASAP slot's exact ISO string in book_slot. If they say they're driving, in a load, or can't right now, drop it without pushing and go to TODAY times.
- No ASAP slot on the list means Riley is booked or it's outside his hours right now; never promise a call "in 15" in that case.
- Lead with TODAY when ASAP isn't possible or they turned it down. If there's a TODAY slot, your first offer is a TODAY time ("I've got a gap at 2:30 this afternoon, or 6 tonight after you're parked?"). Say "today", "this afternoon", "tonight", not the date.
- If they can't do today, go to TOMORROW next ("tomorrow morning at 9:30 or tomorrow at 7?"). Only move past tomorrow if they tell you they can't do either.
- Riley's open times come straight from his live calendar; only offer what is on the list. If a driver says they're rolling all day, offer the latest slot on the list for that day or the first one the next morning. Never promise an evening time that is not on the list.
- Still offer at most two times per message, both in THEIR local time. Match the pair to what they said (morning person vs "after I park").
- If they say "now" or "right now", that's the CALL ME NOW rule below, not a booking.
- If they name a day ("Friday"), figure out which date that is from today's date above and offer the two best slots on that day from the list; if that day has nothing, say so plainly and offer the closest day that does.

MAKE IT MATTER (this is the heart of every reply)
- The person they named on the form is ${famIsName ? `${fam} (use the name: "what would ${fam} do", "is ${fam} the one who'd have to figure it out")` : `"${fam}" (no name on file; if they mention a name, start using it)`}. Every reply should connect back to that person in some way, even if it's a few words.
- Ask emotion-based questions, not product questions. Not "do you want coverage" but "if the check stopped next month, how long before ${fam} would feel it?" "Who handles the truck note if you can't drive?" "At 65, still in the seat or home with ${fam}?" "What made you fill the form out that night?"
- Let them feel the weight of doing nothing, in one honest line, never a lecture: no policy means ${fam} carries the truck note, the house and the bills alone, while grieving. No living benefits means a wreck or a diagnosis that takes you off the road also takes the income with it. Say it once, plainly, then ask a question. Real, not scare tactics, and never disrespectful.
- Use their own answers as the reason to talk: "you said this is for ${fam}, so let's make sure it's actually done." Tie the booking to the person, not the product.

HOW RILEY TEXTS
- Like a real guy texting from his phone between calls: 1-3 short sentences, under 300 characters, plain words, contractions, "yall" is fine, no emojis, no bullet lists, no links, no signatures (they know it's Riley).
- Confirms what's on the form instead of asking cold: "Says here you're an owner operator, is that accurate?" "You're still in ${L.state || 'the same state'}, right?" "OTR or regional?"
- Warm, confident, zero pressure. Genuinely likes drivers. Acknowledges what they said in a few words ("Awesome", "Makes sense", "Gotcha"), then asks ONE simple question they can answer in a word or two.
- Trucker-aware language when it fits (behind the wheel, parked, home time, reset, med card, dock). Never fake CB slang.
- If they say they're driving: one line, ask when they'll be parked.
- Owner-ops: lean on the truck note, no 401k match, living benefits paying them if they can't drive. Company drivers: the policy through work ends when they leave or lose the med card; this one is theirs for life.
- When they answer a question from the sequence (A or B, yes/no, OTR/regional, family vs retirement), reflect it back in one clause so they feel heard, then go for a time.

IF THEY ASK WHO THIS IS (not a bot question): "Riley, the CDL financial advisor on the Trucker IUL request you put in" plus roughly when they put it in (from the file), then one easy question. Do NOT bring up the texting tool unless they actually ask whether this is a bot, automated or AI.

HONESTY (non-negotiable)
- Never claim to be a human, never say "I'm not a bot", never say "no, this is Riley" to a bot question. If they ask whether this is a bot, automated, AI, or a real person, answer in Riley's voice with this idea: "It's my number and I'm the one who'll be calling you. I use a tool that helps me keep up with texts between calls, so if a reply comes back quick, that's why." Then move on with one question.${discloseUpfront ? '\n- This lead is in a state with bot-disclosure rules: in your FIRST reply, work in one plain clause that you use an assistant tool to keep up with texts between calls.' : ''}
- Never invent what Riley is doing at this exact moment (on a call, driving, busy). The one approved exception is the ASAP opener ("finishing up with another driver") and only when an ASAP slot is on the list, because that list comes straight from his live calendar. Otherwise you only know his open calendar times.

HARD RULES (licensing and compliance)
- Never quote a price, premium, rate, dollar amount, "$1/day", percentage, or return. If asked about cost, say it depends on age, health and the amount, that you can run real numbers in a few minutes on the call, and offer a time. If they guess a number (the sequence asks them to), say you'll tell them how close they are on the call.
- Never say anyone is approved, qualifies, or guaranteed. No medical, tax or legal opinions. You can say the carriers you use are used to drivers and things like blood pressure or sleep apnea often are not automatic no's.
- Never name specific insurance carriers or products beyond "the IUL you asked about" or "coverage" or "living benefits".
- Never ask for sensitive data (SSN, bank, medical details, date of birth). Confirming the phone number for the call is fine.
- Already has coverage: never argue or knock the policy. Pivot to the two things most policies don't do: (1) living benefits, meaning it pays THEM while alive if a serious illness or injury takes them off the road, and (2) tax free income in retirement from the cash value, with downside protection when the market drops. Ask one question like "does yours pay you anything if you can't drive, or only ${fam} after?" or "is it through work or in your own name?" Then offer a quick call to make sure what they have actually does both jobs, and that it goes with them if they change jobs or lose the med card. You can say "tax free income in retirement" and "living benefits" in general terms; no numbers, no promises.
- Not interested / "no" / "I'm good" / "not right now": do NOT close the file on the first no. Level with them once, like a human who actually means it, in your own words along these lines: "I get it, most people aren't, and I'm not going to chase you. Let me just ask you straight though. If you passed away today, God forbid, would ${fam} be devastated financially? And if you got in a wreck tomorrow and couldn't drive anymore, do you have income protection so the people who depend on you still have income?" Use ${famIsName ? `${fam}'s name` : 'their family'}, keep it under 300 characters, one or two of those questions at most, no pitch, then stop and let them answer. Set intent "continue". If they answer honestly (even "no I don't"), that's the opening: acknowledge it in a few words and offer a time (ASAP or TODAY first).
- Second no (they've already seen your level-with-them message in the conversation and still say no), or any firm "stop texting me" / "leave me alone" / "remove me" / "not interested" with heat: respect it. Thank them in one line, say you'll close their file, wish them safe travels, set intent "not_interested". Never a third attempt.
- Wrong number / never asked / not a driver: apologize in one line, set intent "wrong_person".
- CALL ME NOW ("call me", "call me now", "just call", "ring me", "can you call"): if an ASAP slot is on the list, set intent "book" with the ASAP slot (the system sends the "I'll call you in about 15" confirmation). If there is no ASAP slot, set intent "handoff" with reason "wants a call now" and reply only: "Give me a few minutes to wrap up what I'm in the middle of and I'll call you at this number." Do not offer times in that message.
- If they ask something only the licensed agent should answer in writing, seem upset, or you've gone back and forth many times without a booking: set intent "handoff" with a reason, and say you'll pick this up personally in a bit.

BOOKING
- Only set intent "book" when the lead has clearly agreed to a call AND picked (or accepted) a specific time you offered IN AN EARLIER MESSAGE. The message where you first propose a time (including the ASAP "call you in 15" offer) is always intent "continue"; you wait for their yes. A one-word or ambiguous reply ("Stops", "ok", "k", "what", "?") is NOT agreement; ask a short clarifying question instead. Anything that reads like "stop", "quit texting", "leave me alone" means they are out: set intent "not_interested" with a one-line respectful close, never a booking.
- When they agree to one of the specific times you offered, set intent "book" and put that slot's exact ISO string from the list in book_slot. Never book a time that is not in the list. If they propose a time not in the list, offer the closest one or two from the list.
- When you set intent "book", your reply text is replaced by a system confirmation, so just write a short friendly line.
${L.status === 'booked' && L.appointment_at ? `- They already have a call booked for ${fmtLocal(new Date(L.appointment_at), tz)}${L.invite_sent ? ` and a calendar invite went to ${L.email} from riley@usnaturalinsurance.com (status: ${L.invite_response || 'not accepted yet'}); if they can't find it, tell them to check spam/junk and that accepting it just puts it on their phone, the call happens either way` : ''}. If they're confirming ("yes", "sounds good", "see you then") reply with one short warm line, no new question. If they want to move it set intent "reschedule" (and offer two new times); if they want to cancel set intent "cancel_appointment"; otherwise just answer briefly.` : ''}

Respond ONLY with JSON: {"reply": string, "intent": "continue"|"book"|"handoff"|"not_interested"|"wrong_person"|"reschedule"|"cancel_appointment", "book_slot": string, "handoff_reason": string, "summary": string}
"summary" = one line about where this conversation stands, for Riley to read before he calls.`;
}
function sayWhen(x: Date, now: Date, tz: string): string { const t = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(x); const dl = dayLabel(x, now, tz); return dl === 'TODAY' ? `today at ${t}` : dl === 'TOMORROW' ? `tomorrow at ${t}` : fmtLocal(x, tz); }
function offerTwo(L: any, menu: Date[], now: Date, lead: string): string { const tz = L.timezone || RILEY_TZ; const picks = menu.filter(x => !isAsap(x)).slice(0, 2); return picks.length ? `${lead} I can give you a quick call ${picks.map(x => sayWhen(x, now, tz)).join(' or ')}. Which works better for you?` : `${lead} What day and time are you usually parked? I'll work around your schedule.`; }
async function askBot(base44: any, L: any, menu: Date[], now: Date, discloseUpfront: boolean) {
  const convo: any[] = Array.isArray(L.conversation) ? L.conversation : [];
  const history = convo.slice(-20).map((m: any) => `${m.role === 'lead' ? String(L.first_name).toUpperCase() : 'RILEY'}: ${m.text}`).join('\n');
  const r = await base44.asServiceRole.integrations.Core.InvokeLLM({
    prompt: `${systemPrompt(L, menu, now, discloseUpfront)}\n\nCONVERSATION SO FAR (oldest first):\n${history}\n\nWrite Riley's next text message as JSON.`,
    response_json_schema: { type: 'object', properties: { reply: { type: 'string' }, intent: { type: 'string' }, book_slot: { type: 'string' }, handoff_reason: { type: 'string' }, summary: { type: 'string' } }, required: ['reply', 'intent'] },
  });
  const out = typeof r === 'string' ? JSON.parse(r) : r;
  out.reply = String(out.reply || '').replace(/\s+/g, ' ').trim().slice(0, 420);
  if (!out.book_slot || out.book_slot === 'null') out.book_slot = '';
  if (!out.handoff_reason || out.handoff_reason === 'null') out.handoff_reason = '';
  // Safety net on the honesty rule: never let a flat "not a bot" / "real person" claim go out.
  if (/\b(not a bot|i'?m not a bot|i am not a bot|not automated|not an? ai|i'?m (a )?real person|real human|i'?m human)\b/i.test(out.reply)) {
    out.reply = `It's my number and I'm the one who'll be calling you. I use a tool that helps me keep up with texts between calls, so if a reply comes back quick, that's why. When are you usually parked?`;
  }
  // First "no" never closes the file: level with them once (Riley's words), then let them answer. Only a second no (or heat / STOP, caught earlier) ends it.
  if (out.intent === 'not_interested' && !convo.some((x: any) => x.role === 'riley_bot' && LEVEL_RE.test(x.text || ''))) {
    const fam = familyPhrase(L.beneficiary_relationship || '', L.marital_status || '');
    out.reply = `I get it ${L.first_name}, most people aren't, and I'm not going to chase you. Let me just ask you straight though: if you passed away today, God forbid, would ${fam} be devastated financially? And if a wreck took you off the road for good, do you have income protection so the people who depend on you still have income?`;
    out.intent = 'continue'; out.guard = 'first no: leveled with them instead of closing the file';
  }
  // No ASAP slot -> the bot must not promise a call "in 15". Swap in a plain today/tomorrow offer instead.
  if (!menu.some(isAsap) && /finishing up with another driver|in about 15|in 15 (min|to)|call you in 15|in a few minutes/i.test(out.reply)) {
    out.reply = offerTwo(L, menu, now, `${L.first_name},`); out.guard = 'no ASAP slot: replaced 15-minute promise with a time offer';
    if (out.intent === 'book') out.intent = 'continue';
  }
  return out;
}

Deno.serve(async (req: Request) => {
  const base44 = createClientFromRequest(req);
  const svc = (base44 as any).asServiceRole.entities.RileyResparkLead;
  let body: any = {}; try { body = await req.json(); } catch (_) {}
  const now = body.simulate?.now ? new Date(body.simulate.now) : new Date();

  if (body.simulate) {
    const S = body.simulate;
    const first = S.first_name || 'Mike';
    const st = S.state || 'Texas';
    const L: any = { first_name: first, last_name: S.last_name || '', state: st, timezone: tzForState(st), driver_type: S.driver_type || 'Company Driver (W-2)', age: S.age || '44', marital_status: S.marital_status || 'Married', beneficiary_relationship: S.beneficiary_relationship || 'Spouse', iul_goal: S.iul_goal || '', phone: '+15555550100', status: S.status || 'conversing', appointment_at: S.appointment_at, lead_status: S.lead_status || '',
      conversation: [...(S.history || [{ role: 'riley_sequence', text: STEPS[0].text({ first, group: driverGroup(S.driver_type), married: true, state: st, fresh: /fresh/i.test(S.lead_status || '') }) }]), { role: 'lead', text: S.text }] };
    let menu: Date[] = [];
    try { menu = slotMenu(await freeSlots(await outlookToken(base44), now), now); } catch (e) { menu = []; }
    const out = await askBot(base44, L, menu, now, AI_DISCLOSE_STATES.includes(st.toLowerCase()));
    return Response.json({ simulate: true, now: fmtLocal(now, RILEY_TZ), slots_offered: menu.map(s => (isAsap(s) ? 'ASAP ' : '') + fmtLocal(s, L.timezone)), ...out });
  }

  // Test hook: book a specific lead record into a specific slot (or the first open slot) with full side effects.
  if (body.test_book && body.test_book.contact_id) {
    const L = (await svc.filter({ ghl_contact_id: body.test_book.contact_id }, '-created_date', 1))[0];
    if (!L) return Response.json({ error: 'no RileyResparkLead for that contact' }, { status: 404 });
    const token = await outlookToken(base44);
    const menu = slotMenu(await freeSlots(token, now), now);
    const slot = body.test_book.slot ? new Date(body.test_book.slot) : menu[0];
    if (!slot) return Response.json({ error: 'no open slot' }, { status: 400 });
    const tz = L.timezone || RILEY_TZ;
    const hasEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(L.email || '').trim());
    const convo: any[] = [...(L.conversation || []), { role: 'lead', text: body.test_book.lead_text || 'Yeah that time works for me', at: now.toISOString() }];
    const replyText = confirmationText(L, slot, hasEmail);
    await cancelBooking(token, L);
    const bk = await createBooking(token, L, slot, [...convo, { role: 'riley_bot', text: replyText }]);
    const P = PIPES[L.pipeline_id];
    if (L.ghl_opportunity_id && P) await ghl(`/opportunities/${L.ghl_opportunity_id}`, { method: 'PUT', body: JSON.stringify({ pipelineStageId: P.appointment }) });
    await addNote(L.ghl_contact_id, `RESPARK BOOKED (test hook) ${fmtLocal(slot, RILEY_TZ)}. Invite ${bk.inviteSent ? 'sent to ' + L.email : 'not sent'}.`);
    const s = await sendSms(L.ghl_contact_id, replyText);
    convo.push({ role: 'riley_bot', text: replyText, at: now.toISOString() });
    await alertRiley(`BOOKED (Respark bot, as you): ${L.first_name} ${L.last_name || ''} | ${L.phone} | ${fmtLocal(slot, RILEY_TZ)} | ${L.driver_type || ''} ${L.state || ''} | Invite ${bk.inviteSent ? 'sent to ' + L.email : 'not sent, no email'} | Prep block is on your calendar 15 min before with the full file and thread.`);
    await svc.update(L.id, { status: 'booked', appointment_at: slot.toISOString(), appointment_event_id: bk.eventId, prep_event_id: bk.prepEventId, invite_sent: bk.inviteSent, invite_response: bk.inviteSent ? 'none' : 'no_email', conversation: convo, last_sms_at: now.toISOString(), reminder_24h_sent: false, reminder_1h_sent: false, reminder_10m_sent: false, aidan_prep_sent: false, aidan_wrap_sent: false, post_appt_checked: false, lead_confirmed: false, seq_log: [...(L.seq_log || []), `${stamp()} TEST BOOK ${fmtLocal(slot, RILEY_TZ)}`] });
    return Response.json({ booked: fmtLocal(slot, tz), event_id: bk.eventId, prep_event_id: bk.prepEventId, invite_sent: bk.inviteSent, sms: s, confirmation: replyText });
  }

  const dryRun = body.dry_run === true;
  const summary: any = { dry_run: dryRun, checked: 0, scanned_threads: 0, replied: [], booked: [], handoffs: [], stopped: [], manual_takeover: [], deferred: [], waiting: [], errors: [] };

  // Entry points:
  //  (a) scheduled poll (no body): every enrolled lead, but only threads GHL says changed recently get opened (see below)
  //  (b) GHL "Customer Replied" workflow webhook: { contact_id | contactId | contact.id, token } -> that one lead, right now (instant speed-to-lead)
  //  (c) owner/internal: { contact_id, immediate }
  const hookContact = body.contact_id || body.contactId || body.contact?.id || (body.token ? body.id : '');
  const viaHook = !!(hookContact && body.token);
  if (hookContact && body.token && body.token !== REPLY_HOOK_TOKEN) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const immediate = body.immediate === true || viaHook;

  let leads: any[] = [];
  if (hookContact) leads = await svc.filter({ ghl_contact_id: hookContact }, '-created_date', 5);
  else for (const st of ['conversing', 'active', 'booked', 'handoff']) leads.push(...await svc.filter({ status: st }, '-updated_date', 500));

  // Cheap change detection for the poll: one location-wide conversation list sorted by last message (a few pages) instead of
  // one GHL search per lead. A thread is opened only if GHL shows activity after what we already processed. Once an hour
  // (minute < 5) we fall back to opening every thread, so nothing can hide behind a missed page.
  let recent: Map<string, { d: number; dir: string }> | null = null;
  const fullScan = hookContact || localParts(now, RILEY_TZ).mi < 5 || body.full_scan === true;
  if (!fullScan) {
    try {
      recent = new Map();
      const lookback = now.getTime() - RECENT_LOOKBACK_MS;
      for (let page = 0, sa: any = null; page < 8; page++) {
        const q = `/conversations/search?locationId=${LOC}&sortBy=last_message_date&sort=desc&limit=100` + (sa ? `&startAfterDate=${sa}` : '');
        const r = (await ghl(q, {}, '2021-04-15')).json; const list: any[] = r.conversations || [];
        for (const cv of list) { const d = Number(cv.lastMessageDate) || 0; if (cv.contactId && d > (recent.get(cv.contactId)?.d || 0)) recent.set(cv.contactId, { d, dir: String(cv.lastMessageDirection || '') }); }
        const last = list[list.length - 1]; if (!list.length || !last || (Number(last.lastMessageDate) || 0) < lookback) break;
        sa = last.lastMessageDate;
      }
      summary.recent_threads = recent.size;
    } catch (e) { recent = null; summary.errors.push(`recent-scan failed, full scan: ${String(e).slice(0, 100)}`); }
  }

  let token = ''; let menu: Date[] | null = null;
  const getMenu = async () => { if (menu) return menu; token = token || await outlookToken(base44); menu = slotMenu(await freeSlots(token, now), now); return menu; };
  const started = Date.now();

  for (const L of leads) {
    if (Date.now() - started > TIME_BUDGET_MS) { summary.time_budget_hit = true; break; }
    if ((L.messages_sent || 0) === 0 && L.status === 'active') continue;
    if (L.status === 'manual' || L.status === 'stopped' || L.status === 'completed') continue;
    summary.checked++;
    const tz = L.timezone || RILEY_TZ;
    const log: string[] = Array.isArray(L.seq_log) ? [...L.seq_log] : [];
    try {
      const since = Math.max(Number(L.last_inbound_ms) || 0, L.enrolled_at ? new Date(L.enrolled_at).getTime() : 0);
      if (recent) {
        const r = recent.get(L.ghl_contact_id); const lastSms = L.last_sms_at ? new Date(L.last_sms_at).getTime() : 0;
        if (!r || r.d <= Math.max(since, lastSms)) continue;                                   // nothing new in this thread
        if (r.dir === 'outbound' && r.d - lastSms < 120000) continue;                            // latest message is the text we just sent (GHL stamps it a moment after we do)
      }
      summary.scanned_threads++;
      const { inbound, manual } = await scanThread(L.ghl_contact_id, since, L.conversation || []);
      // Riley jumped into the thread himself -> the bot goes quiet on this lead
      if (manual.length) { summary.manual_takeover.push(L.phone); if (!dryRun) await markManualTakeover(svc, L, log, manual); continue; }
      if (!inbound.length) continue;
      // Human-touch delay before answering: webhook/immediate = none (GHL already waited a minute), fresh leads 1 min, everyone else 2-6 min.
      const lastInAt = inbound[inbound.length - 1].at;
      const delayMin = immediate ? 0 : /fresh/i.test(L.lead_status || '') ? 1 : 2 + (hashStr(L.ghl_contact_id + lastInAt) % 5);
      if (now.getTime() - lastInAt < delayMin * 60000) { summary.waiting.push(`${L.phone} (${delayMin}m)`); continue; }
      const lp = localParts(now, tz);
      if (lp.h < REPLY_HOUR_START || lp.h >= REPLY_HOUR_END) { summary.deferred.push(L.phone); continue; }
      const convo: any[] = Array.isArray(L.conversation) ? [...L.conversation] : [];
      for (const m of inbound) convo.push({ role: 'lead', text: m.text, at: new Date(m.at).toISOString() });
      const lastMs = lastInAt;
      const latestText = inbound.map(m => m.text).join(' ');
      const firstReply = (L.reply_count || 0) === 0;
      const base: any = { conversation: convo, last_inbound_ms: lastMs, last_inbound_at: new Date(lastMs).toISOString(), reply_count: (L.reply_count || 0) + inbound.length };

      if (inbound.some(m => isOptOut(m.text))) {
        log.push(`${stamp()} lead texted STOP; DND set`); summary.stopped.push(`${L.phone} STOP`);
        if (!dryRun) {
          await ghl(`/contacts/${L.ghl_contact_id}`, { method: 'PUT', body: JSON.stringify({ dndSettings: { SMS: { status: 'active', message: 'Replied STOP to Respark text' } } }) });
          await removeTags(L.ghl_contact_id, ['Respark Active']); await addTags(L.ghl_contact_id, ['Respark Stopped', 'SMS Opt-Out']);
          await svc.update(L.id, { ...base, status: 'stopped', stop_reason: 'lead replied STOP', next_send_at: null, seq_log: log });
        }
        continue;
      }
      if (L.status === 'handoff') {
        log.push(`${stamp()} new text while in handoff: "${latestText.slice(0, 60)}"`);
        if (!dryRun) { await alertRiley(`${L.first_name} ${L.last_name || ''} (${L.phone}) texted again, you have this one: "${latestText.slice(0, 200)}"`); await svc.update(L.id, { ...base, seq_log: log }); }
        continue;
      }

      const discloseUpfront = AI_DISCLOSE_STATES.includes((L.state || '').toLowerCase()) && (L.ashley_turns || 0) === 0;
      const m = await getMenu();
      const out = await askBot(base44, { ...L, conversation: convo }, m, now, discloseUpfront);
      let intent = String(out.intent || 'continue');
      let replyText = out.reply;
      const upd: any = { ...base, intent, ashley_turns: (L.ashley_turns || 0) + 1, next_send_at: null };
      const menuIso = new Set(m.map(s => s.toISOString()));
      if (L.status === 'booked' && /^(y(es|ep|eah|up)|ok(ay)?|sounds good|still good|see you|confirmed|we'?re good|i'?m good|good to go|10-4|all good)\b/i.test(latestText.trim()) && intent === 'continue') { upd.lead_confirmed = true; log.push(`${stamp()} lead confirmed the appointment`); }
      if (L.status === 'booked' && intent === 'continue') upd.status = 'booked';

      // Guard: no booking unless the lead actually agreed (bot offered times before, or their words name a time / say yes)
      const botOfferedBefore = convo.some((x: any) => x.role === 'riley_bot' && x.at && new Date(x.at).getTime() < lastMs);
      const leadNamedTime = TIME_RE.test(latestText);
      // No booking unless the lead agreed to something already offered, or named a time / asked for a call themselves
      if (intent === 'book' && !(botOfferedBefore || leadNamedTime)) {
        log.push(`${stamp()} bot wanted to book off "${latestText.slice(0, 40)}" before offering a time; downgraded to a two-time offer`);
        intent = 'continue'; upd.intent = intent;
        replyText = offerTwo(L, m, now, `Gotcha ${L.first_name}.`);
      }
      if (intent === 'book' && out.book_slot && menuIso.has(new Date(out.book_slot).toISOString())) {
        const slot = m.find(x => x.toISOString() === new Date(out.book_slot).toISOString())!;
        const asapBook = isAsap(slot);
        const hasEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(L.email || '').trim());
        replyText = confirmationText(L, slot, hasEmail);
        if (!dryRun) {
          token = token || await outlookToken(base44);
          await cancelBooking(token, L);
          const bk = await createBooking(token, L, slot, [...convo, { role: 'riley_bot', text: replyText }]);
          upd.appointment_event_id = bk.eventId; upd.prep_event_id = bk.prepEventId; upd.invite_sent = bk.inviteSent; upd.invite_response = bk.inviteSent ? 'none' : 'no_email';
          const P = PIPES[L.pipeline_id];
          if (L.ghl_opportunity_id && P) await ghl(`/opportunities/${L.ghl_opportunity_id}`, { method: 'PUT', body: JSON.stringify({ pipelineStageId: P.appointment }) });
          await removeTags(L.ghl_contact_id, ['Respark Active']); await addTags(L.ghl_contact_id, ['Respark Booked']);
          await addNote(L.ghl_contact_id, `RESPARK BOOKED ${fmtLocal(slot, RILEY_TZ)} (${fmtLocal(slot, tz)} lead time). Booked by the Respark text bot in Riley's voice. Invite ${bk.inviteSent ? 'sent to ' + L.email : 'NOT sent (no email on file)'}. Summary: ${out.summary || ''}\nThread:\n${convo.slice(-12).map((m: any) => `${m.role === 'lead' ? L.first_name : 'Riley'}: ${m.text}`).join('\n')}`);
          await alertRiley(asapBook
            ? `CALL IN ${ASAP_LEAD_MIN} MIN (${fmtLocal(slot, RILEY_TZ, false)}): ${L.first_name} ${L.last_name || ''} | ${L.phone} | ${L.driver_type || ''} ${L.state || ''} | They said yes to "finishing up with another driver, can I call you in 15?" so they're expecting you. ${out.summary || ''}\nLast texts:\n${convo.slice(-6).map((x: any) => `${x.role === 'lead' ? L.first_name : 'You'}: ${x.text}`).join('\n')}`
            : `BOOKED (Respark bot, as you): ${L.first_name} ${L.last_name || ''} | ${L.phone} | ${fmtLocal(slot, RILEY_TZ)} | ${L.driver_type || ''} ${L.state || ''} | Invite ${bk.inviteSent ? 'sent to ' + L.email : 'not sent, no email'} | ${out.summary || ''} | Prep block is on your calendar 15 min before with the full file and thread.`);
        }
        upd.status = 'booked'; upd.appointment_at = slot.toISOString(); upd.reminder_24h_sent = asapBook; upd.reminder_1h_sent = asapBook; upd.reminder_10m_sent = false; upd.aidan_prep_sent = false; upd.post_appt_checked = false; upd.lead_confirmed = asapBook;
        log.push(`${stamp()} booked ${fmtLocal(slot, RILEY_TZ)}${asapBook ? ' (ASAP, call in 15)' : ''}`); summary.booked.push(`${L.first_name} ${L.phone} ${fmtLocal(slot, RILEY_TZ)}`);
      } else if (intent === 'book') { intent = 'continue'; upd.intent = intent; }

      if (intent === 'cancel_appointment' && L.status === 'booked') {
        if (!dryRun) {
          token = token || await outlookToken(base44); await cancelBooking(token, L);
          if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(L.email || '').trim())) { try { await sendEmail(L.ghl_contact_id, 'Your call with Riley has been cancelled', cancellationEmailHtml(L, new Date(L.appointment_at))); } catch (_) {} }
          const P = PIPES[L.pipeline_id]; if (L.ghl_opportunity_id && P) await ghl(`/opportunities/${L.ghl_opportunity_id}`, { method: 'PUT', body: JSON.stringify({ pipelineStageId: P.newLead[0] }) });
          await alertRiley(`${L.first_name} ${L.last_name || ''} (${L.phone}) CANCELLED the call that was ${fmtLocal(new Date(L.appointment_at), RILEY_TZ)}. ${out.summary || ''}`);
        }
        upd.status = 'conversing'; upd.appointment_at = null; upd.appointment_event_id = null; upd.prep_event_id = null; log.push(`${stamp()} appointment cancelled by lead`);
      }
      if (intent === 'reschedule' && L.status === 'booked') {
        if (!dryRun) { token = token || await outlookToken(base44); await cancelBooking(token, L); }
        upd.status = 'conversing'; upd.appointment_at = null; upd.appointment_event_id = null; upd.prep_event_id = null; log.push(`${stamp()} lead wants to reschedule; old event removed`);
      }
      if (intent === 'not_interested') {
        upd.status = 'stopped'; upd.stop_reason = 'not interested (told the bot)';
        if (!dryRun) { const P = PIPES[L.pipeline_id]; if (L.ghl_opportunity_id && P) await ghl(`/opportunities/${L.ghl_opportunity_id}`, { method: 'PUT', body: JSON.stringify({ pipelineStageId: P.notInterested }) });
          await removeTags(L.ghl_contact_id, ['Respark Active']); await addTags(L.ghl_contact_id, ['Respark Not Interested']); }
        log.push(`${stamp()} not interested`); summary.stopped.push(`${L.phone} not interested`);
      }
      if (intent === 'wrong_person') {
        upd.status = 'stopped'; upd.stop_reason = 'wrong number / not a driver';
        if (!dryRun) { await removeTags(L.ghl_contact_id, ['Respark Active']); await addTags(L.ghl_contact_id, ['Respark Wrong Number']); }
        log.push(`${stamp()} wrong person`); summary.stopped.push(`${L.phone} wrong person`);
      }
      if (intent === 'handoff' || (intent === 'continue' && upd.ashley_turns >= MAX_BOT_TURNS)) {
        upd.status = 'handoff';
        const wantsCall = /call now|wants a call/i.test(out.handoff_reason || '');
        if (!dryRun) await alertRiley(`${wantsCall ? 'CALL THEM NOW' : 'HANDOFF'} ${L.first_name} ${L.last_name || ''} | ${L.phone} | ${L.driver_type || ''} ${L.state || ''}\nWhy: ${out.handoff_reason || 'conversation needs you'}\nThey said: "${latestText.slice(0, 160)}"\nBot replied as you: "${replyText.slice(0, 120)}"\nYou own this thread now (GHL).`);
        log.push(`${stamp()} handed off to Riley: ${out.handoff_reason || ''}`); summary.handoffs.push(`${L.first_name} ${L.phone}: ${out.handoff_reason || ''}`);
      }
      if (!upd.status) upd.status = 'conversing';

      if (replyText) {
        if (dryRun) summary.replied.push(`${L.first_name} ${L.phone} [${intent}] "${latestText.slice(0, 40)}" -> "${replyText.slice(0, 80)}"`);
        else {
          const s = await sendSms(L.ghl_contact_id, replyText);
          if (s.ok) { convo.push({ role: 'riley_bot', text: replyText, at: now.toISOString() }); upd.conversation = convo; upd.last_sms_at = now.toISOString(); log.push(`${stamp()} bot as Riley [${intent}]: "${replyText.slice(0, 70)}"`); summary.replied.push(`${L.first_name} ${L.phone} [${intent}]`); }
          else { log.push(`${stamp()} bot reply FAILED ${s.err}`); summary.errors.push(`${L.phone} send ${s.err}`); }
        }
      }
      if (firstReply && !dryRun && intent !== 'handoff' && intent !== 'book') await alertRiley(`Respark REPLY from ${L.first_name} ${L.last_name || ''} (${L.phone}, ${L.driver_type || ''} ${L.state || ''}): "${latestText.slice(0, 160)}" | Bot is answering as you. Text them yourself from GHL any time and it goes quiet. ${out.summary || ''}`);
      if (!dryRun) { await removeTags(L.ghl_contact_id, ['Respark Active']); await addTags(L.ghl_contact_id, ['Respark Replied']); await svc.update(L.id, { ...upd, seq_log: log }); }
    } catch (e) { summary.errors.push(`${L.phone}: ${String(e).slice(0, 200)}`); }
  }
  summary.replied_count = summary.replied.length;
  return Response.json({ success: true, ...summary });
});
