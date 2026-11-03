// approvalRecovery: "Lost at Banking" recovery drip. For clients Aidan closed on the phone (approved, often banking already collected) who
// dropped off before the final review. Short text sequence in Aidan's voice to get them back on the phone; any reply stops the drip and
// pings Aidan immediately. Runs every 15 min from the workflow "Approval Recovery Drip".
//
// Enrollment: (a) automatically, any OPEN opportunity sitting in a stage named "Lost at Banking" (any pipeline), or
//             (b) by hand: POST { action:"enroll", contact_id, carrier, product, amount, notes, start_at:"YYYY-MM-DD HH:MM" (CT) | ISO }
// Stops: lead replies (-> Aidan alerted, status recovery_replied) | STOP/negative reply (recovery_stopped) | DND | opp leaves the stage
//        (completed) | sequence exhausted (recovery_done, Aidan alerted).
// ResparkLead record fields used: status 'recovery' | 'recovery_replied' | 'recovery_stopped' | 'recovery_done' | 'completed',
//   recovery_step, recovery_next_at, recovery_started_at, recovery_last_inbound_at, recovery_carrier, recovery_product, recovery_amount, recovery_notes.
// The Respark sender / enroller / reply bot only touch status active|conversing|booked|handoff, so these records are invisible to them.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
const GHL_API_KEY = Deno.env.get('GHL_API_KEY') || '';
const LOC = 'P1m006Mt7YCXCAdiBBxC';
const AIDAN_CONTACT_ID = 'hLZmFD5Azf8WHCpBuk0d';
const AIDAN_TZ = 'America/Chicago';
const LOST_STAGE_NAME = /lost at banking/i;

const STATE_TZ: Record<string, string> = { alabama: 'America/Chicago', arizona: 'America/Phoenix', arkansas: 'America/Chicago', california: 'America/Los_Angeles', colorado: 'America/Denver', connecticut: 'America/New_York', delaware: 'America/New_York', florida: 'America/New_York', georgia: 'America/New_York', idaho: 'America/Boise', illinois: 'America/Chicago', indiana: 'America/Indiana/Indianapolis', iowa: 'America/Chicago', kansas: 'America/Chicago', kentucky: 'America/New_York', louisiana: 'America/Chicago', maine: 'America/New_York', maryland: 'America/New_York', massachusetts: 'America/New_York', michigan: 'America/Detroit', minnesota: 'America/Chicago', mississippi: 'America/Chicago', missouri: 'America/Chicago', montana: 'America/Denver', nebraska: 'America/Chicago', nevada: 'America/Los_Angeles', 'new hampshire': 'America/New_York', 'new jersey': 'America/New_York', 'new mexico': 'America/Denver', 'new york': 'America/New_York', 'north carolina': 'America/New_York', 'north dakota': 'America/Chicago', ohio: 'America/New_York', oklahoma: 'America/Chicago', oregon: 'America/Los_Angeles', pennsylvania: 'America/New_York', 'rhode island': 'America/New_York', 'south carolina': 'America/New_York', 'south dakota': 'America/Chicago', tennessee: 'America/Chicago', texas: 'America/Chicago', utah: 'America/Denver', vermont: 'America/New_York', virginia: 'America/New_York', washington: 'America/Los_Angeles', 'west virginia': 'America/New_York', wisconsin: 'America/Chicago', wyoming: 'America/Denver' };
const STATE_ABBR: Record<string, string> = { al: 'alabama', az: 'arizona', ar: 'arkansas', ca: 'california', co: 'colorado', ct: 'connecticut', de: 'delaware', fl: 'florida', ga: 'georgia', id: 'idaho', il: 'illinois', in: 'indiana', ia: 'iowa', ks: 'kansas', ky: 'kentucky', la: 'louisiana', me: 'maine', md: 'maryland', ma: 'massachusetts', mi: 'michigan', mn: 'minnesota', ms: 'mississippi', mo: 'missouri', mt: 'montana', ne: 'nebraska', nv: 'nevada', nh: 'new hampshire', nj: 'new jersey', nm: 'new mexico', ny: 'new york', nc: 'north carolina', nd: 'north dakota', oh: 'ohio', ok: 'oklahoma', or: 'oregon', pa: 'pennsylvania', ri: 'rhode island', sc: 'south carolina', sd: 'south dakota', tn: 'tennessee', tx: 'texas', ut: 'utah', vt: 'vermont', va: 'virginia', wa: 'washington', wv: 'west virginia', wi: 'wisconsin', wy: 'wyoming' };
function tzForState(state: string | null | undefined): string { const k = (state || '').trim().toLowerCase(); return STATE_TZ[STATE_ABBR[k] || k] || AIDAN_TZ; }

