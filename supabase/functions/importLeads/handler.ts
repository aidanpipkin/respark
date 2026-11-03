// Self-serve lead import. The browser sends rows in chunks of up to 100; each row becomes a GHL
// contact plus a LeadRespark lead enrolled in the chosen campaign, with the agent's consent attestation.
import { setupContext } from '../_shared/setupAccess.ts';
import { ghl, scope, failure } from '../_shared/ghl.ts';
import { freshSettings } from '../_shared/ghlAuth.ts';
import { e164 } from '../_shared/smsTransport.ts';
import { businessName } from '../_shared/publicSite.ts';
import { startCampaignsWithLeads } from '../_shared/readiness.ts';
import { clean, intakeLead, STATE_TZ, consentRecordFor, writeConsentRecords } from '../_shared/leadIntake.ts';
import { CAMPAIGN_NAME } from '../_shared/lifeSeed.ts';

const SOURCES = ['My website or landing page', 'A form I ran (Facebook / Google ads)', 'Referral or past client who asked to hear from me', 'Lead vendor that named my business in the consent', 'Other documented opt-in'];

const TEST_FIRST = ['Maria', 'Gary', 'Sam', 'Tanya', 'Derek'];
const PREFERRED_STATES = ['TX', 'FL', 'AR', 'OK', 'NY'];

