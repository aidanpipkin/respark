// $100/month LeadRespark subscription on Stripe, with optional promotion (discount) codes.
import { stripeRest, billingAccount } from './stripeRest.ts';
import { platformConfig } from './credits.ts';

const money = (c: number) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;

export function priceCents(config: any) { return Math.max(100, Number(config.subscription_price_cents) || 10000); }

/** Finds or creates the recurring Stripe price for the current amount (idempotent via lookup_key). */
export async function ensurePrice(E: any, config: any) {
  const cents = priceCents(config);
  const lookup = `leadrespark_monthly_${cents}`;
  if (config.stripe_price_id) {
    try { const p = await stripeRest(`prices/${encodeURIComponent(config.stripe_price_id)}`); if (p.active && p.unit_amount === cents && p.recurring?.interval === 'month') return p.id as string; } catch { /* recreate below */ }
  }
  const found = await stripeRest(`prices?lookup_keys[]=${encodeURIComponent(lookup)}&active=true&limit=1`);
  let price = found.data?.[0];
  if (!price) {
    const product = await stripeRest('products', { name: 'LeadRespark', description: 'LeadRespark agent platform: AI texting, CRM workspace and booking.' }, `product:leadrespark:${cents}`);
    price = await stripeRest('prices', { product: product.id, unit_amount: String(cents), currency: 'usd', 'recurring[interval]': 'month', lookup_key: lookup, nickname: `LeadRespark ${money(cents)}/mo` }, `price:${lookup}`);
  }
  await E.PlatformSettings.update(config.id, { stripe_price_id: price.id });
  return price.id as string;
}

export function describeCoupon(c: any) {
  if (!c) return '';
  const off = c.percent_off ? `${c.percent_off}% off` : c.amount_off ? `${money(c.amount_off)} off` : 'Discount';
  const when = c.duration === 'once' ? 'your first month' : c.duration === 'repeating' ? `for ${c.duration_in_months} months` : 'every month';
  return `${off} ${when}`;
}

export function discounted(cents: number, c: any) {
  if (!c) return cents;
  if (c.percent_off) return Math.max(0, Math.round(cents * (1 - c.percent_off / 100)));
  if (c.amount_off) return Math.max(0, cents - c.amount_off);
  return cents;
}

/** Looks up a customer-facing code. Returns null if it doesn't exist or can't be used. */
export async function findCode(code: string) {
  const clean = String(code || '').trim();
  if (!/^[A-Za-z0-9_-]{2,40}$/.test(clean)) return null;
  const r = await stripeRest(`promotion_codes?code=${encodeURIComponent(clean)}&active=true&limit=1`);
  const promo = r.data?.[0];
  if (!promo || !promo.coupon?.valid) return null;
  if (promo.expires_at && promo.expires_at * 1000 < Date.now()) return null;
  if (promo.max_redemptions && promo.times_redeemed >= promo.max_redemptions) return null;
  return promo;
}

/** Writes Stripe's current subscription state onto the billing account. */
export async function syncSubscription(E: any, a: any, known?: any) {
  if (!a?.subscription_id) return a;
  const sub = known?.items ? known : await stripeRest(`subscriptions/${encodeURIComponent(a.subscription_id)}`);
  const unit = sub.items?.data?.[0]?.price?.unit_amount ?? 10000;
  const coupon = sub.discount?.coupon || null;
  const still = !!coupon && (!sub.discount?.end || sub.discount.end * 1000 > Date.now());
  const patch = {
    subscription_status: sub.status, subscription_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : '',
    subscription_cancel_at_period_end: !!sub.cancel_at_period_end, subscription_amount_cents: still ? discounted(unit, coupon) : unit,
    subscription_discount: still ? describeCoupon(coupon) : '', subscription_checked_at: new Date().toISOString(),
  };
  await E.BillingAccount.update(a.id, patch);
  return { ...a, ...patch };
}

/** Starts the subscription on the saved card. Returns { status, client_secret? } (client_secret when the bank needs approval). */
export async function subscribe(E: any, s: any, code: string, nonce: string) {
  const config = await platformConfig(E);
  let a = await billingAccount(E, s.agent_email);
  if (!a?.stripe_customer_id || !a.payment_method_id || a.status !== 'card_saved') throw new Error('Save your card first.');
  if (a.subscription_id && !['canceled', 'incomplete_expired'].includes(a.subscription_status)) {
    a = await syncSubscription(E, a);
    if (!['canceled', 'incomplete_expired'].includes(a.subscription_status)) return { status: a.subscription_status };
  }
  const promo = code ? await findCode(code) : null;
  if (code && !promo) throw new Error('That discount code is not valid or has expired.');
  const price = await ensurePrice(E, config);
  const sub = await stripeRest('subscriptions', {
    customer: a.stripe_customer_id, 'items[0][price]': price, default_payment_method: a.payment_method_id,
    payment_behavior: 'allow_incomplete', 'expand[0]': 'latest_invoice.payment_intent',
    'metadata[agent_email]': s.agent_email, ...(promo ? { 'discounts[0][promotion_code]': promo.id } : {}),
  }, `subscribe:${a.id}:${nonce}`);
  await E.BillingAccount.update(a.id, { subscription_id: sub.id, subscription_consent_at: new Date().toISOString() });
  a = await syncSubscription(E, { ...a, subscription_id: sub.id });
  const pi = sub.latest_invoice?.payment_intent;
  if (sub.status === 'incomplete' && pi?.status === 'requires_action') return { status: sub.status, client_secret: pi.client_secret };
  if (sub.status === 'incomplete') throw new Error(pi?.last_payment_error?.message ? `Your card was declined: ${pi.last_payment_error.message}` : 'The first payment did not go through. Try another card.');
  return { status: a.subscription_status };
}

export async function setCancel(E: any, s: any, cancel: boolean) {
  const a = await billingAccount(E, s.agent_email);
  if (!a?.subscription_id) throw new Error('No subscription.');
  const sub = await stripeRest(`subscriptions/${encodeURIComponent(a.subscription_id)}`, { cancel_at_period_end: cancel ? 'true' : 'false' }, `cancel:${a.id}:${cancel}:${Date.now()}`);
  return await syncSubscription(E, a, sub);
}
