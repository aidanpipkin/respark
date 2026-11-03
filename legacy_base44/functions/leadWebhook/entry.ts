// Fresh-lead webhook. Forms, landing pages, Zapier and lead vendors POST new leads to
//   https://<app>/functions/leadWebhook?key=<agent key>
// as JSON or form data. Each lead becomes a contact, is enrolled in the agent's chosen campaign and,
// with documented consent, gets the opening text right away.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { resilient } from '../../shared/entityRetry.ts';
import { waitUntil } from 'base44:runtime';
import { ghl, scope, agentSettings } from '../../shared/ghl.ts';
import { e164 } from '../../shared/smsTransport.ts';
import { businessName } from '../../shared/publicSite.ts';
import { intakeLead, clean, consentRecordFor, writeConsentRecords } from '../../shared/leadIntake.ts';
import { runSequenceLead } from '../../shared/messageSequence.ts';

const PER_HOUR = 300;
const pick = (o: any, ...keys: string[]) => { const lower: Record<string, any> = {}; for (const [k, v] of Object.entries(o || {})) lower[k.toLowerCase().replace(/[\s-]/g, '_')] = v; for (const k of keys) { const v = o[k] ?? lower[k.toLowerCase()]; if (v !== undefined && v !== null && typeof v !== 'object' && String(v).trim()) return String(v); } return ''; };
const truthy = (v: any) => /^(1|true|yes|y|on|checked|agreed)$/i.test(String(v ?? '').trim());

async function rateOk(E: any, key: string) {
  const id = `leadhook:${key.slice(0, 12)}`;
  const row = (await E.EngineCursor.filter({ key: id }, { limit: 1 })).items[0];
  let st = { start: Date.now(), n: 0 };
  try { const p = JSON.parse(row?.cursor || ''); if (Date.now() - p.start < 3600000) st = p; } catch { /* new window */ }
  if (st.n >= PER_HOUR) return false;
  st.n++;
  await E.EngineCursor.upsert([{ key: id, cursor: JSON.stringify(st) }], { key: 'key' });
  return true;
}

export function normalize(body: any) {
  const name = pick(body, 'name', 'full_name', 'fullName');
  const [nf, ...nl] = name.split(/\s+/);
  const consentWording = pick(body, 'consent_text', 'consentText', 'consent_language', 'tcpa_text', 'tcpa_language');
  const consentFlag = truthy(pick(body, 'consent', 'consent_given', 'sms_consent', 'tcpa_consent', 'opt_in', 'optin', 'agreed'));
  return {
    first_name: pick(body, 'first_name', 'firstName', 'first', 'fname') || nf || '',
    last_name: pick(body, 'last_name', 'lastName', 'last', 'lname') || nl.join(' '),
    phone: pick(body, 'phone', 'phone_number', 'phoneNumber', 'mobile', 'mobile_phone', 'cell', 'cell_phone'),
    email: pick(body, 'email', 'email_address', 'emailAddress'),
    state: pick(body, 'state', 'state_code', 'region', 'province'),
    lead_source: pick(body, 'source', 'lead_source', 'leadSource', 'vendor', 'utm_source', 'campaign'),
    inquiry_date: pick(body, 'created_at', 'submitted_at', 'date', 'timestamp') || new Date().toISOString(),
    consent_date: pick(body, 'consent_date', 'consent_timestamp', 'tcpa_timestamp', 'opt_in_date'),
    consent_wording: consentWording,
    // Both are required: the explicit flag says the box was ticked, the wording says what they agreed to.
    consent_flag: consentFlag,
    consented: consentFlag && consentWording.trim().length > 0,
    consent_url: pick(body, 'consent_url', 'page_url', 'landing_page', 'source_url', 'url'),
    consent_ip: pick(body, 'ip', 'ip_address', 'ipAddress'),
    facts: {
      product_interest: pick(body, 'product', 'product_interest', 'coverage_type', 'interest', 'insurance_type'),
      coverage_requested: pick(body, 'coverage', 'coverage_amount', 'face_amount', 'amount'),
      date_of_birth: pick(body, 'dob', 'date_of_birth', 'birthdate', 'birthday'),
      age: pick(body, 'age'),
      who_to_protect: pick(body, 'beneficiary', 'who_to_protect', 'protect'),
      dependents: pick(body, 'dependents', 'kids', 'children'),
      reason_in_their_words: pick(body, 'reason', 'goal', 'why', 'message', 'comments', 'question'),
      occupation: pick(body, 'occupation', 'job', 'employment'),
      prior_notes: pick(body, 'notes', 'note'),
    },
  };
}

