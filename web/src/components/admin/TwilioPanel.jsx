import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { call } from '@/components/workspace/api';
import { notify } from '@/lib/feedback';
import { CheckCircle2, Circle, AlertTriangle } from 'lucide-react';

function Row({ ok, label, detail }) {
  return <li className="flex items-start gap-3 text-sm">{ok ? <CheckCircle2 size={17} className="mt-0.5 text-success" /> : <Circle size={17} className="mt-0.5 text-muted-foreground" />}<div><p className={ok ? '' : 'font-medium'}>{label}</p>{detail && <p className="text-xs text-muted-foreground">{detail}</p>}</div></li>;
}

export default function TwilioPanel() {
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['admin-twilio'], queryFn: () => call('adminTwilio', { action: 'status' }) });
  const [form, setForm] = useState({ twilio_primary_profile_sid: '', twilio_isv_email: '' });
  const [busy, setBusy] = useState(''), [flash, setFlash] = useState(false);
  useEffect(() => { if (data) setForm({ twilio_primary_profile_sid: data.settings.twilio_primary_profile_sid, twilio_isv_email: data.settings.twilio_isv_email }); }, [data]);

  async function save(extra = {}, key = 'save') {
    setBusy(key);
    try {
      await call('adminTwilio', { action: 'save', ...form, ...extra }); await refetch();
      if (extra.a2p_provider === 'twilio') notify.ok('Automatic registration on', 'Agents now register and buy numbers inside LeadRespark.');
      else if (extra.a2p_provider === 'manual') notify.ok('Switched to manual', 'Registrations go through the provisioning queue again.', { label: 'Open queue', to: '/admin/provisioning' });
      else notify.ok('Twilio settings saved', 'The checklist above was rechecked.');
      setFlash(true); setTimeout(() => setFlash(false), 1300);
    } catch (e) { notify.err(e, 'Twilio settings not saved'); } finally { setBusy(''); }
  }

  if (isLoading) return <section className="panel p-5"><p>Loading Twilio…</p></section>;
  if (error) return <section className="panel p-5"><p className="text-destructive">{error.message}</p></section>;
  const st = data.status, on = data.settings.a2p_provider === 'twilio';

  return (
    <section className={`panel space-y-5 p-5 ${flash ? 'lr-done' : ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold">Texting registration &amp; numbers (Twilio)</h2>
          <p className="subtext mt-1">When on, agents register A2P (with their own EIN or as a sole proprietor) and buy their number inside LeadRespark. Everything is submitted to Twilio automatically.</p>
        </div>
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${on ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'}`}>{on ? 'Automatic' : 'Manual'}</span>
      </div>

      <ol className="space-y-3">
        <Row ok={st.credentials} label="1. Add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in Supabase → Edge Functions → Secrets" detail="From your Twilio Console home page (main account, not a subaccount)." />
        <Row ok={st.account?.status === 'active' && st.account?.type !== 'Trial'} label="2. Upgraded Twilio account" detail={st.account ? `${st.account.name}: ${st.account.status}, ${st.account.type}` : 'Trial accounts cannot register A2P.'} />
        <Row ok={st.primary_profile?.status === 'twilio-approved'} label="3. Approved ISV Primary Customer Profile" detail={st.primary_profile ? `${st.primary_profile.name}: ${st.primary_profile.status}` : 'Twilio Console → Trust Hub → Customer Profiles → create a Primary profile for your company with business identity "ISV Reseller or Partner". Paste its BU… SID below.'} />
        {st.primary_profile && <Row ok={!st.isv_blocked?.length} label="4. Agent subaccounts can register under it (ISV/Reseller)" detail={st.isv_blocked?.length ? `Blocked for ${st.isv_blocked.join(', ')}. Open a Twilio Support ticket: "Please change the classification of our Primary Customer Profile ${form.twilio_primary_profile_sid || ''} from Direct Customer to ISV/Reseller. Secondary profiles in our subaccounts fail evaluation with errors 22216/22217." When Twilio confirms, those agents press Submit again.` : 'No blocked registrations. If an agent submission ever fails with 22216/22217, this turns red with the fix.'} />}
        <Row ok={on} label="5. Connect Twilio to GHL and turn on automatic registration" detail="GHL Agency Settings → Phone Integration → Twilio, using the same account. Map each agent's sub-account to the Twilio subaccount listed below if GHL doesn't do it automatically." />
      </ol>
      {st.error && <p className="flex gap-2 text-sm text-destructive"><AlertTriangle size={16} />{st.error}</p>}

      <div className="grid gap-4 sm:grid-cols-2">
        <label><span className="field-label">Primary Customer Profile SID</span><input className="field font-mono text-xs" placeholder="BU…" value={form.twilio_primary_profile_sid} onChange={e => setForm({ ...form, twilio_primary_profile_sid: e.target.value })} /></label>
        <label><span className="field-label">Compliance email (your company)</span><input className="field" type="email" value={form.twilio_isv_email} onChange={e => setForm({ ...form, twilio_isv_email: e.target.value })} /></label>
      </div>
      <div className="flex flex-wrap gap-3">
        <Button type="button" variant="outline" loading={busy === 'save'} disabled={!!busy} onClick={() => save()}>{busy === 'save' ? 'Saving' : 'Save'}</Button>
        {!on ? <Button type="button" loading={busy === 'on'} disabled={!!busy || !data.ready} onClick={() => save({ a2p_provider: 'twilio' }, 'on')}>Turn on automatic registration</Button>
          : <Button type="button" variant="ghost" loading={busy === 'off'} disabled={!!busy} onClick={() => save({ a2p_provider: 'manual' }, 'off')}>Switch back to manual</Button>}
      </div>
      {!data.ready && !on && <p className="text-xs text-muted-foreground">Finish steps 1–3 to turn it on.</p>}

      {!!data.accounts.length && <div>
        <h3 className="mb-2 text-sm font-semibold">Agent Twilio subaccounts</h3>
        <ul className="divide-y text-xs">{data.accounts.map(a => <li key={a.agent_email} className="flex flex-wrap justify-between gap-2 py-2"><span>{a.agent_email}</span><code className="select-all">{a.subaccount_sid}</code></li>)}</ul>
      </div>}
    </section>
  );
}
