// Calls between an agent and their leads, always from the same business number that texts the lead.
// Outbound: Twilio rings the agent's cell first; when they answer, it dials the lead with the lead's
// business number as caller ID. Inbound: a lead calling that number rings the agent's cell, with a
// short whisper saying who it is; missed calls go to voicemail and land in the inbox.
import { tw, subCred, API } from './twilio.ts';
import { voiceUrl, pinLeadToNumber, prettyPhone } from './numbers.ts';
import { updateSummary } from './messageJobs.ts';
import { agentPhone, textAgent } from './agentNotify.ts';
import { platformConfig, exempt, applyCredit } from './credits.ts';
import { APP_ORIGIN } from './appointmentJourney.ts';

const now = () => new Date().toISOString();
const esc = (v: any) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const xml = (body: string) => new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, { status: 200, headers: { 'Content-Type': 'text/xml' } });
const VOICE = 'Polly.Joanna-Neural';
const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
const firstName = (lead: any) => String(lead?.first_name || '').trim() || 'your lead';
/** One spoken line about who this is, so the agent knows before the lead picks up. */
function briefing(lead: any, short = false) {
  if (!lead) return 'Your lead.';
  const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'Your lead';
  const facts = (lead.lead_facts && typeof lead.lead_facts === 'object') ? lead.lead_facts : {};
  const bits: string[] = [];
  if (facts.product_interest) bits.push(String(facts.product_interest));
  if (lead.state) bits.push(`in ${lead.state}`);
  const stage = lead.status === 'booked' ? 'has a call booked' : lead.status === 'replied' || lead.status === 'engaged' ? 'replied recently' : lead.status === 'needs_human' ? 'is waiting on you' : '';
  if (short) return stage ? `They ${stage}.` : '';
  return `${name}${bits.length ? `, ${bits.join(', ')}` : ''}${stage ? `, ${stage}` : ''}.`;
}

export function leadLocalHour(lead: any, s: any) {
  const tz = lead?.timezone || s?.home_timezone || 'America/Chicago';
  try { return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date())); } catch { return 12; }
}

export function callPriceCents(config: any) { return Math.max(1, Number(config.voice_price_cents_per_min) || 4); }

async function chargeCall(E: any, s: any, call: any, seconds: number) {
  if (!seconds || call.billed_cents) return 0;
  const config = await platformConfig(E);
  if (exempt(config, s.agent_email)) return 0;
  const cents = Math.ceil(seconds / 60) * callPriceCents(config);
  try { await applyCredit(E, s.agent_email, -cents, { kind: 'call_usage', description: `Call ${call.direction === 'inbound' ? 'from' : 'to'} lead (${mmss(seconds)})`, lead_id: call.lead_id || '' }); }
  catch { return 0; }
  await E.CallLog.update(call.id, { billed_cents: cents });
  return cents;
}

async function afterCall(base44: any, s: any, call: any, lead: any, summaryText: string, direction: 'inbound' | 'outbound', extra: any = {}) {
  const E = base44.asServiceRole.entities;
  if (!lead?.id) return;
  if (direction === 'outbound') await E.Lead.update(lead.id, { last_called_at: now(), call_count: (Number(lead.call_count) || 0) + 1 }).catch(() => {});
  await updateSummary(base44, s, lead, summaryText, direction, now(), extra).catch(() => {});
}

