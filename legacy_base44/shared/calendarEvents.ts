// One door to the booking calendar (GHL). Fictional test leads and contacts that only exist in
// LeadRespark never reach GHL: their appointments live here alone, with a `test:` id.
import { ghl } from './ghl.ts';
import { localContactId } from './rehearsal.ts';

export const localAppointmentId = (id: any) => /^test:/.test(String(id || ''));

/** Creates the calendar event and returns its id. */
export async function calendarCreate(s: any, lead: any, startIso: string, endIso: string, title: string) {
  if (localContactId(lead?.ghl_contact_id)) return `test:${crypto.randomUUID()}`;
  const data = await ghl(s, '/calendars/events/appointments', 'POST', {
    calendarId: s.calendar_id, locationId: s.location_id, contactId: lead.ghl_contact_id, startTime: startIso, endTime: endIso,
    title, appointmentStatus: 'confirmed', ignoreDateRange: false, ignoreFreeSlotValidation: false, toNotify: false,
    ...(s.owner_user_id ? { assignedUserId: s.owner_user_id } : {}),
  });
  const apt = data.appointment || data;
  if (!apt.id) throw new Error('The calendar did not confirm the booking.');
  return String(apt.id);
}

/** Moves, cancels or marks a calendar event. Local (test) events are a no-op. */
export async function calendarUpdate(s: any, appointmentId: string, patch: Record<string, any>) {
  if (!appointmentId || localAppointmentId(appointmentId)) return;
  await ghl(s, `/calendars/events/appointments/${encodeURIComponent(appointmentId)}`, 'PUT', { calendarId: s.calendar_id, toNotify: false, ...patch });
}
