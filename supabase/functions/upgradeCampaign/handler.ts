// Applies the latest Trucker IUL playbook (reply prompt, knowledge, writer
// guidance, step briefs, model) to an agent's campaign. The previous prompts are
// kept as a PromptVersion so any change can be compared or rolled back.
import { context, failure } from '../_shared/ghl.ts';
import { systemPrompt, knowledgeDoc, writerPrompt, stepBriefs, PROMPT_VERSION, AI_MODEL } from '../_shared/truckerSeed.ts';

export default async function (req: Request) {
  try {
    const { base44, user } = await context(req);
    if (user.role !== 'admin') return Response.json({ error: 'Administrator access required.' }, { status: 403 });
    const input = await req.json();
    const E = base44.asServiceRole.entities;
    if (typeof input.campaign_id !== 'string' || !input.campaign_id) throw new Error('Choose a campaign.');
    const campaign = await E.Campaign.get(input.campaign_id);
    if (!campaign || campaign.name !== 'Trucker IUL') throw new Error('Choose a Trucker IUL campaign.');
    const scope = { agent_email: campaign.agent_email, location_id: campaign.location_id };

    // Snapshot what is live now, unless that exact version is already saved.
    const current = campaign.prompt_version || 1;
    if (!(await E.PromptVersion.count({ campaign_id: campaign.id, version: current })))
      await E.PromptVersion.create({ ...scope, campaign_id: campaign.id, version: current, system_prompt: campaign.system_prompt || '', knowledge_doc: campaign.knowledge_doc || '', writer_prompt: campaign.writer_prompt || '', notes: 'Saved automatically before upgrading to the latest playbook.' });

    const version = Math.max(current + 1, PROMPT_VERSION);
    const updated = await E.Campaign.update(campaign.id, { system_prompt: systemPrompt, knowledge_doc: knowledgeDoc, writer_prompt: writerPrompt, personalize_sequence: true, ai_model: campaign.ai_model || AI_MODEL, prompt_version: version });
    await E.PromptVersion.create({ ...scope, campaign_id: campaign.id, version, system_prompt: systemPrompt, knowledge_doc: knowledgeDoc, writer_prompt: writerPrompt, notes: 'Trucker IUL playbook: personalized follow-ups written from the lead profile, sales-craft reply guidance.' });

    const steps = (await E.SequenceStep.filter({ campaign_id: campaign.id }, { limit: 20 })).items;
    let briefed = 0;
    for (const step of steps) {
      const key = step.step_number === 1 ? `1${step.variant}` : String(step.step_number);
      if (stepBriefs[key] && step.brief !== stepBriefs[key]) { await E.SequenceStep.update(step.id, { brief: stepBriefs[key] }); briefed++; }
    }
    return Response.json({ campaign_id: updated.id, prompt_version: version, ai_model: updated.ai_model, steps_briefed: briefed });
  } catch (error) { return failure(error as Error); }
}
