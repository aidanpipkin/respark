// The follow-up series: writes each step for one lead and sends it (or drafts it for review).
// Two kinds of series run on this engine:
//  - Cadence series (Life Insurance Respark): steps carry a day and a time slot; the lead's own
//    start date anchors them, Sundays and holidays are skipped, and no lead gets more than 3
//    texts in 24 hours.
//  - Classic series (older playbooks): steps carry a day offset and use the agent's send windows.
import { scope } from './ghl.ts';
import { basicSafety } from './messageSafety.ts';
import { clockOpen, nextWindow } from './messageClock.ts';
import { claimJob, finishJob, logMessage } from './messageJobs.ts';
import { sendSms } from './messageSender.ts';
import { guardrailCheck } from './guardrails.ts';
import { leadProfile } from './leadProfile.ts';
import { writeStep, fillTemplate } from './sequenceWriter.ts';
import { leadContext } from './leadContext.ts';
import { afterSeries, freshLead } from './followUpSchedule.ts';
import { cadenceOpen, nextCadenceWindow, stepTime } from './cadenceClock.ts';
import { isTestLead } from './rehearsal.ts';
import { canSend } from './credits.ts';

const DAY = 86400000;
export const MAX_PER_24H = 3;

/** The cadence this lead runs on (fixed when they start, so switching a campaign never reshuffles a lead mid-series). */
export const cadenceOf = (lead: any, campaign: any) => lead.cadence || campaign?.cadence || '';

/**
 * A lead still inside the "just arrived" window: came through the lead webhook and started the series
 * less than a day ago. Steps marked `fresh_only` (same-day bursts) go only to these leads.
 */
export function freshSeries(lead: any, now = Date.now()) {
  if (!String(lead?.import_batch || '').startsWith('webhook')) return false;
  const started = Date.parse(lead?.sequence_started_at || lead?.created_date || '') || now;
  return now - started < DAY;
}

function stepQuery(campaign: any, cadence: string, number: number, variant: string) {
  const q: any = { campaign_id: campaign.id, step_number: number, variant };
  if (cadence) q.cadence = cadence;
  return q;
}

/**
 * Objects the worker already holds, so one lead's send does not read them again:
 *  steps: every SequenceStep of the agent's active campaigns; campaign; settings; billing (credits.billingContext).
 */
export type SequenceContext = { steps?: any[]; campaign?: any; billing?: any };

/** The step matching `q` from an in-memory list (same fields as the entity query). */
function matchSteps(steps: any[], q: any) {
  return steps.filter(st => Object.entries(q).every(([k, v]: [string, any]) => {
    if (v && typeof v === 'object' && Array.isArray(v.$in)) return v.$in.includes(st[k]);
    if (v && typeof v === 'object' && v.$gt !== undefined) return Number(st[k]) > Number(v.$gt);
    return st[k] === v;
  }));
}

export async function composeStep(base44: any, s: any, lead: any, campaign: any, step: any) {
  const template = fillTemplate(step.body, lead, s);
  let profile: any = {};
  try { profile = await leadProfile(base44, s, lead); } catch { profile = { first_name: lead.first_name || '', state: lead.state || '' }; }
  let ctx: any = null;
  try { ctx = await leadContext(base44.asServiceRole.entities, s, lead, 30); } catch { ctx = null; }
  const previous = (ctx?.turns || []).filter((t: any) => t.direction === 'outbound').slice(-12).map((t: any) => t.text);
  const written = await writeStep(base44, s, lead, campaign, step, profile, previous, ctx);
  const text = written.text;
  if (/\{[^}]+\}/.test(text)) throw new Error('Follow-up message failed safety checks.');
  // Verbatim steps are agent-approved copy sent as written: wording flags are logged, not enforced.
  const guard = guardrailCheck(text);
  if (!guard.passed) { if (step.verbatim === true) console.warn('[sequence] verbatim step sent with guardrail flags', step.step_number, guard.flags); else throw new Error('Follow-up message failed safety checks.'); }
  return { text, template, personalization: { personalized: written.personalized, angle: written.angle, facts_used: written.facts_used, model: written.model, rewrites: written.attempts.length, fallback_reason: written.personalized ? '' : (written.attempts.at(-1)?.flags || ['Personalization off']).join('; ').slice(0, 300) } };
}

/**
 * The next step after `number` and when it is due. Cadence steps that land on a Sunday or holiday
 * are skipped (the series keeps its shape instead of stacking texts on Monday).
 */
