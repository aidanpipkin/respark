// Builds the lead profile the AI writes from. GHL is the source of truth for the
// lead's story (custom fields); this turns a raw contact into plain, named facts.
// Health, tobacco, consent and contact details are deliberately left out: the AI
// never needs them to write a text, and leaving them out means it can't leak them.
import { ghl } from './ghl.ts';
import { localContactId } from './rehearsal.ts';
import { conditions } from './guardrails.ts';

const FIELD_KEYS: Record<string, string> = {
  'Original Inquiry Date': 'original_inquiry_date',
  'Lead Source': 'lead_source',
  'Campaign': 'campaign',
  'Product Interest': 'product_interest',
  'Coverage Amount Requested': 'coverage_requested',
  'Who They Want to Protect': 'who_to_protect',
  'Reason for Coverage': 'reason_in_their_words',
  'Prior Outcome': 'prior_outcome',
  'Prior Notes': 'prior_notes',
  'Driver Type': 'driver_type',
  'Years Driving': 'years_driving',
  'Home Time Pattern': 'home_time_pattern',
  'Has Retirement Plan': 'has_retirement_plan',
  'Dependents': 'dependents',
  'Priority Reply': 'priority_reply',
};
const MAX_AGE_MS = 6 * 3600 * 1000;
// Fields the AI must never see, whatever an agent names them: consent records, health, money
// accounts and identity numbers. Everything else on the contact is fair context.
const PRIVATE = /consent|dnc|do not (call|text)|tobacco|smok|nicotine|health|medical|condition|diagnos|medicat|prescri|height|weight|bmi|ssn|social security|bank|routing|account (no|num)|card|license|password|dob|date of birth|birth ?date|income|salary|credit|beneficiary ssn|respark status|ai mode|last ai|opener variant|sms marketing/i;
const strip = (html: string) => String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

const clean = (v: unknown, max = 500) => {
  if (v === null || v === undefined) return '';
  const text = Array.isArray(v) ? v.join(', ') : String(v);
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
};
// Free-text notes are written by people and may mention health or other private
// details. Strip named conditions so they can never reach a text message.
const redact = (text: string) => text.replace(new RegExp(conditions.source, 'gi'), '[health detail removed]');

function monthsSince(iso: string) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / (30.44 * 86400000)));
}
function ageFrom(dob: string) {
  const t = Date.parse(dob);
  if (!Number.isFinite(t)) return null;
  const age = Math.floor((Date.now() - t) / (365.25 * 86400000));
  return age > 17 && age < 100 ? age : null;
}
function season(iso: string) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const name = ['winter', 'winter', 'spring', 'spring', 'spring', 'summer', 'summer', 'summer', 'fall', 'fall', 'fall', 'winter'][d.getUTCMonth()];
  return `${['January','February','March','April','May','June','July','August','September','October','November','December'][d.getUTCMonth()]} ${d.getUTCFullYear()} (${name})`;
}

export function profileFromContact(s: any, lead: any, contact: any) {
  const byId: Record<string, string> = {};
  for (const [id, name] of Object.entries(contact?.__fieldNames || {})) byId[id] = name as string;
  for (const [name, id] of Object.entries(s.custom_field_ids || {})) byId[id as string] = name;
  const facts: Record<string, any> = {};
  const other: Record<string, string> = {};
  for (const cf of contact?.customFields || []) {
    const name = byId[cf.id];
    const key = name && FIELD_KEYS[name];
    if (!key) {
      // Any other field the agent keeps on the contact (their own custom fields) is context too.
      const label = name || '';
      const v = clean(cf.value ?? cf.field_value ?? cf.fieldValue, 200);
      if (label && v && !PRIVATE.test(label) && !/^unknown$/i.test(v) && Object.keys(other).length < 25) other[label] = redact(v);
      continue;
    }
    const value = clean(cf.value ?? cf.field_value ?? cf.fieldValue, key === 'prior_notes' || key === 'reason_in_their_words' ? 800 : 200);
    if (value && !/^unknown$/i.test(value)) facts[key] = value;
  }
  // Facts captured by LeadRespark itself (CSV import columns, lead webhook) fill anything GHL lacks.
  const own = (lead.lead_facts && typeof lead.lead_facts === 'object') ? lead.lead_facts : {};
  for (const key of Object.values(FIELD_KEYS)) {
    if (!facts[key] && own[key]) facts[key] = clean(own[key], key === 'prior_notes' || key === 'reason_in_their_words' ? 800 : 200);
  }
  if (facts.prior_notes) facts.prior_notes = redact(facts.prior_notes);
  if (facts.reason_in_their_words) facts.reason_in_their_words = redact(facts.reason_in_their_words);
  if (facts.coverage_requested) {
    const n = Number(String(facts.coverage_requested).replace(/[^\d.]/g, ''));
    facts.coverage_requested = Number.isFinite(n) && n > 0 ? `${Math.round(n).toLocaleString('en-US')} (context only; never state amounts in a text)` : '';
    if (!facts.coverage_requested) delete facts.coverage_requested;
  }
  const inquiry = facts.original_inquiry_date || lead.inquiry_date || '';
  const profile: Record<string, any> = {
    first_name: clean(contact?.firstName || lead.first_name, 60),
    city: clean(contact?.city, 80),
    state: clean(lead.state || contact?.state, 20),
    timezone: clean(lead.timezone || contact?.timezone, 60),
    age: ageFrom(contact?.dateOfBirth || own.date_of_birth || '') ?? (Number(own.age) > 17 && Number(own.age) < 100 ? Number(own.age) : null),
    occupation: clean(own.occupation, 120),
    extra_details: own.extra && typeof own.extra === 'object' ? Object.entries(own.extra).slice(0, 15).map(([k, v]) => `${clean(k, 40)}: ${redact(clean(v, 200))}`).filter(x => !/:\s*$/.test(x)).join(' | ') : '',
    inquiry_when: inquiry ? season(inquiry) : '',
    months_since_inquiry: inquiry ? monthsSince(inquiry) : null,
    lead_source: facts.lead_source || clean(lead.lead_source, 120),
    product_interest: facts.product_interest || '',
    coverage_requested: facts.coverage_requested || '',
    who_to_protect: facts.who_to_protect || '',
    dependents: facts.dependents || '',
    reason_in_their_words: facts.reason_in_their_words || '',
    driver_type: facts.driver_type || '',
    years_driving: facts.years_driving || '',
    home_time_pattern: facts.home_time_pattern || '',
    has_retirement_plan: facts.has_retirement_plan || '',
    prior_outcome: facts.prior_outcome || '',
    prior_notes: facts.prior_notes || '',
    priority_reply: facts.priority_reply || (lead.discovery_topic === '1' ? '1 Family' : lead.discovery_topic === '2' ? '2 Retirement' : ''),
    other_details: Object.keys(other).length ? Object.entries(other).map(([k, v]) => `${k}: ${v}`).join(' | ').slice(0, 1500) : '',
    tags: [...new Set([...(contact?.tags || []), ...(lead.tags || [])].map((t: any) => String(t)).filter(t => !/^respark|^campaign-|^web-get-info$/i.test(t)))].slice(0, 15).join(', '),
    crm_notes: (contact?.__notes || []).length ? contact.__notes.join(' || ').slice(0, 2500) : '',
  };
  for (const k of Object.keys(profile)) if (profile[k] === '' || profile[k] === null) delete profile[k];
  return profile;
}

