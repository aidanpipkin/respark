// aidanBook: Aidan books (or reschedules) an appointment by texting Vesper. One call does everything the Respark bot does on a booking:
//   resolve the GHL contact -> Outlook invite to the lead (phone call or Zoom) + private prep block for Aidan -> GHL opp to Appointment
//   stage + note + tags -> confirmation text to the lead in Aidan's voice -> ResparkLead marked booked so resparkAppointmentFlow sends the
//   T-24h / T-1h / T-10m lead reminders, Aidan's T-30m prep brief and the post-call wrap-up.
// Body: { contact_id? | phone? | name?, when: "2026-10-14 17:30" (Aidan's CT unless tz given) | ISO, tz?, mode: "phone"|"zoom", zoom_link?,
//         attendees? ("his wife Shineka"), product?, quotes?, health?, notes?, duration_min? (30), send_sms? (true), dry_run? }
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
const GHL_API_KEY = Deno.env.get('GHL_API_KEY') || '';
const LOC = 'P1m006Mt7YCXCAdiBBxC';
const AIDAN_CONTACT_ID = 'hLZmFD5Azf8WHCpBuk0d';
const AIDAN_EMAIL = 'aidan@usnaturalinsurance.com';
const AIDAN_TZ = 'America/Chicago';

// Pipelines in scope
const PIPES: Record<string, { name: string; newLead: string[]; appointment: string; notInterested: string }> = {
  yl3k1RNrJ3OILc8Yj45R: { name: 'Goat Fresh Premium Truckers', newLead: ['bba15ec1-5be3-49f8-85d9-f77c3e12d1bf'], appointment: '54c64708-d80a-4f17-99dd-f41577fabe3d', notInterested: 'bef95ae4-cd13-4847-b20d-3ab629bdcc2d' },
  Thff0j9pAbolXby28EbT: { name: 'GOAT Fresh Leads', newLead: ['e6e62abc-045f-4b65-80e8-2ee869e3e3d9', '14970631-0cfd-4958-a6da-e5d70cb32a74'], appointment: 'e53033ad-5b8d-47c6-bf03-a2e07d0d911e', notInterested: 'e423de7a-cf26-49fc-a910-a9f6dbda4678' },
  '9spUMGcl4sx6oT8JJ7oC': { name: 'Gold Mailers', newLead: ['5c38986d-0598-436b-8169-f5c0290110ce', '1064a714-1644-41e4-b4f4-6ce3ff86e8b6'], appointment: '9fda742e-7a55-4b10-b2f7-3d6bb4b12046', notInterested: 'b32c5079-5593-4ef1-addb-f0eb8e1ad518' },
};
const GENERAL_PIPES = ['9spUMGcl4sx6oT8JJ7oC'];

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
  return STATE_TZ[STATE_ABBR[k] || k] || AIDAN_TZ;
}

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
async function alertAidan(message: string) {
  try { await sendSms(AIDAN_CONTACT_ID, message.slice(0, 1500)); } catch (_) {}
}
async function addTags(contactId: string, tags: string[]) {
  try { await ghl(`/contacts/${contactId}/tags`, { method: 'POST', body: JSON.stringify({ tags }) }); } catch (_) {}
}
async function removeTags(contactId: string, tags: string[]) {
  try { await ghl(`/contacts/${contactId}/tags`, { method: 'DELETE', body: JSON.stringify({ tags }) }); } catch (_) {}
}

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

function fmtLocal(d: Date, tz: string, withDay = true) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: withDay ? 'short' : undefined, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(d);
}
function stamp() { return new Date().toLocaleString('en-US', { timeZone: AIDAN_TZ }) + ' CT'; }

