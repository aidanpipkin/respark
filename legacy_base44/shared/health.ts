// Platform health: runs every 15 minutes, turns problems into signals, and resolves them on its
// own once they clear. Each check is independent so one failing check never hides the others.
import { raise, resolveStale, heartbeat } from './signals.ts';
import { isRehearsal } from './rehearsal.ts';
import { platformConfig, subscriptionOkFor, exempt } from './credits.ts';
import { APP_ORIGIN } from './appointmentJourney.ts';
import { readiness } from './readiness.ts';
import { masterBalance, twilioConfigured } from './twilio.ts';

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const MIN = 60000, HOUR = 3600000, DAY = 86400000;

/** Scheduled jobs and how long each may go quiet before it counts as stopped. */
const JOBS: [string, string, number, 'warning' | 'critical'][] = [
  ['sequence_sender', 'Texting engine', 20 * MIN, 'critical'],
  ['appointment_reminders', 'Booked-call reminders', 20 * MIN, 'critical'],
  ['a2p_status', 'Carrier registration tracker', 90 * MIN, 'warning'],
  ['subscription_sync', 'Subscription sync', 30 * HOUR, 'warning'],
  ['daily_brief', 'Daily brief', 30 * HOUR, 'warning'],
];

async function checkJobs(base44: any) {
  const E = base44.asServiceRole.entities, open: string[] = [];
  for (const [job, label, limit, severity] of JOBS) {
    const row = (await E.EngineCursor.filter({ key: `heartbeat:${job}` }, { limit: 1 })).items[0];
    let at = ''; try { at = JSON.parse(row?.cursor || '{}').at || ''; } catch { /* unreadable heartbeat */ }
    if (!at) continue; // never ran yet: nothing to compare against
    const quiet = Date.now() - Date.parse(at);
    if (quiet > limit) {
      const key = `job_stale:${job}`; open.push(key);
      await raise(base44, { key, kind: 'job_stale', severity, title: `${label} has stopped running`, detail: `Last run ${Math.round(quiet / MIN)} minutes ago. Check Base44 → Workflows for errors.`, data: { job, last_run: at } });
    }
  }
  await resolveStale(base44, 'job_stale', open);
}

async function checkSends(base44: any) {
  const E = base44.asServiceRole.entities, open: string[] = [];
  const since = ago(2 * HOUR);
  const [uncertain, rejected] = await Promise.all([
    E.MessageDispatch.filter({ kind: 'sms', state: 'uncertain', updated_date: { $gte: since } }, { limit: 500, fields: ['agent_email'] }),
    E.MessageDispatch.filter({ kind: 'sms', delivery_status: { $in: ['failed', 'undelivered'] }, updated_date: { $gte: since } }, { limit: 500, fields: ['agent_email'] }),
  ]);
  const per: Record<string, { uncertain: number; rejected: number }> = {};
  for (const d of uncertain.items) (per[d.agent_email] ||= { uncertain: 0, rejected: 0 }).uncertain++;
  for (const d of rejected.items) (per[d.agent_email] ||= { uncertain: 0, rejected: 0 }).rejected++;
  for (const [email, n] of Object.entries(per)) {
    const total = n.uncertain + n.rejected;
    if (total < 5) continue;
    const key = `send_failures:${email}`; open.push(key);
    await raise(base44, {
      key, kind: 'send_failures', agent_email: email, severity: total >= 25 ? 'critical' : 'warning',
      title: `${total} texts failed in the last 2 hours`,
      detail: `${n.rejected} rejected by the carrier, ${n.uncertain} couldn't be confirmed. Common causes: registration not fully approved, number not attached to the campaign, or landlines in the list.`,
      data: n, notifyOwner: true,
    });
  }
  await resolveStale(base44, 'send_failures', open);
}

