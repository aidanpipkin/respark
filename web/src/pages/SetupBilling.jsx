import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { call } from '@/components/workspace/api';
import { Button } from '@/components/ui/button';
import SetupShell from '@/components/setup/SetupShell';
import StripeCardForm from '@/components/setup/StripeCardForm';
import CreditsPanel from '@/components/setup/CreditsPanel';
import SubscriptionCard from '@/components/setup/SubscriptionCard';
import { CheckCircle2 } from 'lucide-react';
import { PanelSkeleton } from '@/components/system/Loaders';

export default function SetupBilling() {
  const qc = useQueryClient();
  const { pathname } = useLocation();
  const standalone = pathname.startsWith('/credits');
  const [replace, setReplace] = useState(false);
  const [addCard, setAddCard] = useState(false);
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['billing-credits'], queryFn: () => call('billingCredits', { action: 'status' }), retry: false });
  async function refresh(next) { if (next) qc.setQueryData(['billing-credits'], next); else await refetch(); await Promise.all([qc.invalidateQueries({ queryKey: ['setup-status'] }), qc.invalidateQueries({ queryKey: ['launch'] })]); }
  // After the first card is saved, bring the subscription step (the next thing to do) into view.
  const showSubscription = () => setTimeout(() => document.getElementById('subscription')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 300);
  const hasCard = data?.card?.status === 'card_saved';

  return (
    <SetupShell standalone={standalone} title="Billing & credits" description="Your plan is a monthly subscription. Texts, calls and extra numbers are paid from prepaid credits, and auto-recharge keeps them going.">
      {isLoading ? <PanelSkeleton rows={3} /> : error ? <p role="alert" className="text-destructive">{error.message}</p> : <>
        {data.exempt && <div className="panel flex gap-3 p-5 text-sm"><CheckCircle2 size={18} className="mt-0.5 text-success" /><div className="flex-1"><p className="font-medium">Billing is off for this account</p><p className="mt-0.5 text-muted-foreground">Texts, calls and numbers are included, so there is nothing to pay and no card needed.</p></div>{!hasCard && !addCard && <Button variant="outline" size="sm" onClick={() => setAddCard(true)}>Add a card anyway</Button>}</div>}
        {data.exempt && !hasCard && !addCard ? null : <>

        {!hasCard && <section className="panel p-4">
          <h2 className="section-title">How billing works</h2>
          <ol className="mt-2 space-y-1.5 text-sm text-muted-foreground">
            <li><span className="font-medium text-foreground">Add a card.</span> It's stored by Stripe, then you start your monthly subscription.</li>
            <li><span className="font-medium text-foreground">Texts use credits.</span> {data.price_cents}¢ per text, taken from your balance as each one goes out.</li>
            <li><span className="font-medium text-foreground">Auto-recharge.</span> Your balance tops itself up so texting never stops.</li>
          </ol>
        </section>}

        {hasCard && <SubscriptionCard billing={data} />}

        {hasCard ? <CreditsPanel data={data} onChange={refresh} /> : data.publishable_key ? <StripeCardForm config={data} onSaved={async () => { await refresh(); if (!data.exempt) showSubscription(); }} /> : <p className="panel p-5 text-sm text-destructive">Card entry is not configured. Contact your administrator.</p>}

        {hasCard && <div className="space-y-3">
          {!replace ? <Button variant="outline" onClick={() => setReplace(true)}>Replace card</Button> : <StripeCardForm config={data} onSaved={async () => { setReplace(false); await refresh(); }} />}
        </div>}
        </>}
      </>}
    </SetupShell>
  );
}
