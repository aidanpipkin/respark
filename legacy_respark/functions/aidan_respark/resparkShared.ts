// Shared constants + helpers for the Respark campaign (copied into each function at deploy time).
export const GHL_API_KEY = Deno.env.get('GHL_API_KEY') || '';
export const LOC = 'P1m006Mt7YCXCAdiBBxC';
export const AIDAN_CONTACT_ID = 'hLZmFD5Azf8WHCpBuk0d';
export const AIDAN_EMAIL = 'aidan@usnaturalinsurance.com';
export const AIDAN_TZ = 'America/Chicago';

// Pipelines in scope (Respark SMS sequence). NOTE: Gold Mailers (9spUMGcl4sx6oT8JJ7oC) is deliberately NOT here so the enroller never texts
// general-life mailer leads; aidanBook and the deployed (lean) resparkAppointmentFlow carry it separately for appointment handling.
export const PIPES: Record<string, { name: string; newLead: string[]; appointment: string; notInterested: string }> = {
  yl3k1RNrJ3OILc8Yj45R: { name: 'Goat Fresh Premium Truckers', newLead: ['bba15ec1-5be3-49f8-85d9-f77c3e12d1bf'], appointment: '54c64708-d80a-4f17-99dd-f41577fabe3d', notInterested: 'bef95ae4-cd13-4847-b20d-3ab629bdcc2d' },
  Thff0j9pAbolXby28EbT: { name: 'GOAT Fresh Leads', newLead: ['e6e62abc-045f-4b65-80e8-2ee869e3e3d9', '14970631-0cfd-4958-a6da-e5d70cb32a74'], appointment: 'e53033ad-5b8d-47c6-bf03-a2e07d0d911e', notInterested: 'e423de7a-cf26-49fc-a910-a9f6dbda4678' },
};

// Custom field ids (Aidan's location)
export const CF = { driver_type: 'ozKlFFwF4VuIYnhHilwU', age: '2rtfanBsLoRDK3Ku0o2X', marital: 'PJYS5lMKN8rPyCUNDlWG', beneficiary_rel: 'yeTSHrlBVx9j22Z19Fnu' };

