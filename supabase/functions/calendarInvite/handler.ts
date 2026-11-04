// Public "Add to Apple / Outlook calendar" link for a booked call. The token in the link is the
// only key; it is random per appointment and shows nothing beyond the call itself.
import { createClientFromRequest, timingSafeEqual } from '../_shared/runtime.ts';
import { resilient } from '../_shared/entityRetry.ts';
import { icsFor } from '../_shared/appointmentJourney.ts';

export default async function (req: Request) {
  try {
    const url = new URL(req.url);
    const id = url.searchParams.get('a') || '', token = url.searchParams.get('t') || '', who = url.searchParams.get('w') === 'agent' ? 'agent' : 'lead';
    if (!/^[\w-]{6,64}$/.test(id) || !/^[a-f0-9]{32}$/.test(token)) return new Response('Not found', { status: 404 });
    const base44 = resilient(createClientFromRequest(req));
    const E = base44.asServiceRole.entities;
    const appt = await E.Appointment.get(id).catch(() => null);
    if (!appt || !timingSafeEqual(String(appt.invite_token || ''), token)) return new Response('Not found', { status: 404 });
    if (appt.status !== 'booked') return new Response('This call was moved or cancelled. Check your latest text or email for the current time.', { status: 410, headers: { 'Content-Type': 'text/plain' } });
    const s = (await E.AgentSettings.filter({ agent_email: appt.agent_email }, { limit: 1 })).items[0] || {};
    const seq = Object.keys(appt.journey || {}).filter(k => k.startsWith('booked@')).length;
    return new Response(icsFor(appt, s, who, Math.max(0, seq - 1)), { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="call-${who}.ics"`, 'Cache-Control': 'no-store' } });
  } catch { return new Response('Not found', { status: 404 }); }
}
