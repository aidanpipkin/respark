// Credits page: card, balance, buy credits, auto-recharge settings and history.
import { secrets } from 'base44:runtime';
import { setupContext, configFor } from '../../shared/setupAccess.ts';
import { billingAccount, cardSummary } from '../../shared/stripeRest.ts';
import { chargeCard, priceCents, exempt, MIN_PURCHASE_CENTS, MAX_PURCHASE_CENTS, DEFAULT_RECHARGE_AMOUNT_CENTS, DEFAULT_RECHARGE_THRESHOLD_CENTS } from '../../shared/credits.ts';
import { failure } from '../../shared/ghl.ts';

async function view(E: any, s: any, c: any) {
  const a = await billingAccount(E, s.agent_email);
  const tx = await E.CreditTransaction.filter({ agent_email: s.agent_email }, { sort: '-created_at', limit: 30 });
  const publishable = secrets.get('STRIPE_PUBLISHABLE_KEY') || '';
  const price = priceCents(c);
  const balance = Number(a?.balance_cents) || 0;
  return {
    publishable_key: publishable.startsWith(c.stripe_mode === 'live' ? 'pk_live_' : 'pk_test_') ? publishable : '',
    stripe_mode: c.stripe_mode,
    card: cardSummary(a),
    exempt: exempt(c, s.agent_email),
    price_cents: price,
    balance_cents: balance,
    texts_left: Math.floor(balance / price),
    auto_recharge: !!a?.auto_recharge && !!a?.auto_recharge_consent_at,
    recharge_threshold_cents: Number(a?.recharge_threshold_cents) || Number(c.default_recharge_threshold_cents) || DEFAULT_RECHARGE_THRESHOLD_CENTS,
    recharge_amount_cents: Number(a?.recharge_amount_cents) || Number(c.default_recharge_amount_cents) || DEFAULT_RECHARGE_AMOUNT_CENTS,
    last_recharge_at: a?.last_recharge_at || '',
    last_recharge_error: a?.last_recharge_error || '',
    lifetime_texts: Number(a?.lifetime_texts) || 0,
    transactions: tx.items.map((t: any) => ({ id: t.id, kind: t.kind, amount_cents: t.amount_cents, balance_after_cents: t.balance_after_cents, description: t.description, created_at: t.created_at })),
  };
}

export default async function (req: Request) {
  try {
    const { E, s, user } = await setupContext(req);
    const input = await req.json().catch(() => ({}));
    const c = await configFor(E);

    if (input.action === 'settings') {
      const a = await billingAccount(E, s.agent_email);
      if (!a || a.status !== 'card_saved') throw new Error('Save a card first.');
      const threshold = Number(input.recharge_threshold_cents), amount = Number(input.recharge_amount_cents);
      if (!Number.isInteger(threshold) || threshold < 500 || threshold > 20000) throw new Error('Recharge when the balance falls below $5 to $200.');
      if (!Number.isInteger(amount) || amount < MIN_PURCHASE_CENTS || amount > MAX_PURCHASE_CENTS) throw new Error('Recharge amount must be $10 to $500.');
      const on = input.auto_recharge === true;
      if (on && input.consent !== true) throw new Error('Confirm the auto-recharge authorization first.');
      await E.BillingAccount.update(a.id, { auto_recharge: on, recharge_threshold_cents: threshold, recharge_amount_cents: amount, ...(on ? { auto_recharge_consent_at: new Date().toISOString(), last_recharge_error: '' } : {}) });
    }

    if (input.action === 'buy') {
      if (input.confirm !== true) throw new Error('Confirm the charge first.');
      const amount = Number(input.amount_cents);
      if (!Number.isInteger(amount) || amount < MIN_PURCHASE_CENTS || amount > MAX_PURCHASE_CENTS) throw new Error('Choose an amount between $10 and $500.');
      const nonce = typeof input.nonce === 'string' && /^[\w-]{8,64}$/.test(input.nonce) ? input.nonce : crypto.randomUUID();
      await chargeCard(E, s.agent_email, amount, 'purchase', `buy:${user.id}:${nonce}`);
      const a = await billingAccount(E, s.agent_email);
      if (a?.last_recharge_error) await E.BillingAccount.update(a.id, { last_recharge_error: '' });
    }

    return Response.json(await view(E, s, c), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error as Error); }
}

