// The agent's lead board: stages, search, tags, saved views, bulk actions, CSV export and consent
// proof. One filter definition (stage + search + tag) drives the list, the counts, the export and
// saved views, so what you see is exactly what you export. Built for thousands of leads.
import { setupContext } from '../_shared/setupAccess.ts';
import { failure } from '../_shared/ghl.ts';
import { STAGE_QUERIES, STAGE_LABELS, stageOfLead } from '../_shared/leadStages.ts';

const STAGES = STAGE_QUERIES;
const SORTS: Record<string, string> = { reply: '-last_inbound_at', texted: '-last_outbound_at', newest: '-created_date', name: 'first_name' };
const FIELDS = ['first_name', 'last_name', 'phone', 'state', 'status', 'track', 'campaign_id', 'last_inbound_at', 'last_outbound_at', 'next_send_at', 'track_next_at', 'next_nudge_at', 'next_nurture_at', 'ai_summary', 'needs_human_reason', 'sequence_paused', 'ai_paused', 'current_step', 'created_date', 'tags'];
const cleanTag = (t: any) => String(t || '').trim().replace(/\s+/g, ' ').slice(0, 30);

function scoped(email: string, stage: string, search: string, tag = '') {
  // Sample contacts (GHL's "(example)" seeds, marked is_sample) are never shown as leads.
  const parts: any[] = [{ agent_email: email }, { import_batch: { $ne: 'ghl_example' } }];
  if (STAGES[stage] && stage !== 'all') parts.push(STAGES[stage]);
  if (tag) parts.push({ tags: tag });
  const term = search.trim().slice(0, 80);
  if (term) {
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const digits = term.replace(/\D/g, '');
    parts.push({ $or: [
      { first_name: { $regex: esc, $options: 'i' } }, { last_name: { $regex: esc, $options: 'i' } }, { email: { $regex: esc, $options: 'i' } },
      ...(digits.length >= 3 ? [{ phone: { $regex: digits.slice(-10) } }] : []),
    ] });
  }
  return parts.length === 1 ? parts[0] : { $and: parts };
}

