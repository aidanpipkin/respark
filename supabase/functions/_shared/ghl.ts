import { createClientFromRequest } from './runtime.ts';
import { resilient } from './entityRetry.ts';
import { freshSettings } from './ghlAuth.ts';
export async function context(req) {
  const base44 = resilient(createClientFromRequest(req));
  const user = await base44.auth.me();
  if (!user) throw new Error('Please sign in.');
  return { base44, user };
}
// Short in-memory cache: a busy send run reads the same agent's settings many times,
// and Base44 limits list calls per caller. 15s staleness is safe for every check here.
const settingsCache = new Map<string, { at: number; page: any }>();
export function forgetSettings(email?: string) { if (email) settingsCache.delete(email); else settingsCache.clear(); }
// Only the background send path opts in (cached=true); screens always read fresh.
export async function agentSettings(base44, email, cached = false) {
  const hit = cached ? settingsCache.get(email) : null;
  if (hit && Date.now() - hit.at < 15000) { const fresh = await freshSettings(base44, hit.page.items[0]); if (fresh !== hit.page.items[0]) settingsCache.set(email, { at: Date.now(), page: { items: [fresh] } }); return fresh; }
  const page = await base44.asServiceRole.entities.AgentSettings.filter({ agent_email: email }, { limit: 1 });
  // Workspaces connected through the marketplace app get a fresh sub-account token here.
  const fresh = await freshSettings(base44, page.items[0]);
  if (fresh) { if (settingsCache.size > 2000) settingsCache.clear(); settingsCache.set(email, { at: Date.now(), page: { items: [fresh] } }); }
  return fresh;
}
export function own(user, record) {
  if (!record || (user.role !== 'admin' && record.agent_email !== user.email)) throw new Error('Access denied.');
  return record;
}
export async function ghl(settings, path, method = 'GET', body) {
  if (!settings?.ghl_token || !settings?.location_id || !settings.connected) throw new Error('Your messaging connection is not ready. Please contact your administrator.');
  // GHL allows ~100 requests per 10s per location. A 429 means nothing was processed, so it is always
  // safe to wait and retry; other server errors are retried only for reads (a send must never double).
  let response;
  for (let attempt = 0; ; attempt++) {
    response = await fetch(`https://services.leadconnectorhq.com${path}`, {
      method, headers: { Authorization: `Bearer ${settings.ghl_token}`, Version: path.startsWith('/conversations') ? '2021-04-15' : '2021-07-28', 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000)
    });
    const retryable = response.status === 429 || (method === 'GET' && response.status >= 500);
    if (!retryable || attempt >= 3) break;
    const after = Number(response.headers.get('retry-after')) * 1000;
    await response.body?.cancel().catch(() => {});
    await new Promise(r => setTimeout(r, Math.min(10000, after > 0 ? after : 800 * 2 ** attempt) + Math.random() * 300));
  }
  if (!response.ok) throw new Error(`Messaging service unavailable (${response.status}). Please contact your administrator.`);
  if (response.status === 204) return {};
  return response.json();
}
export const scope = (settings) => ({ agent_email: settings.agent_email, location_id: settings.location_id || '' });
export function safeSettings(s) {
  if (!s) return { connected: false, home_timezone: 'America/Chicago', mode: 'review', licensed_states: [], send_window_1: '11:00-13:00', send_window_2: '17:00-19:00', hard_floor: '09:00', hard_ceiling: '20:00', opt_out_keywords: ['STOP','UNSUBSCRIBE','CANCEL','END','QUIT','wrong number',"don't text",'remove me'] };
  const fields = ['first_name','display_name','brand_name','agent_title','logo_url','headshot_url','primary_color','accent_color','licensed_states','home_timezone','mode','notification_phone','notification_email','quiet_start','quiet_end','connected','status','reply_alerts'];
  const result = Object.fromEntries(fields.map(key => [key, s[key]]));
  result.brand_name = s.brand_name || 'LeadRespark';
  result.booking_url = s.domain && s.booking_url === `https://${s.domain}/book` ? s.booking_url : '';
  return result;
}
export function failure(error) { return Response.json({ error: error.message || 'The request could not be completed.' }, { status: error.status || 400 }); }