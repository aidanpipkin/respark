// Ethos Campaign Enrollment
// Pulls every GHL opportunity, dedupes by contact, excludes Closed/won, no-email, email-DND, suppressed.
// Creates EthosCampaignSend records (idempotent: skips contacts already enrolled).
// POST { dry_run: true } to preview counts without writing.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const GHL_API_KEY = Deno.env.get('GHL_API_KEY') || 'pit-85b0f99f-d8cd-4e7d-9373-5213bd2548f0';
const LOC = 'P1m006Mt7YCXCAdiBBxC';
const H = { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28', 'Accept': 'application/json' };

// Segment priority when a contact sits in more than one pipeline (higher wins)
const SEGMENT_PRIORITY: Record<string, number> = { ethos_cart: 5, trucker: 4, mortgage: 3, mailer: 2, iul: 1 };

function segmentForPipeline(name: string): string {
  const n = (name || '').toLowerCase();
  if (n.includes('ethos')) return 'ethos_cart';
  if (n.includes('trucker') || n === 'iul drip campaign') return 'trucker';
  if (n.includes('mortgage')) return 'mortgage';
  if (n.includes('mailer')) return 'mailer';
  return 'iul'; // Aged IUL Lead Drip, Fresh Empire IUL, Web Inbound IUL, anything else
}

function isClosedStage(stageName: string, status: string): boolean {
  const s = (stageName || '').toLowerCase();
  return s.includes('closed') || s.includes('sold') || s.includes('policy issued') || s.includes('app submitted') || status === 'won';
}

function properCase(s: string): string {
  if (!s) return '';
  return s.trim().toLowerCase().replace(/(^|[\s'-])([a-z])/g, (m, p, c) => p + c.toUpperCase());
}

function isValidEmail(e: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test((e || '').trim());
}

Deno.serve(async (req: Request) => {
  const base44 = createClientFromRequest(req);
  const body = await req.json().catch(() => ({}));
  const dryRun = !!body.dry_run;
  const now = new Date();

  try {
    // Pipelines/stages
    const pRes = await fetch(`https://services.leadconnectorhq.com/opportunities/pipelines?locationId=${LOC}`, { headers: H });
    const pipelines = (await pRes.json()).pipelines || [];
    const stageName: Record<string, string> = {};
    const pipeName: Record<string, string> = {};
    for (const p of pipelines) { pipeName[p.id] = p.name; for (const s of p.stages) stageName[s.id] = s.name; }

    // All opportunities
    const all: any[] = [];
    let startAfter: string | undefined, startAfterId: string | undefined;
    for (let i = 0; i < 100; i++) {
      const params = new URLSearchParams({ location_id: LOC, limit: '100' });
      if (startAfter) params.set('startAfter', startAfter);
      if (startAfterId) params.set('startAfterId', startAfterId);
      const r = await fetch(`https://services.leadconnectorhq.com/opportunities/search?${params}`, { headers: H });
      if (!r.ok) return Response.json({ error: r.status, text: await r.text() }, { status: 500 });
      const j = await r.json();
      const opps = j.opportunities || [];
      all.push(...opps);
      const meta = j.meta || {};
      if (!meta.startAfter || opps.length === 0) break;
      startAfter = String(meta.startAfter); startAfterId = meta.startAfterId;
    }

    // Group by contact
    const byContact: Record<string, any[]> = {};
    for (const o of all) { if (!o.contactId) continue; (byContact[o.contactId] ||= []).push(o); }

    // Suppression list
    const suppressed = new Set<string>();
    try {
      let skip = 0;
      while (true) {
        const items: any[] = await (base44 as any).asServiceRole.entities.GlobalSuppression.list('created_date', 200, skip);
        for (const s of items) { const e = (s.email || '').toLowerCase().trim(); if (e) suppressed.add(e); }
        if (items.length < 200) break; skip += 200;
      }
    } catch (_) {}

    // Already enrolled
    const enrolled = new Set<string>();
    {
      let skip = 0;
      while (true) {
        const items: any[] = await (base44 as any).asServiceRole.entities.EthosCampaignSend.list('created_date', 200, skip);
        for (const s of items) { if (s.ghl_contact_id) enrolled.add(s.ghl_contact_id); if (s.email) enrolled.add(s.email.toLowerCase()); }
        if (items.length < 200) break; skip += 200;
      }
    }

    const stats: any = { contacts_total: 0, excluded_closed: 0, excluded_no_email: 0, excluded_bad_email: 0, excluded_dnd: 0, excluded_suppressed: 0, already_enrolled: 0, eligible: 0, created: 0, by_segment: {}, by_pipeline: {} };
    const toCreate: any[] = [];
    const seenEmails = new Set<string>();

    for (const [contactId, opps] of Object.entries(byContact)) {
      stats.contacts_total++;
      if (opps.some(o => isClosedStage(stageName[o.pipelineStageId], o.status))) { stats.excluded_closed++; continue; }
      const contact = opps.find(o => o.contact)?.contact || {};
      const email = (contact.email || '').toLowerCase().trim();
      if (!email) { stats.excluded_no_email++; continue; }
      if (!isValidEmail(email)) { stats.excluded_bad_email++; continue; }
      if (suppressed.has(email)) { stats.excluded_suppressed++; continue; }
      const tags: string[] = (contact.tags || []).map((t: string) => t.toLowerCase());
      if (tags.some(t => t.includes('unsubscribe') || t === 'dnd' || t.includes('do not email') || t.includes('do-not-email'))) { stats.excluded_dnd++; continue; }
      if (enrolled.has(contactId) || enrolled.has(email)) { stats.already_enrolled++; continue; }
      if (seenEmails.has(email)) { stats.already_enrolled++; continue; } // same email under two contact ids
      seenEmails.add(email);

      // Pick segment from highest-priority pipeline
      let best = opps[0], bestSeg = segmentForPipeline(pipeName[opps[0].pipelineId]);
      for (const o of opps) {
        const seg = segmentForPipeline(pipeName[o.pipelineId]);
        if (SEGMENT_PRIORITY[seg] > SEGMENT_PRIORITY[bestSeg]) { best = o; bestSeg = seg; }
      }
      const fullName = contact.name || best.name || '';
      const first = properCase(contact.firstName || fullName.split(' ')[0] || '');
      const last = properCase(contact.lastName || fullName.split(' ').slice(1).join(' ') || '');
      const pn = pipeName[best.pipelineId] || '';
      stats.eligible++;
      stats.by_segment[bestSeg] = (stats.by_segment[bestSeg] || 0) + 1;
      stats.by_pipeline[pn] = (stats.by_pipeline[pn] || 0) + 1;

      toCreate.push({
        ghl_contact_id: contactId,
        email, first_name: first, last_name: last,
        state: contact.state || '',
        segment: bestSeg,
        pipeline_name: pn,
        stage_name: stageName[best.pipelineStageId] || '',
        opportunity_id: best.id,
        next_email: 0, emails_sent: 0,
        enrolled_date: now.toISOString(),
        next_send_date: now.toISOString(),
        status: 'active',
        message_ids: [],
      });
    }

    if (!dryRun) {
      for (let i = 0; i < toCreate.length; i += 100) {
        const chunk = toCreate.slice(i, i + 100);
        await (base44 as any).asServiceRole.entities.EthosCampaignSend.bulkCreate(chunk);
        stats.created += chunk.length;
      }
    }

    return Response.json({ success: true, dry_run: dryRun, opportunities: all.length, ...stats, sample: toCreate.slice(0, 3) });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
});
