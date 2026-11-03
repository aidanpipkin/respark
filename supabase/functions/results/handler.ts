// Agent results: what LeadRespark has produced, all time and last 30 days, plus warm leads to call now.
import { setupContext } from '../_shared/setupAccess.ts';
import { failure } from '../_shared/ghl.ts';

const PER_YEAR: Record<string, number> = { monthly: 12, quarterly: 4, semi_annual: 2, annual: 1 };

export default async function (req: Request) {
  try {
    const { E, s } = await setupContext(req);
    const me = { agent_email: s.agent_email };
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const warmSince = new Date(Date.now() - 3 * 86400000).toISOString();
    const [texted, replied, replied30, booked, booked30, held, policies, warm] = await Promise.all([
      E.Lead.count({ ...me, last_outbound_at: { $exists: true, $nin: ['', null] } }),
      E.Lead.count({ ...me, last_inbound_at: { $exists: true, $nin: ['', null] } }),
      E.Lead.count({ ...me, last_inbound_at: { $gte: since } }),
      E.Appointment.count({ ...me, status: { $in: ['booked', 'held', 'no_show', 'rescheduled'] } }),
      E.Appointment.count({ ...me, created_date: { $gte: since }, status: { $in: ['booked', 'held', 'no_show', 'rescheduled'] } }),
      E.Appointment.count({ ...me, status: 'held' }),
      E.Policy.filter({ ...me, status: { $in: ['submitted', 'approved'] } }, { limit: 500, fields: ['premium_amount_cents', 'premium_frequency', 'status', 'created_at', 'client_name'] }),
      // Replied recently, interested, no call on the books yet: the agent should pick up the phone.
      E.Lead.filter({ ...me, status: { $in: ['replied', 'engaged'] }, last_inbound_at: { $gte: warmSince } }, { sort: '-last_inbound_at', limit: 5, fields: ['first_name', 'last_name', 'phone', 'state', 'last_inbound_at', 'ai_summary', 'status'] }),
    ]);
    const annual = (p: any) => (Number(p.premium_amount_cents) || 0) * (PER_YEAR[p.premium_frequency] || 12);
    const premiumAll = policies.items.reduce((n: number, p: any) => n + annual(p), 0);
    const premium30 = policies.items.filter((p: any) => String(p.created_at || '') >= since).reduce((n: number, p: any) => n + annual(p), 0);
    return Response.json({
      texted, replied, replied30, booked, booked30, held,
      closed: policies.items.length,
      annual_premium_cents: premiumAll,
      annual_premium_30_cents: premium30,
      subscription_year_cents: 120000,
      warm: warm.items,
    });
  } catch (e) { return failure(e as Error); }
}
