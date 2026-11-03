import { localContactId, isTestLead } from '../_shared/rehearsal.ts';
import { context, own, agentSettings, ghl, failure } from '../_shared/ghl.ts';
import { publicRecord } from '../_shared/agentAccess.ts';
import { routeFor } from '../_shared/smsTransport.ts';

export default async function (req: Request) {
  try {
    const { base44, user } = await context(req); const input = await req.json();
    const E = base44.asServiceRole.entities;
    if (typeof input.summary_id !== 'string' || !input.summary_id) throw new Error('Choose a conversation.');
    const summary = own(user, await E.ConversationSummary.get(input.summary_id));
    // Opening a conversation marks it read (only the agent's own view counts, not an admin peeking).
    if (summary.unread && !input.cursor && user.email === summary.agent_email) await E.ConversationSummary.update(summary.id, { unread: false }).catch(() => {});
    const s = await agentSettings(base44, summary.agent_email);
    if (s.location_id !== summary.location_id) throw new Error('Access denied.');
    const lead = summary.lead_id ? own(user, await E.Lead.get(summary.lead_id)) : null;
    const route = await routeFor(E, s);

    // Contact profile from GHL when the contact exists there; otherwise from the lead record.
    let contact: any = null;
    if (summary.ghl_contact_id && !localContactId(summary.ghl_contact_id)) {
      try { contact = (await ghl(s, `/contacts/${encodeURIComponent(summary.ghl_contact_id)}`)).contact; } catch { contact = null; }
      if (contact && contact.locationId !== s.location_id) throw new Error('Contact access denied.');
    }
    const profile = contact
      ? { first_name: contact.firstName, last_name: contact.lastName, phone: contact.phone, email: contact.email, state: contact.state, timezone: contact.timezone, tags: (contact.tags || []).filter((t: string) => !/ghl|highlevel|leadconnector/i.test(t)), source: '', dnd: contact.dnd || contact.dndSettings?.SMS?.status === 'active' }
      : { first_name: lead?.first_name, last_name: lead?.last_name, phone: lead?.phone, email: lead?.email, state: lead?.state, timezone: lead?.timezone, tags: [], source: '', dnd: lead?.status === 'opted_out' };

    // Texts sent directly through Twilio live in LeadRespark's own message log.
    // Fictional test leads and contacts that only exist here use the same log even when the agent still texts through GHL.
    if ((route.kind === 'twilio' || localContactId(summary.ghl_contact_id) || isTestLead(lead)) && summary.lead_id) {
      const before = typeof input.cursor === 'string' && input.cursor.length < 40 ? input.cursor : undefined;
      const logs = await E.MessageLog.filter({ agent_email: s.agent_email, lead_id: summary.lead_id, event_type: { $in: ['sms_sent', 'inbound_sms'] }, ...(before ? { occurred_at: { $lt: before } } : {}) }, { sort: '-occurred_at', limit: 50 });
      const messages: any[] = logs.items.map((m: any) => ({ id: m.ghl_message_id || m.id, body: m.body || '', direction: m.direction, dateAdded: m.occurred_at, type: 'SMS', status: m.status, source: m.source || 'respark', userId: null, number: m.number || '' }));
      // Calls and voicemails sit in the same timeline as the texts.
      const oldest = logs.items.length === 50 ? logs.items[49].occurred_at : '';
      const calls = await E.CallLog.filter({ agent_email: s.agent_email, lead_id: summary.lead_id, ...(before ? { started_at: { $lt: before } } : {}), ...(oldest ? { started_at: { $gte: oldest, ...(before ? { $lt: before } : {}) } } : {}) }, { sort: '-started_at', limit: 50 }).catch(() => ({ items: [] }));
      for (const c of calls.items) messages.push({ id: `call_${c.id}`, body: '', direction: c.direction, dateAdded: c.started_at, type: 'Call', status: c.status, source: 'call', userId: null, number: c.from_number, call: { id: c.id, status: c.status, duration_sec: c.duration_sec || 0, voicemail_sec: c.recording_sid ? (c.recording_duration_sec || 0) : 0, note: c.note || '' } });
      return Response.json({ messages, next_cursor: logs.items.length === 50 ? logs.items[49].occurred_at : null, lead: publicRecord(lead), profile, from_number: lead?.from_number || '' });
    }

    if (!contact) throw new Error('Contact access denied.');
    let conversationId = summary.ghl_conversation_id;
    if (!conversationId) {
      const result = await ghl(s, `/conversations/search?locationId=${encodeURIComponent(s.location_id)}&contactId=${encodeURIComponent(contact.id)}&limit=1`);
      conversationId = result.conversations?.[0]?.id;
    }
    const query = new URLSearchParams({ limit: '50' });
    if (typeof input.cursor === 'string' && input.cursor.length < 200) query.set('lastMessageId', input.cursor);
    const history = conversationId ? await ghl(s, `/conversations/${encodeURIComponent(conversationId)}/messages?${query}`) : {};
    const messages = history.messages?.messages || [];
    return Response.json({ messages: messages.map((m: any) => ({ id: m.id, body: m.body || '', direction: m.direction, dateAdded: m.dateAdded, type: m.messageType || m.type, status: m.status, source: m.source || 'ghl', userId: m.userId || null })), next_cursor: history.messages?.nextPage ? history.messages.lastMessageId : null, lead: publicRecord(lead), profile });
  } catch (error) { return failure(error as Error); }
}
