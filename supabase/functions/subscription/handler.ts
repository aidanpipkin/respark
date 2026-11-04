// Agent-facing $100/mo subscription: view, check a discount code, subscribe, cancel/resume.
import { rewardReferrals } from '../_shared/referrals.ts';
import { setupContext } from '../_shared/setupAccess.ts';
import { billingAccount, cardSummary } from '../_shared/stripeRest.ts';
import { platformConfig, subscriptionOkFor } from '../_shared/credits.ts';
import { priceCents, findCode, describeCoupon, discounted, subscribe, setCancel, syncSubscription } from '../_shared/subscription.ts';
import { tryActivate } from '../_shared/readiness.ts';
import { failure } from '../_shared/ghl.ts';
import { approveAgent, awaitingApproval } from '../_shared/approval.ts';

const STALE_MS = 5 * 60 * 1000;
const CODE_TRIES_PER_HOUR = 15;

async function codeAttempt(E: any, userId: string) {
  const key = `promo_tries:${userId}`;
  const row = (await E.EngineCursor.filter({ key }, { limit: 1 })).items[0];
  let state = { start: Date.now(), n: 0 };
  try { const p = JSON.parse(row?.cursor || ''); if (Date.now() - p.start < 3600000) state = p; } catch { /* new window */ }
  if (state.n >= CODE_TRIES_PER_HOUR) throw new Error('Too many discount code attempts. Try again in an hour.');
  state.n += 1;
  await E.EngineCursor.upsert([{ key, cursor: JSON.stringify(state) }], { key: 'key' });
}

async function view(E: any, s: any) {
  const config = await platformConfig(E);
  let a = await billingAccount(E, s.agent_email);
  if (a?.subscription_id && (!a.subscription_checked_at || Date.now() - Date.parse(a.subscription_checked_at) > STALE_MS)) {
    try { a = await syncSubscription(E, a); } catch { /* show last known state */ }
  }
  const price = priceCents(config);
  return {
    required: !subscriptionOkFor(config, {}, s.agent_email),
    ok: subscriptionOkFor(config, a, s.agent_email),
    price_cents: price,
    card: cardSummary(a),
    status: a?.subscription_status || 'none',
    amount_cents: Number(a?.subscription_amount_cents) || price,
    discount: a?.subscription_discount || '',
    period_end: a?.subscription_period_end || '',
    cancel_at_period_end: !!a?.subscription_cancel_at_period_end,
  };
}

export default async function (req: Request) {
  try {
    const { base44, E, s, user } = await setupContext(req);
    const input = await req.json().catch(() => ({}));
    const action = String(input.action || 'view');

    if (action === 'preview') {
      await codeAttempt(E, user.id);
      const config = await platformConfig(E);
      const promo = await findCode(input.code);
      if (!promo) return Response.json({ valid: false, message: 'That code is not valid or has expired.' });
      const price = priceCents(config);
      return Response.json({ valid: true, code: promo.code, description: describeCoupon(promo.coupon), first_month_cents: discounted(price, promo.coupon), price_cents: price, duration: promo.coupon.duration, months: promo.coupon.duration_in_months || null });
    }

    if (action === 'subscribe') {
      if (input.confirm !== true) throw new Error('Confirm the monthly subscription first.');
      const code = String(input.code || '').trim();
      if (code) await codeAttempt(E, user.id);
      // The Stripe idempotency key is derived server-side (billing account + previous subscription), never from the client.
      const result = await subscribe(E, s, code);
      if (result.client_secret) return Response.json({ ...(await view(E, s)), client_secret: result.client_secret });
      await tryActivate(E, await E.AgentSettings.get(s.id)).catch(() => {});
      await rewardReferrals(base44, { referee_email: s.agent_email }).catch(() => 0);
      // Paid: when the owner allows it, approve the signup and start building the workspace right away.
      const config = await platformConfig(E);
      if (config.auto_approve_on_payment === true && awaitingApproval(config, s)) await approveAgent(base44, await E.AgentSettings.get(s.id), config, 'payment').catch((e: Error) => console.error('[subscription] auto-approve failed', e.message));
    } else if (action === 'refresh') {
      const a = await billingAccount(E, s.agent_email);
      if (a?.subscription_id) await syncSubscription(E, a);
      await tryActivate(E, await E.AgentSettings.get(s.id)).catch(() => {});
      await rewardReferrals(base44, { referee_email: s.agent_email }).catch(() => 0);
    } else if (action === 'cancel') {
      if (input.confirm !== true) throw new Error('Confirm the cancellation first.');
      await setCancel(E, s, true);
    } else if (action === 'resume') {
      await setCancel(E, s, false);
    }

    return Response.json(await view(E, s), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error as Error); }
}