/** Handles every voice webhook step. `q` is the query string, `p` the posted Twilio params. */
export async function handleVoice(base44: any, s: any, acct: any, q: URLSearchParams, p: Record<string, string>) {
  const E = base44.asServiceRole.entities;
  const webhook = acct.webhook_url;
  const step = q.get('voice') || '';
  const callId = q.get('call') || '';
  const call = callId ? await E.CallLog.get(callId).catch(() => null) : null;
  if (call && call.agent_email !== s.agent_email) return xml('<Hangup/>');
  const lead = call?.lead_id ? await E.Lead.get(call.lead_id).catch(() => null) : null;

  // ---- Outbound: agent picked up their cell. A two-second briefing, then any key connects the lead. ----
  // (A key press instead of answering-machine detection: no dead air after pickup, and voicemail never gets the lead dialed.)
  if (step === 'answer' && call) {
    await E.CallLog.update(call.id, { status: 'briefing' });
    const bridge = voiceUrl(webhook, 'bridge', { call: call.id });
    const brief = briefing(lead);
    return xml(`<Gather numDigits="1" timeout="7" actionOnEmptyResult="false" action="${esc(bridge)}"><Say voice="${VOICE}">${esc(brief)} Press any key to connect.</Say></Gather><Say voice="${VOICE}">No key pressed. Goodbye.</Say><Hangup/>`);
  }
  if (step === 'bridge' && call) {
    if (!p.Digits) {
      await E.CallLog.update(call.id, { status: 'agent_missed', ended_at: now(), note: 'No key was pressed, so we did not dial the lead.' });
      return xml('<Hangup/>');
    }
    await E.CallLog.update(call.id, { status: 'ringing_lead' });
    const dialDone = voiceUrl(webhook, 'dialdone', { call: call.id });
    const legStatus = voiceUrl(webhook, 'status', { call: call.id, leg: 'lead' });
    return xml(`<Say voice="${VOICE}">Calling ${esc(firstName(lead))}.</Say><Dial callerId="${esc(call.from_number)}" answerOnBridge="true" timeout="30" action="${esc(dialDone)}"><Number statusCallbackEvent="answered completed" statusCallback="${esc(legStatus)}" statusCallbackMethod="POST">${esc(call.lead_phone)}</Number></Dial>`);
  }

  if (step === 'status' && call) {
    const st = String(p.CallStatus || '');
    if (q.get('leg') === 'lead') {
      if (st === 'in-progress' && !call.answered_at) await E.CallLog.update(call.id, { status: 'in_progress', answered_at: now(), lead_call_sid: p.CallSid || '' });
    } else if (['no-answer', 'busy', 'failed', 'canceled'].includes(st) && ['calling_agent', 'briefing'].includes(call.status)) {
      await E.CallLog.update(call.id, { status: 'agent_missed', ended_at: now(), note: st === 'failed' ? 'We could not reach your phone.' : 'You did not pick up, so we did not dial the lead.' });
    } else if (st === 'completed' && ['calling_agent', 'briefing', 'ringing_lead', 'in_progress'].includes(call.status)) {
      // Agent hung up before the dial result came back.
      await E.CallLog.update(call.id, { status: call.answered_at ? 'completed' : 'no_answer', ended_at: now() });
    }
    return xml('');
  }

  if (step === 'dialdone' && call) {
    const st = String(p.DialCallStatus || ''); const sec = Number(p.DialCallDuration || 0);
    const status = st === 'completed' ? 'completed' : st === 'busy' ? 'busy' : st === 'failed' ? 'failed' : 'no_answer';
    await E.CallLog.update(call.id, { status, duration_sec: sec, ended_at: now(), lead_call_sid: p.DialCallSid || call.lead_call_sid || '' });
    if (sec) await chargeCall(E, s, call, sec);
    await afterCall(base44, s, call, lead, status === 'completed' ? `📞 You called · ${mmss(sec)}` : '📞 You called · no answer', 'outbound');
    return xml(status === 'completed' ? '<Hangup/>' : `<Say voice="${VOICE}">${status === 'busy' ? 'The line is busy.' : 'No answer.'} Goodbye.</Say><Hangup/>`);
  }

  // ---- Inbound: a lead called one of the agent's numbers ----
  if (step === 'inbound') {
    const from = String(p.From || ''), to = String(p.To || '');
    const found = (await E.Lead.filter({ agent_email: s.agent_email, phone: from }, { limit: 1 })).items[0] || null;
    if (found) await pinLeadToNumber(E, s, found, to);
    const created = await E.CallLog.create({ agent_email: s.agent_email, lead_id: found?.id || '', direction: 'inbound', from_number: to, lead_phone: from, agent_phone: agentPhone(s), status: 'ringing_agent', started_at: now(), lead_call_sid: p.CallSid || '' });
    const cell = agentPhone(s);
    if (!cell) return xml(voicemailTwiml(webhook, created.id, s));
    const done = voiceUrl(webhook, 'inbounddone', { call: created.id });
    const whisper = voiceUrl(webhook, 'whisper', { call: created.id });
    return xml(`<Dial callerId="${esc(from)}" timeout="22" answerOnBridge="true" action="${esc(done)}"><Number url="${esc(whisper)}">${esc(cell)}</Number></Dial>`);
  }

  if (step === 'whisper' && call) {
    const who = lead ? `${[lead.first_name, lead.last_name].filter(Boolean).join(' ')}` : `an unknown caller`;
    const brand = String(s.brand_name || '').trim();
    return xml(`<Say voice="${VOICE}">${esc(brand ? `${brand} call` : 'Call')} from ${esc(who || 'a lead')}.${lead ? ` ${esc(briefing(lead, true))}` : ''}</Say>`);
  }

  if (step === 'inbounddone' && call) {
    const st = String(p.DialCallStatus || ''); const sec = Number(p.DialCallDuration || 0);
    if (st === 'completed' && sec > 0) {
      await E.CallLog.update(call.id, { status: 'completed', duration_sec: sec, answered_at: call.answered_at || now(), ended_at: now() });
      await chargeCall(E, s, call, sec);
      await afterCall(base44, s, call, lead, `📞 Called you · ${mmss(sec)}`, 'inbound', { unread: false });
      return xml('<Hangup/>');
    }
    return xml(voicemailTwiml(webhook, call.id, s));
  }

  if (step === 'voicemail' && call) {
    const sec = Number(p.RecordingDuration || 0);
    if (p.RecordingSid && sec >= 2) {
      await E.CallLog.update(call.id, { status: 'voicemail', recording_sid: p.RecordingSid, recording_duration_sec: sec, ended_at: now() });
      await afterCall(base44, s, call, lead, `📞 Voicemail · ${mmss(sec)}`, 'inbound');
      const who = lead ? [lead.first_name, lead.last_name].filter(Boolean).join(' ') : prettyPhone(call.lead_phone);
      await textAgent(base44, s, `New voicemail from ${who} (${mmss(sec)}). Listen: ${APP_ORIGIN}/inbox${lead ? `?lead=${lead.id}` : ''}`, `vm:${call.id}`).catch(() => {});
    } else {
      await E.CallLog.update(call.id, { status: 'missed', ended_at: now() });
      await afterCall(base44, s, call, lead, '📞 Missed call', 'inbound');
      if (lead) await textAgent(base44, s, `Missed call from ${[lead.first_name, lead.last_name].filter(Boolean).join(' ') || prettyPhone(call.lead_phone)}. Call back: ${APP_ORIGIN}/contacts/${lead.id}`, `missed:${call.id}`).catch(() => {});
    }
    return xml('<Hangup/>');
  }

  return xml('<Hangup/>');
}

