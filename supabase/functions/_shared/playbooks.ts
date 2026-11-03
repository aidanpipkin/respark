// Playbooks: ready-made campaigns (AI prompt, knowledge, writer, follow-up series) an agent can add
// in one tap. Every playbook runs on the same engine, pipeline, tracks, documents and stage colors.
import { scope } from './ghl.ts';
import * as trucker from './truckerSeed.ts';
import * as fe from './finalExpenseSeed.ts';
import * as life from './lifeSeed.ts';
import * as aidan from './truckerAidanSeed.ts';

export type Playbook = { key: string; name: string; product: string; tag: string; audience: string; description: string; docs: string; seed: any; persona?: 'assistant' | 'agent'; send_rules?: Record<string, any> };

export const PLAYBOOKS: Playbook[] = [
  { key: 'life_respark', name: life.CAMPAIGN_NAME, product: life.PRODUCT, tag: 'campaign-life-respark', docs: 'all', audience: 'Anyone who asked about life insurance: IUL, term, whole life, final expense or mortgage protection', description: 'Adapts to each lead from their profile and your notes. Emotional, results-first texts over 60 days.', seed: life },
  { key: 'trucker_iul', name: 'Trucker IUL Respark', product: 'Indexed universal life', tag: 'campaign-trucker-iul', docs: 'iul', audience: 'Truck drivers who asked about IUL', description: 'Protection for the family on the road, living benefits, and cash value for life after driving.', seed: trucker },
  { key: 'trucker_aidan', name: aidan.CAMPAIGN_NAME, product: aidan.PRODUCT, tag: 'campaign-trucker-aidan', docs: 'iul', persona: 'agent', send_rules: aidan.SEND_RULES, audience: 'Truck drivers who asked about IUL (fresh vendor leads and aged requests)', description: "Aidan's 30-day series sent word for word in the agent's own name, with a same-day burst for brand-new leads. No AI rewriting; Sunday afternoons allowed except AL/LA/MS/UT/RI.", seed: aidan },
  { key: 'final_expense', name: fe.CAMPAIGN_NAME, product: fe.PRODUCT, tag: 'campaign-final-expense', docs: 'final_expense', audience: 'People 50 to 85 who asked about final expense', description: 'Gentle, trust-first follow-up about not leaving family with final costs.', seed: fe },
];

/** Creates (or refreshes) the agent's campaign for a playbook, including its follow-up series. */
export async function installPlaybook(E: any, s: any, key: string) {
  const pb = PLAYBOOKS.find(p => p.key === key);
  if (!pb) throw new Error('Unknown playbook.');
  if (!s.location_id) throw new Error('Finish building your workspace first.');
  const sd = pb.seed;
  let campaign = (await E.Campaign.filter({ agent_email: s.agent_email, name: pb.name }, { limit: 1 })).items[0];
  if (!campaign) {
    campaign = await E.Campaign.create({
      ...scope(s), name: pb.name, product: pb.product, status: 'draft', mode: s.mode === 'autopilot' ? 'autopilot' : 'review', persona: pb.persona || 'assistant',
      ab_enabled: true, ab_lead_cap: 200, prompt_version: sd.PROMPT_VERSION, system_prompt: sd.systemPrompt, knowledge_doc: sd.knowledgeDoc, writer_prompt: sd.writerPrompt,
      personalize_sequence: true, ai_model: sd.AI_MODEL, ghl_tag: pb.tag, pipeline_id: s.pipeline_id || '', stage_ids: s.stage_ids || {},
      ...(pb.send_rules ? { send_rules: pb.send_rules } : {}),
    });
  }
  // Playbooks with their own send window carry it on the campaign (older installs pick it up here).
  if (pb.send_rules && !campaign.send_rules) campaign = await E.Campaign.update(campaign.id, { send_rules: pb.send_rules });
  // Cadence playbooks install every cadence, so switching a campaign's cadence is instant.
  const wanted = sd.cadenceSteps ? [...sd.cadenceSteps('daily'), ...sd.cadenceSteps('standard')] : sd.sequence;
  if (sd.cadenceSteps && !campaign.cadence) campaign = await E.Campaign.update(campaign.id, { cadence: sd.cadenceSteps('daily').length ? 'daily' : 'standard' });
  const steps = await E.SequenceStep.filter({ campaign_id: campaign.id }, { limit: 300 });
  const missing = wanted.filter((st: any) => !steps.items.some((v: any) => v.step_number === st.step_number && v.variant === st.variant && (v.cadence || '') === (st.cadence || '') && !!v.fresh_only === !!st.fresh_only));
  if (missing.length) await E.SequenceStep.bulkCreate(missing.map((st: any) => ({ ...scope(s), campaign_id: campaign.id, requires_step1_delivered: st.step_number > 1, ...st })));
  if (!(await E.PromptVersion.count({ campaign_id: campaign.id, version: campaign.prompt_version || sd.PROMPT_VERSION })))
    await E.PromptVersion.create({ ...scope(s), campaign_id: campaign.id, version: campaign.prompt_version || sd.PROMPT_VERSION, system_prompt: campaign.system_prompt, knowledge_doc: campaign.knowledge_doc, writer_prompt: campaign.writer_prompt || '', notes: `Installed from the ${pb.name} playbook.` });
  return campaign;
}

/** What kind of product a campaign sells, for documents and email copy. */
export function productKind(campaign: any) {
  const t = `${campaign?.product || ''} ${campaign?.name || ''}`;
  return /mortgage/i.test(t) ? 'mortgage' : /final/i.test(t) ? 'final_expense' : /^life insurance/i.test(t.trim()) ? 'life' : 'iul';
}
