// Writes the full follow-up series for one driver so the agent can see exactly
// what would go out. Nothing is sent, saved as a draft, or written to GHL.
import { context, own, agentSettings, failure } from '../_shared/ghl.ts';
import { writeStep, fillTemplate } from '../_shared/sequenceWriter.ts';
import { leadProfile } from '../_shared/leadProfile.ts';
import { sampleProfiles as truckerSamples } from '../_shared/truckerSeed.ts';
import { sampleProfiles as lifeSamples, CAMPAIGN_NAME as LIFE } from '../_shared/lifeSeed.ts';

export default async function (req: Request) {
  try {
    const { base44, user } = await context(req);
    const input = await req.json();
    if (typeof input.campaign_id !== 'string' || !input.campaign_id) throw new Error('Choose a campaign.');
    const campaign = own(user, await base44.asServiceRole.entities.Campaign.get(input.campaign_id));
    const sampleProfiles: Record<string, any> = campaign.name === LIFE ? lifeSamples : truckerSamples;
    if (input.action === 'samples') return Response.json({ samples: Object.entries(sampleProfiles).map(([key, v]: any) => ({ key, label: v.label })) });
    const s = await agentSettings(base44, campaign.agent_email);
    if (!s) throw new Error('Agent profile not found.');

    let profile: any, lead: any, source: string;
    if (typeof input.lead_id === 'string' && input.lead_id) {
      if (typeof input.lead_id !== 'string' || !input.lead_id) throw new Error('Choose a lead.');
      lead = await base44.asServiceRole.entities.Lead.get(input.lead_id);
      if (lead.agent_email !== campaign.agent_email) throw new Error('Contact access denied.');
      profile = await leadProfile(base44, s, lead, true);
      source = 'lead';
    } else {
      const sample = sampleProfiles[String(input.sample || Object.keys(sampleProfiles)[0])];
      if (!sample) throw new Error('Choose a sample driver.');
      profile = sample.profile; lead = { first_name: profile.first_name, state: profile.state }; source = `sample:${input.sample || Object.keys(sampleProfiles)[0]}`;
    }

    // Cadence campaigns: preview the first steps of the active cadence (writing all 60 would take minutes).
    const limit = Math.max(1, Math.min(Number(input.limit) || 10, 25));
    const steps = (await base44.asServiceRole.entities.SequenceStep.filter({ campaign_id: campaign.id, ...(campaign.cadence ? { cadence: campaign.cadence } : {}) }, { sort: 'step_number', limit: campaign.cadence ? limit + 1 : 20 })).items
      .sort((a: any, b: any) => a.step_number - b.step_number || String(a.variant).localeCompare(String(b.variant)));
    if (!steps.length) throw new Error('This campaign has no follow-up steps.');

    const results: any[] = [];
    const sent: string[] = [];
    for (const step of steps) {
      // Openers A and B are alternatives; later steps follow the A path.
      const previous = step.step_number === 1 ? [] : sent;
      const written = await writeStep(base44, s, lead, { ...campaign, personalize_sequence: true }, step, profile, previous);
      results.push({
        step_number: step.step_number, variant: step.variant, day_offset: step.day_offset, slot: step.slot || '', lever: step.lever,
        text: written.text, personalized: written.personalized, angle: written.angle, facts_used: written.facts_used,
        rewrites: written.attempts.length, fallback_reason: written.personalized ? '' : (written.attempts.at(-1)?.flags || []).join('; '),
        template: fillTemplate(step.body, lead, s), characters: written.text.length, model: written.model,
      });
      if (step.step_number === 1 ? step.variant === 'A' : true) sent.push(written.text);
    }
    // Keep a history of previews so prompt versions can be compared side by side.
    await base44.asServiceRole.entities.PreviewRun.create({ campaign_id: campaign.id, agent_email: campaign.agent_email, source, prompt_version: campaign.prompt_version || 1, model: campaign.ai_model || '', profile, results });
    return Response.json({ source, profile, results, preview: true });
  } catch (error) { return failure(error as Error); }
}
