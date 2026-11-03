import { adminContext } from '../_shared/agentAccess.ts';
import { agentSettings, failure } from '../_shared/ghl.ts';
import { syncLeadToGhl } from '../_shared/crmSync.ts';
import { isRehearsal } from '../_shared/rehearsal.ts';
export default async function (req: Request) {
  try {
    const { base44 } = await adminContext(req);
    const input = await req.json();
    if (typeof input.lead_id !== 'string') throw new Error('Choose a contact.');
    const lead = await base44.asServiceRole.entities.Lead.get(input.lead_id);
    const s = await agentSettings(base44, lead.agent_email);
    // Rehearsal leads live only inside LeadRespark; there is no CRM contact to update.
    if (!s || isRehearsal(s) || isRehearsal({ agent_email: lead.agent_email })) return Response.json({ skipped: true, reason: 'rehearsal' });
    return Response.json(await syncLeadToGhl(base44, s, lead));
  } catch (error) { return failure(error as Error); }
}
