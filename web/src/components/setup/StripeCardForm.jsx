import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { call } from '@/components/workspace/api';
import { notify } from '@/lib/feedback';

const money = c => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;

export default function StripeCardForm({ config, onSaved }) {
  const box = useRef(null), stripe = useRef(null), card = useRef(null);
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [consent, setConsent] = useState(false), [auto, setAuto] = useState(true);
  const replacing = config.card?.status === 'card_saved';
  const threshold = config.recharge_threshold_cents || 2500, amount = config.recharge_amount_cents || 10000;

  useEffect(() => {
    let active = true; let element;
    function mount() { if (!active) return; stripe.current = window.Stripe(config.publishable_key); element = stripe.current.elements().create('card', { hidePostalCode: false }); card.current = element; element.mount(box.current); element.on('ready', () => setReady(true)); element.on('change', e => setError(e.error?.message || '')); }
    function failed() { if (active) setError('Secure card entry could not load. Please refresh and try again.'); }
    let script = document.querySelector('script[data-respark-stripe]');
    if (window.Stripe) mount(); else { if (!script) { script = document.createElement('script'); script.src = 'https://js.stripe.com/v3/'; script.dataset.resparkStripe = 'true'; document.head.appendChild(script); } script.addEventListener('load', mount); script.addEventListener('error', failed); }
    return () => { active = false; element?.destroy(); script?.removeEventListener('load', mount); script?.removeEventListener('error', failed); };
  }, [config.publishable_key]);

  async function submit(e) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const intent = await call('createSetupIntent', { consent: true });
      const result = await stripe.current.confirmCardSetup(intent.client_secret, { payment_method: { card: card.current } });
      if (result.error) throw new Error(result.error.message);
      await call('saveBillingCard', { consent: true, auto_recharge: !replacing && auto });
      await onSaved(); setConsent(false);
      notify.ok(replacing ? 'Card replaced' : 'Card saved', replacing ? 'New charges go to this card.' : config.exempt ? 'Nothing was charged.' : 'Nothing was charged. Next: start your subscription.');
    } catch (e) { notify.err(e, replacing ? 'Card not replaced' : 'Card not saved'); } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="panel space-y-5 p-5">
      <div>
        <h2 className="font-semibold">{replacing ? 'Replace your card' : 'Add your card'}</h2>
        <p className="subtext mt-1">Your card goes straight to Stripe. Saving it does not charge anything.</p>
      </div>
      <div ref={box} className="min-h-12 rounded-lg border bg-card p-4" />
      {!replacing && (
        <label className="flex items-start gap-3 rounded-lg border bg-muted/40 p-4 text-sm">
          <input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} className="mt-1" />
          <span><span className="font-medium">Keep my texts going (recommended).</span> When my credits fall below {money(threshold)}, automatically add {money(amount)} using this card. I can change or turn this off anytime on the Credits page.</span>
        </label>
      )}
      <label className="flex items-start gap-3 text-sm">
        <input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} className="mt-1" />
        <span>I authorize LeadRespark to charge this card for text credits I add{!replacing && auto ? ' and for the automatic recharges described above' : ''}. Texts cost {config.price_cents || 3}¢ each. Saving the card does not start your subscription.</span>
      </label>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button className="min-h-11" disabled={!ready || !consent} loading={busy}>{busy ? 'Saving securely…' : replacing ? 'Replace card' : 'Save card'}</Button>
    </form>
  );
}
