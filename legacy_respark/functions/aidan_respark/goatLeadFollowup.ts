// GOAT fresh lead text follow-up engine. Runs every 5 minutes via workflow "GOAT Lead Follow-up Texts".
//
// Sequence (all times in the lead's local time zone, texts only between 8:00am and 8:30pm):
//   T1 opener (sent by goatLeadWebhook on arrival, or here at 8:30am if the lead came in overnight)
//   -> lead replies at any point: send T2 (call today or calendar link), notify Aidan, stop automation
//   -> no reply ~15 min after T1: send T3 (nudge: family protection / retirement / both)
//   -> still no reply ~4 hours later (same day if possible): send T4 (reply YES)
//   -> keep watching for a reply for 3 more days, then mark completed
// Stops automatically if: contact goes DND, opportunity leaves New Lead (Aidan moved it), or the lead replies.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';

const GHL_API_KEY = Deno.env.get('GHL_API_KEY') || 'pit-85b0f99f-d8cd-4e7d-9373-5213bd2548f0';
const LOC = 'P1m006Mt7YCXCAdiBBxC';
const AIDAN_CONTACT_ID = 'hLZmFD5Azf8WHCpBuk0d';
const NEW_LEAD_STAGE_ID = 'e6e62abc-045f-4b65-80e8-2ee869e3e3d9';
const CALENDAR_URL = 'https://myagentisverified.com/Calendar/aidanpipkin';

const NUDGE_DELAY_MIN = 15;          // T1 -> T3
const FINAL_DELAY_HOURS = 4;         // T3 -> T4
const WATCH_DAYS_AFTER_FINAL = 3;    // keep watching for replies after T4
const SEND_START = { h: 8, m: 0 };   // local
const SEND_END = { h: 20, m: 30 };   // local
const MORNING_SEND = { h: 8, m: 30 };

const H = { 'Authorization': `Bearer ${GHL_API_KEY}`, 'Version': '2021-07-28', 'Accept': 'application/json', 'Content-Type': 'application/json' };

// ---------- copy ----------
const T2 = (first: string) =>
  `Got it. That helps. I work primarily with CDL drivers on these plans, so I just need about 10\u201315 minutes to see what you\u2019d actually qualify for.\n` +
  `I can call you today, or you can grab a time here if that\u2019s easier:\n${CALENDAR_URL}\nWhat works better?`;
const T3 = (first: string) =>
  `${first || 'Hey'}, just making sure my text came through. I\u2019m the agent handling the request you put in for the CDL life insurance/IUL options.\n` +
  `Are you mainly looking at this for family protection, retirement accumulation, or both?`;
const T4 = (first: string) =>
  `I don\u2019t want to keep blowing your phone up${first ? ', ' + first : ''}. I just need to know whether you still want me to run the options you requested.\n` +
  `If so, reply YES and I\u2019ll take care of it from there.`;
const T1 = (first: string) =>
  `${first ? 'Hey ' + first + ', ' : 'Hey, '}this is Aidan \u2014 I\u2019m the licensed financial advisor who received your CDL/IUL request. I\u2019m looking at it now.\n` +
  `Quick question so I pull up the right options \u2014 are you a company driver or owner-operator?`;

// ---------- time helpers ----------
function localParts(d: Date, tz: string) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d);
  const g = (t: string) => parseInt(p.find(x => x.type === t)!.value, 10);
  return { y: g('year'), mo: g('month'), d: g('day'), h: g('hour') % 24, mi: g('minute') };
}
function localToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  // Two-pass offset calc
  let guess = new Date(Date.UTC(y, mo - 1, d, h, mi));
  for (let i = 0; i < 2; i++) {
    const lp = localParts(guess, tz);
    const asUtc = Date.UTC(lp.y, lp.mo - 1, lp.d, lp.h, lp.mi);
    const diff = asUtc - guess.getTime();
    guess = new Date(Date.UTC(y, mo - 1, d, h, mi) - diff);
  }
  return guess;
}
function inSendWindow(now: Date, tz: string): boolean {
  const lp = localParts(now, tz);
  const mins = lp.h * 60 + lp.mi;
  return mins >= SEND_START.h * 60 + SEND_START.m && mins <= SEND_END.h * 60 + SEND_END.m;
}
// Clamp a desired send time into the window (push to next morning if after window)
function clampToWindow(target: Date, tz: string): Date {
  const lp = localParts(target, tz);
  const mins = lp.h * 60 + lp.mi;
  if (mins < SEND_START.h * 60 + SEND_START.m) return localToUtc(lp.y, lp.mo, lp.d, MORNING_SEND.h, MORNING_SEND.m, tz);
  if (mins > SEND_END.h * 60 + SEND_END.m) {
    const next = new Date(target.getTime() + 24 * 3600 * 1000);
    const np = localParts(next, tz);
    return localToUtc(np.y, np.mo, np.d, MORNING_SEND.h, MORNING_SEND.m, tz);
  }
  return target;
}
// "Later that day": now + hours, but if that passes 8:30pm local and we're still before 8pm, send at 8pm; otherwise next morning
function laterToday(now: Date, hours: number, tz: string): Date {
  const target = new Date(now.getTime() + hours * 3600 * 1000);
  const tp = localParts(target, tz);
  const np = localParts(now, tz);
  const endMins = SEND_END.h * 60 + SEND_END.m;
  if (tp.d === np.d && tp.h * 60 + tp.mi <= endMins) return target;
  const nowMins = np.h * 60 + np.mi;
  if (nowMins < 20 * 60 - 30) return localToUtc(np.y, np.mo, np.d, 20, 0, tz); // 8:00pm local today
  return clampToWindow(target, tz);
}

