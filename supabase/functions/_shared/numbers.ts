// Every business number an agent owns: buying, releasing, which number each lead hears from
// (always the same one, for texts and calls), carrier trust registration and number health.
import { tw, subCred, ensureSubaccount, API, TRUST, MSG } from './twilio.ts';

const now = () => new Date().toISOString();
const DAY = 86400000;
const toE164 = (v: any) => { const d = String(v || '').replace(/[^\d+]/g, ''); if (/^\+[1-9]\d{7,14}$/.test(d)) return d; if (/^\d{10}$/.test(d)) return `+1${d}`; if (/^1\d{10}$/.test(d)) return `+${d}`; return ''; };

export const TRUST_POLICY = {
  shaken: 'RN7a97559effdf62d00f4298208492a5ea',
  cnam: 'RNf3db3cd1fe25fcfd3c3ded065c8fea53',
  voiceIntegrity: 'RN5b3660f9598883b1df4e77f77acefba0',
};

export function prettyPhone(p: string) { const m = String(p || '').match(/^\+1(\d{3})(\d{3})(\d{4})$/); return m ? `(${m[1]}) ${m[2]}-${m[3]}` : String(p || ''); }

export function voiceUrl(webhook: string, step: string, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({ voice: step, ...extra });
  return `${webhook}${webhook.includes('?') ? '&' : '?'}${q}`;
}

// ---------- Which numbers exist ----------

/** Creates the PhoneNumber row for an agent's first number if it only lives on TwilioAccount. */
export async function syncPrimary(E: any, s: any) {
  const rows = (await E.PhoneNumber.filter({ agent_email: s.agent_email }, { limit: 50 })).items;
  if (rows.length) return rows;
  const acct = (await E.TwilioAccount.filter({ agent_email: s.agent_email }, { limit: 1 })).items[0];
  if (!acct?.phone_number || !acct.subaccount_sid) return rows;
  const reg = (await E.A2PRegistration.filter({ agent_email: s.agent_email }, { limit: 1 })).items[0];
  const row = await E.PhoneNumber.create({ agent_email: s.agent_email, phone_number: acct.phone_number, phone_sid: acct.phone_sid || '', subaccount_sid: acct.subaccount_sid, label: 'Main', area_code: acct.phone_number.slice(2, 5), is_primary: true, status: 'active', in_messaging_service: reg?.number_attached === acct.phone_number, purchased_at: acct.created_at || now(), monthly_fee_cents: 0 });
  return [row];
}

const cache = new Map<string, { at: number; rows: any[] }>();
export function forgetNumbers(email: string) { cache.delete(email); }

/** Numbers that can still talk to their leads (paused numbers keep their existing conversations). */
export async function liveNumbers(E: any, s: any) {
  const hit = cache.get(s.agent_email);
  if (hit && Date.now() - hit.at < 30000) return hit.rows;
  let rows = (await E.PhoneNumber.filter({ agent_email: s.agent_email, status: { $in: ['active', 'paused'] } }, { limit: 50 })).items;
  if (!rows.length) rows = (await syncPrimary(E, s)).filter((r: any) => ['active', 'paused'].includes(r.status));
  cache.set(s.agent_email, { at: Date.now(), rows });
  return rows;
}

function hash(str: string) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

/**
 * The one number this lead hears from. Once picked it never changes while that number is live,
 * so texts, replies and calls all show the same caller. New leads are spread evenly across the
 * agent's registered, active numbers.
 */
export async function numberForLead(E: any, s: any, lead: any, fallback: string) {
  const rows = await liveNumbers(E, s);
  if (!rows.length) return fallback;
  if (lead.from_number && rows.some((r: any) => r.phone_number === lead.from_number)) return lead.from_number;
  const usable = rows.filter((r: any) => r.status === 'active' && (r.in_messaging_service || r.is_primary)).sort((a: any, b: any) => String(a.phone_number).localeCompare(String(b.phone_number)));
  const pool = usable.length ? usable : rows.filter((r: any) => r.is_primary);
  const pick = pool.length ? pool[hash(String(lead.id)) % pool.length].phone_number : fallback;
  if (pick && lead.id && pick !== lead.from_number) await E.Lead.update(lead.id, { from_number: pick }).catch(() => {});
  return pick || fallback;
}

