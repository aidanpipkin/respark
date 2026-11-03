// Shared booking module (copied into aidanReply + resparkAppointmentFlow at deploy time). Requires resparkShared helpers.
export const CALL_MINUTES = 30;
export const AIDAN_PHONE_DISPLAY = '940-368-1353';
export const AIDAN_TITLE = 'CDL Financial Advisor, My Trucker Wealth';
export async function outlookToken(base44: any): Promise<string> {
  const c = await base44.asServiceRole.connectors.getConnection('outlook');
  return c.accessToken || c.access_token || c.token;
}
export async function graph(token: string, path: string, init: RequestInit = {}) {
  const r = await fetch(`https://graph.microsoft.com/v1.0${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`Graph ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}
export function fmtPhone(p: string): string { const d = String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p; }
export function esc(s: any): string { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
export function fullName(L: any): string { return `${L.first_name || ''} ${L.last_name || ''}`.replace(/\s+/g, ' ').trim(); }
export function tzLabel(tz: string, d: Date): string { return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(d).find(p => p.type === 'timeZoneName')?.value || ''; }
export function fmtLong(d: Date, tz: string): string { return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(d); }

// Lead-facing invite (the lead receives this from aidan@usnaturalinsurance.com)
export function inviteSubject(L: any): string { return `Trucker IUL Strategy Call: ${fullName(L)} and Aidan (My Trucker Wealth)`; }
export function inviteBody(L: any, start: Date): string {
  const tz = L.timezone || AIDAN_TZ;
  const g = driverGroup(L.driver_type);
  const goal = /retire/i.test(L.iul_goal || '') ? 'the retirement side of the IUL (cash value you can tap later, with downside protection)' : /famil|protect|income/i.test(L.iul_goal || '') ? 'making sure your family keeps their income if something happens to you' : 'what you were hoping the coverage would do for you and your family';
  const situ = g === 'owner_op' ? 'As an owner-operator you carry the truck note and the household without an employer safety net, so we will talk about living benefits that pay you if you cannot drive.' : g === 'company' ? 'As a company driver, the group life through work ends the day you leave or lose your med card, so we will look at coverage that is yours for life.' : 'We will look at coverage built around a driver\'s schedule and income.';
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;color:#222;line-height:1.5">
<p>Hi ${esc(L.first_name)},</p>
<p>This confirms our <b>30-minute phone call</b> on <b>${esc(fmtLong(start, tz))}</b>. I will call you at <b>${esc(fmtPhone(L.phone))}</b>, so there is nothing to join and nothing to download. My call may show up from a different number than the one I text from, so please pick up.</p>
<p><b>What we will cover</b></p>
<ul>
<li>The Trucker IUL request you submitted, and ${esc(goal)}</li>
<li>${esc(situ)}</li>
<li>Living benefits: how a policy can pay out to you while you are alive if a serious illness or injury takes you off the road</li>
<li>Real numbers based on your age, health and budget, with no obligation</li>
</ul>
<p><b>To get the most out of it</b>: have a quiet 30 minutes while parked, and if you already have a policy, the company name and monthly amount are helpful (not required).</p>
<p>Need to move it? Reply to my text or email me at aidan@usnaturalinsurance.com and we will find a better time.</p>
<p>Talk soon and drive safe,</p>
<p><b>Aidan</b><br>${esc(AIDAN_TITLE)}<br>${esc(AIDAN_PHONE_DISPLAY)} | aidan@usnaturalinsurance.com<br>Working exclusively with CDL drivers, including JB Hunt, Walmart and Tyson drivers and owner-operators</p>
</div>`;
}
// Internal prep block for Aidan (private, 15 min before the call): full file + text thread
export function prepBody(L: any, start: Date, convo: any[]): string {
  const tz = L.timezone || AIDAN_TZ;
  const file = Object.entries(L.profile || {}).map(([k, v]) => `<li><b>${esc(k)}:</b> ${esc(v)}</li>`).join('');
  const thread = (convo || []).slice(-16).map((m: any) => `<li><b>${m.role === 'lead' ? esc(L.first_name) : 'You (bot)'}:</b> ${esc(m.text)}</li>`).join('');
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px">
<p><b>Call ${esc(fullName(L))} at ${esc(fmtPhone(L.phone))}</b> at ${esc(fmtLocal(start, AIDAN_TZ))} (${esc(fmtLocal(start, tz))} their time). You call them.</p>
<p>Email: ${esc(L.email || 'none on file')} | State: ${esc(L.state || 'n/a')}${L.city ? ', ' + esc(L.city) : ''} | Driver: ${esc(L.driver_type || 'n/a')} | Age ${esc(L.age || 'n/a')} | ${esc(L.marital_status || '')} | Beneficiary: ${esc(L.beneficiary_relationship || 'n/a')} | Goal: ${esc(L.iul_goal || 'n/a')}</p>
<p><b>Full file</b></p><ul>${file || '<li>only name and phone</li>'}</ul>
<p><b>Text thread (booked by the Respark bot in your name; pick up where "you" left off)</b></p><ul>${thread}</ul>
<p>GHL contact ${esc(L.ghl_contact_id)}. After the call, move the opportunity out of the Appointment stage so the bot stops reminding.</p></div>`;
}
export async function createBooking(token: string, L: any, start: Date, convo: any[]): Promise<{ eventId: string; prepEventId: string; inviteSent: boolean }> {
  const end = new Date(start.getTime() + CALL_MINUTES * 60000);
  const email = String(L.email || '').trim();
  const inviteSent = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
  const ev = await graph(token, '/me/events', { method: 'POST', body: JSON.stringify({
    subject: inviteSubject(L),
    body: { contentType: 'HTML', content: inviteBody(L, start) },
    start: { dateTime: start.toISOString().slice(0, 19), timeZone: 'UTC' }, end: { dateTime: end.toISOString().slice(0, 19), timeZone: 'UTC' },
    location: { displayName: `Phone call: Aidan calls ${fmtPhone(L.phone)}` },
    attendees: inviteSent ? [{ emailAddress: { address: email, name: fullName(L) }, type: 'required' }] : [],
    isReminderOn: true, reminderMinutesBeforeStart: 15, showAs: 'busy', categories: ['Respark'], responseRequested: true, allowNewTimeProposals: true,
  }) });
  const prepStart = new Date(start.getTime() - 15 * 60000);
  const prep = await graph(token, '/me/events', { method: 'POST', body: JSON.stringify({
    subject: `Prep: ${fullName(L)} (${L.driver_type || 'driver'}, ${L.state || ''}) ${fmtPhone(L.phone)}`.replace(/\s+/g, ' '),
    body: { contentType: 'HTML', content: prepBody(L, start, convo) },
    start: { dateTime: prepStart.toISOString().slice(0, 19), timeZone: 'UTC' }, end: { dateTime: start.toISOString().slice(0, 19), timeZone: 'UTC' },
    isReminderOn: true, reminderMinutesBeforeStart: 0, showAs: 'tentative', sensitivity: 'private', categories: ['Respark'],
  }) });
  return { eventId: ev?.id || '', prepEventId: prep?.id || '', inviteSent };
}
export async function cancelBooking(token: string, L: any) {
  for (const id of [L.appointment_event_id, L.prep_event_id]) { if (id) { try { await graph(token, `/me/events/${id}`, { method: 'DELETE' }); } catch (_) {} } }
}
export async function inviteResponse(token: string, eventId: string, email: string): Promise<string> {
  try {
    const ev = await graph(token, `/me/events/${eventId}?$select=attendees`);
    const a = (ev?.attendees || []).find((x: any) => String(x.emailAddress?.address || '').toLowerCase() === String(email || '').toLowerCase());
    return a?.status?.response || 'none';
  } catch (_) { return 'unknown'; }
}
export const ASAP_LEAD_MIN = 15;   // "I'm finishing up with another driver, can I call you in 15?"
export function isAsap(d: Date | null | undefined): boolean { return !!(d && (d as any).asap); }
export function confirmationText(L: any, start: Date, inviteSent: boolean): string {
  const tz = L.timezone || AIDAN_TZ;
  if (isAsap(start)) return `Perfect ${L.first_name}, give me about ${ASAP_LEAD_MIN} minutes to wrap up and I'll call you at this number. Heads up, it may show up from a different number than this one, so go ahead and pick up.`;
  const base = `You're set ${L.first_name}. I'll call you ${fmtLocal(start, tz)} at this number.`;
  const inv = inviteSent ? ` I also sent a calendar invite to ${L.email} from aidan@usnaturalinsurance.com, go ahead and accept it so it lands on your phone.` : '';
  return `${base}${inv} If anything changes before then just text me and we'll move it. Drive safe.`;
}
export async function addNote(contactId: string, body: string) { try { await ghl(`/contacts/${contactId}/notes`, { method: 'POST', body: JSON.stringify({ body: body.slice(0, 4000) }) }); } catch (_) {} }
