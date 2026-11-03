// Call outcomes, the post-appointment pipeline board, and the client (closed policy) pipeline.
import { waitUntil } from 'base44:runtime';
import { setupContext } from '../../shared/setupAccess.ts';
import { own, failure } from '../../shared/ghl.ts';
import { applyOutcome, setPolicyStatus, validatePolicy, runTrackLead, policyFor } from '../../shared/trackEngine.ts';
import { OUTCOMES, TRACK_LABEL, nextStep, money } from '../../shared/tracks.ts';

const COLUMNS = ['no_show', 'follow_up', 'lost_banking', 'lost_social'];
const card = (l: any) => ({
  id: l.id, name: [l.first_name, l.last_name].filter(Boolean).join(' ') || l.phone, phone: l.phone, status: l.status,
  disposition_at: l.last_disposition_at || '', note: l.disposition_note || '', next_touch: l.track_next_at || '',
  replied_at: l.last_inbound_at && l.last_inbound_at > (l.last_disposition_at || '') ? l.last_inbound_at : '', needs_you: l.needs_human_reason || '',
});

function policyView(p: any, lead: any) {
  const step = lead ? nextStep(lead, p) : null;
  return {
    id: p.id, lead_id: p.lead_id, client_name: p.client_name || [lead?.first_name, lead?.last_name].filter(Boolean).join(' '), phone: lead?.phone || '',
    carrier: p.carrier, product: p.product, policy_number: p.policy_number, coverage: money(p.coverage_amount_cents), premium: money(p.premium_amount_cents),
    coverage_amount: p.coverage_amount_cents / 100, premium_amount: p.premium_amount_cents / 100,
    premium_frequency: p.premium_frequency, coverage_start_date: p.coverage_start_date, first_draft_date: p.first_draft_date, beneficiary: p.beneficiary || '', notes: p.notes || '',
    status: p.status, approved_at: p.approved_at || '', created_at: p.created_at,
    next_touch: lead?.track === 'client' && step ? { key: step.key, at: new Date(step.due).toISOString() } : null,
    needs_you: lead?.needs_human_reason || '', last_reply_at: lead?.last_inbound_at || '',
  };
}

