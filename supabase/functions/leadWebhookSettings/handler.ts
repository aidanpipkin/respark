// Agent-facing settings for the fresh-lead webhook: URL, key rotation, target campaign, recent arrivals.
import { setupContext } from '../_shared/setupAccess.ts';
import { appOrigin } from '../_shared/agentSite.ts';
import { failure } from '../_shared/ghl.ts';
import { functionUrl } from '../_shared/runtime.ts';

const newKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');

export default async function (req: Request) {
  try {
    const { s, E } = await setupContext(req);
    const input = await req.json().catch(() => ({}));
    let key = s.lead_webhook_key, campaignId = s.lead_webhook_campaign_id || '';
    const campaigns = await E.Campaign.filter({ agent_email: s.agent_email, location_id: s.location_id }, { limit: 50 });
    if (input.action === 'enable' || input.action === 'rotate') { key = newKey(); await E.AgentSettings.update(s.id, { lead_webhook_key: key }); }
    if (input.action === 'disable') { key = ''; await E.AgentSettings.update(s.id, { lead_webhook_key: '' }); }
    if (input.action === 'campaign') {
      if (!campaigns.items.some((c: any) => c.id === input.campaign_id)) throw new Error('Choose one of your campaigns.');
      campaignId = input.campaign_id; await E.AgentSettings.update(s.id, { lead_webhook_campaign_id: campaignId });
    }
    const recent = await E.Lead.filter({ agent_email: s.agent_email, import_batch: { $regex: '^webhook' } }, { sort: '-created_date', limit: 10, fields: ['first_name', 'last_name', 'status', 'created_date', 'eligibility_reason'] });
    let origin = '';
    try { origin = appOrigin(req) || ''; } catch { origin = ''; }
    // Base44 served the webhook under the app origin; on Supabase it lives at ${SUPABASE_URL}/functions/v1/leadWebhook.
    let endpoint = '';
    try { endpoint = functionUrl('leadWebhook'); } catch { endpoint = `${origin || 'https://respark-pipkingroup.com'}/functions/leadWebhook`; }
    return Response.json({
      enabled: !!key,
      url: key ? `${endpoint}?key=${key}` : '',
      campaign_id: campaignId || campaigns.items.find((c: any) => c.status === 'active')?.id || '',
      campaigns: campaigns.items.map((c: any) => ({ id: c.id, name: c.name, status: c.status })),
      recent: recent.items.map((l: any) => ({ id: l.id, name: [l.first_name, l.last_name].filter(Boolean).join(' '), status: l.status, at: l.created_date, note: l.eligibility_reason })),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error as Error); }
}
