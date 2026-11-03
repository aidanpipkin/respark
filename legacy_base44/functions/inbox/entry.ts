// The inbox at volume: counts for every tab, bulk triage (read, take over, hand back,
// not interested, approve or discard suggested replies) and the agent's quick replies.
// Bulk work runs in small parallel batches so one click can clear hundreds of conversations
// without tripping platform limits.
import { setupContext } from '../../shared/setupAccess.ts';
import { failure, ghl } from '../../shared/ghl.ts';
import { deliverDraft } from '../../shared/messageDrafts.ts';

const OPEN = { status_chip: { $nin: ['opted_out', 'not_interested'] } };
const MAX = 200;
const APPROVE_MAX = 40;

const DEFAULT_REPLIES = [
  { label: 'Calling now', text: "Hi {first_name}, it's {my_name}. Calling you now from this number. Pick up when you can!" },
  { label: 'Best time?', text: 'What time works best for a quick 10-minute call today or tomorrow, {first_name}?' },
  { label: 'Missed you', text: "Sorry I missed you, {first_name}. When's a better time to connect?" },
  { label: 'Got it', text: "Thanks {first_name}! I'll take care of that and follow up shortly." },
  { label: 'Email?', text: "Happy to help, {first_name}. What's the best email to send the details to?" },
];

async function pool<T>(items: T[], size: number, fn: (x: T) => Promise<any>) {
  const out: any[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...await Promise.allSettled(items.slice(i, i + size).map(fn)));
  return out;
}

