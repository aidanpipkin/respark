// Optional Microsoft 365 (Outlook) calendar connection through Microsoft Graph.
// Replaces the Base44 "outlook" connector the per-agent Respark stack used (legacy_respark resparkBooking.ts).
//
// Enabled by the env secrets MS_CLIENT_ID and MS_CLIENT_SECRET (an Azure app registration with delegated
// Calendars.ReadWrite, User.Read and offline_access; redirect URI = functionUrl('msOAuth'); MS_TENANT
// defaults to "common"). Each agent connects their own mailbox from the app; the refresh token is stored on
// agent_settings.ms_refresh_token (hidden from the UI). When connected:
//   - availability: the agent's Outlook busy times join the ICS-link busy times,
//   - appointmentJourney: a booked call becomes an Outlook event with the lead invited (when they have an email).
// Nothing here runs when the secrets are missing or the agent has not connected, so every caller stays additive.

const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPES = 'offline_access openid email User.Read Calendars.ReadWrite';

export const msConfigured = () => !!(Deno.env.get('MS_CLIENT_ID') && Deno.env.get('MS_CLIENT_SECRET'));
export const msConnected = (s: any) => msConfigured() && !!s?.ms_refresh_token;
const tenant = () => Deno.env.get('MS_TENANT') || 'common';
const authority = () => `https://login.microsoftonline.com/${encodeURIComponent(tenant())}/oauth2/v2.0`;

export function msAuthUrl(redirectUri: string, state: string) {
  const q = new URLSearchParams({ client_id: Deno.env.get('MS_CLIENT_ID') || '', response_type: 'code', redirect_uri: redirectUri, response_mode: 'query', scope: SCOPES, state, prompt: 'select_account' });
  return `${authority()}/authorize?${q}`;
}

type Tokens = { access_token: string; refresh_token?: string; expires_in?: number };
async function tokenRequest(form: Record<string, string>): Promise<Tokens> {
  const body = new URLSearchParams({ client_id: Deno.env.get('MS_CLIENT_ID') || '', client_secret: Deno.env.get('MS_CLIENT_SECRET') || '', scope: SCOPES, ...form });
  const r = await fetch(`${authority()}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(15000) });
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) throw new Error(`Microsoft sign-in failed: ${String(data.error_description || data.error || r.status).slice(0, 200)}`);
  return data;
}

export const msExchangeCode = (code: string, redirectUri: string) => tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });

/** A fresh access token for the agent's mailbox; rotates the stored refresh token when Microsoft issues a new one. */
export async function msAccessToken(E: any, s: any): Promise<string> {
  if (!msConnected(s)) throw new Error('Microsoft 365 is not connected.');
  const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: s.ms_refresh_token });
  if (t.refresh_token && t.refresh_token !== s.ms_refresh_token) { s.ms_refresh_token = t.refresh_token; await E.AgentSettings.update(s.id, { ms_refresh_token: t.refresh_token }).catch(() => {}); }
  return t.access_token;
}

export async function graph(token: string, path: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(path.startsWith('https://') ? path : `${GRAPH}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(20000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`Graph ${r.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/** The signed-in mailbox address, recorded at connect time so the UI can show which account is linked. */
export async function msProfileEmail(token: string) {
  const me = await graph(token, '/me?$select=mail,userPrincipalName');
  return String(me?.mail || me?.userPrincipalName || '').toLowerCase();
}

/** Busy intervals (ms since epoch) from the agent's Outlook calendar between `from` and `to`. */
export async function graphBusy(E: any, s: any, from: number, to: number): Promise<Array<[number, number]>> {
  const token = await msAccessToken(E, s);
  const busy: Array<[number, number]> = [];
  let url: string | null = `/me/calendarView?${new URLSearchParams({ startDateTime: new Date(from).toISOString(), endDateTime: new Date(to).toISOString(), $select: 'start,end,showAs,isAllDay,isCancelled', $top: '200' })}`;
  for (let page = 0; url && page < 5; page++) {
    const data: any = await graph(token, url, { headers: { Prefer: 'outlook.timezone="UTC"' } });
    for (const ev of data?.value || []) {
      if (ev.isCancelled || ev.showAs === 'free') continue;
      const a = Date.parse(`${String(ev.start?.dateTime || '').replace(/\.\d+$/, '')}Z`), b = Date.parse(`${String(ev.end?.dateTime || '').replace(/\.\d+$/, '')}Z`);
      if (Number.isFinite(a) && Number.isFinite(b) && b > a) busy.push([a, b]);
    }
    url = data?.['@odata.nextLink'] || null;
  }
  return busy;
}

export type GraphEvent = { subject: string; html: string; start: string; end: string; location?: string; attendee?: { email: string; name: string } | null };

/** Creates an event on the agent's calendar (the lead is invited when given) and returns its id. */
export async function graphCreateEvent(E: any, s: any, ev: GraphEvent): Promise<string> {
  const token = await msAccessToken(E, s);
  const created = await graph(token, '/me/events', { method: 'POST', body: JSON.stringify({
    subject: ev.subject, body: { contentType: 'HTML', content: ev.html },
    start: { dateTime: ev.start.replace(/\.\d{3}Z$/, '').replace(/Z$/, ''), timeZone: 'UTC' }, end: { dateTime: ev.end.replace(/\.\d{3}Z$/, '').replace(/Z$/, ''), timeZone: 'UTC' },
    ...(ev.location ? { location: { displayName: ev.location } } : {}),
    attendees: ev.attendee ? [{ emailAddress: { address: ev.attendee.email, name: ev.attendee.name }, type: 'required' }] : [],
    isReminderOn: true, reminderMinutesBeforeStart: 15, showAs: 'busy', categories: ['LeadRespark'], responseRequested: !!ev.attendee, allowNewTimeProposals: !!ev.attendee,
  }) });
  return String(created?.id || '');
}

export async function graphDeleteEvent(E: any, s: any, eventId: string) {
  if (!eventId) return;
  const token = await msAccessToken(E, s);
  await graph(token, `/me/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' });
}

// ---------- OAuth state: HMAC-signed, so the callback can trust which agent is connecting ----------
const enc = new TextEncoder();
const b64url = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function hmac(data: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(Deno.env.get('MS_CLIENT_SECRET') || ''), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}
export async function signState(email: string, ttlMs = 15 * 60000) {
  const payload = b64url(enc.encode(JSON.stringify({ e: email.toLowerCase(), x: Date.now() + ttlMs })));
  return `${payload}.${await hmac(payload)}`;
}
export async function verifyState(state: string): Promise<string | null> {
  const [payload, sig] = String(state || '').split('.');
  if (!payload || !sig || sig !== await hmac(payload)) return null;
  try {
    const { e, x } = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof e === 'string' && Number(x) > Date.now() ? e : null;
  } catch { return null; }
}