async function checkAI(base44: any) {
  const E = base44.asServiceRole.entities;
  const day = new Date().toISOString().slice(0, 10);
  const read = async (k: string) => Number((await E.EngineCursor.filter({ key: `count:${k}:${day}` }, { limit: 1 })).items[0]?.cursor || 0);
  const [fallback, own] = await Promise.all([read('ai_fallback'), read('ai_own_calls')]);
  const key = 'ai_fallback:today';
  // One fallback is already a problem: it means the Anthropic key or balance failed. Critical from the first.
  if (fallback >= 1) {
    await raise(base44, { key, kind: 'ai_fallback', severity: 'critical', title: 'Your Anthropic key failed on an AI call today', detail: `${fallback} AI call${fallback === 1 ? '' : 's'} today failed on your Anthropic/OpenAI key (${own} succeeded). Check the key and your Anthropic balance. With "Allow Base44 AI fallback" on (Admin > Platform) those calls spent Base44 credits, which run out and then AI stops; with it off the texts are retried later.`, data: { fallback, own } });
  } else await resolveStale(base44, 'ai_fallback', []);
}

/** Average Twilio cost of one outbound SMS segment, used to turn the 7-day send count into a spend estimate. */
const SMS_COST = 0.0125;
const BALANCE_TTL = 2 * HOUR;

/**
 * Platform funding: the master Twilio balance versus what the last 7 days of texting cost. The balance is
 * fetched at most every 2 hours (cached in EngineCursor); the owner hears about it before texts stop.
 */
async function checkFunding(base44: any) {
  if (!twilioConfigured()) return;
  const E = base44.asServiceRole.entities;
  const row = (await E.EngineCursor.filter({ key: 'twilio_balance' }, { limit: 1 })).items[0];
  let cached: { at?: string; balance?: number; currency?: string } = {};
  try { cached = JSON.parse(row?.cursor || '{}'); } catch { /* refetch */ }
  if (!cached.at || Date.now() - Date.parse(cached.at) > BALANCE_TTL || typeof cached.balance !== 'number') {
    const fresh = await masterBalance();
    cached = { at: new Date().toISOString(), balance: fresh.balance, currency: fresh.currency };
    await E.EngineCursor.upsert([{ key: 'twilio_balance', cursor: JSON.stringify(cached) }], { key: 'key' });
  }
  const balance = Number(cached.balance);
  if (!Number.isFinite(balance)) return;
  const sent = await E.MessageLog.count({ event_type: 'sms_sent', occurred_at: { $gte: ago(7 * DAY) }, agent_email: { $ne: 'rehearsal@leadrespark.internal' } }).catch(() => 0);
  const weekly = Number(sent || 0) * SMS_COST, daily = weekly / 7;
  const daysLeft = daily > 0 ? balance / daily : Infinity;
  const key = 'twilio_balance_low';
  const summary = `Twilio balance $${balance.toFixed(2)}; last 7 days ≈ ${sent} texts ≈ $${weekly.toFixed(2)} (≈ $${daily.toFixed(2)}/day${Number.isFinite(daysLeft) ? `, about ${Math.floor(daysLeft)} day${Math.floor(daysLeft) === 1 ? '' : 's'} left` : ''}).`;
  if (balance < 50 || daysLeft < 3) {
    await raise(base44, { key, kind: 'twilio_balance', severity: 'critical', notifyOwner: true, title: `Twilio balance is critically low ($${balance.toFixed(2)})`, detail: `${summary} Top up the master Twilio account now or every agent's texting stops.`, data: { balance, sent_7d: sent, weekly, daily, days_left: Number.isFinite(daysLeft) ? Math.round(daysLeft * 10) / 10 : null } });
  } else if (daysLeft < 7) {
    await raise(base44, { key, kind: 'twilio_balance', severity: 'info', notifyOwner: true, title: `Twilio balance covers under a week ($${balance.toFixed(2)})`, detail: `${summary} Top up or turn on Twilio auto-recharge.`, data: { balance, sent_7d: sent, weekly, daily, days_left: Math.round(daysLeft * 10) / 10 } });
  } else await resolveStale(base44, 'twilio_balance', []);
}

