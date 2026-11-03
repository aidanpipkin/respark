import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { call } from '@/components/workspace/api';
import { Button } from '@/components/ui/button';
import AdminTabs from '@/components/admin/AdminTabs';
import WizardStepContent from '@/components/admin/WizardStepContent';
import { notify } from '@/lib/feedback';

const titles = ['Agent profile', 'Create workspace', 'Data model', 'Calendar', 'Business website compliance', 'Phone number', 'A2P registration', 'Campaign and AI', 'Test and go live'];
const initial = { agent_email: '', agent_title: 'Licensed Life Insurance Agent', home_timezone: 'America/Chicago', primary_color: '#0F1E3D', accent_color: '#FF6B2C', max_calls_per_day: 6, licensed_states: [], products_offered: ['IUL'], test_phone_numbers: [], calendar_hours: [...[1, 2, 3, 4, 5].map(day => ({ day, open: '09:00', close: '18:00' })), { day: 6, open: '10:00', close: '14:00' }] };

// Success titles for each wizard action, keyed by "function:action".
const DONE = {
  'provisionSubAccount:provision': ['Workspace ready', 'Next: paste the workspace token below.'],
  'provisionSubAccount:verify': ['Token verified', 'The workspace is connected. Continue to the data model.'],
  'provisionDataModel:build': ['Data model built', 'Fields, tags and the pipeline are in place. Continue to the calendar.'],
  'provisionCalendar:create': ['Calendar ready', 'Next: connect the owner’s external calendar in GHL.'],
  'adminPhone:purchase': ['Number purchased', 'Set up call forwarding and voicemail below.'],
  'provisionCampaign:clone': ['Campaign prepared', 'Next: send the agent invitation.'],
  'inviteAgent:invite': ['Invitation sent', 'The agent gets an email to sign in.'],
  'adminMessaging:go_live': ['Account activated', 'This agent can now send texts.'],
  'adminMessaging:pause': ['Account paused', 'No texts go out until it is activated again.'],
};
const doneFor = (name, input, r) => {
  if (name === 'adminPhone' && input.action === 'search') {
    const n = r?.numbers?.length || 0;
    return n ? [`${n} number${n === 1 ? '' : 's'} found`, 'Choose one below.'] : null;
  }
  if (name === 'adminMessaging' && input.action === 'agent_mode') return input.mode === 'autopilot' ? ['Autopilot on', 'The AI replies without approvals for this agent.'] : ['Switched to review', 'Replies wait for approval.'];
  return DONE[`${name}:${input.action}`] || ['Done', ''];
};

export default function AdminOnboard() {
  const [params, setParams] = useSearchParams();
  const email = params.get('agent');
  const [form, setForm] = useState(initial);
  const [step, setStep] = useState(1);
  // Which button is working: "function:action" for wizard actions, "persist:<where>" for saves.
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [result, setResult] = useState(null);
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['admin-agent', email], enabled: !!email, queryFn: () => call('adminAgents', { action: 'get', agent_email: email }) });

  useEffect(() => {
    if (data) { setForm({ ...initial, ...data.settings, calendar_hours: data.settings.calendar_hours?.length ? data.settings.calendar_hours : initial.calendar_hours }); setStep(data.settings.onboarding_step || 1); }
    else if (!email) { setForm(initial); setStep(1); }
  }, [data, email]);

  const change = (key, value) => setForm(prev => ({ ...prev, [key]: value }));

  async function save(next = step) {
    const payload = { ...form, action: 'save', onboarding_step: next, test_phone_numbers: (form.test_phone_numbers || []).filter(Boolean), business_address: form.address_street ? [form.address_street, form.address_city, [form.address_state, form.address_zip].filter(Boolean).join(' ')].filter(Boolean).join(', ') : form.business_address };
    const r = await call('adminAgents', payload);
    setForm({ ...initial, ...r.settings });
    setStep(next);
    if (!email) setParams({ agent: r.settings.agent_email });
    qc.invalidateQueries({ queryKey: ['admin-agents'] });
    qc.invalidateQueries({ queryKey: ['admin-templates'] });
    return r;
  }

  async function run(name, input) {
    setBusy(`${name}:${input.action}${input.mode ? `:${input.mode}` : ''}`); setMessage('');
    try {
      await save();
      const r = await call(name, { agent_email: form.agent_email, ...input });
      setResult(r);
      if (r.settings) setForm({ ...initial, ...r.settings, calendar_hours: r.settings.calendar_hours?.length ? r.settings.calendar_hours : initial.calendar_hours });
      const instructions = typeof r.instructions === 'string' ? r.instructions : typeof r.manual === 'string' ? r.manual : '';
      if (instructions || r.manual) {
        // Steps the admin has to do by hand stay on screen; the toast points at them.
        setMessage(instructions || 'Manual setup required.');
        notify.info('Manual setup required', 'Follow the steps shown below the form.');
      } else {
        const done = doneFor(name, input, r);
        if (done) notify.ok(done[0], done[1]);
        else notify.info('No numbers found', 'Try a different area code.');
      }
      return r;
    } catch (e) { notify.err(e, 'That step did not finish'); return null; }
    finally { setBusy(''); }
  }

  async function persist(next, where) {
    setBusy(`persist:${where}`); setMessage('');
    try {
      await save(next);
      if (where === 'stay') notify.ok('Progress saved', `${form.brand_name || form.agent_email || 'This agent'} is on step ${next}.`);
      if (where === 'next') notify.ok('Progress saved', `Now on step ${next}: ${titles[next - 1]}.`);
    } catch (e) { notify.err(e, 'Progress not saved'); }
    finally { setBusy(''); }
  }

  return (
    <div>
      <AdminTabs />
      <h1 className="page-title">Onboarding wizard</h1>
      <p className="subtext mt-2">{form.brand_name || 'New agent'} · {email || 'Create an agent profile to begin'}</p>
      {error && <p className="text-destructive">{error.message}</p>}
      {isLoading && email ? <p className="mt-6">Loading saved progress…</p> : (
        <>
          <div className="my-6 flex gap-2 overflow-auto">
            {titles.map((title, i) => (
              <button key={title} disabled={!!busy || (!email && i > 0)} onClick={() => persist(i + 1, 'tab')} className={`min-h-11 whitespace-nowrap rounded-lg border px-3 text-xs transition-colors ${step === i + 1 ? 'bg-navy text-navy-foreground' : 'bg-card hover:bg-muted'} ${busy === 'persist:tab' ? 'opacity-70' : ''}`}>{i + 1}. {title}</button>
            ))}
          </div>
          <section key={step} className="panel lr-rise p-5 sm:p-7">
            <h2 className="mb-6 text-lg font-semibold">{step}. {titles[step - 1]}</h2>
            <WizardStepContent step={step} form={form} change={change} existing={!!email} run={run} busy={busy} result={result} />
            {message && <p role="status" className="lr-rise mt-5 rounded-lg bg-muted p-4 text-xs leading-6">{message}</p>}
            <div className="mt-7 flex flex-wrap justify-between gap-3 border-t pt-5">
              <Button variant="outline" loading={busy === 'persist:back'} disabled={!!busy || step === 1} onClick={() => persist(step - 1, 'back')}>Back</Button>
              <div className="flex gap-3">
                <Button variant="outline" loading={busy === 'persist:stay'} disabled={!!busy} onClick={() => persist(step, 'stay')}>{busy === 'persist:stay' ? 'Saving' : 'Save progress'}</Button>
                {step < 9 && <Button loading={busy === 'persist:next'} disabled={!!busy} onClick={() => persist(step + 1, 'next')}>Save and continue</Button>}
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
