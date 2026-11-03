import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { call } from '@/components/workspace/api';
import { AlertTriangle, CreditCard } from 'lucide-react';
import { notify } from '@/lib/feedback';

const money = c => `$${(Math.abs(c) / 100).toFixed(2)}`;
const PACKS = [2500, 5000, 10000];
const THRESHOLDS = [1000, 2500, 5000, 10000];
const AMOUNTS = [2500, 5000, 10000, 20000];
const KIND = { purchase: 'Credits added', auto_recharge: 'Auto-recharge', text_usage: 'Text sent', call_usage: 'Call', number_fee: 'Phone number', refund: 'Refund', adjustment: 'Adjustment', referral: 'Referral reward' };

export default function CreditsPanel({ data, onChange }) {
  const [pick, setPick] = useState(null), [busy, setBusy] = useState(''), [flash, setFlash] = useState({ balance: 0, auto: 0 });
  const [auto, setAuto] = useState(data.auto_recharge), [threshold, setThreshold] = useState(data.recharge_threshold_cents), [amount, setAmount] = useState(data.recharge_amount_cents), [consent, setConsent] = useState(false);
  const dirty = auto !== data.auto_recharge || threshold !== data.recharge_threshold_cents || amount !== data.recharge_amount_cents;
  const low = data.balance_cents < data.recharge_threshold_cents;

  async function buy() {
    setBusy('buy');
    try {
      const next = await call('billingCredits', { action: 'buy', amount_cents: pick, confirm: true, nonce: crypto.randomUUID() });
      await onChange(next);
      notify.ok('Credits added', `${money(pick)} charged to ${data.card?.brand || 'your card'} •••• ${data.card?.last4 || ''}.${typeof next?.balance_cents === 'number' ? ` New balance ${money(next.balance_cents)}.` : ''}`);
      setPick(null); setFlash(f => ({ ...f, balance: f.balance + 1 }));
    }
    catch (e) { notify.err(e, 'Credits not added'); } finally { setBusy(''); }
  }
  async function save() {
    setBusy('save');
    try {
      const next = await call('billingCredits', { action: 'settings', auto_recharge: auto, recharge_threshold_cents: threshold, recharge_amount_cents: amount, consent });
      setConsent(false); await onChange(next);
      notify.ok('Auto-recharge saved', auto ? `Adds ${money(amount)} whenever credits fall below ${money(threshold)}.` : 'Auto-recharge is off. Texts pause when credits run out.');
      setFlash(f => ({ ...f, auto: f.auto + 1 }));
    }
    catch (e) { notify.err(e, 'Auto-recharge not saved'); } finally { setBusy(''); }
  }

  return (
    <div className="space-y-5">
      {data.last_recharge_error && <div role="alert" className="flex gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm"><AlertTriangle size={18} className="mt-0.5 shrink-0 text-destructive" /><div><p className="font-semibold">Auto-recharge failed</p><p className="subtext mt-1">{data.last_recharge_error} Add credits below or replace your card so texts keep going out.</p></div></div>}

      <section key={`b${flash.balance}`} className={`panel grid gap-5 p-5 sm:grid-cols-[1fr_auto] sm:items-end ${flash.balance ? 'lr-done' : ''}`}>
        <div>
          <p className="text-sm text-muted-foreground">Credit balance</p>
          <p className={`mt-1 text-3xl font-semibold tabular-nums ${data.balance_cents <= 0 ? 'text-destructive' : ''}`}>{money(data.balance_cents)}</p>
          <p className="subtext mt-1">About {data.texts_left.toLocaleString()} texts left at {data.price_cents}¢ each{data.lifetime_texts ? ` · ${data.lifetime_texts.toLocaleString()} sent so far` : ''}</p>
          {data.balance_cents <= 0 && !data.auto_recharge && <p className="mt-2 text-sm font-medium text-destructive">Texts are paused until you add credits.</p>}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground"><CreditCard size={14} />{data.card?.brand} •••• {data.card?.last4}</div>
      </section>

      <section className="panel space-y-4 p-5">
        <h2 className="section-title">Add credits</h2>
        <div className="flex flex-wrap gap-2">{PACKS.map(p => <Button key={p} type="button" variant={pick === p ? 'default' : 'outline'} className="min-h-11" onClick={() => setPick(p)}>{money(p)} <span className="ml-1 text-[11px] opacity-70">≈{Math.floor(p / data.price_cents).toLocaleString()} texts</span></Button>)}</div>
        {pick && <div className="flex flex-wrap items-center gap-3 rounded-lg bg-muted/50 p-4 text-sm lr-rise"><span>Charge <strong>{money(pick)}</strong> to {data.card?.brand} •••• {data.card?.last4} now?</span><Button type="button" loading={busy === 'buy'} disabled={!!busy} onClick={buy}>{busy === 'buy' ? 'Charging…' : `Charge ${money(pick)}`}</Button><Button type="button" variant="ghost" disabled={!!busy} onClick={() => setPick(null)}>Cancel</Button></div>}
      </section>

      <section key={`a${flash.auto}`} className={`panel space-y-4 p-5 ${flash.auto ? 'lr-done' : ''}`}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="section-title">Auto-recharge</h2>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} />{auto ? 'On' : 'Off'}</label>
        </div>
        <p className="subtext">{auto ? 'Your credits refill automatically so campaigns never stop mid-sequence.' : 'Texts pause when your credits run out.'}{low && data.auto_recharge ? ' A refill runs with the next text.' : ''}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label><span className="field-label">When credits fall below</span><select className="field" disabled={!auto} value={threshold} onChange={e => setThreshold(Number(e.target.value))}>{THRESHOLDS.map(t => <option key={t} value={t}>{money(t)}</option>)}</select></label>
          <label><span className="field-label">Add this amount</span><select className="field" disabled={!auto} value={amount} onChange={e => setAmount(Number(e.target.value))}>{AMOUNTS.map(a => <option key={a} value={a}>{money(a)}</option>)}</select></label>
        </div>
        {dirty && auto && <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} className="mt-1" />I authorize LeadRespark to charge {data.card?.brand} •••• {data.card?.last4} {money(amount)} whenever my credits fall below {money(threshold)}, until I turn auto-recharge off.</label>}
        {dirty && <Button type="button" disabled={!!busy || (auto && !consent)} loading={busy === 'save'} onClick={save}>{busy === 'save' ? 'Saving…' : 'Save auto-recharge'}</Button>}
        {data.last_recharge_at && <p className="text-xs text-muted-foreground">Last auto-recharge {new Date(data.last_recharge_at).toLocaleString()}</p>}
      </section>

      <section className="panel p-5">
        <h2 className="section-title">History</h2>
        {!data.transactions.length ? <p className="subtext mt-2">No activity yet.</p> :
          <ul className="mt-3 divide-y text-sm">{data.transactions.map(t => <li key={t.id} className="flex items-center justify-between gap-3 py-2.5"><div className="min-w-0"><p className="truncate">{t.description || KIND[t.kind] || t.kind}</p><p className="text-[11px] text-muted-foreground">{t.created_at ? new Date(t.created_at).toLocaleString() : ''}</p></div><div className="text-right tabular-nums"><p className={t.amount_cents > 0 ? 'text-success' : ''}>{t.amount_cents > 0 ? '+' : '−'}{money(t.amount_cents)}</p><p className="text-[11px] text-muted-foreground">{money(t.balance_after_cents)}</p></div></li>)}</ul>}
      </section>
    </div>
  );
}
