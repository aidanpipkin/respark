// Lead-vendor payload adapters for the fresh-lead webhook (leadWebhook?key=<agent key>&vendor=<name>).
// Each adapter turns a vendor's own payload shape into the generic fields leadWebhook.normalize()
// understands, so an agent pastes one URL per vendor and nothing else changes downstream.
//
// Field names come from the per-agent stack this replaces (legacy_respark premiumTruckerWebhook.ts
// and goatLeadWebhook.ts) and from real deliveries in legacy_respark/data/GoatLead.jsonl:
//   closr  Closr Tech / Closrleads: { order:{number,campaign}, lead:{first_name,last_name,full_name,phone,state,dob,email,timezone,
//          city,zip,timestamp,delivered_at,custom_data:{...form answers}}, buyer, tenant:{site_title}, is_test }
//   goat   GOAT Leads (gotleads.com): flat title-case keys: "First Name","Last Name","Phone","Email","State","RR State","DOB",
//          "Lead Type","Lead Quality","Driver Type","IUL Goal","Beneficiary","Trusted Form URL","Aged Bucket","Vendor", ...
//
// Consent: both vendors sell TCPA-consented leads from their own forms, and the stack this replaces
// treated every delivery as opted in. The adapters record that as the consent proof: flag true, wording
// naming the vendor form (and the TrustedForm certificate URL when the vendor sends one), so the lead
// row and its ConsentRecord say exactly where consent came from. A Closr `is_test` delivery is
// acknowledged and dropped (nothing is created), as before.

export const VENDORS = ['closr', 'goat'] as const;
export type Vendor = typeof VENDORS[number];
export const VENDOR_LABEL: Record<Vendor, string> = { closr: 'Closr Tech (Closrleads)', goat: 'GOAT Leads' };

const str = (v: unknown) => (v === undefined || v === null || typeof v === 'object' ? '' : String(v).trim());
const na = (v: string) => (/^n\/?a$/i.test(v) ? '' : v);
/** Case/space/underscore-insensitive lookup of the first non-empty key. */
export function pickKey(obj: any, keys: string[]): string {
  if (!obj || typeof obj !== 'object') return '';
  const norm = (k: string) => k.toLowerCase().replace(/[\s_\-.]/g, '');
  const lower: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) lower[norm(k)] = v;
  for (const k of keys) { const v = na(str(lower[norm(k)])); if (v) return v; }
  return '';
}
/** Vendor form answers about health never reach the lead profile. */
const HEALTH_KEY = /(cancer|heart|diabet|stroke|health|medical|condition|medication|tobacco|smok|history of)/i;

export type Adapted = {
  vendor: Vendor; test: boolean; generic: Record<string, unknown>;
  /** Aged vendor leads (GOAT "Aged Bucket" other than FRESH) do not get the instant opener. */
  fresh: boolean;
  trusted_form: string; vendor_lead_id: string; order: string;
};

function consentWording(vendorName: string, form: string, trustedForm: string, when: string) {
  return [
    `Prior express written consent captured on the ${vendorName} lead form${form ? ` (${form})` : ''}${when ? ` on ${when}` : ''}: the consumer requested a life insurance quote and agreed to be contacted by text at the number provided.`,
    trustedForm ? `TrustedForm certificate: ${trustedForm}` : '',
  ].filter(Boolean).join(' ');
}

/** Closr Tech / Closrleads delivery. */
export function adaptClosr(payload: any): Adapted {
  const lead = payload?.lead && typeof payload.lead === 'object' ? payload.lead : payload || {};
  const custom = lead.custom_data && typeof lead.custom_data === 'object' ? lead.custom_data : (payload?.custom_data || {});
  const order = str(payload?.order?.number);
  const campaign = str(payload?.order?.campaign);
  const email = pickKey(lead, ['email', 'email_address']);
  const test = payload?.is_test === true || String(payload?.is_test).toLowerCase() === 'true' || /^test$/i.test(campaign) || (/test/i.test(email) && /closrtech|closrleads/i.test(email));
  const vendorName = str(payload?.tenant?.site_title) || 'Closr Tech';
  const trustedForm = pickKey({ ...custom, ...lead }, ['trusted_form_url', 'trustedform', 'trusted_form', 'xxTrustedFormCertUrl', 'trustedform_cert_url']);
  const full = pickKey(lead, ['full_name', 'name']);
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(custom)) { const key = str(k), val = na(str(v)); if (key && val && !HEALTH_KEY.test(key) && !/^source$/i.test(key)) extra[key.slice(0, 40)] = val.slice(0, 300); }
  const driver = pickKey(custom, ['What Kind of Cdl Driver Are You', 'driver_type', 'driver type', 'cdl_type']);
  const generic = {
    first_name: pickKey(lead, ['first_name', 'firstname', 'first', 'fname']) || full.split(/\s+/)[0] || '',
    last_name: pickKey(lead, ['last_name', 'lastname', 'last', 'lname']) || full.split(/\s+/).slice(1).join(' '),
    phone: pickKey(lead, ['phone', 'phone_number', 'mobile', 'cell']),
    email,
    state: pickKey(lead, ['state', 'rr_state', 'state_code', 'region']),
    source: vendorName,
    created_at: str(lead.delivered_at) || str(lead.timestamp) || new Date().toISOString(),
    consent: 'true',
    consent_text: consentWording(vendorName, [campaign, pickKey(custom, ['source'])].filter(Boolean).join(', '), trustedForm, str(lead.delivered_at) || str(lead.timestamp)),
    consent_date: str(lead.delivered_at) || '',
    consent_url: trustedForm,
    product: 'IUL',
    dob: pickKey(lead, ['dob', 'date_of_birth', 'birthdate']),
    age: pickKey(custom, ['age']),
    beneficiary: pickKey(custom, ['Who Would You Most Likely Want These Funds to Go to', 'beneficiary', 'beneficiary_relationship', 'beneficiary name']),
    reason: pickKey(custom, ['iul_goal', 'goal', 'What are your goals for the IUL', 'goals']),
    occupation: driver ? `CDL driver (${driver})` : 'CDL driver',
    notes: [order ? `${vendorName} order ${order}` : '', pickKey(custom, ['Company Name']) ? `Company: ${pickKey(custom, ['Company Name'])}` : ''].filter(Boolean).join(' | '),
    extra,
  };
  return { vendor: 'closr', test, generic, fresh: true, trusted_form: trustedForm, vendor_lead_id: str(lead.id), order };
}

