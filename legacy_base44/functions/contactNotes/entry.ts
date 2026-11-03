// Agent's private notes on a contact and the facts the AI writes from. Both feed every AI text.
import { context, own, failure } from '../../shared/ghl.ts';
import { clean, birthDate as dateOnly } from '../../shared/leadIntake.ts';

const FACT_KEYS = ['product_interest', 'prior_notes', 'prior_outcome', 'reason_in_their_words', 'who_to_protect', 'dependents', 'coverage_requested', 'date_of_birth', 'age', 'occupation'];

export default async function (req: Request) {
  try {
    const { base44, user } = await context(req);
    const E = base44.asServiceRole.entities;
    const input = await req.json().catch(() => ({}));
    if (typeof input.lead_id !== 'string' || !input.lead_id) throw new Error('Choose a contact.');
    const lead = own(user, await E.Lead.get(input.lead_id));
    const action = String(input.action || 'list');

    if (action === 'add') {
      const body = clean(input.body, 2000);
      if (!body) throw new Error('Write a note first.');
      await E.LeadNote.create({ agent_email: lead.agent_email, lead_id: lead.id, body, author_email: user.email, kind: input.kind === 'call' ? 'call' : 'note', created_at: new Date().toISOString() });
    } else if (action === 'delete') {
      const note = own(user, await E.LeadNote.get(String(input.note_id || '')));
      if (note.lead_id !== lead.id) throw new Error('Access denied.');
      await E.LeadNote.delete(note.id);
    } else if (action === 'save_facts') {
      const next: Record<string, any> = { ...(lead.lead_facts || {}) };
      for (const k of FACT_KEYS) {
        if (input.facts?.[k] === undefined) continue;
        const v = clean(input.facts[k], k === 'prior_notes' || k === 'reason_in_their_words' ? 1500 : 200);
        if (k === 'date_of_birth' && v && !dateOnly(v)) throw new Error('Enter the date of birth as a date.');
        if (v) next[k] = k === 'date_of_birth' ? dateOnly(v) : v; else delete next[k];
      }
      // Drop the cached profile so the next text uses the new facts.
      await E.Lead.update(lead.id, { lead_facts: next, lead_snapshot: { ...(lead.lead_snapshot || {}), fetched_at: '' } });
      lead.lead_facts = next;
    }

    const notes = await E.LeadNote.filter({ agent_email: lead.agent_email, lead_id: lead.id }, { sort: '-created_at', limit: 50 });
    return Response.json({
      notes: notes.items.map((n: any) => ({ id: n.id, body: n.body, kind: n.kind || 'note', created_at: n.created_at })),
      facts: lead.lead_facts || {},
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error as Error); }
}
