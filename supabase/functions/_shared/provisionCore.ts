// Builds a complete LeadRespark workspace for one agent in GHL. Used by the
// self-serve welcome flow. Every step is idempotent: existing objects are found
// by ID or name and reused, so a failed or interrupted build can simply be re-run.
import { request, log } from './provisioning.ts';
import { agencyToken, agencyOAuthToken, mintLocationToken, credentialRecord } from './ghlAuth.ts';
import { stageNames, stageKeys, tagNames, fields, customValues } from './dataModelSpec.ts';
import { installPlaybook } from './playbooks.ts';
import { scope } from './ghl.ts';

export const STEPS = ['workspace', 'access', 'data_model', 'calendar', 'campaign'] as const;
export const STEP_LABELS: Record<string, string> = {
  workspace: 'Creating your private workspace',
  access: 'Connecting securely',
  data_model: 'Setting up lead fields, tags and your pipeline',
  calendar: 'Creating your booking calendar',
  campaign: 'Setting up your Life Insurance Respark campaign',
};

export class AwaitingConnection extends Error {}

async function progress(base44: any, s: any, patch: Record<string, any>) {
  const current = s.provisioning || { state: 'running', steps: {} };
  const next = { ...current, ...patch, steps: { ...(current.steps || {}), ...(patch.steps || {}) }, updated_at: new Date().toISOString() };
  const saved = await base44.asServiceRole.entities.AgentSettings.update(s.id, { provisioning: next });
  Object.assign(s, saved);
  return s;
}

function randomPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return `Rp!${Array.from(bytes, b => b.toString(36).padStart(2, '0')).join('').slice(0, 22)}9`;
}

async function stepWorkspace(base44: any, s: any, config: any) {
  if (s.location_id) return;
  const body = {
    name: `${s.brand_name || s.legal_business_name} – Respark`, phone: s.business_phone, companyId: config.agency_company_id,
    address: s.address_street, city: s.address_city, state: s.address_state, country: 'US', postalCode: s.address_zip,
    ...(s.domain ? { website: `https://${s.domain}` } : {}), timezone: s.home_timezone || config.default_timezone || 'America/Chicago',
    prospectInfo: { firstName: s.first_name, lastName: s.last_name || '', email: s.business_email || s.agent_email },
    settings: { allowDuplicateContact: false, allowDuplicateOpportunity: false, allowFacebookNameMerge: false, disableContactTimezone: false }, social: {},
  };
  const result = await request(s, '/locations/', 'POST', body, true);
  const id = result.data.location?.id || result.data.id;
  if (!id) throw new Error('GHL did not return the new workspace ID.');
  Object.assign(s, await base44.asServiceRole.entities.AgentSettings.update(s.id, { location_id: id }));
  await log(base44, s, 2, 'workspace', body.name, id, 'POST /locations/ (self-serve)', result.status);
}

async function stepAccess(base44: any, s: any) {
  // A pasted sub-account token (older setup) is kept as-is.
  // A sub-account token pasted by an admin (Admin > Agents > step 2) is used as-is.
  if (s.ghl_token && s.connected && s.token_kind !== 'oauth') return;
  if (!(await agencyOAuthToken(base44))) throw new AwaitingConnection('Waiting for the platform administrator to finish connecting GHL.');
  const cred = await credentialRecord(base44);
  const minted = await mintLocationToken(base44, cred.company_id, s.location_id);
  Object.assign(s, await base44.asServiceRole.entities.AgentSettings.update(s.id, { ghl_token: minted.token, ghl_token_expires_at: minted.expires_at, token_kind: 'oauth', connected: true }));
}

async function ensureAgentUser(base44: any, s: any, config: any) {
  if (s.agent_ghl_user_id) return s.agent_ghl_user_id;
  const email = String(s.agent_email).toLowerCase();
  const found = await request(s, `/users/search?companyId=${encodeURIComponent(config.agency_company_id)}&query=${encodeURIComponent(email)}`, 'GET', undefined, true);
  let user = (found.data.users || []).find((u: any) => String(u.email).toLowerCase() === email);
  if (!user) {
    const created = await request(s, '/users/', 'POST', {
      companyId: config.agency_company_id, firstName: s.first_name || 'Agent', lastName: s.last_name || '-', email, password: randomPassword(),
      type: 'account', role: 'user', locationIds: [s.location_id],
      permissions: { appointmentsEnabled: true, contactsEnabled: true, conversationsEnabled: true, opportunitiesEnabled: true, settingsEnabled: true, dashboardStatsEnabled: true, phoneCallEnabled: true },
    }, true);
    user = created.data.user || created.data;
    await log(base44, s, 4, 'user', email, user.id, 'POST /users/ (agent, self-serve)', created.status);
  } else {
    const locations = [...new Set([...(user.locationIds || user.roles?.locationIds || []), s.location_id])];
    await request(s, `/users/${encodeURIComponent(user.id)}`, 'PUT', { locationIds: locations }, true);
  }
  if (!user?.id) throw new Error('GHL did not return the agent user ID.');
  Object.assign(s, await base44.asServiceRole.entities.AgentSettings.update(s.id, { agent_ghl_user_id: user.id }));
  return user.id;
}