async function nextStep(E: any, s: any, lead: any, campaign: any, cadence: string, number: number, started: string, steps?: any[]) {
  const q: any = { campaign_id: lead.campaign_id, step_number: { $gt: number }, variant: { $in: ['none', 'A'] } };
  if (cadence) q.cadence = cadence;
  const items = steps ? matchSteps(steps, q).sort((a, b) => Number(a.step_number) - Number(b.step_number)).slice(0, 15) : (await E.SequenceStep.filter(q, { sort: 'step_number', limit: 15 })).items;
  const rules = campaign?.send_rules || null;
  const fresh = freshSeries(lead);
  const tz = lead.timezone || s.home_timezone || 'America/Chicago';
  for (const step of items) {
    // Same-day burst steps exist only for leads that just arrived; everyone else skips past them.
    if (step.fresh_only === true && !fresh) continue;
    // Fictional test leads run the series on a compressed clock (one step every 10 minutes, any hour), so an
    // agent can watch the whole thing the same day instead of over 60 days.
    if (isTestLead(lead)) return { step, at: new Date(Date.now() + 10 * 60000).toISOString(), skipped: 0 };
    // Minutes after the previous text (fresh-lead bursts), clamped into the sending window.
    if (Number(step.offset_minutes) > 0) {
      const base = Date.parse(lead.last_outbound_at || '') || Date.now();
      const want = Math.max(Date.now() + 60000, base + Number(step.offset_minutes) * 60000);
      const open = cadence ? cadenceOpen(s, tz, want, rules, lead.state) : clockOpen(s, lead.timezone, false, new Date(want));
      const at = open ? new Date(want).toISOString() : cadence ? nextCadenceWindow(s, tz, want, rules, lead.state) : nextWindow(s, lead.timezone, want, false);
      return { step, at, skipped: step.step_number - number - 1 };
    }
    if (cadence && step.slot) {
      const at = stepTime(s, lead, started, step.day_offset || 0, step.slot, ['breakup', 'close'].includes(step.kind), rules);
      if (!at) continue; // Sunday or holiday
      return { step, at: new Date(Math.max(Date.parse(at), Date.now() + 60000)).toISOString(), skipped: step.step_number - number - 1 };
    }
    return { step, at: nextWindow(s, lead.timezone, Math.max(Date.now() + 60000, Date.parse(started) + (step.day_offset || 0) * DAY)), skipped: 0 };
  }
  return null;
}

export async function advanceSequence(base44: any, s: any, leadId: string, step: number, ctx: SequenceContext = {}) {
  const E = base44.asServiceRole.entities;
  // Fresh read on purpose: the send just changed the lead, and the CAS below needs its current updated_date.
  const lead = await E.Lead.get(leadId);
  if (lead.last_inbound_at || !['queued', 'in_sequence'].includes(lead.status) || (lead.current_step || 0) >= step) return;
  const started = lead.sequence_started_at || new Date().toISOString();
  const campaign = (ctx.campaign && ctx.campaign.id === lead.campaign_id) ? ctx.campaign : await E.Campaign.get(lead.campaign_id).catch(() => null);
  const cadence = cadenceOf(lead, campaign);
  const next = await nextStep(E, s, lead, campaign, cadence, step, started, ctx.steps);
  // Skipped (Sunday/holiday) steps count as passed, so the lead's step number matches the next one due.
  const current = next ? next.step.step_number - 1 : step;
  const changed = await E.Lead.updateMany({ id: lead.id, updated_date: lead.updated_date }, { $set: {
    current_step: current, sequence_waiting_review: false, sequence_started_at: started, ...(cadence ? { cadence } : {}),
    status: next ? 'in_sequence' : 'closed', sequence_paused: !next, next_send_at: next ? next.at : '', ...(next ? {} : afterSeries()),
  } });
  if (changed.updated && lead.status !== (next ? 'in_sequence' : 'closed')) await logMessage(base44, s, lead, { event_type: 'status_changed', direction: 'internal', source: 'engine', status: next ? 'in_sequence' : 'closed', body: 'Follow-up series advanced.' });
}

/** Texts sent to this lead in the last 24 hours, and when the oldest of them ages out. */
async function recentSends(E: any, s: any, lead: any) {
  const since = new Date(Date.now() - DAY).toISOString();
  const page = await E.MessageLog.filter({ agent_email: s.agent_email, lead_id: lead.id, event_type: 'sms_sent', occurred_at: { $gte: since } }, { sort: 'occurred_at', limit: MAX_PER_24H });
  return { count: page.items.length, oldest: page.items[0]?.occurred_at };
}

