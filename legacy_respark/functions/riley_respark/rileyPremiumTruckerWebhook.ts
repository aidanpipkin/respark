// Fresh premium trucker lead webhook (vendor -> GHL -> Respark, instant first text).
// Paste into the vendor's "GHL Webhook URL" box (leave their GHL API Key / Location ID blank so this function owns the whole flow):
//   https://vesper-4e3ffdf5.base44.app/functions/rileyPremiumTruckerWebhook?token=rLy7Qn3VtKx9ZbW2eHs8MdPc4Fj6AgUo
// Vendor: Closrleads (payload {order, lead:{first_name,last_name,phone,state,dob,email,timezone}, buyer, items, is_test}). Also accepts GOAT-style or generic keys.
// Test leads (is_test=true) are logged + confirmed to Riley by text, never pushed to GHL. On each real lead: parses the payload, upserts the GHL contact (E.164 phone, proper-case names,
// state, email, DOB, trucker custom fields), opens an opportunity in "Riley Fresh Premium Truckers" > New Lead, writes a note,
// enrolls the lead in Respark as a FRESH lead (different first text: "the request you just put in"), fires the first text right away
// when inside the 9am-7:30pm local Mon-Sat window (otherwise it queues for the next morning), logs to GoatLead, and texts Riley.
// Idempotent: same phone again reuses the contact/opportunity and never double-enrolls. GET ?token=...&ping=1 returns ok.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.31';
//__SHARED__//

const WEBHOOK_TOKEN = 'rLy7Qn3VtKx9ZbW2eHs8MdPc4Fj6AgUo';
const PIPELINE_ID = 'kq9QT4chftvYo3oth31j';                       // Riley Fresh Premium Truckers
const NEW_LEAD_STAGE_ID = '42e8daa3-20b8-462b-a056-061bb64d9736'; // New Lead
const SELF_URL = 'https://vesper-4e3ffdf5.base44.app/functions/rileySend';
const CF_STATE_FULL = 'EN8XwsxErZ5KDoCw9DZt';

