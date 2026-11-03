// Respark enroller. Runs every 30 minutes (7am-9pm CT). Finds fresh trucker leads that Aidan has been calling with no pickup and no text reply,
// and enrolls them into the 30-day Respark text sequence (ResparkLead entity). Idempotent.
// Criteria: opportunity open in a New Lead stage of an in-scope pipeline, contact added >= MIN_AGE_DAYS ago, has phone + first name,
// not DND, not "Not a Trucker", no inbound SMS ever, not already enrolled.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
//__SHARED__//
//__COPY__//

const MIN_AGE_DAYS = 3;
// Pipelines where Aidan drops leads in by hand and wants them texting right away (no age gate).
const MIN_AGE_DAYS_BY_PIPE: Record<string, number> = { yl3k1RNrJ3OILc8Yj45R: 0 };   // Goat Fresh Premium Truckers

Deno.serve(async (req: Request) => {
  const base44 = createClientFromRequest(req);
  const svc = (base44 as any).asServiceRole.entities.ResparkLead;
  let body: any = {}; try { body = await req.json(); } catch (_) {}
  const dryRun = body.dry_run === true;
  const limit = body.limit || 500;
  const onlyContactIds: string[] | null = Array.isArray(body.contact_ids) ? body.contact_ids : null;
  const now = new Date();
  const cfNames = await cfNameMap();

  // Refresh mode: rebuild the profile on existing ResparkLead records (no enrollment)
  if (body.refresh_profiles) {
    const out: any = { refreshed: 0, errors: [] as string[] };
    const all: any[] = [];
    for (let skip = 0; ; skip += 500) { const page = await svc.list('-created_date', 500, skip); all.push(...page); if (page.length < 500) break; }
    for (const L of all) {
      if (body.contact_id && L.ghl_contact_id !== body.contact_id) continue;
      try {
        const c = (await ghl(`/contacts/${L.ghl_contact_id}`)).json.contact || {};
        if (!c.id) { out.errors.push(`${L.ghl_contact_id}: contact not found`); continue; }
        const pr = await buildProfile(base44, c, cfNames);
        await svc.update(L.id, { profile: pr.fields, lead_status: pr.lead_status, requested_at: pr.requested_at, city: pr.city, gender: pr.gender, iul_goal: pr.iul_goal, dob: pr.dob,
          age: L.age || pr.age, marital_status: L.marital_status || pr.marital, beneficiary_relationship: L.beneficiary_relationship || pr.beneficiary, driver_type: L.driver_type || pr.driver_type });
        out.refreshed++;
      } catch (e) { out.errors.push(`${L.ghl_contact_id}: ${String(e).slice(0, 120)}`); }
    }
    return Response.json({ success: true, ...out });
  }

  // Existing enrollments
  const existing: any[] = [];
  for (let skip = 0; ; skip += 500) { const page = await svc.list('-created_date', 500, skip); existing.push(...page); if (page.length < 500) break; }
  const enrolled = new Set(existing.map((e: any) => e.ghl_contact_id));

  const summary: any = { dry_run: dryRun, scanned: 0, enrolled: [], skipped: {} as Record<string, number>, errors: [] as string[] };
  const skip = (k: string) => { summary.skipped[k] = (summary.skipped[k] || 0) + 1; };

  for (const [pipeId, P] of Object.entries(PIPES)) {
    let sa: any = null, sid: any = null;
    const opps: any[] = [];
    while (true) {
      const q = `/opportunities/search?location_id=${LOC}&pipeline_id=${pipeId}&status=open&limit=100` + (sa ? `&startAfter=${sa}&startAfterId=${sid}` : '');
      const r = await ghl(q); const o = r.json.opportunities || []; opps.push(...o);
      const m = r.json.meta || {}; if (!o.length || !m.startAfterId) break; sa = m.startAfter; sid = m.startAfterId;
    }
    for (const o of opps) {
      if (summary.enrolled.length >= limit) break;
      if (!P.newLead.includes(o.pipelineStageId)) continue;
      summary.scanned++;
      const cid = o.contactId;
      if (onlyContactIds && !onlyContactIds.includes(cid)) continue;
      if (enrolled.has(cid)) { skip('already_enrolled'); continue; }
      try {
        const c = (await ghl(`/contacts/${cid}`)).json.contact || {};
        const cf: Record<string, any> = {}; for (const f of (c.customFields || [])) cf[f.id] = f.value;
        const first = (c.firstName || '').trim();
        if (!first || !c.phone) { skip('no_name_or_phone'); continue; }
        const added = c.dateAdded ? new Date(c.dateAdded) : null;
        const minAge = MIN_AGE_DAYS_BY_PIPE[pipeId] ?? MIN_AGE_DAYS;
        if (!added || (now.getTime() - added.getTime()) < minAge * 86400000) { skip('too_new'); continue; }
        const smsDnd = c.dnd === true || c.dndSettings?.SMS?.status === 'active';
        const tags: string[] = (c.tags || []).map((t: string) => t.toLowerCase());
        if (smsDnd || tags.some(t => t.includes('unsub') || t === 'dnd' || t.includes('stop'))) { skip('dnd'); continue; }
        const driverType = String(cf[CF.driver_type] || '');
        if (driverType.toLowerCase().includes('not a trucker')) { skip('not_a_trucker'); continue; }
        // any inbound SMS ever?
        const convs = (await ghl(`/conversations/search?locationId=${LOC}&contactId=${cid}`, {}, '2021-04-15')).json.conversations || [];
        let hasInbound = false;
        for (const cv of convs) {
          if (cv.lastMessageDirection === 'inbound' && String(cv.lastMessageType || '').includes('SMS')) { hasInbound = true; break; }
          if (String(cv.lastMessageType || '').includes('SMS') || cv.type === 'TYPE_PHONE') {
            const ms = (await ghl(`/conversations/${cv.id}/messages?limit=100`, {}, '2021-04-15')).json;
            const list: any[] = ms.messages?.messages || ms.messages || [];
            if (list.some((m: any) => m.direction === 'inbound' && String(m.messageType || m.type || '').includes('SMS'))) { hasInbound = true; break; }
          }
        }
        if (hasInbound) { skip('already_replied'); continue; }

        const state = c.state || cf['ocr4KRc9tfJVGAdxoEOW'] || '';
        const tz = tzForState(state);
        const pr = await buildProfile(base44, c, cfNames);
        const first_send = scheduleLocal(now, 0, STEPS[0].h, STEPS[0].mi, tz);
        const rec = {
          ghl_contact_id: cid, ghl_opportunity_id: o.id, pipeline_id: pipeId,
          first_name: first.charAt(0).toUpperCase() + first.slice(1).toLowerCase(), last_name: c.lastName || '', phone: c.phone, email: c.email || '',
          state, timezone: tz, driver_type: driverType, age: String(cf[CF.age] || pr.age || ''), marital_status: String(cf[CF.marital] || pr.marital || ''), beneficiary_relationship: String(cf[CF.beneficiary_rel] || pr.beneficiary || ''),
          city: pr.city, gender: pr.gender, dob: pr.dob, iul_goal: pr.iul_goal, lead_status: pr.lead_status, requested_at: pr.requested_at, profile: pr.fields,
          lead_added_date: c.dateAdded, enrolled_at: now.toISOString(), status: 'active', step: 0, messages_sent: 0, reply_count: 0, ashley_turns: 0,
          next_send_at: first_send.toISOString(), conversation: [], seq_log: [`${stamp()} enrolled (${P.name}); first text ${fmtLocal(first_send, tz)}`],
        };
        if (!dryRun) { await svc.create(rec); await addTags(cid, ['Respark Active']); enrolled.add(cid); }
        summary.enrolled.push(`${rec.first_name} ${rec.last_name} ${rec.phone} ${state} -> ${fmtLocal(first_send, tz)}`);
      } catch (e) { summary.errors.push(`${cid}: ${String(e).slice(0, 150)}`); }
    }
  }
  summary.enrolled_count = summary.enrolled.length;
  return Response.json({ success: true, ...summary });
});
