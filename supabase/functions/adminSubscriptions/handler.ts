// Admin: discount codes (Stripe coupons + promotion codes), subscription overview and the daily sync.
import { rewardReferrals } from '../_shared/referrals.ts';
import { heartbeat } from '../_shared/signals.ts';
import { adminContext } from '../_shared/agentAccess.ts';
import { stripeRest } from '../_shared/stripeRest.ts';
import { platformConfig } from '../_shared/credits.ts';
import { describeCoupon, syncSubscription, ensurePrice } from '../_shared/subscription.ts';
import { failure } from '../_shared/ghl.ts';

const LIVE = ['active', 'trialing', 'past_due', 'incomplete', 'unpaid'];

function codeView(p: any) {
  return {
    id: p.id, code: p.code, active: !!p.active && !!p.coupon?.valid, description: describeCoupon(p.coupon),
    times_redeemed: p.times_redeemed || 0, max_redemptions: p.max_redemptions || null,
    expires_at: p.expires_at ? new Date(p.expires_at * 1000).toISOString() : '', created: new Date(p.created * 1000).toISOString(),
  };
}

async function syncAll(E: any) {
  const deadline = Date.now() + 50000;
  let cursor: string | undefined, checked = 0, failed = 0;
  do {
    const page = await E.BillingAccount.filter({ subscription_status: { $in: LIVE } }, { sort: 'subscription_checked_at', limit: 25, cursor });
    const results = await Promise.allSettled(page.items.filter((a: any) => a.subscription_id).map((a: any) => syncSubscription(E, a)));
    checked += results.length; failed += results.filter(r => r.status === 'rejected').length;
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor && Date.now() < deadline);
  const summary = { at: new Date().toISOString(), checked, failed };
  await E.EngineCursor.upsert([{ key: 'subscription_sync', cursor: JSON.stringify(summary) }], { key: 'key' });
  return summary;
}

export default async function (req: Request) {
  try {
    const { base44 } = await adminContext(req);
    const E = base44.asServiceRole.entities;
    const input = await req.json().catch(() => ({}));
    const action = String(input.action || 'overview');

    if (action === 'sync') { const out: any = await syncAll(E); out.referrals_paid = await rewardReferrals(base44).catch(() => 0); await heartbeat(base44, 'subscription_sync', out); return Response.json(out); }

    if (action === 'create_code') {
      const code = String(input.code || '').trim().toUpperCase();
      if (!/^[A-Z0-9_-]{3,30}$/.test(code)) throw new Error('Use 3–30 letters, numbers, dashes or underscores for the code.');
      const kind = input.kind === 'amount' ? 'amount' : 'percent';
      const value = Number(input.value);
      if (kind === 'percent' && (!Number.isFinite(value) || value <= 0 || value > 100)) throw new Error('Percent off must be between 1 and 100.');
      if (kind === 'amount' && (!Number.isInteger(value) || value < 100 || value > 100000)) throw new Error('Amount off must be $1 to $1,000.');
      const duration = ['once', 'repeating', 'forever'].includes(input.duration) ? input.duration : 'once';
      const months = Number(input.months);
      if (duration === 'repeating' && (!Number.isInteger(months) || months < 1 || months > 36)) throw new Error('Choose 1 to 36 months.');
      const maxUses = input.max_redemptions ? Number(input.max_redemptions) : 0;
      if (maxUses && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100000)) throw new Error('Max uses must be a whole number.');
      const expires = input.expires_on ? Date.parse(`${input.expires_on}T23:59:59Z`) : 0;
      if (input.expires_on && (!expires || expires < Date.now())) throw new Error('Expiry date must be in the future.');
      const existing = await stripeRest(`promotion_codes?code=${encodeURIComponent(code)}&active=true&limit=1`);
      if (existing.data?.length) throw new Error('That code already exists.');
      const coupon = await stripeRest('coupons', {
        name: code, duration, ...(duration === 'repeating' ? { duration_in_months: String(months) } : {}),
        ...(kind === 'percent' ? { percent_off: String(value) } : { amount_off: String(value), currency: 'usd' }),
        'metadata[created_by]': 'leadrespark_admin',
      });
      const promo = await stripeRest('promotion_codes', {
        coupon: coupon.id, code, ...(maxUses ? { max_redemptions: String(maxUses) } : {}),
        ...(expires ? { expires_at: String(Math.floor(expires / 1000)) } : {}),
      });
      return Response.json({ created: codeView(promo) });
    }

    if (action === 'deactivate_code') {
      if (!/^promo_\w+$/.test(String(input.id))) throw new Error('Unknown code.');
      await stripeRest(`promotion_codes/${input.id}`, { active: 'false' });
    }

    if (action === 'set_price') {
      const cents = Number(input.price_cents);
      if (!Number.isInteger(cents) || cents < 100 || cents > 100000) throw new Error('Price must be $1 to $1,000.');
      const config = await platformConfig(E);
      await E.PlatformSettings.update(config.id, { subscription_price_cents: cents, subscription_required: input.required !== false });
      await ensurePrice(E, { ...config, subscription_price_cents: cents });
    }

    const config = await platformConfig(E);
    const codes = await stripeRest('promotion_codes?limit=100');
    const counts: Record<string, number> = {};
    for (const st of ['active', 'trialing', 'past_due', 'incomplete', 'canceled']) counts[st] = await E.BillingAccount.count({ subscription_status: st }).catch(() => 0);
    let lastSync = null;
    try { lastSync = JSON.parse((await E.EngineCursor.filter({ key: 'subscription_sync' }, { limit: 1 })).items[0]?.cursor || 'null'); } catch { /* none yet */ }
    return Response.json({
      price_cents: Number(config.subscription_price_cents) || 10000, required: config.subscription_required !== false,
      counts, last_sync: lastSync,
      codes: (codes.data || []).map(codeView),
    });
  } catch (error) { return failure(error as Error); }
}