function voicemailTwiml(webhook: string, callId: string, s: any) {
  const name = String(s.first_name || s.display_name || 'us').split(' ')[0];
  const brand = String(s.brand_name || '').trim();
  const vm = voiceUrl(webhook, 'voicemail', { call: callId });
  return `<Say voice="${VOICE}">Hi, you've reached ${esc(name)}${brand ? ` with ${esc(brand)}` : ''}. Sorry I missed you. Leave your name and a quick message after the tone and I'll call you right back.</Say><Record maxLength="120" playBeep="true" timeout="5" action="${esc(vm)}"/><Say voice="${VOICE}">We didn't get a message. Goodbye.</Say>`;
}

/** Starts a call: rings the agent first, then connects the lead from their business number. */
export async function startCall(E: any, s: any, lead: any, from: string, agentCell: string, webhook: string, subSid: string) {
  const call = await E.CallLog.create({ agent_email: s.agent_email, lead_id: lead.id, direction: 'outbound', from_number: from, lead_phone: lead.phone, agent_phone: agentCell, status: 'calling_agent', started_at: now() });
  try {
    const cred = await subCred(subSid);
    const created = await tw(cred, `${API}/Accounts/${cred.sid}/Calls.json`, {
      To: agentCell, From: from, Url: voiceUrl(webhook, 'answer', { call: call.id }), Method: 'POST',
      StatusCallback: voiceUrl(webhook, 'status', { call: call.id, leg: 'agent' }), StatusCallbackMethod: 'POST', StatusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      Timeout: 25,
    });
    return await E.CallLog.update(call.id, { agent_call_sid: created.sid });
  } catch (e) {
    await E.CallLog.update(call.id, { status: 'failed', ended_at: now(), note: (e as Error).message.slice(0, 200) });
    throw e;
  }
}

export async function hangUp(call: any, subSid: string) {
  const cred = await subCred(subSid);
  for (const sid of [call.lead_call_sid, call.agent_call_sid].filter(Boolean)) await tw(cred, `${API}/Accounts/${cred.sid}/Calls/${sid}.json`, { Status: 'completed' }).catch(() => {});
}