/** Billing problems the agent needs to fix: shown as a banner in their app and emailed once a day. */
async function checkBilling(base44: any) {
  const E = base44.asServiceRole.entities, config = await platformConfig(E);
  const open: Record<string, string[]> = { payment_failed: [], recharge_failed: [], low_balance: [] };
  let cursor: string | undefined;
  do {
    const page = await E.AgentSettings.filter({ status: { $in: ['live', 'onboarding'] } }, { limit: 100, cursor, fields: ['agent_email', 'status', 'first_name'] });
    const emails = page.items.map((a: any) => a.agent_email);
    const accts = emails.length ? (await E.BillingAccount.filter({ agent_email: { $in: emails } }, { limit: 100 })).items : [];
    for (const a of page.items) {
      if (exempt(config, a.agent_email)) continue;
      const w = accts.find((x: any) => x.agent_email === a.agent_email);
      if (!w) continue;
      const billing = `${APP_ORIGIN}/credits`;
      if (w.subscription_id && ['past_due', 'unpaid'].includes(w.subscription_status)) {
        const key = `payment_failed:${a.agent_email}`; open.payment_failed.push(key);
        const paused = !subscriptionOkFor(config, w, a.agent_email);
        await raise(base44, {
          key, kind: 'payment_failed', agent_email: a.agent_email, agent_visible: true, severity: paused ? 'critical' : 'warning',
          title: paused ? 'Texting is paused: your subscription payment failed' : 'Your subscription payment didn’t go through',
          detail: paused ? 'Update your card to turn texting back on. Your leads and conversations are safe.' : 'We’ll retry automatically. Update your card now so texting never pauses.',
          action_label: 'Update card', action_href: '/credits', notifyOwner: paused,
          notifyAgent: { subject: paused ? 'Action needed: LeadRespark texting is paused' : 'Your LeadRespark payment didn’t go through', body: `Hi ${a.first_name || 'there'},\n\nYour LeadRespark subscription payment didn't go through${paused ? ', so texting is paused' : ''}. Your leads, conversations and calendar are all safe.\n\nUpdate your card here (takes a minute): ${billing}\n\nLeadRespark`, cooldownHours: 48 },
        });
      }
      if (w.last_recharge_error && w.auto_recharge) {
        const key = `recharge_failed:${a.agent_email}`; open.recharge_failed.push(key);
        await raise(base44, {
          key, kind: 'recharge_failed', agent_email: a.agent_email, agent_visible: true, severity: 'warning',
          title: 'Auto-reload of text credits failed', detail: `Your card was declined when topping up text credits. Texts pause when the balance runs out. (${String(w.last_recharge_error).slice(0, 120)})`,
          action_label: 'Fix card', action_href: '/credits',
          notifyAgent: { subject: 'Your LeadRespark text credits couldn’t reload', body: `Hi ${a.first_name || 'there'},\n\nWe tried to top up your text credits but the card was declined. When your balance runs out, texting pauses.\n\nFix it here: ${billing}\n\nLeadRespark`, cooldownHours: 48 },
        });
      } else if (a.status === 'live' && (Number(w.balance_cents) || 0) < 300 && !w.auto_recharge) {
        const key = `low_balance:${a.agent_email}`; open.low_balance.push(key);
        await raise(base44, {
          key, kind: 'low_balance', agent_email: a.agent_email, agent_visible: true, severity: 'warning',
          title: `Text credits are almost out ($${((Number(w.balance_cents) || 0) / 100).toFixed(2)} left)`, detail: 'Add credits or turn on auto-reload so your follow-up doesn’t stop.',
          action_label: 'Add credits', action_href: '/credits',
          notifyAgent: { subject: 'Your LeadRespark text credits are almost out', body: `Hi ${a.first_name || 'there'},\n\nYou're down to $${((Number(w.balance_cents) || 0) / 100).toFixed(2)} in text credits. When it hits zero, texting pauses.\n\nAdd credits or turn on auto-reload: ${billing}\n\nLeadRespark`, cooldownHours: 72 },
        });
      }
    }
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  for (const [kind, keys] of Object.entries(open)) await resolveStale(base44, kind, keys);
}

async function checkRegistrations(base44: any) {
  const E = base44.asServiceRole.entities, open: Record<string, string[]> = { a2p_stuck: [], a2p_rejected: [] };
  const regs = (await E.A2PRegistration.filter({ $or: [{ status: { $in: ['brand_submitted', 'campaign_submitted', 'otp_pending', 'rejected'] } }, { provider_step: 'platform_wait' }] }, { limit: 200 })).items;
  let waiting = 0;
  for (const r of regs) {
    if (r.provider_step === 'platform_wait') { waiting++; continue; }
    if (r.status === 'rejected') {
      const key = `a2p_rejected:${r.agent_email}`; open.a2p_rejected.push(key);
      await raise(base44, { key, kind: 'a2p_rejected', agent_email: r.agent_email, agent_visible: true, severity: 'warning', title: 'Your texting registration needs changes', detail: String(r.review_note || 'The carriers asked for changes.').slice(0, 400), action_label: 'Fix registration', action_href: '/setup/texting-registration', notifyOwner: true });
      continue;
    }
    const since = Date.parse(r.submitted_at || r.updated_date || '');
    if (since && Date.now() - since > 7 * DAY) {
      const key = `a2p_stuck:${r.agent_email}`; open.a2p_stuck.push(key);
      await raise(base44, { key, kind: 'a2p_stuck', agent_email: r.agent_email, severity: 'warning', title: `Texting registration in review for ${Math.round((Date.now() - since) / DAY)} days`, detail: `Status: ${r.status}. ${r.review_note || ''}`.slice(0, 400), notifyOwner: true });
    }
  }
  if (waiting) {
    const key = 'a2p_platform_wait'; open.a2p_stuck.push(key);
    await raise(base44, { key, kind: 'a2p_stuck', severity: 'warning', title: `${waiting} agent${waiting === 1 ? ' is' : 's are'} waiting on your Twilio ISV setup`, detail: 'Twilio still won’t let agent subaccounts use your Primary Customer Profile. Follow up on your Twilio support ticket.', data: { waiting } });
  }
  for (const [kind, keys] of Object.entries(open)) await resolveStale(base44, kind, keys);
}

/** Replies nobody answered: the AI pipeline is stuck, or drafts are waiting on the agent. */
async function checkReplies(base44: any) {
  const E = base44.asServiceRole.entities, open: Record<string, string[]> = { unanswered: [], drafts_waiting: [] };
  const recent = await E.Lead.filter({ last_inbound_at: { $gte: ago(DAY), $lte: ago(30 * MIN) }, status: { $nin: ['needs_human', 'opted_out', 'not_interested', 'client', 'closed'] } }, { limit: 500, fields: ['agent_email', 'last_inbound_at', 'last_outbound_at', 'ai_paused'] });
  const stuck = recent.items.filter((l: any) => !l.ai_paused && (!l.last_outbound_at || l.last_outbound_at < l.last_inbound_at));
  const ids = stuck.map((l: any) => l.id);
  const drafted = ids.length ? new Set((await E.AIDraft.filter({ lead_id: { $in: ids }, status: 'pending' }, { limit: 500, fields: ['lead_id'] })).items.map((d: any) => d.lead_id)) : new Set();
  const per: Record<string, number> = {};
  for (const l of stuck) if (!drafted.has(l.id)) per[l.agent_email] = (per[l.agent_email] || 0) + 1;
  for (const [email, n] of Object.entries(per)) {
    const key = `unanswered:${email}`; open.unanswered.push(key);
    await raise(base44, { key, kind: 'unanswered', agent_email: email, severity: n >= 5 ? 'critical' : 'warning', title: `${n} repl${n === 1 ? 'y has' : 'ies have'} gone unanswered for 30+ minutes`, detail: 'Neither an AI reply nor a draft was created. The reply pipeline may be stuck.', notifyOwner: true, data: { count: n } });
  }
  // Review mode: drafts waiting on the agent for over 2 hours. Nudge them (gently, once every 4 hours).
  const old = await E.AIDraft.filter({ status: 'pending', created_date: { $lte: ago(2 * HOUR) } }, { limit: 500, fields: ['agent_email'] });
  const waiting: Record<string, number> = {};
  for (const d of old.items) waiting[d.agent_email] = (waiting[d.agent_email] || 0) + 1;
  // Auto-reply agents' drafts just wait for sending hours; only Review-mode agents need a nudge.
  const reviewers = Object.keys(waiting).length ? new Set((await E.AgentSettings.filter({ agent_email: { $in: Object.keys(waiting) }, mode: { $ne: 'autopilot' } }, { limit: 200, fields: ['agent_email'] })).items.map((a: any) => a.agent_email)) : new Set();
  for (const [email, n] of Object.entries(waiting)) {
    if (!reviewers.has(email)) continue;
    const key = `drafts_waiting:${email}`; open.drafts_waiting.push(key);
    await raise(base44, {
      key, kind: 'drafts_waiting', agent_email: email, agent_visible: true, severity: 'info',
      title: `${n} lead${n === 1 ? ' is' : 's are'} waiting on your approval`, detail: 'They replied and the AI drafted an answer. Approve it before they go cold.',
      action_label: 'Review replies', action_href: '/inbox?filter=drafts',
      notifyAgent: { subject: `${n} lead${n === 1 ? '' : 's'} waiting for your reply`, body: `${n} of your leads replied and the AI has a response ready for each. They're waiting on your approval.\n\nReview them: ${APP_ORIGIN}/inbox?filter=drafts\n\nTip: once you trust the AI, switch to "Auto-reply on" in your Profile and it answers instantly.`, text: `LeadRespark: ${n} lead${n === 1 ? '' : 's'} replied and ${n === 1 ? 'is' : 'are'} waiting on your approval. ${APP_ORIGIN}/inbox?filter=drafts`, cooldownHours: 4 },
    });
  }
  for (const [kind, keys] of Object.entries(open)) await resolveStale(base44, kind, keys);
}

/** What to say for each setup step an agent is stuck on. */
const SETUP_COPY: Record<string, { title: string; why: string; href: string }> = {
  workspace: { title: 'Finish building your workspace', why: 'It takes about a minute and sets up your contacts, calendar and pipeline.', href: '/welcome' },
  billing: { title: 'Add your card', why: 'Texts are paid from a prepaid balance, so your card has to be on file before anything sends.', href: '/credits' },
  subscription: { title: 'Start your LeadRespark plan', why: 'Your AI, number and calendar booking all turn on with your plan.', href: '/credits' },
  number: { title: 'Pick your texting number', why: 'Choose a local area code your leads will recognize. It takes 30 seconds.', href: '/setup/number' },
  registration: { title: 'Submit your texting registration', why: 'Carriers require it before business texts are delivered. We wrote all of it for you; you just confirm your details.', href: '/setup/texting-registration' },
  test: { title: 'Send yourself a test text', why: 'One tap from your dashboard. Reply YES and you go live.', href: '/dashboard' },
  leads: { title: 'Upload your leads', why: 'Drop in a CSV of old leads and the AI starts working them the moment you’re live.', href: '/contacts/import' },
};

/** Agents who signed up but stalled: nudge them at 1, 3 and 7 days toward the exact next step. */
async function checkSetup(base44: any) {
  const E = base44.asServiceRole.entities, open: string[] = [];
  const stalled = await E.AgentSettings.filter({ status: { $ne: 'live' }, self_serve: true, created_date: { $lte: ago(DAY), $gte: ago(30 * DAY) } }, { limit: 100 });
  for (const s of stalled.items) {
    const r = await readiness(E, s).catch(() => null);
    if (!r) continue;
    const reg = (await E.A2PRegistration.filter({ agent_email: s.agent_email }, { limit: 1, fields: ['status', 'provider_step'] })).items[0];
    const regPending = reg && (reg.provider_step === 'platform_wait' || ['queued', 'brand_submitted', 'otp_pending', 'campaign_submitted'].includes(reg.status));
    // Skip steps that are waiting on carriers or on us; nudge the next thing they can actually do.
    const next = r.items.find((i: any) => !i.done && !(i.key === 'registration' && regPending) && !(i.key === 'test' && !r.can_test));
    if (!next) continue;
    const days = Math.floor((Date.now() - Date.parse(s.created_date)) / DAY);
    const stage = days >= 7 ? 3 : days >= 3 ? 2 : 1;
    // The key carries the stage (1d, 3d, 7d): each stage is one signal and one nudge email. When the stage
    // advances the old key is resolved below and the new one nudges once; a repeat run only bumps the count.
    const key = `setup_stalled:${s.agent_email}:s${stage}`; open.push(key);
    const copy = SETUP_COPY[next.key] || { title: next.label, why: '', href: next.href || '/dashboard' };
    const done = r.items.filter((i: any) => i.done).length;
    await raise(base44, {
      key, kind: 'setup_stalled', agent_email: s.agent_email, severity: 'info',
      title: `Setup stalled ${days}d at “${next.label}” (${done}/${r.items.length} done)`, detail: copy.why,
      data: { step: next.key, days, stage, done, total: r.items.length },
      notifyAgent: { subject: `${s.first_name ? `${s.first_name}, your` : 'Your'} next step: ${copy.title.toLowerCase()}`, body: `Hi ${s.first_name || 'there'},\n\nYou're ${done} of ${r.items.length} steps into LeadRespark. Next up: ${copy.title.toLowerCase()}.\n\n${copy.why}\n\nPick up where you left off: ${APP_ORIGIN}${copy.href}\n\nQuestions? Tap "Get help" in the app and we'll get back to you.\n\nLeadRespark`, cooldownHours: 24 * 365 },
    });
  }
  await resolveStale(base44, 'setup_stalled', open);
}

/** Agents whose calendar leaves the AI almost nothing to offer: one nudge, resolved when hours open up. */
async function checkCalendars(base44: any) {
  const E = base44.asServiceRole.entities, open: string[] = [];
  const { freeSlots } = await import('./messageBooking.ts');
  const agents = await E.AgentSettings.filter({ status: { $in: ['live', 'onboarding'] }, connected: true, calendar_id: { $exists: true, $nin: ['', null] } }, { limit: 100 });
  for (const s of agents.items) {
    if (isRehearsal(s)) continue;
    const leads = await E.Lead.count({ agent_email: s.agent_email, status: { $in: ['queued', 'in_sequence', 'replied', 'engaged'] } }).catch(() => 0);
    if (leads < 10) continue;
    let slots: string[] = [];
    try { slots = await freeSlots(s, { timezone: s.home_timezone }, E); } catch { continue; }
    const week = slots.filter(t => Date.parse(t) < Date.now() + 7 * DAY).length;
    if (week >= 10) continue;
    const key = `calendar_thin:${s.agent_email}`; open.push(key);
    await raise(base44, {
      key, kind: 'calendar_thin', agent_email: s.agent_email, severity: 'warning',
      title: `${s.first_name || s.agent_email}: only ${week} open call times in the next 7 days`,
      detail: `${leads} leads are being worked and the AI will run out of times to offer. ${s.busy_calendar_url ? 'Their linked personal calendar blocks most of their hours.' : 'Their hours are narrow.'}`,
      data: { open_7d: week, leads },
      notifyAgent: { subject: `Only ${week} open call times this week`, body: `Hi ${s.first_name || 'there'},\n\nYour AI has ${leads} leads to work but only ${week} open times to offer in the next 7 days${s.busy_calendar_url ? ', because your linked calendar blocks most of your hours' : ''}. When it runs out, interested leads get held for you instead of booked.\n\nOpen a few more hours, or unlink the busy calendar, here:\n${APP_ORIGIN}/setup/calendar\n\nLeadRespark` },
    });
  }
  await resolveStale(base44, 'calendar_thin', open);
}

export async function runHealth(base44: any) {
  const results: Record<string, string> = {};
  for (const [name, fn] of [['jobs', checkJobs], ['sends', checkSends], ['ai', checkAI], ['billing', checkBilling], ['funding', checkFunding], ['registrations', checkRegistrations], ['replies', checkReplies], ['setup', checkSetup], ['calendars', checkCalendars]] as const) {
    try { await fn(base44); results[name] = 'ok'; } catch (e) { results[name] = `error: ${String((e as Error).message).slice(0, 160)}`; console.error('[health]', name, e); }
  }
  await heartbeat(base44, 'health', results);
  return results;
}
