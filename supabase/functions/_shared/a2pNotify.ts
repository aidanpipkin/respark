// Tells the agent (and the owner) when their texting registration changes stage.
// Every notice is sent once per registration and stage, no matter how often the tracker runs.
import { appOrigin } from './runtime.ts';
import { textAgent, emailAgent } from './agentNotify.ts';
import { raise } from './signals.ts';

const LINK = appOrigin();

export type Stage = 'brand_approved' | 'approved' | 'rejected' | 'resubmitted';

/** Which notice (if any) a status change calls for. */
export function stageFor(prev: any, next: any): Stage | null {
  if (!next || prev?.status === next.status) return null;
  if (next.status === 'approved') return 'approved';
  if (next.status === 'rejected') return 'rejected';
  if (next.status === 'campaign_submitted' && prev?.status === 'rejected') return 'resubmitted';
  if (next.status === 'campaign_submitted' && prev?.status !== 'campaign_submitted') return 'brand_approved';
  return null;
}

/** The words each notice uses. Exported so the admin preview shows exactly what an agent gets. */
export function noticeFor(stage: Stage, s: any, reg: any) {
  const name = s.first_name || 'there';
  const biz = reg.legal_business_name || s.brand_name || 'your business';
  const num = s.phone_number ? s.phone_number.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3') : 'your LeadRespark number';
  if (stage === 'approved') return {
    subject: 'Texting is approved. You can go live.',
    email: `Hi ${name},\n\nGood news: the carriers approved texting for ${biz}. ${num} is now registered, and your caller ID and spam protection are being finished automatically.\n\nOne last step (1 minute)\nOpen your dashboard and tap "Text me a test". Reply YES from your phone. That confirms texting works end to end, and your campaign starts texting your imported leads right after.\n\n${LINK}/dashboard\n\nLeadRespark`,
    text: `LeadRespark: texting is approved for ${biz}. Last step: tap "Text me a test" on your dashboard and reply YES. ${LINK}/dashboard`,
  };
  if (stage === 'brand_approved') return {
    subject: 'Step 1 of 2 approved: your business is verified',
    email: `Hi ${name},\n\nThe carriers verified ${biz}. We've already submitted your texting campaign for the final review, which usually takes 1 to 7 business days. Nothing for you to do; we'll tell you the moment it's approved.\n\nWhile you wait, import your leads and set your calendar hours so you go live the same day:\n${LINK}/dashboard\n\nLeadRespark`,
    text: '',
  };
  if (stage === 'resubmitted') return {
    subject: 'Your texting campaign was resubmitted. Nothing needed from you',
    email: `Hi ${name},\n\nThe carriers sent back the texting campaign for ${biz} with one note: the campaign description needed to spell out more plainly who sends the messages, who receives them and why. That is wording on our side, not anything you did, and your business verification (step 1 of 2) is still approved.\n\nWe rewrote the description to the carriers' format and resubmitted the campaign today. The final review usually takes 1 to 7 business days. We check every 30 minutes and will email and text you the moment it is approved.\n\nNothing to do right now. If you want to read the new wording, it is on your registration page:\n${LINK}/setup/texting-registration\n\nWhile you wait, import your leads and set your calendar hours so you can go live the same day texting is approved:\n${LINK}/dashboard\n\nLeadRespark`,
    text: '',
  };
  return {
    subject: 'Action needed: your texting registration needs a fix',
    email: `Hi ${name},\n\nThe carriers didn't approve the texting registration for ${biz}.\n\nTheir reason: ${reg.review_note || 'not given.'}\n\nOpen the link below, correct the details and submit again. Most fixes take a couple of minutes, and we're watching it too.\n\n${LINK}/setup/texting-registration\n\nLeadRespark`,
    text: '',
  };
}

async function once(E: any, s: any, key: string) {
  const saved = await E.MessageDispatch.upsert([{ agent_email: s.agent_email, location_id: s.location_id || '', key, kind: 'alert', lead_id: '' }], { key: 'key' });
  const job = saved.records[0];
  if (job.state && job.state !== 'new') return null;
  const token = crypto.randomUUID();
  await E.MessageDispatch.updateMany({ id: job.id, state: { $in: ['new', null, ''] } }, { $set: { state: 'working', token } });
  const fresh = await E.MessageDispatch.get(job.id);
  return fresh.token === token ? fresh : null;
}

/** Sends the notice for a stage change. Returns what happened, for logs and the admin preview. */
export async function notifyRegistration(base44: any, s: any, prev: any, next: any) {
  const stage = stageFor(prev, next);
  if (!stage) return null;
  const E = base44.asServiceRole.entities;
  const job = await once(E, s, `a2p_notice:${next.id}:${stage}${stage === 'resubmitted' ? `:${next.resubmitted_at || ''}` : ''}`);
  if (!job) return { stage, skipped: 'already sent' };
  const n = noticeFor(stage, s, next);
  const email = await emailAgent(base44, s, n.subject, n.email).catch((e: Error) => `failed:${e.message}`);
  // The agent's own number can text them once approved; before that, email is the channel.
  const text = n.text ? await textAgent(base44, s, n.text, `a2p_notice_text:${next.id}:${stage}`).catch((e: Error) => ({ error: e.message })) : null;
  await E.MessageDispatch.update(job.id, { state: 'done', result: { email, text } });
  await raise(base44, {
    key: `a2p_${stage}:${s.agent_email}`, kind: stage === 'rejected' ? 'a2p_rejected' : 'a2p_progress', scope: 'platform', agent_email: s.agent_email,
    severity: stage === 'rejected' ? 'warning' : 'info', notifyOwner: true,
    title: stage === 'approved' ? `Texting approved: ${next.legal_business_name || s.agent_email}` : stage === 'brand_approved' ? `Brand verified: ${next.legal_business_name || s.agent_email}` : stage === 'resubmitted' ? `Campaign resubmitted: ${next.legal_business_name || s.agent_email}` : `Registration rejected: ${next.legal_business_name || s.agent_email}`,
    detail: next.review_note || '', action_label: 'Open agents', action_href: '/admin',
  }).catch(() => {});
  return { stage, email, text };
}
