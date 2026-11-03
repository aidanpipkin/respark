import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plug, CheckCircle2, AlertTriangle, Copy, ExternalLink, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { call } from '@/components/workspace/api';
import { notify } from '@/lib/feedback';

// The OAuth redirect lands here with ?ghl=connected|error. Announce it once per page load.
let announced = false;

const SCOPES = ['locations.readonly', 'locations.write', 'locations/customValues.readonly', 'locations/customValues.write', 'locations/customFields.readonly', 'locations/customFields.write', 'locations/tags.readonly', 'locations/tags.write', 'contacts.readonly', 'contacts.write', 'conversations.readonly', 'conversations.write', 'conversations/message.readonly', 'conversations/message.write', 'calendars.readonly', 'calendars.write', 'calendars/events.readonly', 'calendars/events.write', 'opportunities.readonly', 'opportunities.write', 'users.readonly', 'users.write', 'oauth.readonly', 'oauth.write', 'phonenumbers.read', 'companies.readonly', 'workflows.readonly', 'snapshots.readonly', 'saas/location.read', 'saas/location.write'];

function CopyRow({ label, value }) {
  const [copied, setCopied] = useState(false);
  return <div><span className="field-label">{label}</span><div className="flex gap-2"><code className="field flex min-h-11 flex-1 items-center overflow-x-auto whitespace-nowrap text-[11px]">{value}</code><Button type="button" variant="outline" className="h-11 gap-1.5 text-xs" onClick={async () => { try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); notify.ok(`${label} copied`, 'Paste it into your GHL app settings.'); } catch { notify.err('Clipboard access unavailable. Select the text and copy it.', "Couldn't copy"); } }}>{copied ? <CheckCircle2 size={13} className="lr-pop text-success" /> : <Copy size={13} />}{copied ? 'Copied' : 'Copy'}</Button></div></div>;
}

