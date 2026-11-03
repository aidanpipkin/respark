// When LeadRespark follows up again, so no lead is ever dropped:
//  - Nudges: they replied, then went quiet after our text. 2, 5 and 12 days later.
//  - Long-term check-ins: the series ended with no reply, nudges ran out, or they said "not now".
//    30, 45, 60, 90, 90 and 120 days apart, then we stop for good.
export const DAY = 86400000;
export const NUDGE_GAPS_DAYS = [2, 5, 12];
export const NURTURE_GAPS_DAYS = [30, 45, 60, 90, 90, 120];
export const NOT_NOW_DAYS = 60;
export const ACTIVE_CONVERSATION = ['replied', 'engaged'];

const at = (days: number, from = Date.now()) => new Date(from + days * DAY).toISOString();

/** Lead fields to set right after an outbound text was accepted. */
export function afterSend(lead: any, source: string, now = Date.now()) {
  const out: Record<string, any> = {};
  // Leads in a post-appointment track are followed up by that track, not by nudges.
  if (['ai', 'manual', 'nudge'].includes(source) && ACTIVE_CONVERSATION.includes(lead.status) && !lead.ai_paused && !lead.track) {
    const n = source === 'nudge' ? (Number(lead.nudge_count) || 0) + 1 : Number(lead.nudge_count) || 0;
    out.nudge_count = n;
    // After the last nudge, one more wait; then the sweep moves them to long-term check-ins.
    out.next_nudge_at = at(n < NUDGE_GAPS_DAYS.length ? NUDGE_GAPS_DAYS[n] : 7, now);
  }
  if (source === 'nurture') {
    const n = (Number(lead.nurture_count) || 0) + 1;
    out.nurture_count = n;
    out.next_nurture_at = n < NURTURE_GAPS_DAYS.length ? at(NURTURE_GAPS_DAYS[n], now) : '';
  }
  return out;
}

/** Lead fields when the follow-up series ends without a reply. */
export function afterSeries(now = Date.now()) {
  return { next_nurture_at: at(NURTURE_GAPS_DAYS[0], now), nurture_count: 0, revisit_reason: 'Finished the follow-up series without replying' };
}

/** Lead fields when nudges ran out mid-conversation. */
export function afterNudges(now = Date.now()) {
  return { status: 'closed', next_nudge_at: '', next_nurture_at: at(NURTURE_GAPS_DAYS[0], now), nurture_count: 0, revisit_reason: 'Went quiet mid-conversation' };
}

/** Lead fields when they say "not now": a respectful check-in later instead of losing them. */
export function afterNotNow(now = Date.now()) {
  return { status: 'closed', next_nudge_at: '', next_nurture_at: at(NOT_NOW_DAYS, now), nurture_count: 0, revisit_reason: 'Said "not now"', needs_human_reason: '' };
}

/** Lead fields whenever they reply: they're back in a live conversation. */
export function onReply() {
  return { next_nudge_at: '', nudge_count: 0, next_nurture_at: '' };
}

/** A brand-new lead from the webhook: the opener goes out right away (any permitted hour), not at the next send window. */
export function freshLead(lead: any) {
  return String(lead?.import_batch || '').startsWith('webhook') && !((Number(lead?.current_step) || 0) > 0);
}