const H = { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28', 'Accept': 'application/json', 'Content-Type': 'application/json' };
async function ghl(path: string, init: RequestInit = {}) {
  const r = await fetch(`https://services.leadconnectorhq.com${path}`, { ...init, headers: { ...H, ...(init.headers || {}) } });
  const t = await r.text(); let json: any = {}; try { json = JSON.parse(t); } catch { json = { raw: t }; }
  return { ok: r.ok, status: r.status, json };
}
async function sendSms(contactId: string, message: string) {
  const r = await ghl('/conversations/messages', { method: 'POST', body: JSON.stringify({ type: 'SMS', contactId, message }) });
  return { ok: r.ok, err: r.ok ? '' : `${r.status} ${JSON.stringify(r.json).slice(0, 160)}` };
}
async function alertAidan(m: string) { try { await sendSms(AIDAN_CONTACT_ID, m.slice(0, 1500)); } catch (_) {} }
async function addNote(contactId: string, body: string) { try { await ghl(`/contacts/${contactId}/notes`, { method: 'POST', body: JSON.stringify({ body: body.slice(0, 4000) }) }); } catch (_) {} }
async function addTags(contactId: string, tags: string[]) { try { await ghl(`/contacts/${contactId}/tags`, { method: 'POST', body: JSON.stringify({ tags }) }); } catch (_) {} }

function localParts(d: Date, tz: string) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d);
  const g = (t: string) => p.find(x => x.type === t)!.value;
  return { y: +g('year'), mo: +g('month'), d: +g('day'), h: +g('hour') % 24, mi: +g('minute'), wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday')) };
}
function localToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  let guess = new Date(Date.UTC(y, mo - 1, d, h, mi));
  for (let i = 0; i < 2; i++) { const lp = localParts(guess, tz); guess = new Date(Date.UTC(y, mo - 1, d, h, mi) - (Date.UTC(lp.y, lp.mo - 1, lp.d, lp.h, lp.mi) - guess.getTime())); }
  return guess;
}
function fmtLocal(d: Date, tz: string) { return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(d); }
function stamp() { return new Date().toLocaleString('en-US', { timeZone: AIDAN_TZ }) + ' CT'; }
// Texting window: 9:00am-7:30pm local Mon-Sat; Sunday 12:00-7:30pm except AL/LA/MS/UT/RI.
const SUNDAY_BLACKOUT = ['alabama', 'al', 'louisiana', 'la', 'mississippi', 'ms', 'utah', 'ut', 'rhode island', 'ri'];
function inWindow(now: Date, tz: string, state?: string | null) {
  const lp = localParts(now, tz); const m = lp.h * 60 + lp.mi;
  if (lp.wd === 0) return !SUNDAY_BLACKOUT.includes((state || '').toLowerCase()) && m >= 12 * 60 && m <= 19 * 60 + 30;
  return m >= 9 * 60 && m <= 19 * 60 + 30;
}
function nextWindowStart(from: Date, tz: string, state?: string | null): Date {
  for (let d = 0; d < 8; d++) {
    const lp = localParts(new Date(from.getTime() + d * 86400000), tz);
    if (lp.wd === 0 && SUNDAY_BLACKOUT.includes((state || '').toLowerCase())) continue;
    const t = localToUtc(lp.y, lp.mo, lp.d, lp.wd === 0 ? 12 : 9, lp.wd === 0 ? 15 : 30, tz);
    if (t.getTime() > from.getTime()) return t;
  }
  return new Date(from.getTime() + 86400000);
}
// Day offset + local send time for each touch after the first
const SCHEDULE: Array<[number, number, number]> = [[0, 9, 30], [1, 12, 15], [3, 17, 30], [6, 10, 0], [9, 13, 0], [13, 11, 0]];
function stepTime(start: Date, step: number, tz: string, state: string): Date {
  const [days, h, mi] = SCHEDULE[Math.min(step, SCHEDULE.length - 1)];
  const lp = localParts(new Date(start.getTime() + days * 86400000), tz);
  let t = localToUtc(lp.y, lp.mo, lp.d, h, mi, tz);
  if (!inWindow(t, tz, state)) t = nextWindowStart(t, tz, state);
  return t;
}

