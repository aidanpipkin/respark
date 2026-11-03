// Scheduled: moves every in-flight A2P registration forward (brand → campaign → approved).
import { adminContext } from '../_shared/agentAccess.ts';
import { heartbeat, raise, resolveStale } from '../_shared/signals.ts';
import { agentSettings, failure } from '../_shared/ghl.ts';
import { advanceRegistration, probePlatform, resubmitCampaign } from '../_shared/a2pEngine.ts';
import { configFor } from '../_shared/setupAccess.ts';
import { textAgent, emailAgent } from '../_shared/agentNotify.ts';
import { APP_ORIGIN } from '../_shared/appointmentJourney.ts';

/** Agents parked on our Twilio ISV setup: recheck, and when it clears, tell each one to finish. */
async function releaseWaiting(base44: any, E: any) {
  const waiting = (await E.A2PRegistration.filter({ provider_step: 'platform_wait' }, { limit: 50 })).items;
  if (!waiting.length) return 0;
  const config = await configFor(E);
  const acct = (await E.TwilioAccount.filter({ agent_email: waiting[0].agent_email }, { limit: 1 })).items[0];
  if (!acct?.subaccount_sid || !config.twilio_primary_profile_sid) return 0;
  if (!(await probePlatform(E, config, acct.subaccount_sid))) return 0;
  let n = 0;
  for (const reg of waiting) {
    await E.A2PRegistration.update(reg.id, { provider_step: 'platform_ready' });
    const s = await agentSettings(base44, reg.agent_email);
    if (!s) continue;
    const link = `${APP_ORIGIN}/setup/texting-registration`;
    await textAgent(base44, s, `LeadRespark: texting registration is open. Your details are saved; re-enter your EIN and tap Submit (30 seconds): ${link}`, `a2p_ready:${reg.id}`, { anyHour: false }).catch(() => {});
    await emailAgent(base44, s, 'Finish your texting registration (30 seconds)', `Hi ${s.first_name || 'there'},\n\nGood news: texting registration is open. Everything you entered is saved. Open the link below, re-enter your EIN (we never store it) and press Submit.\n\n${link}\n\nCarrier approval usually takes 1 to 7 business days after that, and we track it for you.\n\nLeadRespark`);
    n++;
  }
  return n;
}
import { twilioConfigured } from '../_shared/twilio.ts';
import { tryActivate } from '../_shared/readiness.ts';
import { sweepAgentNumbers } from '../_shared/numberOps.ts';
import { notifyRegistration } from '../_shared/a2pNotify.ts';
import { syncPrimary } from '../_shared/numbers.ts';

export default async function (req: Request) {
  try {
    const { base44 } = await adminContext(req);
    if (!twilioConfigured()) return Response.json({ skipped: 'Twilio not connected' });
    const E = base44.asServiceRole.entities;
    const page = await E.A2PRegistration.filter({ status: { $in: ['brand_submitted', 'otp_pending', 'campaign_submitted', 'approved'] } }, { sort: 'last_checked_at', limit: 40 });
    let checked = 0, approved = 0, errors = 0;
    for (const reg of page.items) {
      if (!reg.brand_sid) continue;
      const s = await agentSettings(base44, reg.agent_email);
      if (!s) continue;
      if (reg.status === 'approved' && (!s.phone_number || reg.number_attached === s.phone_number)) continue;
      try { const next = await advanceRegistration(E, s, reg); checked++; await notifyRegistration(base44, s, reg, next).catch((e) => console.error('A2P notice failed', reg.agent_email, (e as Error).message)); if (next.status === 'approved' && reg.status !== 'approved') { approved++; await tryActivate(E, { ...s, a2p_status: 'approved' }).catch(() => false); } }
      catch (e) { errors++; await E.A2PRegistration.update(reg.id, { last_checked_at: new Date().toISOString() }).catch(() => {}); console.error('A2P advance failed', reg.agent_email, (e as Error).message); }
    }
    const released = await releaseWaiting(base44, E).catch((e) => { console.error('A2P platform check failed', (e as Error).message); return 0; });
    // Rejected campaigns an administrator fixed and flagged: resubmit on the approved brand and tell the agent.
    let resubmitted = 0;
    for (const reg of (await E.A2PRegistration.filter({ status: 'rejected', resubmit_requested: true }, { limit: 20 })).items) {
      const s = await agentSettings(base44, reg.agent_email);
      if (!s || !reg.campaign_sid) continue;
      try { const out = await resubmitCampaign(E, s, reg); resubmitted++; await notifyRegistration(base44, s, reg, out.reg).catch((e) => console.error('A2P resubmit notice failed', reg.agent_email, (e as Error).message)); }
      catch (e) { if ((e as Error).name === 'CampaignInReview') { await E.A2PRegistration.update(reg.id, { resubmit_requested: false, status: 'campaign_submitted', provider_step: 'campaign', review_note: (e as Error).message }).catch(() => {}); continue; } errors++; await E.A2PRegistration.update(reg.id, { resubmit_requested: false, review_note: `${reg.review_note || ''} Automatic resubmit failed: ${String((e as Error).message).slice(0, 300)}`.trim() }).catch(() => {}); console.error('A2P resubmit failed', reg.agent_email, (e as Error).message); }
    }
    // Phone numbers: registration, call routing, monthly fees, caller trust and health.
    let numberAgents = 0;
    const started = Date.now();
    // First run after multi-number launch: give every existing number its PhoneNumber record.
    for (const a of (await E.TwilioAccount.filter({ phone_number: { $exists: true, $nin: ['', null] } }, { limit: 500, fields: ['agent_email'] })).items) {
      if ((await E.PhoneNumber.count({ agent_email: a.agent_email })) > 0) continue;
      const s1 = await agentSettings(base44, a.agent_email); if (s1) await syncPrimary(E, s1).catch(() => {});
    }
    const owners = [...new Set((await E.PhoneNumber.filter({ status: { $ne: 'released' } }, { limit: 500, fields: ['agent_email'] })).items.map((r: any) => r.agent_email))];
    if (owners.length) {
      const config = await configFor(E);
      for (const email of owners) {
        if (Date.now() - started > 150000) break;
        const s2 = await agentSettings(base44, String(email)); if (!s2) continue;
        try { await sweepAgentNumbers(E, s2, config); numberAgents++; } catch (e) { console.error('Number sweep failed', email, (e as Error).message); }
      }
    }
    await heartbeat(base44, 'a2p_status', { checked, approved, errors, resubmitted, number_agents: numberAgents });
    // Registrations that could not be advanced this run: the owner should look before carriers time them out.
    if (errors > 0) await raise(base44, { key: 'a2p_advance_errors', kind: 'job_errors', severity: 'warning', notifyOwner: true, title: `${errors} texting registration${errors === 1 ? '' : 's'} could not be advanced`, detail: `The carrier-registration tracker hit ${errors} error${errors === 1 ? '' : 's'} this run (${checked} checked, ${resubmitted} resubmitted). See the function logs for the Twilio messages; the affected agents are retried next run.`, data: { checked, approved, errors, resubmitted } }).catch(() => {});
    else await resolveStale(base44, 'job_errors', []).catch(() => {});
    return Response.json({ checked, approved, errors, released, resubmitted, number_agents: numberAgents });
  } catch (e) { return failure(e as Error); }
}
