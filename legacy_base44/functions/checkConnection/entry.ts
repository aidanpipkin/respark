import { context, agentSettings, ghl, failure } from '../../shared/ghl.ts';
export default async function(req) {
  try {
    const { base44, user } = await context(req);
    if (user.role !== 'admin') return Response.json({ error: 'Administrator access required.' }, { status: 403 });
    const input = await req.json(); const s = await agentSettings(base44, input.agent_email || user.email);
    if (!s?.connected) throw new Error('Save your GHL connection first.');
    const paths = { contacts: `/contacts/?locationId=${encodeURIComponent(s.location_id)}&limit=1`, conversations: `/conversations/search?locationId=${encodeURIComponent(s.location_id)}&limit=1`, calendar: s.calendar_id ? `/calendars/${encodeURIComponent(s.calendar_id)}` : `/calendars/?locationId=${encodeURIComponent(s.location_id)}` };
    const results = await Promise.all(Object.entries(paths).map(async ([key, path]) => { try { await ghl(s, path); return [key, { ok: true, message: key === 'calendar' && !s.calendar_id ? 'Access verified. Choose a calendar before booking.' : 'Access verified' }]; } catch (error) { return [key, { ok: false, message: error.message }]; } }));
    return Response.json({ checks: Object.fromEntries(results) });
  } catch (error) { return failure(error); }
}