export default function GhlConnectionPanel() {
  const params = new URLSearchParams(window.location.search);
  const [edits, setEdits] = useState({});
  const [busy, setBusy] = useState('');
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (announced) return;
    announced = true;
    if (params.get('ghl') === 'connected') notify.ok('GHL connected', 'New agents can now build their workspaces automatically.');
    else if (params.get('ghl') === 'error') notify.err(params.get('message') || 'Unknown error', 'GHL connection failed');
  }, []);
  const { data, error, isLoading, refetch } = useQuery({ queryKey: ['admin-ghl'], queryFn: () => call('adminGhl', { action: 'status' }) });
  const form = { ...data?.settings, ...edits };
  async function run(action) {
    setBusy(action);
    try {
      const r = await call('adminGhl', { action, ...form }); await refetch(); setEdits({});
      if (action === 'test') {
        if (r.test?.ok) notify.ok('Connection works', `Sub-accounts visible: ${r.test.sub_accounts.join(', ') || 'none yet'}.`);
        else notify.err(`GHL answered with status ${r.test?.status}. Reconnect GHL and test again.`, 'Connection test failed');
      } else {
        notify.ok('GHL settings saved', st.connected ? 'Signup rules apply to the next agent who signs up.' : 'Next: click Connect GHL and approve for your agency.');
        setFlash(true); setTimeout(() => setFlash(false), 1300);
      }
    } catch (e) { notify.err(e, action === 'test' ? 'Connection test failed' : 'GHL settings not saved'); }
    finally { setBusy(''); }
  }
  if (isLoading) return <section className="panel p-5 text-sm"><Loader2 size={15} className="mr-2 inline animate-spin" />Loading GHL connection…</section>;
  if (error) return <section className="panel p-5 text-sm text-destructive">{error.message}</section>;
  const st = data.status;
  return <section className={`panel space-y-5 p-5 sm:p-6 ${flash ? 'lr-done' : ''}`}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="flex items-center gap-2 font-semibold"><Plug size={17} />GHL connection</h2><p className="subtext mt-1 text-xs">Connect once. Every agent who signs up then gets their own GHL sub-account built automatically.</p></div>
      <span className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] ${st.connected ? 'bg-success-soft text-success' : 'bg-muted text-muted-foreground'}`}>{st.connected ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}{st.connected ? `Connected · agency ${st.company_id}` : 'Not connected'}</span>
    </div>
    {st.last_error && <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs">{st.last_error}</p>}

    <details open={!st.connected} className="rounded-lg border p-4">
      <summary className="cursor-pointer text-sm font-semibold">One-time setup in GHL (about 10 minutes)</summary>
      <ol className="mt-4 list-decimal space-y-3 pl-5 text-xs leading-6">
        <li>Go to <a className="text-primary underline" href="https://marketplace.gohighlevel.com" target="_blank" rel="noreferrer">marketplace.gohighlevel.com</a>, sign in with your agency login, then <b>My Apps → Create App</b>. Name it LeadRespark, type <b>Private</b>, distribution <b>Agency and Sub-account</b>, and turn on installing to <b>all sub-accounts</b> if offered.</li>
        <li>In <b>Auth</b>, add every scope listed below, then add the redirect URL below.</li>
        <li>Under <b>Client Keys</b>, create a key. Paste the <b>Client ID</b> here. Put the <b>Client secret</b> in the app's Base44 secrets as <code>GHL_CLIENT_SECRET</code> (never here).</li>
        <li>In <b>Advanced Settings → Webhooks</b>, paste the webhook URL below and turn on InboundMessage, OutboundMessage, AppointmentCreate, AppointmentUpdate and AppointmentDelete.</li>
        <li>Copy the app's <b>Installation URL</b> from the Auth page, paste it below, save, then click <b>Connect GHL</b> and approve for your agency.</li>
      </ol>
      <div className="mt-4 space-y-3">
        <CopyRow label="Redirect URL" value={data.urls.redirect_uri} />
        <CopyRow label="Webhook URL" value={data.urls.webhook_url} />
        <CopyRow label="Scopes" value={SCOPES.join(' ')} />
      </div>
    </details>

    <div className="grid gap-4 sm:grid-cols-2">
      <label><span className="field-label">Marketplace app Client ID</span><input className="field" value={form.ghl_client_id || ''} onChange={e => setEdits({ ...edits, ghl_client_id: e.target.value })} /></label>
      <label><span className="field-label">Installation URL</span><input className="field" value={form.ghl_install_url || ''} onChange={e => setEdits({ ...edits, ghl_install_url: e.target.value })} /></label>
    </div>
    <p className="text-[11px] text-muted-foreground">Client secret: <span className={st.client_secret_set ? 'text-success' : 'text-destructive'}>{st.client_secret_set ? 'set' : 'not set (add GHL_CLIENT_SECRET in Secrets)'}</span> · Agency private token fallback: {st.agency_pit_set ? 'set' : 'not set'}</p>

    <div className="rounded-lg border p-4">
      <p className="mb-3 text-sm font-semibold">Signups</p>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!!form.self_serve_enabled} onChange={e => setEdits({ ...edits, self_serve_enabled: e.target.checked })} />Anyone who signs up can build their own workspace</label>
      <label className="mt-2 flex items-center gap-2 text-xs"><input type="checkbox" checked={!!form.self_serve_requires_approval} onChange={e => setEdits({ ...edits, self_serve_requires_approval: e.target.checked })} />Require my approval before a new workspace is built</label>
    </div>

    <div className="flex flex-wrap gap-2">
      <Button type="button" loading={busy === 'save'} disabled={!!busy} onClick={() => run('save')}>{busy === 'save' ? 'Saving' : 'Save'}</Button>
      <Button type="button" variant="outline" disabled={!!busy || !data.settings.ghl_install_url || !st.client_secret_set} className="gap-1.5" onClick={() => { window.location.href = data.settings.ghl_install_url; }}><ExternalLink size={14} />{st.connected ? 'Reconnect GHL' : 'Connect GHL'}</Button>
      <Button type="button" variant="outline" loading={busy === 'test'} disabled={!!busy || !st.connected} onClick={() => run('test')}>{busy === 'test' ? 'Testing' : 'Test connection'}</Button>
    </div>
  </section>;
}
