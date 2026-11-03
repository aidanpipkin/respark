// Mirrors each lead into the agent's GHL CRM: Respark Status field, one status tag, and an
// opportunity card in the Respark pipeline at the right stage. Runs from the sequence sender
// (every 5 minutes per agent) for leads whose status changed since the last sync.
import { localContactId } from './rehearsal.ts';
import { ghl } from './ghl.ts';
import { claimJob, finishJob } from './messageJobs.ts';

const MAP: Record<string, [string, string, string]> = {
  queued: ['eligible', 'Ready', 'respark-ready'],
  in_sequence: ['re_permission_sent', 'In Sequence', 'respark-in-sequence'],
  replied: ['engaged', 'Replied', 'respark-replied'],
  engaged: ['engaged', 'Replied', 'respark-replied'],
  booked: ['appointment_booked', 'Booked', 'respark-booked'],
  held: ['appointment_held', 'Booked', 'respark-booked'],
  needs_human: ['engaged', 'Needs Human', 'respark-needs-human'],
  opted_out: ['lost', 'Opted Out', 'respark-opted-out'],
  not_interested: ['not_now', 'Ineligible', 'respark-ineligible'],
  closed: ['not_now', 'Ineligible', 'respark-ineligible'],
  no_show: ['engaged', 'Needs Human', 'respark-no-show'],
};
const TRACK: Record<string, [string, string, string]> = {
  no_show: ['engaged', 'Needs Human', 'respark-no-show'],
  follow_up: ['appointment_held', 'Booked', 'respark-follow-up'],
  lost_banking: ['appointment_held', 'Booked', 'respark-lost-banking'],
  lost_social: ['appointment_held', 'Booked', 'respark-lost-social'],
};
const ALL_TAGS = ['respark-ready', 'respark-in-sequence', 'respark-replied', 'respark-booked', 'respark-needs-human', 'respark-ineligible', 'respark-no-show', 'respark-follow-up', 'respark-lost-banking', 'respark-lost-social', 'respark-client', 'respark-client-pending'];

export async function stageFor(E: any, lead: any): Promise<[string, string, string] | null> {
  if (lead.status === 'opted_out') return MAP.opted_out;
  if (lead.track === 'client' || lead.status === 'client') {
    const p = (await E.Policy.filter({ agent_email: lead.agent_email, lead_id: lead.id }, { sort: '-created_at', limit: 1 }).catch(() => ({ items: [] }))).items[0];
    return p?.status === 'approved' ? ['policy_issued', 'Booked', 'respark-client'] : ['policy_submitted', 'Booked', 'respark-client-pending'];
  }
  if (lead.track && TRACK[lead.track] && lead.status !== 'booked') return TRACK[lead.track];
  return MAP[lead.status] || null;
}

export async function syncLeadToGhl(base44: any, s: any, lead: any) {
  const E = base44.asServiceRole.entities;
  if (!s?.connected || !s.ghl_token || !lead.ghl_contact_id || localContactId(lead.ghl_contact_id) || lead.location_id !== s.location_id) return { skipped: true };
  const values = await stageFor(E, lead);
  if (!values) return { skipped: true };
  const id = encodeURIComponent(lead.ghl_contact_id);
  const update: any = { customFields: s.custom_field_ids?.['Respark Status'] ? [{ id: s.custom_field_ids['Respark Status'], field_value: values[1] }] : [] };
  if (lead.status === 'opted_out') update.dndSettings = { SMS: { status: 'active', message: 'Contact opted out via SMS', code: 'STOP' } };
  await ghl(s, `/contacts/${id}`, 'PUT', update);
  await ghl(s, `/contacts/${id}/tags`, 'POST', { tags: [values[2]] });
  await ghl(s, `/contacts/${id}/tags`, 'DELETE', { tags: ALL_TAGS.filter(t => t !== values[2]) });
  const stage = s.stage_ids?.[values[0]];
  if (s.pipeline_id && stage) {
    let opp = lead.ghl_opportunity_id;
    if (!opp) {
      const claim = await claimJob(base44, s, `opportunity:${lead.id}`, 'opportunity', lead.id);
      if (claim.claimed) {
        try {
          const r = await ghl(s, '/opportunities/', 'POST', { locationId: s.location_id, pipelineId: s.pipeline_id, pipelineStageId: stage, contactId: lead.ghl_contact_id, name: [lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.phone, status: 'open' });
          opp = r.opportunity?.id || r.id;
          if (!opp) throw new Error('Pipeline acknowledgement missing.');
          await finishJob(base44, claim.job, { id: opp });
        } catch (e) { await finishJob(base44, claim.job, { error: 'Review pipeline record before retrying' }, 'uncertain'); throw e; }
      } else opp = claim.job.result?.id;
      if (opp) await E.Lead.update(lead.id, { ghl_opportunity_id: opp });
    }
    if (opp) await ghl(s, `/opportunities/${encodeURIComponent(opp)}`, 'PUT', { pipelineStageId: stage, status: lead.status === 'opted_out' ? 'lost' : values[0] === 'policy_issued' ? 'won' : 'open' });
  }
  return { synced: true, stage: values[0] };
}

const syncKey = (lead: any, values: any) => `${lead.status}|${lead.track || ''}|${values?.[0] || ''}`;

/** Leads changed since the last pass whose CRM stage is out of date. Time-boxed per agent. */
export async function syncChangedLeads(base44: any, s: any, limit = 60, budgetMs = 60000) {
  const E = base44.asServiceRole.entities;
  if (!s?.connected) return 0;
  const key = `crmsync:${s.agent_email}`;
  const row = (await E.EngineCursor.filter({ key }, { limit: 1 })).items[0];
  const since = row?.cursor || '1970-01-01T00:00:00Z';
  const page = await E.Lead.filter({ agent_email: s.agent_email, updated_date: { $gt: since } }, { sort: 'updated_date', limit });
  const stop = Date.now() + budgetMs;
  let last = since, n = 0;
  for (const lead of page.items) {
    if (Date.now() > stop) break;
    try {
      const values = await stageFor(E, lead);
      const want = syncKey(lead, values);
      if (values && lead.crm_synced_status !== want) {
        await syncLeadToGhl(base44, s, lead);
        await E.Lead.updateMany({ id: lead.id, updated_date: lead.updated_date }, { $set: { crm_synced_status: want } });
        n++;
      }
    } catch { /* retried when the lead changes again or on the next pass */ }
    last = lead.updated_date;
  }
  if (last !== since) await E.EngineCursor.upsert([{ key, cursor: last }], { key: 'key' });
  return n;
}
