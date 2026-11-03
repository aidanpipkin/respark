// GHL credentials for the platform.
//
// The agency connects once by installing the LeadRespark marketplace app. That
// gives an agency (Company) OAuth token, stored server-side in PlatformCredential.
// From it the platform can mint a sub-account (Location) token for any agent's
// workspace on demand, so nobody ever pastes a token by hand.
//
// Older workspaces that were connected with a pasted private-integration token
// (token_kind 'pit') keep working unchanged.
import { secrets } from 'base44:runtime';

const API = 'https://services.leadconnectorhq.com';
const KEY = 'ghl_agency';
const EARLY_MS = 10 * 60 * 1000; // refresh 10 minutes before expiry

function form(body: Record<string, string>) {
  return new URLSearchParams(Object.entries(body).filter(([, v]) => v !== undefined && v !== '')).toString();
}
async function post(path: string, body: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...headers }, body, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let data: any = {}; try { data = text ? JSON.parse(text) : {}; } catch { /* non-JSON error page */ }
  if (!res.ok) { const e: any = new Error(`GHL authorization failed (${res.status}). ${String(data.message || data.error_description || data.error || '').slice(0, 200)}`); e.status = res.status; throw e; }
  return data;
}

export async function clientConfig(base44: any) {
  const p = await base44.asServiceRole.entities.PlatformSettings.filter({ singleton_key: 'platform' }, { limit: 1 });
  const config = p.items[0] || {};
  const clientId = config.ghl_client_id || secrets.get('GHL_CLIENT_ID') || '';
  const clientSecret = secrets.get('GHL_CLIENT_SECRET') || '';
  return { config, clientId, clientSecret };
}

export async function credentialRecord(base44: any) {
  const page = await base44.asServiceRole.entities.PlatformCredential.filter({ key: KEY }, { limit: 1 });
  return page.items[0] || null;
}

export function redirectUri(origin: string) { return new URL('/functions/ghlOAuth', origin).toString(); }

// Exchange the code GHL sends after the agency installs the app.
export async function exchangeCode(base44: any, code: string, redirect: string) {
  const { config, clientId, clientSecret } = await clientConfig(base44);
  if (!clientId || !clientSecret) throw new Error('Add the marketplace app client ID and the GHL_CLIENT_SECRET secret first.');
  const data = await post('/oauth/token', form({ client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', code, user_type: 'Company', redirect_uri: redirect }));
  if (data.userType !== 'Company' || !data.companyId) throw new Error('Install the app at the agency level (not a single sub-account).');
  if (config.agency_company_id && data.companyId !== config.agency_company_id) throw new Error('This installation belongs to a different agency.');
  const now = Date.now();
  const record = { key: KEY, company_id: data.companyId, access_token: data.access_token, refresh_token: data.refresh_token, expires_at: new Date(now + (Number(data.expires_in) || 86000) * 1000).toISOString(), scope: String(data.scope || '').slice(0, 4000), installed_by_user_id: data.userId || '', is_bulk_installation: !!data.isBulkInstallation, connected_at: new Date(now).toISOString(), last_refresh_at: new Date(now).toISOString(), last_error: '' };
  const existing = await credentialRecord(base44);
  if (existing) await base44.asServiceRole.entities.PlatformCredential.update(existing.id, record);
  else await base44.asServiceRole.entities.PlatformCredential.create(record);
  return { company_id: data.companyId, bulk: !!data.isBulkInstallation };
}

// Agency OAuth access token, refreshed when close to expiry. Null when the
// marketplace app has not been installed yet.
export async function agencyOAuthToken(base44: any): Promise<string | null> {
  let cred = await credentialRecord(base44);
  if (!cred?.refresh_token) return null;
  if (Date.parse(cred.expires_at || '') - Date.now() > EARLY_MS) return cred.access_token;
  const { clientId, clientSecret } = await clientConfig(base44);
  try {
    const data = await post('/oauth/token', form({ client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: cred.refresh_token, user_type: 'Company' }));
    const update = { access_token: data.access_token, refresh_token: data.refresh_token || cred.refresh_token, expires_at: new Date(Date.now() + (Number(data.expires_in) || 86000) * 1000).toISOString(), last_refresh_at: new Date().toISOString(), last_error: '' };
    cred = await base44.asServiceRole.entities.PlatformCredential.update(cred.id, update);
    return cred.access_token;
  } catch (e) {
    await base44.asServiceRole.entities.PlatformCredential.update(cred.id, { last_error: String((e as Error).message).slice(0, 500) });
    throw new Error('The GHL agency connection needs to be reconnected by an administrator.');
  }
}

// Agency-level credential for creating sub-accounts and users: the OAuth token
// when connected, otherwise the private integration token kept in secrets.
export async function agencyToken(base44: any) {
  const oauth = await agencyOAuthToken(base44);
  if (oauth) return { token: oauth, kind: 'oauth' as const };
  const pit = secrets.get('RESPARK_GHL_AGENCY_TOKEN');
  if (pit) return { token: pit, kind: 'pit' as const };
  throw new Error('Connect the GHL agency first (Admin > Platform > GHL connection).');
}

export async function mintLocationToken(base44: any, companyId: string, locationId: string) {
  const token = await agencyOAuthToken(base44);
  if (!token) throw new Error('The GHL marketplace app is not connected yet, so a workspace token cannot be created automatically.');
  try {
    const data = await post('/oauth/locationToken', form({ companyId, locationId }), { Authorization: `Bearer ${token}`, Version: '2021-07-28' });
    if (!data.access_token) throw new Error('GHL did not return a workspace token.');
    return { token: data.access_token as string, expires_at: new Date(Date.now() + (Number(data.expires_in) || 86000) * 1000).toISOString() };
  } catch (e: any) {
    if ([400, 401, 403].includes(e.status)) throw new Error('The LeadRespark app is not installed on this sub-account yet. In GHL, install it on all sub-accounts (or this one), then try again.');
    throw e;
  }
}

// Make sure an agent's settings carry a usable sub-account token.
export async function freshSettings(base44: any, s: any) {
  if (!s || s.token_kind !== 'oauth' || !s.location_id) return s;
  if (s.ghl_token && Date.parse(s.ghl_token_expires_at || '') - Date.now() > EARLY_MS) return s;
  const cred = await credentialRecord(base44);
  const minted = await mintLocationToken(base44, cred?.company_id || '', s.location_id);
  return base44.asServiceRole.entities.AgentSettings.update(s.id, { ghl_token: minted.token, ghl_token_expires_at: minted.expires_at, connected: true });
}

export async function connectionStatus(base44: any) {
  const { config, clientId, clientSecret } = await clientConfig(base44);
  const cred = await credentialRecord(base44);
  return {
    client_id_set: !!clientId, client_secret_set: !!clientSecret, install_url_set: !!config.ghl_install_url,
    connected: !!cred?.refresh_token, company_id: cred?.company_id || '', connected_at: cred?.connected_at || '',
    bulk_installation: !!cred?.is_bulk_installation, last_error: cred?.last_error || '',
    agency_pit_set: !!secrets.get('RESPARK_GHL_AGENCY_TOKEN'),
  };
}