/** A lead who texted one of our numbers is pinned to that number. */
export async function pinLeadToNumber(E: any, s: any, lead: any, to: string) {
  const num = toE164(to);
  if (!lead?.id || !num || lead.from_number === num) return;
  const rows = await liveNumbers(E, s);
  if (rows.some((r: any) => r.phone_number === num)) await E.Lead.update(lead.id, { from_number: num }).catch(() => {});
}

// ---------- Twilio plumbing ----------

export async function configureNumber(cred: any, phoneSid: string, webhook: string) {
  await tw(cred, `${API}/Accounts/${cred.sid}/IncomingPhoneNumbers/${phoneSid}.json`, { SmsUrl: webhook, SmsMethod: 'POST', SmsFallbackUrl: webhook, SmsFallbackMethod: 'POST', VoiceUrl: voiceUrl(webhook, 'inbound'), VoiceMethod: 'POST', StatusCallback: '', VoiceCallerIdLookup: 'false' });
}

export async function attachToService(cred: any, serviceSid: string, phoneSid: string) {
  try { await tw(cred, `${MSG}/Services/${serviceSid}/PhoneNumbers`, { PhoneNumberSid: phoneSid }); return true; }
  catch (e: any) { if (e?.code === 21710 || e?.code === 21712) return true; throw e; }
}

export async function searchAvailable(E: any, s: any, area: string, contains = '') {
  const cred = await subCred(await ensureSubaccount(E, s));
  const q: Record<string, any> = { AreaCode: area, SmsEnabled: 'true', VoiceEnabled: 'true', ExcludeAllAddressRequired: 'true', PageSize: 20 };
  if (/^\d{2,7}$/.test(contains)) q.Contains = contains;
  const data = await tw(cred, `${API}/Accounts/${cred.sid}/AvailablePhoneNumbers/US/Local.json`, q, 'GET');
  return (data.available_phone_numbers || []).map((n: any) => ({ phone_number: n.phone_number, pretty: prettyPhone(n.phone_number), locality: [n.locality, n.region].filter(Boolean).join(', ') }));
}

export async function buyNumber(E: any, s: any, phone: string, webhook: string, opts: { label?: string; fee?: number; primary?: boolean } = {}) {
  const sub = await ensureSubaccount(E, s);
  const cred = await subCred(sub);
  const bought = await tw(cred, `${API}/Accounts/${cred.sid}/IncomingPhoneNumbers.json`, { PhoneNumber: phone, FriendlyName: `${s.brand_name || s.display_name || 'LeadRespark'} ${opts.label || 'line'}`.slice(0, 64), SmsUrl: webhook, SmsMethod: 'POST', SmsFallbackUrl: webhook, SmsFallbackMethod: 'POST', VoiceUrl: voiceUrl(webhook, 'inbound'), VoiceMethod: 'POST' });
  const reg = (await E.A2PRegistration.filter({ agent_email: s.agent_email }, { limit: 1 })).items[0];
  let inService = false, lastError = '';
  if (reg?.messaging_service_sid) { try { inService = await attachToService(cred, reg.messaging_service_sid, bought.sid); } catch (e: any) { lastError = `Texting registration: ${e.message}`; } }
  const row = await E.PhoneNumber.create({ agent_email: s.agent_email, phone_number: bought.phone_number, phone_sid: bought.sid, subaccount_sid: sub, label: opts.label || '', area_code: String(bought.phone_number).slice(2, 5), locality: [bought.locality, bought.region].filter(Boolean).join(', '), is_primary: !!opts.primary, status: 'active', in_messaging_service: inService, voice_configured: true, purchased_at: now(), monthly_fee_cents: opts.fee || 0, paid_through: opts.fee ? new Date(Date.now() + 30 * DAY).toISOString() : '', last_error: lastError });
  forgetNumbers(s.agent_email);
  return row;
}

