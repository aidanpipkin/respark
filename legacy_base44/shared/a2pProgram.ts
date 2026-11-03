// Recommended A2P 10DLC "texting program" copy, written to carrier (TCR) review rules:
// brand named in every sample, STOP language, no links or phone numbers in samples,
// a concrete opt-in flow that matches the agent's hosted compliant page, and STOP/HELP replies.
// Agents get this pre-filled so they only enter identity details.

import { ensurePublicSlug, appOrigin, siteLinks, hostedOptInFlow } from './agentSite.ts';

export async function hostedSite(req: Request, E: any, s: any) {
  const links = siteLinks(appOrigin(req), await ensurePublicSlug(E, s));
  return { ...links, opt_in_flow: hostedOptInFlow(s, links) };
}

/** Pre-fills links and program copy so the agent only supplies identity details. */
export async function completeRegistration(req: Request, E: any, s: any, data: any) {
  const site = await hostedSite(req, E, s);
  fillLinks(data, site);
  if (s?.licensed_states && !data.licensed_states) data.licensed_states = s.licensed_states;
  return fillProgram(data, data.website === site.url ? site.opt_in_flow : '', s?.brand_name || '');
}

export const PROGRAM_FIELDS = ['description', 'opt_in_flow', 'sample_message_1', 'sample_message_2', 'stop_response', 'help_response'];

function first(v: any, fallback: string) { const t = String(v || '').trim(); return t || fallback; }

export function programBrand(reg: any) {
  return first(reg.legal_business_name, `${reg.first_name || ''} ${reg.last_name || ''}`.trim() || 'our agency');
}

/** Two extra samples sent to the carriers alongside the agent's two (Twilio accepts up to five). */
export function extraSamples(reg: any) {
  const brand = programBrand(reg), agent = first(reg.first_name, 'your agent');
  return [
    `${brand}: Reminder, ${agent} will call you in about 10 minutes for the life insurance review you scheduled. Reply R to reschedule or STOP to opt out.`,
    `Hi Sarah, it's ${agent} with ${brand}. Following up on the life insurance information you requested. Do mornings or afternoons work better for a quick call? Reply STOP to opt out.`,
  ];
}

/** The full recommended program for this registration. `optInFlow` is the hosted-page flow when available. */
export function recommendedProgram(reg: any, optInFlow = '', dbaName = '') {
  const brand = programBrand(reg), agent = first(reg.first_name, 'your agent');
  reg = { ...reg, dba: dbaName || reg.dba || '' };
  // Carriers reject descriptions that don't name the sender, the recipients and the purpose, that mix
  // use cases (marketing plus account notices), or that carry personal identifiers. Keep it to one program.
  const dba = reg.dba && String(reg.dba).trim().toLowerCase() !== brand.toLowerCase();
  const agentFull = [reg.first_name, reg.last_name].filter(Boolean).join(' ').trim() || agent;
  const list = Array.isArray(reg.licensed_states) ? reg.licensed_states.filter((x: string) => /^[A-Z]{2}$/.test(x)) : [];
  const states = list.length ? ` licensed in ${list.length <= 6 ? list.join(', ') : `${list.length} states including ${list.slice(0, 4).join(', ')}`}` : '';
  const site = /^https:\/\//.test(String(reg.website || '')) ? `${String(reg.website).replace(/\/$/, '')}/get-info` : '';
  const phone = first(reg.business_phone, '');
  const email = first(reg.business_email, '');
  const contact = [phone && `call ${phone.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3')}`, email && `email ${email}`].filter(Boolean).join(' or ') || 'reply to this message';
  return {
    description: `${brand}${dba ? ` (doing business as ${String(reg.dba).trim()})` : ''} is an independent life insurance agency${states}. ${brand} sends text messages only to consumers who requested life insurance information from ${brand} and opted in to receive text messages, by checking the SMS consent box on the ${brand} request form${site ? ` at ${site}` : ''} or by giving documented written consent when they requested information. Messages follow up on that request: answers to the consumer's coverage questions, invitations to schedule a phone appointment with the licensed agent, and confirmations and reminders for appointments the consumer schedules. Messages are conversational and sent one to one on behalf of the agency's licensed agent, ${agentFull}. Message frequency varies. Message and data rates may apply. Consumers can reply STOP at any time to opt out and HELP for help.`,
    opt_in_flow: optInFlow || `Contacts opt in on our website request-information form, where they enter their name, phone number and email and may check a separate, optional checkbox (unchecked by default) that reads: "By checking this box, I agree to receive text messages from ${agent} of ${brand} about life insurance options at the number provided, including messages sent using automated technology. Consent is not a condition of purchase. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help." We only text people who gave this consent naming ${brand}, or gave ${brand} documented written consent when they requested information from ${brand}, which ${brand} keeps on file. Our privacy policy and SMS terms are linked on the form.`,
    sample_message_1: `Hi Sarah, it's ${agent} with ${brand}. You asked about life insurance options for your family. Want me to go over a few options with you? Reply STOP to opt out.`,
    sample_message_2: `${brand}: Hi Sarah, your phone appointment with ${agent} is set for Tue 10/27 at 2:00 PM CT to go over your life insurance options. Reply C to confirm or R to reschedule. Reply STOP to opt out.`,
    stop_response: `${brand}: You are unsubscribed and will receive no further messages. Reply START to resubscribe.`,
    help_response: `${brand}: For help, ${contact}. Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out.`.slice(0, 320),
  };
}

/** Hosted compliant page used whenever the agent's own site can't carry the privacy policy and SMS terms. */
export function fillLinks(data: any, site: { url: string; privacy_url: string; terms_url: string; opt_in_flow: string } | null) {
  if (!site) return data;
  const host = (u: string) => { try { return new URL(u).hostname; } catch { return ''; } };
  const ok = data.website && data.privacy_url && data.terms_url && host(data.privacy_url) === host(data.website) && host(data.terms_url) === host(data.website);
  if (!ok) { data.website = site.url; data.privacy_url = site.privacy_url; data.terms_url = site.terms_url; }
  // An opt-in description that doesn't describe the hosted form would not match what reviewers find there.
  if (data.website === site.url && !String(data.opt_in_flow || '').includes(site.url)) data.opt_in_flow = site.opt_in_flow;
  return data;
}

/** A sample the carriers will accept: names the brand, has STOP, no links or phone numbers. */
export function sampleOk(m: string, brand: string) {
  const t = String(m || '');
  return t.length >= 40 && t.length <= 320 && /\bSTOP\b/.test(t) && t.toLowerCase().includes(brand.toLowerCase()) && !/https?:|www\.|\.com\b|\d{3}[\s.)-]*\d{3}[\s.-]*\d{4}/i.test(t);
}

/** Fills any empty program field with the recommended copy. Never overwrites what the agent wrote. */
export function fillProgram(data: any, optInFlow = '', dbaName = '') {
  const rec = recommendedProgram(data, optInFlow, dbaName) as Record<string, string>;
  const brand = programBrand(data).toLowerCase();
  for (const k of PROGRAM_FIELDS) {
    const v = String(data[k] || '').trim();
    // Samples written for an older business name no longer pass review; replace them.
    const stale = k.startsWith('sample_message') && v && !v.toLowerCase().includes(brand);
    if (!v || stale) data[k] = rec[k];
  }
  return data;
}
