// Upkeep for an agent's numbers: monthly fees, texting registration, caller trust and health.
import { subCred } from './twilio.ts';
import { billingAccount } from './stripeRest.ts';
import { applyCredit, maybeRecharge, exempt } from './credits.ts';
import { raise, resolve } from './signals.ts';
import { attachToService, configureNumber, advanceCallerTrust, renewNumbers, numberHealth, prettyPhone, forgetNumbers } from './numbers.ts';

export function numberFeeCents(config: any) { const v = Number(config.extra_number_monthly_cents); return Number.isFinite(v) && v >= 0 ? v : 300; }
export function maxNumbers(config: any) { return Math.max(1, Number(config.max_numbers_per_agent) || 10); }

/** Takes one month of an extra number's fee from the agent's credits. False when it can't be covered. */
export async function chargeNumberFee(E: any, s: any, config: any, cents: number, phone: string) {
  if (!cents || exempt(config, s.agent_email)) return true;
  let a = await billingAccount(E, s.agent_email);
  if ((Number(a?.balance_cents) || 0) < cents) { await maybeRecharge(E, s.agent_email, cents).catch(() => false); a = await billingAccount(E, s.agent_email); }
  if (!a || (Number(a.balance_cents) || 0) < cents) return false;
  await applyCredit(E, s.agent_email, -cents, { kind: 'number_fee', description: `Phone number ${prettyPhone(phone)} · 30 days` });
  return true;
}

/** Everything that keeps one agent's numbers in good standing. Each part fails independently. */
export async function sweepAgentNumbers(E: any, s: any, config: any, opts: { force?: boolean } = {}) {
  const out: any = {};
  const rows = (await E.PhoneNumber.filter({ agent_email: s.agent_email, status: { $ne: 'released' } }, { limit: 50 })).items;
  if (!rows.length) return out;
  const acct = (await E.TwilioAccount.filter({ agent_email: s.agent_email }, { limit: 1 })).items[0];
  const reg = (await E.A2PRegistration.filter({ agent_email: s.agent_email }, { limit: 1 })).items[0];
  let cred: any = null;
  const getCred = async () => (cred ||= await subCred(acct.subaccount_sid));

  // Texting registration + call routing for any number that isn't fully wired.
  for (const r of rows) {
    try {
      if (reg?.messaging_service_sid && !r.in_messaging_service && r.phone_sid) { await attachToService(await getCred(), reg.messaging_service_sid, r.phone_sid); await E.PhoneNumber.update(r.id, { in_messaging_service: true, last_error: '' }); r.in_messaging_service = true; }
      if (!r.voice_configured && r.phone_sid && acct?.webhook_url) { await configureNumber(await getCred(), r.phone_sid, acct.webhook_url); await E.PhoneNumber.update(r.id, { voice_configured: true }); }
    } catch (e: any) { await E.PhoneNumber.update(r.id, { last_error: String(e.message).slice(0, 200) }).catch(() => {}); }
  }
  forgetNumbers(s.agent_email);

  out.fees = await renewNumbers(E, s, (r: any) => chargeNumberFee(E, s, config, r.monthly_fee_cents, r.phone_number)).catch((e: any) => ({ error: e.message }));

  const stale = (iso: string, hours: number) => !iso || Date.now() - Date.parse(iso) > hours * 3600000;
  const trustPending = ['shaken', 'cnam', 'vi'].some(k => !['twilio-approved', 'not-available'].includes(acct?.[`${k}_status`] || ''));
  const unassigned = rows.some((r: any) => r.status !== 'released' && (!r.profile_assigned || !r.shaken_assigned || !r.vi_assigned));
  if (acct && (opts.force || ((trustPending || unassigned) && stale(acct.trust_checked_at, 1)) || stale(acct.trust_checked_at, 24))) {
    out.trust = await advanceCallerTrust(E, s, config).catch((e: any) => ({ error: e.message }));
  }

  const freshAcct = (await E.TwilioAccount.filter({ agent_email: s.agent_email }, { limit: 1 })).items[0] || acct;
  const b44 = { asServiceRole: { entities: E } };
  for (const r of rows) {
    if (!(opts.force || stale(r.health_checked_at, 3))) continue;
    const h: any = await numberHealth(E, s, r, freshAcct).catch(() => null);
    if (!h) continue;
    const key = `number_risk:${r.id}`;
    if (h.grade === 'at_risk' && r.status !== 'released') {
      const top = (h.issues || []).find((i: any) => i.level === 'bad') || h.issues?.[0];
      await raise(b44, { key, kind: 'number_at_risk', severity: 'warning', agent_email: s.agent_email, agent_visible: true, title: `Your number ${prettyPhone(r.phone_number)} needs attention`, detail: top?.text || `Health score ${h.score}.`, action_label: 'Open phone numbers', action_href: '/numbers', data: { score: h.score } }).catch(() => {});
    } else await resolve(b44, key).catch(() => {});
  }
  return out;
}
