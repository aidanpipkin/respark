import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, ChevronDown, Clock3, Loader2 } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { call, states, timezones } from '@/components/workspace/api';
import ResparkLogo from '@/components/branding/ResparkLogo';
import { openHelp } from '@/components/system/HelpButton';
import { notify } from '@/lib/feedback';

const STEPS = [
  { key: 'you', title: 'About you', time: '1 min' },
  { key: 'business', title: 'Your business', time: '3 min' },
  { key: 'create', title: 'Create workspace', time: '1 min' },
];
const STEP_FIELDS = [['first name', 'last name', 'brand name'], ['legal business name', 'NPN', 'street address', 'city', 'state', 'ZIP code', 'business email', 'business phone', 'timezone', 'licensed states']];
const PRODUCTS = ['IUL', 'Term', 'Whole Life', 'Final Expense', 'Mortgage Protection'];
const AFTER = [
  ['Choose your plan and add a card', 'Nothing is charged until you start your plan.'],
  ['Pick your texting number', 'A local number your leads will see.'],
  ['Register for texting', 'Required by the phone carriers. You submit once; approval usually takes 1 to 7 business days and we track it for you.'],
  ['Set your calendar hours', 'When the AI is allowed to book calls.'],
  ['Import your leads', 'Upload a spreadsheet of past leads. Texting starts once registration is approved.'],
];

const REQUIRED = [['first_name', 'first name', 0], ['last_name', 'last name', 0], ['brand_name', 'brand name', 0], ['legal_business_name', 'legal business name', 1], ['npn', 'NPN', 1], ['address_street', 'street address', 1], ['address_city', 'city', 1], ['address_state', 'state', 1], ['address_zip', 'ZIP code', 1], ['business_email', 'business email', 1], ['business_phone', 'business phone', 1], ['home_timezone', 'timezone', 1]];
function localMissing(form, stepIndex) {
  const m = REQUIRED.filter(([k, , i]) => (stepIndex === undefined || i === stepIndex) && !String(form?.[k] || '').trim()).map(([, label]) => label);
  if ((stepIndex === undefined || stepIndex === 1) && !form?.licensed_states?.length) m.push('licensed states');
  return m;
}

function sampleSetup(kind) {
  const steps = ['Creating your private workspace', 'Connecting securely', 'Setting up your lead pipeline', 'Setting up your calendar', 'Creating your first campaign'].map((label, i) => ({ key: String(i), label, status: 'pending' }));
  return {
    profile: { first_name: kind === 'new' ? '' : 'Riley', last_name: '', brand_name: '', licensed_states: [], products_offered: [] },
    missing: ['first name', 'last name', 'brand name', 'legal business name', 'NPN', 'street address', 'city', 'state', 'ZIP code', 'business phone', 'licensed states'],
    workspace_ready: false, platform_connected: true,
    provisioning: { state: kind === 'pending' ? 'awaiting_approval' : 'not_started', steps },
    approval: kind === 'pending' ? 'pending' : kind === 'approved' ? 'approved' : 'none',
  };
}

function Field({ label, hint, children, className = '' }) {
  return <label className={`block ${className}`}><span className="field-label">{label}</span>{children}{hint && <span className="field-hint block">{hint}</span>}</label>;
}

function Shell({ email, children }) {
  return (
    <div className="min-h-dvh bg-canvas">
      <header className="sticky top-0 z-20 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4 sm:px-6">
          <ResparkLogo className="!h-7 !w-24 object-left" />
          <div className="flex items-center gap-1 text-sm">
            <span className="mr-2 hidden text-muted-foreground sm:inline">{email}</span>
            <Button variant="ghost" size="sm" onClick={() => openHelp()}>Get help</Button>
            <Button variant="ghost" size="sm" onClick={() => base44.auth.logout('/login')}>Sign out</Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 pb-16 pt-8 sm:px-6 lg:pt-12">{children}</main>
    </div>
  );
}

function Notice({ tone = 'info', title, children }) {
  const styles = tone === 'success' ? 'border-success/30 bg-success-soft' : 'bg-card';
  return <div className={`rounded-lg border p-4 text-sm ${styles}`}><p className="font-medium">{title}</p><div className="mt-1 text-muted-foreground">{children}</div></div>;
}

