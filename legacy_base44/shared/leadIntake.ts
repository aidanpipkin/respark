// Shared by CSV import and the fresh-lead webhook: normalizes a raw lead row and
// turns it into a GHL contact + LeadRespark lead enrolled in a campaign.
import { isTestPhone } from './rehearsal.ts';
export const STATE_TZ: Record<string, string> = {
  CT: 'America/New_York', DE: 'America/New_York', DC: 'America/New_York', FL: 'America/New_York', GA: 'America/New_York', ME: 'America/New_York', MD: 'America/New_York', MA: 'America/New_York', MI: 'America/Detroit', NH: 'America/New_York', NJ: 'America/New_York', NY: 'America/New_York', NC: 'America/New_York', OH: 'America/New_York', PA: 'America/New_York', RI: 'America/New_York', SC: 'America/New_York', VT: 'America/New_York', VA: 'America/New_York', WV: 'America/New_York', IN: 'America/Indiana/Indianapolis', KY: 'America/New_York',
  AL: 'America/Chicago', AR: 'America/Chicago', IL: 'America/Chicago', IA: 'America/Chicago', KS: 'America/Chicago', LA: 'America/Chicago', MN: 'America/Chicago', MS: 'America/Chicago', MO: 'America/Chicago', NE: 'America/Chicago', ND: 'America/Chicago', OK: 'America/Chicago', SD: 'America/Chicago', TN: 'America/Chicago', TX: 'America/Chicago', WI: 'America/Chicago',
  AZ: 'America/Phoenix', CO: 'America/Denver', ID: 'America/Boise', MT: 'America/Denver', NM: 'America/Denver', UT: 'America/Denver', WY: 'America/Denver',
  CA: 'America/Los_Angeles', NV: 'America/Los_Angeles', OR: 'America/Los_Angeles', WA: 'America/Los_Angeles', AK: 'America/Anchorage', HI: 'Pacific/Honolulu',
};
export const STATE_NAMES: Record<string, string> = { alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE', 'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY' };

export const clean = (v: any, n = 80) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
// Columns that must never reach the AI (or a text), whatever the agent's file contains.
const PRIVATE_COLUMN = /(ssn|social.?sec|medical|health|condition|diagnos|medication|prescription|tobacco|smok|height|weight|bmi|bank|account.?n|routing|card|password|license.?n|driver.?lic|\bdl\b)/i;
const FACT_KEYS = ['product_interest', 'prior_notes', 'prior_outcome', 'reason_in_their_words', 'who_to_protect', 'dependents', 'coverage_requested', 'date_of_birth', 'age', 'occupation'];
export function leadFacts(row: any) {
  const facts: Record<string, any> = {};
  const f = row?.facts && typeof row.facts === 'object' ? row.facts : {};
  for (const k of FACT_KEYS) { const v = clean(f[k], k === 'prior_notes' || k === 'reason_in_their_words' ? 1500 : 200); if (v) facts[k] = v; }
  if (facts.date_of_birth) { const d = birthDate(facts.date_of_birth); if (d) facts.date_of_birth = d; else delete facts.date_of_birth; }
  const extra: Record<string, string> = {};
  const x = row?.extra && typeof row.extra === 'object' ? row.extra : {};
  for (const [k, v] of Object.entries(x).slice(0, 20)) { const key = clean(k, 40), val = clean(v, 300); if (key && val && !PRIVATE_COLUMN.test(key)) extra[key] = val; }
  if (Object.keys(extra).length) facts.extra = extra;
  return facts;
}
export function stateCode(v: any) { const t = clean(v, 40); if (/^[A-Za-z]{2}$/.test(t)) return t.toUpperCase(); return STATE_NAMES[t.toLowerCase()] || ''; }
export function dateOnly(v: any) { const t = clean(v, 40); if (!t) return ''; const d = new Date(t); return Number.isFinite(d.getTime()) && d.getFullYear() > 1990 && d.getTime() <= Date.now() ? d.toISOString().slice(0, 10) : ''; }

export type IntakeOptions = {
  campaign: any; source: string; consentText: string; seller: string; batch: string; leadSource?: string; tags?: string[]; consentDate?: string;
  /** Why the lead may be texted without a registry scrub: 'written_consent' (default), 'registry_scrub', or '' when no consent was given. */
  dncBasis?: string;
  /** false when the submission carried no consent: the lead is kept but never texted (CSV imports are always attested). */
  consented?: boolean;
};

/** Where the proof of consent came from: the agent's upload attestation, the hosted web form, or the lead API. */
export type ConsentBasis = 'agent_attestation' | 'web_form' | 'webhook';
export type ConsentMeta = { basis: ConsentBasis; attested_by: string; attested_at: string; ip: string; user_agent: string; location_id: string; page_url?: string };

/** One ConsentRecord row for an imported/held lead. `wording` and `consent_date` come from intakeLead's result. */
export function consentRecordFor(s: any, r: { lead_id?: string; consent_wording?: string; consent_date?: string }, o: IntakeOptions, meta: ConsentMeta) {
  return {
    agent_email: s.agent_email, location_id: meta.location_id || s.location_id || '', lead_id: r.lead_id, submission_id: '',
    basis: meta.basis, source: o.source, wording: r.consent_wording || o.consentText, consent_text: r.consent_wording || o.consentText,
    consent_date: r.consent_date || o.consentDate || meta.attested_at.slice(0, 10), seller_named: o.seller,
    attested_by: meta.attested_by, attested_at: meta.attested_at, timestamp: meta.attested_at, consent_checked: true,
    ip: meta.ip || '', user_agent: meta.user_agent || '', page_url: meta.page_url || '', batch_id: o.batch,
  };
}

/** Writes consent records in chunks, so a 1,000-row import is ten calls rather than a thousand. Never throws. */
export async function writeConsentRecords(E: any, records: any[]) {
  let written = 0;
  for (let i = 0; i < records.length; i += 100) {
    const chunk = records.slice(i, i + 100);
    try { await E.ConsentRecord.bulkCreate(chunk); written += chunk.length; }
    catch { for (const r of chunk) { try { await E.ConsentRecord.create(r); written++; } catch { /* the lead keeps its own consent fields */ } } }
  }
  return written;
}

/** Creates (or skips) one lead: GHL contact upsert, opt-out check, LeadRespark lead enrolled in the campaign. */
export async function intakeLead(E: any, s: any, row: any, o: IntakeOptions, deps: { ghl: any; scope: any; e164: any }) {
  const phone = deps.e164(row.phone);
  const first = clean(row.first_name), last = clean(row.last_name), email = clean(row.email, 254).toLowerCase(), state = stateCode(row.state);
  if (!phone || !/^\+1[2-9]\d{9}$/.test(phone)) return { status: 'skipped', reason: 'Missing or invalid US mobile number' };
  // Fictional 555-01xx numbers never carry a consent attestation; they are created by the test-lead action instead.
  if (isTestPhone(phone)) return { status: 'skipped', reason: 'Use the Create test leads button for fictional numbers' };
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { status: 'skipped', reason: 'Invalid email' };
  const dup = await E.Lead.filter({ agent_email: s.agent_email, phone }, { limit: 1 });
  if (dup.items[0]) return { status: 'duplicate', reason: 'Already in your contacts', lead_id: dup.items[0].id };
  const tag = `campaign-${String(o.campaign.name || 'import').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}`;
  const up = await deps.ghl(s, '/contacts/upsert', 'POST', { locationId: s.location_id, firstName: first || undefined, lastName: last || undefined, phone, email: email || undefined, state: state || undefined, source: o.leadSource || 'LeadRespark import', tags: ['respark-import', tag, ...(o.tags || [])] });
  const contact = up.contact;
  if (!contact?.id) return { status: 'error', reason: 'Could not create the contact' };
  if (contact.dnd || contact.dndSettings?.SMS?.status === 'active' || (contact.tags || []).includes('respark-opted-out')) return { status: 'skipped', reason: 'Contact previously opted out' };
  const licensed: string[] = s.licensed_states || [];
  const eligible = !!state && licensed.includes(state);
  const consented = o.consented !== false;
  const consentDate = consented ? (dateOnly(row.consent_date) || o.consentDate || dateOnly(row.inquiry_date) || new Date().toISOString().slice(0, 10)) : '';
  const consentWording = consented ? (clean(row.consent_wording, 2000) || o.consentText) : '';
  // Why this number may be texted without a National DNC Registry scrub: documented prior express written consent
  // (the agent's attestation or the lead's own submission), or the agent's own registry scrub. The agent's opt-out
  // list is always checked above (GHL DND / opted-out tag, plus existing contacts via the duplicate check).
  const dncBasis = consented ? (o.dncBasis || 'written_consent') : '';
  const texts = eligible && consented;
  const saved = await E.Lead.upsert([{
    ...deps.scope(s), ghl_contact_id: contact.id, campaign_id: o.campaign.id, first_name: contact.firstName || first, last_name: contact.lastName || last,
    phone: contact.phone || phone, email: contact.email || email, state: contact.state || state, timezone: STATE_TZ[state] || '',
    lead_source: clean(row.lead_source, 120) || o.source, inquiry_date: dateOnly(row.inquiry_date), lead_facts: leadFacts(row), import_batch: o.batch,
    consent_source: consented ? o.source : '', consent_date: consentDate, consent_text: consented ? o.consentText : '', consent_wording: consentWording, consent_seller_named: consented ? o.seller : '',
    state_eligible: eligible, dnc_checked: !!dncBasis, dnc_basis: dncBasis, current_step: 0, next_send_at: '', step1_delivered: false,
    status: texts ? 'queued' : 'closed',
    eligibility_reason: !consented ? 'Consent flag missing. Add documented consent on the contact before texting.' : eligible ? `Added with consent (${o.source}).` : state ? `Not licensed in ${state}.` : 'State unknown; add the state to text this contact.',
    sequence_paused: !texts, ai_paused: !texts, sequence_waiting_review: false,
  }], { key: ['agent_email', 'ghl_contact_id'] });
  return {
    status: texts ? 'imported' : 'held', reason: texts ? '' : !consented ? 'Consent flag missing' : state ? `Not licensed in ${state}` : 'State missing',
    lead_id: saved?.records?.[0]?.id, consent_wording: consentWording, consent_date: consentDate,
  };
}

export function birthDate(v: any) { const t = clean(v, 40); if (!t) return ''; const d = new Date(t); return Number.isFinite(d.getTime()) && d.getFullYear() > 1900 && d.getTime() < Date.now() - 16 * 365 * 86400000 ? d.toISOString().slice(0, 10) : ''; }
