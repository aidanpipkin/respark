import { context, agentSettings } from './ghl.ts';
export async function adminContext(req) {
 const ctx = await context(req); if (ctx.user.role !== 'admin') throw Object.assign(new Error('Administrator access required.'), { status: 403 }); return ctx;
}
export async function actingSettings(base44, user, input: any = {}) {
 if (input.agent_email && user.role !== 'admin' && input.agent_email !== user.email) throw new Error('Access denied.');
 const settings = await agentSettings(base44, user.role === 'admin' && input.agent_email ? input.agent_email : user.email);
 if (!settings) throw new Error('Your account is awaiting setup. Please contact your administrator.'); return settings;
}
export function publicRecord(record) {
 if (!record) return null;
 const omitted = ['location_id','lead_snapshot','stage_ids','pipeline_id','calendar_id','custom_field_ids','custom_value_ids','tag_ids','ghl_token','send_lock_token','send_lock_until','website_request_key','last_inbound_id'];
 return Object.fromEntries(Object.entries(record).filter(([key]) => !key.startsWith('ghl_') && !omitted.includes(key)));
}
export function adminSettings(settings) { const { ghl_token, ...safe } = settings; return { ...safe, credential_saved: !!ghl_token }; }