function driverGroup(driverType: string | null | undefined): 'owner_op' | 'company' | 'unknown' {
  const t = (driverType || '').toLowerCase();
  if (!t) return 'unknown';
  if (t.includes('owner') || t.includes('lease')) return 'owner_op';
  return 'company';
}

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
    if (calls) fields['Aidan call attempts logged'] = `${calls}${voicemails ? ` (${voicemails} went to voicemail)` : ''}`;
  } catch (_) {}
  if (!fields['Request submitted'] && c.dateAdded) fields['Request submitted'] = new Date(c.dateAdded).toLocaleDateString('en-US', { timeZone: AIDAN_TZ, month: 'short', day: 'numeric', year: 'numeric' });
  const goal = fields['IUL Goal'] || fields['What are your Goals for the IUL?'] || '';
  const bene = fields['Beneficiary Relationship'] || fields['Beneficiary'] || fields['Beneficiary Name'] || '';
  return { fields, lead_status, ad, dob, requested_at: c.dateAdded || '', city: c.city || '', gender: fields['Gender'] || '', iul_goal: goal, beneficiary: bene, age: fields['Age'] || '', marital: fields['Marital Status'] || '', driver_type: fields['Driver Type'] || '' };
}

const CALL_MINUTES = 30;
const AIDAN_PHONE_DISPLAY = '940-368-1353';
const AIDAN_TITLE = 'CDL Financial Advisor, My Trucker Wealth';
async function outlookToken(base44: any): Promise<string> {
  const c = await base44.asServiceRole.connectors.getConnection('outlook');
  return c.accessToken || c.access_token || c.token;
}
async function graph(token: string, path: string, init: RequestInit = {}) {
  const r = await fetch(`https://graph.microsoft.com/v1.0${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`Graph ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}
function fmtPhone(p: string): string { const d = String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p; }
function esc(s: any): string { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function fullName(L: any): string { return `${L.first_name || ''} ${L.last_name || ''}`.replace(/\s+/g, ' ').trim(); }
function tzLabel(tz: string, d: Date): string { return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(d).find(p => p.type === 'timeZoneName')?.value || ''; }
function fmtLong(d: Date, tz: string): string { return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(d); }

function inviteSubject(L: any): string { return `Trucker IUL Strategy Call: ${fullName(L)} and Aidan (My Trucker Wealth)`; }

async function cancelBooking(token: string, L: any) {
  for (const id of [L.appointment_event_id, L.prep_event_id]) { if (id) { try { await graph(token, `/me/events/${id}`, { method: 'DELETE' }); } catch (_) {} } }
}

async function addNote(contactId: string, body: string) { try { await ghl(`/contacts/${contactId}/notes`, { method: 'POST', body: JSON.stringify({ body: body.slice(0, 4000) }) }); } catch (_) {} }

const ZOOM_DEFAULT = 'https://us06web.zoom.us/j/7720606398';
const ZOOM_ID = '772 060 6398';
const ZOOM_TAP = '+12532050468,,7720606398#';

function parseWhen(when: string, tz: string): Date | null {
  if (!when) return null;
  const s = when.trim();
  if (/(Z|[+-]\d\d:?\d\d)$/.test(s)) { const d = new Date(s); return isNaN(d.getTime()) ? null : d; }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/);
  if (!m) return null;
  return localToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], tz);
}
function cap(s: string) { return String(s || '').trim().replace(/\s+/g, ' ').split(' ').map(w => w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w).join(''); }
function properName(s: string) { return String(s || '').trim().replace(/\s+/g, ' ').split(' ').map(w => w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w).join(' '); }

