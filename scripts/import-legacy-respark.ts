// One-time import of the per-agent Respark stack's leads (legacy_respark/data/ResparkLead.jsonl for Aidan,
// RileyResparkLead.jsonl for Riley) into the multi-tenant `lead` + `message_log` tables.
//
//   DATABASE_URL=postgres://postgres:...@db.<ref>.supabase.co:5432/postgres \
//   deno run -A scripts/import-legacy-respark.ts --agent aidan@example.com --file legacy_respark/data/ResparkLead.jsonl \
//       [--campaign "Trucker IUL, Aidan's voice"] [--consent legacy_respark/data/SMSConsent.jsonl] \
//       [--assume-vendor-consent] [--limit N] [--dry-run]
//
// What it does, per legacy row (see docs/LEGACY_RESPARK_FOLD_IN.md for the mapping table):
//   - one `lead` for the agent, keyed on (agent_email, phone): re-running updates the same rows (idempotent)
//   - status active → queued / in_sequence, conversing → replied, booked → booked, manual → needs_human,
//     stopped (STOP / DND / declined) → opted_out, every other stopped / completed / recovery* → closed
//   - current_step translated onto the trucker_aidan playbook's step numbers (its fresh burst occupies steps 2-3)
//   - the `conversation` array → `message_log` rows (deterministic ids, so re-runs do not duplicate them)
//   - consent from SMSConsent.jsonl where the phone matches; otherwise the lead is kept but cannot be texted
//     (the engine demands documented consent) unless --assume-vendor-consent records the vendor-form consent
//     the legacy stack relied on.
// Nothing is sent: imported leads with next_send_at in the past are picked up by the regular sender only when
// the agent is live and the campaign is active.
import { parseArgs } from 'node:util';
import { connect, serviceEntities } from '../supabase/functions/_shared/entities.ts';
import { STATE_TZ, stateCode } from '../supabase/functions/_shared/leadIntake.ts';
import { CAMPAIGN_NAME as AIDAN_CAMPAIGN } from '../supabase/functions/_shared/truckerAidanSeed.ts';

const { values: args } = parseArgs({
  options: {
    agent: { type: 'string' }, file: { type: 'string' }, campaign: { type: 'string', default: AIDAN_CAMPAIGN }, consent: { type: 'string' },
    'assume-vendor-consent': { type: 'boolean', default: false }, limit: { type: 'string' }, 'dry-run': { type: 'boolean', default: false },
  },
});
if (!args.agent || !args.file) { console.error('usage: import-legacy-respark.ts --agent <email> --file <ResparkLead.jsonl> [--campaign name] [--consent SMSConsent.jsonl] [--assume-vendor-consent] [--limit N] [--dry-run]'); Deno.exit(2); }
const dryRun = !!args['dry-run'];
const url = Deno.env.get('DATABASE_URL') || Deno.env.get('SUPABASE_DB_URL');
if (!url) { console.error('Set DATABASE_URL'); Deno.exit(2); }

