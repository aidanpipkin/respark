import { secrets } from '../_shared/runtime.ts';
import { adminContext } from '../_shared/agentAccess.ts';
import { platform } from '../_shared/provisioning.ts';
import { failure } from '../_shared/ghl.ts';
export default async function(req) {
 try { const { base44 } = await adminContext(req); const input = await req.json(); let config = await platform(base44);
 if (input.action === 'save') {
 const fields = ['agency_company_id','owner_email','default_timezone','default_sequence_campaign_id','a2p_packet_template','website_spec_template','test_plan_template','google_oauth_client_id','ms_oauth_client_id'];
 const update: Record<string, any> = {}; for (const key of fields) if (input[key] !== undefined) { if (typeof input[key] !== 'string' || input[key].length > 50000) throw new Error('Invalid platform setting.'); update[key] = input[key]; }
 if (update.default_timezone) new Intl.DateTimeFormat('en-US',{timeZone:update.default_timezone}).format();
 for (const key of ['owner_alert_phone','owner_alert_from_number']) if (input[key] !== undefined) { const v = String(input[key] || '').trim(); if (v && !/^\+[1-9]\d{7,14}$/.test(v)) throw new Error(`${key === 'owner_alert_phone' ? 'Owner alert mobile' : 'Alert from number'}: use E.164 format, like +19185550142.`); update[key] = v; }
 for (const key of ['auto_approve_on_payment','llm_fallback_allowed']) if (input[key] !== undefined) { if (typeof input[key] !== 'boolean') throw new Error('Invalid platform setting.'); update[key] = input[key]; }
 if (input.stripe_mode !== undefined) { if (!['test','live'].includes(input.stripe_mode)) throw new Error('Invalid billing mode.'); update.stripe_mode=input.stripe_mode; }
 if (input.phone_number_setup_fee_cents !== undefined) { if (input.phone_number_setup_fee_cents !== 0) throw new Error('Beta setup fees must remain zero until paid provisioning is enabled.'); update.phone_number_setup_fee_cents=0; }
 if (input.default_send_windows !== undefined) { if (!input.default_send_windows || typeof input.default_send_windows !== 'object' || JSON.stringify(input.default_send_windows).length > 2000) throw new Error('Invalid send windows.'); update.default_send_windows = input.default_send_windows; }
 config = await base44.entities.PlatformSettings.update(config.id, update);
 }
 return Response.json({ config, secrets: { RESPARK_GHL_AGENCY_TOKEN: !!secrets.get('RESPARK_GHL_AGENCY_TOKEN'), RESPARK_WEBHOOK_SECRET: !!secrets.get('RESPARK_WEBHOOK_SECRET'), STRIPE_SECRET_KEY: !!secrets.get('STRIPE_SECRET_KEY'), STRIPE_PUBLISHABLE_KEY: !!secrets.get('STRIPE_PUBLISHABLE_KEY'), 'STRIPE_WEBHOOK_SECRET (Stripe → Webhooks signing secret)': !!secrets.get('STRIPE_WEBHOOK_SECRET'), GOOGLE_OAUTH_CLIENT_SECRET: !!secrets.get('GOOGLE_OAUTH_CLIENT_SECRET'), 'MS_CLIENT_SECRET (Microsoft 365 calendar, with MS_CLIENT_ID)': !!(secrets.get('MS_CLIENT_ID')&&secrets.get('MS_CLIENT_SECRET')), GHL_CLIENT_SECRET: !!secrets.get('GHL_CLIENT_SECRET'), TWILIO_ACCOUNT_SID: !!(secrets.get('TWILIO_ACCOUNT_SID')||secrets.get('Twillio_SID')), TWILIO_AUTH_TOKEN: !!(secrets.get('TWILIO_AUTH_TOKEN')||secrets.get('Twillio_Auth')), 'ANTHROPIC_API_KEY (AI texts without Base44 credit cap)': !!secrets.get('ANTHROPIC_API_KEY'), 'OPENAI_API_KEY (alternative to Anthropic)': !!secrets.get('OPENAI_API_KEY') } });
 } catch (error) { return failure(error); }
}