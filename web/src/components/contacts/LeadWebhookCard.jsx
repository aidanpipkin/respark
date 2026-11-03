import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { call } from '@/components/workspace/api';
import { Button } from '@/components/ui/button';
import { Copy, Check } from 'lucide-react';
import { notify } from '@/lib/feedback';

const SAMPLE = `{
  "first_name": "Jordan",
  "last_name": "Lee",
  "phone": "+15125550123",
  "email": "jordan@example.com",
  "state": "TX",
  "product": "Term life",
  "notes": "Wants coverage for new baby",
  "consent": true,
  "consent_text": "By checking this box I agree to receive texts from Your Agency at the number provided. Reply STOP to opt out.",
  "consent_date": "2026-10-28T14:03:00Z",
  "consent_url": "https://yoursite.com/get-info",
  "ip": "203.0.113.7"
}`;

export default function LeadWebhookCard() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['lead-webhook'], queryFn: () => call('leadWebhookSettings', {}) });
  const [busy, setBusy] = useState(''), [copied, setCopied] = useState(false), [open, setOpen] = useState(false), [flash, setFlash] = useState('');
  useEffect(() => { if (!flash) return undefined; const t = setTimeout(() => setFlash(''), 1300); return () => clearTimeout(t); }, [flash]);
  async function run(body) {
    setBusy(body.action);
    try {
      const next = await call('leadWebhookSettings', body);
      qc.setQueryData(['lead-webhook'], next);
      const campaignName = next?.campaigns?.find(c => c.id === body.campaign_id)?.name;
      const [title, detail] = {
        enable: ['Lead URL turned on', 'Copy it into your website form, Zapier or lead vendor.'],
        campaign: ['Campaign updated', campaignName ? `New leads go into ${campaignName}.` : ''],
        rotate: ['New URL created', 'The old URL no longer works. Update your form or Zapier with this one.'],
        disable: ['Lead URL turned off', 'New leads sent to it are no longer accepted.'],
      }[body.action] || ['Saved', ''];
      notify.ok(title, detail);
      setFlash(body.action === 'campaign' ? 'campaign' : 'url');
    } catch (e) { notify.err(e); } finally { setBusy(''); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(data.url); setCopied(true); setTimeout(() => setCopied(false), 1500); notify.ok('Copied', 'Paste it into your form, Zapier or lead vendor.'); }
    catch { notify.err('Could not copy. Select the URL and copy it yourself.'); }
  }
  if (isLoading) return null;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  return <section className="panel space-y-4 p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h2 className="section-title">Or send new leads in automatically</h2>
        <p className="mt-1 text-sm text-muted-foreground">Send new leads from your website form, Zapier or a lead vendor straight into LeadRespark. Leads with SMS consent get their first text within minutes.</p></div>
      {!data.enabled && <Button loading={busy === 'enable'} onClick={() => run({ action: 'enable' })}>{busy === 'enable' ? 'Turning on…' : 'Turn on'}</Button>}
    </div>
    {data.enabled && <div className="space-y-3 text-sm">
      <label className="block"><span className="field-label">Your lead URL (keep it private)</span>
        <div className="flex gap-2"><input readOnly className={`field font-mono text-xs ${flash === 'url' ? 'lr-done' : ''}`} value={data.url} onFocus={e => e.target.select()} />
          <Button type="button" variant="outline" className="gap-1" onClick={copy}>{copied ? <Check size={14} className="lr-pop text-success" /> : <Copy size={14} />}{copied ? 'Copied' : 'Copy'}</Button></div></label>
      <label className="block max-w-sm"><span className="field-label">Put new leads in</span><select className={`field ${flash === 'campaign' ? 'lr-done' : ''}`} disabled={busy === 'campaign'} value={data.campaign_id} onChange={e => run({ action: 'campaign', campaign_id: e.target.value })}>{data.campaigns.map(c => <option key={c.id} value={c.id}>{c.name}{c.status !== 'active' ? ` (${c.status})` : ''}</option>)}</select></label>
      <button type="button" className="text-xs text-primary underline" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'} what to send</button>
      {open && <div className="space-y-2 text-xs"><p>POST JSON or form fields. Phone is required. To text a lead, send both <code>consent: true</code> (also accepted: <code>consent_given</code>, <code>sms_consent</code>) and <code>consent_text</code> with the exact wording they agreed to. Wording alone is not enough. Leads missing either are saved but held with the reason "Consent flag missing" and never texted. <code>consent_date</code>, <code>consent_url</code> and <code>ip</code> are kept as proof.</p><pre className="overflow-auto rounded-lg bg-muted p-3">{SAMPLE}</pre></div>}
      {!!data.recent.length && <div><p className="field-label">Latest arrivals</p><ul className="divide-y text-xs">{data.recent.map(l => <li key={l.id} className="flex justify-between gap-3 py-1.5"><span>{l.name || 'New lead'} · {new Date(l.at).toLocaleString()}</span><span className="text-muted-foreground">{l.status}</span></li>)}</ul></div>}
      <div className="flex gap-3"><Button size="sm" variant="ghost" loading={busy === 'rotate'} disabled={!!busy} onClick={() => run({ action: 'rotate' })}>{busy === 'rotate' ? 'Creating…' : 'New URL'}</Button><Button size="sm" variant="ghost" loading={busy === 'disable'} disabled={!!busy} onClick={() => run({ action: 'disable' })}>{busy === 'disable' ? 'Turning off…' : 'Turn off'}</Button></div>
    </div>}
  </section>;
}