const csvCell = (v: any) => { const s = v === undefined || v === null ? '' : Array.isArray(v) ? v.join('; ') : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export default async function (req: Request) {
  try {
    const { E, s, user } = await setupContext(req);
    const input = await req.json().catch(() => ({}));
    const me = s.agent_email;
    const stage = STAGES[input.stage] ? input.stage : 'all';
    const tag = cleanTag(input.tag);
    const search = String(input.search || '');

    if (input.action === 'stages') {
      const keys = Object.keys(STAGES);
      const counts = await Promise.all(keys.map(k => E.Lead.count(scoped(me, k, search, tag))));
      return Response.json({ counts: Object.fromEntries(keys.map((k, i) => [k, counts[i]])) });
    }

    if (input.action === 'list') {
      const sort = SORTS[input.sort] || (['texting', 'waiting'].includes(stage) ? SORTS.texted : SORTS.reply);
      const page = await E.Lead.filter(scoped(me, stage, search, tag), { sort, limit: 50, cursor: input.cursor || undefined, fields: FIELDS });
      return Response.json({ items: page.items, next_cursor: page.has_more ? page.next_cursor : null });
    }

    if (input.action === 'bulk') {
      const ids = (Array.isArray(input.ids) ? input.ids : []).filter((x: any) => typeof x === 'string').slice(0, 500);
      if (!ids.length) throw new Error('Select at least one lead.');
      if (input.op === 'tag_add' || input.op === 'tag_remove') {
        const t = cleanTag(input.value);
        if (!t) throw new Error('Type a tag name.');
        const rows = (await E.Lead.filter({ agent_email: me, id: { $in: ids } }, { limit: 500, fields: ['tags'] })).items;
        let updated = 0;
        for (let i = 0; i < rows.length; i += 10) {
          await Promise.all(rows.slice(i, i + 10).map(async (l: any) => {
            const cur: string[] = Array.isArray(l.tags) ? l.tags : [];
            const next = input.op === 'tag_add' ? (cur.includes(t) ? cur : [...cur, t].slice(0, 20)) : cur.filter(x => x !== t);
            if (next.length !== cur.length) { await E.Lead.update(l.id, { tags: next }); updated++; }
          }));
        }
        return Response.json({ updated });
      }
      const base = { agent_email: me, id: { $in: ids }, status: { $nin: ['opted_out'] } };
      let set: Record<string, any>;
      if (input.op === 'pause') set = { sequence_paused: true, ai_paused: true };
      else if (input.op === 'resume') set = { sequence_paused: false, ai_paused: false };
      else if (input.op === 'not_interested') set = { status: 'not_interested', sequence_paused: true, ai_paused: true, next_send_at: '' };
      else throw new Error('Choose an action.');
      // Resuming never revives people who said no or who are already clients.
      const filter = input.op === 'resume' ? { ...base, status: { $nin: ['opted_out', 'not_interested', 'client'] } } : base;
      const r = await E.Lead.updateMany(filter, { $set: set });
      if (input.op === 'not_interested') await E.ConversationSummary.updateMany({ agent_email: me, lead_id: { $in: ids } }, { $set: { status_chip: 'not_interested', has_pending_draft: false } }).catch(() => {});
      await E.ControlAudit.create({ agent_email: me, location_id: s.location_id || '', actor_email: user?.email || me, action: `bulk_${input.op}`, details: { count: ids.length }, occurred_at: new Date().toISOString() }).catch(() => {});
      return Response.json({ updated: Number(r?.updated ?? r?.modified ?? 0) });
    }

    if (input.action === 'tags') {
      // Tags in use, with counts. Tagged leads are a small slice, so this stays fast.
      const counts: Record<string, number> = {};
      let cursor: string | undefined, pages = 0;
      do {
        const page = await E.Lead.filter({ agent_email: me, 'tags.0': { $exists: true } }, { limit: 500, cursor, fields: ['tags'] });
        for (const l of page.items) for (const t of (l.tags || [])) counts[t] = (counts[t] || 0) + 1;
        cursor = page.has_more ? page.next_cursor : undefined;
      } while (cursor && ++pages < 20);
      return Response.json({ tags: Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })) });
    }

    if (input.action === 'views') {
      const rows = await E.SavedView.filter({ agent_email: me }, { sort: 'position', limit: 30 });
      return Response.json({ views: rows.items.map((v: any) => ({ id: v.id, name: v.name, stage: v.stage || 'all', search: v.search || '', tag: v.tag || '', sort: v.sort || '' })) });
    }
    if (input.action === 'save_view') {
      const name = String(input.name || '').trim().slice(0, 40);
      if (!name) throw new Error('Name the view.');
      if ((await E.SavedView.count({ agent_email: me })) >= 30) throw new Error('You can keep up to 30 saved views.');
      const v = await E.SavedView.create({ agent_email: me, name, stage, search: search.slice(0, 80), tag, sort: SORTS[input.sort] ? input.sort : '', position: Date.now(), created_at: new Date().toISOString() });
      return Response.json({ id: v.id });
    }
    if (input.action === 'delete_view') {
      const v = await E.SavedView.get(String(input.id || ''));
      if (v?.agent_email !== me) throw new Error('View not found.');
      await E.SavedView.delete(v.id);
      return Response.json({ ok: true });
    }

    if (input.action === 'export') {
      // Same filter as the screen. Includes consent proof columns, so an export doubles as a compliance record.
      const header = ['First name', 'Last name', 'Phone', 'Email', 'State', 'Stage', 'Status', 'Tags', 'Last reply', 'Last text sent', 'Next scheduled text', 'AI summary', 'Lead source', 'Date inquired', 'Uploaded', 'Import batch', 'Consent source', 'Consent date', 'Consent statement', 'Seller named in consent', 'DNC checked'];
      const lines = [header.map(csvCell).join(',')];
      let cursor: string | undefined, n = 0;
      do {
        const page = await E.Lead.filter(scoped(me, stage, search, tag), { sort: '-created_date', limit: 500, cursor });
        for (const l of page.items) {
          const next = [l.next_send_at, l.track_next_at, l.next_nudge_at, l.next_nurture_at].filter(Boolean).sort()[0] || '';
          lines.push([l.first_name, l.last_name, l.phone, l.email, l.state, STAGE_LABELS[stageOfLead(l)], l.status, l.tags, l.last_inbound_at, l.last_outbound_at, next, l.ai_summary, l.lead_source, l.inquiry_date, l.created_date, l.import_batch, l.consent_source, l.consent_date, l.consent_wording || l.consent_text, l.consent_seller_named, l.dnc_checked ? 'yes' : 'no'].map(csvCell).join(','));
          n++;
        }
        cursor = page.has_more ? page.next_cursor : undefined;
      } while (cursor && n < 20000);
      await E.ControlAudit.create({ agent_email: me, location_id: s.location_id || '', actor_email: user?.email || me, action: 'leads_exported', details: { count: n, stage, tag, search: search.slice(0, 40) }, occurred_at: new Date().toISOString() }).catch(() => {});
      return Response.json({ csv: lines.join('\n'), count: n, truncated: !!cursor });
    }

    if (input.action === 'consent') {
      // Everything that proves this person agreed to hear from the agent and was treated properly.
      const lead = await E.Lead.get(String(input.id || ''));
      if (!lead || lead.agent_email !== me) throw new Error('Lead not found.');
      const [logs, audits, web] = await Promise.all([
        E.MessageLog.filter({ agent_email: me, lead_id: lead.id, event_type: { $in: ['sms_sent', 'inbound_sms', 'status_changed', 'needs_human'] } }, { sort: 'occurred_at', limit: 500, fields: ['occurred_at', 'direction', 'event_type', 'body', 'status', 'source'] }),
        E.ControlAudit.filter({ agent_email: me, $or: [{ lead_id: lead.id }, { action: 'import_attested', 'details.batch': lead.import_batch || '__none__' }] }, { sort: 'occurred_at', limit: 100 }),
        lead.website_request_key ? E.ConsentRecord.filter({ agent_email: me, submission_id: lead.website_request_key }, { limit: 1 }) : Promise.resolve({ items: [] }),
      ]);
      const stop = logs.items.find((m: any) => m.direction === 'inbound' && /^\s*(stop|unsubscribe|cancel|end|quit|stopall)\b/i.test(m.body || ''));
      return Response.json({
        generated_at: new Date().toISOString(), agent: { name: [s.first_name, s.last_name].filter(Boolean).join(' '), business: s.legal_business_name || s.brand_name || '', email: me, npn: s.npn || '' },
        lead: { name: [lead.first_name, lead.last_name].filter(Boolean).join(' '), phone: lead.phone, email: lead.email || '', state: lead.state, status: lead.status, created: lead.created_date, import_batch: lead.import_batch || '', lead_source: lead.lead_source || '', inquiry_date: lead.inquiry_date || '' },
        consent: { source: lead.consent_source || '', date: lead.consent_date || '', statement: lead.consent_wording || lead.consent_text || '', seller_named: lead.consent_seller_named || '', dnc_checked: !!lead.dnc_checked, dnc_basis: lead.dnc_basis || (lead.dnc_checked ? 'written_consent' : '') },
        web_form: web.items[0] ? { submitted: web.items[0].timestamp, checkbox_checked: web.items[0].consent_checked, wording: web.items[0].consent_text, ip: web.items[0].ip, page: web.items[0].page_url } : null,
        attestations: audits.items.filter((a: any) => a.action === 'import_attested').map((a: any) => ({ at: a.occurred_at, by: a.actor_email, ...(a.details || {}) })),
        opt_out: stop ? { at: stop.occurred_at, message: stop.body } : (lead.status === 'opted_out' ? { at: '', message: 'Marked opted out' } : null),
        messages: logs.items.filter((m: any) => ['sms_sent', 'inbound_sms'].includes(m.event_type)).map((m: any) => ({ at: m.occurred_at, direction: m.direction, body: m.body, status: m.status, source: m.source })),
        actions: audits.items.filter((a: any) => a.action !== 'import_attested').map((a: any) => ({ at: a.occurred_at, by: a.actor_email, action: a.action })),
      });
    }

    if (input.action === 'inbox_counts') {
      const c = (q: any) => E.ConversationSummary.count({ agent_email: me, ...q });
      const [needs_you, unread, replied, drafts, booked] = await Promise.all([
        c({ status_chip: 'needs_human' }), c({ unread: true }), c({ replied_at: { $exists: true, $nin: ['', null] } }), c({ has_pending_draft: true }), c({ status_chip: 'booked' }),
      ]);
      return Response.json({ counts: { needs_you, unread, replied, drafts, booked } });
    }

    throw new Error('Unknown action.');
  } catch (e) { return failure(e as Error); }
}
