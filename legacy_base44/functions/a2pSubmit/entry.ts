// Agent submits their A2P registration. With Twilio connected, it is registered with the
// carriers immediately; otherwise it is queued for the administrator.
import { setupContext, configFor, checklist, setupLog } from '../../shared/setupAccess.ts';
import { registrationInput, validateRegistration, cleanEin } from '../../shared/a2pRegistration.ts';
import { submitToTwilio, resubmitCampaign, PlatformNotReady, platformState, markPlatform } from '../../shared/a2pEngine.ts';
import { notifyRegistration } from '../../shared/a2pNotify.ts';

/** Tells the platform owner once a day what to ask Twilio for. */
async function notifyOwner(base44: any, E: any, c: any, s: any) {
  const to = c.twilio_isv_email || c.owner_email;
  if (!to) return;
  const key = `a2p_isv_notice:${new Date().toISOString().slice(0, 10)}`;
  const row = (await E.EngineCursor.upsert([{ key }], { key: 'key' })).records[0];
  if (row.cursor) return;
  await E.EngineCursor.update(row.id, { cursor: 'sent' });
  await base44.asServiceRole.integrations.Core.SendEmail({ to, subject: 'LeadRespark: agents waiting on your Twilio ISV setup', body: `${s.agent_email} finished texting registration, but Twilio won't let agent subaccounts use the platform's Primary Customer Profile (${c.twilio_primary_profile_sid}) yet (errors 22216/22217).\n\nFix: open a Twilio Support ticket asking them to change that Primary Customer Profile's classification from "Direct Customer" to "ISV/Reseller".\n\nLeadRespark rechecks every 30 minutes. As soon as Twilio fixes it, every waiting agent is texted and emailed to finish (they re-enter their EIN and press Submit).` }).catch(() => {});
}
import { twilioConfigured } from '../../shared/twilio.ts';
import { failure } from '../../shared/ghl.ts';
import { completeRegistration, PROGRAM_FIELDS } from '../../shared/a2pProgram.ts';
import { billingAccount } from '../../shared/stripeRest.ts';
import { subscriptionOkFor } from '../../shared/credits.ts';

const LOCKED = ['queued', 'brand_submitted', 'otp_pending', 'campaign_submitted', 'approved'];