// ---------- GHL ----------
async function ghl(path: string, init: RequestInit = {}, version = '2021-07-28') {
  const r = await fetch(`https://services.leadconnectorhq.com${path}`, { ...init, headers: { ...H, Version: version, ...(init.headers || {}) } });
  const text = await r.text();
  let json: any = {};
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { ok: r.ok, status: r.status, json };
}
async function sendSms(contactId: string, message: string) {
  const r = await ghl('/conversations/messages', { method: 'POST', body: JSON.stringify({ type: 'SMS', contactId, message }) });
  return { ok: r.ok, id: r.json.messageId || '', err: r.ok ? '' : `${r.status} ${JSON.stringify(r.json).slice(0, 150)}` };
}
async function alertAidan(message: string) {
  try { await sendSms(AIDAN_CONTACT_ID, message); } catch (_) {}
}
async function latestInbound(contactId: string): Promise<{ at: number; body: string } | null> {
  const r = await ghl(`/conversations/search?locationId=${LOC}&contactId=${contactId}`, {}, '2021-04-15');
  const convs: any[] = r.json.conversations || [];
  let best: { at: number; body: string } | null = null;
  for (const c of convs) {
    if (c.lastMessageDirection === 'inbound' && (c.lastMessageType || '').includes('SMS')) {
      const at = Number(c.lastMessageDate) || 0;
      if (!best || at > best.at) best = { at, body: c.lastMessageBody || '' };
    }
  }
  return best;
}

