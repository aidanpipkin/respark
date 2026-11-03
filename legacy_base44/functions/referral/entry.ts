// Agent referrals: { action: 'status' } returns the agent's invite link and results;
// { action: 'claim', code } records that the signed-in agent joined through someone's link.
import { setupContext } from '../../shared/setupAccess.ts';
import { failure } from '../../shared/ghl.ts';
import { ensurePublicSlug } from '../../shared/agentSite.ts';
import { APP_ORIGIN } from '../../shared/appointmentJourney.ts';
import { rewardReferrals, REFERRER_REWARD_CENTS, REFEREE_REWARD_CENTS } from '../../shared/referrals.ts';

export default async function (req: Request) {
  try {
    const { base44, E, s } = await setupContext(req);
    const input = await req.json().catch(() => ({}));

    if (input.action === 'claim') {
      const code = String(input.code || '').trim().toLowerCase().slice(0, 64);
      if (!/^[a-z0-9-]{2,64}$/.test(code)) return Response.json({ claimed: false });
      const referrer = (await E.AgentSettings.filter({ public_slug: code }, { limit: 1 })).items[0];
      if (!referrer || referrer.agent_email === s.agent_email) return Response.json({ claimed: false });
      // One referral per new agent, and only for brand-new accounts (no subscription yet).
      if ((await E.Referral.filter({ referee_email: s.agent_email }, { limit: 1 })).items[0]) return Response.json({ claimed: false, reason: 'already' });
      const acct = (await E.BillingAccount.filter({ agent_email: s.agent_email }, { limit: 1 })).items[0];
      if (acct?.subscription_id) return Response.json({ claimed: false, reason: 'existing' });
      await E.Referral.create({ code, referrer_email: referrer.agent_email, referee_email: s.agent_email, status: 'joined', joined_at: new Date().toISOString() });
      return Response.json({ claimed: true, referrer: referrer.first_name || referrer.brand_name || 'a fellow agent' });
    }

    // Pay anything that's due for this agent before showing their numbers.
    await rewardReferrals(base44, { referrer_email: s.agent_email }).catch(() => 0);
    const slug = await ensurePublicSlug(E, s);
    const mine = (await E.Referral.filter({ referrer_email: s.agent_email }, { sort: '-joined_at', limit: 100, fields: ['status', 'joined_at', 'referrer_reward_cents'] })).items;
    return Response.json({
      link: `${APP_ORIGIN}/?ref=${slug}`,
      joined: mine.length,
      rewarded: mine.filter((r: any) => r.status === 'rewarded').length,
      earned_cents: mine.reduce((n: number, r: any) => n + (Number(r.referrer_reward_cents) || 0), 0),
      referrer_reward_cents: REFERRER_REWARD_CENTS, referee_reward_cents: REFEREE_REWARD_CENTS,
    });
  } catch (e) { return failure(e as Error); }
}
