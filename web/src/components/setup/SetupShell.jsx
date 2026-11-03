import { useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { notify, lastOkAt } from '@/lib/feedback';
import { useQuery } from '@tanstack/react-query';
import { Check, ArrowRight, ArrowLeft, Clock3 } from 'lucide-react';
import { call } from '@/components/workspace/api';
import PageHeader from '@/components/workspace/PageHeader';
import { Button } from '@/components/ui/button';

// Guided setup: one clear path through every step, with live progress and a "Next" button,
// so an agent never wonders what to do after finishing a page.
export const SETUP_STEPS = [
  { key: 'billing', label: 'Plan & billing', to: '/setup/billing' },
  { key: 'number', label: 'Texting number', to: '/setup/number' },
  { key: 'registration', label: 'Texting registration', to: '/setup/texting-registration' },
  { key: 'calendar', label: 'Calendar', to: '/setup/calendar' },
  { key: 'leads', label: 'Import leads', to: '/contacts/import' },
];

export function useSetupProgress({ enabled = true } = {}) {
  const launch = useQuery({ queryKey: ['launch'], queryFn: () => call('launch', {}), staleTime: 15000, enabled, refetchInterval: enabled ? 20000 : false });
  const setup = useQuery({ queryKey: ['setup-status'], queryFn: () => call('getSetupStatus'), staleTime: 15000, enabled, refetchInterval: enabled ? 20000 : false });
  const item = k => launch.data?.items?.find(i => i.key === k);
  const reg = setup.data?.registration;
  const state = {
    billing: item('billing')?.done && item('subscription')?.done !== false ? 'done' : 'todo',
    number: item('number')?.done || setup.data?.phone_number ? 'done' : 'todo',
    registration: item('registration')?.done ? 'done' : reg && (['brand_submitted', 'otp_pending', 'campaign_submitted', 'queued'].includes(reg.status) || reg.provider_step === 'platform_wait') ? 'waiting' : 'todo',
    calendar: setup.data?.checklist?.calendar ? 'done' : 'todo',
    leads: item('leads')?.done ? 'done' : 'todo',
  };
  const doneCount = SETUP_STEPS.filter(s => state[s.key] === 'done').length;
  return { state, doneCount, ready: !!(launch.data && setup.data) };
}

export default function SetupShell({ title, description, children, standalone = false }) {
  const { pathname } = useLocation();
  const { state, doneCount, ready } = useSetupProgress({ enabled: !standalone });
  const index = Math.max(0, SETUP_STEPS.findIndex(s => pathname.startsWith(s.to)));
  const after = SETUP_STEPS.slice(index + 1);
  const next = after.find(s => state[s.key] === 'todo') || after[0];
  const prev = SETUP_STEPS[index - 1];

  const current = SETUP_STEPS[index];
  const currentState = state[current.key];
  // The moment this page's step is finished, say so and point at the next one.
  const was = useRef(null);
  useEffect(() => {
    if (!ready || standalone) return;
    const recent = Date.now() - lastOkAt < 15000; // a page-specific toast already said it
    if (!recent && was.current && was.current !== 'done' && currentState === 'done') notify.ok(`${current.label} done`, next ? `Next up: ${next.label}.` : 'Setup is complete.', next ? { label: `Next: ${next.label}`, to: next.to } : { label: 'Go to Home', to: '/dashboard' });
    if (!recent && was.current && was.current === 'todo' && currentState === 'waiting') notify.ok('Submitted', 'Nothing else to do here while the carriers review it.', next ? { label: `Next: ${next.label}`, to: next.to } : null);
    was.current = currentState;
  }, [ready, currentState]);

  if (standalone) {
    return <div className="mx-auto max-w-3xl"><PageHeader title={title} description={description} /><div className="space-y-6">{children}</div></div>;
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader back={{ to: '/dashboard', label: 'Home' }} title={title} description={description}>
        <nav aria-label="Setup steps" className="no-scrollbar -mx-4 mt-5 flex overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <ol className="flex min-w-full gap-1 border-b">
            {SETUP_STEPS.map((s, i) => {
              const st = state[s.key], active = i === index;
              return (
                <li key={s.key} className="shrink-0">
                  <Link to={s.to} aria-current={active ? 'step' : undefined} className={`-mb-px flex h-10 items-center gap-2 border-b-2 px-2.5 text-sm transition-colors ${active ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}>
                    <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold ${st === 'done' ? 'bg-primary text-primary-foreground' : active ? 'border border-primary text-primary' : 'border text-muted-foreground'}`}>
                      {st === 'done' ? <Check size={11} strokeWidth={3} /> : st === 'waiting' ? <Clock3 size={11} /> : i + 1}
                    </span>
                    {s.label}
                  </Link>
                </li>
              );
            })}
          </ol>
        </nav>
        {ready && <p className="mt-2 text-xs text-muted-foreground">{doneCount} of {SETUP_STEPS.length} steps done</p>}
      </PageHeader>

      {ready && currentState !== 'todo' && (
        <div className={`mb-6 flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 text-sm ${currentState === 'done' ? 'border-success/30 bg-success-soft' : 'bg-card'}`}>
          <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${currentState === 'done' ? 'bg-success text-white' : 'bg-muted text-muted-foreground'}`}>{currentState === 'done' ? <Check size={13} strokeWidth={3} /> : <Clock3 size={13} />}</span>
          <span className="min-w-0 flex-1"><span className="font-medium">{currentState === 'done' ? 'This step is done.' : 'Submitted. Waiting on the carriers.'}</span> <span className="text-muted-foreground">{next ? `Next: ${next.label}.` : 'You can head back to Home.'}</span></span>
          <Button size="sm" asChild><Link to={next ? next.to : '/dashboard'}>{next ? `Go to ${next.label}` : 'Go to Home'}<ArrowRight /></Link></Button>
        </div>
      )}

      <div className="space-y-6">{children}</div>

      <div className="mt-8 flex items-center justify-between gap-3 border-t pt-5">
        {prev ? <Link to={prev.to} className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft size={15} />{prev.label}</Link> : <span />}
        {next
          ? <Button asChild><Link to={next.to}>Next: {next.label}<ArrowRight /></Link></Button>
          : <Button asChild><Link to="/dashboard">Done<ArrowRight /></Link></Button>}
      </div>
    </div>
  );
}
