// Booking, rescheduling and cancelling done by the agent from inside LeadRespark.
import { scope } from './ghl.ts';
import { calendarCreate, calendarUpdate } from './calendarEvents.ts';
import { freeSlots, replaceRescheduled, startJourney } from './messageBooking.ts';
import { labelSlot, dayBounds } from './messageClock.ts';
import { logMessage } from './messageJobs.ts';
import { sendSms } from './messageSender.ts';
import { msConnected, graphDeleteEvent } from './msGraph.ts';

const LENGTH_MS = 20 * 60000;

async function ensureOpen(E: any, s: any, lead: any, slot: string, ignoreAppointmentId = '') {
  const open = await freeSlots(s, lead, E);
  if (!open.some(t => Date.parse(t) === Date.parse(slot))) throw new Error('That time was just taken or is no longer open. Pick another.');
  const range = dayBounds(slot, s.home_timezone || 'America/Chicago');
  const sameDay = await E.Appointment.filter({ agent_email: s.agent_email, status: { $in: ['booked', 'held'] }, start_time: { $gte: range.start, $lt: range.end } }, { limit: 50 });
  if (sameDay.items.filter((a: any) => a.id !== ignoreAppointmentId).length >= (s.max_calls_per_day || 6)) throw new Error('That day already has your maximum number of calls.');
}

async function confirmText(base44: any, lead: any, s: any, slot: string, kind: 'booked' | 'moved') {
  const who = String(s.first_name || s.display_name || 'I').split(/\s+/)[0];
  const text = kind === 'booked'
    ? `You're set for ${labelSlot(slot, lead.timezone)}. ${who} will call you${s.phone_number ? ' from this number, so save it' : ''}.${lead.email ? ' Details are on the way to your email.' : ''} Reply STOP to opt out.`
    : `Quick update: your call with ${who} is now ${labelSlot(slot, lead.timezone)}. Reply here if that doesn't work. Reply STOP to opt out.`;
  try { await sendSms(base44, lead.id, text, 'booking', `agent-${kind}:${lead.id}:${slot}`); return { texted: true }; }
  catch (e) { return { texted: false, text_error: (e as Error).message }; }
}

export async function agentBook(base44: any, s: any, lead: any, slot: string, notify: boolean) {
  const E = base44.asServiceRole.entities;
  if (['opted_out'].includes(lead.status)) throw new Error('This contact opted out.');
  if (!lead.ghl_contact_id) throw new Error('This contact is still syncing. Try again in a minute.');
  await ensureOpen(E, s, lead, slot);
  const apt = { id: await calendarCreate(s, lead, new Date(slot).toISOString(), new Date(Date.parse(slot) + LENGTH_MS).toISOString(), `Strategy call with ${s.first_name || s.display_name}`) };
  if (lead.status !== 'client') await replaceRescheduled(E, s, lead.id, new Date(slot).toISOString());
  const savedAppt = await E.Appointment.upsert([{ ...scope(s), ghl_appointment_id: apt.id, lead_id: lead.id, campaign_id: lead.campaign_id || '', lead_name: [lead.first_name, lead.last_name].filter(Boolean).join(' '), ai_summary: lead.ai_summary || '', start_time: new Date(slot).toISOString(), lead_timezone: lead.timezone || s.home_timezone, phone_to_call: lead.phone, status: 'booked' }], { key: ['agent_email', 'ghl_appointment_id'] });
  startJourney(base44, savedAppt?.records?.[0]?.id);
  // Clients keep their retention track (e.g. an annual review call); everyone else moves to Booked.
  if (lead.status !== 'client') await E.Lead.update(lead.id, { status: 'booked', ai_paused: true, sequence_paused: true, next_send_at: '', next_nudge_at: '', next_nurture_at: '', offered_slots: [], needs_human_reason: '', track: '', track_next_at: '' });
  if (lead.status !== 'client') await E.ConversationSummary.updateMany({ agent_email: s.agent_email, lead_id: lead.id }, { $set: { status_chip: 'booked', has_pending_draft: false } });
  await E.AIDraft.updateMany({ agent_email: s.agent_email, lead_id: lead.id, status: 'pending' }, { $set: { status: 'discarded', edit_reason: 'Agent booked the call' } });
  await logMessage(base44, s, lead, { event_type: 'status_changed', source: 'agent', direction: 'internal', status: 'booked', body: `Call booked by agent for ${labelSlot(slot, s.home_timezone || 'America/Chicago')}.` });
  return { booked: true, ...(notify ? await confirmText(base44, await E.Lead.get(lead.id), s, slot, 'booked') : {}) };
}

export async function agentReschedule(base44: any, s: any, appointment: any, slot: string, notify: boolean) {
  const E = base44.asServiceRole.entities;
  const lead = await E.Lead.get(appointment.lead_id);
  await ensureOpen(E, s, lead, slot, appointment.id);
  await calendarUpdate(s, appointment.ghl_appointment_id, { startTime: new Date(slot).toISOString(), endTime: new Date(Date.parse(slot) + LENGTH_MS).toISOString(), appointmentStatus: 'confirmed', ignoreFreeSlotValidation: false, toNotify: false });
  await E.Appointment.update(appointment.id, { start_time: new Date(slot).toISOString(), status: 'booked', reminders_sent: {}, confirmation: 'pending' });
  startJourney(base44, appointment.id);
  await logMessage(base44, s, lead, { event_type: 'status_changed', source: 'agent', direction: 'internal', status: 'booked', body: `Call moved to ${labelSlot(slot, s.home_timezone || 'America/Chicago')}.` });
  return { rescheduled: true, ...(notify && lead.status === 'booked' ? await confirmText(base44, lead, s, slot, 'moved') : {}) };
}

export async function agentCancel(base44: any, s: any, appointment: any, handBack: boolean) {
  const E = base44.asServiceRole.entities;
  await calendarUpdate(s, appointment.ghl_appointment_id, { appointmentStatus: 'cancelled' });
  if (appointment.ms_event_id && msConnected(s)) await graphDeleteEvent(E, s, appointment.ms_event_id).catch(() => {});
  await E.Appointment.update(appointment.id, { status: 'cancelled' });
  const lead = await E.Lead.get(appointment.lead_id);
  if (lead.status !== 'opted_out') {
    // Hand back to the AI (it will offer new times when they reply) or keep it with the agent.
    await E.Lead.update(lead.id, handBack ? { status: 'engaged', ai_paused: false, needs_human_reason: '' } : { status: 'needs_human', ai_paused: true, needs_human_reason: 'You cancelled the call. Reschedule or hand back to the AI.' });
  }
  await logMessage(base44, s, lead, { event_type: 'status_changed', source: 'agent', direction: 'internal', status: 'cancelled', body: 'Call cancelled by agent.' });
  return { cancelled: true };
}

export async function agentMarkOutcome(base44: any, s: any, appointment: any, outcome: 'held' | 'no_show') {
  const E = base44.asServiceRole.entities;
  await calendarUpdate(s, appointment.ghl_appointment_id, { appointmentStatus: outcome === 'held' ? 'showed' : 'noshow' });
  await E.Appointment.update(appointment.id, { status: outcome });
  const lead = await E.Lead.get(appointment.lead_id);
  if (lead.status !== 'opted_out') await E.Lead.update(lead.id, outcome === 'held' ? { status: 'held' } : { status: 'no_show', needs_human_reason: 'Missed the call. Reschedule from Appointments.' });
  return { updated: true };
}
