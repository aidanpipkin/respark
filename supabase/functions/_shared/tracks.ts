// Post-appointment pipeline. After every call the agent picks an outcome; each outcome is its own
// column with its own text track written by the AI from the full lead picture:
//   no_show      – rebook the missed call
//   follow_up    – talked, still deciding: education, great questions, gentle closing
//   lost_banking – stopped at bank details: handle that objection
//   lost_social  – stopped at SSN: handle that objection
//   client       – closed: exact policy details, first-premium reminder, 3/6/9/12-month care, referrals
import { guardrailCheck, conditions } from './guardrails.ts';
import { localParts } from './messageClock.ts';

export const DAY = 86400000;
export const TRACKS = ['no_show', 'follow_up', 'lost_banking', 'lost_social', 'client'] as const;
export type Track = typeof TRACKS[number];
export const OUTCOMES = ['no_show', 'follow_up', 'lost_banking', 'lost_social', 'closed'] as const;

export const TRACK_LABEL: Record<string, string> = { no_show: 'No-show', follow_up: 'Follow-up', lost_banking: 'Lost at banking', lost_social: 'Lost at social', client: 'Client' };

/**
 * `text`: agent-written copy sent exactly as written (tokens {first} {agent} {carrier} {coverage}); the AI
 * writer is skipped. Without it the AI writes the text from `brief`.
 */
type Step = { key: string; after_hours: number; brief: string; offer?: boolean; text?: string };

const ASK_NEVER = 'Never ask them to text bank, routing, account or Social Security numbers. Never state prices, premiums, amounts or approval.';

