import { useState } from 'react';
import { PanelSkeleton } from '@/components/system/Loaders';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { call } from '@/components/workspace/api';
import { Button } from '@/components/ui/button';
import SetupShell from '@/components/setup/SetupShell';
import A2PForm from '@/components/setup/A2PForm';
import A2PStatus from '@/components/setup/A2PStatus';
import AgentSiteCard from '@/components/setup/AgentSiteCard';
import { CheckCircle2, Loader2, Circle, PartyPopper, Sparkles, ArrowRight } from 'lucide-react';
import { Link, useOutletContext } from 'react-router-dom';
import TryMyAI from '@/components/dashboard/TryMyAI';

function Waiting({ r, onEdit, onTry }) {
  const steps = [
    ['done', 'Your registration details are saved', `${r.legal_business_name}${r.ein_last4 ? ` · EIN ending ${r.ein_last4}` : ''}`],
    ['now', 'One-time carrier setup on our side', 'Our texting provider is finishing a one-time setup for LeadRespark. Nothing for you to do, and nothing you entered is wrong.'],
    ['next', 'You finish in 30 seconds', "We'll text and email you the moment it's ready. You'll re-enter your EIN (we never store it) and press Submit."],
    ['next', 'Carriers approve your texting', 'Usually 1 to 7 business days. We track it and turn texting on automatically.'],
  ];
  return (
    <section className="panel space-y-5 p-5 lr-rise">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">You're done for now</h2>
          <p className="subtext mt-1">Keep setting up the rest of your account (calendar, leads) while this finishes.</p>
        </div>
        <Button size="sm" asChild><Link to="/setup/calendar">Next: Calendar<ArrowRight /></Link></Button>
      </div>
      <ol className="space-y-4">{steps.map(([state, title, detail]) => (
        <li key={title} className="flex gap-3">
          {state === 'done' ? <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-success" /> : state === 'now' ? <Loader2 size={18} className="mt-0.5 shrink-0 animate-spin text-primary" /> : <Circle size={18} className="mt-0.5 shrink-0 text-muted-foreground" />}
          <div><p className={`text-sm ${state === 'next' ? 'text-muted-foreground' : 'font-medium'}`}>{title}</p><p className="mt-0.5 text-xs text-muted-foreground">{detail}</p></div>
        </li>))}
      </ol>
      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-primary/5 p-4">
        <Sparkles size={18} className="shrink-0 text-primary" />
        <p className="min-w-0 flex-1 text-sm">While you wait, text your AI. You play the lead and see exactly how it talks to your prospects.</p>
        <Button type="button" size="sm" onClick={onTry}>Try it</Button>
      </div>
      <Button type="button" variant="ghost" size="sm" onClick={onEdit}>Edit my details</Button>
    </section>
  );
}

export default function SetupTexting() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [trying, setTrying] = useState(false);
  const ctx = useOutletContext();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['setup-status'], queryFn: () => call('getSetupStatus') });
  async function saved() { setEditing(false); await refetch(); await Promise.all([qc.invalidateQueries({ queryKey: ['setup-status'] }), qc.invalidateQueries({ queryKey: ['launch'] })]); }
  const r = data?.registration;
  const inFlight = r && ['queued', 'brand_submitted', 'otp_pending', 'campaign_submitted', 'approved', 'rejected'].includes(r.status);
  const waiting = r?.status === 'draft' && r.provider_step === 'platform_wait';
  const ready = r?.status === 'draft' && r.provider_step === 'platform_ready';
  return (
    <SetupShell title="Texting registration" description="Register your business with the carriers so your texts are delivered. You only do this once.">
      {isLoading ? <PanelSkeleton rows={6} /> : error ? <p className="text-destructive">{error.message}</p> : <>
        {inFlight && r.status !== 'queued' && <A2PStatus registration={r} onChange={saved} />}
        {r?.status === 'queued' && <section className="panel p-5 lr-rise"><p className="font-semibold">Submitted</p><p className="subtext mt-2">Your administrator is submitting your registration to the carriers. You'll see the status here. Nothing else to do on this page.</p><Button size="sm" className="mt-4" asChild><Link to="/setup/calendar">Next: Calendar<ArrowRight /></Link></Button></section>}
        {waiting && !editing && <Waiting r={r} onEdit={() => setEditing(true)} onTry={() => setTrying(true)} />}
        {ready && <section className="panel flex gap-3 border-success/40 bg-success/5 p-5"><PartyPopper size={20} className="mt-0.5 shrink-0 text-success" /><div><p className="font-semibold">Registration is open</p><p className="subtext mt-1">Everything you entered is saved. Re-enter your EIN below and press Submit.</p></div></section>}
        {(!inFlight || r.status === 'rejected') && (!waiting || editing) && <A2PForm data={data} onSaved={saved} />}
        <AgentSiteCard site={data.site} />
        {trying && <TryMyAI open onClose={() => setTrying(false)} settings={ctx?.settings} />}
      </>}
    </SetupShell>
  );
}