export default async function (req: Request) {
  try {
    const { base44, E, s } = await setupContext(req);
    const input = await req.json();
    const data = await completeRegistration(req, E, s, registrationInput(input));
    const existing = (await E.A2PRegistration.filter({ agent_email: s.agent_email }, { limit: 1 })).items[0];
    if (existing && LOCKED.includes(existing.status)) throw new Error('Your registration is already in review or approved.');

    // The carriers sent the campaign back but the brand is approved: fix the program wording on the same
    // brand. No EIN, no new brand, no second brand fee.
    if (input.draft !== true && existing?.status === 'rejected' && existing.provider_step === 'campaign' && existing.brand_sid && existing.campaign_sid && existing.messaging_service_sid) {
      const errors = validateRegistration({ ...existing, ...data });
      if (errors.length) return Response.json({ error: errors.join(' ') }, { status: 400 });
      const program = Object.fromEntries([...PROGRAM_FIELDS, 'website', 'privacy_url', 'terms_url', 'first_name', 'last_name', 'attested'].map((k) => [k, data[k]]));
      const reg = await E.A2PRegistration.update(existing.id, program);
      let out;
      try { out = await resubmitCampaign(E, s, reg); }
      catch (error) {
        const message = String((error as Error).message || 'The campaign could not be resubmitted.').slice(0, 1500);
        await setupLog(E, s, 'a2p_error', `Campaign resubmit failed: ${message.slice(0, 300)}`, 400);
        return Response.json({ error: message }, { status: 400 });
      }
      await notifyRegistration(base44, s, existing, out.reg).catch(() => null);
      await setupLog(E, s, 'a2p_campaign', `A2P campaign resubmitted to the carriers (${out.how}).`);
      return Response.json({ status: out.reg.status, review_note: out.reg.review_note, resubmitted: true });
    }

    if (input.draft === true) {
      const saved = await E.A2PRegistration.upsert([{ ...data, agent_email: s.agent_email, status: 'draft' }], { key: 'agent_email' });
      return Response.json({ id: saved.records[0].id, status: 'draft' });
    }

    {
      const c = await configFor(E);
      if (!subscriptionOkFor(c, await billingAccount(E, s.agent_email), s.agent_email)) {
        await E.A2PRegistration.upsert([{ ...data, agent_email: s.agent_email, status: 'draft' }], { key: 'agent_email' });
        throw new Error('Start your LeadRespark subscription on the Billing page before submitting your registration. Your answers are saved as a draft.');
      }
    }
    const sole = data.business_type === 'sole_proprietor';
    const errors = validateRegistration(data, sole ? {} : { ein: input.ein ?? '' });
    if (errors.length) return Response.json({ error: errors.join(' ') }, { status: 400 });
    const ein = sole ? '' : cleanEin(input.ein);
    const c = await configFor(E);

    if (c.a2p_provider !== 'twilio' || !twilioConfigured()) {
      if (!s.phone_number) throw new Error('Your texting number must be assigned first.');
      const saved = await E.A2PRegistration.upsert([{ ...data, ein_last4: ein.slice(-4), agent_email: s.agent_email, status: 'queued', submitted_at: new Date().toISOString(), review_note: '' }], { key: 'agent_email' });
      await E.ProvisioningTask.upsert([{ key: `a2p:${s.agent_email}`, agent_email: s.agent_email, kind: 'a2p', registration_id: saved.records[0].id, status: 'queued', public_note: 'Your registration is waiting for administrator submission.' }], { key: 'key' });
      await setupLog(E, s, 'a2p_packet', 'Agent submitted registration for administrator review.');
      return Response.json({ status: 'queued' });
    }

    // Platform-side blocker (our Twilio ISV setup): park the agent in a calm "waiting" state instead of
    // erroring. Everything except the EIN is saved; they're texted and emailed when they can finish.
    const wait = async () => {
      await E.A2PRegistration.upsert([{ ...data, ein_last4: ein.slice(-4), agent_email: s.agent_email, status: 'draft', provider_step: 'platform_wait', review_note: '' }], { key: 'agent_email' });
      await markPlatform(E, false);
      await notifyOwner(base44, E, c, s);
      await setupLog(E, s, 'a2p_wait', 'Registration saved; waiting on platform Twilio ISV setup.');
      return Response.json({ status: 'waiting_platform' });
    };
    const platform = await platformState(E);
    if (platform.ready === false && Date.now() - Date.parse(platform.at || '0') < 30 * 60000) return await wait();

    // A previous attempt died mid-way (timeout) if it is still marked "Submitting…": the bundle SIDs it saved
    // are kept by the upsert below and submitToTwilio resumes from them instead of creating duplicates.
    const resume = existing?.provider_step === 'profile' && /^Submitting/i.test(String(existing.review_note || ''));
    if (resume) await setupLog(E, s, 'a2p_resume', `Resuming an interrupted carrier submission (profile ${existing.customer_profile_sid || 'none'}, trust ${existing.trust_product_sid || 'none'}, brand ${existing.brand_sid || 'none'}).`);
    const saved = await E.A2PRegistration.upsert([{ ...data, ein_last4: ein.slice(-4), agent_email: s.agent_email, status: 'draft', provider_step: 'profile', review_note: 'Submitting to the carriers…' }], { key: 'agent_email' });
    let reg = saved.records[0];
    try {
      reg = await submitToTwilio(E, s, c, reg, ein);
    } catch (error) {
      if (error instanceof PlatformNotReady) return await wait();
      const message = String((error as Error).message || 'Registration could not be submitted.').slice(0, 1500);
      await E.A2PRegistration.update(reg.id, { status: 'draft', review_note: message, provider_step: 'profile' });
      await setupLog(E, s, 'a2p_error', `Twilio registration failed: ${message.slice(0, 300)}`, 400);
      return Response.json({ error: message }, { status: 400 });
    }
    await markPlatform(E, true);
    await E.AgentSettings.update(s.id, { a2p_status: 'brand_submitted' });
    await checklist(E, s, 'texting', false);
    await setupLog(E, s, 'a2p_brand', `A2P ${reg.business_type === 'sole_proprietor' ? 'Sole Proprietor' : 'Standard'} brand submitted to Twilio.`);
    return Response.json({ status: reg.status, review_note: reg.review_note });
  } catch (e) { return failure(e as Error); }
}