async function readJsonl(path: string): Promise<any[]> {
  const text = await Deno.readTextFile(path);
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
}
const e164 = (raw: unknown) => { const d = String(raw || '').replace(/\D/g, ''); return d.length === 10 ? `+1${d}` : d.length === 11 && d.startsWith('1') ? `+${d}` : ''; };
const dateOnly = (v: unknown) => { const t = Date.parse(String(v || '')); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : ''; };
const iso = (v: unknown) => { const t = Date.parse(String(v || '')); return Number.isFinite(t) ? new Date(t).toISOString() : ''; };
async function stableId(...parts: string[]) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.join('|')));
  return `legacy-${Array.from(new Uint8Array(h)).slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const OPT_OUT = /\b(stop|unsubscribe|dnd|do not text|declined|not interested|negative|opt)/i;

/** Product lead status + engine fields for a legacy status. */
function mapStatus(row: any, sent: number) {
  const st = String(row.status || '');
  const reason = String(row.stop_reason || '');
  switch (st) {
    case 'active': return { status: sent > 0 ? 'in_sequence' : 'queued', paused: false };
    case 'conversing': return { status: 'replied', paused: true };
    case 'booked': return { status: 'booked', paused: true };
    case 'manual': return { status: 'needs_human', paused: true, needs_human_reason: reason || 'Taken over by the agent in the previous system.' };
    case 'stopped': return OPT_OUT.test(reason) ? { status: 'opted_out', paused: true } : { status: 'closed', paused: true };
    default: return { status: 'closed', paused: true }; // completed, recovery, recovery_replied, recovery_stopped, recovery_done
  }
}

/**
 * Legacy step index → product current_step for the trucker_aidan playbook. Legacy aged series: D1 then D2..D30
 * (indexes 0..13); fresh track: D1, F2, F3, then D2..D30. Product numbering: D1 = 1, F2 = 2, F3 = 3, D2.. = 4...
 * Aged leads skip steps 2-3 automatically, so after k aged texts the next product step is k + 3 (k >= 1).
 */
function mapStep(sentSeq: number, fresh: boolean) {
  if (sentSeq <= 0) return 0;
  if (fresh) return sentSeq; // F2/F3 land on 2/3 and D2.. on 4.. in both systems
  return sentSeq + 2;
}

const sql = connect(url, { max: 2 });
const E: any = serviceEntities(sql);
try {
  const agentEmail = String(args.agent).toLowerCase().trim();
  const s = (await E.AgentSettings.filter({ agent_email: agentEmail }, { limit: 1 })).items[0];
  if (!s) throw new Error(`No agent_settings row for ${agentEmail}. Create the agent first.`);
  const campaign = (await E.Campaign.filter({ agent_email: agentEmail, name: args.campaign }, { limit: 1 })).items[0];
  if (!campaign) throw new Error(`Campaign "${args.campaign}" is not installed for ${agentEmail}. Install the playbook first (Admin > Diagnostics > install_playbook trucker_aidan, or Playbooks in the app).`);
  const seller = s.brand_name || s.legal_business_name || s.display_name || agentEmail;

  const consentByPhone = new Map<string, any>();
  if (args.consent) for (const c of await readJsonl(args.consent)) { const p = e164(c.phone); if (p && !c.revoked && !c.consent_withdrawn) consentByPhone.set(p, c); }

  const rows = await readJsonl(args.file);
  const limit = Number(args.limit) || rows.length;
  const batch = `legacy-respark:${agentEmail}:${new Date().toISOString().slice(0, 10)}`;
  const counts: Record<string, number> = { leads: 0, skipped: 0, messages: 0, with_consent: 0, without_consent: 0 };
  const statuses: Record<string, number> = {};

  for (const row of rows.slice(0, limit)) {
    const phone = e164(row.phone);
    if (!phone) { counts.skipped++; console.warn(`skip ${row.id}: no usable phone`); continue; }
    const convo: any[] = Array.isArray(row.conversation) ? row.conversation : [];
    const seqSent = convo.filter((m) => /sequence/.test(String(m.role || ''))).length || Number(row.messages_sent) || Number(row.step) || 0;
    const fresh = /fresh/i.test(String(row.lead_status || '')) || (row.seq_log || []).some((l: string) => /FRESH/.test(String(l))) || convo.some((m) => /^F[23] /.test(String(m.label || '')));
    const m = mapStatus(row, seqSent);
    const state = stateCode(row.state);
    const consent = consentByPhone.get(phone);
    const consentFields = consent
      ? { consent_source: `Website form (${consent.prospect_source || 'SMSConsent'}, legacy import)`, consent_date: dateOnly(consent.consent_timestamp || consent.created_date), consent_wording: String(consent.consent_text || ''), consent_text: String(consent.consent_text || ''), consent_seller_named: seller, dnc_checked: true, dnc_basis: 'written_consent' }
      : args['assume-vendor-consent']
        ? { consent_source: 'Vendor lead form (legacy Respark import)', consent_date: dateOnly(row.requested_at || row.lead_added_date || row.created_date), consent_wording: `Consent captured on the lead vendor's form when the consumer requested a Trucker IUL quote (${row.lead_status || 'vendor lead'}); carried over from the previous Respark stack.`, consent_text: 'Vendor form consent (legacy import)', consent_seller_named: seller, dnc_checked: true, dnc_basis: 'written_consent' }
        : { consent_source: '', consent_date: '', consent_wording: '', consent_text: '', consent_seller_named: '', dnc_checked: false, dnc_basis: '' };
    counts[consent || args['assume-vendor-consent'] ? 'with_consent' : 'without_consent']++;
    const canText = !!consentFields.consent_source && ['queued', 'in_sequence'].includes(m.status);
    const lastOut = convo.filter((x) => x.role !== 'lead').map((x) => iso(x.at)).filter(Boolean).sort().at(-1) || iso(row.last_sms_at);
    const lastIn = convo.filter((x) => x.role === 'lead').map((x) => iso(x.at)).filter(Boolean).sort().at(-1) || iso(row.last_inbound_at);
    const facts: Record<string, any> = {};
    if (row.driver_type) facts.occupation = `CDL driver (${row.driver_type})`;
    if (row.age) facts.age = String(row.age);
    if (row.dob) facts.date_of_birth = dateOnly(row.dob) || String(row.dob);
    if (row.beneficiary_relationship) facts.who_to_protect = String(row.beneficiary_relationship);
    if (row.iul_goal) facts.reason_in_their_words = String(row.iul_goal);
    if (row.profile && typeof row.profile === 'object' && Object.keys(row.profile).length) facts.extra = Object.fromEntries(Object.entries(row.profile).slice(0, 20).map(([k, v]) => [String(k).slice(0, 40), String(v).slice(0, 300)]));
    const lead: Record<string, unknown> = {
      id: String(row.id || await stableId(agentEmail, phone)), agent_email: agentEmail, location_id: s.location_id || '', campaign_id: campaign.id,
      ghl_contact_id: String(row.ghl_contact_id || ''), ghl_opportunity_id: String(row.ghl_opportunity_id || ''),
      first_name: String(row.first_name || ''), last_name: String(row.last_name || ''), phone, email: String(row.email || '').toLowerCase(),
      state, timezone: String(row.timezone || STATE_TZ[state] || ''), lead_source: `Legacy Respark (${row.lead_status || 'aged request'})`,
      inquiry_date: dateOnly(row.requested_at || row.lead_added_date || row.created_date), lead_facts: facts, import_batch: batch, tags: ['legacy-respark'],
      ...consentFields, state_eligible: !!state && (s.licensed_states || []).includes(state),
      status: m.status, cadence: 'standard', variant: 'A', current_step: mapStep(seqSent, fresh), step1_delivered: seqSent > 0,
      sequence_started_at: iso(row.enrolled_at || row.created_date) || new Date().toISOString(),
      next_send_at: canText ? (iso(row.next_send_at) || new Date().toISOString()) : '',
      sequence_paused: !canText, ai_paused: m.paused && m.status !== 'replied' ? true : false, sequence_waiting_review: false,
      last_outbound_at: lastOut || '', last_inbound_at: lastIn || '', needs_human_reason: (m as any).needs_human_reason || '',
      eligibility_reason: consentFields.consent_source ? `Imported from the previous Respark stack (${row.status}).` : `Imported from the previous Respark stack (${row.status}); no consent record found, so it will not be texted.`,
      disposition_note: String(row.stop_reason || '').slice(0, 500),
    };
    statuses[m.status] = (statuses[m.status] || 0) + 1;
    counts.leads++;
    if (dryRun) { if (counts.leads <= 3) console.log(JSON.stringify({ lead: { ...lead, lead_facts: undefined }, messages: convo.length }, null, 0)); counts.messages += convo.length; continue; }
    const saved = await E.Lead.upsert([lead], { key: ['agent_email', 'phone'] });
    const leadId = saved.records[0]?.id || lead.id;
    const logs = [];
    for (const msg of convo) {
      const at = iso(msg.at); if (!at || !msg.text) continue;
      const inbound = msg.role === 'lead';
      logs.push({
        id: await stableId(String(leadId), at, String(msg.role), String(msg.text).slice(0, 40)), agent_email: agentEmail, location_id: s.location_id || '', lead_id: leadId, campaign_id: campaign.id,
        event_type: inbound ? 'inbound_sms' : 'sms_sent', direction: inbound ? 'inbound' : 'outbound', source: inbound ? 'lead' : /sequence/.test(String(msg.role)) ? 'sequence' : 'ai',
        body: String(msg.text).slice(0, 2000), status: inbound ? 'received' : 'sent', occurred_at: at,
      });
    }
    if (logs.length) { await E.MessageLog.upsert(logs, { key: 'id' }); counts.messages += logs.length; }
  }
  console.log(`SUMMARY ${JSON.stringify({ dry_run: dryRun, agent: agentEmail, campaign: campaign.name, batch, ...counts, statuses })}`);
} finally {
  await sql.end().catch(() => {});
}