export default function Welcome() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [step, setStep] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [looks, setLooks] = useState(false);
  const started = useRef(false);
  const runningSince = useRef(0);
  const workspace = qc.getQueryData(['workspace']);
  const email = workspace?.user?.email || '';
  // Admin-only QA: /welcome?preview=new|pending|approved shows the first-run screen with sample data. Nothing is saved.
  const preview = workspace?.user?.role === 'admin' ? new URLSearchParams(window.location.search).get('preview') : null;

  const { data, refetch, isLoading, error: loadError } = useQuery({
    queryKey: ['self-setup', preview || ''],
    queryFn: () => preview ? Promise.resolve(sampleSetup(preview)) : call('selfSetup', { action: 'status' }),
    refetchInterval: q => {
      const st = q.state.data?.provisioning?.state;
      if (st === 'running') {
        // Poll every 5 s while the workspace builds; after two minutes back off to 15 s.
        if (!runningSince.current) runningSince.current = Date.now();
        return Date.now() - runningSince.current > 2 * 60 * 1000 ? 15000 : 5000;
      }
      runningSince.current = 0;
      return st === 'awaiting_connection' ? 20000 : st === 'awaiting_approval' ? 60000 : false;
    },
  });

  // First load: fill the form and open the first step that still needs something.
  useEffect(() => {
    if (!data || form) return;
    setForm({ primary_color: '#0F1E3D', accent_color: '#FF6B2C', home_timezone: 'America/Chicago', agent_title: 'Licensed Life Insurance Agent', ...data.profile, products_offered: data.profile.products_offered?.length ? data.profile.products_offered : ['IUL'] });
    const st = data.provisioning.state;
    if (data.workspace_ready || ['running', 'error', 'done', 'awaiting_connection'].includes(st)) setStep(2);
    else if (data.missing.some(m => STEP_FIELDS[0].includes(m))) setStep(0);
    else if (data.missing.length) setStep(1);
    else setStep(2);
  }, [data, form]);

  // Someone who already has a workspace doesn't belong here.
  useEffect(() => { if (!preview && data?.workspace_ready && workspace && !workspace.needs_welcome) navigate('/dashboard', { replace: true }); }, [data, workspace, navigate]);

  // Celebrate the moment the workspace finishes building.
  const lastState = useRef('');
  useEffect(() => {
    const st = data?.workspace_ready ? 'done' : data?.provisioning?.state;
    if (lastState.current && lastState.current !== 'done' && st === 'done') notify.ok('Your workspace is ready', 'Next: choose your plan and add a card.', { label: 'Go to my dashboard', to: '/dashboard' });
    if (st === 'error' && lastState.current !== 'error') notify.err(data?.provisioning?.error || 'Setup paused. Try again.', 'Setup paused');
    lastState.current = st || '';
  }, [data]);

  // Pick up automatically once the platform connection finishes.
  useEffect(() => {
    if (data?.provisioning.state === 'awaiting_connection' && data.platform_connected && !started.current) { started.current = true; build(); }
  }, [data]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const go = i => { setStep(i); setError(''); window.scrollTo({ top: 0, behavior: 'smooth' }); };

  async function save(next) {
    const gaps = localMissing(form, step);
    if (gaps.length) { setError(`Please add your ${gaps.join(', ')}.`); return; }
    if (preview) { go(next); return; }
    setBusy(true); setError('');
    try { await call('selfSetup', { action: 'save_profile', profile: form }); await refetch(); notify.ok(next === 1 ? 'Saved. Now your business details' : 'Saved. Last step: create your workspace'); go(next); }
    catch (e) { setError(e.message); notify.err(e); } finally { setBusy(false); }
  }
  async function build() {
    if (preview) return;
    setBusy(true); setError('');
    try { await call('selfSetup', { action: 'save_profile', profile: form || {} }); await call('selfSetup', { action: 'build' }); await refetch(); }
    catch (e) { setError(e.message); } finally { setBusy(false); started.current = false; }
  }
  async function finish() { await qc.invalidateQueries({ queryKey: ['workspace'] }); navigate('/dashboard'); }

  if (loadError) return <Shell email={email}><div className="panel mx-auto max-w-md p-6 text-center"><h1 className="text-base font-semibold">We couldn't load your setup</h1><p className="mt-1 text-sm text-muted-foreground">{loadError.message}</p><Button className="mt-4" onClick={() => refetch()}>Try again</Button></div></Shell>;
  if (isLoading || !form || step === null) return <Shell email={email}><div className="mx-auto max-w-2xl space-y-3"><div className="h-8 w-64 rounded-md bg-muted lr-shimmer" /><div className="h-64 rounded-xl bg-muted lr-shimmer" /></div></Shell>;

  const p = data.provisioning;
  const missing = preview ? localMissing(form) : data.missing;
  const done = data.workspace_ready || p.state === 'done';
  const pending = data.approval === 'pending';
  const missingHere = i => missing.filter(m => (STEP_FIELDS[i] || []).includes(m));
  const stepDone = i => i < 2 ? missingHere(i).length === 0 && (i < step || done || pending) : done;
  const stepsDone = p.steps.filter(s => s.status === 'done').length;
  const current = p.steps.find(s => s.status === 'running')?.label;
  const first = form.first_name?.trim();

  return (
    <Shell email={email}>
      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{done ? 'You\'re all set' : first ? `Welcome, ${first}` : 'Welcome to LeadRespark'}</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">{done ? 'Your workspace is ready. Your dashboard takes it from here.' : 'Three short steps to create your workspace, about 5 minutes. Your answers save as you go, so you can come back anytime.'}</p>

          {pending && <div className="mt-5"><Notice title="Your account is waiting for approval">We review new accounts before they're created, usually within one business day. Fill in your details now and we'll email {email || 'you'} the moment you're approved. Then you can create your workspace in one click.</Notice></div>}
          {data.approval === 'approved' && !done && <div className="mt-5"><Notice tone="success" title="You're approved">Finish the steps below to create your workspace.</Notice></div>}

          {/* Stepper */}
          <ol className="mt-6 grid grid-cols-3 gap-2">
            {STEPS.map((st, i) => {
              const active = i === step, complete = stepDone(i);
              const locked = busy || p.state === 'running' || (done && i < 2);
              return (
                <li key={st.key}>
                  <button type="button" disabled={locked} onClick={() => go(i)} className={`w-full border-t-2 pt-2.5 text-left transition-colors disabled:cursor-default ${active ? 'border-primary' : complete ? 'border-primary/40' : 'border-border hover:border-muted-foreground/40'}`}>
                    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">{complete ? <Check size={13} className="text-primary" strokeWidth={3} /> : <span className="tabular-nums">Step {i + 1}</span>}<span className="hidden sm:inline">· {st.time}</span></span>
                    <span className={`mt-0.5 block text-sm ${active ? 'font-medium' : 'text-muted-foreground'}`}>{st.title}</span>
                  </button>
                </li>
              );
            })}
          </ol>

          <div className="mt-6">
            {step === 0 && (
              <section className="panel space-y-5 p-5 sm:p-6">
                <div><h2 className="section-title">About you</h2><p className="subtext mt-0.5">How you'll introduce yourself in texts.</p></div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="First name"><input autoFocus={!form.first_name} className="field" value={form.first_name} onChange={e => set('first_name', e.target.value)} /></Field>
                  <Field label="Last name"><input className="field" value={form.last_name} onChange={e => set('last_name', e.target.value)} /></Field>
                  <Field label="Agency or brand name" hint="What leads will know you by, like Pipkin Group."><input className="field" value={form.brand_name} onChange={e => set('brand_name', e.target.value)} /></Field>
                  <Field label="Your title"><input className="field" value={form.agent_title} onChange={e => set('agent_title', e.target.value)} /></Field>
                </div>
                <div className="rounded-lg border">
                  <button type="button" onClick={() => setLooks(v => !v)} aria-expanded={looks} className="flex w-full items-center justify-between px-4 py-3 text-left text-sm">
                    <span><span className="font-medium">Brand colors</span><span className="ml-2 text-muted-foreground">Optional, for your website and booking page</span></span>
                    <ChevronDown size={16} className={`text-muted-foreground transition-transform ${looks ? 'rotate-180' : ''}`} />
                  </button>
                  {looks && <div className="grid gap-4 border-t p-4 sm:grid-cols-2">
                    {[['primary_color', 'Main color'], ['accent_color', 'Accent color']].map(([k, label]) => (
                      <Field key={k} label={label}><span className="flex items-center gap-3"><input type="color" aria-label={label} className="h-10 w-14 cursor-pointer rounded-md border bg-card p-1" value={form[k]} onChange={e => set(k, e.target.value)} /><code className="text-xs text-muted-foreground">{form[k]}</code></span></Field>
                    ))}
                  </div>}
                </div>
                {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                <div className="flex justify-end"><Button disabled={busy || !form.first_name?.trim() || !form.last_name?.trim() || !form.brand_name?.trim()} onClick={() => save(1)}>{busy ? 'Saving…' : 'Continue'}<ArrowRight /></Button></div>
              </section>
            )}

            {step === 1 && (
              <section className="panel space-y-6 p-5 sm:p-6">
                <div><h2 className="section-title">Your business</h2><p className="subtext mt-0.5">The phone carriers check these against your IRS records when you register for texting, so match them exactly.</p></div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Legal business name" hint="As on your EIN letter, like Pipkin Group, LLC."><input className="field" value={form.legal_business_name} onChange={e => set('legal_business_name', e.target.value)} /></Field>
                  <Field label="NPN" hint="Your National Producer Number."><input className="field" inputMode="numeric" value={form.npn} onChange={e => set('npn', e.target.value)} /></Field>
                  <Field label="Street address" className="sm:col-span-2"><input className="field" autoComplete="street-address" value={form.address_street} onChange={e => set('address_street', e.target.value)} /></Field>
                  <Field label="City"><input className="field" autoComplete="address-level2" value={form.address_city} onChange={e => set('address_city', e.target.value)} /></Field>
                  <div className="grid grid-cols-2 gap-4">
                    <Field label="State"><select className="field" value={form.address_state} onChange={e => set('address_state', e.target.value)}><option value="">Choose</option>{states.map(s => <option key={s}>{s}</option>)}</select></Field>
                    <Field label="ZIP"><input className="field" inputMode="numeric" autoComplete="postal-code" value={form.address_zip} onChange={e => set('address_zip', e.target.value)} /></Field>
                  </div>
                  <Field label="Business email"><input className="field" type="email" value={form.business_email} onChange={e => set('business_email', e.target.value)} /></Field>
                  <Field label="Business phone"><input className="field" inputMode="tel" placeholder="(918) 555-0142" value={form.business_phone} onChange={e => set('business_phone', e.target.value)} /></Field>
                  <Field label="Your cell, for alerts" hint="We text you when a lead books or asks for you. Optional."><input className="field" inputMode="tel" value={form.alert_mobile} onChange={e => set('alert_mobile', e.target.value)} /></Field>
                  <Field label="Time zone"><select className="field" value={form.home_timezone} onChange={e => set('home_timezone', e.target.value)}>{timezones.map(t => <option key={t} value={t}>{t.replace('America/', '').replace('Pacific/', '').replace('_', ' ')}</option>)}</select></Field>
                  <Field label="Business website" hint="Optional. If you don't have one, we give you one." className="sm:col-span-2"><input className="field" placeholder="yourcompany.com" value={form.domain} onChange={e => set('domain', e.target.value)} /></Field>
                </div>
                <div>
                  <span className="field-label">States you're licensed in</span>
                  <div className="flex flex-wrap gap-1.5">{states.map(s => { const on = form.licensed_states?.includes(s); return <button key={s} type="button" aria-pressed={on} onClick={() => set('licensed_states', on ? form.licensed_states.filter(v => v !== s) : [...(form.licensed_states || []), s])} className={`h-9 min-w-11 rounded-md border text-[13px] transition-colors ${on ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-muted'}`}>{s}</button>; })}</div>
                  <span className="field-hint block">We only text leads in these states.</span>
                </div>
                <div><span className="field-label">Products you offer</span><div className="flex flex-wrap gap-x-5 gap-y-1">{PRODUCTS.map(pr => <label key={pr} className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={form.products_offered?.includes(pr) || false} onChange={e => set('products_offered', e.target.checked ? [...(form.products_offered || []), pr] : form.products_offered.filter(v => v !== pr))} />{pr}</label>)}</div></div>
                <p className="text-sm text-muted-foreground">We never ask for or store your EIN here. You'll type it once when you register for texting.</p>
                {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                <div className="flex justify-between"><Button variant="outline" disabled={busy} onClick={() => go(0)}>Back</Button><Button disabled={busy} onClick={() => save(2)}>{busy ? 'Saving…' : 'Continue'}<ArrowRight /></Button></div>
              </section>
            )}

            {step === 2 && (
              <section className="panel space-y-5 p-5 sm:p-6">
                {done ? (
                  <div className="space-y-4">
                    <span className="flex h-11 w-11 items-center justify-center rounded-full bg-success-soft text-success"><Check size={22} /></span>
                    <div><h2 className="text-lg font-semibold">Your workspace is ready</h2><p className="subtext mt-1">Next up: choose your plan and add a card. Your dashboard has a checklist that walks you through every step to going live.</p></div>
                    <Button size="lg" onClick={finish}>Go to my dashboard<ArrowRight /></Button>
                  </div>
                ) : missing.length > 0 ? (
                  <div className="space-y-4">
                    <div><h2 className="section-title">A few details are missing</h2><p className="subtext mt-0.5">Add these and you can create your workspace:</p></div>
                    <p className="text-sm">{missing.join(', ')}</p>
                    <Button onClick={() => go(missing.some(m => STEP_FIELDS[0].includes(m)) ? 0 : 1)}>Add them<ArrowRight /></Button>
                  </div>
                ) : pending ? (
                  <div className="space-y-4">
                    <span className="flex h-11 w-11 items-center justify-center rounded-full bg-muted text-muted-foreground"><Clock3 size={20} /></span>
                    <div><h2 className="section-title">You're all filled in</h2><p className="subtext mt-1">As soon as your account is approved we'll email you, and this button will create your workspace. Nothing else to do for now; you can close this page.</p></div>
                    <div className="flex flex-wrap gap-2"><Button disabled>Create my workspace</Button><Button variant="outline" onClick={() => go(1)}>Review my details</Button></div>
                  </div>
                ) : p.state === 'running' || p.state === 'awaiting_connection' ? (
                  <div className="space-y-4">
                    <div><h2 className="section-title">Creating your workspace</h2><p className="subtext mt-0.5">{p.state === 'awaiting_connection' ? 'Finishing a one-time connection. This continues on its own; you can close this page.' : 'About a minute. Keep this page open or come back later.'}</p></div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-[width] duration-700" style={{ width: `${Math.max(8, (stepsDone / p.steps.length) * 100)}%` }} /></div>
                    <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 size={14} className="animate-spin" />{current || 'Getting started'}…</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div><h2 className="section-title">{p.state === 'error' ? 'Setup paused' : 'Create your workspace'}</h2>
                      <p className="subtext mt-1">{p.state === 'error' ? `${p.error} Everything finished so far is saved, so trying again picks up where it stopped.` : 'This sets up your private lead list, inbox, calendar and your first texting campaign. It takes about a minute.'}</p></div>
                    <div className="flex flex-wrap gap-2">
                      <Button size="lg" loading={busy} onClick={build}>{p.state === 'error' ? 'Try again' : 'Create my workspace'}</Button>
                      <Button size="lg" variant="outline" disabled={busy} onClick={() => go(1)}>Back</Button>
                    </div>
                  </div>
                )}
                {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
              </section>
            )}
          </div>
        </div>

        <aside className="lg:pt-1">
          <h2 className="text-sm font-medium">After your workspace is created</h2>
          <p className="mt-1 text-sm text-muted-foreground">Your dashboard walks you through these, in order:</p>
          <ol className="mt-4 space-y-4">
            {AFTER.map(([t, d], i) => (
              <li key={t} className="flex gap-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                <span><span className="block text-sm">{t}</span><span className="block text-[13px] text-muted-foreground">{d}</span></span>
              </li>
            ))}
          </ol>
        </aside>
      </div>
    </Shell>
  );
}
