// Agent availability and in-app booking: hours, days off, busy-calendar link, open times, and
// book / reschedule / cancel / mark outcome. Agents never need to open another calendar app.
import { setupContext } from '../../shared/setupAccess.ts';
import { ghl, own, failure } from '../../shared/ghl.ts';
import { freeSlots } from '../../shared/messageBooking.ts';
import { busyIntervals, normalizeFeedUrl, validHours, openHoursFor } from '../../shared/availability.ts';
import { agentBook, agentReschedule, agentCancel, agentMarkOutcome } from '../../shared/agentBooking.ts';

const DEFAULT_HOURS = [...[1, 2, 3, 4, 5].map(day => ({ day, open: '09:00', close: '18:00' })), { day: 6, open: '10:00', close: '14:00' }];

function view(s: any) {
  const cache = s.busy_cache || {};
  return {
    timezone: s.home_timezone || 'America/Chicago',
    hours: s.calendar_hours?.length ? s.calendar_hours : DEFAULT_HOURS,
    max_calls_per_day: s.max_calls_per_day || 6,
    blocked_dates: (s.blocked_dates || []).filter((d: string) => d >= new Date(Date.now() - 86400000).toISOString().slice(0, 10)).sort(),
    busy_calendar_connected: !!s.busy_calendar_url,
    busy_calendar_host: s.busy_calendar_url ? new URL(s.busy_calendar_url).hostname.replace(/^www\./, '') : '',
    busy_checked_at: cache.fetched_at || '',
    busy_error: cache.error || '',
    busy_blocks_next_two_weeks: (cache.busy || []).length,
    calendar_ready: !!s.calendar_id,
    meeting_link: s.meeting_link || '',
  };
}

export default async function (req: Request) {
  try {
    const { base44, user, s, E } = await setupContext(req);
    const input = await req.json().catch(() => ({}));
    const action = String(input.action || 'view');

    if (action === 'save') {
      const update: Record<string, any> = {};
      if (input.hours !== undefined) {
        if (!validHours(input.hours)) throw new Error('Each day needs one opening and closing time, with opening before closing.');
        if (!input.hours.length) throw new Error('Keep at least one day open for calls.');
        update.calendar_hours = input.hours;
      }
      if (input.max_calls_per_day !== undefined) {
        const n = Number(input.max_calls_per_day);
        if (!Number.isInteger(n) || n < 1 || n > 30) throw new Error('Calls per day must be 1 to 30.');
        update.max_calls_per_day = n;
      }
      if (input.blocked_dates !== undefined) {
        if (!Array.isArray(input.blocked_dates) || input.blocked_dates.length > 120 || input.blocked_dates.some((d: any) => !/^\d{4}-\d{2}-\d{2}$/.test(d))) throw new Error('Pick valid days off.');
        update.blocked_dates = [...new Set(input.blocked_dates as string[])].sort();
      }
      if (input.meeting_link !== undefined) {
        const v = String(input.meeting_link || '').trim();
        if (v && !/^https:\/\/([a-z0-9-]+\.)*(zoom\.us|zoomgov\.com|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|whereby\.com|webex\.com)\//i.test(v)) throw new Error('Paste your Zoom, Google Meet, Teams, Webex or Whereby meeting link (it starts with https://).');
        update.meeting_link = v.slice(0, 500);
      }
      if (input.busy_calendar_url !== undefined) {
        update.busy_calendar_url = input.busy_calendar_url ? normalizeFeedUrl(input.busy_calendar_url) : '';
        update.busy_cache = {};
      }
      Object.assign(s, await E.AgentSettings.update(s.id, update), update);
      // Keep the booking calendar in step with the hours shown here.
      if ((update.calendar_hours || update.max_calls_per_day) && s.calendar_id && s.connected) {
        await ghl(s, `/calendars/${encodeURIComponent(s.calendar_id)}`, 'PUT', { openHours: openHoursFor(s.calendar_hours?.length ? s.calendar_hours : DEFAULT_HOURS), appoinmentPerDay: s.max_calls_per_day || 6 });
      }
      if (update.busy_calendar_url) {
        const r = await busyIntervals(E, s, true);
        if (r.error) throw new Error(r.error);
        s.busy_cache = { fetched_at: r.fetched_at, error: '', busy: r.busy.map(([a, b]) => [new Date(a).toISOString(), new Date(b).toISOString()]) };
      }
      return Response.json(view(s));
    }

    if (action === 'refresh_busy') {
      const r = await busyIntervals(E, s, true);
      s.busy_cache = { fetched_at: r.fetched_at, error: r.error, busy: r.busy.map(([a, b]) => [new Date(a).toISOString(), new Date(b).toISOString()]) };
      return Response.json(view(s));
    }

    if (action === 'slots') {
      const lead = input.lead_id ? own(user, await E.Lead.get(String(input.lead_id))) : null;
      const tz = lead?.timezone || s.home_timezone || 'America/Chicago';
      const slots = await freeSlots(s, lead || { timezone: tz }, E);
      return Response.json({ slots: slots.slice(0, 120), timezone: tz, agent_timezone: s.home_timezone || 'America/Chicago' });
    }

    if (['book', 'reschedule', 'cancel', 'held', 'no_show'].includes(action)) {
      if (!s.calendar_id || !s.connected) throw new Error('Your booking calendar is still being set up.');
      const slot = String(input.slot || '');
      if (['book', 'reschedule'].includes(action) && !Number.isFinite(Date.parse(slot))) throw new Error('Pick a time.');
      if (action === 'book') {
        const lead = own(user, await E.Lead.get(String(input.lead_id || '')));
        if (lead.agent_email !== s.agent_email) throw new Error('Access denied.');
        return Response.json(await agentBook(base44, s, lead, slot, input.notify !== false));
      }
      const appointment = own(user, await E.Appointment.get(String(input.appointment_id || '')));
      if (appointment.agent_email !== s.agent_email) throw new Error('Access denied.');
      if (action === 'reschedule') return Response.json(await agentReschedule(base44, s, appointment, slot, input.notify !== false));
      if (action === 'cancel') return Response.json(await agentCancel(base44, s, appointment, input.hand_back === true));
      return Response.json(await agentMarkOutcome(base44, s, appointment, action as 'held' | 'no_show'));
    }

    return Response.json(view(s), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error as Error); }
}
