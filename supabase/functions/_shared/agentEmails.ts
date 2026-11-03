// Emails to agents that used to depend on entity-triggered workflows (which don't fire for
// backend writes): the go-live welcome and the daily brief. Sent directly, deduplicated by key.
import { emailAgent } from './agentNotify.ts';
import { APP_ORIGIN } from './appointmentJourney.ts';

async function once(E: any, s: any, key: string) {
  const saved = await E.MessageDispatch.upsert([{ agent_email: s.agent_email, location_id: s.location_id || '', key, kind: 'alert', lead_id: '' }], { key: 'key' });
  const job = saved.records[0];
  if (job.state && job.state !== 'new') return null;
  const token = crypto.randomUUID();
  await E.MessageDispatch.updateMany({ id: job.id, state: { $in: ['new', null, ''] } }, { $set: { state: 'working', token } });
  const fresh = await E.MessageDispatch.get(job.id);
  return fresh.token === token ? fresh : null;
}

export function welcomeText(s: any) {
  const name = s.first_name || s.display_name || 'there';
  const review = (s.mode || 'review') === 'review';
  return `Hi ${name},

You're live on LeadRespark. Your campaign is now texting your leads from ${s.phone_number || 'your LeadRespark number'}.

What happens now
- The AI texts your aged leads in short, personal conversations and books calls straight onto your calendar.
- ${review ? 'You are in Review mode: every AI reply waits in your Inbox for one tap to approve. Once you trust it, switch "Approve before sending" to "Auto-reply on" in your Profile.' : 'Auto-reply is on: replies go out on their own; anything sensitive is held for you.'}
- When someone books, you get a text and an email with their recap and a suggested opener. They get a confirmation, the buyer's guide and carrier brochures, a confirm text the evening before, and a heads-up 10 minutes before you call.

Your part
1. Check the Inbox a couple of times a day. Anything marked "Needs you" is a person asking for you.
2. After every call, open Appointments and log the outcome (closed, follow-up, no-show, lost). Each one starts the right follow-up texts automatically.
3. When someone closes, enter the policy details. That powers their welcome text, premium reminder, check-ins and referral asks.

Open your dashboard: ${APP_ORIGIN}/dashboard

Reply to this email if anything looks off.
LeadRespark`;
}

/** Welcomes agents who went live in the last two days and haven't been welcomed. Safe to run often. */
export async function sendWelcomes(base44: any) {
  const E = base44.asServiceRole.entities;
  const since = new Date(Date.now() - 2 * 86400000).toISOString();
  const page = await E.AgentSettings.filter({ status: 'live', live_at: { $gte: since } }, { limit: 50 });
  let sent = 0;
  for (const s of page.items || []) {
    const job = await once(E, s, `welcome:${s.agent_email}`);
    if (!job) continue;
    const r = await emailAgent(base44, s, "You're live on LeadRespark", welcomeText(s));
    await E.MessageDispatch.update(job.id, { state: r === 'sent' ? 'done' : 'failed', result: { email: r } });
    if (r === 'sent') sent++;
  }
  return sent;
}

export function briefText(b: any) {
  const lines = [
    `Good morning ${b.first_name || 'there'},`, '',
    `Here's ${b.date}:`,
    `- Calls booked today: ${b.bookings}`,
    `- Leads who replied in the last 24 hours: ${b.replies}`,
    `- People waiting on you: ${b.needs_human}`,
    `- AI replies waiting for your approval: ${b.pending_drafts}`, '',
  ];
  if (b.needs_human || b.pending_drafts) lines.push('Start with the Inbox: people who asked for you, then the drafts waiting for approval.', '');
  else if (!b.bookings && !b.replies) lines.push('Quiet day so far. Your campaign keeps working in the background.', '');
  lines.push(`Open your dashboard: ${APP_ORIGIN}/dashboard`, '', 'LeadRespark');
  return lines.join('\n');
}
