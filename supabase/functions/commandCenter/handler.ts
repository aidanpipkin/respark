// Admin Command Center: one call returns platform health, open signals, the launch funnel,
// revenue, activity across all agents, help requests and the latest rehearsal.
import { adminContext } from '../_shared/agentAccess.ts';
import { failure } from '../_shared/ghl.ts';
import { platformConfig } from '../_shared/credits.ts';
import { resolve } from '../_shared/signals.ts';
import { runHealth } from '../_shared/health.ts';
import { REHEARSAL_EMAIL } from '../_shared/rehearsal.ts';

const real = { agent_email: { $ne: REHEARSAL_EMAIL } };

const DAY = 86400000;
const since = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const JOBS = [['sequence_sender', 'Texting engine', 20], ['appointment_reminders', 'Call reminders', 20], ['health', 'Health monitor', 30], ['a2p_status', 'Registration tracker', 90], ['subscription_sync', 'Subscription sync', 1800], ['daily_brief', 'Daily brief', 1800]];

export default async function (req: Request) {
  try {
    const { base44 } = await adminContext(req);
    const E = base44.asServiceRole.entities;
    const input = await req.json().catch(() => ({}));

    if (input.action === 'resolve' && input.key) { await resolve(base44, String(input.key), 'Marked resolved by admin.'); return Response.json({ ok: true }); }
    if (input.action === 'run_health') return Response.json({ results: await runHealth(base44) });

    const config = await platformConfig(E);
    const day = new Date().toISOString().slice(0, 10);
    const counter = async (k: string) => Number((await E.EngineCursor.filter({ key: `count:${k}:${day}` }, { limit: 1 })).items[0]?.cursor || 0);
    const beat = async (job: string) => { const r = (await E.EngineCursor.filter({ key: `heartbeat:${job}` }, { limit: 1 })).items[0]; try { return JSON.parse(r?.cursor || '{}'); } catch { return {}; } };

    const [agentsTotal, agents7, agents30, live, withNumber, regSubmitted, regApproved, withCalendar, subs, signals, help, rehearsalRow,
      texts7, replies7, booked7, closed7, texts1, replies1, aiOwn, aiFallback, aiBase44] = await Promise.all([
      E.AgentSettings.count({ self_serve: true }), E.AgentSettings.count({ self_serve: true, created_date: { $gte: since(7) } }), E.AgentSettings.count({ self_serve: true, created_date: { $gte: since(30) } }),
      E.AgentSettings.count({ ...real, status: 'live' }), E.AgentSettings.count({ ...real, phone_number: { $exists: true, $nin: ['', null] } }),
      E.A2PRegistration.count({ $or: [{ status: { $in: ['queued', 'brand_submitted', 'otp_pending', 'campaign_submitted', 'approved'] } }, { provider_step: 'platform_wait' }] }),
      E.AgentSettings.count({ ...real, a2p_status: 'approved' }),
      E.AgentSettings.count({ ...real, $or: [{ busy_calendar_url: { $exists: true, $nin: ['', null] } }, { calendar_id: { $exists: true, $nin: ['', null] } }] }),
      E.BillingAccount.filter({ subscription_status: { $in: ['active', 'trialing', 'past_due'] } }, { limit: 1000, fields: ['subscription_amount_cents', 'subscription_status', 'agent_email'] }),
      E.SystemEvent.filter({ status: 'open' }, { sort: '-last_seen_at', limit: 200 }),
      E.SupportRequest.filter({ status: 'open' }, { sort: '-created_at', limit: 50 }),
      E.EngineCursor.filter({ key: 'rehearsal:last' }, { limit: 1 }),
      E.MessageLog.count({ ...real, event_type: 'sms_sent', occurred_at: { $gte: since(7) } }), E.MessageLog.count({ ...real, event_type: 'inbound_sms', occurred_at: { $gte: since(7) } }),
      E.Appointment.count({ ...real, created_date: { $gte: since(7) } }), E.Policy.count({ created_at: { $gte: since(7) } }),
      E.MessageLog.count({ ...real, event_type: 'sms_sent', occurred_at: { $gte: since(1) } }), E.MessageLog.count({ ...real, event_type: 'inbound_sms', occurred_at: { $gte: since(1) } }),
      counter('ai_own_calls'), counter('ai_fallback'), counter('ai_base44_calls'),
    ]);
    const price = Number(config.subscription_price_cents) || 10000;
    const paying = subs.items.filter((s: any) => s.subscription_status !== 'trialing');
    const mrr = paying.reduce((n: number, s: any) => n + (Number(s.subscription_amount_cents) || price), 0);
    const jobs = await Promise.all(JOBS.map(async ([key, label, maxMin]) => { const b = await beat(key as string); const mins = b.at ? Math.round((Date.now() - Date.parse(b.at)) / 60000) : null; return { key, label, last_run: b.at || null, minutes_ago: mins, ok: mins !== null && mins <= (maxMin as number), info: b }; }));
    const order: Record<string, number> = { critical: 0, warning: 1, info: 2 };
    const open = signals.items.sort((a: any, b: any) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
    let rehearsal = null; try { rehearsal = JSON.parse(rehearsalRow.items[0]?.cursor || 'null'); } catch { /* none yet */ }

    return Response.json({
      health: { jobs, last_check: (await beat('health')).at || null, critical: open.filter((s: any) => s.severity === 'critical').length, warnings: open.filter((s: any) => s.severity === 'warning').length },
      signals: open,
      funnel: [
        ['Signed up', agentsTotal], ['Subscribed', subs.items.length], ['Got a number', withNumber], ['Submitted registration', regSubmitted],
        ['Registration approved', regApproved], ['Calendar set', withCalendar], ['Live', live],
      ],
      growth: { signups_7d: agents7, signups_30d: agents30, mrr_cents: mrr, paying: paying.length, trialing: subs.items.length - paying.length },
      activity: { texts_7d: texts7, replies_7d: replies7, reply_rate_7d: texts7 ? Math.round((replies7 / texts7) * 1000) / 10 : 0, booked_7d: booked7, closed_7d: closed7, texts_24h: texts1, replies_24h: replies1 },
      ai: { own_today: aiOwn, fallback_today: aiFallback, base44_today: aiBase44 },
      help: help.items,
      rehearsal,
    });
  } catch (e) { return failure(e as Error); }
}