async function stepDataModel(base44: any, s: any) {
  const loc = encodeURIComponent(s.location_id);
  const [valuesR, fieldsR, tagsR, pipesR] = await Promise.all([
    request(s, `/locations/${loc}/customValues`), request(s, `/locations/${loc}/customFields`),
    request(s, `/locations/${loc}/tags`), request(s, `/opportunities/pipelines?locationId=${loc}`),
  ]);
  const ids: Record<string, Record<string, string>> = { customValue: {}, customField: {}, tag: {} };
  async function group(specs: any[], existing: any[], path: string, type: 'customValue' | 'customField' | 'tag', saved: any, update = false) {
    for (let i = 0; i < specs.length; i += 3) {
      const results = await Promise.allSettled(specs.slice(i, i + 3).map(async spec => {
        let item = existing.find(x => x.id === saved?.[spec.name]) || existing.find(x => String(x.name).toLowerCase() === spec.name.toLowerCase());
        if (!item) {
          const created = await request(s, path, 'POST', spec);
          item = created.data[type] || created.data;
          if (!item?.id) throw new Error(`GHL did not return an ID for ${spec.name}.`);
          await log(base44, s, 3, type, spec.name, item.id, `POST ${path}`, created.status);
        } else if (update) {
          await request(s, `${path}/${encodeURIComponent(item.id)}`, 'PUT', spec);
        }
        ids[type][spec.name] = item.id;
      }));
      const failed = results.find(r => r.status === 'rejected') as PromiseRejectedResult | undefined;
      if (failed) throw failed.reason;
    }
  }
  await group(Object.entries(customValues(s)).map(([name, value]) => ({ name, value: String(value || ' ') })), valuesR.data.customValues || [], `/locations/${loc}/customValues`, 'customValue', s.custom_value_ids, true);
  await group(fields.map(f => ({ ...f, model: 'contact' })), fieldsR.data.customFields || [], `/locations/${loc}/customFields`, 'customField', s.custom_field_ids);
  await group(tagNames.map(name => ({ name })), tagsR.data.tags || [], `/locations/${loc}/tags`, 'tag', s.tag_ids);
  let pipeline = (pipesR.data.pipelines || []).find((p: any) => p.id === s.pipeline_id) || (pipesR.data.pipelines || []).find((p: any) => p.name === 'Respark');
  if (!pipeline) {
    const created = await request(s, '/opportunities/pipelines', 'POST', { locationId: s.location_id, name: 'Respark', showInFunnel: true, showInPieChart: true, stages: stageNames.map((name, position) => ({ name, position })) });
    pipeline = created.data.pipeline || created.data;
    await log(base44, s, 3, 'pipeline', 'Respark', pipeline.id, 'POST /opportunities/pipelines', created.status);
  }
  const stage_ids: Record<string, string> = {};
  stageNames.forEach((name, i) => { const st = (pipeline.stages || []).find((v: any) => v.name === name); if (st) stage_ids[stageKeys[i]] = st.id; });
  if (Object.keys(stage_ids).length !== stageNames.length) throw new Error('The Respark pipeline is missing stages.');
  Object.assign(s, await base44.asServiceRole.entities.AgentSettings.update(s.id, { custom_value_ids: ids.customValue, custom_field_ids: ids.customField, tag_ids: ids.tag, pipeline_id: pipeline.id, stage_ids }));
}

