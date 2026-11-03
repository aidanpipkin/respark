// Respark appointment flow. Runs every 5 minutes. For every booked lead it runs the reminder sequence for the LEAD (in Riley's voice)
// and for RILEY, (GHL calendar build: no invite acceptance tracking), and handles the post-appointment outcome.
//
// LEAD (their local time):          RILEY (CT):
//   T-24h  "quick reminder, tomorrow at X" (only if booked on an earlier day, quiet 3h)   T-30m  prep brief text (file highlights, thread summary, invite status)
//          (+ nudge to accept invite if not accepted)   T+45m  wrap-up nudge if the opp is still in the Appointment stage
//   T-1h   "calling you in about an hour"
//   T-10m  "about to call, may show as a different number"
// POST-APPOINTMENT: if Riley moved the opp back to New Lead/Contacted -> treated as no-show -> lead gets a reschedule text and the
// reply bot takes over. Any other stage move -> done. Still in Appointment after 24h -> marked done, Riley nudged once.
// Modes: { dry_run: true }, { contact_id } (one lead only).
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


const MIN = 60000, HOUR = 3600000;

Deno.serve(async (req: Request) => {
  const base44 = createClientFromRequest(req);
  const svc = (base44 as any).asServiceRole.entities.RileyResparkLead;
  let body: any = {}; try { body = await req.json(); } catch (_) {}
  const dryRun = body.dry_run === true;
  const now = new Date();
  const summary: any = { dry_run: dryRun, checked: 0, lead_texts: [], riley_texts: [], invite_updates: [], outcomes: [], errors: [] };

  let booked: any[] = body.contact_id ? await svc.filter({ ghl_contact_id: body.contact_id }, '-created_date', 5) : await svc.filter({ status: 'booked' }, 'appointment_at', 300);
  booked = booked.filter((L: any) => L.status === 'booked' && L.appointment_at);
  let token = '';
  const tok = async () => (token = token || await outlookToken(base44));

  for (const L of booked) {
    summary.checked++;
    const tz = L.timezone || RILEY_TZ;
    const appt = new Date(L.appointment_at);
    const msTo = appt.getTime() - now.getTime();
    const log: string[] = Array.isArray(L.seq_log) ? [...L.seq_log] : [];
    const upd: any = {};
    const push = (text: string, flag: string) => ({ text, flag });
    try {
      // Invite response tracking (only while upcoming and sent)
      if (L.invite_sent && L.appointment_event_id && msTo > -HOUR && L.invite_response !== 'accepted') {
        const resp = await inviteResponse(await tok(), L.appointment_event_id, L.email);
        if (resp !== L.invite_response && resp !== 'unknown') { upd.invite_response = resp; summary.invite_updates.push(`${L.first_name}: ${resp}`); log.push(`${stamp()} invite response: ${resp}`); }
      }
      const inviteOk = (upd.invite_response || L.invite_response) === 'accepted';
      const lp = localParts(now, tz);
      const daytime = lp.h >= 8 && lp.h < 21;
      const zoom = L.meeting_mode === 'zoom' && !!L.zoom_link;

      // ---- LEAD reminders ----
      // Rules (Oct 23): light touch, never a confirmation demand.
      //  1. Nothing goes out within 3 hours of the last text we sent them; the booking confirmation counts, so a same-day booking never
      //     gets a "still good?" five minutes after "you're set".
      //  2. The day-before reminder only exists when the call is on a later calendar day than today (their time).
      //  3. At most one of the T-1h / T-10m texts: T-1h when it has been quiet long enough, otherwise just the short T-10m heads up.
      const sinceLast = now.getTime() - new Date(L.last_sms_at || 0).getTime();
      const quiet3h = sinceLast >= 3 * HOUR;
      const ap = localParts(appt, tz);
      const laterDay = Date.UTC(ap.y, ap.mo - 1, ap.d) > Date.UTC(lp.y, lp.mo - 1, lp.d);
      const dayAfter = Date.UTC(ap.y, ap.mo - 1, ap.d) - Date.UTC(lp.y, lp.mo - 1, lp.d) === 86400000;
      const timeOnly = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(appt);
      const whenWord = dayAfter ? `tomorrow at ${timeOnly}` : fmtLocal(appt, tz);
      let leadMsg: { text: string; flag: string } | null = null;
      if (!L.reminder_24h_sent && msTo <= 24 * HOUR && msTo > 3 * HOUR && daytime && laterDay && quiet3h) {
        leadMsg = zoom
          ? push(`Hey ${L.first_name}, Riley here. Quick reminder, we're on Zoom ${whenWord}${L.additional_attendees ? ` with ${L.additional_attendees.replace(/^(his|her|their)\s+/i, 'your ')}` : ''}. Link: ${L.zoom_link} . If anything comes up just text me and we'll move it.`, 'reminder_24h_sent')
          : push(`Hey ${L.first_name}, Riley here. Quick reminder, we're on for ${whenWord} and I'll call you at this number. If anything comes up just text me and we'll move it.`, 'reminder_24h_sent');
      } else if (!L.reminder_1h_sent && msTo <= HOUR && msTo > 20 * MIN && quiet3h) {
        leadMsg = zoom
          ? push(`${L.first_name}, Zoom in about an hour (${timeOnly}): ${L.zoom_link} . If the video gives you trouble I'll just call you at this number. Riley`, 'reminder_1h_sent')
          : push(`${L.first_name}, I'll be calling you at ${timeOnly}, about an hour from now. Talk soon. Riley`, 'reminder_1h_sent');
        if (!L.reminder_24h_sent) upd.reminder_24h_sent = true;
      } else if (!L.reminder_10m_sent && msTo <= 10 * MIN && msTo > -5 * MIN) {
        if (L.reminder_1h_sent) { upd.reminder_10m_sent = true; log.push(`${stamp()} T-10m skipped (T-1h already sent)`); }
        else if (sinceLast < 30 * MIN) { upd.reminder_10m_sent = true; log.push(`${stamp()} T-10m skipped (texted them ${Math.round(sinceLast / MIN)} min ago)`); }
        else leadMsg = zoom
          ? push(`${L.first_name}, hopping on Zoom in a few minutes: ${L.zoom_link} . Riley`, 'reminder_10m_sent')
          : push(`${L.first_name}, calling you in a few minutes. It might show up from a different number than this one, so go ahead and pick up. Riley`, 'reminder_10m_sent');
        if (!L.reminder_24h_sent) upd.reminder_24h_sent = true; if (!L.reminder_1h_sent) upd.reminder_1h_sent = true;
      }
      if (leadMsg) {
        if (dryRun) summary.lead_texts.push(`${L.first_name} ${L.phone} [${leadMsg.flag}] ${leadMsg.text.slice(0, 70)}`);
        else {
          const s = await sendSms(L.ghl_contact_id, leadMsg.text);
          if (s.ok && leadMsg.flag === 'reminder_24h_sent' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(L.email || '').trim())) { try { await sendEmail(L.ghl_contact_id, `Reminder: your call with Riley is tomorrow`, reminderEmailHtml(L, appt)); log.push(`${stamp()} reminder email sent`); } catch (_) {} }
          if (s.ok) { upd[leadMsg.flag] = true; upd.conversation = [...(L.conversation || []), { role: 'riley_bot', text: leadMsg.text, at: now.toISOString() }]; upd.last_sms_at = now.toISOString(); log.push(`${stamp()} ${leadMsg.flag} sent`); summary.lead_texts.push(`${L.first_name} ${leadMsg.flag}`); }
          else { log.push(`${stamp()} ${leadMsg.flag} FAILED ${s.err}`); summary.errors.push(`${L.phone} ${leadMsg.flag} ${s.err}`); }
        }
      }

      // ---- RILEY prep brief (T-30m) ----
      if (!L.aidan_prep_sent && msTo <= 30 * MIN && msTo > 5 * MIN) {
        const f = L.profile || {};
        const hi = [L.driver_type, L.age ? `age ${L.age}` : '', L.marital_status, L.beneficiary_relationship ? `beneficiary ${L.beneficiary_relationship}` : '', L.iul_goal ? `goal ${L.iul_goal}` : '', f['Coverage Amount desired'] ? `wants ${f['Coverage Amount desired']}` : '', f['Health History'] ? `health: ${f['Health History']}` : '', f['Have Life Insurance'] ? `has coverage: ${f['Have Life Insurance']}` : ''].filter(Boolean).join(', ');
        const lastLead = [...(L.conversation || [])].reverse().find((m: any) => m.role === 'lead');
        const confirmed = L.lead_confirmed ? 'confirmed the time' : 'has not replied to the reminder (none was required)';
        const t = `${zoom ? 'ZOOM' : 'CALL'} IN 30 MIN: ${L.first_name} ${L.last_name || ''} ${L.phone} at ${fmtLocal(appt, RILEY_TZ, false)} (${fmtLocal(appt, tz, false)} their time).${zoom ? ` Zoom ${L.zoom_link}.` : ''}${L.additional_attendees ? ` Joining: ${L.additional_attendees}.` : ''}${L.booking_notes ? ` Your notes: ${L.booking_notes}.` : ''} ${hi}. ${L.state || ''}${L.city ? ', ' + L.city : ''}. Lead ${confirmed}. Last thing they said: "${(lastLead?.text || '').slice(0, 120)}". Full file + text thread are in the PREP note on their GHL contact.`;
        if (dryRun) summary.riley_texts.push(`prep ${L.first_name}: ${t.slice(0, 80)}`);
        else { await alertRiley(t); upd.aidan_prep_sent = true; log.push(`${stamp()} Riley prep brief sent`); summary.riley_texts.push(`prep ${L.first_name}`); }
      }

      // ---- POST appointment ----
      if (msTo <= -45 * MIN && !L.post_appt_checked) {
        const P = PIPES[L.pipeline_id];
        let stage = ''; let opp: any = null;
        if (L.ghl_opportunity_id) { opp = (await ghl(`/opportunities/${L.ghl_opportunity_id}`)).json.opportunity; stage = opp?.pipelineStageId || ''; }
        const stillAppt = P && stage === P.appointment && opp?.status === 'open';
        const backToNew = P && P.newLead.includes(stage);
        if (backToNew) {
          // Riley marked it a no-show -> offer a new time, reply bot takes over
          const t = `${L.first_name}, ${zoom ? 'looks like we missed each other on Zoom at' : 'tried you at'} ${fmtLocal(appt, tz, false)}, no worries at all, I know the schedule changes on you. Want to grab another time? Morning or afternoon usually better?`;
          if (!dryRun) { const s = await sendSms(L.ghl_contact_id, t); if (s.ok) { upd.conversation = [...(upd.conversation || L.conversation || []), { role: 'riley_bot', text: t, at: now.toISOString() }]; upd.last_sms_at = now.toISOString(); } }
          upd.status = 'conversing'; upd.appointment_at = null; upd.post_appt_checked = true;
          if (!dryRun) { await cancelBooking(await tok(), L); await removeTags(L.ghl_contact_id, ['Respark Booked']); await addTags(L.ghl_contact_id, ['Respark No-Show']); }
          upd.appointment_event_id = null; upd.prep_event_id = null;
          log.push(`${stamp()} no-show (opp moved back to New Lead); reschedule text sent`); summary.outcomes.push(`${L.first_name}: no-show, rebooking`);
        } else if (!stillAppt) {
          upd.status = 'completed'; upd.stop_reason = `appointment held, Riley moved opp (stage ${stage || 'n/a'})`; upd.post_appt_checked = true;
          if (!dryRun) { await removeTags(L.ghl_contact_id, ['Respark Booked']); await addTags(L.ghl_contact_id, ['Respark Appointment Done']); }
          log.push(`${stamp()} appointment outcome handled by Riley`); summary.outcomes.push(`${L.first_name}: done`);
        } else if (!L.aidan_wrap_sent) {
          const t = `Wrap-up: your ${fmtLocal(appt, RILEY_TZ, false)} call with ${L.first_name} ${L.last_name || ''} (${L.phone}) is still sitting in the Appointment stage. If you connected, move them forward. If they no-showed, drag them back to New Lead and I'll text them for a new time within the hour.`;
          if (!dryRun) { await alertRiley(t); upd.aidan_wrap_sent = true; }
          summary.riley_texts.push(`wrap ${L.first_name}`); log.push(`${stamp()} Riley wrap-up nudge sent`);
          if (msTo <= -24 * HOUR) { upd.status = 'completed'; upd.stop_reason = 'appointment passed, no stage change in 24h'; upd.post_appt_checked = true; summary.outcomes.push(`${L.first_name}: closed out after 24h`); }
        } else if (msTo <= -24 * HOUR) {
          upd.status = 'completed'; upd.stop_reason = 'appointment passed, no stage change in 24h'; upd.post_appt_checked = true; summary.outcomes.push(`${L.first_name}: closed out after 24h`);
        }
      }

      if (!dryRun && Object.keys(upd).length) await svc.update(L.id, { ...upd, seq_log: log });
    } catch (e) { summary.errors.push(`${L.phone}: ${String(e).slice(0, 160)}`); }
  }
  return Response.json({ success: true, ...summary });
});