export default async function (req: Request) {
  try {
    if (req.method !== 'POST') return Response.json({ error: 'Send leads with POST.' }, { status: 405 });
    const url = new URL(req.url);
    const key = url.searchParams.get('key') || req.headers.get('x-respark-key') || '';
    if (!/^[a-f0-9]{32}$/.test(key)) return Response.json({ error: 'Missing or invalid key.' }, { status: 401 });
    const raw = (await req.text()).slice(0, 20000);
    let body: any = {};
    const type = req.headers.get('content-type') || '';
    try { body = type.includes('application/x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw || '{}'); } catch { return Response.json({ error: 'Send JSON or form data.' }, { status: 400 }); }
    if (Array.isArray(body)) body = body[0] || {};
    if (body.contact && typeof body.contact === 'object') body = { ...body, ...body.contact };

    const base44 = resilient(createClientFromRequest(req));
    const E = base44.asServiceRole.entities;
    const raw_s = (await E.AgentSettings.filter({ lead_webhook_key: key }, { limit: 1 })).items[0];
    if (!raw_s) return Response.json({ error: 'Unknown key.' }, { status: 401 });
    if (!(await rateOk(E, key))) return Response.json({ error: 'Too many leads this hour. Try again later.' }, { status: 429 });
    const s = await agentSettings(base44, raw_s.agent_email);
    if (!s?.connected || !s.location_id) return Response.json({ error: 'This workspace is still being set up.' }, { status: 503 });

    const lead = normalize(body);
    const campaigns = await E.Campaign.filter({ agent_email: s.agent_email, location_id: s.location_id }, { limit: 50 });
    const campaign = campaigns.items.find((c: any) => c.id === s.lead_webhook_campaign_id) || campaigns.items.find((c: any) => c.status === 'active') || campaigns.items[0];
    if (!campaign) return Response.json({ error: 'No campaign to enroll leads into.' }, { status: 409 });

    const seller = businessName(s);
    const receivedAt = new Date().toISOString();
    const consentText = lead.consented
      ? [lead.consent_wording, lead.consent_url && `Page: ${clean(lead.consent_url, 300)}`, lead.consent_ip && `IP: ${clean(lead.consent_ip, 60)}`].filter(Boolean).join(' · ')
      : '';
    const intake = {
      campaign, source: lead.consented ? 'Lead webhook (consent captured)' : 'Lead webhook (no consent)', consentText, seller, batch: `webhook:${receivedAt.slice(0, 10)}`,
      leadSource: clean(lead.lead_source, 120) || 'Lead webhook', tags: ['respark-webhook'], consentDate: (lead.consent_date && Number.isFinite(Date.parse(lead.consent_date)) ? new Date(lead.consent_date) : new Date()).toISOString().slice(0, 10),
      // Without the flag plus wording the lead is kept but never texted (status closed, reported as held: "Consent flag missing").
      consented: lead.consented, dncBasis: lead.consented ? 'written_consent' : '',
    };
    const result = await intakeLead(E, s, { ...lead, consent_wording: consentText }, intake, { ghl, scope, e164 });

    // Proof of consent for this submission: what the form sent, from where, received when.
    if (lead.consented && result.lead_id && ['imported', 'held'].includes(result.status)) {
      await writeConsentRecords(E, [consentRecordFor(s, result, intake, {
        basis: 'webhook', attested_by: `webhook:${key.slice(0, 8)}`, attested_at: receivedAt, location_id: s.location_id || '',
        ip: clean(lead.consent_ip, 60) || (req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || '').split(',')[0].trim().slice(0, 64),
        user_agent: (req.headers.get('user-agent') || '').slice(0, 200), page_url: clean(lead.consent_url, 300),
      })]);
    }

    // Speed to lead: write and send the opener now instead of waiting for the next scheduled run.
    if (result.status === 'imported' && result.lead_id && campaign.status === 'active' && s.status === 'live') {
      waitUntil((async () => { try { const fresh = await E.Lead.get(result.lead_id); await runSequenceLead(base44, s, fresh, campaign); } catch { /* the scheduled sender retries */ } })());
    }
    return Response.json({ ok: true, status: result.status, reason: (result as any).reason || '', lead_id: result.lead_id || null });
  } catch (error) {
    return Response.json({ error: String((error as Error).message || 'Could not accept the lead.').slice(0, 200) }, { status: 400 });
  }
}