export async function releaseNumber(E: any, s: any, row: any) {
  const cred = await subCred(row.subaccount_sid);
  const reg = (await E.A2PRegistration.filter({ agent_email: s.agent_email }, { limit: 1 })).items[0];
  if (reg?.messaging_service_sid && row.phone_sid) await tw(cred, `${MSG}/Services/${reg.messaging_service_sid}/PhoneNumbers/${row.phone_sid}`, undefined, 'DELETE').catch(() => {});
  if (row.phone_sid) await tw(cred, `${API}/Accounts/${cred.sid}/IncomingPhoneNumbers/${row.phone_sid}.json`, undefined, 'DELETE').catch((e: any) => { if (e?.status !== 404) throw e; });
  await E.PhoneNumber.update(row.id, { status: 'released', released_at: now(), is_primary: false });
  // Their leads move to another number on their next text.
  await E.Lead.updateMany({ agent_email: s.agent_email, from_number: row.phone_number }, { $set: { from_number: '' } }).catch(() => {});
  forgetNumbers(s.agent_email);
}

export async function makePrimary(E: any, s: any, row: any) {
  await E.PhoneNumber.updateMany({ agent_email: s.agent_email, is_primary: true }, { $set: { is_primary: false } });
  await E.PhoneNumber.update(row.id, { is_primary: true, monthly_fee_cents: 0 });
  const acct = (await E.TwilioAccount.filter({ agent_email: s.agent_email }, { limit: 1 })).items[0];
  if (acct) await E.TwilioAccount.update(acct.id, { phone_number: row.phone_number, phone_sid: row.phone_sid });
  await E.AgentSettings.update(s.id, { phone_number: row.phone_number });
  forgetNumbers(s.agent_email);
}

// ---------- Carrier trust: verified caller (SHAKEN/STIR), spam-label monitoring, caller name ----------

export function cnamName(s: any) {
  const raw = String(s.brand_name || s.agency_name || s.legal_business_name || `${s.first_name || ''} ${s.last_name || ''}`).replace(/[^A-Za-z0-9., ]/g, ' ').replace(/\s+/g, ' ').trim();
  let name = raw.replace(/^[^A-Za-z]+/, '');
  if (name.length > 15) name = name.slice(0, 15).replace(/[ .,]+$/, '');
  return name;
}

async function ensureProduct(cred: any, acct: any, key: 'shaken' | 'cnam' | 'vi', profileSid: string, email: string, label: string, endUser?: { type: string; attributes: any }) {
  const sidField = `${key}_sid`, statusField = `${key}_status`;
  if (acct[sidField]) {
    const tp = await tw(cred, `${TRUST}/TrustProducts/${acct[sidField]}`).catch((e: any) => (e?.status === 404 ? null : Promise.reject(e)));
    if (tp) return { sid: tp.sid, status: tp.status };
  }
  const policy = key === 'shaken' ? TRUST_POLICY.shaken : key === 'cnam' ? TRUST_POLICY.cnam : TRUST_POLICY.voiceIntegrity;
  const tp = await tw(cred, `${TRUST}/TrustProducts`, { FriendlyName: `${label} ${key}`.slice(0, 64), Email: email, PolicySid: policy });
  try {
    if (endUser) {
      const eu = await tw(cred, `${TRUST}/EndUsers`, { FriendlyName: `${label} ${key}`.slice(0, 64), Type: endUser.type, Attributes: endUser.attributes });
      await tw(cred, `${TRUST}/TrustProducts/${tp.sid}/EntityAssignments`, { ObjectSid: eu.sid });
    }
    await tw(cred, `${TRUST}/TrustProducts/${tp.sid}/EntityAssignments`, { ObjectSid: profileSid });
    await tw(cred, `${TRUST}/TrustProducts/${tp.sid}`, { Status: 'pending-review' });
  } catch (e) {
    await tw(cred, `${TRUST}/TrustProducts/${tp.sid}`, undefined, 'DELETE').catch(() => {});
    throw e;
  }
  return { sid: tp.sid, status: 'pending-review', [sidField]: tp.sid, [statusField]: 'pending-review' };
}

