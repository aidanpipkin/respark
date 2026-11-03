// Approving a self-serve signup: grants access, closes the "waiting for approval" signal, starts
// building the workspace right away (when the profile is complete) and tells the agent. Used by
// Admin > Agents and, when the owner turns it on, automatically the moment the agent pays.
import { waitUntil } from './runtime.ts';
import { resolve } from './signals.ts';
import { runProvisioning } from './provisionCore.ts';
import { emailAgent } from './agentNotify.ts';
import { APP_ORIGIN } from './appointmentJourney.ts';

/** Profile fields the workspace build needs (shared with the welcome flow). */
export const REQUIRED_PROFILE: [string, string][] = [['first_name', 'first name'], ['last_name', 'last name'], ['brand_name', 'brand name'], ['legal_business_name', 'legal business name'], ['npn', 'NPN'], ['address_street', 'street address'], ['address_city', 'city'], ['address_state', 'state'], ['address_zip', 'ZIP code'], ['business_email', 'business email'], ['business_phone', 'business phone'], ['home_timezone', 'timezone']];

export function profileGaps(s: any) {
  const m = REQUIRED_PROFILE.filter(([k]) => !String(s?.[k] || '').trim()).map(([, label]) => label);
  if (!s?.licensed_states?.length) m.push('licensed states');
  return m;
}

/** True when approval is still outstanding for this agent under the current settings. */
export function awaitingApproval(config: any, s: any) {
  return config?.self_serve_requires_approval === true && !s?.beta_access && !s?.location_id;
}

/** Starts (or re-starts) the workspace build in the background unless one is already running. Returns true when started. */
export function startBuild(base44: any, s: any, config: any) {
  const E = base44.asServiceRole.entities;
  const p = s.provisioning || {};
  const busy = p.state === 'running' && Date.now() - Date.parse(p.updated_at || 0) < 3 * 60 * 1000;
  if (busy) return Promise.resolve(false);
  return E.AgentSettings.update(s.id, { provisioning: { ...p, state: 'running', error: '', updated_at: new Date().toISOString() } }).then((marked: any) => {
    const run = runProvisioning(base44, { ...marked }, config).catch(() => { /* progress records the error */ });
    try { waitUntil(run); } catch { /* no background slot: the build still runs on this request */ }
    return true;
  });
}

/**
 * Grants beta access, resolves the signup signal, kicks off the build and emails the agent.
 * `via` is recorded on the resolved signal ("admin", "payment", "card").
 */
export async function approveAgent(base44: any, s: any, config: any, via: string) {
  const E = base44.asServiceRole.entities;
  if (!s.beta_access) s = await E.AgentSettings.update(s.id, { beta_access: true });
  await resolve(base44, `signup_approval:${s.agent_email}`, `Approved (${via})`).catch(() => {});
  const gaps = profileGaps(s);
  let building = false;
  if (!gaps.length && !s.location_id) building = await startBuild(base44, s, config).catch(() => false);
  const body = building || s.location_id
    ? `Hi ${s.first_name || 'there'},\n\nYou're approved, and we're building your LeadRespark workspace right now. It takes about a minute: your contacts, calendar and pipeline are being set up for you.\n\nOpen your dashboard to watch it finish and go live:\n${APP_ORIGIN}/dashboard\n\nLeadRespark`
    : `Hi ${s.first_name || 'there'},\n\nYou're approved. Add your ${gaps.join(', ')} and your workspace builds itself in about a minute.\n\nFinish here: ${APP_ORIGIN}/welcome\n\nLeadRespark`;
  await emailAgent(base44, s, 'Your LeadRespark workspace is approved', body).catch(() => {});
  return { settings: s, building, gaps };
}