async function stepCalendar(base44: any, s: any, config: any) {
  let calendar: any;
  if (s.calendar_id) { try { const r = await request(s, `/calendars/${encodeURIComponent(s.calendar_id)}`); calendar = r.data.calendar || r.data; } catch { calendar = null; } }
  if (!calendar?.id) { const all = await request(s, `/calendars/?locationId=${encodeURIComponent(s.location_id)}`); calendar = (all.data.calendars || []).find((c: any) => c.name === 'Respark Strategy Call'); }
  if (!calendar?.id) {
    // Appointments belong to the agent, never to the platform owner.
    const member = await ensureAgentUser(base44, s, config);
    const hours = s.calendar_hours?.length ? s.calendar_hours : [...[1, 2, 3, 4, 5].map(day => ({ day, open: '09:00', close: '18:00' })), { day: 6, open: '10:00', close: '14:00' }];
    const openHours = hours.map((h: any) => { const [oh, om] = h.open.split(':').map(Number); const [ch, cm] = h.close.split(':').map(Number); return { daysOfTheWeek: [Number(h.day)], hours: [{ openHour: oh, openMinute: om, closeHour: ch, closeMinute: cm }] }; });
    const body = {
      locationId: s.location_id, name: 'Respark Strategy Call', calendarType: 'round_robin', description: 'A 20-minute phone conversation about life insurance options.',
      slug: `respark-${String(s.location_id).slice(0, 8).toLowerCase()}`, widgetSlug: `respark-${String(s.location_id).slice(0, 8).toLowerCase()}`, widgetType: 'default',
      eventTitle: 'Respark Strategy Call: {{contact.name}} and {{custom_values.agent_first_name}}', eventColor: '#FF6B2C',
      teamMembers: [{ userId: member, priority: 0.5, isPrimary: true, locationConfigurations: [{ kind: 'outbound_call', location: '{{contact.phone}}', position: 0 }] }],
      slotDuration: 20, slotDurationUnit: 'mins', slotInterval: 20, slotIntervalUnit: 'mins', slotBuffer: 15, slotBufferUnit: 'mins', preBuffer: 0, preBufferUnit: 'mins',
      appoinmentPerSlot: 1, appoinmentPerDay: s.max_calls_per_day || 6, allowBookingAfter: 2, allowBookingAfterUnit: 'hours', allowBookingFor: 14, allowBookingForUnit: 'days',
      openHours, autoConfirm: true, allowReschedule: true, allowCancellation: true, stickyContact: true, googleInvitationEmails: false, shouldAssignContactToTeamMember: true,
      enableRecurring: false, isLivePaymentMode: false, formSubmitType: 'ThankYouMessage', formSubmitThanksMessage: "You're booked. {{custom_values.agent_first_name}} will call you at the time you picked. Reply STOP to any text to opt out.",
      availabilityType: 0, notifications: [{ type: 'email', shouldSendToContact: true, shouldSendToUser: true, shouldSendToSelectedUsers: false }],
    };
    const r = await request(s, '/calendars/', 'POST', body);
    calendar = r.data.calendar || r.data;
    if (!calendar?.id) throw new Error('GHL did not return the calendar ID.');
    await log(base44, s, 4, 'calendar', body.name, calendar.id, 'POST /calendars/ (self-serve)', r.status);
  }
  const booking_url = s.domain ? `https://${s.domain}/book` : `https://api.leadconnectorhq.com/widget/booking/${calendar.id}`;
  if (s.custom_value_ids?.booking_url) await request(s, `/locations/${encodeURIComponent(s.location_id)}/customValues/${encodeURIComponent(s.custom_value_ids.booking_url)}`, 'PUT', { name: 'booking_url', value: booking_url });
  Object.assign(s, await base44.asServiceRole.entities.AgentSettings.update(s.id, { calendar_id: calendar.id, booking_url }));
}

async function stepCampaign(base44: any, s: any) {
  // New workspaces start on the universal Life Insurance Respark playbook. It adapts to each lead's
  // product interest, so agents who sell IUL, term, whole life, final expense or mortgage protection
  // all start with the right campaign. Other playbooks can be added from the Campaigns page.
  const E = base44.asServiceRole.entities;
  const campaign = await installPlaybook(E, s, 'life_respark');
  if (campaign.location_id !== s.location_id || campaign.pipeline_id !== s.pipeline_id)
    await E.Campaign.update(campaign.id, { location_id: s.location_id, pipeline_id: s.pipeline_id, stage_ids: s.stage_ids });
}

export async function runProvisioning(base44: any, s: any, config: any) {
  const done = { ...(s.provisioning?.steps || {}) };
  await progress(base44, s, { state: 'running', error: '', started_at: s.provisioning?.started_at || new Date().toISOString() });
  const agency = await agencyToken(base44);
  s.__agency_token = agency.token;
  const runners: Record<string, () => Promise<void>> = {
    workspace: () => stepWorkspace(base44, s, config),
    access: () => stepAccess(base44, s),
    data_model: () => stepDataModel(base44, s),
    calendar: () => stepCalendar(base44, s, config),
    campaign: () => stepCampaign(base44, s),
  };
  for (const step of STEPS) {
    if (done[step] === 'done' && step !== 'access') continue;
    await progress(base44, s, { current: step, steps: { [step]: 'running' } });
    try {
      s.__agency_token = agency.token;
      await runners[step]();
      done[step] = 'done';
      await progress(base44, s, { steps: { [step]: 'done' } });
    } catch (error) {
      if (error instanceof AwaitingConnection) {
        await progress(base44, s, { state: 'awaiting_connection', current: step, steps: { [step]: 'waiting' }, error: error.message });
        return s;
      }
      await progress(base44, s, { state: 'error', current: step, steps: { [step]: 'error' }, error: String((error as Error).message || 'Something went wrong.').slice(0, 400) });
      throw error;
    }
  }
  const completed = [...new Set([...(s.completed_steps || []), 2, 3, 4, 8])];
  Object.assign(s, await base44.asServiceRole.entities.AgentSettings.update(s.id, { completed_steps: completed, onboarding_step: Math.max(s.onboarding_step || 1, 5), connected: true }));
  await progress(base44, s, { state: 'done', current: '', error: '', finished_at: new Date().toISOString() });
  delete s.__agency_token;
  return s;
}
