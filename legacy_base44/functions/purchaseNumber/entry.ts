import { setupContext, configFor, setupLog } from '../../shared/setupAccess.ts';
import { billingAccount } from '../../shared/stripeRest.ts';
import { subscriptionOkFor } from '../../shared/credits.ts';
import { failure } from '../../shared/ghl.ts';
import { twilioConfigured, ensureSubaccount, subCred, tw, API } from '../../shared/twilio.ts';
import { advanceRegistration } from '../../shared/a2pEngine.ts';
import { appOrigin } from '../../shared/agentSite.ts';
import { buyNumber } from '../../shared/numbers.ts';

export default async function (req: Request) {
  try {
    const { E, s } = await setupContext(req);
    const input = await req.json();
    if (input.confirmed !== true) throw new Error('Confirm your number request.');
    const phone = String(input.phone_number || '');
    const area = String(input.area_code || s.preferred_area_code || '');
    if (phone && !/^\+1[2-9]\d{9}$/.test(phone)) throw new Error('Choose a valid US number.');
    if (!/^[2-9]\d{2}$/.test(area)) throw new Error('Enter a valid area code.');
    if (s.phone_number) throw new Error('You already have a texting number.');
    const billing = await billingAccount(E, s.agent_email);
    if (billing?.status !== 'card_saved') throw new Error('Save your billing card first.');
    const c = await configFor(E);
    if (!subscriptionOkFor(c, billing, s.agent_email)) throw new Error('Start your LeadRespark subscription on the Billing page before choosing a number.');
    if (c.phone_number_setup_fee_cents !== 0) throw new Error('Paid number setup is not enabled; contact your administrator.');

    if (c.a2p_provider === 'twilio' && twilioConfigured()) {
      if (!phone) throw new Error('Choose a number from the list.');
      const key = `number:${s.agent_email}`;
      const lock = await E.ProvisioningTask.filter({ key }, { limit: 1 });
      if (lock.items[0]?.status === 'working' && Date.now() - Date.parse(lock.items[0].updated_date || 0) < 120000) throw new Error('Your number is already being set up.');
      await E.ProvisioningTask.upsert([{ key, agent_email: s.agent_email, kind: 'phone_number', requested_number: phone, status: 'working', public_note: 'Setting up your number…' }], { key: 'key' });
      try {
        const webhook = `${appOrigin(req)}/functions/twilioWebhook`;
        await ensureSubaccount(E, s);
        const acct0 = (await E.TwilioAccount.filter({ agent_email: s.agent_email }, { limit: 1 })).items[0];
        if (acct0 && !acct0.webhook_url) await E.TwilioAccount.update(acct0.id, { webhook_url: webhook });
        const row = await buyNumber(E, s, phone, acct0?.webhook_url || webhook, { label: 'Main', primary: true });
        const bought = { phone_number: row.phone_number, sid: row.phone_sid };
        const acct = (await E.TwilioAccount.filter({ agent_email: s.agent_email }, { limit: 1 })).items[0];
        if (acct) await E.TwilioAccount.update(acct.id, { phone_number: bought.phone_number, phone_sid: bought.sid, webhook_url: acct.webhook_url || webhook });
        await E.AgentSettings.update(s.id, { phone_number: bought.phone_number, preferred_area_code: area });
        await E.ProvisioningTask.upsert([{ key, agent_email: s.agent_email, kind: 'phone_number', requested_number: phone, status: 'done', public_note: `Your number ${bought.phone_number} is ready. It is linked to your workspace automatically.` }], { key: 'key' });
        await setupLog(E, s, 'number_purchased', `Purchased ${bought.phone_number} in the agent's Twilio subaccount.`);
        const reg = (await E.A2PRegistration.filter({ agent_email: s.agent_email }, { limit: 1 })).items[0];
        if (reg?.messaging_service_sid) await advanceRegistration(E, { ...s, phone_number: bought.phone_number }, reg).catch(() => {});
        return Response.json({ status: 'done', phone_number: bought.phone_number, charged_cents: 0 });
      } catch (error) {
        await E.ProvisioningTask.upsert([{ key, agent_email: s.agent_email, kind: 'phone_number', requested_number: phone, status: 'queued', public_note: 'That number could not be reserved. Pick another one or try again.' }], { key: 'key' });
        throw error;
      }
    }

    const key = `number:${s.agent_email}`;
    const existing = await E.ProvisioningTask.filter({ key }, { limit: 1 });
    if (existing.items[0] && ['queued', 'working', 'done'].includes(existing.items[0].status)) return Response.json({ task_id: existing.items[0].id, status: existing.items[0].status, charged_cents: 0 });
    const result = await E.ProvisioningTask.upsert([{ key, agent_email: s.agent_email, kind: 'phone_number', requested_number: phone, status: 'queued', public_note: `Number requested in area code ${area}. Your administrator will confirm availability. No beta setup fee.` }], { key: 'key' });
    await E.AgentSettings.update(s.id, { preferred_area_code: area });
    await setupLog(E, s, 'number_request', 'Queued number provisioning; no charge created.');
    return Response.json({ task_id: result.records[0].id, status: 'queued', charged_cents: 0 });
  } catch (e) { return failure(e as Error); }
}
