import { context, agentSettings, safeSettings, scope, ghl, failure } from '../../shared/ghl.ts';
const allowed = ['display_name','notification_phone','notification_email','quiet_start','quiet_end','mode','reply_alerts'];
export default async function(req) {
  try {
    const { base44, user } = await context(req); const input = await req.json();
    const old = await agentSettings(base44, user.email);
    if (!old) throw new Error('Open your workspace first.');
    const data = Object.fromEntries(allowed.filter(key => input[key] !== undefined).map(key => [key, input[key]]));
    for (const [key, value] of Object.entries(data)) if (typeof value === 'string' && value.length > 500) throw new Error(`${key} is too long.`);
    if (data.licensed_states && (!Array.isArray(data.licensed_states) || data.licensed_states.length > 51 || data.licensed_states.some(s => !/^[A-Z]{2}$/.test(s)))) throw new Error('Select valid licensed states.');
    if (data.opt_out_keywords && (!Array.isArray(data.opt_out_keywords) || data.opt_out_keywords.length > 40 || data.opt_out_keywords.some(s => typeof s !== 'string' || s.length > 60))) throw new Error('Use up to 40 short opt-out phrases.');
    if (data.home_timezone) new Intl.DateTimeFormat('en-US', { timeZone: data.home_timezone }).format();
    if (input.ghl_token || input.location_id) throw new Error('Use the administrator onboarding flow to configure service access.');
    if (data.mode && !['review','autopilot'].includes(data.mode)) throw new Error('Choose a valid reply preference.');
    if (data.reply_alerts !== undefined && !['every','needs_you','off'].includes(data.reply_alerts)) throw new Error('Choose when to be texted about replies.');
    for (const key of ['quiet_start','quiet_end']) if (data[key] && !/^([01]\d|2[0-3]):[0-5]\d$/.test(data[key])) throw new Error('Enter valid quiet hours.');
    if (data.notification_phone && !/^\+[1-9]\d{7,14}$/.test(data.notification_phone)) throw new Error('Use international phone format, such as +19403681353.');
    if (data.notification_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.notification_email)) throw new Error('Enter a valid notification email.');
    const saved = await base44.asServiceRole.entities.AgentSettings.update(old.id, data);
    // One switch: the agent's reply preference applies to all their campaigns (both must be autopilot to send automatically).
    if (data.mode) await base44.asServiceRole.entities.Campaign.updateMany({ agent_email: old.agent_email }, { $set: { mode: data.mode } });
    if (data.mode) await base44.asServiceRole.entities.ControlAudit.create({ ...scope(old), actor_email: user.email, action: 'reply_preference_changed', details: { mode: data.mode }, occurred_at: new Date().toISOString() });
    return Response.json({ connected: !!saved.connected, settings: safeSettings(saved) });
  } catch (error) { return failure(error); }
}