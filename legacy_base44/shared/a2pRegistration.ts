// Agent A2P registration input. EIN is accepted only as a transient value and never stored.
export const ENTITY_TYPES = ['Limited Liability Corporation', 'Corporation', 'Partnership', 'Co-operative', 'Non-profit Corporation'];
export const POSITIONS = ['Director', 'GM', 'VP', 'CEO', 'CFO', 'General Counsel', 'Other'];
const STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');

export const registrationFields = ['legal_business_name', 'business_type', 'entity_type', 'first_name', 'last_name', 'npn', 'rep_title', 'rep_position', 'mobile_phone', 'business_email', 'business_phone', 'street', 'city', 'region', 'postal_code', 'website', 'privacy_url', 'terms_url', 'description', 'opt_in_flow', 'sample_message_1', 'sample_message_2', 'stop_response', 'help_response'];

const phone = (v: string) => { const d = String(v || '').replace(/[^\d+]/g, ''); if (/^\d{10}$/.test(d)) return `+1${d}`; if (/^1\d{10}$/.test(d)) return `+${d}`; return d; };

export function registrationInput(input: any) {
  const data: Record<string, any> = {};
  for (const key of registrationFields) {
    const v = input[key] ?? '';
    if (typeof v !== 'string' || v.length > 4000) throw new Error('Complete all registration fields.');
    data[key] = v.trim();
  }
  if (!['sole_proprietor', 'company'].includes(data.business_type)) throw new Error('Choose whether you have an EIN.');
  data.business_phone = phone(data.business_phone);
  data.mobile_phone = phone(data.mobile_phone);
  data.region = data.region.toUpperCase();
  data.website = data.website && !/^https?:\/\//i.test(data.website) ? `https://${data.website}` : data.website;
  if (data.business_type === 'sole_proprietor' && !data.legal_business_name) data.legal_business_name = `${data.first_name} ${data.last_name}`.trim();
  data.business_address = [data.street, data.city, [data.region, data.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  data.attested = input.attested === true;
  // Enum fields: leave unset rather than storing an empty string.
  for (const k of ['entity_type', 'rep_position']) if (!data[k]) delete data[k];
  return data;
}

/** EIN is validated here and returned digits-only; callers must not persist it. */
export function cleanEin(raw: any) {
  const d = String(raw || '').replace(/\D/g, '');
  if (!/^\d{9}$/.test(d)) throw new Error('Enter your 9-digit EIN.');
  return d;
}

export function validateRegistration(d: any, opts: { ein?: string } = {}) {
  const errors: string[] = [];
  const sole = d.business_type === 'sole_proprietor';
  const need = (k: string, label: string) => { if (!d[k]) errors.push(`${label} is required.`); };
  need('first_name', 'First name'); need('last_name', 'Last name'); need('legal_business_name', sole ? 'Brand name' : 'Legal business name');
  need('street', 'Street address'); need('city', 'City'); need('description', 'Program description'); need('opt_in_flow', 'Opt-in description');
  need('stop_response', 'STOP response'); need('help_response', 'HELP response');
  if (!/^\d{4,10}$/.test(d.npn || '')) errors.push('Your NPN is 4 to 10 digits.');
  if (!STATES.includes(d.region)) errors.push('Use a two-letter state, like TX.');
  if (!/^\d{5}(-\d{4})?$/.test(d.postal_code || '')) errors.push('Enter a 5-digit ZIP code.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.business_email || '')) errors.push('Enter a valid email.');
  if (!/^\+1[2-9]\d{9}$/.test(d.business_phone || '')) errors.push('Enter a valid US business phone.');
  if (sole) {
    if (!/^\+1[2-9]\d{9}$/.test(d.mobile_phone || '')) errors.push('Enter the US mobile number where you can receive the verification text.');
  } else {
    if (!ENTITY_TYPES.includes(d.entity_type)) errors.push('Choose your business type (LLC, Corporation, …).');
    if (!POSITIONS.includes(d.rep_position)) errors.push('Choose your position.');
    need('rep_title', 'Your title');
    if (opts.ein !== undefined) { try { cleanEin(opts.ein); } catch (e) { errors.push((e as Error).message); } }
  }
  for (const key of ['website', 'privacy_url', 'terms_url']) {
    try {
      const u = new URL(d[key]); if (u.protocol !== 'https:') throw new Error();
      if (key !== 'website' && u.hostname !== new URL(d.website).hostname) errors.push('Privacy policy and SMS terms must be on your business website.');
    } catch { errors.push(`${key === 'website' ? 'Business website' : key === 'privacy_url' ? 'Privacy policy link' : 'SMS terms link'} must be a valid https:// address.`); }
  }
  if ((d.description || '').length < 40) errors.push('Describe your texting program in at least 40 characters.');
  if ((d.opt_in_flow || '').length < 40 || !/consent|opt.?in|checkbox/i.test(d.opt_in_flow || '')) errors.push('Explain how contacts opt in (at least 40 characters, mention consent).');
  for (const key of ['sample_message_1', 'sample_message_2']) {
    const m = String(d[key] || '');
    if (m.length < 20) errors.push('Each sample message needs at least 20 characters.');
    if (!/\bSTOP\b/i.test(m)) errors.push('Both sample messages must include STOP instructions.');
    if (d.legal_business_name && !m.toLowerCase().includes(String(d.legal_business_name).toLowerCase())) errors.push(`Both sample messages must name "${d.legal_business_name}".`);
  }
  for (const key of ['stop_response', 'help_response']) if (d[key] && (d[key].length < 20 || d[key].length > 320)) errors.push('STOP and HELP responses must be 20 to 320 characters.');
  if (!d.attested) errors.push('Confirm the registration accuracy and consent practices.');
  return [...new Set(errors)];
}
