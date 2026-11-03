import { context, own, failure } from '../_shared/ghl.ts';
export default async function(req) {
  try {
    const { base44, user } = await context(req); const input = await req.json();
    if (user.role !== 'admin') return Response.json({ error: 'Only your administrator can change campaign settings.' }, { status: 403 });
    if (typeof input.campaign_id !== 'string' || !input.campaign_id) throw new Error('Choose a campaign.');
    const campaign = own(user, await base44.asServiceRole.entities.Campaign.get(input.campaign_id));
    const common = { agent_email: campaign.agent_email, location_id: campaign.location_id, campaign_id: campaign.id };
    if (input.action === 'prompt') {
      if (typeof input.system_prompt !== 'string' || typeof input.knowledge_doc !== 'string' || !input.system_prompt.trim() || input.system_prompt.length > 30000 || input.knowledge_doc.length > 30000 || !input.notes?.trim() || input.notes.length > 1000) throw new Error('Add the prompt, knowledge document and a short change note (up to 1,000 characters).');
      if (input.expected_version !== campaign.prompt_version) throw new Error('The prompt changed in another session. Reopen the editor before saving.');
      const version = (campaign.prompt_version || 0) + 1;
      await base44.asServiceRole.entities.PromptVersion.create({ ...common, version, system_prompt: input.system_prompt, knowledge_doc: input.knowledge_doc, notes: input.notes, created_by: user.email });
      await base44.asServiceRole.entities.Campaign.update(campaign.id, { system_prompt: input.system_prompt, knowledge_doc: input.knowledge_doc, prompt_version: version });
      return Response.json({ version });
    }
    if (input.action === 'sequence') {
      if (!Array.isArray(input.steps) || input.steps.length !== 6) throw new Error('The sequence must contain both opening variants and four follow-ups.');
      const saved = await base44.entities.SequenceStep.filter({ campaign_id: campaign.id }, { limit: 10 });
      const updates = input.steps.map(step => {
        const original = saved.items.find(s => s.id === step.id);
        if (!original || typeof step.body !== 'string' || !step.body.trim() || step.body.length > 1600) throw new Error('Each message must contain 1–1,600 characters.');
        return { id: original.id, body: step.body };
      });
      if (new Set(updates.map(x => x.id)).size !== 6) throw new Error('Each sequence step must appear once.');
      await base44.asServiceRole.entities.SequenceStep.bulkUpdate(updates);
      return Response.json({ saved: true });
    }
    if (input.action === 'mode') {
      if (!['review','autopilot'].includes(input.mode)) throw new Error('Choose Review or Autopilot.');
      if (input.mode === 'autopilot' && (user.role !== 'admin' || input.confirmed !== true)) throw new Error('Only an admin may confirm Autopilot.');
      const [total, approved] = await Promise.all([base44.entities.AIDraft.count({ campaign_id: campaign.id }), base44.entities.AIDraft.count({ campaign_id: campaign.id, status: 'approved' })]);
      await base44.asServiceRole.entities.Campaign.update(campaign.id, { mode: input.mode });
      await base44.asServiceRole.entities.ControlAudit.create({ agent_email: campaign.agent_email, location_id: campaign.location_id, actor_email: user.email, action: 'campaign_mode_changed', details: { campaign_id: campaign.id, mode: input.mode, draft_approval_rate: total ? approved / total : null }, occurred_at: new Date().toISOString() });
      return Response.json({ saved: true });
    }
    throw new Error('Unknown campaign action.');
  } catch (error) { return failure(error); }
}