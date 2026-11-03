// Ashley: AI texting assistant for the Respark campaign. Runs every 5 minutes (and can be hit directly by a GHL webhook with
// { contact_id }). For every enrolled lead with a new inbound text it: logs the message, handles STOP, and either hands off to
// Aidan or has Ashley reply with the goal of booking a 30-minute phone call on Aidan's Outlook calendar (9am-5pm CT, Mon-Fri).
// Booking: creates the Outlook event, texts a confirmation, moves the GHL opportunity to the Appointment stage, alerts Aidan.
// Simulation: POST { simulate: { text, first_name, driver_type, state, history: [...] } } returns Ashley's reply without side effects.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
//__SHARED__//
//__COPY__//

const CALL_MINUTES = 30;
const MAX_ASHLEY_TURNS = 14;
const REPLY_HOUR_START = 7, REPLY_HOUR_END = 22; // Ashley answers inbound texts 7am-10pm recipient local; later texts get answered in the morning
const BOOK_START_H = 9, BOOK_END_H = 17; // Aidan's call hours, CT, Mon-Fri
const MIN_NOTICE_MIN = 90;
const STOP_RE = /^\s*(stop|stopall|stop all|unsubscribe|cancel|end|quit|remove me|opt out|optout)\b[\s.!]*$/i;

