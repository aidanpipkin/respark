import { context, agentSettings, safeSettings, scope, failure } from '../_shared/ghl.ts';
import { systemPrompt, knowledgeDoc, writerPrompt, sequence, PROMPT_VERSION, AI_MODEL } from '../_shared/truckerSeed.ts';
export default async function(req) {
  try {
    const { base44, user } = await context(req);
    let settings = await agentSettings(base44, user.email);
    if (user.role !== 'admin') {
      // Self-serve: every new signup gets a profile and is sent to the welcome flow.
      if (!settings) {
        const config = (await base44.asServiceRole.entities.PlatformSettings.filter({ singleton_key: 'platform' }, { limit: 1 })).items[0];
        if (config?.self_serve_enabled !== false) {
          const first = String(user.full_name || '').split(' ')[0] || '';
          settings = await base44.asServiceRole.entities.AgentSettings.create({ agent_email: user.email, first_name: first, display_name: user.full_name || first, notification_email: user.email, business_email: user.email, status: 'onboarding', mode: 'review', self_serve: true, onboarding_step: 1 });
        }
      }
      const needs_welcome = !!settings && settings.self_serve === true && settings.provisioning?.state !== 'done';
      return Response.json({ settings: safeSettings(settings), user: { email: user.email, full_name: user.full_name, role: 'agent' }, awaiting_setup: !settings, needs_welcome });
    }
    if (!settings) settings = await base44.asServiceRole.entities.AgentSettings.create({ agent_email: user.email, first_name: user.full_name?.split(' ')[0] || '', display_name: user.full_name?.split(' ')[0] || '', notification_email: user.email, status: 'onboarding' });
    let { items } = await base44.entities.Campaign.filter({ agent_email: user.email, name: { $in: ['Trucker IUL', 'Trucker IUL Respark'] } }, { limit: 1 });
    let campaign = items[0];
    if (!campaign) campaign = await base44.asServiceRole.entities.Campaign.create({ ...scope(settings), name: 'Trucker IUL Respark', product: 'Indexed universal life', status: 'draft', mode: 'review', persona: 'assistant', ab_enabled: true, ab_lead_cap: 200, prompt_version: PROMPT_VERSION, system_prompt: systemPrompt, knowledge_doc: knowledgeDoc, writer_prompt: writerPrompt, personalize_sequence: true, ai_model: AI_MODEL, ghl_tag: 'campaign-trucker-iul', stage_ids: {} });
    const existing = await base44.entities.SequenceStep.filter({ campaign_id: campaign.id }, { limit: 10 });
    const missing = sequence.filter(step => !existing.items.some(saved => saved.step_number === step.step_number && saved.variant === step.variant));
    if (missing.length) await base44.asServiceRole.entities.SequenceStep.bulkCreate(missing.map(step => ({ ...scope(settings), campaign_id: campaign.id, requires_step1_delivered: step.step_number > 1, ...step })));
    if (!(await base44.entities.PromptVersion.count({ campaign_id: campaign.id, version: campaign.prompt_version || PROMPT_VERSION }))) await base44.asServiceRole.entities.PromptVersion.create({ ...scope(settings), campaign_id: campaign.id, version: campaign.prompt_version || PROMPT_VERSION, system_prompt: campaign.system_prompt || systemPrompt, knowledge_doc: campaign.knowledge_doc || knowledgeDoc, writer_prompt: campaign.writer_prompt || writerPrompt, notes: 'Trucker IUL v2: personalized follow-ups written from the lead profile, sales-craft reply guidance.', created_by: user.email });
    return Response.json({ settings: safeSettings(settings), user: { email: user.email, full_name: user.full_name, role: user.role }, campaign_id: campaign.id });
  } catch (error) { return failure(error); }
}