export const TRACK_STEPS: Record<string, Step[]> = {
  no_show: [
    { key: 'ns1', after_hours: 0.25, offer: true, brief: 'They missed their call with the agent a little while ago. Zero guilt ("looks like we missed each other", life happens). Make it effortless to pick a new time.' },
    { key: 'ns2', after_hours: 24, brief: 'Next day. Remind them, in their own words, why they booked the call in the first place, and ask if it is still worth 15 minutes.' },
    { key: 'ns3', after_hours: 72, offer: true, brief: 'Offer two specific new times. Keep it short and friendly.' },
    { key: 'ns4', after_hours: 168, brief: 'Results-based: paint the outcome they wanted (family taken care of, peace of mind). Ask whether it is still a priority or whether timing changed.' },
    { key: 'ns5', after_hours: 336, brief: 'Permission-based takeaway: ask whether they want you to keep a spot open for them or close their file for now.' },
    { key: 'ns6', after_hours: 720, brief: 'Final warm note: the door stays open whenever they are ready. One simple yes/no question.' },
  ],
  follow_up: [
    { key: 'fu1', after_hours: 20, brief: 'Thank them for the call. Recap the one thing they said mattered most (from the notes) and ask a thoughtful question about it.' },
    { key: 'fu2', after_hours: 72, brief: 'Education: answer the hesitation or question from the call (agent notes) with one short, plain-language insight. Ask if that helps.' },
    { key: 'fu3', after_hours: 144, brief: 'Great question-asking: help them picture life with this protection already in place (future-pacing) using their own reason. Ask one open question.' },
    { key: 'fu4', after_hours: 240, offer: true, brief: 'Gentle close with a choice of two: a quick call to finish the application. Assume the yes politely.' },
    { key: 'fu5', after_hours: 360, brief: 'Ask what is still holding them back, framed so any honest answer is welcome. No pressure, no numbers.' },
    { key: 'fu6', after_hours: 600, brief: 'Permission-based takeaway: should you keep their application open or close it out for now?' },
  ],
  // Approval Recovery drip (from the per-agent Respark stack, legacy_respark approvalRecovery.ts): six texts
  // over 14 days in the agent's own voice for applications approved on the phone that stalled at the final
  // review / banking step. Sent word for word; the first reply stops the track (engine rule).
  lost_banking: [
    { key: 'lb1', after_hours: 0, brief: 'Day 1: congratulations, the carrier approved the application; you tried calling and missed them; you need 10 minutes to review it and make sure it is still what they want. Ask what time works today or tomorrow.',
      text: `{first}, {agent} here. Good news, {carrier} came back and you're fully approved for {coverage} we talked about. Congrats, that's the hard part done. I tried you back a couple times and missed you. I just need 10 minutes to go over it with you and make sure it's still what you want to do. What time works today or tomorrow?` },
    { key: 'lb2', after_hours: 24, brief: 'Day 2: their approval is ready; nothing moves forward until the review call, so no surprises. Ask morning or afternoon.',
      text: `{first}, quick one. Your approval is sitting here ready to go. Nothing moves forward until you and I finish that review call, so no surprises on your end. Morning or afternoon better for you?` },
    { key: 'lb3', after_hours: 72, brief: 'Day 4: be straight; the open application holds their personal information and you do not like leaving one open; if they have second thoughts you will close it, no hard feelings; if they still want the coverage, 10 minutes finishes it. Ask which way they want to go.',
      text: `{first}, I'll be straight with you. That application has your personal and health information on it and I don't like leaving one of those sitting open. If you've had second thoughts, just tell me and I'll close it out, no hard feelings. If you still want {coverage}, 10 minutes gets it done. Which way do you want to go?` },
    { key: 'lb4', after_hours: 144, brief: 'Day 7: making sure nothing is wrong on their end; approvals do not stay open forever, the carrier pulls it back if it is not finished. Ask: hold it or let it go?',
      text: `{first}, {agent} again. Just making sure nothing's wrong on your end. Approvals like this don't stay open forever, {carrier} pulls it back if we don't finish up. Want me to hold it for you or let it go?` },
    { key: 'lb5', after_hours: 216, brief: 'Day 10: if the monthly amount made them pause, say so; the face amount or draft date can move to fit the budget. Ask if they want that run.',
      text: `{first}, if it was the monthly amount that made you pause, say so. We can drop the face amount or move the draft date, whatever makes it fit the budget. Want me to run that for you?` },
    { key: 'lb6', after_hours: 312, brief: 'Day 14, last one: the application closes at the end of the week so their information is not sitting out there; text back before then to finish in one quick call. Appreciate them either way.',
      text: `{first}, last one from me on this. I'm going to close out your {carrier} application at the end of the week so your info isn't sitting out there. If you want to keep {coverage} in place, text me back before then and we'll finish it in one quick call. Either way, I appreciate you. {agent}` },
  ],
  lost_social: [
    { key: 'ls1', after_hours: 48, brief: 'They paused at giving their Social Security number. Validate the caution. In plain words: the insurance company uses it to confirm identity and check records for underwriting, and it is entered on the carrier\'s secure application, never by text. Ask what concerned them most.' },
    { key: 'ls2', after_hours: 120, brief: 'Offer to have them give that part directly to the insurance company on a three-way call or on the carrier\'s secure page, so they never share it with anyone else. Ask if that would help.' },
    { key: 'ls3', after_hours: 240, offer: true, brief: 'Reconnect to who they wanted to protect. Offer a short call to finish.' },
    { key: 'ls4', after_hours: 480, brief: 'Address trust: invite them to look up the agent\'s license with their state insurance department. Ask if that would put their mind at ease.' },
    { key: 'ls5', after_hours: 840, brief: 'Permission-based takeaway: keep the application open or close it for now?' },
  ],
};

export const TRACK_GOAL: Record<string, string> = {
  no_show: 'They booked a call and missed it. Goal: rebook without guilt. When they show willingness, offer times (get_free_slots).',
  follow_up: 'They had the call and are still deciding. Goal: bring them back to finish the application using education, great questions and gentle closing techniques (recap their reason, future-pace, choice of two, permission-based takeaway).',
  lost_banking: 'They stopped when asked for bank details. Goal: resolve that objection with empathy and plain facts, then finish the application on a short call. ' + ASK_NEVER,
  lost_social: 'They stopped when asked for their Social Security number. Goal: resolve that objection with empathy and plain facts, then finish on a short call or directly with the carrier. ' + ASK_NEVER,
  client: 'This person is now a CLIENT with an active or pending policy. Be their caring agent: service first, answer simply, never sell or change coverage by text, never quote amounts. Anything about claims, cancelling, changing beneficiaries or payments goes to the agent personally (flag_for_human). Referrals are welcome: if they name someone, thank them and ask for the best number to reach that person.',
};

