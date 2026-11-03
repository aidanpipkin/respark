// Microsoft 365 (Outlook) calendar connection for one agent.
//   POST (signed-in agent)  { action: 'status' }      → { configured, connected, email, connected_at, redirect_uri }
//                           { action: 'start' }       → { url }  open it; Microsoft sends the browser back here
//                           { action: 'disconnect' }  → { connected: false }
//   GET  ?code=&state=      Microsoft's redirect (no sign-in header): stores the refresh token and sends the
//                           browser to ${APP_URL}/availability?ms=connected|error
// Register functionUrl('msOAuth') as the app registration's redirect URI. Deploy with --no-verify-jwt (the
// callback carries no user token; the state parameter is HMAC-signed with MS_CLIENT_SECRET instead).
import { createClientFromRequest, functionUrl } from '../_shared/runtime.ts';
import { setupContext } from '../_shared/setupAccess.ts';
import { failure } from '../_shared/ghl.ts';
import { msConfigured, msConnected, msAuthUrl, msExchangeCode, msProfileEmail, signState, verifyState } from '../_shared/msGraph.ts';

function appOrigin(req: Request) {
  const header = req.headers.get('x-base44-app-url') || Deno.env.get('APP_URL') || '';
  return /^https?:\/\//.test(header) ? new URL(header).origin : new URL(req.url).origin;
}
const back = (origin: string, params: Record<string, string>) => { const u = new URL('/availability', origin); for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v); return Response.redirect(u.toString(), 302); };

export default async function (req: Request) {
  const redirectUri = functionUrl('msOAuth');
  if (req.method === 'GET') {
    const origin = appOrigin(req);
    const q = new URL(req.url).searchParams;
    try {
      if (!msConfigured()) throw new Error('Microsoft 365 is not configured on this platform.');
      if (q.get('error')) throw new Error(String(q.get('error_description') || q.get('error')).slice(0, 200));
      const email = await verifyState(q.get('state') || '');
      if (!email) throw new Error('The sign-in link expired. Start again from Availability.');
      const code = q.get('code') || '';
      if (!code || code.length > 4000) throw new Error('No authorization code was received from Microsoft.');
      const tokens = await msExchangeCode(code, redirectUri);
      if (!tokens.refresh_token) throw new Error('Microsoft did not return a refresh token; make sure offline_access is granted.');
      const E: any = createClientFromRequest(req).asServiceRole.entities;
      const s = (await E.AgentSettings.filter({ agent_email: email }, { limit: 1 })).items[0];
      if (!s) throw new Error('Agent profile not found.');
      const mailbox = await msProfileEmail(tokens.access_token).catch(() => '');
      await E.AgentSettings.update(s.id, { ms_refresh_token: tokens.refresh_token, ms_connected_email: mailbox, ms_connected_at: new Date().toISOString(), busy_cache: {} });
      return back(origin, { ms: 'connected', email: mailbox });
    } catch (e) { return back(origin, { ms: 'error', message: String((e as Error).message).slice(0, 200) }); }
  }
  try {
    const { user, s, E } = await setupContext(req);
    const input = await req.json().catch(() => ({}));
    const status = () => ({ configured: msConfigured(), connected: msConnected(s), email: s.ms_connected_email || '', connected_at: s.ms_connected_at || '', redirect_uri: redirectUri });
    if (input.action === 'start') {
      if (!msConfigured()) throw new Error('Microsoft 365 is not configured on this platform yet.');
      return Response.json({ url: msAuthUrl(redirectUri, await signState(user.email)) });
    }
    if (input.action === 'disconnect') {
      await E.AgentSettings.update(s.id, { ms_refresh_token: '', ms_connected_email: '', ms_connected_at: '', busy_cache: {} });
      Object.assign(s, { ms_refresh_token: '', ms_connected_email: '', ms_connected_at: '' });
      return Response.json(status());
    }
    return Response.json(status(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return failure(error as Error); }
}