export default async function (req: Request) {
  try {
    const { base44, user, s, E } = await setupContext(req);
    const input = await req.json().catch(() => ({}));
    const action = String(input.action || 'board');
    const mine = (r: any) => { own(user, r); if (r.agent_email !== s.agent_email) throw new Error('Access denied.'); return r; };

    if (action === 'set') {
      const outcome = String(input.outcome || '');
      if (!(OUTCOMES as readonly string[]).includes(outcome)) throw new Error('Choose what happened on the call.');
      let appointment = input.appointment_id ? mine(await E.Appointment.get(String(input.appointment_id))) : null;
      const lead = mine(await E.Lead.get(String(appointment?.lead_id || input.lead_id || '')));
      if (lead.status === 'opted_out') throw new Error('This contact opted out of texts. Log the outcome in a note instead.');
      if (!appointment) appointment = (await E.Appointment.filter({ agent_email: s.agent_email, lead_id: lead.id, status: 'booked' }, { sort: '-start_time', limit: 1 })).items[0] || null;
      if (outcome !== 'no_show' && outcome !== 'closed' && !String(input.note || '').trim()) throw new Error('Add a quick note about what happened so the follow-up texts fit.');
      const policyStatus = input.policy_status === 'submitted' ? 'submitted' : 'approved';
      const result = await applyOutcome(base44, s, user, lead, appointment, outcome, input.note, input.policy, policyStatus);
      // Clients get their first text (welcome or "application submitted") right away.
      if (result.track === 'client') waitUntil((async () => { try { await runTrackLead(base44, s, await E.Lead.get(lead.id), lead.campaign_id ? await E.Campaign.get(lead.campaign_id).catch(() => null) : null); } catch { /* the scheduled sender retries */ } })());
      return Response.json({ ok: true, ...result, label: TRACK_LABEL[result.track] });
    }

    if (action === 'move') {
      const lead = mine(await E.Lead.get(String(input.lead_id || '')));
      const to = String(input.to || '');
      if (!COLUMNS.includes(to)) throw new Error('Choose a column.');
      if (lead.track === 'client') throw new Error('Clients are managed on the Clients page.');
      const now = new Date().toISOString();
      await E.Lead.update(lead.id, { track: to, track_started_at: now, track_done: [], track_hold_until: '', track_next_at: new Date(Date.now() + 3600000).toISOString(), last_disposition: to, last_disposition_at: now, status: to === 'no_show' ? 'no_show' : 'engaged', ai_paused: false, needs_human_reason: '' });
      return Response.json({ ok: true });
    }

    if (action === 'policy_status') {
      const policy = mine(await E.Policy.get(String(input.policy_id || '')));
      const status = String(input.status || '');
      if (!['approved', 'declined', 'lapsed', 'cancelled'].includes(status)) throw new Error('Choose a policy status.');
      await setPolicyStatus(base44, s, policy, status);
      if (status === 'approved') waitUntil((async () => { try { const lead = await E.Lead.get(policy.lead_id); await runTrackLead(base44, s, lead, lead.campaign_id ? await E.Campaign.get(lead.campaign_id).catch(() => null) : null); } catch { /* retried */ } })());
      return Response.json({ ok: true });
    }

    if (action === 'update_policy') {
      const policy = mine(await E.Policy.get(String(input.policy_id || '')));
      const { policy: p, errors } = validatePolicy(input.policy);
      if (errors.length) throw new Error(`Add the ${errors.join(', ')}.`);
      await E.Policy.update(policy.id, p);
      // Dates may have moved: let the track recompute its next touch.
      const lead = await E.Lead.get(policy.lead_id);
      if (lead.track === 'client') await E.Lead.update(lead.id, { track_next_at: new Date().toISOString() });
      return Response.json({ ok: true });
    }

    if (action === 'clients') {
      const policies = await E.Policy.filter({ agent_email: s.agent_email, ...(input.status ? { status: input.status } : {}) }, { sort: '-created_at', limit: 200 });
      const ids = [...new Set(policies.items.map((p: any) => p.lead_id))];
      const leads = ids.length ? (await E.Lead.filter({ agent_email: s.agent_email, id: { $in: ids } }, { limit: 200 })).items : [];
      const byId = Object.fromEntries(leads.map((l: any) => [l.id, l]));
      return Response.json({ clients: policies.items.map((p: any) => policyView(p, byId[p.lead_id])) }, { headers: { 'Cache-Control': 'no-store' } });
    }

    if (action === 'policy') {
      const lead = mine(await E.Lead.get(String(input.lead_id || '')));
      const p = await policyFor(E, lead);
      return Response.json({ policy: p ? policyView(p, lead) : null });
    }

    // Board
    const now = new Date();
    const due = await E.Appointment.filter({ agent_email: s.agent_email, status: 'booked', start_time: { $lt: new Date(now.getTime() - 15 * 60000).toISOString() } }, { sort: 'start_time', limit: 50 });
    const upcoming = await E.Appointment.filter({ agent_email: s.agent_email, status: 'booked', start_time: { $gte: new Date(now.getTime() - 15 * 60000).toISOString() } }, { sort: 'start_time', limit: 50 });
    const columns: Record<string, any[]> = {};
    const counts: Record<string, number> = {};
    await Promise.all(COLUMNS.map(async c => {
      const page = await E.Lead.filter({ agent_email: s.agent_email, track: c }, { sort: '-last_disposition_at', limit: 50 });
      columns[c] = page.items.map(card);
      counts[c] = await E.Lead.count({ agent_email: s.agent_email, track: c }).catch(() => page.items.length);
    }));
    counts.clients = await E.Lead.count({ agent_email: s.agent_email, track: 'client' }).catch(() => 0);
    const apptCard = (a: any) => ({ appointment_id: a.id, lead_id: a.lead_id, name: a.lead_name || 'Phone call', phone: a.phone_to_call, start_time: a.start_time, summary: a.ai_summary || '', confirmation: a.confirmation || '' });
    return Response.json({ needs_outcome: due.items.map(apptCard), upcoming: upcoming.items.map(apptCard), columns, counts }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error as Error); }
}