// Keys the writer is allowed to cite. Anything else it "remembers" is invented.
export const citableKeys = ['other_details','tags','crm_notes','first_name','city','state','age','occupation','extra_details','inquiry_when','months_since_inquiry','lead_source','product_interest','coverage_requested','who_to_protect','dependents','reason_in_their_words','driver_type','years_driving','home_time_pattern','has_retirement_plan','prior_outcome','prior_notes','priority_reply'];

// Names of every custom field in the agent's CRM (theirs and ours), cached per location for 6 hours.
const fieldNameCache = new Map<string, { at: number; names: Record<string, string> }>();
async function fieldNames(s: any) {
  const hit = fieldNameCache.get(s.location_id);
  if (hit && Date.now() - hit.at < MAX_AGE_MS) return hit.names;
  const names: Record<string, string> = {};
  try {
    const r = await ghl(s, `/locations/${encodeURIComponent(s.location_id)}/customFields`);
    for (const f of r.customFields || []) if (f.id && f.name) names[f.id] = String(f.name);
  } catch { /* fall back to the fields LeadRespark created */ }
  fieldNameCache.set(s.location_id, { at: Date.now(), names });
  return names;
}

export async function leadProfile(base44: any, s: any, lead: any, force = false) {
  const cached = lead.lead_snapshot?.profile;
  const fresh = cached && Date.now() - Date.parse(lead.lead_snapshot?.fetched_at || '') < MAX_AGE_MS;
  if (cached && fresh && !force) return cached;
  let contact: any = {};
  if (s?.connected && s.ghl_token && lead.ghl_contact_id && !localContactId(lead.ghl_contact_id)) {
    const res = await ghl(s, `/contacts/${encodeURIComponent(lead.ghl_contact_id)}`);
    contact = res.contact || {};
    if (contact.locationId && contact.locationId !== s.location_id) throw new Error('Contact access denied.');
    contact.__fieldNames = await fieldNames(s);
    // The agent's notes on this person in their CRM: newest first, health details removed.
    try {
      const n = await ghl(s, `/contacts/${encodeURIComponent(lead.ghl_contact_id)}/notes`);
      contact.__notes = (n.notes || []).sort((a: any, b: any) => String(b.dateAdded || '').localeCompare(String(a.dateAdded || ''))).slice(0, 8)
        .map((x: any) => `${String(x.dateAdded || '').slice(0, 10)}: ${redact(strip(x.body)).slice(0, 500)}`).filter((t: string) => t.length > 12);
    } catch { contact.__notes = []; }
  }
  const profile = profileFromContact(s, lead, contact);
  const saved = await base44.asServiceRole.entities.Lead.update(lead.id, { lead_snapshot: { ...(lead.lead_snapshot || {}), profile, fetched_at: new Date().toISOString() } });
  // Keep the caller's lead current: the send lock (lockLead) compares updated_date, so a stale copy after this
  // write made every first send to a lead throw Busy and wait for the next run.
  if (saved && typeof saved === 'object' && saved.id === lead.id) Object.assign(lead, saved);
  return profile;
}