// ---- Copy (Aidan's voice). ctx: { first, carrier, product, amount } ----
function copy(step: number, c: { first: string; carrier: string; product: string; amount: string }): { label: string; text: string } | null {
  const carrier = c.carrier || 'the carrier';
  const amt = c.amount ? `${c.amount} ` : '';
  const cov = c.amount || c.product ? `the ${amt}${c.product || 'coverage'}`.replace(/\s+/g, ' ') : 'the coverage we set up';
  const T: Array<[string, string]> = [
    ['D1 congrats + call ask', `${c.first}, Aidan here. Good news, ${carrier} came back and you're fully approved for ${cov} we talked about. Congrats, that's the hard part done. I tried you back a couple times and missed you. I just need 10 minutes to go over it with you and make sure it's still what you want to do. What time works today or tomorrow?`],
    ['D2 nothing moves until we talk', `${c.first}, quick one. Your approval is sitting here ready to go. Nothing moves forward until you and I finish that review call, so no surprises on your end. Morning or afternoon better for you?`],
    ['D4 honest: open app with your info', `${c.first}, I'll be straight with you. That application has your personal and health information on it and I don't like leaving one of those sitting open. If you've had second thoughts, just tell me and I'll close it out, no hard feelings. If you still want ${cov}, 10 minutes gets it done. Which way do you want to go?`],
    ['D7 approvals do not stay open', `${c.first}, Aidan again. Just making sure nothing's wrong on your end. Approvals like this don't stay open forever, ${carrier} pulls it back if we don't finish up. Want me to hold it for you or let it go?`],
    ['D10 if it was the premium', `${c.first}, if it was the monthly amount that made you pause, say so. We can drop the face amount or move the draft date, whatever makes it fit the budget. Want me to run that for you?`],
    ['D14 last one, closing it out', `${c.first}, last one from me on this. I'm going to close out your ${carrier} application at the end of the week so your info isn't sitting out there. If you want to keep ${cov} in place, text me back before then and we'll finish it in one quick call. Either way, I appreciate you. Aidan`],
  ];
  if (step >= T.length) return null;
  return { label: T[step][0], text: T[step][1] };
}

const NEG = /\b(stop|unsubscribe|quit|cancel( it)?|not interested|no longer|don'?t want|dont want|leave me alone|remove me|no thanks?|changed my mind|forget it)\b/i;

async function lostStages(): Promise<Record<string, { pipeline: string; stage: string }>> {
  const r = await ghl(`/opportunities/pipelines?locationId=${LOC}`);
  const out: Record<string, { pipeline: string; stage: string }> = {};
  for (const p of (r.json.pipelines || [])) for (const s of (p.stages || [])) if (LOST_STAGE_NAME.test(s.name || '')) out[p.id] = { pipeline: p.name, stage: s.id };
  return out;
}
async function latestInbound(contactId: string): Promise<{ at: Date; text: string } | null> {
  const s = await ghl(`/conversations/search?locationId=${LOC}&contactId=${contactId}`);
  const conv = (s.json.conversations || [])[0]; if (!conv) return null;
  const m = await ghl(`/conversations/${conv.id}/messages?limit=20`);
  const msgs: any[] = m.json.messages?.messages || m.json.messages || [];
  const inb = msgs.filter((x: any) => x.direction === 'inbound' && /SMS/i.test(x.messageType || x.type || 'SMS')).sort((a: any, b: any) => new Date(b.dateAdded).getTime() - new Date(a.dateAdded).getTime())[0];
  return inb ? { at: new Date(inb.dateAdded), text: String(inb.body || '').trim() } : null;
}
function parseWhen(s: string): Date | null {
  if (!s) return null; const t = s.trim();
  if (/(Z|[+-]\d\d:?\d\d)$/.test(t)) { const d = new Date(t); return isNaN(d.getTime()) ? null : d; }
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/); if (!m) return null;
  return localToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], AIDAN_TZ);
}
function properName(s: string) { return String(s || '').trim().split(/\s+/).map(w => w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w).join(' '); }