export const STATE_TZ: Record<string, string> = {
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
export function tzForState(state: string | null | undefined): string {
  const k = (state || '').trim().toLowerCase().replace(/\.$/, '');
  return STATE_TZ[STATE_ABBR[k] || k] || AIDAN_TZ;
}
// States that require upfront AI disclosure in sales conversations
export const AI_DISCLOSE_STATES = ['california', 'ca', 'utah', 'ut', 'colorado', 'co'];

export const H = { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28', 'Accept': 'application/json', 'Content-Type': 'application/json' };
export async function ghl(path: string, init: RequestInit = {}, version = '2021-07-28') {
  const r = await fetch(`https://services.leadconnectorhq.com${path}`, { ...init, headers: { ...H, Version: version, ...(init.headers || {}) } });
  const text = await r.text();
  let json: any = {};
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { ok: r.ok, status: r.status, json };
}
export async function sendSms(contactId: string, message: string) {
  const r = await ghl('/conversations/messages', { method: 'POST', body: JSON.stringify({ type: 'SMS', contactId, message }) });
  return { ok: r.ok, id: r.json.messageId || '', err: r.ok ? '' : `${r.status} ${JSON.stringify(r.json).slice(0, 160)}` };
}
export async function alertAidan(message: string) {
  try { await sendSms(AIDAN_CONTACT_ID, message.slice(0, 1500)); } catch (_) {}
}
export async function addTags(contactId: string, tags: string[]) {
  try { await ghl(`/contacts/${contactId}/tags`, { method: 'POST', body: JSON.stringify({ tags }) }); } catch (_) {}
}
export async function removeTags(contactId: string, tags: string[]) {
  try { await ghl(`/contacts/${contactId}/tags`, { method: 'DELETE', body: JSON.stringify({ tags }) }); } catch (_) {}
}

// ---- time helpers ----
export function localParts(d: Date, tz: string) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d);
  const g = (t: string) => p.find(x => x.type === t)!.value;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday'));
  return { y: +g('year'), mo: +g('month'), d: +g('day'), h: +g('hour') % 24, mi: +g('minute'), wd };
}
export function localToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  let guess = new Date(Date.UTC(y, mo - 1, d, h, mi));
  for (let i = 0; i < 2; i++) {
    const lp = localParts(guess, tz);
    const asUtc = Date.UTC(lp.y, lp.mo - 1, lp.d, lp.h, lp.mi);
    guess = new Date(Date.UTC(y, mo - 1, d, h, mi) - (asUtc - guess.getTime()));
  }
  return guess;
}
// Compliance window for OUTBOUND campaign texts: 9:00am-7:30pm recipient local time, Monday-Saturday (covers FL/OK/MD/WA 8pm cutoffs, TX 9am start, AL/LA/MS/TX Sunday rules).
export const SEND_START_MIN = 9 * 60, SEND_END_MIN = 19 * 60 + 30;
// Sundays: allowed 12:00pm-7:30pm local (covers the Texas noon rule) EXCEPT states that prohibit Sunday solicitation outright.
export const SUNDAY_BLACKOUT_STATES = ['alabama', 'al', 'louisiana', 'la', 'mississippi', 'ms', 'utah', 'ut', 'rhode island', 'ri'];
export const SUNDAY_START_MIN = 12 * 60;
export function sundayAllowed(state: string | null | undefined): boolean { return !SUNDAY_BLACKOUT_STATES.includes((state || '').trim().toLowerCase()); }
export function inSendWindow(now: Date, tz: string, state?: string | null): boolean {
  const lp = localParts(now, tz);
  const m = lp.h * 60 + lp.mi;
  if (lp.wd === 0) return sundayAllowed(state) && m >= SUNDAY_START_MIN && m <= SEND_END_MIN;
  return m >= SEND_START_MIN && m <= SEND_END_MIN;
}
// Next moment texting opens for this lead, on or after `from` (9:30am Mon-Sat, 12:15pm Sunday where allowed). Used when a text is due outside the window.
export function nextSendWindowStart(from: Date, tz: string, state?: string | null): Date {
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
export const MAX_SEQ_TEXTS_PER_24H = 1;
export function seqTextsLast24h(conversation: any[], now: Date): Date[] {
  return (conversation || []).filter((m: any) => m.role === 'aidan_sequence' && m.at && now.getTime() - new Date(m.at).getTime() < 86400000).map((m: any) => new Date(m.at)).sort((a: Date, b: Date) => a.getTime() - b.getTime());
}
// Next instant at local h:mi on or after `from` that is not a Sunday; `dayOffset` days after `from`'s local date
export function scheduleLocal(from: Date, dayOffset: number, h: number, mi: number, tz: string): Date {
  const lp = localParts(from, tz);
  let t = localToUtc(lp.y, lp.mo, lp.d, h, mi, tz);
  t = new Date(t.getTime() + dayOffset * 86400000);
  // re-anchor to exact local time after DST shifts
  const tp = localParts(t, tz); t = localToUtc(tp.y, tp.mo, tp.d, h, mi, tz);
  if (dayOffset === 0 && t.getTime() <= from.getTime()) { const np = localParts(new Date(t.getTime() + 86400000), tz); t = localToUtc(np.y, np.mo, np.d, h, mi, tz); }
  while (localParts(t, tz).wd === 0) { const np = localParts(new Date(t.getTime() + 86400000), tz); t = localToUtc(np.y, np.mo, np.d, h, mi, tz); }
  return t;
}
export function fmtLocal(d: Date, tz: string, withDay = true) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: withDay ? 'short' : undefined, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(d);
}
export function stamp() { return new Date().toLocaleString('en-US', { timeZone: AIDAN_TZ }) + ' CT'; }

export function driverGroup(driverType: string | null | undefined): 'owner_op' | 'company' | 'unknown' {
  const t = (driverType || '').toLowerCase();
  if (!t) return 'unknown';
  if (t.includes('owner') || t.includes('lease')) return 'owner_op';
  return 'company';
}

