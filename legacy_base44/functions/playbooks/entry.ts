// Agent: list available playbooks and add one as a new campaign in one tap.
import { setupContext } from '../../shared/setupAccess.ts';
import { failure } from '../../shared/ghl.ts';
import { PLAYBOOKS, installPlaybook } from '../../shared/playbooks.ts';

export default async function (req: Request) {
  try {
    const { E, s } = await setupContext(req);
    const input = await req.json().catch(() => ({}));
    if (input.action === 'add') {
      const c = await installPlaybook(E, s, String(input.key || ''));
      await E.ControlAudit.create({ agent_email: s.agent_email, location_id: s.location_id || '', actor_email: s.agent_email, action: 'playbook_added', details: { key: input.key, campaign_id: c.id }, occurred_at: new Date().toISOString() }).catch(() => {});
      return Response.json({ campaign_id: c.id, name: c.name });
    }
    if (input.action === 'set_cadence') {
      const c = await E.Campaign.get(String(input.campaign_id || ''));
      if (!c || c.agent_email !== s.agent_email) throw new Error('Campaign not found.');
      if (!['daily', 'standard'].includes(input.cadence)) throw new Error('Choose a cadence.');
      if (!c.cadence) throw new Error('This campaign uses a fixed follow-up series.');
      await E.Campaign.update(c.id, { cadence: input.cadence });
      await E.ControlAudit.create({ agent_email: s.agent_email, location_id: s.location_id || '', actor_email: s.agent_email, action: 'cadence_changed', details: { campaign_id: c.id, cadence: input.cadence }, occurred_at: new Date().toISOString() }).catch(() => {});
      return Response.json({ campaign_id: c.id, cadence: input.cadence });
    }
    if (input.action === 'cadence') {
      const c = await E.Campaign.get(String(input.campaign_id || ''));
      if (!c || c.agent_email !== s.agent_email) throw new Error('Campaign not found.');
      const { CADENCES, cadenceSteps } = await import('../../shared/lifeSeed.ts');
      const plan = (k: any) => cadenceSteps(k).filter((x: any) => x.variant !== 'B').map((x: any) => ({ step: x.step_number, day: x.day_offset, slot: x.slot, lever: x.lever, kind: x.kind }));
      return Response.json({ cadence: c.cadence || '', options: Object.entries(CADENCES).map(([key, v]) => ({ key, ...v, steps: plan(key) })) });
    }
    const mine = await E.Campaign.filter({ agent_email: s.agent_email }, { limit: 50, fields: ['name', 'status'] });
    return Response.json({ playbooks: PLAYBOOKS.map(p => { const c = mine.items.find((x: any) => x.name === p.name); return { key: p.key, name: p.name, audience: p.audience, description: p.description, installed: !!c, campaign_id: c?.id || null, status: c?.status || null }; }) });
  } catch (e) { return failure(e as Error); }
}
