// closedGuard: hard rule from Aidan (Nov 2, 2026): NEVER text a client who is closed. Runs every 30 min.
// Pulls every opportunity sitting in a stage whose name looks like closed/won/issued (any pipeline) plus any opp with status "won",
// then (1) retires every ResparkLead for those contacts that is still in a texting status (active, conversing, handoff, manual, booked)
// -> status 'completed', stop_reason 'CLIENT CLOSED, never text', next_send_at cleared; (2) tags the GHL contact "Client - Do Not Text".
// Lost at Banking is NOT treated as closed (that stage exists to get people back on the phone).
// Also exposes { action: "check", contact_ids: [...] } -> { closed: [...] } so other senders can ask before texting.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
const GHL_API_KEY = Deno.env.get('GHL_API_KEY') || '';
const LOC = 'P1m006Mt7YCXCAdiBBxC';
const CLOSED_STAGE = /\b(closed|won|sold|policy issued|issued|app submitted|application submitted|in force|active policy|client)\b/i;
const TEXTING_STATUSES = ['active', 'conversing', 'handoff', 'manual', 'booked'];
const H = { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28', 'Accept': 'application/json', 'Content-Type': 'application/json' };
async function ghl(path: string, init: RequestInit = {}) {
  const r = await fetch(`https://services.leadconnectorhq.com${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } });
  const t = await r.text(); let json: any = {}; try { json = JSON.parse(t); } catch { json = { raw: t }; }
  return { ok: r.ok, status: r.status, json };
}
async function closedContactIds(): Promise<{ ids: Set<string>; stages: string[] }> {
  const ids = new Set<string>(); const stages: string[] = [];
  const p = await ghl(`/opportunities/pipelines?locationId=${LOC}`);
  for (const pipe of (p.json.pipelines || [])) {
    for (const s of (pipe.stages || [])) {
      if (!CLOSED_STAGE.test(s.name || '') || /lost at banking/i.test(s.name || '')) continue;
      stages.push(`${pipe.name} / ${s.name}`);
      let sa = '', said = '';
      for (let page = 0; page < 30; page++) {
        const q = `/opportunities/search?location_id=${LOC}&pipeline_id=${pipe.id}&pipeline_stage_id=${s.id}&limit=100${sa ? `&startAfter=${sa}&startAfterId=${said}` : ''}`;
        const r = await ghl(q); const L: any[] = r.json.opportunities || [];
        for (const o of L) { const cid = o.contact?.id || o.contactId; if (cid) ids.add(cid); }
        const m = r.json.meta || {}; if (L.length < 100 || !m.startAfterId) break; sa = m.startAfter; said = m.startAfterId;
      }
    }
  }
  // opps marked won regardless of stage
  let sa = '', said = '';
  for (let page = 0; page < 30; page++) {
    const r = await ghl(`/opportunities/search?location_id=${LOC}&status=won&limit=100${sa ? `&startAfter=${sa}&startAfterId=${said}` : ''}`);
    const L: any[] = r.json.opportunities || [];
    for (const o of L) { const cid = o.contact?.id || o.contactId; if (cid) ids.add(cid); }
    const m = r.json.meta || {}; if (L.length < 100 || !m.startAfterId) break; sa = m.startAfter; said = m.startAfterId;
  }
  return { ids, stages };
}
Deno.serve(async (req: Request) => {
  const base44 = createClientFromRequest(req);
  const svc = (base44 as any).asServiceRole.entities.ResparkLead;
  let b: any = {}; try { b = await req.json(); } catch (_) {}
  const dryRun = b.dry_run === true;
  try {
    const { ids, stages } = await closedContactIds();
    if (b.action === 'check') {
      const asked: string[] = b.contact_ids || [];
      return Response.json({ success: true, closed: asked.filter(c => ids.has(c)), closed_total: ids.size });
    }
    const retired: string[] = []; const errors: string[] = [];
    for (const st of TEXTING_STATUSES) {
      const rows: any[] = await svc.filter({ status: st }, '-updated_date', 500);
      for (const L of rows) {
        if (!ids.has(L.ghl_contact_id)) continue;
        retired.push(`${L.first_name} ${L.last_name || ''} ${L.phone} (${st})`);
        if (dryRun) continue;
        try {
          await svc.update(L.id, { status: 'completed', stop_reason: 'CLIENT CLOSED, never text', next_send_at: null, seq_log: [...(L.seq_log || []), `${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT closedGuard: client is closed, all texting stopped`] });
          await ghl(`/contacts/${L.ghl_contact_id}/tags`, { method: 'POST', body: JSON.stringify({ tags: ['Client - Do Not Text'] }) });
        } catch (e) { errors.push(`${L.phone}: ${String(e).slice(0, 120)}`); }
      }
    }
    return Response.json({ success: true, dry_run: dryRun, closed_contacts: ids.size, closed_stages: stages, retired, errors });
  } catch (e) { return Response.json({ success: false, error: String((e as any)?.message || e).slice(0, 300) }); }
});