export default async function (req: Request) {
  try {
    const { base44, E, s, user } = await setupContext(req);
    const input = await req.json().catch(() => ({}));
    const me = s.agent_email;
    const audit = (action: string, details: any) => E.ControlAudit.create({ agent_email: me, location_id: s.location_id || '', actor_email: user?.email || me, action, details, occurred_at: new Date().toISOString() }).catch(() => {});

    if (input.action === 'counts') {
      const c = (q: any) => E.ConversationSummary.count({ agent_email: me, ...q });
      const [needs_you, unread, replied, drafts, booked, unanswered, oldest] = await Promise.all([
        c({ status_chip: 'needs_human' }), c({ unread: true }), c({ replied_at: { $exists: true, $nin: ['', null] } }),
        c({ has_pending_draft: true }), c({ status_chip: 'booked' }), c({ last_direction: 'inbound', ...OPEN }),
        E.ConversationSummary.filter({ agent_email: me, last_direction: 'inbound', ...OPEN }, { sort: 'last_time', limit: 1, fields: ['last_time'] }),
      ]);
      return Response.json({ counts: { needs_you, unread, replied, drafts, booked, unanswered }, oldest_waiting: oldest.items[0]?.last_time || null });
    }

    if (input.action === 'bulk') {
      const ids = (Array.isArray(input.ids) ? input.ids : []).filter((x: any) => typeof x === 'string').slice(0, MAX);
      if (!ids.length) throw new Error('Select at least one conversation.');
      const rows = (await E.ConversationSummary.filter({ agent_email: me, id: { $in: ids } }, { limit: MAX })).items;
      const leadIds = rows.map((r: any) => r.lead_id).filter(Boolean);
      const op = String(input.op || '');
      const result: any = { done: 0, skipped: 0, reasons: {} as Record<string, number> };
      const skip = (why: string) => { result.skipped++; result.reasons[why] = (result.reasons[why] || 0) + 1; };

      if (op === 'read' || op === 'unread') {
        await E.ConversationSummary.updateMany({ agent_email: me, id: { $in: rows.map((r: any) => r.id) } }, { $set: { unread: op === 'unread' } });
        result.done = rows.length;
      } else if (op === 'not_interested') {
        await E.Lead.updateMany({ agent_email: me, id: { $in: leadIds }, status: { $nin: ['opted_out'] } }, { $set: { status: 'not_interested', sequence_paused: true, ai_paused: true, next_send_at: '', next_nudge_at: '', next_nurture_at: '', needs_human_reason: '' } });
        await E.AIDraft.updateMany({ agent_email: me, lead_id: { $in: leadIds }, status: 'pending' }, { $set: { status: 'discarded', reviewed_by: user?.email || me, edit_reason: 'Marked not interested' } }).catch(() => {});
        await E.ConversationSummary.updateMany({ agent_email: me, id: { $in: rows.map((r: any) => r.id) }, status_chip: { $ne: 'opted_out' } }, { $set: { status_chip: 'not_interested', has_pending_draft: false, unread: false } });
        result.done = rows.length;
      } else if (op === 'take_over' || op === 'hand_back') {
        const leads = (await E.Lead.filter({ agent_email: me, id: { $in: leadIds } }, { limit: MAX })).items;
        await pool(leads, 8, async (lead: any) => {
          if (['opted_out', 'not_interested'].includes(lead.status)) return skip('opted out or not interested');
          let status = lead.status;
          if (op === 'take_over') {
            if (lead.status === 'needs_human') return skip('already yours');
            status = 'needs_human';
            await E.Lead.update(lead.id, { ai_paused: true, sequence_paused: true, sequence_waiting_review: false, status, needs_human_reason: 'Agent took over', status_before_takeover: lead.status });
            await E.AIDraft.updateMany({ agent_email: me, lead_id: lead.id, status: 'pending' }, { $set: { status: 'discarded', edit_reason: 'Agent took over', reviewed_by: user?.email || me } }).catch(() => {});
          } else {
            if (!lead.campaign_id || !lead.consent_source || !lead.consent_date || !lead.dnc_checked) return skip('no documented consent or campaign');
            if (!s.licensed_states?.includes(lead.state)) return skip('outside your licensed states');
            if (!lead.timezone) return skip('timezone unknown');
            if (lead.status === 'needs_human') status = lead.last_inbound_at ? 'replied' : (lead.status_before_takeover || 'queued');
            await E.Lead.update(lead.id, { ai_paused: false, status, needs_human_reason: '' });
            const cid = String(lead.ghl_contact_id || '');
            if (cid && !/^(tw|rh):/.test(cid) && s.ghl_token) ghl(s, `/contacts/${encodeURIComponent(cid)}/tags`, 'DELETE', { tags: ['respark-needs-human'] }).catch(() => {});
          }
          await E.ConversationSummary.updateMany({ agent_email: me, lead_id: lead.id }, { $set: { status_chip: status, ...(op === 'take_over' ? { has_pending_draft: false } : {}) } });
          result.done++;
        });
      } else if (op === 'approve_drafts' || op === 'discard_drafts') {
        const drafts = (await E.AIDraft.filter({ agent_email: me, lead_id: { $in: leadIds }, status: 'pending' }, { sort: '-created_date', limit: MAX })).items;
        const latest = new Map<string, any>();
        for (const d of drafts) if (!latest.has(d.lead_id)) latest.set(d.lead_id, d);
        const list = [...latest.values()];
        if (op === 'approve_drafts') {
          const sendable = list.filter((d: any) => d.proposed_action !== 'book_appointment');
          for (let i = 0; i < list.length - sendable.length; i++) skip('bookings need a one-by-one review');
          const batch = sendable.slice(0, APPROVE_MAX);
          result.remaining = Math.max(0, sendable.length - batch.length);
          const outcomes = await pool(batch, 4, (d: any) => deliverDraft(base44, d, user?.email || me));
          outcomes.forEach((o: any) => { if (o.status === 'fulfilled' && (o.value?.sent || o.value?.booked)) result.done++; else skip(o.status === 'rejected' ? String(o.reason?.message || 'could not send').slice(0, 80) : 'not sent'); });
        } else {
          await pool(list, 8, async (d: any) => {
            await E.AIDraft.update(d.id, { status: 'discarded', reviewed_by: user?.email || me, edit_reason: 'Discarded in bulk' });
            await E.Lead.update(d.lead_id, d.source === 'sequence' ? { sequence_paused: true, sequence_waiting_review: false } : d.source === 'nurture' ? { next_nurture_at: '' } : d.source === 'nudge' ? { next_nudge_at: '' } : d.source === 'track' ? {} : { ai_paused: true });
            await E.ConversationSummary.updateMany({ agent_email: me, lead_id: d.lead_id }, { $set: { has_pending_draft: false } });
            result.done++;
          });
        }
        const without = rows.filter((r: any) => !latest.has(r.lead_id)).length;
        for (let i = 0; i < without; i++) skip('no suggested reply');
      } else throw new Error('Choose an action.');

      await audit(`inbox_bulk_${op}`, { count: ids.length, done: result.done, skipped: result.skipped });
      return Response.json(result);
    }

    if (input.action === 'quick_list') {
      let rows = (await E.QuickReply.filter({ agent_email: me }, { sort: 'position', limit: 50 })).items;
      if (!rows.length && !input.no_seed) rows = (await E.QuickReply.bulkCreate(DEFAULT_REPLIES.map((r, i) => ({ agent_email: me, ...r, position: i, uses: 0 })))) || [];
      return Response.json({ items: rows, my_name: s.first_name || String(s.display_name || '').split(' ')[0] || '' });
    }
    if (input.action === 'quick_save') {
      const text = String(input.text || '').trim().slice(0, 480), label = String(input.label || '').trim().slice(0, 24) || text.slice(0, 20);
      if (!text) throw new Error('Write the reply text.');
      if (input.id) { const row = await E.QuickReply.get(String(input.id)); if (row.agent_email !== me) throw new Error('Access denied.'); return Response.json(await E.QuickReply.update(row.id, { label, text })); }
      const count = await E.QuickReply.count({ agent_email: me });
      if (count >= 30) throw new Error('You can keep up to 30 quick replies.');
      return Response.json(await E.QuickReply.create({ agent_email: me, label, text, position: Date.now(), uses: 0 }));
    }
    if (input.action === 'quick_delete') {
      const row = await E.QuickReply.get(String(input.id || '')); if (row.agent_email !== me) throw new Error('Access denied.');
      await E.QuickReply.delete(row.id); return Response.json({ ok: true });
    }
    if (input.action === 'quick_used') {
      const row = await E.QuickReply.get(String(input.id || '')); if (row.agent_email !== me) throw new Error('Access denied.');
      await E.QuickReply.update(row.id, { uses: (row.uses || 0) + 1 }); return Response.json({ ok: true });
    }
    throw new Error('Unknown action.');
  } catch (e) { return failure(e as Error); }
}