Deno.serve(async (req: Request) => {
  const base44 = createClientFromRequest(req);
  const svc = (base44 as any).asServiceRole.entities.ResparkLead;
  let b: any = {}; try { b = await req.json(); } catch (_) {}
  const dryRun = b.dry_run === true;
  const now = new Date();
  const out: any = { dry_run: dryRun, enrolled: [], sent: [], replied: [], stopped: [], done: [], errors: [] };

  // Enroll one contact (manual or auto). Returns the record.
  async function enroll(contactId: string, o: { carrier?: string; product?: string; amount?: string; notes?: string; start_at?: Date | null; source: string; opp?: any }) {
    const c = (await ghl(`/contacts/${contactId}`)).json.contact; if (!c?.id) throw new Error('contact not found');
    const existing: any[] = await svc.filter({ ghl_contact_id: c.id }, '-created_date', 3);
    const L = existing[0] || null;
    if (L?.recovery_started_at && L.status !== 'recovery' && !o.start_at) return null; // already ran once; re-enroll only by hand
    const state = c.state || L?.state || ''; const tz = tzForState(state);
    const want = o.start_at || new Date(now.getTime() + 60000);
    const first = inWindow(want, tz, state) ? want : nextWindowStart(want, tz, state);
    const upd: any = { ghl_contact_id: c.id, first_name: properName(c.firstName || L?.first_name || ''), last_name: properName(c.lastName || L?.last_name || ''), phone: c.phone || L?.phone || '', email: c.email || L?.email || '', state, timezone: tz,
      status: 'recovery', stop_reason: `approval recovery (${o.source}), starts ${fmtLocal(first, AIDAN_TZ)}`, recovery_step: 0, recovery_next_at: first.toISOString(), recovery_anchor_at: first.toISOString(), recovery_started_at: now.toISOString(), recovery_last_inbound_at: now.toISOString(),
      recovery_carrier: o.carrier || L?.recovery_carrier || '', recovery_product: o.product || L?.recovery_product || '', recovery_amount: o.amount || L?.recovery_amount || '', recovery_notes: o.notes || L?.recovery_notes || '',
      seq_log: [...(L?.seq_log || []), `${stamp()} enrolled in approval recovery (${o.source}); first text ${fmtLocal(first, AIDAN_TZ)}`] };
    if (o.opp) { upd.ghl_opportunity_id = o.opp.id; upd.pipeline_id = o.opp.pipelineId; }
    if (dryRun) return { ...upd, id: L?.id || 'new' };
    const rec = L ? await svc.update(L.id, upd) : await svc.create({ ...upd, enrolled_at: now.toISOString(), step: 0, messages_sent: 0, reply_count: 0, conversation: [] });
    await addTags(c.id, ['Lost at Banking', 'Approval Recovery']);
    await addNote(c.id, `APPROVAL RECOVERY DRIP started ${stamp()} (${o.source}). ${[o.carrier, o.product, o.amount].filter(Boolean).join(' ')}${o.notes ? '. ' + o.notes : ''}. First text ${fmtLocal(first, AIDAN_TZ)}. Any reply stops the drip and pings Aidan.`);
    out.enrolled.push(`${upd.first_name} ${upd.last_name} (${o.source}) first text ${fmtLocal(first, AIDAN_TZ)}`);
    return rec || upd;
  }

  try {
    const stages = await lostStages();

    if (b.action === 'enroll') {
      if (!b.contact_id) return Response.json({ success: false, error: 'contact_id required' });
      const start = b.start_at ? parseWhen(String(b.start_at)) : null;
      if (b.start_at && !start) return Response.json({ success: false, error: 'start_at must be "YYYY-MM-DD HH:MM" (CT) or ISO' });
      // move the opp into Lost at Banking if it is not there yet
      let opp: any = null;
      const opps = ((await ghl(`/opportunities/search?location_id=${LOC}&contact_id=${b.contact_id}`)).json.opportunities || []).filter((x: any) => x.status === 'open');
      opp = opps.find((x: any) => stages[x.pipelineId]) || opps[0] || null;
      if (opp && stages[opp.pipelineId] && opp.pipelineStageId !== stages[opp.pipelineId].stage && !dryRun) await ghl(`/opportunities/${opp.id}`, { method: 'PUT', body: JSON.stringify({ pipelineStageId: stages[opp.pipelineId].stage }) });
      const rec = await enroll(b.contact_id, { carrier: b.carrier, product: b.product, amount: b.amount, notes: b.notes, start_at: start, source: 'Aidan', opp });
      const preview = copy(0, { first: rec?.first_name || '', carrier: b.carrier || '', product: b.product || '', amount: b.amount || '' });
      return Response.json({ success: true, ...out, opp_moved: !!(opp && stages[opp.pipelineId]), first_text: preview?.text, schedule: SCHEDULE.map((s, i) => `touch ${i + 1}: day ${s[0]} ${s[1]}:${String(s[2]).padStart(2, '0')} local`) });
    }

    // ---- RUN ----
    // 1. Auto-enroll anything sitting in a Lost at Banking stage
    for (const [pid, s] of Object.entries(stages)) {
      const r = await ghl(`/opportunities/search?location_id=${LOC}&pipeline_id=${pid}&pipeline_stage_id=${s.stage}&status=open&limit=100`);
      for (const o of (r.json.opportunities || [])) {
        const cid = o.contact?.id || o.contactId; if (!cid) continue;
        const ex: any[] = await svc.filter({ ghl_contact_id: cid }, '-created_date', 1);
        if (ex[0]?.recovery_started_at) continue;
        try { await enroll(cid, { source: `stage ${s.pipeline}`, opp: o }); } catch (e) { out.errors.push(`enroll ${cid}: ${String(e).slice(0, 120)}`); }
      }
    }

    // 2. Work every active recovery record
    const active: any[] = await svc.filter({ status: 'recovery' }, 'recovery_next_at', 200);
    for (const L of active) {
      const tz = L.timezone || AIDAN_TZ; const log: string[] = [...(L.seq_log || [])]; const upd: any = {};
      const who = `${L.first_name} ${L.last_name || ''} ${L.phone}`.trim();
      try {
        const c = (await ghl(`/contacts/${L.ghl_contact_id}`)).json.contact || {};
        if (c.dnd === true || c.dndSettings?.SMS?.status === 'active') { upd.status = 'recovery_stopped'; upd.stop_reason = 'DND'; log.push(`${stamp()} recovery stopped: DND`); out.stopped.push(`${who} DND`); if (!dryRun) await svc.update(L.id, { ...upd, seq_log: log }); continue; }
        // opp left the stage?
        if (L.ghl_opportunity_id && stages[L.pipeline_id]) {
          const o = (await ghl(`/opportunities/${L.ghl_opportunity_id}`)).json.opportunity;
          if (o && (o.status !== 'open' || o.pipelineStageId !== stages[L.pipeline_id].stage)) { upd.status = 'completed'; upd.stop_reason = `opp moved out of Lost at Banking (${o.status}/${o.pipelineStageId})`; log.push(`${stamp()} recovery ended: ${upd.stop_reason}`); out.done.push(`${who} moved by Aidan`); if (!dryRun) await svc.update(L.id, { ...upd, seq_log: log }); continue; }
        }
        // reply?
        const inb = await latestInbound(L.ghl_contact_id);
        const since = new Date(L.recovery_last_inbound_at || L.recovery_started_at || 0);
        if (inb && inb.at.getTime() > since.getTime()) {
          const neg = NEG.test(inb.text);
          upd.recovery_last_inbound_at = inb.at.toISOString(); upd.last_inbound_at = inb.at.toISOString(); upd.reply_count = (L.reply_count || 0) + 1;
          upd.conversation = [...(L.conversation || []), { role: 'lead', text: inb.text, at: inb.at.toISOString() }];
          upd.status = neg ? 'recovery_stopped' : 'recovery_replied'; upd.stop_reason = neg ? 'lead declined during recovery' : 'lead replied during recovery, Aidan to call';
          log.push(`${stamp()} lead replied "${inb.text.slice(0, 80)}" -> ${upd.status}`);
          if (!dryRun) {
            if (!neg) { const ack = `Got you ${L.first_name}, I'll give you a call shortly. If there's a better time just tell me what works.`; const s = await sendSms(L.ghl_contact_id, ack); if (s.ok) upd.conversation.push({ role: 'aidan_bot', text: ack, at: now.toISOString() }); }
            await alertAidan(`${neg ? 'DECLINED' : 'REPLIED'} (approval recovery): ${who} said "${inb.text.slice(0, 200)}". ${neg ? 'Drip stopped. Your call whether to close the app.' : 'Drip stopped, I told them you will call shortly. CALL NOW.'}${L.recovery_product ? ` File: ${[L.recovery_carrier, L.recovery_amount, L.recovery_product].filter(Boolean).join(' ')}.` : ''}`);
            await addNote(L.ghl_contact_id, `Approval recovery: lead replied "${inb.text.slice(0, 300)}" at ${fmtLocal(inb.at, AIDAN_TZ)}. ${neg ? 'Declined, drip stopped.' : 'Drip stopped, Aidan alerted to call.'}`);
          }
          out.replied.push(`${who}: ${inb.text.slice(0, 60)}`);
          if (!dryRun) await svc.update(L.id, { ...upd, seq_log: log }); continue;
        }
        // due?
        const next = L.recovery_next_at ? new Date(L.recovery_next_at) : null;
        if (!next || next.getTime() > now.getTime()) continue;
        if (!inWindow(now, tz, L.state)) continue;
        const step = L.recovery_step || 0;
        const msg = copy(step, { first: L.first_name, carrier: L.recovery_carrier || '', product: L.recovery_product || '', amount: L.recovery_amount || '' });
        if (!msg) { upd.status = 'recovery_done'; upd.stop_reason = 'recovery sequence exhausted, no reply'; log.push(`${stamp()} recovery done, no reply`); out.done.push(`${who} exhausted`); if (!dryRun) { await svc.update(L.id, { ...upd, seq_log: log }); await alertAidan(`Approval recovery finished for ${who} with no reply after ${step} texts. Close out the ${L.recovery_carrier || ''} application or dial them one more time.`); } continue; }
        if (dryRun) { out.sent.push(`${who} [${msg.label}] ${msg.text.slice(0, 60)}`); continue; }
        const s = await sendSms(L.ghl_contact_id, msg.text);
        if (!s.ok) { upd.recovery_next_at = new Date(now.getTime() + 45 * 60000).toISOString(); log.push(`${stamp()} ${msg.label} FAILED ${s.err}`); out.errors.push(`${who} ${s.err}`); await svc.update(L.id, { ...upd, seq_log: log }); continue; }
        const nstep = step + 1; const anchor = new Date(L.recovery_anchor_at || L.recovery_started_at || now);
        const nxt = nstep < SCHEDULE.length ? stepTime(anchor, nstep, tz, L.state) : stepTime(now, 1, tz, L.state);
        upd.recovery_step = nstep; upd.recovery_next_at = nxt.toISOString(); upd.messages_sent = (L.messages_sent || 0) + 1; upd.last_sms_at = now.toISOString();
        upd.conversation = [...(L.conversation || []), { role: 'aidan_sequence', text: msg.text, at: now.toISOString(), label: `recovery ${msg.label}` }];
        log.push(`${stamp()} sent recovery ${msg.label}; next ${fmtLocal(nxt, AIDAN_TZ)}`);
        out.sent.push(`${who} ${msg.label}`);
        await svc.update(L.id, { ...upd, seq_log: log });
      } catch (e) { out.errors.push(`${who}: ${String(e).slice(0, 160)}`); }
    }
    return Response.json({ success: true, active: active.length, stages: Object.values(stages).map(s => s.pipeline), ...out });
  } catch (e) { return Response.json({ success: false, error: String((e as any)?.message || e).slice(0, 400), ...out }); }
});
