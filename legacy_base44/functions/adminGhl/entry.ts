// Admin controls for the GHL agency connection and self-serve signups.
import { adminContext } from '../../shared/agentAccess.ts';
import { failure } from '../../shared/ghl.ts';
import { platform } from '../../shared/provisioning.ts';
import { connectionStatus, agencyOAuthToken, redirectUri } from '../../shared/ghlAuth.ts';
import { runProvisioning } from '../../shared/provisionCore.ts';
import { waitUntil } from 'base44:runtime';

function origin(req: Request) {
  const header = req.headers.get('x-base44-app-url');
  if (!header || !/^https:\/\//.test(header)) throw new Error('Publish the app before connecting GHL.');
  return new URL(header).origin;
}

export default async function (req: Request) {
  try {
    const { base44 } = await adminContext(req);
    const input = await req.json();
    let config = await platform(base44);
    if (input.action === 'save') {
      const update: Record<string, any> = {};
      if (input.ghl_client_id !== undefined) { const v = String(input.ghl_client_id).trim(); if (v.length > 200 || /\s/.test(v)) throw new Error('Enter the client ID exactly as shown in GHL.'); update.ghl_client_id = v; }
      if (input.ghl_install_url !== undefined) { const v = String(input.ghl_install_url).trim(); if (v) { const u = new URL(v); if (u.protocol !== 'https:' || !/(gohighlevel|leadconnectorhq)\.com$/.test(u.hostname)) throw new Error('Paste the installation URL from your GHL marketplace app.'); } update.ghl_install_url = v; }
      for (const k of ['self_serve_enabled', 'self_serve_requires_approval']) if (input[k] !== undefined) update[k] = input[k] === true;
      config = await base44.asServiceRole.entities.PlatformSettings.update(config.id, update);
    }
    const o = origin(req);
    const status = await connectionStatus(base44);
    // Signups that stopped at "Connecting securely" pick up again once GHL is connected.
    let resumed = 0;
    if (status.connected) {
      const E = base44.asServiceRole.entities;
      const waiting = (await E.AgentSettings.filter({}, { limit: 200 })).items.filter((a: any) => a.provisioning?.state === 'awaiting_connection');
      for (const a of waiting) {
        const marked = await E.AgentSettings.update(a.id, { provisioning: { ...a.provisioning, state: 'running', error: '', updated_at: new Date().toISOString() } });
        waitUntil(runProvisioning(base44, { ...marked }, config).catch(() => { /* progress records the error */ }));
        resumed++;
      }
    }
    let test: any = null;
    if (input.action === 'test') {
      const token = await agencyOAuthToken(base44);
      if (!token) throw new Error('GHL is not connected yet.');
      const res = await fetch(`https://services.leadconnectorhq.com/locations/search?companyId=${encodeURIComponent(status.company_id)}&limit=5`, { headers: { Authorization: `Bearer ${token}`, Version: '2021-07-28', Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      const body = await res.json().catch(() => ({}));
      test = { ok: res.ok, status: res.status, sub_accounts: (body.locations || []).map((l: any) => l.name).slice(0, 5) };
    }
    return Response.json({
      status, test, resumed,
      settings: { ghl_client_id: config.ghl_client_id || '', ghl_install_url: config.ghl_install_url || '', self_serve_enabled: config.self_serve_enabled !== false, self_serve_requires_approval: config.self_serve_requires_approval === true },
      urls: { redirect_uri: redirectUri(o), webhook_url: new URL('/functions/ghlWebhook', o).toString() },
    });
  } catch (error) { return failure(error as Error); }
}