/** GOAT Leads delivery (flat, title-case keys). */
export function adaptGoat(payload: any): Adapted {
  const f: any = { ...(payload || {}) };
  for (const key of ['lead', 'data', 'contact', 'customer', 'fields', 'payload', 'record']) if (payload && typeof payload[key] === 'object' && payload[key]) Object.assign(f, payload[key]);
  const trustedForm = pickKey(f, ['trusted_form_url', 'trustedform', 'trusted_form', 'trustedform_cert_url', 'xxTrustedFormCertUrl']);
  const aged = pickKey(f, ['aged_bucket', 'bucket']).toUpperCase();
  const fresh = !aged || aged === 'FRESH';
  const leadType = pickKey(f, ['lead_type', 'leadtype', 'type', 'campaign', 'campaign_name', 'product', 'vertical']);
  const full = pickKey(f, ['name', 'full_name', 'fullname', 'contact_name', 'lead_name']);
  const when = pickKey(f, ['Date/Time', 'date_time', 'created_at', 'timestamp', 'date']);
  const extra: Record<string, string> = {};
  const SKIP = /^(id|lead_?id|first ?name|last ?name|phone|email|state|rr ?state|dob|vendor|trusted ?form ?url|aged ?bucket|lead ?quality|lead ?type|date\/time)$/i;
  for (const [k, v] of Object.entries(f)) { const key = str(k), val = na(str(v)); if (key && val && !SKIP.test(key) && !HEALTH_KEY.test(key)) extra[key.slice(0, 40)] = val.slice(0, 300); }
  const driver = pickKey(f, ['driver_type', 'drivertype', 'driver']);
  const generic = {
    first_name: pickKey(f, ['first_name', 'firstname', 'first', 'fname', 'contact_first_name']) || full.split(/\s+/)[0] || '',
    last_name: pickKey(f, ['last_name', 'lastname', 'last', 'lname', 'surname', 'contact_last_name']) || full.split(/\s+/).slice(1).join(' '),
    phone: pickKey(f, ['phone', 'phone_number', 'mobile', 'cell', 'cell_phone', 'contact_phone']),
    email: pickKey(f, ['email', 'email_address', 'contact_email']),
    state: pickKey(f, ['rr_state', 'state_code', 'st', 'state', 'region']),
    source: pickKey(f, ['vendor', 'source', 'lead_source', 'provider']) || 'GOAT Leads',
    created_at: when || new Date().toISOString(),
    consent: 'true',
    consent_text: consentWording('GOAT Leads', leadType, trustedForm, when),
    consent_date: '',
    consent_url: trustedForm,
    product: leadType.replace(/\s*Lead$/i, '') || 'IUL',
    dob: pickKey(f, ['dob', 'date_of_birth', 'birthdate', 'birthday']),
    age: pickKey(f, ['age']),
    beneficiary: pickKey(f, ['beneficiary', 'beneficiary_name', 'beneficiary_relationship']),
    reason: pickKey(f, ['iul_goal', 'goal', 'goals']),
    occupation: driver ? `CDL driver (${driver})` : '',
    coverage: pickKey(f, ['needed_coverage', 'coverage']),
    notes: [pickKey(f, ['lead_quality', 'quality']) ? `Quality: ${pickKey(f, ['lead_quality', 'quality'])}` : '', aged ? `Bucket: ${aged}` : '', pickKey(f, ['notes', 'note', 'comments', 'message'])].filter(Boolean).join(' | '),
    extra,
  };
  return { vendor: 'goat', test: false, generic, fresh, trusted_form: trustedForm, vendor_lead_id: pickKey(f, ['id', 'lead_id', 'record_id', 'external_id', 'uuid']), order: '' };
}

export function adaptVendor(vendor: string, payload: any): Adapted | null {
  if (vendor === 'closr') return adaptClosr(payload);
  if (vendor === 'goat') return adaptGoat(payload);
  return null;
}
