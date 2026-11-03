// Admin: run a dress rehearsal with thousands of fictional leads through the real engine, with
// texting, charging and GHL switched off. { action: 'start' | 'status' | 'stop' }.
import { adminContext } from '../../shared/agentAccess.ts';
import { failure } from '../../shared/ghl.ts';
import { REHEARSAL_EMAIL, REHEARSAL_LOCATION } from '../../shared/rehearsal.ts';
import { raise } from '../../shared/signals.ts';
import { STAGE_QUERIES } from '../../shared/leadStages.ts';
import { CAMPAIGN_NAME } from '../../shared/lifeSeed.ts';

const STATES: [string, string][] = [['TX', 'America/Chicago'], ['AR', 'America/Chicago'], ['OK', 'America/Chicago'], ['MO', 'America/Chicago'], ['TN', 'America/Chicago'], ['GA', 'America/New_York'], ['FL', 'America/New_York'], ['OH', 'America/New_York'], ['AZ', 'America/Phoenix'], ['CO', 'America/Denver']];
const FIRST = ['Marcus', 'Dale', 'Jose', 'Tanya', 'Rick', 'Andre', 'Shawn', 'Lisa', 'Carl', 'Maria', 'Derek', 'Wes', 'Tony', 'Brenda', 'Luis'];
const LAST = ['Rehearsal', 'Testlead', 'Example', 'Sample', 'Fictional'];
const ALL_STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');
const KEY = 'rehearsal:last';

async function save(E: any, data: any) { await E.EngineCursor.upsert([{ key: KEY, cursor: JSON.stringify(data).slice(0, 20000) }], { key: 'key' }); }
async function load(E: any) { try { return JSON.parse((await E.EngineCursor.filter({ key: KEY }, { limit: 1 })).items[0]?.cursor || 'null'); } catch { return null; } }

async function cleanup(E: any) {
  const me = { agent_email: REHEARSAL_EMAIL };
  for (const ent of ['Lead', 'MessageLog', 'ConversationSummary', 'MessageDispatch', 'AIDraft', 'Appointment']) {
    try { await E[ent].deleteMany(me); } catch (e) { console.error('[rehearsal] cleanup', ent, (e as Error).message); }
  }
  const camps = (await E.Campaign.filter(me, { limit: 20, fields: ['id'] })).items;
  for (const c of camps) { try { await E.SequenceStep.deleteMany({ campaign_id: c.id }); } catch { /* none */ } }
  try { await E.Campaign.deleteMany(me); } catch { /* none */ }
}

async function ensureAgent(E: any) {
  const fields = {
    agent_email: REHEARSAL_EMAIL, status: 'live', connected: true, ghl_token: 'rehearsal', token_kind: 'rehearsal', location_id: REHEARSAL_LOCATION,
    phone_number: '+15550100000', a2p_status: 'approved', licensed_states: ALL_STATES, home_timezone: 'America/Chicago', mode: 'autopilot',
    first_name: 'Rehearsal', last_name: 'Agent', display_name: 'Rehearsal Agent', brand_name: 'Rehearsal Agency', self_serve: false,
  };
  const existing = (await E.AgentSettings.filter({ agent_email: REHEARSAL_EMAIL }, { limit: 1 })).items[0];
  return existing ? await E.AgentSettings.update(existing.id, fields) : await E.AgentSettings.create(fields);
}

const LEGACY_CAMPAIGN = 'Trucker IUL Respark';
async function cloneCampaign(E: any, callerEmail = '') {
  // Prefer the caller's copy of the current default playbook, then anyone's, then the legacy trucker playbook.
  const find = async (q: any) => (await E.Campaign.filter({ ...q, agent_email: { $ne: REHEARSAL_EMAIL } }, { sort: 'created_date', limit: 1 })).items[0];
  const source = (callerEmail ? await find({ name: CAMPAIGN_NAME, agent_email: callerEmail }) : null) || await find({ name: CAMPAIGN_NAME }) || await find({ name: LEGACY_CAMPAIGN });
  if (!source) throw new Error(`No ${CAMPAIGN_NAME} campaign to copy. Provision one agent first.`);
  const { id, created_date, updated_date, created_by, created_by_id, ...rest } = source;
  const camp = await E.Campaign.create({ ...rest, agent_email: REHEARSAL_EMAIL, location_id: REHEARSAL_LOCATION, status: 'active', mode: 'autopilot', name: `${source.name} (rehearsal)` });
  const steps = (await E.SequenceStep.filter({ campaign_id: source.id }, { limit: 100 })).items;
  if (!steps.length) throw new Error('The source campaign has no sequence steps.');
  await E.SequenceStep.bulkCreate(steps.map((st: any) => { const { id: _i, created_date: _c, updated_date: _u, created_by: _b, created_by_id: _bi, ...r } = st; return { ...r, campaign_id: camp.id, agent_email: REHEARSAL_EMAIL, location_id: REHEARSAL_LOCATION }; }));
  return camp;
}

async function timed<T>(fn: () => Promise<T>) { const t = Date.now(); const v = await fn(); return { ms: Date.now() - t, v }; }