function manualInviteBody(L: any, start: Date, o: any): string {
  const tz = L.timezone || AIDAN_TZ;
  const zoom = o.mode === 'zoom';
  const link = o.zoom_link || ZOOM_DEFAULT;
  const who = o.attendees ? ` You mentioned ${esc(o.attendees)} will join us, which is great, this is a family decision and I want everyone's questions answered.` : '';
  const how = zoom
    ? `<p>This confirms our <b>${o.duration_min}-minute Zoom meeting</b> on <b>${esc(fmtLong(start, tz))}</b>.${who}</p>
<p><b>Join Zoom Meeting</b><br><a href="${esc(link)}">${esc(link)}</a><br>Meeting ID: ${esc(o.zoom_meeting_id || ZOOM_ID)}<br>One tap mobile: ${esc(o.zoom_tap || ZOOM_TAP)} US</p>
<p>From a phone, tap the link and choose "Join from browser" or install the free Zoom app. If anything goes sideways with the video, no problem, I will simply call you at <b>${esc(fmtPhone(L.phone))}</b>.</p>`
    : `<p>This confirms our <b>${o.duration_min}-minute phone call</b> on <b>${esc(fmtLong(start, tz))}</b>. I will call you at <b>${esc(fmtPhone(L.phone))}</b>, so there is nothing to join and nothing to download. My call may show up from a different number than the one I text from, so please pick up.${who}</p>`;
  if (o.general) {
    const quotesG = o.quotes ? `<li>The options we discussed: ${esc(o.quotes)}. We will go through each one line by line and lock in the one that fits your budget.</li>` : '';
    return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;color:#222;line-height:1.5">
<p>Hi ${esc(L.first_name)},</p>
${how}
<p><b>What we will cover</b></p>
<ul>
<li><b>${esc(o.product || 'The life insurance coverage you asked about')}</b></li>
${quotesG}
<li>Making sure the people you care about are not left with the bills, and that the money gets to them quickly and tax free</li>
<li>Coverage that is approved based on a few health questions, with no medical exam, and premiums that never go up</li>
<li>Next steps if you decide to move forward, with no obligation either way</li>
</ul>
<p><b>Please have handy</b>: a driver's license or ID, the full legal name and date of birth of your beneficiary, and (only if you have one) the name and monthly amount of any current policy.</p>
<p>Need to move it? Reply to my text or email me at aidan@usnaturalinsurance.com and we will find a better time.</p>
<p>Looking forward to it,</p>
<p><b>Aidan</b><br>Licensed Life Insurance Agent, US Natural Insurance<br>${esc(AIDAN_PHONE_DISPLAY)} | aidan@usnaturalinsurance.com</p>
</div>`;
  }
  const product = o.product ? `<li><b>${esc(o.product)}</b></li>` : '<li>The Trucker IUL request you submitted and what you want the coverage to do for your family</li>';
  const quotes = o.quotes ? `<li>The options we discussed: ${esc(o.quotes)}. We will walk through each one line by line and lock in the one that fits.</li>` : '';
  const g = driverGroup(L.driver_type);
  const situ = g === 'owner_op' ? 'As an owner-operator you carry the truck note and the household without an employer safety net, so we will spend real time on the living benefits that pay you if you cannot drive.' : g === 'company' ? 'As a company driver, the group life through work ends the day you leave or lose your med card, so we will look at coverage that is yours for life.' : 'We will look at coverage built around a driver\'s schedule and income.';
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;color:#222;line-height:1.5">
<p>Hi ${esc(L.first_name)},</p>
${how}
<p><b>What we will cover</b></p>
<ul>
${product}
${quotes}
<li>${esc(situ)}</li>
<li>Living benefits: how the policy pays out to you while you are alive if a serious illness or injury takes you off the road</li>
<li>Cash value: how the account grows, how you can access it, and the downside protection built in</li>
<li>Next steps if you decide to move forward, with no obligation either way</li>
</ul>
<p><b>Please have handy</b>: a driver's license or ID, the full legal name and date of birth of your beneficiary, and (only if you have one) the name and monthly amount of any current policy.</p>
<p>Need to move it? Reply to my text or email me at aidan@usnaturalinsurance.com and we will find a better time.</p>
<p>Looking forward to it,</p>
<p><b>Aidan</b><br>${esc(AIDAN_TITLE)}<br>${esc(AIDAN_PHONE_DISPLAY)} | aidan@usnaturalinsurance.com<br>Working exclusively with CDL drivers, including JB Hunt, Walmart and Tyson drivers and owner-operators</p>
</div>`;
}
function manualPrepBody(L: any, start: Date, o: any, convo: any[]): string {
  const tz = L.timezone || AIDAN_TZ;
  const file = Object.entries(L.profile || {}).map(([k, v]) => `<li><b>${esc(k)}:</b> ${esc(v)}</li>`).join('');
  const thread = (convo || []).slice(-12).map((m: any) => `<li><b>${m.role === 'lead' ? esc(L.first_name) : 'You'}:</b> ${esc(m.text)}</li>`).join('');
  const how = o.mode === 'zoom' ? `Zoom: <a href="${esc(o.zoom_link || ZOOM_DEFAULT)}">${esc(o.zoom_link || ZOOM_DEFAULT)}</a> (backup: call ${esc(fmtPhone(L.phone))})` : `You call ${esc(fmtPhone(L.phone))}`;
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px">
<p><b>${esc(fullName(L))}</b> at ${esc(fmtLocal(start, AIDAN_TZ))}${tz !== AIDAN_TZ ? ` (${esc(fmtLocal(start, tz))} their time)` : ''}. ${how}.${o.attendees ? ` Joining: ${esc(o.attendees)}.` : ''}</p>
<p><b>Your notes</b></p><ul>${o.product ? `<li><b>Product:</b> ${esc(o.product)}</li>` : ''}${o.quotes ? `<li><b>Quotes discussed:</b> ${esc(o.quotes)}</li>` : ''}${o.health ? `<li><b>Health / underwriting:</b> ${esc(o.health)}</li>` : ''}${o.notes ? `<li><b>Other:</b> ${esc(o.notes)}</li>` : ''}</ul>
<p>Email: ${esc(L.email || 'none on file')} | State: ${esc(L.state || 'n/a')} | Driver: ${esc(L.driver_type || 'n/a')} | Age ${esc(L.age || 'n/a')} | DOB ${esc(L.dob || 'n/a')} | ${esc(L.marital_status || '')} | Beneficiary: ${esc(L.beneficiary_relationship || 'n/a')}</p>
<p><b>Full file</b></p><ul>${file || '<li>only name and phone</li>'}</ul>
${thread ? `<p><b>Text thread</b></p><ul>${thread}</ul>` : ''}
<p>GHL contact ${esc(L.ghl_contact_id)}. After the meeting, move the opportunity out of the Appointment stage so the reminders stop.</p></div>`;
}
function manualConfirmationText(L: any, start: Date, o: any, inviteSent: boolean): string {
  const tz = L.timezone || AIDAN_TZ;
  const who = o.attendees ? ` Glad ${o.attendees.replace(/^(his|her|their)\s+/i, 'your ')} will be on too.` : '';
  const inv = inviteSent ? ` I emailed a calendar invite to ${L.email} from aidan@usnaturalinsurance.com with everything in it, go ahead and accept it so it lands on your phone (check junk if you don't see it).` : '';
  if (o.mode === 'zoom') {
    const link = o.zoom_link || ZOOM_DEFAULT;
    return `${L.first_name}, great talking with you. We're set for ${fmtLocal(start, tz)} on Zoom.${who} Here's the link: ${link} (tap it and choose join from browser if you don't have the app).${inv} Have your ID and ${o.attendees ? 'your beneficiary\'s' : 'the beneficiary\'s'} full name and date of birth handy and we'll get it done. If anything changes just text me. Aidan`;
  }
  return `${L.first_name}, great talking with you. We're set for ${fmtLocal(start, tz)}, I'll call you at this number.${who}${inv} Have your ID and the beneficiary's full name and date of birth handy. If anything changes just text me. Aidan`;
}

Deno.serve(async (req: Request) => {
  const base44 = createClientFromRequest(req);
  const svc = (base44 as any).asServiceRole.entities.ResparkLead;
  let b: any = {}; try { b = await req.json(); } catch (_) {}
  const dryRun = b.dry_run === true;
  const now = new Date();
  const o: any = { general: false, mode: (b.mode || 'phone').toLowerCase() === 'zoom' ? 'zoom' : 'phone', zoom_link: String(b.zoom_link || ZOOM_DEFAULT).trim(), zoom_meeting_id: b.zoom_meeting_id || '', zoom_tap: b.zoom_tap || '',
    attendees: String(b.attendees || '').trim(), product: String(b.product || '').trim(), quotes: String(b.quotes || '').trim(), health: String(b.health || '').trim(), notes: String(b.notes || '').trim(), duration_min: Number(b.duration_min) || 30 };
  try {
    // 1. Resolve the GHL contact
    let c: any = null;
    if (b.contact_id) c = (await ghl(`/contacts/${b.contact_id}`)).json.contact;
    else {
      const q = b.phone ? String(b.phone).replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '') : String(b.name || '').trim();
      if (!q) return Response.json({ success: false, error: 'Give me contact_id, phone or name' });
      const r = (await ghl(`/contacts/?locationId=${LOC}&query=${encodeURIComponent(q)}&limit=10`)).json.contacts || [];
      const want = String(b.name || '').toLowerCase().split(/\s+/).filter(Boolean);
      const hits = b.phone ? r.filter((x: any) => String(x.phone || '').replace(/\D/g, '').endsWith(q)) : r.filter((x: any) => want.every(w => `${x.firstName || ''} ${x.lastName || ''}`.toLowerCase().includes(w)));
      if (hits.length !== 1) return Response.json({ success: false, error: hits.length ? 'Several contacts match, pass contact_id' : 'No GHL contact matched', candidates: hits.slice(0, 10).map((x: any) => ({ id: x.id, name: `${x.firstName || ''} ${x.lastName || ''}`.trim(), phone: x.phone, email: x.email, state: x.state, added: x.dateAdded })) });
      c = (await ghl(`/contacts/${hits[0].id}`)).json.contact;
    }
    if (!c?.id) return Response.json({ success: false, error: 'Contact not found' });

    // 2. Lead record (existing Respark file or a fresh one built from the GHL contact)
    const existing: any[] = await svc.filter({ ghl_contact_id: c.id }, '-created_date', 3);
    let L: any = existing[0] || null;
    const cfNames = await cfNameMap();
    const P = await buildProfile(base44, c, cfNames);
    const st = c.state || L?.state || '';
    const tz = tzForState(st);
    const base = { ghl_contact_id: c.id, first_name: properName(c.firstName || L?.first_name || ''), last_name: properName(c.lastName || L?.last_name || ''), phone: c.phone || L?.phone || '', email: (c.email || L?.email || '').trim(),
      state: st, city: P.city || L?.city || '', timezone: tz, driver_type: P.driver_type || L?.driver_type || '', age: P.age || L?.age || '', dob: P.dob || L?.dob || '', gender: P.gender || L?.gender || '', marital_status: P.marital || L?.marital_status || '',
      beneficiary_relationship: P.beneficiary || L?.beneficiary_relationship || '', iul_goal: P.iul_goal || L?.iul_goal || '', profile: { ...(L?.profile || {}), ...P.fields } };
    if (b.email) base.email = String(b.email).trim();

    // 3. Opportunity -> Appointment stage
    const opps = ((await ghl(`/opportunities/search?location_id=${LOC}&contact_id=${c.id}`)).json.opportunities || []).filter((x: any) => x.status === 'open');
    const opp = opps.find((x: any) => PIPES[x.pipelineId]) || opps[0] || null;
    const pipe = opp ? PIPES[opp.pipelineId] : null;
    const tags: string[] = (c.tags || []).map((t: any) => String(t).toLowerCase());
    o.general = b.audience ? String(b.audience).toLowerCase() === 'general' : (/final expense|burial|mortgage|general life|whole life|term life/i.test(o.product) || (opp ? GENERAL_PIPES.includes(opp.pipelineId) : false) || tags.some(t => /general life|mortgage protection|final expense|aged fe|gold mailer/.test(t)));

    // 4. Time
    const start = parseWhen(String(b.when || ''), b.tz || AIDAN_TZ);
    if (!start) return Response.json({ success: false, error: 'when must look like "2026-10-14 17:30" (Aidan CT) or an ISO datetime' });
    if (start.getTime() < now.getTime() - 5 * 60000) return Response.json({ success: false, error: `That time is in the past (${fmtLocal(start, AIDAN_TZ)})` });

    const convo: any[] = [...(L?.conversation || [])];
    const draft = { ...base, ...o, status: 'booked' };
    const plan = { contact: `${base.first_name} ${base.last_name} ${base.phone} ${base.email || '(no email)'} ${st}`, when_ct: fmtLocal(start, AIDAN_TZ), when_lead: fmtLocal(start, tz), mode: o.mode, audience: o.general ? 'general' : 'trucker', opp: opp ? `${pipe?.name || opp.pipelineId} -> Appointment` : 'no open opportunity', rescheduling: !!(L?.appointment_event_id), sms_preview: manualConfirmationText(draft, start, o, !!base.email) };
    if (dryRun) return Response.json({ success: true, dry_run: true, ...plan });

    // 5. Outlook: cancel any prior booking, create invite + prep block
    const token = await outlookToken(base44);
    if (L?.appointment_event_id || L?.prep_event_id) await cancelBooking(token, L);
    const end = new Date(start.getTime() + o.duration_min * 60000);
    const email = base.email; const inviteSent = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
    const subject = o.general ? `Life Insurance Review ${o.mode === 'zoom' ? '(Zoom)' : 'Call'}: ${base.first_name} ${base.last_name} and Aidan (US Natural Insurance)` : o.mode === 'zoom' ? `Trucker IUL Zoom: ${base.first_name} ${base.last_name}${o.attendees ? ' + ' + o.attendees.replace(/^(his|her|their)\s+(wife|husband|spouse|partner)\s+/i, '') : ''} and Aidan (My Trucker Wealth)` : inviteSubject(base);
    const ev = await graph(token, '/me/events', { method: 'POST', body: JSON.stringify({
      subject, body: { contentType: 'HTML', content: manualInviteBody(base, start, o) },
      start: { dateTime: start.toISOString().slice(0, 19), timeZone: 'UTC' }, end: { dateTime: end.toISOString().slice(0, 19), timeZone: 'UTC' },
      location: { displayName: o.mode === 'zoom' ? `Zoom: ${o.zoom_link}` : `Phone call: Aidan calls ${fmtPhone(base.phone)}` },
      attendees: inviteSent ? [{ emailAddress: { address: email, name: `${base.first_name} ${base.last_name}`.trim() }, type: 'required' }] : [],
      isReminderOn: true, reminderMinutesBeforeStart: 15, showAs: 'busy', categories: ['Respark', 'Booked by Aidan'], responseRequested: true, allowNewTimeProposals: true }) });
    const prepStart = new Date(start.getTime() - 15 * 60000);
    const prep = await graph(token, '/me/events', { method: 'POST', body: JSON.stringify({
      subject: `Prep: ${base.first_name} ${base.last_name} (${o.mode === 'zoom' ? 'Zoom' : fmtPhone(base.phone)}${o.product ? ', ' + o.product.slice(0, 40) : ''})`,
      body: { contentType: 'HTML', content: manualPrepBody(base, start, o, convo) },
      start: { dateTime: prepStart.toISOString().slice(0, 19), timeZone: 'UTC' }, end: { dateTime: start.toISOString().slice(0, 19), timeZone: 'UTC' },
      isReminderOn: true, reminderMinutesBeforeStart: 0, showAs: 'tentative', sensitivity: 'private', categories: ['Respark'] }) });

    // 6. GHL: stage, note, tags
    if (opp && pipe && opp.pipelineStageId !== pipe.appointment) await ghl(`/opportunities/${opp.id}`, { method: 'PUT', body: JSON.stringify({ pipelineStageId: pipe.appointment }) });
    const noteLines = [`BOOKED BY AIDAN ${fmtLocal(start, AIDAN_TZ)}${tz !== AIDAN_TZ ? ` (${fmtLocal(start, tz)} lead time)` : ''} via ${o.mode === 'zoom' ? 'Zoom ' + o.zoom_link : 'phone'}.`, o.attendees ? `Joining: ${o.attendees}` : '', o.product ? `Product: ${o.product}` : '', o.quotes ? `Quotes discussed: ${o.quotes}` : '', o.health ? `Health: ${o.health}` : '', o.notes ? `Notes: ${o.notes}` : '', `Invite ${inviteSent ? 'sent to ' + email : 'NOT sent (no email on file)'}.`].filter(Boolean);
    await addNote(c.id, noteLines.join('\n'));
    await removeTags(c.id, ['Respark Active']); await addTags(c.id, o.general ? ['Appointment Booked', 'Booked by Aidan'] : ['Respark Booked', 'Booked by Aidan']);

    // 7. Confirmation text to the lead
    let sms: any = { skipped: true };
    const text = manualConfirmationText(base, start, o, inviteSent);
    if (b.send_sms !== false) { sms = await sendSms(c.id, text); if (sms.ok) convo.push({ role: 'aidan_bot', text, at: now.toISOString(), label: 'booking confirmation (booked by Aidan)' }); }

    // 8. Lead record -> booked (reminders + prep brief + wrap-up now run from resparkAppointmentFlow)
    const log = [...(L?.seq_log || []), `${stamp()} booked by Aidan for ${fmtLocal(start, AIDAN_TZ)} (${o.mode})${L?.appointment_event_id ? ' [rescheduled]' : ''}; invite ${inviteSent ? 'sent' : 'not sent'}; sms ${sms.ok ? 'sent' : sms.skipped ? 'skipped' : 'FAILED ' + sms.err}`];
    const upd: any = { ...base, status: 'booked', stop_reason: null, intent: 'book', appointment_at: start.toISOString(), appointment_event_id: ev?.id || '', prep_event_id: prep?.id || '', invite_sent: inviteSent, invite_response: inviteSent ? 'none' : 'no_email',
      meeting_mode: o.mode, zoom_link: o.mode === 'zoom' ? o.zoom_link : '', additional_attendees: o.attendees, booking_notes: [o.product, o.quotes, o.health, o.notes].filter(Boolean).join(' | '), booked_by: 'aidan',
      reminder_24h_sent: start.getTime() - now.getTime() < 20 * 3600000, /* same-day booking: the confirmation text just went out, skip the day-before reminder */ reminder_1h_sent: false, reminder_10m_sent: false, lead_confirmed: false, aidan_prep_sent: false, aidan_wrap_sent: false, post_appt_checked: false, conversation: convo, seq_log: log, next_send_at: null };
    if (sms.ok) upd.last_sms_at = now.toISOString();
    if (L) await svc.update(L.id, upd);
    else await svc.create({ ...upd, ghl_opportunity_id: opp?.id || '', pipeline_id: opp?.pipelineId || '', lead_status: P.lead_status || '', requested_at: P.requested_at || '', enrolled_at: now.toISOString(), step: 0, messages_sent: 0, reply_count: 0 });
    return Response.json({ success: true, ...plan, event_id: ev?.id || '', prep_event_id: prep?.id || '', invite_sent: inviteSent, sms, sms_text: text, opp_moved: !!(opp && pipe) });
  } catch (e) { return Response.json({ success: false, error: String((e as any)?.message || e).slice(0, 400) }); }
});