Deno.serve(async (req: Request) => {
  const base44 = createClientFromRequest(req);
  const svc = (base44 as any).asServiceRole.entities.GoatLead;
  let body: any = {};
  try { body = await req.json(); } catch (_) {}
  const dryRun = body.dry_run === true;
  const now = new Date();

  const active: any[] = await svc.filter({ seq_status: 'active' }, '-created_date', 200);
  const awaiting: any[] = await svc.filter({ seq_status: 'awaiting_reply' }, '-created_date', 200);
  const leads = [...active, ...awaiting];

  const summary: any = { checked: leads.length, sent: [], replied: [], stopped: [], completed: [], errors: [], dry_run: dryRun };

  for (const L of leads) {
    const first = L.first_name || '';
    const tz = L.timezone || 'America/Chicago';
    const log: string[] = Array.isArray(L.seq_log) ? [...L.seq_log] : [];
    const upd: any = {};
    const stamp = () => now.toLocaleString('en-US', { timeZone: 'America/Chicago' }) + ' CT';
    try {
      if (!L.ghl_contact_id) { upd.seq_status = 'stopped'; upd.stop_reason = 'no GHL contact'; log.push(`${stamp()} stopped: no contact`); summary.stopped.push(L.phone); if (!dryRun) await svc.update(L.id, { ...upd, seq_log: log }); continue; }

      // 1. Stop conditions: DND, opportunity moved out of New Lead
      const c = await ghl(`/contacts/${L.ghl_contact_id}`);
      const contact = c.json.contact || {};
      const smsDnd = contact.dnd === true || (contact.dndSettings?.SMS?.status === 'active');
      const tags: string[] = (contact.tags || []).map((t: string) => t.toLowerCase());
      if (smsDnd || tags.some(t => t.includes('unsub') || t === 'dnd' || t.includes('stop'))) {
        upd.seq_status = 'stopped'; upd.stop_reason = 'DND / unsubscribed'; log.push(`${stamp()} stopped: DND`);
        summary.stopped.push(`${L.phone} dnd`); if (!dryRun) await svc.update(L.id, { ...upd, seq_log: log }); continue;
      }
      if (L.ghl_opportunity_id) {
        const o = await ghl(`/opportunities/${L.ghl_opportunity_id}`);
        const opp = o.json.opportunity;
        if (opp && (opp.pipelineStageId !== NEW_LEAD_STAGE_ID || opp.status !== 'open')) {
          upd.seq_status = 'stopped'; upd.stop_reason = 'opportunity moved by Aidan'; log.push(`${stamp()} stopped: opp stage changed`);
          summary.stopped.push(`${L.phone} moved`); if (!dryRun) await svc.update(L.id, { ...upd, seq_log: log }); continue;
        }
      }

      // 2. Reply detection (any inbound SMS after our last outbound)
      const lastOut = L.last_sms_at ? new Date(L.last_sms_at).getTime() : 0;
      const inbound = await latestInbound(L.ghl_contact_id);
      if (inbound && inbound.at > lastOut && (L.seq_step || 0) >= 1) {
        const replyText = inbound.body.slice(0, 300);
        upd.replied_at = new Date(inbound.at).toISOString(); upd.reply_text = replyText; upd.seq_status = 'replied';
        if (!dryRun) {
          const s = await sendSms(L.ghl_contact_id, T2(first));
          if (s.ok) { upd.seq_step = 2; upd.last_sms_at = now.toISOString(); log.push(`${stamp()} T2 sent after reply: "${replyText.slice(0, 60)}"`); }
          else { log.push(`${stamp()} T2 FAILED ${s.err}`); summary.errors.push(`${L.phone} T2 ${s.err}`); }
          try { await ghl(`/contacts/${L.ghl_contact_id}/tags`, { method: 'POST', body: JSON.stringify({ tags: ['GOAT Replied'] }) }); } catch (_) {}
          await alertAidan(`GOAT lead REPLIED: ${first} ${L.last_name || ''} | ${L.phone} | "${replyText.slice(0, 120)}" | calendar text sent, you're up.`);
          await svc.update(L.id, { ...upd, seq_log: log });
        }
        summary.replied.push(`${L.phone}: ${replyText.slice(0, 40)}`);
        continue;
      }

      // 3. Awaiting-reply leads: just watch until expiry
      if (L.seq_status === 'awaiting_reply') {
        if (L.seq_expires_at && now > new Date(L.seq_expires_at)) {
          upd.seq_status = 'completed'; log.push(`${stamp()} completed: no reply after T4`); summary.completed.push(L.phone);
          if (!dryRun) await svc.update(L.id, { ...upd, seq_log: log });
        }
        continue;
      }

      // 4. Scheduled sends
      const due = !L.seq_next_at || now >= new Date(L.seq_next_at);
      if (!due) continue;
      if (!inSendWindow(now, tz)) {
        const next = clampToWindow(now, tz);
        if (!dryRun) await svc.update(L.id, { seq_next_at: next.toISOString() });
        continue;
      }
      const step = L.seq_step || 0;
      let text = '', nextStep = step, nextAt: Date | null = null, nextStatus = 'active';
      if (step === 0) { text = T1(first); nextStep = 1; nextAt = new Date(now.getTime() + NUDGE_DELAY_MIN * 60000); }
      else if (step === 1) { text = T3(first); nextStep = 3; nextAt = laterToday(now, FINAL_DELAY_HOURS, tz); }
      else if (step === 3) { text = T4(first); nextStep = 4; nextStatus = 'awaiting_reply'; upd.seq_expires_at = new Date(now.getTime() + WATCH_DAYS_AFTER_FINAL * 86400000).toISOString(); }
      else { continue; }

      if (dryRun) { summary.sent.push(`${L.phone} would send T${nextStep}`); continue; }
      const s = await sendSms(L.ghl_contact_id, text);
      if (s.ok) {
        upd.seq_step = nextStep; upd.last_sms_at = now.toISOString(); upd.seq_status = nextStatus;
        upd.seq_next_at = nextAt ? nextAt.toISOString() : null;
        if (nextStep === 1) { upd.sms_sent = true; upd.sms_message_id = s.id; }
        log.push(`${stamp()} T${nextStep} sent`);
        summary.sent.push(`${L.phone} T${nextStep}`);
      } else {
        log.push(`${stamp()} T${nextStep} FAILED ${s.err}`);
        upd.seq_next_at = new Date(now.getTime() + 30 * 60000).toISOString(); // retry in 30 min
        summary.errors.push(`${L.phone} T${nextStep} ${s.err}`);
      }
      await svc.update(L.id, { ...upd, seq_log: log });
    } catch (e) {
      summary.errors.push(`${L.phone}: ${String(e).slice(0, 150)}`);
    }
  }

  return Response.json({ success: true, ...summary, sent_count: summary.sent.length, replied_count: summary.replied.length });
});
