// Shared booking module for RILEY (copied into rileyReply + rileyAppointmentFlow at deploy time). Requires rileyShared helpers.
// Riley's build books on his GHL calendar ("Riley Lyng's Personal Calendar") instead of Outlook: free slots come from the GHL
// free-slots API (so his calendar hours/conflicts are the source of truth), the booking is a GHL appointment on the lead's contact,
// and the private prep block is a GHL blocked slot plus a contact note with the full file + thread.
export const CALL_MINUTES = 30;
export const RILEY_PHONE_DISPLAY = '479-446-6932';
export const RILEY_TITLE = 'CDL Financial Advisor, My Trucker Wealth';
export const CALENDAR_ID = 'UzHXKRyDyP5bXb303J03';   // Riley Lyng's Personal Calendar (30 min slots)
export const RILEY_USER_ID = 'AbSahwCJZNX0e0yFDkKS';
export const MIN_NOTICE_MIN = 60;
export const ASAP_LEAD_MIN = 15;   // "I'm finishing up with another driver, can I call you in 15?"
export function isAsap(d: Date | null | undefined): boolean { return !!(d && (d as any).asap); }
// No OAuth token needed for GHL; kept so callers stay identical to the Outlook build.
export async function outlookToken(_base44: any): Promise<string> { return 'ghl'; }
export function fmtPhone(p: string): string { const d = String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p; }
export function esc(s: any): string { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
export function fullName(L: any): string { return `${L.first_name || ''} ${L.last_name || ''}`.replace(/\s+/g, ' ').trim(); }
export function tzLabel(tz: string, d: Date): string { return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(d).find(p => p.type === 'timeZoneName')?.value || ''; }
export function fmtLong(d: Date, tz: string): string { return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(d); }

// ---------- Availability from Riley's GHL calendar ----------
// Returns bookable slot starts (UTC Dates) for the next 8 days, honoring the calendar's hours, existing appointments and blocked slots.
// Adds an ASAP slot (~15 min from now, rounded to 5) when the calendar shows the next half hour open on a weekday.
export async function freeSlots(_token: string, now: Date): Promise<Date[]> {
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
export function inviteSubject(L: any): string { return `Trucker IUL Strategy Call: ${fullName(L)} and Riley (My Trucker Wealth)`; }
export function inviteBody(L: any, start: Date): string {
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
export function prepBody(L: any, start: Date, convo: any[]): string {
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
export async function createBooking(_token: string, L: any, start: Date, convo: any[]): Promise<{ eventId: string; prepEventId: string; inviteSent: boolean }> {
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
export async function cancelBooking(_token: string, L: any) {
  for (const id of [L.appointment_event_id, L.prep_event_id]) { if (id) { try { await ghl(`/calendars/events/${id}`, { method: 'DELETE' }); } catch (_) {} } }
}
// GHL does not expose attendee accept/decline like Outlook; the appointment flow treats this as unknown and never nags about the invite.
export async function inviteResponse(_token: string, _eventId: string, _email: string): Promise<string> { return 'unknown'; }
export function confirmationText(L: any, start: Date, _inviteSent: boolean): string {
  const tz = L.timezone || RILEY_TZ;
  if (isAsap(start)) return `Perfect ${L.first_name}, give me about ${ASAP_LEAD_MIN} minutes to wrap up and I'll call you at this number. Heads up, it may show up from a different number than this one, so go ahead and pick up.`;
  return `You're set ${L.first_name}. I'll call you ${fmtLocal(start, tz)} at this number. If anything changes before then just text me and we'll move it. Drive safe.`;
}
export async function addNote(contactId: string, body: string) { try { await ghl(`/contacts/${contactId}/notes`, { method: 'POST', body: JSON.stringify({ body: body.slice(0, 4000) }) }); } catch (_) {} }

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