async function assignEndpoint(cred: any, path: string, phoneSid: string) {
  try { await tw(cred, `${path}/ChannelEndpointAssignments`, { ChannelEndpointType: 'phone-number', ChannelEndpointSid: phoneSid }); return true; }
  catch (e: any) { if (/already|exists|duplicate/i.test(String(e?.message)) || e?.status === 409) return true; throw e; }
}

/**
 * Moves an agent's caller-trust registrations forward. Safe to call repeatedly: it only creates
 * what is missing and only assigns numbers that aren't assigned yet.
 */
export async function advanceCallerTrust(E: any, s: any, config: any) {
  const acct = (await E.TwilioAccount.filter({ agent_email: s.agent_email }, { limit: 1 })).items[0];
  const reg = (await E.A2PRegistration.filter({ agent_email: s.agent_email }, { limit: 1 })).items[0];
  if (!acct?.subaccount_sid) return { waiting: 'no subaccount' };
  const note = async (msg: string, extra: any = {}) => { await E.TwilioAccount.update(acct.id, { trust_note: msg, trust_checked_at: now(), ...extra }); return { waiting: msg }; };
  if (!reg?.customer_profile_sid) return note('Starts automatically once your texting registration is submitted.');
  const cred = await subCred(acct.subaccount_sid);
  const profile = await tw(cred, `${TRUST}/CustomerProfiles/${reg.customer_profile_sid}`).catch(() => null);
  if (!profile) return note('Your business profile could not be found. Contact support.');
  if (profile.status !== 'twilio-approved') return note('Waiting for your business profile to be approved (usually 1–3 business days after your texting registration).');

  const rows = (await E.PhoneNumber.filter({ agent_email: s.agent_email, status: { $in: ['active', 'paused'] } }, { limit: 50 })).items;
  const email = config.twilio_isv_email || config.owner_email || s.agent_email;
  const label = String(s.brand_name || s.display_name || 'LeadRespark').slice(0, 40);
  const isSole = /sole/i.test(String(reg.business_type || reg.entity_type || ''));
  const update: any = { trust_checked_at: now() };
  const problems: string[] = [];

  for (const r of rows) {
    if (r.profile_assigned || !r.phone_sid) continue;
    try { await assignEndpoint(cred, `${TRUST}/CustomerProfiles/${reg.customer_profile_sid}`, r.phone_sid); await E.PhoneNumber.update(r.id, { profile_assigned: true }); r.profile_assigned = true; }
    catch (e: any) { problems.push(`${prettyPhone(r.phone_number)}: ${e.message}`); }
  }

  const products: Array<{ key: 'shaken' | 'cnam' | 'vi'; flag: string; endUser?: any; skip?: string }> = [
    { key: 'shaken', flag: 'shaken_assigned' },
    { key: 'vi', flag: 'vi_assigned', endUser: { type: 'voice_integrity_information', attributes: { use_case: 'Click to Call', business_employee_count: '1', average_business_day_call_volume: String(Math.max(10, Number(s.max_calls_per_day) || 40)) } } },
    { key: 'cnam', flag: 'cnam_assigned', endUser: { type: 'cnam_information', attributes: { cnam_display_name: cnamName(s) } }, skip: isSole ? 'Caller name needs a business EIN' : (cnamName(s).length < 2 ? 'Add a brand name first' : '') },
  ];
  for (const p of products) {
    if (p.skip) { update[`${p.key}_status`] = 'not-available'; continue; }
    try {
      const tp: any = await ensureProduct(cred, acct, p.key, reg.customer_profile_sid, email, label, p.endUser);
      update[`${p.key}_sid`] = tp.sid; update[`${p.key}_status`] = tp.status;
      if (p.key === 'cnam') update.cnam_name = cnamName(s);
      for (const r of rows) {
        if (r[p.flag] || !r.profile_assigned) continue;
        try { await assignEndpoint(cred, `${TRUST}/TrustProducts/${tp.sid}`, r.phone_sid); await E.PhoneNumber.update(r.id, { [p.flag]: true }); }
        catch (e: any) { problems.push(`${p.key} ${prettyPhone(r.phone_number)}: ${e.message}`); }
      }
    } catch (e: any) { problems.push(`${p.key}: ${e.message}`); update[`${p.key}_status`] = acct[`${p.key}_status`] || 'error'; }
  }
  update.trust_note = problems.length ? problems.slice(0, 3).join(' · ').slice(0, 500) : '';
  await E.TwilioAccount.update(acct.id, update);
  return { ok: !problems.length, problems };
}

