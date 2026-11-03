// Self-serve launch: every requirement is checked automatically, and the agent goes live by
// themselves once all pass (including a live two-way test text). No admin step needed.
import { billingAccount } from './stripeRest.ts';
import { exempt, platformConfig, subscriptionOkFor } from './credits.ts';
import { routeFor, sendRawText, e164 } from './smsTransport.ts';

export type Item = { key: string; label: string; done: boolean; href?: string; detail?: string };

export async function readiness(E: any, s: any) {
  const config = await platformConfig(E);
  const wallet = await billingAccount(E, s.agent_email);
  const route = s.phone_number ? await routeFor(E, s) : { kind: 'ghl' };
  const checks = (s.onboarding_checks && typeof s.onboarding_checks === 'object') ? s.onboarding_checks : {};
  const leads = await E.Lead.count({ agent_email: s.agent_email, status: { $in: ['queued', 'in_sequence', 'replied', 'engaged', 'booked'] } }).catch(() => 0);
  const paid = exempt(config, s.agent_email) || wallet?.status === 'card_saved';
  const items: Item[] = [
    { key: 'workspace', label: 'Workspace built', done: s.provisioning?.state === 'done' || (!!s.location_id && !!s.calendar_id && s.connected), href: '/welcome' },
    { key: 'billing', label: 'Card saved for text credits', done: paid, href: '/credits' },
    { key: 'subscription', label: `LeadRespark subscription ($${Math.round((Number(config.subscription_price_cents) || 10000) / 100)}/mo)`, done: subscriptionOkFor(config, wallet, s.agent_email), href: '/credits', detail: wallet?.subscription_status && !subscriptionOkFor(config, wallet, s.agent_email) ? `Status: ${String(wallet.subscription_status).replace(/_/g, ' ')}` : '' },
    { key: 'number', label: 'Texting number', done: !!s.phone_number, href: '/setup/number', detail: s.phone_number || '' },
    { key: 'registration', label: 'Carrier registration approved', done: s.a2p_status === 'approved', href: '/setup/texting-registration' },
    { key: 'test', label: 'Two-way test text', done: !!checks.self_test_at, href: '/dashboard', detail: checks.self_test_sent_at && !checks.self_test_at ? `Reply YES to the text we sent to ${String(s.alert_mobile || '').slice(-4).padStart(4, '•')}` : '' },
    { key: 'leads', label: 'Leads imported', done: leads > 0, href: '/contacts/import', detail: leads ? `${leads} ready` : 'Optional, but your campaign needs people to text' },
  ];
  const required = items.filter(i => i.key !== 'leads');
  return { items, ready: required.every(i => i.done), live: s.status === 'live', automatic: route.kind === 'twilio' && !!s.self_serve, can_test: route.kind === 'twilio' && !!e164(s.alert_mobile) && s.a2p_status === 'approved' };
}

/** Sends the YES test to the agent's own mobile. */
export async function sendSelfTest(E: any, s: any) {
  const to = e164(s.alert_mobile);
  if (!to) throw new Error('Add your mobile number on your Profile first.');
  if (s.a2p_status !== 'approved') throw new Error('Your carrier registration must be approved first.');
  const checks = (s.onboarding_checks && typeof s.onboarding_checks === 'object') ? s.onboarding_checks : {};
  if (checks.self_test_sent_at && Date.now() - Date.parse(checks.self_test_sent_at) < 60000) throw new Error('A test was just sent. Give it a minute.');
  const sid = await sendRawText(E, s, to, `${s.brand_name || 'LeadRespark'}: this is your LeadRespark test text. Reply YES to confirm texting works and finish setup.`);
  if (!sid) throw new Error('Test texts need your LeadRespark number. Contact support.');
  await E.AgentSettings.update(s.id, { onboarding_checks: { ...checks, self_test_sent_at: new Date().toISOString(), self_test_sid: sid } });
}

/** Called for every inbound text: returns true if it was the agent answering their own test. */
export async function handleSelfTestReply(E: any, s: any, from: string, body: string) {
  const checks = (s.onboarding_checks && typeof s.onboarding_checks === 'object') ? s.onboarding_checks : {};
  if (!checks.self_test_sent_at || e164(s.alert_mobile) !== from) return false;
  if (!/^\s*(yes|y|yep|yeah|confirm)\b/i.test(body)) return true;
  const fresh = { ...s, onboarding_checks: { ...checks, self_test_at: new Date().toISOString(), webhook_received: true } };
  await E.AgentSettings.update(s.id, { onboarding_checks: fresh.onboarding_checks });
  await tryActivate(E, fresh);
  return true;
}

/** Starts any draft campaign the agent has imported leads into (only once they are live). */
export async function startCampaignsWithLeads(E: any, s: any) {
  if (s.status !== 'live') return 0;
  const drafts = await E.Campaign.filter({ agent_email: s.agent_email, location_id: s.location_id, status: 'draft' }, { limit: 20 });
  let started = 0;
  for (const c of drafts.items) {
    const queued = await E.Lead.count({ agent_email: s.agent_email, campaign_id: c.id, status: 'queued' });
    if (queued > 0) { await E.Campaign.update(c.id, { status: 'active' }); started++; }
  }
  return started;
}

/** Turns a self-serve agent live once everything passes. Starts in review mode (agent approves AI replies). */
export async function tryActivate(E: any, s: any) {
  if (s.status === 'live' || !s.self_serve) return false;
  const r = await readiness(E, s);
  if (!r.ready) return false;
  await E.AgentSettings.update(s.id, { status: 'live', live_at: s.live_at || new Date().toISOString(), onboarding_complete: true, mode: s.mode || 'review' });
  await E.ControlAudit.create({ agent_email: s.agent_email, location_id: s.location_id || '', actor_email: 'system', action: 'account_activated', occurred_at: new Date().toISOString() }).catch(() => {});
  await startCampaignsWithLeads(E, { ...s, status: 'live' });
  return true;
}
