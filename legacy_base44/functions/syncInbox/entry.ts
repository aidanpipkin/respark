import { context, agentSettings, ghl, failure, scope } from '../../shared/ghl.ts';
import { actingSettings } from '../../shared/agentAccess.ts';
export default async function(req) {
  try {
    const { base44, user } = await context(req); const input = await req.json(); const s = await actingSettings(base44, user, input);
    if (!s?.connected) return Response.json({ synced: 0, connected: false });
    const query = new URLSearchParams({ locationId: s.location_id, limit: '50', sort: 'desc', sortBy: 'last_message_date' });
    if (input.cursor && /^[\d.]+$/.test(String(input.cursor))) query.set('startAfterDate', String(input.cursor));
    if (typeof input.query === 'string' && input.query.trim()) query.set('query', input.query.trim().slice(0, 100));
    const result = await ghl(s, `/conversations/search?${query}`);
    // GHL seeds every new sub-account with "(example)" contacts; they are not leads.
    const rows = (result.conversations || []).filter(c => !/^\(example\)/i.test(String(c.firstName || c.fullName || c.contactName || '')));
    const contactIds = rows.map(c => c.contactId);
    const leads = contactIds.length ? (await base44.asServiceRole.entities.Lead.filter({ agent_email: s.agent_email, ghl_contact_id: { $in: contactIds } }, { limit: 50 })).items : [];
    const missing = rows.filter(c => c.contactId && !leads.some(l => l.ghl_contact_id === c.contactId));
    if (missing.length) {
      const created = await base44.asServiceRole.entities.Lead.bulkCreate(missing.map(c => ({ ...scope(s), ghl_contact_id: c.contactId, ghl_conversation_id: c.id, first_name: c.firstName || c.fullName || c.contactName || '', last_name: c.lastName || '', phone: c.phone || '', status: 'closed', ai_paused: true, sequence_paused: true, eligibility_reason: 'Consent and eligibility have not been verified.' })));
      leads.push(...created);
    }
    const campaigns = await base44.entities.Campaign.filter({ agent_email: s.agent_email }, { limit: 50, fields: ['name'] });
    if (rows.length) await base44.asServiceRole.entities.ConversationSummary.upsert(rows.map(c => {
      const lead = leads.find(l => l.ghl_contact_id === c.contactId);
      const timestamp = c.lastMessageDate || c.dateUpdated || c.dateAdded;
      return { ...scope(s), lead_id: lead?.id || '', ghl_contact_id: c.contactId, ghl_conversation_id: c.id, lead_name: c.fullName || c.contactName || c.phone || 'Unnamed contact', phone: c.phone || '', campaign_id: lead?.campaign_id || '', campaign_name: campaigns.items.find(p => p.id === lead?.campaign_id)?.name || 'Not enrolled', last_message: c.lastMessageBody || '', last_direction: c.lastMessageDirection || '', last_time: timestamp ? new Date(timestamp).toISOString() : '', unread: (c.unreadCount || 0) > 0, status_chip: lead?.status || 'not_enrolled' };
    }), { key: ['agent_email','ghl_contact_id'] });
    return Response.json({ synced: rows.length, connected: true, next_cursor: rows.length === 50 ? rows.at(-1)?.lastMessageDate : null });
  } catch (error) { return failure(error); }
}