// ---------- Monthly fee for extra numbers ----------

export async function renewNumbers(E: any, s: any, chargeFn: (row: any) => Promise<boolean>) {
  const due = (await E.PhoneNumber.filter({ agent_email: s.agent_email, status: { $in: ['active', 'paused', 'unpaid'] }, monthly_fee_cents: { $gt: 0 }, paid_through: { $lte: now() } }, { limit: 20 })).items;
  const out = { renewed: 0, unpaid: 0 };
  for (const r of due) {
    if (await chargeFn(r)) { await E.PhoneNumber.update(r.id, { paid_through: new Date(Math.max(Date.parse(r.paid_through || now()), Date.now()) + 30 * DAY).toISOString(), ...(r.status === 'unpaid' ? { status: 'active' } : {}) }); out.renewed++; }
    else if (r.status !== 'unpaid') { await E.PhoneNumber.update(r.id, { status: 'unpaid' }); out.unpaid++; }
  }
  if (due.length) forgetNumbers(s.agent_email);
  return out;
}

// ---------- Health ----------

const FILTERED = ['30007']; // carrier filtering (treated as spam)
const BAD_DEST = ['30003', '30005', '30006'];

export async function numberHealth(E: any, s: any, row: any, acct?: any) {
  const since = new Date(Date.now() - 7 * DAY).toISOString();
  const today = new Date(Date.now() - DAY).toISOString();
  const base = { agent_email: s.agent_email, number: row.phone_number };
  const c = (q: any) => E.MessageLog.count({ ...base, ...q }).catch(() => 0);
  const [sent, sent24, delivered, failed, filtered, badDest, replies, assigned, optedOut, calls] = await Promise.all([
    c({ event_type: 'sms_sent', occurred_at: { $gte: since } }),
    c({ event_type: 'sms_sent', occurred_at: { $gte: today } }),
    c({ event_type: 'sms_delivery', status: { $in: ['delivered', 'read'] }, occurred_at: { $gte: since } }),
    c({ event_type: 'sms_delivery', status: { $in: ['failed', 'undelivered'] }, occurred_at: { $gte: since } }),
    c({ event_type: 'sms_delivery', error_code: { $in: FILTERED }, occurred_at: { $gte: since } }),
    c({ event_type: 'sms_delivery', error_code: { $in: BAD_DEST }, occurred_at: { $gte: since } }),
    c({ event_type: 'inbound_sms', occurred_at: { $gte: since } }),
    E.Lead.count({ agent_email: s.agent_email, from_number: row.phone_number }).catch(() => 0),
    E.Lead.count({ agent_email: s.agent_email, from_number: row.phone_number, status: 'opted_out' }).catch(() => 0),
    E.CallLog.filter({ agent_email: s.agent_email, from_number: row.phone_number, started_at: { $gte: since } }, { limit: 500, fields: ['status', 'duration_sec', 'direction'] }).then((p: any) => p.items).catch(() => []),
  ]);
  const outCalls = calls.filter((x: any) => x.direction === 'outbound' && !['agent_missed', 'failed'].includes(x.status));
  const answered = outCalls.filter((x: any) => (x.duration_sec || 0) > 0 && ['completed', 'in_progress'].includes(x.status));
  const short = answered.filter((x: any) => x.duration_sec < 15);
  const finished = delivered + failed;
  const deliveryRate = finished ? delivered / finished : null;
  const filterRate = sent ? filtered / sent : 0;
  const replyRate = sent ? replies / sent : null;
  const optOutRate = assigned ? optedOut / assigned : 0;
  const answerRate = outCalls.length ? answered.length / outCalls.length : null;

  let score = 100; const issues: Array<{ level: 'bad' | 'warn' | 'info'; text: string }> = [];
  const hit = (pts: number, level: 'bad' | 'warn' | 'info', text: string) => { score -= pts; issues.push({ level, text }); };
  if (!row.in_messaging_service && !row.is_primary) hit(30, 'bad', 'Not registered for texting yet. It will be added to your registration automatically once that is approved.');
  else if (!row.in_messaging_service) hit(20, 'warn', 'Waiting for your texting registration to be approved.');
  if (sent >= 20 && filterRate > 0.02) hit(35, 'bad', `Carriers filtered ${filtered} texts as possible spam this week. Rest this number for a few days and check your message wording.`);
  else if (sent >= 20 && filterRate > 0.005) hit(15, 'warn', `A few texts (${filtered}) were filtered by carriers. Keep messages personal and avoid links.`);
  if (finished >= 20 && deliveryRate! < 0.9) hit(20, 'bad', `Only ${Math.round(deliveryRate! * 100)}% of texts were delivered.${badDest > failed / 2 ? ' Most failures are bad or landline numbers in your lead list.' : ''}`);
  else if (finished >= 20 && deliveryRate! < 0.95) hit(8, 'warn', `${Math.round(deliveryRate! * 100)}% delivered. Clean out landlines and disconnected numbers.`);
  if (assigned >= 30 && optOutRate > 0.05) hit(20, 'bad', `${Math.round(optOutRate * 100)}% of leads on this number opted out. Carriers watch this closely.`);
  else if (assigned >= 30 && optOutRate > 0.03) hit(8, 'warn', `${Math.round(optOutRate * 100)}% opt-out rate. Under 3% is healthy.`);
  if (sent >= 60 && replyRate! < 0.02) hit(10, 'warn', 'Very few replies this week. Low engagement can hurt deliverability.');
  if (sent24 > 300) hit(12, 'warn', `${sent24} texts in the last day from one number. Add another number to spread the volume.`);
  if (outCalls.length >= 10 && short.length / Math.max(1, answered.length) > 0.4) hit(10, 'warn', 'Many calls hang up within seconds. This number may show as "Spam Likely" on some phones.');
  const shakenOk = acct?.shaken_status === 'twilio-approved' && row.shaken_assigned;
  const viOk = acct?.vi_status === 'twilio-approved' && row.vi_assigned;
  if (!shakenOk) hit(4, 'info', 'Verified caller ID (A-level) is not active yet.');
  if (!viOk) hit(4, 'info', 'Spam-label monitoring is not active yet.');
  if (row.status === 'unpaid') hit(30, 'bad', 'Paused: the monthly number fee could not be paid. Add credits to turn it back on.');
  score = Math.max(0, Math.min(100, Math.round(score)));
  const grade = score >= 85 ? 'healthy' : score >= 65 ? 'watch' : 'at_risk';
  const health = { score, grade, issues, stats: { sent, sent24, delivered, failed, filtered, replies, assigned, opted_out: optedOut, calls: outCalls.length, answered: answered.length, short_calls: short.length, delivery_rate: deliveryRate, reply_rate: replyRate, opt_out_rate: optOutRate, answer_rate: answerRate } };
  await E.PhoneNumber.update(row.id, { health, health_checked_at: now() });
  return health;
}
