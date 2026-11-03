import { secrets } from 'base44:runtime';
import { agentSettings } from './ghl.ts';
import { adminContext } from './agentAccess.ts';
import { defaults } from './platformDefaults.ts';
export async function platform(base44) {
 const p = await base44.entities.PlatformSettings.filter({ singleton_key: 'platform' }, { limit: 1 });
 if (p.items[0]) return p.items[0];
 const campaigns = await base44.entities.Campaign.filter({ name: 'Trucker IUL' }, { sort: 'created_date', limit: 1 });
 const result = await base44.entities.PlatformSettings.upsert([{ ...defaults, default_sequence_campaign_id: campaigns.items[0]?.id || '' }], { key: 'singleton_key' });
 return result.records[0];
}
export async function setup(req) {
 const ctx = await adminContext(req); const input = await req.json();
 if (typeof input.agent_email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.agent_email)) throw new Error('Choose an agent first.');
 const settings = await agentSettings(ctx.base44, input.agent_email.toLowerCase().trim());
 if (!settings) throw new Error('Save the agent profile first.');
 return { ...ctx, input, settings, config: await platform(ctx.base44) };
}
export async function request(settings, path, method = 'GET', body, agency = false) {
 // Agency calls use the marketplace OAuth token when provided by the caller, else the stored private token.
 const credential = agency ? (settings?.__agency_token || secrets.get('RESPARK_GHL_AGENCY_TOKEN')) : settings?.ghl_token;
 if (!credential) throw new Error(agency ? 'Set the agency credential in platform secrets first.' : 'Save and verify this agent’s workspace credential first.');
 const res = await fetch(`https://services.leadconnectorhq.com${path}`, { method, headers: { Authorization: `Bearer ${credential}`, Version: path.startsWith('/conversations') ? '2021-04-15' : '2021-07-28', Accept: 'application/json', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
 const text = await res.text(); let data; try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
 if (!res.ok) { const error = new Error(`Provider request failed (${res.status}). ${String(data.message || data.error || 'Review endpoint access and permissions.').slice(0,250)}`); error.status = res.status; throw error; }
 return { data, status: res.status };
}
export async function log(base44, settings, step, type, name, id, method, status = 200) {
 await base44.asServiceRole.entities.ProvisioningLog.create({ agent_email: settings.agent_email, location_id: settings.location_id || '', step, object_type: type, object_name: name, object_id: id || '', request_summary: method, response_status: status, created_at: new Date().toISOString() });
}
export async function complete(base44, settings, step, extra = {}) {
 return base44.asServiceRole.entities.AgentSettings.update(settings.id, { ...extra, completed_steps: [...new Set([...(settings.completed_steps || []),step])], onboarding_step: Math.max(settings.onboarding_step || 1, Math.min(step + 1, 9)) });
}