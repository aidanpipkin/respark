import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { call } from '@/components/workspace/api';
import { BadgeCheck, AlertTriangle, Tag } from 'lucide-react';
import { notify } from '@/lib/feedback';

const money = c => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;
const date = iso => iso ? new Date(iso).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) : '';
const STATUS = { active: 'Active', trialing: 'Trial', past_due: 'Payment past due', incomplete: 'Waiting on payment', incomplete_expired: 'Payment expired', unpaid: 'Unpaid', canceled: 'Canceled', none: 'Not started' };

function loadStripe(key) {
  return new Promise((resolve, reject) => {
    if (window.Stripe) return resolve(window.Stripe(key));
    let s = document.querySelector('script[data-respark-stripe]');
    if (!s) { s = document.createElement('script'); s.src = 'https://js.stripe.com/v3/'; s.dataset.resparkStripe = 'true'; document.head.appendChild(s); }
    s.addEventListener('load', () => resolve(window.Stripe(key)));
    s.addEventListener('error', () => reject(new Error('Secure payment could not load. Refresh and try again.')));
  });
}

export default function SubscriptionCard({ billing }) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['subscription'], queryFn: () => call('subscription', { action: 'view' }), retry: false });
  const [code, setCode] = useState(''), [preview, setPreview] = useState(null), [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(''), [flash, setFlash] = useState(0);
  const ERR = { code: 'Code not applied', subscribe: 'Subscription not started', cancel: 'Could not cancel', resume: 'Could not resume' };

  async function done(next, title, detail) {
    qc.setQueryData(['subscription'], next); setConsent(false);
    await Promise.all([qc.invalidateQueries({ queryKey: ['setup-status'] }), qc.invalidateQueries({ queryKey: ['launch'] })]);
    if (title) { notify.ok(title, detail || ''); setFlash(f => f + 1); }
  }
  async function run(kind, fn) { setBusy(kind); try { await fn(); } catch (e) { notify.err(e, ERR[kind] || ''); } finally { setBusy(''); } }

  const apply = () => run('code', async () => {
    const r = await call('subscription', { action: 'preview', code });
    if (!r.valid) { setPreview(null); throw new Error(r.message); }
    setPreview(r);
    notify.ok('Code applied', `${r.code}: first month ${money(r.first_month_cents)}.`);
  });
  const start = () => run('subscribe', async () => {
    let next = await call('subscription', { action: 'subscribe', confirm: true, code: preview?.code || '', nonce: crypto.randomUUID() });
    if (next.client_secret) {
      const stripe = await loadStripe(billing.publishable_key);
      const r = await stripe.confirmCardPayment(next.client_secret);
      if (r.error) throw new Error(r.error.message);
      next = await call('subscription', { action: 'refresh' });
    }
    if (next.ok) await done(next, 'Subscription started', next.period_end ? `Active. Renews on ${date(next.period_end)}.` : 'Your subscription is active.');
    else { await done(next); notify.info('Subscription not active yet', 'Check the status above. If the payment needs attention, replace your card and try again.'); }
  });
  const cancel = () => run('cancel', async () => { const next = await call('subscription', { action: 'cancel', confirm: true }); await done(next, 'Subscription cancelled', next?.period_end ? `You keep access until ${date(next.period_end)}.` : 'It ends at the close of this billing period.'); });
  const resume = () => run('resume', async () => done(await call('subscription', { action: 'resume' }), 'Subscription resumed', 'It will keep renewing each month.'));

  if (isLoading) return <section className="panel p-5 text-sm">Loading subscription…</section>;
  if (error) return <section className="panel p-5 text-sm text-destructive" role="alert">{error.message}</section>;
  if (!data.required && data.status === 'none') return <section className="panel flex gap-3 p-5 text-sm"><BadgeCheck size={18} className="mt-0.5 text-success" /><p>Your account does not need a LeadRespark subscription.</p></section>;

  const hasCard = billing?.card?.status === 'card_saved';
  const live = ['active', 'trialing', 'past_due'].includes(data.status);
  const firstCharge = preview ? preview.first_month_cents : data.price_cents;
  const terms = !preview || firstCharge === data.price_cents ? `${money(data.price_cents)} every month`
    : preview.duration === 'forever' ? `${money(firstCharge)} every month`
    : preview.duration === 'repeating' ? `${money(firstCharge)} monthly for ${preview.months} months in total, then ${money(data.price_cents)} every month`
    : `${money(data.price_cents)} every month after that`;

  return (
    <section id="subscription" key={flash} className={`panel scroll-mt-20 space-y-4 p-5 ${flash ? 'lr-done' : ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="field-label">LeadRespark subscription</p>
          <p className="mt-1 text-3xl font-semibold tabular-nums">{money(data.price_cents)}<span className="text-base font-normal text-muted-foreground">/month</span></p>
          <p className="subtext mt-1">Your workspace, AI texting, booking page and compliant website. Text credits are billed separately.</p>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-medium ${live && data.status !== 'past_due' ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'}`}>{STATUS[data.status] || data.status}</span>
      </div>

      {live && <div className="space-y-2 text-sm">
        {data.discount && <p className="flex items-center gap-2"><Tag size={14} />{data.discount} · now {money(data.amount_cents)}/mo</p>}
        <p className="subtext">{data.cancel_at_period_end ? `Ends on ${date(data.period_end)}. Texting stops after that.` : `Renews on ${date(data.period_end)}.`}</p>
        {data.status === 'past_due' && <p role="alert" className="flex gap-2 text-destructive"><AlertTriangle size={16} className="mt-0.5 shrink-0" />Your last payment failed. Replace your card below. Stripe will retry automatically.</p>}
        {data.cancel_at_period_end
          ? <Button type="button" disabled={!!busy} loading={busy === 'resume'} onClick={resume}>{busy === 'resume' ? 'Saving…' : 'Keep my subscription'}</Button>
          : <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">Cancel subscription</summary>
              <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-muted/50 p-4"><span>You keep access until {date(data.period_end)}. After that, texts stop going out.</span><Button type="button" variant="outline" disabled={!!busy} loading={busy === 'cancel'} onClick={cancel}>{busy === 'cancel' ? 'Canceling…' : 'Cancel at period end'}</Button></div>
            </details>}
      </div>}

      {!live && <div className="space-y-4">
        {!hasCard ? <p className="text-sm font-medium">Add your card below first, then start your subscription.</p> : <>
          <p className="rounded-md bg-primary/5 px-3 py-2 text-sm"><span className="font-medium">Next step:</span> start your subscription to turn on AI texting.</p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-0 flex-1"><span className="field-label">Discount code (optional)</span><input className="field uppercase" value={code} maxLength={40} onChange={e => { setCode(e.target.value.toUpperCase()); setPreview(null); }} placeholder="Enter code" /></label>
            <Button type="button" variant="outline" className="min-h-11" disabled={!code.trim() || !!busy} loading={busy === 'code'} onClick={apply}>{busy === 'code' ? 'Checking…' : 'Apply'}</Button>
          </div>
          {preview && <p className="flex items-center gap-2 text-sm text-success lr-rise"><Tag size={14} />{preview.code}: {preview.description}. First month {money(preview.first_month_cents)}.</p>}
          <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} className="mt-1" />
            <span>I authorize LeadRespark to charge {billing.card.brand} •••• {billing.card.last4} {money(firstCharge)} today and {terms} until I cancel. I can cancel anytime on this page.</span></label>
          <Button type="button" className="min-h-11" disabled={!consent || !!busy} loading={busy === 'subscribe'} onClick={start}>{busy === 'subscribe' ? 'Starting…' : `Subscribe · ${money(firstCharge)} today`}</Button>
        </>}
      </div>}

    </section>
  );
}
