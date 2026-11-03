// Agent referrals: share your link, and when the agent you invited starts their subscription,
// you both get free text credits. Rewards are paid once, atomically, and logged as credit
// transactions like any other balance change.
import { applyCredit, platformConfig, subscriptionOkFor } from './credits.ts';
import { billingAccount } from './stripeRest.ts';
import { emailAgent } from './agentNotify.ts';

export const REFERRER_REWARD_CENTS = 5000; // $50 in texts to the agent who shared the link
export const REFEREE_REWARD_CENTS = 2500;  // $25 in texts to the agent who joined

/** Pays every referral whose new agent now has an active subscription. Safe to run often. */
export async function rewardReferrals(base44: any, filter: Record<string, any> = {}) {
  const E = base44.asServiceRole.entities;
  const config = await platformConfig(E);
  const page = await E.Referral.filter({ status: 'joined', ...filter }, { limit: 50 });
  let paid = 0;
  for (const r of page.items || []) {
    const refereeAcct = await billingAccount(E, r.referee_email);
    if (!refereeAcct || !subscriptionOkFor({ ...config, subscription_required: true }, refereeAcct, '')) continue;
    const referrerAcct = await billingAccount(E, r.referrer_email);
    if (!referrerAcct) continue;
    // Claim it so two runs can't both pay.
    const claimed = await E.Referral.updateMany({ id: r.id, status: 'joined' }, { $set: { status: 'rewarding' } });
    if (!Number(claimed?.updated ?? claimed?.modified ?? 0)) continue;
    try {
      await applyCredit(E, r.referrer_email, REFERRER_REWARD_CENTS, { kind: 'adjustment', description: `Referral: ${r.referee_email} joined` });
      await applyCredit(E, r.referee_email, REFEREE_REWARD_CENTS, { kind: 'adjustment', description: 'Welcome bonus for joining with a referral' });
      await E.Referral.update(r.id, { status: 'rewarded', rewarded_at: new Date().toISOString(), referrer_reward_cents: REFERRER_REWARD_CENTS, referee_reward_cents: REFEREE_REWARD_CENTS });
      paid++;
      const s = (await E.AgentSettings.filter({ agent_email: r.referrer_email }, { limit: 1 })).items[0];
      if (s) await emailAgent(base44, s, 'You earned $50 in texts', `Hi ${s.first_name || 'there'},\n\nAn agent you invited just started LeadRespark, so we added $50 in text credits to your balance. They got $25 too.\n\nKeep sharing your link from your dashboard. There's no limit.\n\nLeadRespark`).catch(() => {});
    } catch (e) {
      await E.Referral.update(r.id, { status: 'joined' }).catch(() => {});
      console.error('[referrals] reward failed', r.id, (e as Error).message);
    }
  }
  return paid;
}