function pick(obj: any, keys: string[]): string {
  if (!obj || typeof obj !== 'object') return '';
  const lower: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) lower[k.toLowerCase().replace(/[\s_\-\.]/g, '')] = v;
  for (const k of keys) { const v = lower[k.toLowerCase().replace(/[\s_\-\.]/g, '')]; if (v !== undefined && v !== null && String(v).trim() !== '' && String(v).trim().toLowerCase() !== 'n/a') return String(v).trim(); }
  return '';
}
const NEST_KEYS = ['lead', 'data', 'contact', 'customer', 'fields', 'payload', 'record', 'customData', 'custom_data', 'custom_fields', 'answers', 'questions', 'form', 'form_data', 'details', 'meta', 'attributes', 'extra'];
function flatten(payload: any): any {
  // Merge known nesting containers (two levels deep) so pick() sees everything, and turn [{label,value}] style arrays into fields.
  const out: any = {};
  const merge = (obj: any, depth: number) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v)) { for (const it of v) { if (it && typeof it === 'object' && !Array.isArray(it)) { const lab = it.label ?? it.name ?? it.question ?? it.key ?? it.field; const val = it.value ?? it.answer ?? it.val; if (lab !== undefined && val !== undefined && val !== null && String(val).trim() !== '') out[String(lab)] = val; } } continue; }
      if (v && typeof v === 'object') { if (depth < 2 && NEST_KEYS.includes(k)) merge(v, depth + 1); continue; }
      if (out[k] === undefined || out[k] === '' || out[k] === null) out[k] = v;
    }
  };
  merge(payload, 0);
  if (payload?.order?.campaign && out.campaign === undefined) out.campaign = payload.order.campaign;
  if (payload?.order?.number && out.order_number === undefined) out.order_number = payload.order.number;
  return out;
}
// NANP sanity: real area code + exchange (no 0/1 leading digits, no 555 exchange, not a repeated/sequential dummy)
function plausibleUsPhone(e164: string): boolean {
  const d = e164.replace(/^\+1/, ''); if (d.length !== 10) return false;
  if (!/^[2-9]/.test(d) || !/^[2-9]/.test(d.slice(3)) || d.slice(3, 6) === '555' || d.slice(0, 3) === '555') return false;
  if (/^(\d)\1{9}$/.test(d) || /0123456789|1234567890|9876543210/.test(d)) return false;
  return true;
}
function toE164(raw: string): string {
  const d = (raw || '').replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return '';
}
function properCase(s: string): string { return (s || '').trim().toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_m, p, c) => p + c.toUpperCase()); }
const STATE_NAMES: Record<string, string> = Object.fromEntries(Object.entries(STATE_ABBR).map(([a, n]) => [a, n.replace(/\b\w/g, c => c.toUpperCase())]));
function stateFull(s: string): string { const k = (s || '').trim().toLowerCase(); return STATE_NAMES[k] || properCase(s); }

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  const base44 = createClientFromRequest(req);
  const now = new Date();
  // ---- parse body (JSON, form, or query string) ----
  let payload: any = {}; const contentType = req.headers.get('content-type') || '';
  try {
    const text = await req.text();
    if (text) { if (contentType.includes('json')) payload = JSON.parse(text); else if (contentType.includes('form')) payload = Object.fromEntries(new URLSearchParams(text)); else { try { payload = JSON.parse(text); } catch { payload = Object.fromEntries(new URLSearchParams(text)); } } }
  } catch (e) { payload = { parse_error: String(e) }; }
  if ((url.searchParams.get('token') || payload.token) !== WEBHOOK_TOKEN) return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (url.searchParams.get('ping') || payload.ping) return Response.json({ ok: true, pipeline: 'Riley Fresh Premium Truckers', now: stamp() });
  delete payload.token; delete payload.ping;
  for (const [k, v] of url.searchParams.entries()) if (!['token', 'ping', 'dry_run'].includes(k) && payload[k] === undefined) payload[k] = v;
  const dryRun = url.searchParams.get('dry_run') === '1' || payload.dry_run === true; delete payload.dry_run;
  const f = flatten(payload);
  // Vendor connectivity check (empty body) -> just say ok, nothing to log or alert
  if (!Object.keys(f).length) return Response.json({ ok: true, note: 'empty payload, nothing to process' });
  const isTest = payload.is_test === true || String(payload.is_test).toLowerCase() === 'true' || /^test$/i.test(String(payload?.order?.campaign || '')) || /test/i.test(String(payload?.lead?.email || '')) && /closrtech|closrleads/i.test(String(payload?.lead?.email || ''));
  const vendorName = String(payload?.tenant?.site_title || payload?.vendor_name || (Array.isArray(payload?.vendor) ? '' : payload?.vendor) || '').trim() || 'Closrleads';
  let first = pick(f, ['first_name', 'firstname', 'first', 'fname', 'given_name']);
  let last = pick(f, ['last_name', 'lastname', 'last', 'lname', 'surname']);
  const fullName = pick(f, ['name', 'full_name', 'fullname', 'contact_name', 'lead_name']);
  if (!first && fullName) { const parts = fullName.split(/\s+/); first = parts[0]; last = last || parts.slice(1).join(' '); }
  const phoneRaw = pick(f, ['phone', 'phone_number', 'phonenumber', 'mobile', 'cell', 'cell_phone', 'mobile_phone', 'primary_phone', 'telephone']);
  const phone = toE164(phoneRaw);
  const email = pick(f, ['email', 'email_address', 'emailaddress']).toLowerCase();
  const stateRaw = pick(f, ['rr_state', 'state', 'st', 'state_code', 'region']);
  const state = stateFull(stateRaw);
  const city = properCase(pick(f, ['city', 'town']));
  const zip = pick(f, ['zip', 'zipcode', 'zip_code', 'postal_code', 'postalcode']);
  const dob = pick(f, ['dob', 'date_of_birth', 'birthdate', 'birth_date']);
  const driverType = pick(f, ['driver_type', 'drivertype', 'driver', 'cdl_type']);
  const age = pick(f, ['age']);
  const marital = pick(f, ['marital_status', 'marital']);
  const beneficiary = pick(f, ['beneficiary', 'beneficiary_name', 'beneficiary_relationship']);
  const goal = pick(f, ['iul_goal', 'goal', 'what_are_your_goals_for_the_iul', 'goals']);
  const gender = pick(f, ['gender', 'sex']);
  const leadType = pick(f, ['lead_type', 'leadtype', 'type', 'campaign', 'product', 'vertical']) || 'Trucker IUL';
  const tzFromVendor = pick(f, ['timezone', 'time_zone', 'tz']);
  const leadQuality = pick(f, ['lead_quality', 'quality']);
  const vendorLeadId = pick(f, ['lead_id', 'leadid', 'id', 'record_id', 'external_id']);
  const trustedForm = pick(f, ['trusted_form_url', 'trustedform', 'trusted_form', 'xxTrustedFormCertUrl']);
  const vendor = vendorName;
  const orderNumber = pick(f, ['order_number']);
  const bestTime = pick(f, ['best_time_of_day_to_contact_you', 'best_time']);
  const details: string[] = [];
  for (const k of ['Driver Type', 'Age', 'Gender', 'Marital Status', 'Beneficiary', 'Beneficiary Name', 'IUL Goal', 'Has Life Insurance', 'Needed Coverage', 'Employment Status', 'Best Time Of Day To Contact You', 'History of cancer, heart attack, diabetes or stroke', 'Lead Quality', 'Date/Time']) {
    const v = (f as any)[k]; if (v !== null && v !== undefined && String(v).trim() !== '' && String(v) !== 'N/A') details.push(`${k}: ${v}`);
  }
  const rec: any = { first_name: properCase(first), last_name: properCase(last), phone, phone_raw: phoneRaw, email, state, city, zip, dob,
    lead_type: leadType, lead_source: 'Riley Premium Trucker Webhook', vendor_lead_id: vendorLeadId, notes: [trustedForm ? `TrustedForm: ${trustedForm}` : '', ...details].filter(Boolean).join(' | '),
    raw_payload: payload, content_type: contentType, received_date: now.toISOString(), stage: 'received', status: 'logged_only', sms_sent: false, owner_alert_sent: false, call_count: 0, pipeline_id: PIPELINE_ID };
  const parsed = { first: rec.first_name, last: rec.last_name, phone, email, state, city, driver_type: driverType, age, marital, beneficiary, goal };
  if (dryRun) return Response.json({ received: true, dry_run: true, is_test: isTest, parsed, keys_seen: Object.keys(f) });
  const GL = (base44 as any).asServiceRole.entities.GoatLead;
  if (isTest) {
    rec.status = 'test'; rec.notes = `Vendor test lead (${vendor}${orderNumber ? ' ' + orderNumber : ''}); not sent to GHL or Respark.`;
    const saved = await GL.create(rec);
    try { await alertRiley(`${vendor} sent a TEST lead to the premium trucker webhook and it parsed fine (${rec.first_name} ${rec.last_name}, ${phone || phoneRaw}, ${state}). Nothing was created in GHL. Real leads will flow automatically.`); } catch (_) {}
    return Response.json({ received: true, test: true, parsed, logged_id: saved.id });
  }
  if (!phone || !rec.first_name || !plausibleUsPhone(phone)) {
    rec.status = 'error'; rec.error = !phone ? 'No valid 10-digit US phone in payload' : !rec.first_name ? 'No first name in payload' : `Phone ${phone} is not a plausible US number`;
    const saved = await GL.create(rec);
    try { await alertRiley(`Premium trucker lead came in but could not be processed (${rec.error}). Logged id ${saved.id}. Keys: ${Object.keys(f).slice(0, 12).join(', ')}`); } catch (_) {}
    return Response.json({ received: true, error: rec.error, parsed, logged_id: saved.id });
  }
  const out: any = { received: true, parsed };
  try {
    // 1. Contact upsert (by phone) + trucker custom fields + tags
    const customFields: any[] = [];
    if (driverType) customFields.push({ id: CF.driver_type, value: driverType });
    if (age) customFields.push({ id: CF.age, value: age });
    if (marital) customFields.push({ id: CF.marital, value: marital });
    if (beneficiary) customFields.push({ id: CF.beneficiary_rel, value: beneficiary });
    if (state) customFields.push({ id: CF_STATE_FULL, value: state });
    const upsertBody: any = { locationId: LOC, firstName: rec.first_name, lastName: rec.last_name, phone, source: vendor, tags: ['Premium Trucker', 'Fresh Lead', 'Respark Active'] };
    if (email) upsertBody.email = email; if (state) upsertBody.state = state; if (city) upsertBody.city = city; if (zip) upsertBody.postalCode = zip; if (dob) upsertBody.dateOfBirth = dob; if (customFields.length) upsertBody.customFields = customFields;
    const up = await ghl('/contacts/upsert', { method: 'POST', body: JSON.stringify(upsertBody) });
    if (!up.ok) throw new Error(`GHL upsert ${up.status}: ${JSON.stringify(up.json).slice(0, 200)}`);
    const contactId: string = up.json.contact?.id; rec.ghl_contact_id = contactId; rec.ghl_contact_new = !!up.json.new; out.contact_id = contactId; out.contact_new = rec.ghl_contact_new;
    await addTags(contactId, ['Premium Trucker', 'Fresh Lead', 'Respark Active']);
    // 2. Opportunity in Riley Fresh Premium Truckers > New Lead (reuse an open one)
    const ex = await ghl(`/opportunities/search?location_id=${LOC}&contact_id=${contactId}&pipeline_id=${PIPELINE_ID}&status=open&limit=5`);
    let opp = (ex.json.opportunities || [])[0];
    if (!opp) {
      const cr = await ghl('/opportunities/', { method: 'POST', body: JSON.stringify({ pipelineId: PIPELINE_ID, locationId: LOC, contactId, status: 'open', pipelineStageId: NEW_LEAD_STAGE_ID, name: `${rec.first_name} ${rec.last_name}`.trim(), source: vendor }) });
      if (!cr.ok) throw new Error(`GHL opportunity ${cr.status}: ${JSON.stringify(cr.json).slice(0, 200)}`);
      opp = cr.json.opportunity;
    }
    rec.ghl_opportunity_id = opp.id; rec.stage = 'new_lead'; out.opportunity_id = opp.id;
    // 3. Note
    try { await ghl(`/contacts/${contactId}/notes`, { method: 'POST', body: JSON.stringify({ body: [`PREMIUM TRUCKER FRESH lead received ${stamp()}`, `Vendor: ${vendor}${orderNumber ? ' order ' + orderNumber : ''} | Type: ${leadType} | Quality: ${leadQuality || 'n/a'} | Vendor ID: ${vendorLeadId || 'n/a'}`, `State: ${state || 'n/a'} | DOB: ${dob || 'n/a'} | Email: ${email || 'n/a'}`, ...details.map(d => `- ${d}`), trustedForm ? `TrustedForm consent cert: ${trustedForm}` : '', 'Respark: enrolled as FRESH lead, first text fires immediately (inside 9am-7:30pm local).'].filter(Boolean).join('\n') }) }); } catch (_) {}
    // 4. Respark enrollment (fresh variant, instant first text)
    const svc = (base44 as any).asServiceRole.entities.RileyResparkLead;
    const already: any[] = await svc.filter({ ghl_contact_id: contactId }, '-created_date', 1);
    let tz = tzForState(state);
    if (tzFromVendor) { try { new Intl.DateTimeFormat('en-US', { timeZone: tzFromVendor }); tz = tzFromVendor; } catch (_) {} }
    rec.timezone = tz;
    // next_send_at = now; the sender owns the texting-hours policy and will defer to the next window itself if needed
    const firstSend = now;
    if (already.length) { out.respark = `already enrolled (${already[0].status})`; }
    else {
      const c = (await ghl(`/contacts/${contactId}`)).json.contact || {};
      let pr: any = { fields: {}, lead_status: '', requested_at: now.toISOString(), city, gender, iul_goal: goal, dob, age, marital, beneficiary, driver_type: driverType };
      try { pr = await buildProfile(base44, c, await cfNameMap()); } catch (_) {}
      const fields = { ...(pr.fields || {}) }; for (const d of details) { const [k, ...v] = d.split(': '); if (!fields[k]) fields[k] = v.join(': '); }
      await svc.create({ ghl_contact_id: contactId, ghl_opportunity_id: opp.id, pipeline_id: PIPELINE_ID, first_name: rec.first_name, last_name: rec.last_name, phone, email, state, timezone: tz,
        driver_type: driverType || pr.driver_type || '', age: age || pr.age || '', marital_status: marital || pr.marital || '', beneficiary_relationship: beneficiary || pr.beneficiary || '', city: city || pr.city || '', gender: gender || pr.gender || '', dob: dob || pr.dob || '', iul_goal: goal || pr.iul_goal || '',
        lead_status: 'Fresh Lead (vendor webhook)', requested_at: now.toISOString(), profile: fields, lead_added_date: c.dateAdded || now.toISOString(), enrolled_at: now.toISOString(), status: 'active', step: 0, messages_sent: 0, reply_count: 0, ashley_turns: 0,
        next_send_at: firstSend.toISOString(), conversation: [], seq_log: [`${stamp()} enrolled via premium trucker webhook (FRESH); first text requested immediately`] });
      out.respark = 'enrolled';
      // 5. Fire the first text immediately (single-lead run of the sender, which applies the texting-hours policy; the 15-minute sender is the backstop)
      try {
        const r = await fetch(SELF_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contact_id: contactId }) });
        const j = await r.json().catch(() => ({}));
        if (j.sent_count) { out.first_text = 'first text sent'; rec.sms_sent = true; rec.last_sms_at = now.toISOString(); }
        else if (j.deferred) out.first_text = `outside texting hours, first text queued for ${j.deferred_until || 'the next window'}`;
        else out.first_text = `not sent yet (${JSON.stringify(j).slice(0, 120)}); sender will retry within 15 min`;
      } catch (e) { out.first_text = `sender call failed, 15-min sender will pick it up: ${String(e).slice(0, 80)}`; }
    }
    rec.status = 'processed'; rec.seq_status = 'respark';
    // 6. Alert Riley
    try { await alertRiley(`NEW LEAD, CALL NOW (they just hit submit): ${rec.first_name} ${rec.last_name} | ${phone} | ${state}${city ? ', ' + city : ''} | ${driverType || 'driver type n/a'}${age ? ', age ' + age : ''}${beneficiary ? ' | beneficiary ' + beneficiary : ''}${goal ? ' | goal: ' + goal : ''}${bestTime ? ' | best time: ' + bestTime : ''}. Double dial inside 3 minutes beats everything else. Text: ${out.first_text || out.respark}. In Fresh Premium Truckers > New Lead.`); rec.owner_alert_sent = true; } catch (_) {}
  } catch (e) { rec.status = 'error'; rec.error = String(e).slice(0, 300); out.error = rec.error; try { await alertRiley(`Premium trucker lead ${rec.first_name} ${phone} hit an error: ${rec.error.slice(0, 160)}`); } catch (_) {} }
  const saved = await GL.create(rec); out.logged_id = saved.id;
  return Response.json(out);
});
