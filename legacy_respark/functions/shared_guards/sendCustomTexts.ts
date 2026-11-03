// sendCustomTexts: send a batch of one-off personal texts (written by Vesper in Aidan's voice) and log each one on the lead's ResparkLead
// record as an 'aidan_bot' message so the reply bot keeps context and does not treat it as a manual takeover.
// Body: { items: [{ lead_id, contact_id, text }], dry_run?, respect_window? (default true: skip + report anything outside 9am-7:30pm local) }
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
const GHL_API_KEY = Deno.env.get('GHL_API_KEY') || '';
const AIDAN_TZ = 'America/Chicago';
async function sendSms(contactId: string, message: string) {
  const r = await fetch('https://services.leadconnectorhq.com/conversations/messages', { method: 'POST', headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-07-28', 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'SMS', contactId, message }) });
  const t = await r.text(); return { ok: r.ok, err: r.ok ? '' : `${r.status} ${t.slice(0, 160)}` };
}
function localMin(d: Date, tz: string) { const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(d); const g = (t: string) => p.find(x => x.type === t)!.value; return { m: (+g('hour') % 24) * 60 + +g('minute'), wd: g('weekday') }; }
Deno.serve(async (req: Request) => {
  const base44 = createClientFromRequest(req);
  const svc = (base44 as any).asServiceRole.entities.ResparkLead;
  let b: any = {}; try { b = await req.json(); } catch (_) {}
  const dry = b.dry_run === true; const now = new Date();
  const out: any = { dry_run: dry, sent: [], skipped: [], errors: [] };
  for (const it of (b.items || [])) {
    try {
      const L = it.lead_id ? await svc.get(it.lead_id) : null;
      const tz = L?.timezone || AIDAN_TZ;
      const { m, wd } = localMin(now, tz);
      if (b.respect_window !== false && (m < 9 * 60 || m > 19 * 60 + 30 || (wd === 'Sun' && m < 12 * 60))) { out.skipped.push(`${it.contact_id}: outside texting window (${tz})`); continue; }
      if (dry) { out.sent.push(`${L?.first_name || it.contact_id}: ${it.text.slice(0, 60)}...`); continue; }
      const s = await sendSms(it.contact_id, it.text);
      if (!s.ok) { out.errors.push(`${it.contact_id}: ${s.err}`); continue; }
      if (L) {
        const conv = [...(L.conversation || []), { role: 'aidan_bot', text: it.text, at: now.toISOString(), label: 'personal momentum text (Vesper for Aidan)' }];
        const log = [...(L.seq_log || []), `${now.toLocaleString('en-US', { timeZone: AIDAN_TZ })} CT personal momentum text sent (Vesper for Aidan)`];
        await svc.update(L.id, { conversation: conv, seq_log: log, last_sms_at: now.toISOString(), messages_sent: (L.messages_sent || 0) + 1 });
      }
      out.sent.push(`${L?.first_name || it.contact_id} ${L?.phone || ''}`);
    } catch (e) { out.errors.push(`${it.contact_id}: ${String(e).slice(0, 160)}`); }
  }
  return Response.json({ success: true, ...out });
});
