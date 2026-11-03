// Texts and emails to the AGENT (not the lead): booked alerts, confirmations, pre-call briefs.
// Texts go from the agent's LeadRespark number to their own mobile; if that number isn't on
// Twilio yet, they go through the GHL sub-account instead. Deduplicated by key.
import { ghl } from './ghl.ts';
import { sendRawText, e164 } from './smsTransport.ts';
import { localParts } from './messageClock.ts';
import { platformConfig } from './credits.ts';
import { tw, masterCred, twilioConfigured, API } from './twilio.ts';

/** Agents get alerts 7:00 to 21:30 in their own timezone; outside that, the morning agenda covers it. */
export function agentAwake(s: any, at = Date.now()) {
  const m = localParts(at, s.home_timezone || 'America/Chicago').minutes;
  return m >= 7 * 60 && m < 21 * 60 + 30;
}

export function agentPhone(s: any) { return e164(s.notification_phone || s.alert_mobile || ''); }
export function agentEmail(s: any) { return s.notification_email || s.business_email || s.agent_email; }

/**
 * Platform owner alerts: when the owner has no LeadRespark texting number of their own, texts go out from
 * the master Twilio account using PlatformSettings.owner_alert_from_number → owner_alert_phone. Returns
 * null when that is not configured (email stays the only channel).
 */
async function ownerRoute(E: any, s: any) {
  const c = await platformConfig(E).catch(() => ({}));
  if (!c.owner_email || String(s.agent_email || '').toLowerCase() !== String(c.owner_email).toLowerCase()) return null;
  const from = e164(c.owner_alert_from_number || ''), to = e164(c.owner_alert_phone || '');
  if (!from || !to || !twilioConfigured()) return null;
  return { from, to };
}