// ---------- Outlook ----------
async function outlookToken(base44: any): Promise<string> {
  const c = await base44.asServiceRole.connectors.getConnection('outlook');
  return c.accessToken || c.access_token || c.token;
}
async function graph(token: string, path: string, init: RequestInit = {}) {
  const r = await fetch(`https://graph.microsoft.com/v1.0${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`Graph ${r.status} ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}
// Free 30-min slots over the next 7 days inside Aidan's call hours
async function freeSlots(token: string, now: Date): Promise<Date[]> {
  const start = new Date(now.getTime() + MIN_NOTICE_MIN * 60000);
  const end = new Date(now.getTime() + 8 * 86400000);
  const ev = await graph(token, `/me/calendarView?startDateTime=${start.toISOString()}&endDateTime=${end.toISOString()}&$select=start,end,showAs,isCancelled&$top=200`);
  const busy = (ev?.value || []).filter((e: any) => !e.isCancelled && e.showAs !== 'free').map((e: any) => ({ s: new Date(e.start.dateTime + 'Z').getTime(), e: new Date(e.end.dateTime + 'Z').getTime() }));
  const slots: Date[] = [];
  for (let day = 0; day < 8; day++) {
    const dp = localParts(new Date(now.getTime() + day * 86400000), AIDAN_TZ);
    if (dp.wd === 0 || dp.wd === 6) continue;
    for (let h = BOOK_START_H; h < BOOK_END_H; h++) for (const mi of [0, 30]) {
      const s = localToUtc(dp.y, dp.mo, dp.d, h, mi, AIDAN_TZ); const e = new Date(s.getTime() + CALL_MINUTES * 60000);
      if (s.getTime() < start.getTime()) continue;
      if (busy.some((b: any) => s.getTime() < b.e + 10 * 60000 && e.getTime() > b.s - 10 * 60000)) continue;
      slots.push(s);
    }
  }
  return slots;
}
// Pick a short, varied menu of slots to show the model: up to 3 per day over the next 4 business days
function slotMenu(slots: Date[]): Date[] {
  const byDay: Record<string, Date[]> = {};
  for (const s of slots) { const k = s.toISOString().slice(0, 10) + localParts(s, AIDAN_TZ).d; (byDay[k] ||= []).push(s); }
  const out: Date[] = [];
  for (const k of Object.keys(byDay).slice(0, 4)) {
    const d = byDay[k]; const picks = [d[0], d[Math.floor(d.length / 2)], d[d.length - 1]].filter((x, i, a) => x && a.indexOf(x) === i);
    out.push(...picks);
  }
  return out;
}
async function bookEvent(token: string, L: any, startIso: string, convo: any[]) {
  const s = new Date(startIso); const e = new Date(s.getTime() + CALL_MINUTES * 60000);
  const transcript = convo.slice(-12).map((m: any) => `<li><b>${m.role === 'lead' ? L.first_name : m.role === 'ashley' ? 'Ashley' : 'Sequence'}:</b> ${String(m.text).replace(/</g, '&lt;')}</li>`).join('');
  const body = `<p><b>Respark trucker lead, phone call (Aidan calls the lead)</b></p>
<p>Name: ${L.first_name} ${L.last_name || ''}<br>Phone: ${L.phone}<br>Email: ${L.email || 'n/a'}<br>State: ${L.state || 'n/a'} (${L.timezone})<br>Driver type: ${L.driver_type || 'n/a'}<br>Age: ${L.age || 'n/a'} | ${L.marital_status || ''} | Beneficiary: ${L.beneficiary_relationship || 'n/a'}</p>
<p>Booked by Ashley. GHL contact: ${L.ghl_contact_id}</p><p><b>Text thread:</b></p><ul>${transcript}</ul>`;
  const ev = await graph(token, '/me/events', { method: 'POST', body: JSON.stringify({
    subject: `Call ${L.first_name} ${L.last_name || ''} (trucker lead) ${L.phone}`.trim(),
    body: { contentType: 'HTML', content: body },
    start: { dateTime: s.toISOString().slice(0, 19), timeZone: 'UTC' }, end: { dateTime: e.toISOString().slice(0, 19), timeZone: 'UTC' },
    isReminderOn: true, reminderMinutesBeforeStart: 15, showAs: 'busy', categories: ['Respark'],
  }) });
  return ev?.id || '';
}

// ---------- GHL inbound ----------
async function newInbound(contactId: string, sinceMs: number): Promise<{ at: number; text: string }[]> {
  const convs = (await ghl(`/conversations/search?locationId=${LOC}&contactId=${contactId}`, {}, '2021-04-15')).json.conversations || [];
  const out: { at: number; text: string }[] = [];
  for (const cv of convs) {
    if (cv.lastMessageDirection !== 'inbound' && !(Number(cv.lastMessageDate) > sinceMs)) continue;
    const ms = (await ghl(`/conversations/${cv.id}/messages?limit=40`, {}, '2021-04-15')).json;
    const list: any[] = ms.messages?.messages || ms.messages || [];
    for (const m of list) {
      const at = new Date(m.dateAdded).getTime();
      if (m.direction === 'inbound' && String(m.messageType || m.type || '').includes('SMS') && at > sinceMs && m.body) out.push({ at, text: String(m.body).trim() });
    }
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

// ---------- Ashley brain ----------
function systemPrompt(L: any, menu: Date[], now: Date, discloseAi: boolean) {
  const tz = L.timezone || AIDAN_TZ;
  const group = driverGroup(L.driver_type);
  const slotLines = menu.map(s => `- ${s.toISOString()} = ${fmtLocal(s, tz)}${tz !== AIDAN_TZ ? ` (${fmtLocal(s, AIDAN_TZ, false)})` : ''}`).join('\n');
  return `You are Ashley, the scheduling assistant for Aidan, a licensed life insurance advisor (license #${LIC}) based in Bentonville, Arkansas who works with CDL truck drivers. Aidan's brokerage works with a lot of JB Hunt, Walmart and Tyson drivers as well as owner-operators. You are texting with a lead by SMS.

WHO YOU ARE TALKING TO
- Name: ${L.first_name} ${L.last_name || ''}. State: ${L.state || 'unknown'}. Local time zone: ${tz}. Right now it is ${fmtLocal(now, tz)} for them.
- Driver type (from their form): ${L.driver_type || 'unknown'} (${group === 'owner_op' ? 'owner-operator: no company benefits, truck payments, irregular income' : group === 'company' ? 'company driver: has basic group life through the carrier that ends when they leave or lose their med card' : 'unknown'}).
- Age ${L.age || 'unknown'}, ${L.marital_status || 'marital status unknown'}, beneficiary they listed: ${L.beneficiary_relationship || 'unknown'}.
- They filled out an online form asking about life insurance / an IUL (indexed universal life) for CDL drivers. Aidan called a few times with no answer. YOU (Ashley) then sent them the short text sequence shown in the conversation below, so you have already introduced yourself. They have now replied. Continue the same thread naturally; do not reintroduce yourself unless they ask who this is.

YOUR ONE GOAL
Get them on a ${CALL_MINUTES}-minute phone call with Aidan. Aidan calls them at this number. Available call times (pick from this list only, present them in THEIR local time, offer at most two at a time, vary morning/evening based on what they say about their schedule):
${slotLines || '- (no open slots in the next week: ask what day/time works and hand off to Aidan)'}

HOW YOU TEXT
- Like a real person texting from a phone: 1-3 short sentences, under 300 characters, plain language, no emojis, no exclamation point pileups, no bullet lists, no links.
- Warm, calm, zero pressure. Drivers get hammered by salespeople; you are the opposite. Never argue. Mirror their energy.
- Ask ONE question per text. Acknowledge what they said before moving forward.
- No signatures; they already know it's Ashley. If they ask who this is: "${discloseAi ? "Ashley, Aidan's AI assistant" : "Ashley, Aidan's assistant"}, he's the licensed advisor who got your request".${discloseAi ? ' This lead is in a state that requires you to say you are an AI assistant up front, so say it plainly in your first reply.' : ''}
- Energy: upbeat and confident, like someone who genuinely likes drivers and wants to get them squared away. Make it easy to say yes: every message ends with one simple question they can answer in a word or two.
- If they ask whether you are a bot, AI, real, or a person: tell the truth plainly. You are an AI assistant that handles Aidan's scheduling; Aidan is a real licensed advisor and he is who they will talk to.
- Use trucker-aware language naturally when it fits (on the road, home time, reset, med card, parked). Never fake CB slang.
- If they say they are driving: keep it to one line and ask when they will be parked.

HARD RULES (licensing and compliance)
- Never quote a price, premium, rate, dollar amount, "$1/day", percentage, or return. If asked about cost, say honestly that it depends on age, health and the amount, that Aidan is the licensed one who can run real numbers in a few minutes, and offer a time.
- Never say anyone is approved, qualifies, or guaranteed. Never give medical, tax or legal opinions. You can say Aidan works with carriers that are used to CDL drivers and common things like blood pressure or sleep apnea often are not automatic no's, and let Aidan handle specifics.
- Never name specific insurance carriers or products beyond "the IUL you asked about" or "coverage".
- Never ask for sensitive data (SSN, bank, medical details, date of birth). Confirming the phone number for the call is fine.
- If they say they already have coverage: do not argue. Ask one light question (is it through the company or in their own name) and only if they engage, suggest a quick call to make sure it goes with them if they change jobs.
- If they say not interested, no, leave me alone, or anything similar: thank them in one short line, say you will take them off the list, wish them safe travels, and set intent "not_interested". Do not try to save it.
- If they say this is the wrong number / they never asked for this / they are not a driver: apologize in one line and set intent "wrong_person".
- CALL NOW: if they ask Aidan to call them now, right away, asap, or "just call me": set intent "handoff" with reason "wants a call now". Reply only: acknowledge, say you're pinging Aidan right now, and that if he's mid-call with another driver he'll ring them as soon as he's off. Do not offer times in that message.
- If they ask something only a licensed agent should answer, seem upset, or you have gone back and forth several times without a booking: set intent "handoff" with a reason, and tell them Aidan will reach out personally (do not promise an exact minute).
- Never claim to know what Aidan is doing right now (busy, on a call, driving). You only know his open calendar times.

BOOKING
- When they agree to one of the specific times you offered, set intent "book" and put that slot's exact ISO string from the list in book_slot. Do not book a time that is not in the list. If they propose a time not in the list, offer the closest one or two from the list.
- When you set intent "book", your reply text will be replaced by a system confirmation, so just write a short friendly line.
${L.status === 'booked' && L.appointment_at ? `- They already have a call booked for ${fmtLocal(new Date(L.appointment_at), tz)}. If they want to move it set intent "reschedule" (and offer two new times); if they want to cancel set intent "cancel_appointment"; otherwise just answer briefly.` : ''}

Respond ONLY with JSON: {"reply": string, "intent": "continue"|"book"|"handoff"|"not_interested"|"wrong_person"|"reschedule"|"cancel_appointment", "book_slot": string, "handoff_reason": string, "summary": string}
"summary" = one line about where this conversation stands, for Aidan.`;
}

async function askAshley(base44: any, L: any, menu: Date[], now: Date, discloseAi: boolean) {
  const convo: any[] = Array.isArray(L.conversation) ? L.conversation : [];
  const history = convo.slice(-20).map((m: any) => `${m.role === 'lead' ? String(L.first_name).toUpperCase() : m.role === 'ashley' ? 'ASHLEY' : 'ASHLEY (sequence text)'}: ${m.text}`).join('\n');
  const r = await base44.asServiceRole.integrations.Core.InvokeLLM({
    prompt: `${systemPrompt(L, menu, now, discloseAi)}\n\nCONVERSATION SO FAR (oldest first):\n${history}\n\nWrite Ashley's next text message as JSON.`,
    response_json_schema: { type: 'object', properties: { reply: { type: 'string' }, intent: { type: 'string' }, book_slot: { type: 'string' }, handoff_reason: { type: 'string' }, summary: { type: 'string' } }, required: ['reply', 'intent'] },
  });
  const out = typeof r === 'string' ? JSON.parse(r) : r;
  out.reply = String(out.reply || '').replace(/\s+/g, ' ').trim().slice(0, 420);
  if (!out.book_slot || out.book_slot === 'null') out.book_slot = '';
  if (!out.handoff_reason || out.handoff_reason === 'null') out.handoff_reason = '';
  return out;
}

function hashStr(x: string): number { let h = 0; for (let i = 0; i < x.length; i++) h = (h * 31 + x.charCodeAt(i)) >>> 0; return h; }

Deno.serve(async (req: Request) => {
  const base44 = createClientFromRequest(req);
  const svc = (base44 as any).asServiceRole.entities.ResparkLead;
  let body: any = {}; try { body = await req.json(); } catch (_) {}
  const now = new Date();

  // ---- simulation mode (no side effects) ----
  if (body.simulate) {
    const S = body.simulate;
    const L: any = { first_name: S.first_name || 'Mike', last_name: S.last_name || '', state: S.state || 'Texas', timezone: tzForState(S.state || 'Texas'), driver_type: S.driver_type || 'Company Driver (W-2)', age: S.age || '44', marital_status: S.marital_status || 'Married', beneficiary_relationship: S.beneficiary_relationship || 'Spouse', phone: '+15555550100', status: S.status || 'conversing', appointment_at: S.appointment_at,
      conversation: [...(S.history || [{ role: 'aidan_sequence', text: STEPS[0].text({ first: S.first_name || 'Mike', group: driverGroup(S.driver_type), married: true }) }]), { role: 'lead', text: S.text }] };
    let menu: Date[] = [];
    try { menu = slotMenu(await freeSlots(await outlookToken(base44), now)); } catch (e) { menu = []; }
    const out = await askAshley(base44, L, menu, now, AI_DISCLOSE_STATES.includes((L.state || '').toLowerCase()));
    return Response.json({ simulate: true, slots_offered: menu.map(s => fmtLocal(s, L.timezone)), ...out });
  }

  const dryRun = body.dry_run === true;
  const summary: any = { dry_run: dryRun, checked: 0, replied: [], booked: [], handoffs: [], stopped: [], deferred: [], waiting: [], errors: [] };

  let leads: any[] = [];
  if (body.contact_id) leads = await svc.filter({ ghl_contact_id: body.contact_id }, '-created_date', 5);
  else for (const st of ['conversing', 'active', 'booked', 'handoff']) leads.push(...await svc.filter({ status: st }, '-updated_date', 500));

  let token = ''; let menu: Date[] | null = null;
  const getMenu = async () => { if (menu) return menu; token = token || await outlookToken(base44); menu = slotMenu(await freeSlots(token, now)); return menu; };

  for (const L of leads) {
    if ((L.messages_sent || 0) === 0 && L.status === 'active') continue; // nothing sent yet, nothing to answer
    summary.checked++;
    const tz = L.timezone || AIDAN_TZ;
    const log: string[] = Array.isArray(L.seq_log) ? [...L.seq_log] : [];
    try {
      const since = Math.max(Number(L.last_inbound_ms) || 0, L.enrolled_at ? new Date(L.enrolled_at).getTime() : 0);
      const inbound = await newInbound(L.ghl_contact_id, since);
      if (!inbound.length) continue;
      // Human-touch delay: wait 2-6 minutes (varies per lead/message) before answering, unless called with { immediate: true }.
      const lastInAt = inbound[inbound.length - 1].at;
      const delayMin = body.immediate ? 0 : 2 + (hashStr(L.ghl_contact_id + lastInAt) % 5);
      if (now.getTime() - lastInAt < delayMin * 60000) { summary.waiting.push(`${L.phone} (${delayMin}m)`); continue; }
      const lp = localParts(now, tz);
      if (lp.h < REPLY_HOUR_START || lp.h >= REPLY_HOUR_END) { summary.deferred.push(L.phone); continue; } // answer in the morning
      const convo: any[] = Array.isArray(L.conversation) ? [...L.conversation] : [];
      for (const m of inbound) convo.push({ role: 'lead', text: m.text, at: new Date(m.at).toISOString() });
      const lastMs = inbound[inbound.length - 1].at;
      const latestText = inbound.map(m => m.text).join(' ');
      const firstReply = (L.reply_count || 0) === 0;
      const base: any = { conversation: convo, last_inbound_ms: lastMs, last_inbound_at: new Date(lastMs).toISOString(), reply_count: (L.reply_count || 0) + inbound.length };

      // STOP
      if (inbound.some(m => STOP_RE.test(m.text))) {
        log.push(`${stamp()} lead texted STOP; DND set`); summary.stopped.push(`${L.phone} STOP`);
        if (!dryRun) {
          await ghl(`/contacts/${L.ghl_contact_id}`, { method: 'PUT', body: JSON.stringify({ dndSettings: { SMS: { status: 'active', message: 'Replied STOP to Respark text' } } }) });
          await removeTags(L.ghl_contact_id, ['Respark Active']); await addTags(L.ghl_contact_id, ['Respark Stopped', 'SMS Opt-Out']);
          await svc.update(L.id, { ...base, status: 'stopped', stop_reason: 'lead replied STOP', seq_log: log });
        }
        continue;
      }
      // Already handed to Aidan: just make sure he sees it
      if (L.status === 'handoff') {
        log.push(`${stamp()} new text while in handoff: "${latestText.slice(0, 60)}"`);
        if (!dryRun) { await alertAidan(`${L.first_name} ${L.last_name || ''} (${L.phone}) texted again, you have this one: "${latestText.slice(0, 200)}"`); await svc.update(L.id, { ...base, seq_log: log }); }
        continue;
      }

      const discloseAi = AI_DISCLOSE_STATES.includes((L.state || '').toLowerCase());
      const m = await getMenu();
      const out = await askAshley(base44, { ...L, conversation: convo }, m, now, discloseAi);
      let intent = String(out.intent || 'continue');
      let replyText = out.reply;
      const upd: any = { ...base, intent, ashley_turns: (L.ashley_turns || 0) + 1 };
      const menuIso = new Set(m.map(s => s.toISOString()));

      if (intent === 'book' && out.book_slot && menuIso.has(new Date(out.book_slot).toISOString())) {
        const slot = new Date(out.book_slot);
        replyText = `You're set, ${L.first_name}. Aidan will call you ${fmtLocal(slot, tz)} at this number. If anything changes before then, just text me here and I'll move it. Safe travels.`;
        if (!dryRun) {
          token = token || await outlookToken(base44);
          if (L.appointment_event_id) { try { await graph(token, `/me/events/${L.appointment_event_id}`, { method: 'DELETE' }); } catch (_) {} }
          const evId = await bookEvent(token, L, slot.toISOString(), [...convo, { role: 'ashley', text: replyText }]);
          upd.status = 'booked'; upd.appointment_at = slot.toISOString(); upd.appointment_event_id = evId; upd.reminder_24h_sent = false; upd.reminder_1h_sent = false; upd.next_send_at = null;
          const P = PIPES[L.pipeline_id];
          if (L.ghl_opportunity_id && P) await ghl(`/opportunities/${L.ghl_opportunity_id}`, { method: 'PUT', body: JSON.stringify({ pipelineStageId: P.appointment }) });
          await removeTags(L.ghl_contact_id, ['Respark Active']); await addTags(L.ghl_contact_id, ['Ashley Booked']);
          await alertAidan(`Ashley BOOKED a call: ${L.first_name} ${L.last_name || ''} | ${L.phone} | ${fmtLocal(slot, AIDAN_TZ)} | ${L.driver_type || ''} ${L.state || ''} | ${out.summary || ''}`);
        }
        log.push(`${stamp()} booked ${fmtLocal(slot, AIDAN_TZ)}`); summary.booked.push(`${L.first_name} ${L.phone} ${fmtLocal(slot, AIDAN_TZ)}`);
      } else if (intent === 'book') {
        intent = 'continue'; upd.intent = intent; // model picked a slot not on the menu; its reply should offer real times
      }
      if (intent === 'cancel_appointment' && L.status === 'booked') {
        if (!dryRun) { token = token || await outlookToken(base44); if (L.appointment_event_id) { try { await graph(token, `/me/events/${L.appointment_event_id}`, { method: 'DELETE' }); } catch (_) {} }
          const P = PIPES[L.pipeline_id]; if (L.ghl_opportunity_id && P) await ghl(`/opportunities/${L.ghl_opportunity_id}`, { method: 'PUT', body: JSON.stringify({ pipelineStageId: P.newLead[0] }) });
          await alertAidan(`${L.first_name} ${L.last_name || ''} (${L.phone}) CANCELLED the call that was ${fmtLocal(new Date(L.appointment_at), AIDAN_TZ)}. ${out.summary || ''}`); }
        upd.status = 'conversing'; upd.appointment_at = null; upd.appointment_event_id = null; log.push(`${stamp()} appointment cancelled by lead`);
      }
      if (intent === 'reschedule' && L.status === 'booked') {
        if (!dryRun) { token = token || await outlookToken(base44); if (L.appointment_event_id) { try { await graph(token, `/me/events/${L.appointment_event_id}`, { method: 'DELETE' }); } catch (_) {} } }
        upd.status = 'conversing'; upd.appointment_at = null; upd.appointment_event_id = null; log.push(`${stamp()} lead wants to reschedule; old event removed`);
      }
      if (intent === 'not_interested') {
        upd.status = 'stopped'; upd.stop_reason = 'not interested (told Ashley)'; upd.next_send_at = null;
        if (!dryRun) { const P = PIPES[L.pipeline_id]; if (L.ghl_opportunity_id && P) await ghl(`/opportunities/${L.ghl_opportunity_id}`, { method: 'PUT', body: JSON.stringify({ pipelineStageId: P.notInterested }) });
          await removeTags(L.ghl_contact_id, ['Respark Active']); await addTags(L.ghl_contact_id, ['Respark Not Interested']); }
        log.push(`${stamp()} not interested`); summary.stopped.push(`${L.phone} not interested`);
      }
      if (intent === 'wrong_person') {
        upd.status = 'stopped'; upd.stop_reason = 'wrong number / not a driver'; upd.next_send_at = null;
        if (!dryRun) { await removeTags(L.ghl_contact_id, ['Respark Active']); await addTags(L.ghl_contact_id, ['Respark Wrong Number']); }
        log.push(`${stamp()} wrong person`); summary.stopped.push(`${L.phone} wrong person`);
      }
      if (intent === 'handoff' || (intent === 'continue' && upd.ashley_turns >= MAX_ASHLEY_TURNS)) {
        upd.status = 'handoff'; upd.next_send_at = null;
        if (!dryRun) await alertAidan(`HANDOFF ${L.first_name} ${L.last_name || ''} | ${L.phone} | ${L.driver_type || ''} ${L.state || ''}\nWhy: ${out.handoff_reason || 'conversation needs you'}\nThey said: "${latestText.slice(0, 160)}"\nAshley replied: "${replyText.slice(0, 120)}"\nReply from the GHL thread.`);
        log.push(`${stamp()} handed off to Aidan: ${out.handoff_reason || ''}`); summary.handoffs.push(`${L.first_name} ${L.phone}: ${out.handoff_reason || ''}`);
      }
      if (intent === 'continue' && upd.status !== 'handoff') { upd.status = 'conversing'; upd.next_send_at = null; }
      if (intent === 'reschedule' || intent === 'cancel_appointment') { if (!upd.status) upd.status = 'conversing'; }

      // send the reply
      if (replyText) {
        if (dryRun) summary.replied.push(`${L.first_name} ${L.phone} [${intent}] "${latestText.slice(0, 40)}" -> "${replyText.slice(0, 80)}"`);
        else {
          const s = await sendSms(L.ghl_contact_id, replyText);
          if (s.ok) { convo.push({ role: 'ashley', text: replyText, at: now.toISOString() }); upd.conversation = convo; upd.last_sms_at = now.toISOString(); log.push(`${stamp()} Ashley [${intent}]: "${replyText.slice(0, 70)}"`); summary.replied.push(`${L.first_name} ${L.phone} [${intent}]`); }
          else { log.push(`${stamp()} Ashley reply FAILED ${s.err}`); summary.errors.push(`${L.phone} send ${s.err}`); }
        }
      }
      if (firstReply && !dryRun && intent !== 'handoff' && intent !== 'book') await alertAidan(`Respark REPLY from ${L.first_name} ${L.last_name || ''} (${L.phone}, ${L.driver_type || ''} ${L.state || ''}): "${latestText.slice(0, 160)}" | Ashley's on it. ${out.summary || ''}`);
      if (!dryRun) { await removeTags(L.ghl_contact_id, ['Respark Active']); await addTags(L.ghl_contact_id, ['Respark Replied']); await svc.update(L.id, { ...upd, seq_log: log }); }
    } catch (e) { summary.errors.push(`${L.phone}: ${String(e).slice(0, 200)}`); }
  }
  summary.replied_count = summary.replied.length;
  return Response.json({ success: true, ...summary });
});
