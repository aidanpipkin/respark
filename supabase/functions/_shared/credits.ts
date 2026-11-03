// Text credit wallet. Agents prepay credits through Stripe; every outbound text
// uses credits by SMS segment; auto-recharge tops the wallet up from the saved card.
import { stripeRest, billingAccount } from './stripeRest.ts';
import { isRehearsal } from './rehearsal.ts';

export const MIN_PURCHASE_CENTS = 1000;
export const MAX_PURCHASE_CENTS = 50000;
// Auto-recharge defaults for agents who never chose their own: add $100 whenever the balance falls under $25.
// Values an agent already saved on their BillingAccount always win.
export const DEFAULT_RECHARGE_AMOUNT_CENTS = 10000;
export const DEFAULT_RECHARGE_THRESHOLD_CENTS = 2500;

export class OutOfCredits extends Error {
  constructor(message = 'Out of text credits. Add credits on the Credits page to keep texts going out.') { super(message); this.name = 'OutOfCredits'; }
}

const GSM = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXT = '^{}\\[~]|€';

/** Number of SMS segments carriers bill for this text. */
export function segments(text: string) {
  const chars = [...String(text || '')];
  const gsm = chars.every(c => GSM.includes(c) || GSM_EXT.includes(c));
  if (gsm) {
    const len = chars.reduce((n, c) => n + (GSM_EXT.includes(c) ? 2 : 1), 0);
    return Math.max(1, len <= 160 ? 1 : Math.ceil(len / 153));
  }
  const len = chars.length;
  return Math.max(1, len <= 70 ? 1 : Math.ceil(len / 67));
}

export async function platformConfig(E: any) {
  return (await E.PlatformSettings.filter({ singleton_key: 'platform' }, { limit: 1 })).items[0] || {};
}

export function priceCents(config: any) { return Math.max(1, Number(config.text_price_cents) || 3); }

export function exempt(config: any, email: string) {
  if (config.credits_enforced === false) return true;
  return (config.credits_exempt_emails || []).map((e: string) => e.toLowerCase()).includes(String(email || '').toLowerCase());
}

// past_due keeps texting on while Stripe retries the card; the daily sync turns it off once Stripe gives up.
export const SUBSCRIPTION_ACTIVE = ['active', 'trialing', 'past_due'];
export const NO_SUBSCRIPTION = 'Your LeadRespark subscription is not active. Start or update it on the Billing page to keep texting.';

function listedExempt(config: any, email: string) {
  return (config.credits_exempt_emails || []).map((e: string) => e.toLowerCase()).includes(String(email || '').toLowerCase());
}

/** True when the $100/mo subscription is not required for this agent, or it is active. */
export function subscriptionOkFor(config: any, account: any, email: string) {
  if (config.subscription_required === false || listedExempt(config, email)) return true;
  return SUBSCRIPTION_ACTIVE.includes(account?.subscription_status);
}

/** Adds (positive) or removes (negative) credit atomically and records it. */
export async function applyCredit(E: any, email: string, delta: number, entry: Record<string, any>) {
  const a = await billingAccount(E, email);
  if (!a) throw new Error('No billing account.');
  await E.BillingAccount.updateMany({ id: a.id }, { $inc: { balance_cents: delta } });
  const fresh = await billingAccount(E, email);
  const balance = Number(fresh?.balance_cents) || 0;
  await E.CreditTransaction.create({ agent_email: email, amount_cents: delta, balance_after_cents: balance, created_at: new Date().toISOString(), ...entry });
  return balance;
}

/** Atomically takes `cost` from the balance only if it is covered. Returns true when taken. */
async function takeIfCovered(E: any, accountId: string, cost: number) {
  const r = await E.BillingAccount.updateMany({ id: accountId, balance_cents: { $gte: cost } }, { $inc: { balance_cents: -cost } });
  return Number(r?.updated ?? r?.modified ?? r?.count ?? 0) > 0;
}

/** Charges the saved card and adds the amount as credits. Throws a readable error on decline. */
export async function chargeCard(E: any, email: string, cents: number, kind: 'purchase' | 'auto_recharge', key: string) {
  if (!Number.isInteger(cents) || cents < MIN_PURCHASE_CENTS || cents > MAX_PURCHASE_CENTS) throw new Error('Choose an amount between $10 and $500.');
  const a = await billingAccount(E, email);
  if (!a?.stripe_customer_id || !a.payment_method_id || a.status !== 'card_saved') throw new Error('Save a card first.');
  let intent: any;
  try {
    intent = await stripeRest('payment_intents', {
      amount: String(cents), currency: 'usd', customer: a.stripe_customer_id, payment_method: a.payment_method_id,
      off_session: 'true', confirm: 'true',
      description: kind === 'auto_recharge' ? 'LeadRespark text credits (auto-recharge)' : 'LeadRespark text credits',
      'metadata[agent_email]': email, 'metadata[kind]': kind,
    }, key);
  } catch (error) {
    const msg = String((error as Error).message || '');
    throw new Error(/authentication|action/i.test(msg) ? 'Your bank needs you to approve this charge. Use "Add credits" on the Credits page to approve it.' : `Card charge failed: ${msg}`);
  }
  if (intent.status !== 'succeeded') throw new Error('The card charge did not complete. Try again or use another card.');
  // Idempotent: one credit entry per payment.
  const existing = await E.CreditTransaction.filter({ stripe_payment_intent_id: intent.id }, { limit: 1 });
  if (existing.items[0]) return existing.items[0].balance_after_cents;
  const balance = await applyCredit(E, email, cents, { kind, stripe_payment_intent_id: intent.id, description: kind === 'auto_recharge' ? `Auto-recharge $${(cents / 100).toFixed(2)}` : `Added $${(cents / 100).toFixed(2)} in credits` });
  if (kind === 'auto_recharge') await E.BillingAccount.update(a.id, { last_recharge_at: new Date().toISOString(), last_recharge_error: '' });
  return balance;
}

