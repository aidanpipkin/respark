// GHL sends the browser here after the agency installs the LeadRespark
// marketplace app. We exchange the one-time code for the agency token, store it
// server-side, and send the admin back to the platform settings page.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { resilient } from '../../shared/entityRetry.ts';
import { exchangeCode, redirectUri } from '../../shared/ghlAuth.ts';

function appOrigin(req: Request) {
  const header = req.headers.get('x-base44-app-url');
  if (header && /^https:\/\//.test(header)) return new URL(header).origin;
  return new URL(req.url).origin;
}
function back(origin: string, params: Record<string, string>) {
  const url = new URL('/admin/platform', origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { Location: url.toString(), 'Cache-Control': 'no-store' } });
}

export default async function (req: Request) {
  const origin = appOrigin(req);
  try {
    if (req.method !== 'GET') return Response.json({ error: 'Method not allowed' }, { status: 405 });
    const params = new URL(req.url).searchParams;
    if (params.get('error')) return back(origin, { ghl: 'error', message: String(params.get('error_description') || params.get('error')).slice(0, 200) });
    const code = params.get('code');
    if (!code || code.length > 2000) return back(origin, { ghl: 'error', message: 'No authorization code was received from GHL.' });
    const base44 = resilient(createClientFromRequest(req));
    const result = await exchangeCode(base44, code, redirectUri(origin));
    return back(origin, { ghl: 'connected', bulk: result.bulk ? '1' : '0' });
  } catch (error) {
    return back(origin, { ghl: 'error', message: String((error as Error).message || 'Connection failed.').slice(0, 200) });
  }
}
