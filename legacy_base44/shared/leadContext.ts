// Everything the AI should know about one lead before it writes: the real conversation
// (from LeadRespark's own message log, so it works for Twilio and GHL numbers alike),
// the agent's private notes, appointment history and timing. Health details are redacted.
import { localContactId } from './rehearsal.ts';
import { ghl } from './ghl.ts';
import { conditions } from './guardrails.ts';
import { trackContext } from './tracks.ts';

const redact = (t: string) => String(t || '').replace(new RegExp(conditions.source, 'gi'), '[health detail removed]');
const DAY = 86400000;

export type Turn = { direction: 'inbound' | 'outbound'; text: string; at: string };

/** Last `limit` texts in order, oldest first. Falls back to GHL only if LeadRespark has no log yet. */
export async function transcript(E: any, s: any, lead: any, limit = 30): Promise<Turn[]> {
  const page = await E.MessageLog.filter({ agent_email: s.agent_email, lead_id: lead.id, event_type: { $in: ['sms_sent', 'inbound_sms'] } }, { sort: '-occurred_at', limit });
  let turns: Turn[] = page.items
    .filter((m: any) => m.body)
    .map((m: any) => ({ direction: m.direction === 'inbound' || m.event_type === 'inbound_sms' ? 'inbound' : 'outbound', text: String(m.body).slice(0, 1000), at: m.occurred_at }))
    .reverse();
  if (!turns.length && s.connected && s.ghl_token && lead.ghl_contact_id && !localContactId(lead.ghl_contact_id)) {
    try {
      let id = lead.ghl_conversation_id;
      if (!id) id = (await ghl(s, `/conversations/search?${new URLSearchParams({ locationId: s.location_id, contactId: lead.ghl_contact_id, limit: '1' })}`)).conversations?.[0]?.id;
      if (id) {
        const h = await ghl(s, `/conversations/${encodeURIComponent(id)}/messages?limit=${Math.min(limit, 50)}`);
        turns = (h.messages?.messages || []).slice(0, limit).map((m: any) => ({ direction: m.direction === 'inbound' ? 'inbound' : 'outbound', text: String(m.body || '').slice(0, 1000), at: m.dateAdded })).filter((t: Turn) => t.text).reverse();
      }
    } catch { /* no history available */ }
  }
  return turns;
}

/** The agent's own notes on this contact, newest first. Private context for the AI. */
export async function agentNotes(E: any, s: any, lead: any, limit = 10) {
  const page = await E.LeadNote.filter({ agent_email: s.agent_email, lead_id: lead.id }, { sort: '-created_at', limit }).catch(() => ({ items: [] }));
  return page.items.map((n: any) => `${String(n.created_at || '').slice(0, 10)}: ${redact(String(n.body || '')).slice(0, 600)}`);
}

export async function appointmentHistory(E: any, s: any, lead: any) {
  const page = await E.Appointment.filter({ agent_email: s.agent_email, lead_id: lead.id }, { sort: '-start_time', limit: 5 }).catch(() => ({ items: [] }));
  return page.items.map((a: any) => ({ when: a.start_time, status: a.status, confirmation: a.confirmation || undefined }));
}

function daysAgo(iso: string) { const t = Date.parse(iso || ''); return Number.isFinite(t) ? Math.max(0, Math.floor((Date.now() - t) / DAY)) : null; }

/** Situation summary: where this relationship stands right now. */
export function situation(lead: any, turns: Turn[]) {
  const lastIn = [...turns].reverse().find(t => t.direction === 'inbound');
  const lastOut = [...turns].reverse().find(t => t.direction === 'outbound');
  const outboundSinceReply = lastIn ? turns.filter(t => t.direction === 'outbound' && Date.parse(t.at) > Date.parse(lastIn.at)).length : turns.filter(t => t.direction === 'outbound').length;
  return {
    status: lead.status,
    has_ever_replied: !!lastIn,
    days_since_their_last_reply: lastIn ? daysAgo(lastIn.at) : null,
    days_since_our_last_text: lastOut ? daysAgo(lastOut.at) : null,
    our_texts_since_their_last_reply: outboundSinceReply,
    total_texts_exchanged: turns.length,
    follow_up_step: lead.current_step || 0,
    long_term_check_ins_sent: lead.nurture_count || 0,
    what_they_care_about: lead.discovery_topic === '1' ? 'family protection' : lead.discovery_topic === '2' ? 'retirement / life after work' : undefined,
    conversation_summary_so_far: lead.ai_summary || undefined,
  };
}

/** One call for the whole picture. */
export async function leadContext(E: any, s: any, lead: any, limit = 30) {
  const [turns, notes, appointments, policy] = await Promise.all([transcript(E, s, lead, limit), agentNotes(E, s, lead), appointmentHistory(E, s, lead), lead.track === 'client' ? E.Policy.filter({ agent_email: s.agent_email, lead_id: lead.id }, { sort: '-created_at', limit: 1 }).then((p: any) => p.items[0] || null).catch(() => null) : Promise.resolve(null)]);
  const sit: any = situation(lead, turns);
  const upcoming = appointments.filter((a: any) => a.status === 'booked' && Date.parse(a.when) > Date.now()).pop();
  if (upcoming) { sit.upcoming_call = upcoming.when; if (upcoming.confirmation === 'reschedule') sit.asked_to_reschedule = 'Yes: they asked to move their call. Acknowledge it kindly and offer new times (get_free_slots).'; }
  return { turns, notes, appointments, situation: sit, track: trackContext(lead, policy) };
}