/** Five fictional leads: four with states (the agent's licensed ones first), one with no state, one duplicate number. */
export async function createTestLeads(E: any, s: any) {
  const camps = (await E.Campaign.filter({ agent_email: s.agent_email, location_id: s.location_id }, { sort: 'created_date', limit: 50 })).items;
  const campaign = camps.find((c: any) => c.name === CAMPAIGN_NAME && c.status === 'active') || camps.find((c: any) => c.status === 'active') || camps.find((c: any) => c.name === CAMPAIGN_NAME) || camps[0];
  if (!campaign) throw new Error('Create a campaign first; test leads are enrolled in it.');
  const licensed: string[] = Array.isArray(s.licensed_states) ? s.licensed_states : [];
  const states = [...PREFERRED_STATES.filter(st => licensed.includes(st)), ...licensed.filter(st => !PREFERRED_STATES.includes(st)), ...PREFERRED_STATES];
  const picked: string[] = []; for (const st of states) { if (!picked.includes(st)) picked.push(st); if (picked.length === 4) break; }
  // Deterministic numbers per agent, so running this twice reports duplicates instead of piling up.
  let h = 0; for (const ch of String(s.agent_email)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const area = String(200 + (h % 700)).padStart(3, '0');
  const num = (i: number) => `+1${area}55501${String((h + i * 7) % 100).padStart(2, '0')}`;
  const rows = [
    { first_name: TEST_FIRST[0], state: picked[0], phone: num(0), facts: { product_interest: 'Mortgage Protection', who_to_protect: 'her two kids' } },
    { first_name: TEST_FIRST[1], state: picked[1], phone: num(1), facts: { product_interest: 'Final Expense' } },
    { first_name: TEST_FIRST[2], state: picked[2], phone: num(2), facts: {} },
    { first_name: TEST_FIRST[3], state: picked[3], phone: num(3), facts: { product_interest: 'Term Life' } },
    { first_name: TEST_FIRST[4], state: '', phone: num(4), facts: {} },
    { first_name: TEST_FIRST[0], state: picked[0], phone: num(0), facts: {} }, // duplicate number
  ];
  const now = new Date().toISOString(), batch = 'test';
  const results: any[] = [];
  for (const [i, row] of rows.entries()) {
    try {
      const dup = (await E.Lead.filter({ agent_email: s.agent_email, phone: row.phone }, { limit: 1 })).items[0];
      if (dup) { results.push({ i, status: 'duplicate', reason: 'Already in your contacts', lead_id: dup.id }); continue; }
      const eligible = !!row.state && licensed.includes(row.state);
      const saved = await E.Lead.create({
        ...scope(s), ghl_contact_id: `test:${crypto.randomUUID()}`, campaign_id: campaign.id, first_name: row.first_name, last_name: 'Testlead', phone: row.phone,
        state: row.state, timezone: STATE_TZ[row.state] || '', lead_source: 'Test', inquiry_date: '2026-02-14', lead_facts: { ...row.facts, extra_details: 'Fictional test lead' }, import_batch: batch,
        consent_source: 'test', consent_date: now.slice(0, 10), consent_wording: 'Fictional test lead. Never texted.', consent_text: 'Fictional test lead. Never texted.', consent_seller_named: businessName(s),
        state_eligible: eligible, dnc_checked: true, current_step: 0, next_send_at: eligible ? now : '', step1_delivered: false,
        status: eligible ? 'queued' : 'closed', eligibility_reason: eligible ? 'Fictional test lead.' : row.state ? `Not licensed in ${row.state}.` : 'State unknown; add the state to text this contact.',
        sequence_paused: !eligible, ai_paused: !eligible, sequence_waiting_review: false,
      });
      results.push({ i, status: eligible ? 'imported' : 'held', reason: eligible ? '' : row.state ? `Not licensed in ${row.state}` : 'State missing', lead_id: saved.id });
    } catch (e) { results.push({ i, status: 'error', reason: String((e as Error).message || 'Failed').slice(0, 160) }); }
  }
  const count = (st: string) => results.filter(r => r.status === st).length;
  if (count('imported')) await startCampaignsWithLeads(E, s).catch(() => 0);
  // Lets the sender pick this agent up even before they are live (test leads only).
  if (count('imported') && !s.test_leads_at) await E.AgentSettings.update(s.id, { test_leads_at: now }).catch(() => {});
  return { test: true, campaign: campaign.name, imported: count('imported'), held: count('held'), duplicate: count('duplicate'), skipped: count('skipped'), errors: count('error'), results };
}

export default async function (req: Request) {
  try {
    const ctx = await setupContext(req);
    const { E } = ctx;
    const input = await req.json();
    const s = await freshSettings(ctx.base44, ctx.s);

    if (input.action === 'options') {
      const campaigns = await E.Campaign.filter({ agent_email: s.agent_email, location_id: s.location_id }, { limit: 50 });
      return Response.json({ sources: SOURCES, campaigns: campaigns.items.filter((c: any) => !c.archived).map((c: any) => ({ id: c.id, name: c.name, status: c.status })), licensed_states: s.licensed_states || [], business_name: businessName(s) });
    }

    if (!s.connected || !s.location_id) throw new Error('Your workspace is still being set up. Try again in a minute.');

    // Fictional test leads (reserved 555-01xx numbers). No consent attestation, no GHL contact, never texted for real:
    // the engine logs their texts and the agent can simulate replies from the Inbox.
    if (input.action === 'test_leads') return Response.json(await createTestLeads(E, s));

    const rows = Array.isArray(input.rows) ? input.rows.slice(0, 100) : [];
    if (!rows.length) throw new Error('No rows to import.');
    if (input.attested !== true) throw new Error('Confirm that these contacts gave consent to receive texts from your business.');
    if (!SOURCES.includes(input.source)) throw new Error('Choose where these leads came from.');
    const campaign = await E.Campaign.get(String(input.campaign_id || ''));
    if (!campaign || campaign.agent_email !== s.agent_email || campaign.location_id !== s.location_id) throw new Error('Choose one of your campaigns.');
    const batch = clean(input.batch_id, 64) || crypto.randomUUID();
    const seller = businessName(s);
    const attestedAt = new Date().toISOString();
    const attestedBy = ctx.user?.email || s.agent_email;
    const ip = (req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || '').split(',')[0].trim().slice(0, 64);
    const userAgent = (req.headers.get('user-agent') || '').slice(0, 200);
    // What the agent actually ticked. The registry scrub is optional: written consent already makes it unnecessary.
    const registryScrubbed = input.registry_scrubbed === true;
    const attestation = `${attestedBy} attested on ${attestedAt.slice(0, 10)} (import ${batch}): everyone in this file asked ${seller} for information and gave prior express written consent to receive texts from ${seller}; no one on it has asked us to stop; the agent can produce that consent if asked. Source: ${input.source}.${registryScrubbed ? ' The agent also attested that the list was scrubbed against the National Do Not Call Registry within the last 31 days.' : ''}`;
    const intake = { campaign, source: input.source, consentText: attestation, seller, batch, dncBasis: registryScrubbed ? 'registry_scrub' : 'written_consent' };

    const results: any[] = [];
    const work = async (row: any, i: number) => ({ i, ...(await intakeLead(E, s, row, intake, { ghl, scope, e164 })) });
    // 5 at a time keeps each agent well under GHL's per-location rate limit.
    for (let k = 0; k < rows.length; k += 5) {
      const chunk = await Promise.allSettled(rows.slice(k, k + 5).map((r: any, j: number) => work(r, k + j)));
      for (const [j, r] of chunk.entries()) results.push(r.status === 'fulfilled' ? r.value : { i: k + j, status: 'error', reason: String((r as any).reason?.message || 'Failed').slice(0, 160) });
    }
    const count = (st: string) => results.filter(r => r.status === st).length;
    // One ConsentRecord per lead that entered the system (duplicates and skips already have or never get one), written in bulk.
    const meta = { basis: 'agent_attestation' as const, attested_by: attestedBy, attested_at: attestedAt, ip, user_agent: userAgent, location_id: s.location_id || '' };
    const consentRecords = await writeConsentRecords(E, results.filter(r => ['imported', 'held'].includes(r.status) && r.lead_id).map(r => consentRecordFor(s, r, intake, meta)));
    // Proof of consent: who attested, when, from where, for which batch. One record per upload chunk.
    if (count('imported') || count('held')) await E.ControlAudit.create({
      agent_email: s.agent_email, location_id: s.location_id || '', actor_email: attestedBy, action: 'import_attested', occurred_at: attestedAt,
      details: { batch, source: input.source, attestation, dnc_basis: intake.dncBasis, registry_scrubbed: registryScrubbed, imported: count('imported'), held: count('held'), consent_records: consentRecords, campaign: campaign.name, ip, user_agent: userAgent },
    }).catch(() => {});
    if (count('imported')) await startCampaignsWithLeads(E, s).catch(() => 0);
    return Response.json({ imported: count('imported'), held: count('held'), duplicate: count('duplicate'), skipped: count('skipped'), errors: count('error'), results });
  } catch (e) { return failure(e as Error); }
}