/** Tops up the wallet if auto-recharge is on and the balance is below the threshold (or below `need`). */
export async function maybeRecharge(E: any, email: string, need = 0) {
  let a = await billingAccount(E, email);
  if (!a?.auto_recharge || !a.auto_recharge_consent_at || a.status !== 'card_saved') return false;
  const threshold = Number(a.recharge_threshold_cents) || DEFAULT_RECHARGE_THRESHOLD_CENTS;
  if ((Number(a.balance_cents) || 0) >= Math.max(threshold, need)) return false;
  // One recharge at a time per agent.
  const token = crypto.randomUUID(), now = new Date().toISOString();
  await E.BillingAccount.updateMany({ id: a.id, $or: [{ recharge_lock_until: { $exists: false } }, { recharge_lock_until: '' }, { recharge_lock_until: null }, { recharge_lock_until: { $lte: now } }] }, { $set: { recharge_lock_token: token, recharge_lock_until: new Date(Date.now() + 90000).toISOString() } });
  a = await billingAccount(E, email);
  if (a.recharge_lock_token !== token) return false;
  try {
    if ((Number(a.balance_cents) || 0) >= Math.max(threshold, need)) return false;
    const amount = Math.max(Number(a.recharge_amount_cents) || DEFAULT_RECHARGE_AMOUNT_CENTS, need - (Number(a.balance_cents) || 0));
    await chargeCard(E, email, Math.min(Math.max(amount, MIN_PURCHASE_CENTS), MAX_PURCHASE_CENTS), 'auto_recharge', `auto:${a.id}:${token}`);
    return true;
  } catch (error) {
    await E.BillingAccount.update(a.id, { last_recharge_error: String((error as Error).message).slice(0, 300) });
    return false;
  } finally {
    await E.BillingAccount.updateMany({ id: a.id, recharge_lock_token: token }, { $set: { recharge_lock_token: '', recharge_lock_until: '' } });
  }
}

export type Reservation = { cost: number; segments: number; account_id: string } | null;

/** Platform config and the agent's BillingAccount, loaded once by a caller that sends many texts. */
export type BillingContext = { config?: any; account?: any };

/** Loads what reserveText/canSend need, once, so a worker can pass it to every send. */
export async function billingContext(E: any, email: string): Promise<BillingContext> {
  const [config, account] = await Promise.all([platformConfig(E), billingAccount(E, email)]);
  return { config, account };
}

/**
 * Call before sending. Takes the cost from the balance atomically (recharging first if needed),
 * so parallel sends can never overspend. Pair with debitText (sent) or refundText (not sent).
 * Returns null when the agent is exempt.
 */
export async function reserveText(E: any, email: string, text: string, pre: BillingContext = {}): Promise<Reservation> {
  if (isRehearsal(email)) return null;
  const config = pre.config || await platformConfig(E);
  let a = pre.account || await billingAccount(E, email);
  if (!subscriptionOkFor(config, a, email)) throw new OutOfCredits(NO_SUBSCRIPTION);
  if (exempt(config, email)) return null;
  const segs = segments(text), cost = segs * priceCents(config);
  if (!a || a.status !== 'card_saved') throw new OutOfCredits('Add a card and text credits on the Credits page before texts can go out.');
  if (await takeIfCovered(E, a.id, cost)) return { cost, segments: segs, account_id: a.id };
  await maybeRecharge(E, email, cost);
  if (await takeIfCovered(E, a.id, cost)) return { cost, segments: segs, account_id: a.id };
  a = await billingAccount(E, email);
  throw new OutOfCredits(a?.last_recharge_error ? `Out of text credits. Auto-recharge failed: ${a.last_recharge_error}` : undefined);
}

/** Gives back a reservation for a text that was not sent. */
export async function refundText(E: any, reserved: Reservation) {
  if (!reserved) return;
  await E.BillingAccount.updateMany({ id: reserved.account_id }, { $inc: { balance_cents: reserved.cost } });
}

/** True when the agent can pay for at least one text right now (recharging if allowed). Takes nothing. */
export async function canSend(E: any, email: string, pre: BillingContext = {}) {
  if (isRehearsal(email)) return true;
  const config = pre.config || await platformConfig(E);
  let a = pre.account || await billingAccount(E, email);
  if (!subscriptionOkFor(config, a, email)) return false;
  if (exempt(config, email)) return true;
  const price = priceCents(config);
  if (!a || a.status !== 'card_saved') return false;
  if ((Number(a.balance_cents) || 0) >= price) return true;
  await maybeRecharge(E, email, price);
  a = await billingAccount(E, email);
  return (Number(a?.balance_cents) || 0) >= price;
}

/** Call after a text is accepted by the carrier: records the usage (the balance was already taken). */
export async function debitText(E: any, email: string, reserved: Reservation, ref: { lead_id?: string; dispatch_id?: string }) {
  if (!reserved) return;
  await E.BillingAccount.updateMany({ id: reserved.account_id }, { $inc: { lifetime_texts: reserved.segments } });
  const fresh = await billingAccount(E, email);
  await E.CreditTransaction.create({ agent_email: email, kind: 'text_usage', amount_cents: -reserved.cost, balance_after_cents: Number(fresh?.balance_cents) || 0, segments: reserved.segments, description: `Text sent (${reserved.segments} segment${reserved.segments > 1 ? 's' : ''})`, created_at: new Date().toISOString(), ...ref });
  await maybeRecharge(E, email);
}
