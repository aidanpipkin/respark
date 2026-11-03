// Respark enroller. Runs every 30 minutes (7am-9pm CT). Finds fresh trucker leads that Riley has been calling with no pickup and no text reply,
// and enrolls them into the 30-day Respark text sequence (RileyResparkLead entity). Idempotent.
// Criteria: opportunity open in a New Lead stage of an in-scope pipeline, contact added >= MIN_AGE_DAYS ago, has phone + first name,
// not DND, not "Not a Trucker", no inbound SMS ever, not already enrolled.
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


const MIN_AGE_DAYS = 3;
// Pipelines where Riley drops leads in by hand and wants them texting right away (no age gate, fresh track, first text within minutes inside the window).
const MIN_AGE_DAYS_BY_PIPE: Record<string, number> = { kq9QT4chftvYo3oth31j: 0 };   // Riley Fresh Premium Truckers

Deno.serve(async (req: Request) => {
  const base44 = createClientFromRequest(req);
  const svc = (base44 as any).asServiceRole.entities.RileyResparkLead;
  let body: any = {}; try { body = await req.json(); } catch (_) {}
  const dryRun = body.dry_run === true;
  const limit = body.limit || 500;
  const onlyContactIds: string[] | null = Array.isArray(body.contact_ids) ? body.contact_ids : null;
  const now = new Date();
  const cfNames = await cfNameMap();

  // Refresh mode: rebuild the profile on existing RileyResparkLead records (no enrollment)
  if (body.refresh_profiles) {
    const out: any = { refreshed: 0, errors: [] as string[] };
    const all: any[] = [];
    for (let skip = 0; ; skip += 500) { const page = await svc.list('-created_date', 500, skip); all.push(...page); if (page.length < 500) break; }
    for (const L of all) {
      if (body.contact_id && L.ghl_contact_id !== body.contact_id) continue;
      try {
        const c = (await ghl(`/contacts/${L.ghl_contact_id}`)).json.contact || {};
        if (!c.id) { out.errors.push(`${L.ghl_contact_id}: contact not found`); continue; }
        const pr = await buildProfile(base44, c, cfNames);
        await svc.update(L.id, { profile: pr.fields, lead_status: (/fresh/i.test(L.lead_status || '') && !/fresh/i.test(pr.lead_status || '')) ? L.lead_status : pr.lead_status, requested_at: pr.requested_at, city: pr.city, gender: pr.gender, iul_goal: pr.iul_goal, dob: pr.dob,
          age: L.age || pr.age, marital_status: L.marital_status || pr.marital, beneficiary_relationship: L.beneficiary_relationship || pr.beneficiary, driver_type: L.driver_type || pr.driver_type });
        out.refreshed++;
      } catch (e) { out.errors.push(`${L.ghl_contact_id}: ${String(e).slice(0, 120)}`); }
    }
    return Response.json({ success: true, ...out });
  }

  // Existing enrollments
  const existing: any[] = [];
  for (let skip = 0; ; skip += 500) { const page = await svc.list('-created_date', 500, skip); existing.push(...page); if (page.length < 500) break; }
  const enrolled = new Set(existing.map((e: any) => e.ghl_contact_id));

  const summary: any = { dry_run: dryRun, scanned: 0, enrolled: [], skipped: {} as Record<string, number>, errors: [] as string[] };
  const skip = (k: string) => { summary.skipped[k] = (summary.skipped[k] || 0) + 1; };

  for (const [pipeId, P] of Object.entries(PIPES)) {
    let sa: any = null, sid: any = null;
    const opps: any[] = [];
    while (true) {
      const q = `/opportunities/search?location_id=${LOC}&pipeline_id=${pipeId}&status=open&limit=100` + (sa ? `&startAfter=${sa}&startAfterId=${sid}` : '');
      const r = await ghl(q); const o = r.json.opportunities || []; opps.push(...o);
      const m = r.json.meta || {}; if (!o.length || !m.startAfterId) break; sa = m.startAfter; sid = m.startAfterId;
    }
    for (const o of opps) {
      if (summary.enrolled.length >= limit) break;
      if (!P.newLead.includes(o.pipelineStageId)) continue;
      summary.scanned++;
      const cid = o.contactId;
      if (onlyContactIds && !onlyContactIds.includes(cid)) continue;
      if (enrolled.has(cid)) { skip('already_enrolled'); continue; }
      try {
        const c = (await ghl(`/contacts/${cid}`)).json.contact || {};
        const cf: Record<string, any> = {}; for (const f of (c.customFields || [])) cf[f.id] = f.value;
        const first = (c.firstName || '').trim();
        if (!first || !c.phone) { skip('no_name_or_phone'); continue; }
        const added = c.dateAdded ? new Date(c.dateAdded) : null;
        const minAge = MIN_AGE_DAYS_BY_PIPE[pipeId] ?? MIN_AGE_DAYS;
        if (!added || (now.getTime() - added.getTime()) < minAge * 86400000) { skip('too_new'); continue; }
        const smsDnd = c.dnd === true || c.dndSettings?.SMS?.status === 'active';
        const tags: string[] = (c.tags || []).map((t: string) => t.toLowerCase());
        if (smsDnd || tags.some(t => t.includes('unsub') || t === 'dnd' || t.includes('stop'))) { skip('dnd'); continue; }
        const driverType = String(cf[CF.driver_type] || '');
        if (driverType.toLowerCase().includes('not a trucker')) { skip('not_a_trucker'); continue; }
        // any inbound SMS ever?
        const convs = (await ghl(`/conversations/search?locationId=${LOC}&contactId=${cid}`, {}, '2021-04-15')).json.conversations || [];
        let hasInbound = false;
        for (const cv of convs) {
          if (cv.lastMessageDirection === 'inbound' && String(cv.lastMessageType || '').includes('SMS')) { hasInbound = true; break; }
          if (String(cv.lastMessageType || '').includes('SMS') || cv.type === 'TYPE_PHONE') {
            const ms = (await ghl(`/conversations/${cv.id}/messages?limit=100`, {}, '2021-04-15')).json;
            const list: any[] = ms.messages?.messages || ms.messages || [];
            if (list.some((m: any) => m.direction === 'inbound' && String(m.messageType || m.type || '').includes('SMS'))) { hasInbound = true; break; }
          }
        }
        if (hasInbound) { skip('already_replied'); continue; }

        const state = c.state || cf['EN8XwsxErZ5KDoCw9DZt'] || '';
        const tz = tzForState(state);
        const pr = await buildProfile(base44, c, cfNames);
        // Hand-dropped leads (no-age-gate pipelines) are treated as fresh: first text goes out now if we're inside the window, otherwise at the next opening.
        const handDropped = minAge === 0;
        const first_send = handDropped ? (inSendWindow(now, tz, state) ? new Date(now.getTime() + 60000) : nextSendWindowStart(now, tz, state)) : scheduleLocal(now, 0, STEPS[0].h, STEPS[0].mi, tz);
        if (handDropped && !/fresh/i.test(pr.lead_status || '')) pr.lead_status = `Fresh Lead (${P.name} drop)${pr.lead_status ? ' / ' + pr.lead_status : ''}`;
        const rec = {
          ghl_contact_id: cid, ghl_opportunity_id: o.id, pipeline_id: pipeId,
          first_name: first.charAt(0).toUpperCase() + first.slice(1).toLowerCase(), last_name: c.lastName || '', phone: c.phone, email: c.email || '',
          state, timezone: tz, driver_type: driverType, age: String(cf[CF.age] || pr.age || ''), marital_status: String(cf[CF.marital] || pr.marital || ''), beneficiary_relationship: String(cf[CF.beneficiary_rel] || pr.beneficiary || ''),
          city: pr.city, gender: pr.gender, dob: pr.dob, iul_goal: pr.iul_goal, lead_status: pr.lead_status, requested_at: pr.requested_at, profile: pr.fields,
          lead_added_date: c.dateAdded, enrolled_at: now.toISOString(), status: 'active', step: 0, messages_sent: 0, reply_count: 0, ashley_turns: 0,
          next_send_at: first_send.toISOString(), conversation: [], seq_log: [`${stamp()} enrolled (${P.name}); first text ${fmtLocal(first_send, tz)}`],
        };
        if (!dryRun) { await svc.create(rec); await addTags(cid, ['Respark Active']); enrolled.add(cid); }
        summary.enrolled.push(`${rec.first_name} ${rec.last_name} ${rec.phone} ${state} -> ${fmtLocal(first_send, tz)}`);
      } catch (e) { summary.errors.push(`${cid}: ${String(e).slice(0, 150)}`); }
    }
  }
  summary.enrolled_count = summary.enrolled.length;
  return Response.json({ success: true, ...summary });
});
