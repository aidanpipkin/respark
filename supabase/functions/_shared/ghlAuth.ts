// GHL credentials for the platform.
//
// The agency connects once by installing the LeadRespark marketplace app. That
// gives an agency (Company) OAuth token, stored server-side in PlatformCredential.
// From it the platform can mint a sub-account (Location) token for any agent's
// workspace on demand, so nobody ever pastes a token by hand.
//
// Older workspaces that were connected with a pasted private-integration token
// (token_kind 'pit') keep working unchanged.
import { secrets, functionUrl, timingSafeEqual } from './runtime.ts';
import { getSql } from './entities.ts';

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

// The OAuth redirect is the public ghlOAuth edge function (Base44 served it under the app origin; Supabase at /functions/v1).
export function redirectUri(origin: string) { try { return functionUrl('ghlOAuth'); } catch { return new URL('/functions/ghlOAuth', origin).toString(); } }

// Exchange the code GHL sends after the agency installs the app.
export async function exchangeCode(base44: any, code: string, redirect: string) {
  const { config, clientId, clientSecret } = await clientConfig(base44);
  if (!clientId || !clientSecret) throw new Error('Add the marketplace app client ID and the GHL_CLIENT_SECRET secret first.');
  // Without a known agency any GHL account that installs the app would become "the agency".
  if (!String(config.agency_company_id || '').trim()) throw new Error('Set the Agency company ID on Admin > Platform before connecting GHL.');
  const data = await post('/oauth/token', form({ client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', code, user_type: 'Company', redirect_uri: redirect }));
  if (data.userType !== 'Company' || !data.companyId) throw new Error('Install the app at the agency level (not a single sub-account).');
  if (data.companyId !== config.agency_company_id) throw new Error('This installation belongs to a different agency.');
  const now = Date.now();
  const record = { key: KEY, company_id: data.companyId, access_token: data.access_token, refresh_token: data.refresh_token, expires_at: new Date(now + (Number(data.expires_in) || 86000) * 1000).toISOString(), scope: String(data.scope || '').slice(0, 4000), installed_by_user_id: data.userId || '', is_bulk_installation: !!data.isBulkInstallation, connected_at: new Date(now).toISOString(), last_refresh_at: new Date(now).toISOString(), last_error: '' };
  const existing = await credentialRecord(base44);
  if (existing) await base44.asServiceRole.entities.PlatformCredential.update(existing.id, record);
  else await base44.asServiceRole.entities.PlatformCredential.create(record);
  return { company_id: data.companyId, bulk: !!data.isBulkInstallation };
}

// Agency OAuth access token, refreshed when close to expiry. Null when the
// marketplace app has not been installed yet.
//
// GHL rotates the refresh token on every refresh, so two isolates refreshing at once would leave one
// of them holding a dead token and overwrite the good one. The refresh runs under a transaction-scoped
// advisory lock: whoever gets the lock re-reads the row and skips the refresh if it already happened.
const fresh = (cred: any) => !!cred?.access_token && Date.parse(cred.expires_at || '') - Date.now() > EARLY_MS;

export async function agencyOAuthToken(base44: any): Promise<string | null> {
  const cred = await credentialRecord(base44);
  if (!cred?.refresh_token) return null;
  if (fresh(cred)) return cred.access_token;
  const { clientId, clientSecret } = await clientConfig(base44);
  const sql = getSql();
  type Outcome = { token: string | null } | { failed: { id: string; message: string } };
  const outcome = await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('ghl_agency_refresh'))`;
    const rows = await tx`select id, access_token, refresh_token, expires_at from public.platform_credential where key = ${KEY} limit 1`;
    const current = rows[0] as { id: string; access_token?: string; refresh_token?: string; expires_at?: string } | undefined;
    if (!current?.refresh_token) return { token: null };
    // Another isolate refreshed while we waited for the lock.
    if (fresh(current)) return { token: current.access_token as string };
    try {
      const data = await post('/oauth/token', form({ client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: current.refresh_token, user_type: 'Company' }));
      if (!data.access_token) throw new Error('GHL returned no access token.');
      const expiresAt = new Date(Date.now() + (Number(data.expires_in) || 86000) * 1000).toISOString();
      const refreshToken = String(data.refresh_token || current.refresh_token);
      const now = new Date().toISOString();
      await tx`update public.platform_credential set access_token = ${String(data.access_token)}, refresh_token = ${refreshToken}, expires_at = ${expiresAt}, last_refresh_at = ${now}, last_error = '' where id = ${current.id}`;
      return { token: String(data.access_token) };
    } catch (e) {
      // Returned (not thrown) so the lock transaction commits; last_error is written outside it below.
      return { failed: { id: current.id, message: String((e as Error).message || e).slice(0, 500) } };
    }
  }) as unknown as Outcome;
  if ('failed' in outcome) {
    console.error('[ghlAuth] agency token refresh failed:', outcome.failed.message);
    await base44.asServiceRole.entities.PlatformCredential.update(outcome.failed.id, { last_error: outcome.failed.message }).catch(() => {});
    throw new Error('The GHL agency connection needs to be reconnected by an administrator.');
  }
  return outcome.token;
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
// A failed mint returns the stale settings (logged once per agent per minute) so screens that do not
// talk to GHL (billing, numbers, inbox) keep working; ghl() calls still fail on the stale token.
const mintFailureLogged = new Map<string, number>();
export async function freshSettings(base44: any, s: any) {
  if (!s || s.token_kind !== 'oauth' || !s.location_id) return s;
  if (s.ghl_token && Date.parse(s.ghl_token_expires_at || '') - Date.now() > EARLY_MS) return s;
  try {
    const cred = await credentialRecord(base44);
    const minted = await mintLocationToken(base44, cred?.company_id || '', s.location_id);
    return await base44.asServiceRole.entities.AgentSettings.update(s.id, { ghl_token: minted.token, ghl_token_expires_at: minted.expires_at, connected: true });
  } catch (e) {
    const key = String(s.agent_email || s.id);
    const last = mintFailureLogged.get(key) || 0;
    if (Date.now() - last > 60000) {
      mintFailureLogged.set(key, Date.now());
      if (mintFailureLogged.size > 2000) mintFailureLogged.clear();
      console.error(`[ghlAuth] could not mint a location token for ${key}: ${String((e as Error).message || e).slice(0, 300)}`);
    }
    return s;
  }
}

// ---------- OAuth state for the agency install: HMAC-signed with GHL_CLIENT_SECRET ----------
// The callback only accepts a code that was started from our admin page (CSRF / login-fixation guard).
const enc = new TextEncoder();
const b64url = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function hmac(data: string, secret: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}
const stateSecret = () => secrets.get('GHL_CLIENT_SECRET') || '';

/** Signed, expiring `state` for the marketplace install URL. `by` is the admin starting the install. */
export async function signInstallState(by: string, ttlMs = 15 * 60000, secret = stateSecret()): Promise<string> {
  if (!secret) throw new Error('Add the GHL_CLIENT_SECRET secret first.');
  const payload = b64url(enc.encode(JSON.stringify({ u: String(by || '').toLowerCase(), n: crypto.randomUUID().slice(0, 8), x: Date.now() + ttlMs })));
  return `${payload}.${await hmac(payload, secret)}`;
}

/** The admin email the state was minted for, or null when missing, forged or expired. */
export async function verifyInstallState(state: string, secret = stateSecret()): Promise<string | null> {
  if (!secret) return null;
  const [payload, sig, extra] = String(state || '').split('.');
  if (!payload || !sig || extra !== undefined) return null;
  if (!timingSafeEqual(sig, await hmac(payload, secret))) return null;
  try {
    const { u, x } = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof u === 'string' && Number(x) > Date.now() ? u : null;
  } catch { return null; }
}

/** The marketplace install URL with our signed state attached. */
export async function installUrl(config: any, by: string): Promise<string> {
  const base = String(config?.ghl_install_url || '').trim();
  if (!base) throw new Error('Paste the installation URL from your GHL marketplace app first.');
  const url = new URL(base);
  url.searchParams.set('state', await signInstallState(by));
  return url.toString();
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