export async function runSequenceLead(base44: any, s: any, lead: any, campaign: any, ctx: SequenceContext = {}) {
  const E = base44.asServiceRole.entities;
  basicSafety(s, lead, 'sequence', false);
  const cadence = cadenceOf(lead, campaign);
  const tz = lead.timezone || s.home_timezone || 'America/Chicago';
  const rules = campaign?.send_rules || null;

  // Sending window (fictional test leads ignore it, and the 3-per-day cap: nothing reaches a phone).
  const test = isTestLead(lead);
  if (test) { /* always open */ } else if (cadence) {
    if (!cadenceOpen(s, tz, Date.now(), rules, lead.state)) { await E.Lead.update(lead.id, { next_send_at: nextCadenceWindow(s, tz, Date.now() + 300000, rules, lead.state) }); return { skipped: 'sending window' }; }
  } else if (!clockOpen(s, lead.timezone, !freshLead(lead))) {
    await E.Lead.update(lead.id, { next_send_at: nextWindow(s, lead.timezone, Date.now() + 300000, !freshLead(lead)) });
    return { skipped: 'sending window' };
  }
  const number = (lead.current_step || 0) + 1;
  if (number > 1 && !lead.step1_delivered) return { skipped: 'awaiting opener delivery' };

  // Never more than 3 texts in 24 hours to one person (Florida, Oklahoma, Maryland and Oregon law; good practice everywhere).
  const recent = test ? { count: 0, oldest: '' } : await recentSends(E, s, lead);
  if (recent.count >= MAX_PER_24H) {
    const free = Date.parse(recent.oldest) + DAY + 5 * 60000;
    await E.Lead.update(lead.id, { next_send_at: cadence ? nextCadenceWindow(s, tz, free, rules, lead.state) : nextWindow(s, lead.timezone, free) });
    return { skipped: 'contact limit' };
  }

  const variant = lead.variant || campaign.ab_winner || ((lead.id.charCodeAt(lead.id.length - 1) % 2) ? 'A' : 'B');
  const q = stepQuery(campaign, cadence, number, number === 1 ? variant : 'none');
  // A step may exist twice, as a fresh-lead version (`fresh_only`) and the regular one; pick by the lead's arrival.
  const candidates: any[] = ctx.steps ? matchSteps(ctx.steps, q) : (await E.SequenceStep.filter(q, { limit: 4 })).items;
  const fresh = freshSeries(lead);
  const step = candidates.find((st: any) => !!st.fresh_only === fresh) || candidates.find((st: any) => !st.fresh_only);
  if (!step) return { skipped: 'no step' };
  const startPatch: any = {};
  if (!lead.variant) startPatch.variant = variant;
  if (cadence && !lead.cadence) startPatch.cadence = cadence;
  // Keep the lead object current (updated_date is the send lock's CAS key).
  if (Object.keys(startPatch).length) { const saved = await E.Lead.update(lead.id, startPatch); lead = saved?.id ? saved : { ...lead, ...startPatch }; }

  // Review mode is for conversational AI replies. The pre-written follow-up series always sends directly
  // while the campaign is active; a campaign can opt back into per-step approval with review_sequence.
  if (campaign.review_sequence === true && (campaign.mode !== 'autopilot' || s.mode !== 'autopilot')) {
    const claim = await claimJob(base44, s, `sequence-draft:${lead.id}:${number}`, 'draft', lead.id);
    if (!claim.claimed) return { skipped: 'suggested reply already prepared' };
    let composed;
    try { composed = await composeStep(base44, s, lead, campaign, step); }
    catch (error: any) { await finishJob(base44, claim.job, { error: error.message }, 'uncertain'); throw error; }
    const { text, template, personalization } = composed;
    const draft = await E.AIDraft.create({ ...scope(s), campaign_id: campaign.id, lead_id: lead.id, proposed_text: text, template_text: template, personalization, proposed_action: 'none', source: 'sequence', step_number: number, variant, status: 'pending', guardrail_flags: { passed: true, flags: [] } });
    await E.Lead.update(lead.id, { sequence_waiting_review: true });
    await E.ConversationSummary.updateMany({ agent_email: s.agent_email, lead_id: lead.id }, { $set: { has_pending_draft: true } });
    await finishJob(base44, claim.job, { draft_id: draft.id });
    return { drafted: true };
  }
  // The AI writer costs real money: check the wallet can pay for the text before writing it.
  if (!isTestLead(lead) && !(await canSend(E, s.agent_email, ctx.billing || {}))) { const e: any = new Error('Add text credits to keep the series going.'); e.name = 'OutOfCredits'; throw e; }
  const { text } = await composeStep(base44, s, lead, campaign, step);
  const result = await sendSms(base44, lead.id, text, 'sequence', `sequence:${lead.id}:${number}`, { step_number: number, automatic: true, lead, settings: s, campaign, billing: ctx.billing });
  if (result.sent) await advanceSequence(base44, s, lead.id, number, { ...ctx, campaign });
  return result;
}