// ---------- Client retention schedule ----------
export function addMonths(dateStr: string, months: number) {
  const d = new Date(`${dateStr}T15:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() < day) d.setUTCDate(0); // clamp to month end
  return d.getTime();
}

export type Planned = { key: string; at: number; template?: 'welcome' | 'submitted' | 'premium'; brief?: string; offer?: boolean; text?: string };

export function clientSchedule(policy: any, now = Date.now()): Planned[] {
  if (!policy) return [];
  if (policy.status === 'submitted') return [{ key: 'submitted', at: Date.parse(policy.submitted_at || policy.created_at || new Date(now).toISOString()), template: 'submitted' }];
  if (policy.status !== 'approved') return [];
  const approved = Date.parse(policy.approved_at || new Date(now).toISOString());
  const start = policy.coverage_start_date || new Date(approved).toISOString().slice(0, 10);
  const out: Planned[] = [{ key: 'welcome', at: approved, template: 'welcome' }];
  if (policy.first_draft_date) {
    const draft = Date.parse(`${policy.first_draft_date}T15:00:00Z`);
    // Two days before the first draft; one day if that is already past; skip if the draft is too close.
    const two = draft - 2 * DAY, one = draft - DAY;
    const at = two > approved + 2 * 3600000 ? two : one > approved + 2 * 3600000 ? one : 0;
    if (at) out.push({ key: 'premium', at, template: 'premium' });
  }
  out.push({ key: 'c3', at: addMonths(start, 3), brief: 'Three-month check-in as their agent. Warm and service-first: ask how they are doing and whether anything changed in their life (new baby, new home, new job, marriage) that matters for their coverage. No selling.' });
  out.push({ key: 'c6', at: addMonths(start, 6), brief: 'Six-month check-in: ask whether the people they wanted to protect (beneficiaries) are still right, and whether they have any questions about their policy. Offer help.' });
  out.push({ key: 'c9', at: addMonths(start, 9), brief: 'Nine-month check-in plus a first referral ask: thank them for trusting the agent, then ask if anyone in their life (family, coworkers, friends) would want the same peace of mind. Make it easy: reply with a first name and the best number, or pass along the agent\'s number.' });
  out.push({ key: 'c12', at: addMonths(start, 12), brief: 'One-year anniversary: congratulate them on a full year of protection, offer a quick annual review call, and ask if anyone they care about should have the same protection.' });
  for (let y = 2; y <= 10; y++) out.push({ key: `y${y}`, at: addMonths(start, 12 * y), brief: `Annual review, year ${y}: thank them for being a client, ask about life changes, offer a short review call, and invite a referral.` });
  return out;
}

export function trackSchedule(lead: any, policy: any = null): Planned[] {
  if (lead.track === 'client') return clientSchedule(policy);
  const start = Date.parse(lead.track_started_at || lead.last_disposition_at || '') || Date.now();
  return (TRACK_STEPS[lead.track] || []).map(s => ({ key: s.key, at: start + s.after_hours * 3600000, brief: s.brief, offer: s.offer, ...(s.text ? { text: s.text } : {}) }));
}

/** Next unsent step and when it may go (respecting a hold after the lead replied). */
export function nextStep(lead: any, policy: any = null) {
  const done = new Set(lead.track_done || []);
  const step = trackSchedule(lead, policy).find(s => !done.has(s.key));
  if (!step) return null;
  const hold = Date.parse(lead.track_hold_until || '') || 0;
  return { ...step, due: Math.max(step.at, hold) };
}

// ---------- Exact service texts (agent-entered policy data, never AI-written) ----------
export const money = (cents: number) => `$${(Number(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: Number(cents) % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
const FREQ: Record<string, string> = { monthly: 'per month', quarterly: 'per quarter', semi_annual: 'every 6 months', annual: 'per year' };
export const dateLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

export function serviceText(kind: 'welcome' | 'submitted' | 'premium', lead: any, policy: any, s: any) {
  const first = lead.first_name || 'there';
  const agent = String(s.first_name || s.display_name || '').split(/\s+/)[0] || s.brand_name || 'your agent';
  const plan = [policy.carrier, policy.product].filter(Boolean).join(' ');
  if (kind === 'submitted') return `Thank you ${first}. Your ${plan} application is submitted (policy #${policy.policy_number}). I'll text you as soon as it's approved. Reply anytime with questions. - ${agent}`;
  if (kind === 'premium') return `Hi ${first}, a friendly reminder: your first ${policy.carrier} premium of ${money(policy.premium_amount_cents)} is scheduled for ${dateLabel(policy.first_draft_date)}. Please make sure funds are available so your coverage stays active. Questions? Just reply. - ${agent}`;
  return `Congratulations ${first}. Your ${plan} policy is approved. Policy #${policy.policy_number}. Coverage: ${money(policy.coverage_amount_cents)}. Premium: ${money(policy.premium_amount_cents)} ${FREQ[policy.premium_frequency] || ''}. Coverage starts ${dateLabel(policy.coverage_start_date)}. Save this text for your records and reply anytime with questions. - ${agent}`.replace(/\s+\./g, '.');
}

/**
 * Fills an agent-written track text. {carrier} and {coverage} come from the lead's policy when one is on
 * file, otherwise the generic words the original drip used.
 */
export function verbatimTrackText(step: { text?: string }, lead: any, policy: any, s: any) {
  const agent = String(s.first_name || s.display_name || '').split(/\s+/)[0] || s.brand_name || 'your agent';
  const carrier = String(policy?.carrier || '').trim() || 'the carrier';
  const product = String(policy?.product || '').trim();
  const coverage = product ? `the ${product}` : 'the coverage we set up';
  const values: Record<string, string> = { first: lead.first_name || 'there', agent, carrier, coverage };
  return String(step.text || '').replace(/\{([a-z_]+)\}/g, (m, k) => values[k] ?? m);
}

/** Checks for exact service texts: they may include amounts and the word premium, but never health details or links. */
export function serviceCheck(text: string) {
  const flags: string[] = [];
  const t = String(text || '');
  if (!t.trim()) flags.push('Empty text');
  if (t.length > 480) flags.push('Over 480 characters');
  if (conditions.test(t)) flags.push('Named medical condition');
  if (/https?:\/\/|www\./i.test(t)) flags.push('Contains a link');
  if (/\b\d{3}-?\d{2}-?\d{4}\b/.test(t)) flags.push('Looks like an SSN');
  return { passed: flags.length === 0, flags };
}

/** Checks for AI-written track texts. */
export function trackTextCheck(text: string) {
  const t = String(text || '').trim();
  const flags = [...guardrailCheck(t).flags];
  if (!t) flags.push('Empty text');
  if (/\{[^}]+\}/.test(t)) flags.push('Unfilled placeholder');
  if (/https?:\/\/|www\./i.test(t)) flags.push('Contains a link');
  if (/!/.test(t)) flags.push('Exclamation point');
  if (/\b(AI|artificial intelligence|chatbot|software|automated)\b/i.test(t)) flags.push('Mentions software or AI');
  if (/(send|text|reply|share|give)\b.{0,40}\b(ssn|social security|bank|routing|account number|card number)/i.test(t)) flags.push('Asks for sensitive numbers by text');
  return { passed: flags.length === 0, flags };
}

export function fallbackTrackText(track: string, lead: any, s: any) {
  const first = lead.first_name ? `${lead.first_name}, ` : '';
  const agent = String(s.first_name || s.display_name || 'your agent').split(/\s+/)[0];
  switch (track) {
    case 'no_show': return `${first}looks like we missed each other. No problem at all. Want me to find a new time for you and ${agent} to talk?`;
    case 'follow_up': return `${first}thanks again for your time with ${agent}. Any questions come up since you two talked?`;
    case 'lost_banking':
    case 'lost_social': return `${first}totally understand wanting to be careful. Would it help to finish that step directly with the insurance company on a quick call?`;
    default: return `Hi ${lead.first_name || 'there'}, ${agent} here checking in. How is everything going? Anything I can help with?`;
  }
}

/** What the AI should know about where this lead sits in the pipeline. */
export function trackContext(lead: any, policy: any = null) {
  if (!lead.track) return null;
  const ctx: any = { column: TRACK_LABEL[lead.track], goal: TRACK_GOAL[lead.track], outcome_logged: lead.last_disposition_at || undefined, agents_call_notes: lead.disposition_note || undefined };
  if (lead.track === 'client' && policy) {
    ctx.policy = { carrier: policy.carrier, product: policy.product, status: policy.status, coverage_start_date: policy.coverage_start_date, beneficiary_on_file: policy.beneficiary ? 'yes' : 'unknown' };
    const start = Date.parse(`${policy.coverage_start_date}T12:00:00Z`);
    if (Number.isFinite(start)) ctx.months_as_client = Math.max(0, Math.floor((Date.now() - start) / (30.44 * DAY)));
  }
  return ctx;
}

export function nowLocalDate(tz: string) { return localParts(Date.now(), tz).date; }