export async function textAgent(base44: any, s: any, text: string, key: string, opts: { anyHour?: boolean } = {}) {
  const E = base44.asServiceRole.entities;
  let owner: { from: string; to: string } | null = null;
  let to = agentPhone(s);
  if (!to) { owner = await ownerRoute(E, s); to = owner?.to || ''; }
  if (!to) return { skipped: 'no agent mobile on file' };
  if (!opts.anyHour && !agentAwake(s)) return { deferred: true };
  // Inline claim (not messageJobs) so messageJobs can import this module without a cycle.
  const saved = await E.MessageDispatch.upsert([{ agent_email: s.agent_email, location_id: s.location_id || '', key: `agent:${key}`, kind: 'alert', lead_id: '' }], { key: 'key' });
  let job = saved.records[0];
  if (job.state && job.state !== 'new') return { skipped: 'already sent' };
  const token = crypto.randomUUID();
  await E.MessageDispatch.updateMany({ id: job.id, state: { $in: ['new', null, ''] } }, { $set: { state: 'working', token } });
  job = await E.MessageDispatch.get(job.id);
  if (job.token !== token) return { skipped: 'already sent' };
  const claim = { job };
  const finishJob = (_b: any, j: any, result: any, state = 'done') => E.MessageDispatch.update(j.id, { state, result });
  try {
    const body = text.slice(0, 600);
    const sid = await sendRawText(E, s, to, body).catch(() => null);
    if (sid) { await finishJob(base44, claim.job, { sent: true, via: 'twilio' }); return { sent: true }; }
    if (!owner) owner = await ownerRoute(E, s);
    if (owner) {
      // Owner without a texting number of their own: master account, platform alert number.
      const master = masterCred();
      const msg = await tw(master, `${API}/Accounts/${master.sid}/Messages.json`, { To: to, From: owner.from, Body: body });
      await finishJob(base44, claim.job, { sent: !!msg.sid, via: 'twilio_master' });
      return { sent: !!msg.sid };
    }
    if (!s.connected || !s.phone_number) { await finishJob(base44, claim.job, { skipped: 'no texting number yet' }); return { skipped: 'no texting number yet' }; }
    const up = await ghl(s, '/contacts/upsert', 'POST', { locationId: s.location_id, phone: to, firstName: s.first_name || s.display_name || 'Agent', tags: ['respark-agent-alert'] });
    const r = await ghl(s, '/conversations/messages', 'POST', { type: 'SMS', contactId: up.contact?.id, fromNumber: s.phone_number, message: body });
    await finishJob(base44, claim.job, { sent: !!r.messageId, via: 'ghl' });
    return { sent: !!r.messageId };
  } catch (e) {
    await finishJob(base44, claim.job, { error: String((e as Error).message).slice(0, 200) }, 'failed');
    return { failed: (e as Error).message };
  }
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const textToHtml = (t: string) => `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1a1a1a;max-width:560px">${esc(t).replace(/(https:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('')}</div>`;

/**
 * Emails the agent. Goes through the agent's own GHL workspace (no per-email platform credit), and
 * falls back to Base44 email if the workspace isn't connected yet.
 */
export async function emailAgent(base44: any, s: any, subject: string, body: string) {
  // Platform email first: a new agent's own CRM usually has no verified email sender yet, so mail sent
  // through it can silently go nowhere. Fall back to their CRM only if platform email fails.
  const to = agentEmail(s);
  if (!to) return 'skipped:no email';
  try {
    await base44.asServiceRole.integrations.Core.SendEmail({ to, subject: subject.slice(0, 180), body: body.slice(0, 20000), from_name: 'LeadRespark' });
    return 'sent';
  } catch (e) { console.error('[emailAgent] platform email failed, trying CRM', (e as Error).message); }
  if (s.connected && s.location_id) {
    try {
      const up = await ghl(s, '/contacts/upsert', 'POST', { locationId: s.location_id, email: to, firstName: s.first_name || s.display_name || 'Agent', tags: ['respark-agent-alert'] });
      const id = up.contact?.id;
      if (id) { await ghl(s, '/conversations/messages', 'POST', { type: 'Email', contactId: id, subject: subject.slice(0, 180), html: textToHtml(body.slice(0, 20000)) }); return 'sent'; }
    } catch (e) { return `failed:${String((e as Error).message).slice(0, 120)}`; }
  }
  return 'failed:no route';
}


/**
 * Tells the agent a lead replied. Every reply by default, at most one text per lead every 20 minutes,
 * and if more than 12 leads reply within the hour the rest are grouped into one summary text every
 * 30 minutes so a busy day never floods their phone. Respects the agent's reply_alerts choice.
 */
export async function notifyReply(base44: any, s: any, lead: any, body: string, opts: { needsYou?: boolean; origin?: string } = {}) {
  const pref = s.reply_alerts || 'every';
  if (pref === 'off' || (pref === 'needs_you' && !opts.needsYou)) return { skipped: 'preference' };
  if (!agentPhone(s)) return { skipped: 'no agent mobile' };
  const E = base44.asServiceRole.entities;
  const origin = opts.origin || 'https://respark-pipkingroup.com';
  const now = Date.now();
  const hourAgo = new Date(now - 3600000).toISOString();
  const recent = await E.MessageDispatch.count({ agent_email: s.agent_email, kind: 'alert', key: { $regex: '^agent:reply:' }, created_date: { $gte: hourAgo } }).catch(() => 0);
  const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || String(lead.phone || 'A lead');
  if (recent >= 12) {
    const waiting = await E.Lead.count({ agent_email: s.agent_email, status: { $in: ['replied', 'engaged', 'needs_human'] }, last_inbound_at: { $gte: new Date(now - 30 * 60000).toISOString() } }).catch(() => 0);
    return textAgent(base44, s, `LeadRespark: ${waiting || 'Several'} leads replied in the last 30 minutes. Open your inbox: ${origin}/inbox`, `reply-digest:${Math.floor(now / 1800000)}`);
  }
  const snippet = String(body || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  const review = (s.mode || 'review') !== 'autopilot';
  const tail = opts.needsYou ? 'They need you personally.' : review ? 'Your AI drafted a reply for you to approve.' : 'Your AI is handling it.';
  return textAgent(base44, s, `${name} replied: "${snippet}" ${tail} ${origin}/inbox?lead=${lead.id}`, `reply:${lead.id}:${Math.floor(now / 1200000)}`);
}
