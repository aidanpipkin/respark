import { useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import PageHeader from '@/components/workspace/PageHeader';
import { call } from '@/components/workspace/api';
import { notify } from '@/lib/feedback';

function Section({ title, description, children }) {
  return (
    <section className="grid gap-4 border-b py-6 first:pt-0 last:border-0 md:grid-cols-[240px_1fr] md:gap-8">
      <div><h2 className="section-title">{title}</h2>{description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}</div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

const LINKS = [
  ['/numbers', 'Phone numbers', 'Your texting and calling numbers, health and spam protection'],
  ['/credits', 'Billing & credits', 'Subscription, card, credit balance and auto-recharge'],
  ['/campaigns', 'Campaigns', 'What the AI says and the follow-up texts'],
  ['/setup/calendar', 'Availability', 'When the AI can book calls'],
];

export default function Profile() {
  const { settings, user } = useOutletContext();
  const qc = useQueryClient();
  const [form, setForm] = useState(settings);
  const [busy, setBusy] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const set = (key, v) => setForm(f => ({ ...f, [key]: v }));
  const dirty = ['display_name', 'notification_email', 'notification_phone', 'quiet_start', 'quiet_end', 'mode', 'reply_alerts'].some(k => (form[k] || '') !== (settings[k] || ''));

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await call('saveAgentSettings', form); await qc.invalidateQueries({ queryKey: ['workspace'] });
      notify.ok('Settings saved', (form.mode || 'review') === 'autopilot' ? 'The AI replies to leads on its own.' : 'The AI drafts replies for you to approve in the inbox.');
    }
    catch (x) { notify.err(x, 'Settings not saved'); } finally { setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Settings" />
      <form onSubmit={save} className="panel px-4 py-6 sm:px-6">
        <Section title="Profile" description="How you appear in texts and emails.">
          <label className="block"><span className="field-label">Display name</span><input className="field" maxLength={200} value={form.display_name || ''} onChange={e => set('display_name', e.target.value)} /></label>
          <p className="text-sm text-muted-foreground">Signed in as {user?.email}</p>
        </Section>
        <Section title="Notifications" description="Where we reach you when a lead needs you, and the phone we ring first when you call a lead.">
          <label className="block"><span className="field-label">Email</span><input className="field" type="email" maxLength={200} value={form.notification_email || ''} onChange={e => set('notification_email', e.target.value)} placeholder={user?.email} /></label>
          <label className="block"><span className="field-label">Your cell</span><input className="field" type="tel" maxLength={30} value={form.notification_phone || ''} onChange={e => set('notification_phone', e.target.value)} placeholder="(555) 555-5555" /></label>
          <label className="block"><span className="field-label">Text me when a lead replies</span>
            <select className="field" value={form.reply_alerts || 'every'} onChange={e => set('reply_alerts', e.target.value)}>
              <option value="every">Every reply (grouped if many come in at once)</option>
              <option value="needs_you">Only when they need me</option>
              <option value="off">Never, I'll check the inbox</option>
            </select>
          </label>
          <p className="field-hint">Booked calls, reminders 15 minutes before each call, and your morning agenda are always texted.</p>
          <div className="grid grid-cols-2 gap-3">
            <label className="block"><span className="field-label">Quiet hours start</span><input type="time" className="field" value={form.quiet_start || '20:00'} onChange={e => set('quiet_start', e.target.value)} /></label>
            <label className="block"><span className="field-label">Quiet hours end</span><input type="time" className="field" value={form.quiet_end || '09:00'} onChange={e => set('quiet_end', e.target.value)} /></label>
          </div>
          <p className="field-hint">No alerts during quiet hours. Your time zone is {String(settings.home_timezone || 'America/Chicago').replace(/_/g, ' ')}.</p>
        </Section>
        <Section title="Replies" description="What happens when a lead texts back. Your follow-up series sends on schedule either way; this only covers the AI's conversational replies.">
          {[['review', 'I approve each reply', 'The AI writes a suggested reply and waits for you in the inbox.'], ['autopilot', 'The AI replies on its own', 'Fastest. You can take over any conversation at any time.']].map(([v, label, help]) => (
            <label key={v} className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors ${(form.mode || 'review') === v ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'}`}>
              <input type="radio" name="mode" className="mt-1" checked={(form.mode || 'review') === v} onChange={() => set('mode', v)} />
              <span><span className="block text-sm font-medium">{label}</span><span className="block text-sm text-muted-foreground">{help}</span></span>
            </label>
          ))}
          <p className="field-hint">Opt-outs, quiet hours and campaign settings always apply.</p>
        </Section>
        <div className="flex items-center justify-end gap-3 border-t pt-5">
          {!dirty && !busy && <span className="text-sm text-muted-foreground">No unsaved changes</span>}
          <Button type="submit" disabled={!dirty} loading={busy}>{busy ? 'Saving…' : 'Save changes'}</Button>
        </div>
      </form>

      <ul className="panel mt-6 divide-y">
        {LINKS.map(([to, label, help]) => (
          <li key={to}><Link to={to} className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-muted/50"><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{label}</span><span className="block text-sm text-muted-foreground">{help}</span></span><ChevronRight size={16} className="text-muted-foreground" /></Link></li>
        ))}
      </ul>
      <div className="mt-6 flex justify-end"><Button variant="ghost" loading={signingOut} onClick={() => { setSigningOut(true); base44.auth.logout('/login'); }}>Sign out</Button></div>
    </div>
  );
}