// ---- Thread scan: new inbound texts + any outbound text the bot did not send (= Aidan jumped in manually) ----
export const MANUAL_GRACE_MS = 5 * 60000;
function normText(s: string) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
export async function scanThread(contactId: string, sinceMs: number, conversation: any[]): Promise<{ inbound: { at: number; text: string }[]; manual: { at: number; text: string }[] }> {
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
      else if (m.direction === 'outbound' && contactId !== AIDAN_CONTACT_ID && !known.has(normText(m.body)) && at < Date.now() - MANUAL_GRACE_MS) manual.push({ at, text: String(m.body).trim() }); // Aidan's own contact receives bot alerts; never treat those as a manual takeover. Grace period: a text the sender/reply bot just sent may not be saved to the record yet (two runs overlapping), so only outbound texts older than a few minutes count as Aidan's.
    }
  }
  inbound.sort((a, b) => a.at - b.at); manual.sort((a, b) => a.at - b.at);
  return { inbound, manual };
}
export async function markManualTakeover(svc: any, L: any, log: string[], manual: { at: number; text: string }[]) {
  log.push(`${stamp()} Aidan texted manually ("${manual[manual.length - 1].text.slice(0, 50)}"), bot paused`);
  await removeTags(L.ghl_contact_id, ['Respark Active']); await addTags(L.ghl_contact_id, ['Aidan Took Over']);
  await svc.update(L.id, { status: 'manual', stop_reason: 'Aidan took over the thread', next_send_at: null, seq_log: log });
}

// ---- Lead profile: everything we know about the lead, by human-readable name, for the reply bot and the sequence ----
// Internal/system fields are dropped so the bot never sees (or mentions) IPs, TrustedForm, A2P, pipeline bookkeeping, etc.
export const PROFILE_SKIP = /ip address|trusted form|otp code|a2p|sms optin|opt-out|opt out|wavv|campaign stage|email stage|test field|opportunity|pipeline|^stage$|^status$|^sold|^won$|sold\/won|closed\/won|lost reason|contact type|contact source|date created|landline|^time zone$|u\.s\. timezone|state full name|^u\.s\. state|aloha|producer license|dot number|mc number|secondary phone|^ad$|lead source|lead value|business name|disposition status/i;
export async function cfNameMap(): Promise<Record<string, string>> {
  const r = await ghl(`/locations/${LOC}/customFields`);
  const m: Record<string, string> = {};
  for (const f of (r.json.customFields || [])) m[f.id] = String(f.name || '').trim();
  return m;
}
export function ageFromDob(dob: string): string {
  const d = new Date(dob); if (isNaN(d.getTime())) return '';
  const now = new Date(); let a = now.getUTCFullYear() - d.getUTCFullYear();
  if (now.getUTCMonth() < d.getUTCMonth() || (now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() < d.getUTCDate())) a--;
  return a > 0 && a < 110 ? String(a) : '';
}
export async function buildProfile(base44: any, c: any, cfNames: Record<string, string>) {
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
    if (calls) fields['Aidan call attempts logged'] = `${calls}${voicemails ? ` (${voicemails} went to voicemail)` : ''}`;
  } catch (_) {}
  if (!fields['Request submitted'] && c.dateAdded) fields['Request submitted'] = new Date(c.dateAdded).toLocaleDateString('en-US', { timeZone: AIDAN_TZ, month: 'short', day: 'numeric', year: 'numeric' });
  const goal = fields['IUL Goal'] || fields['What are your Goals for the IUL?'] || '';
  const bene = fields['Beneficiary Relationship'] || fields['Beneficiary'] || fields['Beneficiary Name'] || '';
  return { fields, lead_status, ad, dob, requested_at: c.dateAdded || '', city: c.city || '', gender: fields['Gender'] || '', iul_goal: goal, beneficiary: bene, age: fields['Age'] || '', marital: fields['Marital Status'] || '', driver_type: fields['Driver Type'] || '' };
}
// Fields the bot should treat as "already talked to Aidan"
export function talkedBefore(lead_status: string): boolean { return /pitch|follow|nurture|contacted|appointment|callback/i.test(lead_status || ''); }
// Beneficiary phrasing for the sequence: a relationship word -> "your wife and kids" etc., a real name -> the name, else "your family"
export function familyPhrase(beneficiary: string, marital: string): string {
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
