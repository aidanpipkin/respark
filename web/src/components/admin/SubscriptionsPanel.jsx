import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { call } from '@/components/workspace/api';
import { Tag } from 'lucide-react';
import { notify } from '@/lib/feedback';

const money = c => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
const BLANK = { code: '', kind: 'percent', value: '', duration: 'once', months: '3', max_redemptions: '', expires_on: '' };

export default function SubscriptionsPanel() {
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['admin-subscriptions'], queryFn: () => call('adminSubscriptions', { action: 'overview' }) });
  const [form, setForm] = useState(BLANK), [busy, setBusy] = useState(''), [flash, setFlash] = useState('');
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  async function run(kind, body, title, detail = '', flashKey = '') {
    setBusy(kind);
    try {
      await call('adminSubscriptions', body); await refetch();
      notify.ok(title, detail);
      if (flashKey) { setFlash(flashKey); setTimeout(() => setFlash(''), 1300); }
      return true;
    } catch (e) { notify.err(e, kind === 'sync' ? 'Refresh failed' : kind === 'create' ? 'Code not created' : 'Code not turned off'); return false; }
    finally { setBusy(''); }
  }
  async function create(e) {
    e.preventDefault();
    const value = form.kind === 'amount' ? Math.round(Number(form.value) * 100) : Number(form.value);
    const ok = await run('create', { action: 'create_code', ...form, value, months: Number(form.months), max_redemptions: form.max_redemptions ? Number(form.max_redemptions) : 0 }, 'Code created', `${form.code.toUpperCase()} is ready to share. It is listed under Codes.`, form.code.toUpperCase());
    if (ok) setForm(BLANK);
  }

  if (isLoading) return <section className="panel p-5 text-sm">Loading subscriptions…</section>;
  if (error) return <section className="panel p-5 text-sm text-destructive">{error.message}</section>;

  return (
    <section className="panel space-y-5 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Subscriptions</h2>
          <p className="subtext mt-1">{money(data.price_cents)}/month · {data.required ? 'required before texting' : 'not required'}</p>
        </div>
        <Button type="button" variant="outline" loading={busy === 'sync'} disabled={!!busy} onClick={() => run('sync', { action: 'sync' }, 'Subscriptions refreshed', 'Counts below are up to date with Stripe.', 'counts')}>{busy === 'sync' ? 'Refreshing' : 'Refresh from Stripe'}</Button>
      </div>
      <dl className={`grid grid-cols-2 gap-3 rounded-lg text-sm sm:grid-cols-5 ${flash === 'counts' ? 'lr-done' : ''}`}>
        {Object.entries(data.counts).map(([k, n]) => <div key={k} className="rounded-lg bg-muted/50 p-3"><dt className="text-xs capitalize text-muted-foreground">{k.replace('_', ' ')}</dt><dd className="text-xl font-semibold tabular-nums">{n}</dd></div>)}
      </dl>
      {data.last_sync && <p className="text-xs text-muted-foreground">Last sync {new Date(data.last_sync.at).toLocaleString()} · {data.last_sync.checked} checked{data.last_sync.failed ? `, ${data.last_sync.failed} failed` : ''}</p>}

      <form onSubmit={create} className="space-y-3 rounded-lg border p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold"><Tag size={14} />New discount code</h3>
        <div className="grid gap-3 sm:grid-cols-3">
          <label><span className="field-label">Code</span><input className="field uppercase" required maxLength={30} value={form.code} onChange={e => set('code', e.target.value.toUpperCase())} placeholder="LAUNCH50" /></label>
          <label><span className="field-label">Discount</span><select className="field" value={form.kind} onChange={e => set('kind', e.target.value)}><option value="percent">Percent off</option><option value="amount">Dollars off</option></select></label>
          <label><span className="field-label">{form.kind === 'percent' ? 'Percent' : 'Dollars'}</span><input className="field" required type="number" min="1" max={form.kind === 'percent' ? 100 : 1000} step={form.kind === 'percent' ? 1 : 0.01} value={form.value} onChange={e => set('value', e.target.value)} /></label>
          <label><span className="field-label">Applies</span><select className="field" value={form.duration} onChange={e => set('duration', e.target.value)}><option value="once">First month only</option><option value="repeating">Several months</option><option value="forever">Every month</option></select></label>
          {form.duration === 'repeating' && <label><span className="field-label">Months</span><input className="field" type="number" min="1" max="36" value={form.months} onChange={e => set('months', e.target.value)} /></label>}
          <label><span className="field-label">Max uses (optional)</span><input className="field" type="number" min="1" value={form.max_redemptions} onChange={e => set('max_redemptions', e.target.value)} /></label>
          <label><span className="field-label">Expires (optional)</span><input className="field" type="date" value={form.expires_on} onChange={e => set('expires_on', e.target.value)} /></label>
        </div>
        <Button type="submit" loading={busy === 'create'} disabled={!!busy}>{busy === 'create' ? 'Creating' : 'Create code'}</Button>
      </form>

      <div>
        <h3 className="mb-2 text-sm font-semibold">Codes</h3>
        {!data.codes.length ? <p className="subtext text-sm">No codes yet.</p> : <ul className="divide-y text-sm">
          {data.codes.map(c => <li key={c.id} className={`flex flex-wrap items-center justify-between gap-2 py-2 ${flash === c.code ? 'lr-done' : ''}`}>
            <div><code className="font-semibold">{c.code}</code> <span className="text-muted-foreground">· {c.description} · used {c.times_redeemed}{c.max_redemptions ? `/${c.max_redemptions}` : ''}{c.expires_at ? ` · expires ${new Date(c.expires_at).toLocaleDateString()}` : ''}</span></div>
            {c.active ? <Button type="button" size="sm" variant="ghost" loading={busy === `off:${c.id}`} disabled={!!busy} onClick={() => run(`off:${c.id}`, { action: 'deactivate_code', id: c.id }, 'Code turned off', `${c.code} can no longer be used at checkout.`, c.code)}>Turn off</Button> : <span className="text-xs text-muted-foreground">Off</span>}
          </li>)}
        </ul>}
      </div>
    </section>
  );
}
