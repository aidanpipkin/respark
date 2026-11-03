import { context, own, agentSettings, ghl, scope, failure } from '../../shared/ghl.ts';
import { publicRecord } from '../../shared/agentAccess.ts';
export default async function(req) {
  try {
    const { base44, user } = await context(req); const input = await req.json();
    if (!['take_over','resume'].includes(input.action)) throw new Error('Choose take over or resume.');
    const summary = own(user, await base44.asServiceRole.entities.ConversationSummary.get(input.summary_id)); const s = await agentSettings(base44, summary.agent_email);
    if (summary.location_id !== s.location_id) throw new Error('Access denied.');
    let lead = summary.lead_id ? own(user, await base44.asServiceRole.entities.Lead.get(summary.lead_id)) : null;
    if (lead && (lead.location_id !== s.location_id || lead.ghl_contact_id !== summary.ghl_contact_id)) throw new Error('Contact access denied.');
    if (input.action === 'take_over' && lead) {
      lead = await base44.asServiceRole.entities.Lead.update(lead.id, { ai_paused: true, sequence_paused: true, sequence_waiting_review: false, status: lead.status === 'opted_out' ? 'opted_out' : 'needs_human', needs_human_reason: 'Agent took over', status_before_takeover: lead.status === 'needs_human' ? lead.status_before_takeover : lead.status });
      await base44.asServiceRole.entities.AIDraft.updateMany({ agent_email: s.agent_email, lead_id: lead.id, status: 'pending' }, { $set: { status: 'discarded', edit_reason: 'Agent took over', reviewed_by: user.email } });
      await base44.asServiceRole.entities.ConversationSummary.update(summary.id, { status_chip: lead.status, has_pending_draft: false });
      await base44.asServiceRole.entities.ControlAudit.create({ ...scope(s), lead_id: lead.id, actor_email: user.email, action: 'take_over', details: { ai_paused: true, sequence_paused: true }, occurred_at: new Date().toISOString() });
      return Response.json({ lead: publicRecord(lead) });
    }
    // Texting-number agents (Twilio) have no CRM contact to check; their lead record is the source of truth.
    const cid = String(summary.ghl_contact_id || '');
    const viaGhl = !!cid && !/^(tw|rh):/.test(cid) && !!s.ghl_token && !!s.connected;
    const contact = viaGhl ? (await ghl(s, `/contacts/${encodeURIComponent(cid)}`)).contact : { id: cid, locationId: s.location_id, dnd: lead?.status === 'opted_out', tags: [] as string[] };
    if (contact?.locationId !== s.location_id) throw new Error('Contact access denied.');
    if (input.action === 'take_over') {
      const update = { ai_paused: true, sequence_paused: true, status: lead?.status === 'opted_out' || contact.dnd || contact.dndSettings?.SMS?.status === 'active' ? 'opted_out' : 'needs_human', needs_human_reason: 'Agent took over', status_before_takeover: lead?.status === 'needs_human' ? lead.status_before_takeover : lead?.status || 'closed' };
      if (lead) lead = await base44.asServiceRole.entities.Lead.update(lead.id, update);
      else lead = await base44.asServiceRole.entities.Lead.create({ ...scope(s), ghl_contact_id: contact.id, ghl_conversation_id: summary.ghl_conversation_id, first_name: contact.firstName || '', last_name: contact.lastName || '', phone: contact.phone || '', state: contact.state || '', timezone: contact.timezone || '', lead_snapshot: { source: contact.source || '', custom_fields: contact.customFields || [] }, ...update });
      await base44.asServiceRole.entities.ConversationSummary.update(summary.id, { lead_id: lead.id, status_chip: lead.status });
      if (viaGhl) await ghl(s, `/contacts/${encodeURIComponent(contact.id)}/tags`, 'POST', { tags: ['respark-needs-human'] });
    } else {
      if (!lead || !lead.campaign_id || !lead.consent_source || !lead.consent_date || !lead.dnc_checked) throw new Error('Campaign enrollment, documented consent and a DNC check are required before handing this contact back.');
      if (['opted_out','not_interested'].includes(lead.status) || contact.dnd || contact.dndSettings?.SMS?.status === 'active' || contact.tags?.includes('respark-opted-out')) throw new Error('This contact has opted out or is marked do not contact.');
      if (!s.licensed_states?.includes(lead.state)) throw new Error('The contact’s state is outside your licensed states.');
      if (!lead.timezone) throw new Error('Confirm the contact’s timezone first.');
      if (input.resume_ai !== true && input.resume_sequence !== true) throw new Error('Choose what to resume.');
      if (input.resume_sequence && (lead.last_inbound_at || !['queued','in_sequence'].includes(lead.status_before_takeover))) throw new Error('The follow-up series cannot resume after a reply or after it has closed. Suggested replies may be enabled separately.');
      if (viaGhl) await ghl(s, `/contacts/${encodeURIComponent(contact.id)}/tags`, 'DELETE', { tags: ['respark-needs-human'] });
      const status = lead.status === 'needs_human' ? (lead.last_inbound_at ? 'replied' : lead.status_before_takeover || 'queued') : lead.status;
      lead = await base44.asServiceRole.entities.Lead.update(lead.id, { ai_paused: input.resume_ai !== true, sequence_paused: input.resume_sequence !== true, status, needs_human_reason: '' });
      await base44.asServiceRole.entities.ConversationSummary.update(summary.id, { status_chip: status });
    }
    await base44.asServiceRole.entities.ControlAudit.create({ ...scope(s), lead_id: lead.id, actor_email: user.email, action: input.action, details: { ai_paused: lead.ai_paused, sequence_paused: lead.sequence_paused }, occurred_at: new Date().toISOString() });
    return Response.json({ lead: publicRecord(lead) });
  } catch (error) { return failure(error); }
}