export default async function (req: Request) {
  try {
    const { base44, user } = await adminContext(req);
    const E = base44.asServiceRole.entities;
    const input = await req.json().catch(() => ({}));

    if (input.action === 'start') {
      const total = Math.min(5000, Math.max(100, Number(input.count) || 5000));
      const started = Date.now();
      await cleanup(E);
      await ensureAgent(E);
      await E.EngineCursor.upsert([{ key: 'rehearsal:ai', cursor: input.ai ? 'on' : 'off' }], { key: 'key' });
      const camp = await cloneCampaign(E, user?.email || '');
      const now = new Date().toISOString();
      let created = 0;
      for (let i = 0; i < total; i += 250) {
        const batch = Array.from({ length: Math.min(250, total - i) }, (_, k) => {
          const n = i + k, [state, tz] = STATES[n % STATES.length];
          return {
            agent_email: REHEARSAL_EMAIL, location_id: REHEARSAL_LOCATION, campaign_id: camp.id, ghl_contact_id: `rh:${n}`,
            first_name: FIRST[n % FIRST.length], last_name: `${LAST[n % LAST.length]} ${n}`, phone: `+1555${String(2000000 + n).padStart(7, '0')}`,
            state, timezone: tz, state_eligible: true, status: 'queued', sequence_paused: false, sequence_waiting_review: false, current_step: 0, next_send_at: now,
            consent_source: 'rehearsal', consent_date: now, consent_wording: 'Fictional rehearsal lead. Never texted.', consent_seller_named: 'Rehearsal Agency', dnc_checked: true,
            lead_source: 'Rehearsal', inquiry_date: '2026-02-14', import_batch: 'rehearsal',
            lead_facts: { occupation: 'Owner-operator truck driver', extra_details: 'Fictional rehearsal lead' },
          };
        });
        await E.Lead.bulkCreate(batch); created += batch.length;
      }
      const seed_ms = Date.now() - started;
      await save(E, { status: 'running', started_at: now, total, ai: !!input.ai, seed_ms, created });
      return Response.json({ ok: true, total, seed_ms });
    }

    if (input.action === 'stop') {
      const last = await load(E);
      const agent = (await E.AgentSettings.filter({ agent_email: REHEARSAL_EMAIL }, { limit: 1 })).items[0];
      if (agent) await E.AgentSettings.update(agent.id, { status: 'paused' });
      if (input.cleanup !== false) await cleanup(E);
      await save(E, { ...(last || {}), status: 'stopped', stopped_at: new Date().toISOString() });
      return Response.json({ ok: true });
    }

    // status: measure progress, engine throughput and how fast the agent-facing views answer at this size.
    const last = await load(E);
    if (!last) return Response.json({ rehearsal: null });
    const me = { agent_email: REHEARSAL_EMAIL };
    const [totalLeads, queued, texting, flagged, sent, firstLog, lastLog, uncertain] = await Promise.all([
      E.Lead.count(me), E.Lead.count({ ...me, status: 'queued' }), E.Lead.count({ ...me, status: 'in_sequence' }), E.Lead.count({ ...me, status: 'needs_human' }),
      E.MessageLog.count({ ...me, event_type: 'sms_sent' }),
      E.MessageLog.filter({ ...me, event_type: 'sms_sent' }, { sort: 'occurred_at', limit: 1, fields: ['occurred_at'] }),
      E.MessageLog.filter({ ...me, event_type: 'sms_sent' }, { sort: '-occurred_at', limit: 1, fields: ['occurred_at'] }),
      E.MessageDispatch.count({ ...me, state: 'uncertain' }),
    ]);
    // The same queries the Leads page and Inbox run, timed at this lead count.
    const stages = await timed(() => Promise.all(Object.values(STAGE_QUERIES).map((q: any) => E.Lead.count({ $and: [me, q] }))));
    const list = await timed(() => E.Lead.filter(me, { sort: '-last_outbound_at', limit: 50 }));
    const search = await timed(() => E.Lead.filter({ ...me, first_name: { $regex: 'Marc', $options: 'i' } }, { limit: 50 }));
    const inbox = await timed(() => E.ConversationSummary.filter(me, { sort: '-last_time', limit: 50 }));
    const first = firstLog.items[0]?.occurred_at, lastAt = lastLog.items[0]?.occurred_at;
    const minutes = first && lastAt ? Math.max(1, (Date.parse(lastAt) - Date.parse(first)) / 60000) : 0;
    const perMin = minutes ? Math.round((sent / minutes) * 10) / 10 : 0;
    // A real agent starts 25 new leads per 5-minute run, only inside the sending windows (about 4 hours a day).
    const realPerDay = 25 * 12 * 4;
    const result = {
      ...last, checked_at: new Date().toISOString(),
      progress: { total: totalLeads, queued, texting, flagged, sent, uncertain, percent: totalLeads ? Math.round(((totalLeads - queued) / totalLeads) * 100) : 0 },
      throughput: { first_send: first || null, last_send: lastAt || null, per_minute: perMin },
      speed_ms: { leads_stage_counts: stages.ms, leads_list: list.ms, leads_search: search.ms, inbox_list: inbox.ms },
      projection: { real_agent_first_texts_per_day: realPerDay, days_to_text_5000: Math.ceil(5000 / realPerDay) },
    };
    if (last.status === 'running' && queued === 0 && totalLeads > 0) {
      result.status = 'complete';
      result.completed_at = new Date().toISOString();
      await raise(base44, { key: `rehearsal:${last.started_at}`, kind: 'rehearsal', severity: flagged || uncertain ? 'warning' : 'info', title: `Rehearsal finished: ${sent.toLocaleString()} texts through the engine`, detail: `${flagged} flagged for review, ${uncertain} uncertain. Peak ${perMin}/min. Leads page counts ${stages.ms}ms, list ${list.ms}ms, inbox ${inbox.ms}ms.`, notifyOwner: false });
    }
    await save(E, result);
    return Response.json({ rehearsal: result });
  } catch (e) { return failure(e as Error); }
}
