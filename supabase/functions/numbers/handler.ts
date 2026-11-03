// An agent's phone numbers: list with health and spam protection, buy another, release,
// make primary, pause new leads, rename, and run a health check now.
import { setupContext, configFor } from '../_shared/setupAccess.ts';
import { agentSettings, failure } from '../_shared/ghl.ts';
import { twilioConfigured } from '../_shared/twilio.ts';
import { subscriptionOkFor, applyCredit, exempt } from '../_shared/credits.ts';
import { billingAccount } from '../_shared/stripeRest.ts';
import { syncPrimary, searchAvailable, buyNumber, releaseNumber, makePrimary, prettyPhone, forgetNumbers, cnamName } from '../_shared/numbers.ts';
import { chargeNumberFee, numberFeeCents, maxNumbers, sweepAgentNumbers } from '../_shared/numberOps.ts';
import { functionUrl } from '../_shared/runtime.ts';
import { callPriceCents } from '../_shared/voice.ts';

export default async function (req: Request) {
  try {
    const ctx = await setupContext(req); let { s } = ctx; const { E, user, base44 } = ctx;
    const input = await req.json().catch(() => ({}));
    if (input.agent_email && input.agent_email !== s.agent_email) { if (user.role !== 'admin') throw new Error('Access denied.'); s = await agentSettings(base44, String(input.agent_email)); if (!s) throw new Error('Agent not found.'); }
    const config = await configFor(E);
    const acct = (await E.TwilioAccount.filter({ agent_email: s.agent_email }, { limit: 1 })).items[0];
    const own = async (id: string) => { const r = await E.PhoneNumber.get(String(id || '')); if (r.agent_email !== s.agent_email || r.status === 'released') throw new Error('Number not found.'); return r; };

    if (input.action === 'list') {
      const rows = (await syncPrimary(E, s)).length ? (await E.PhoneNumber.filter({ agent_email: s.agent_email, status: { $ne: 'released' } }, { sort: 'purchased_at', limit: 50 })).items : [];
      const counts = await Promise.all(rows.map((r: any) => E.Lead.count({ agent_email: s.agent_email, from_number: r.phone_number }).catch(() => 0)));
      const reg = (await E.A2PRegistration.filter({ agent_email: s.agent_email }, { limit: 1 })).items[0];
      // First visit after launch: wire up any number that isn't fully set up yet.
      if (rows.some((r: any) => !r.voice_configured || !r.health_checked_at)) await sweepAgentNumbers(E, s, config).catch(() => {});
      const fresh = rows.length ? (await E.PhoneNumber.filter({ agent_email: s.agent_email, status: { $ne: 'released' } }, { sort: 'purchased_at', limit: 50 })).items : [];
      const a2 = (await E.TwilioAccount.filter({ agent_email: s.agent_email }, { limit: 1 })).items[0] || acct;
      return Response.json({
        numbers: fresh.map((r: any) => ({ ...r, pretty: prettyPhone(r.phone_number), leads: counts[rows.findIndex((x: any) => x.id === r.id)] ?? 0 })),
        trust: a2 ? { shaken: a2.shaken_status || '', vi: a2.vi_status || '', cnam: a2.cnam_status || '', cnam_name: a2.cnam_name || cnamName(s), note: a2.trust_note || '', checked_at: a2.trust_checked_at || '' } : null,
        texting: { status: reg?.status || 'not_started', approved: reg?.status === 'approved' },
        can_buy: !!acct?.subaccount_sid && twilioConfigured(),
        own_texting_number: !!acct?.phone_number,
        fee_cents: numberFeeCents(config), call_cents_per_min: callPriceCents(config), max: maxNumbers(config),
        agent_cell: s.notification_phone || s.alert_mobile || '',
      });
    }

    if (input.action === 'search') {
      const area = String(input.area_code || s.preferred_area_code || '').trim();
      if (!/^[2-9]\d{2}$/.test(area)) throw new Error('Enter a 3-digit US area code.');
      const numbers = await searchAvailable(E, s, area, String(input.contains || '').replace(/\D/g, ''));
      return Response.json({ numbers, message: numbers.length ? '' : 'No numbers available in that area code right now. Try a nearby one.' });
    }

    if (input.action === 'buy') {
      if (!acct?.phone_number) throw new Error('Set up your first texting number before adding more.');
      if (input.confirmed !== true) throw new Error('Confirm the purchase.');
      const phone = String(input.phone_number || '');
      if (!/^\+1[2-9]\d{9}$/.test(phone)) throw new Error('Choose a number from the list.');
      const live = await E.PhoneNumber.count({ agent_email: s.agent_email, status: { $ne: 'released' } });
      if (live >= maxNumbers(config)) throw new Error(`You can have up to ${maxNumbers(config)} numbers.`);
      const billing = await billingAccount(E, s.agent_email);
      if (!subscriptionOkFor(config, billing, s.agent_email)) throw new Error('Your subscription needs to be active to add numbers.');
      const fee = numberFeeCents(config);
      if (!(await chargeNumberFee(E, s, config, fee, phone))) throw new Error(`Adding a number costs $${(fee / 100).toFixed(2)} a month from your credits. Add credits first.`);
      let row;
      try { row = await buyNumber(E, s, phone, acct.webhook_url || functionUrl('twilioWebhook'), { label: String(input.label || '').slice(0, 30), fee: exempt(config, s.agent_email) ? 0 : fee }); }
      catch (e) {
        // Give the month back if the number couldn't be bought.
        if (fee && !exempt(config, s.agent_email)) await applyCredit(E, s.agent_email, fee, { kind: 'adjustment', description: `Refund: ${prettyPhone(phone)} could not be reserved` }).catch(() => {});
        throw e;
      }
      await E.ControlAudit.create({ agent_email: s.agent_email, location_id: s.location_id || '', actor_email: user.email, action: 'number_purchased', details: { phone: row.phone_number, fee_cents: fee }, occurred_at: new Date().toISOString() }).catch(() => {});
      await sweepAgentNumbers(E, s, config, { force: true }).catch(() => {});
      return Response.json({ number: { ...row, pretty: prettyPhone(row.phone_number) } });
    }

    if (input.action === 'release') {
      const row = await own(input.id);
      if (input.confirmed !== true) throw new Error('Confirm releasing this number.');
      if (row.is_primary) throw new Error('Make another number your main number before releasing this one.');
      await releaseNumber(E, s, row);
      await E.ControlAudit.create({ agent_email: s.agent_email, location_id: s.location_id || '', actor_email: user.email, action: 'number_released', details: { phone: row.phone_number }, occurred_at: new Date().toISOString() }).catch(() => {});
      return Response.json({ ok: true });
    }

    if (input.action === 'primary') { const row = await own(input.id); if (row.status !== 'active') throw new Error('Only an active number can be your main number.'); if (!row.in_messaging_service) throw new Error('This number is still being registered for texting.'); await makePrimary(E, s, row); return Response.json({ ok: true }); }
    if (input.action === 'pause' || input.action === 'resume') {
      const row = await own(input.id);
      if (row.status === 'unpaid') throw new Error('Add credits; the number turns back on at the next check.');
      if (input.action === 'pause' && row.is_primary) throw new Error('Your main number cannot be paused.');
      await E.PhoneNumber.update(row.id, { status: input.action === 'pause' ? 'paused' : 'active' }); forgetNumbers(s.agent_email);
      return Response.json({ ok: true });
    }
    if (input.action === 'label') { const row = await own(input.id); await E.PhoneNumber.update(row.id, { label: String(input.label || '').trim().slice(0, 30) }); return Response.json({ ok: true }); }
    if (input.action === 'check') { const out = await sweepAgentNumbers(E, s, config, { force: true }); return Response.json({ ok: true, ...out }); }
    if (input.action === 'set_cell') {
      const d = String(input.phone || '').replace(/\D/g, ''); const cell = d.length === 10 ? `+1${d}` : d.length === 11 && d[0] === '1' ? `+${d}` : '';
      if (!cell) throw new Error('Enter your 10-digit cell number.');
      await E.AgentSettings.update(s.id, { notification_phone: cell }); return Response.json({ ok: true, cell });
    }
    throw new Error('Unknown action.');
  } catch (e) { return failure(e as Error); }
}
