import { useEffect, useState } from 'react';
import { PanelSkeleton } from '@/components/system/Loaders';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { call } from '@/components/workspace/api';
import { Button } from '@/components/ui/button';
import SetupShell from '@/components/setup/SetupShell';
import { CalendarCheck2, CalendarX2, Clock, Link2, Video, X } from 'lucide-react';
import { notify } from '@/lib/feedback';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const HOW = {
  google: ['Open Google Calendar on a computer → Settings (gear) → click your calendar under "Settings for my calendars".', 'Scroll to "Integrate calendar" and copy "Secret address in iCal format".'],
  outlook: ['Open Outlook on the web → Settings → Calendar → Shared calendars.', 'Under "Publish a calendar", pick your calendar, choose "Can view when I\'m busy", Publish, then copy the ICS link.'],
  icloud: ['Open Calendar on iPhone or Mac, tap the (i) next to your calendar.', 'Turn on "Public Calendar" and copy the link.'],
};

export default function SetupCalendar() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['availability'], queryFn: () => call('availability', { action: 'view' }) });
  const [hours, setHours] = useState([]), [max, setMax] = useState(6), [blocked, setBlocked] = useState([]), [newDay, setNewDay] = useState('');
  const [url, setUrl] = useState(''), [provider, setProvider] = useState('google'), [meet, setMeet] = useState('');
  const [busy, setBusy] = useState(''), [flash, setFlash] = useState({});
  const flashCls = k => (flash[k] ? 'lr-done' : '');
  const ERR = { hours: 'Hours not saved', meet: 'Link not saved', disconnect: 'Could not disconnect', feed: 'Calendar not connected', off: 'Days off not saved' };
  useEffect(() => { if (data) { setHours(data.hours); setMax(data.max_calls_per_day); setBlocked(data.blocked_dates); setMeet(data.meeting_link || ''); } }, [data]);
  // The Microsoft 365 OAuth callback (msOAuth edge function) sends the browser back here with ?ms=connected|error.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ms = params.get('ms');
    if (!ms) return;
    if (ms === 'connected') notify.ok('Microsoft 365 calendar connected', params.get('email') ? `Busy times from ${params.get('email')} are kept off your booking times.` : '');
    else notify.err(params.get('message') || 'Microsoft did not complete the connection.', 'Calendar not connected');
    window.history.replaceState({}, '', window.location.pathname);
  }, []);

  async function save(kind, body, note, detail = '') {
    setBusy(kind);
    try {
      qc.setQueryData(['availability'], await call('availability', { action: 'save', ...body }));
      await Promise.all(['open-times', 'launch', 'setup-status'].map(k => qc.invalidateQueries({ queryKey: [k] })));
      notify.ok(note, detail);
      const section = kind === 'disconnect' ? 'feed' : kind;
      setFlash(f => ({ ...f, [section]: (f[section] || 0) + 1 }));
      return true;
    }
    catch (e) { notify.err(e, ERR[kind] || ''); return false; } finally { setBusy(''); }
  }
  async function refreshBusy() {
    setBusy('refresh');
    try {
      const next = await call('availability', { action: 'refresh_busy' });
      qc.setQueryData(['availability'], next);
      await qc.invalidateQueries({ queryKey: ['open-times'] });
      if (next?.busy_error) notify.err(next.busy_error, 'Calendar checked, with a problem');
      else notify.ok('Calendar checked', typeof next?.busy_blocks_next_two_weeks === 'number' ? `${next.busy_blocks_next_two_weeks} busy block${next.busy_blocks_next_two_weeks === 1 ? '' : 's'} in the next two weeks are kept off your booking times.` : '');
      setFlash(f => ({ ...f, feed: (f.feed || 0) + 1 }));
    } catch (e) { notify.err(e, 'Could not check your calendar'); } finally { setBusy(''); }
  }
  const byDay = Object.fromEntries(hours.map(h => [h.day, h]));
  const toggle = d => setHours(byDay[d] ? hours.filter(h => h.day !== d) : [...hours, { day: d, open: '09:00', close: '17:00' }].sort((a, b) => a.day - b.day));
  const setTime = (d, k, v) => setHours(hours.map(h => h.day === d ? { ...h, [k]: v } : h));

  return <SetupShell title="Availability" description="When people can book a call with you. Everything is managed here, and the AI only offers times you're actually free.">
    {isLoading ? <PanelSkeleton rows={5} /> : error ? <p className="text-destructive">{error.message}</p> : <>
      <section key={`h${flash.hours || 0}`} className={`panel space-y-4 p-5 ${flashCls('hours')}`}>
        <h2 className="flex items-center gap-2 font-semibold"><Clock size={16} />Weekly hours <span className="text-xs font-normal text-muted-foreground">({data.timezone.replace('_', ' ')})</span></h2>
        <div className="space-y-2">{DAYS.map((name, d) => <div key={d} className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex w-32 items-center gap-2"><input type="checkbox" checked={!!byDay[d]} onChange={() => toggle(d)} />{name}</label>
          {byDay[d] ? <><input type="time" className="field w-auto" value={byDay[d].open} onChange={e => setTime(d, 'open', e.target.value)} /><span>to</span><input type="time" className="field w-auto" value={byDay[d].close} onChange={e => setTime(d, 'close', e.target.value)} /></> : <span className="text-muted-foreground">Unavailable</span>}
        </div>)}</div>
        <label className="block max-w-xs"><span className="field-label">Most calls in one day</span><input type="number" min="1" max="30" className="field" value={max} onChange={e => setMax(Number(e.target.value))} /></label>
        <Button disabled={!!busy} loading={busy === 'hours'} onClick={() => save('hours', { hours, max_calls_per_day: max }, 'Hours saved', 'The AI now offers only these times.')}>{busy === 'hours' ? 'Saving…' : 'Save hours'}</Button>
      </section>

      <section key={`m${flash.meet || 0}`} className={`panel space-y-3 p-5 ${flashCls('meet')}`}>
        <h2 className="flex items-center gap-2 font-semibold"><Video size={16} />Video meeting link</h2>
        <p className="subtext text-sm">Your Zoom personal meeting link (or Google Meet / Teams). It goes on every booked call's invite for you and the lead, so they can join by video or wait for your call. Leave it empty for phone-only calls.</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input className="field" inputMode="url" placeholder="https://us02web.zoom.us/j/1234567890" value={meet} onChange={e => setMeet(e.target.value)} />
          <Button className="shrink-0" disabled={!!busy || meet.trim() === (data.meeting_link || '')} loading={busy === 'meet'} onClick={() => save('meet', { meeting_link: meet.trim() }, meet.trim() ? 'Meeting link saved' : 'Meeting link removed', meet.trim() ? 'It goes on every new booking.' : 'New bookings are phone-only.')}>{busy === 'meet' ? 'Saving…' : 'Save link'}</Button>
        </div>
        <p className="text-xs text-muted-foreground">In Zoom: Meetings → Personal Room → copy the invite link.</p>
      </section>

      <section key={`f${flash.feed || 0}`} className={`panel space-y-4 p-5 ${flashCls('feed')}`}>
        <h2 className="flex items-center gap-2 font-semibold"><Link2 size={16} />Avoid my personal calendar</h2>
        {data.busy_calendar_connected ? <div className="space-y-2 text-sm">
          <p className="flex items-center gap-2"><CalendarCheck2 size={16} className="text-success" />Connected to {data.busy_calendar_host}. {data.busy_blocks_next_two_weeks} busy block{data.busy_blocks_next_two_weeks === 1 ? '' : 's'} in the next two weeks are kept off your booking times.</p>
          {data.busy_error && <p role="alert" className="text-destructive">{data.busy_error}</p>}
          <p className="text-xs text-muted-foreground">Checked {data.busy_checked_at ? new Date(data.busy_checked_at).toLocaleString() : 'never'}. Refreshes automatically every 10 minutes.</p>
          <div className="flex gap-2"><Button size="sm" variant="outline" disabled={!!busy} loading={busy === 'refresh'} onClick={refreshBusy}>{busy === 'refresh' ? 'Checking…' : 'Check now'}</Button>
            <Button size="sm" variant="ghost" disabled={!!busy} loading={busy === 'disconnect'} onClick={() => save('disconnect', { busy_calendar_url: '' }, 'Calendar disconnected', 'Busy times from it are no longer blocked.')}>Disconnect</Button></div>
        </div> : <div className="space-y-3 text-sm">
          <p className="subtext">Paste your calendar's private link once. We read only busy times, never event details, and keep those times off your booking calendar.</p>
          <div className="flex gap-2">{Object.keys(HOW).map(p => <Button key={p} size="sm" type="button" variant={provider === p ? 'default' : 'outline'} onClick={() => setProvider(p)}>{p === 'google' ? 'Google' : p === 'outlook' ? 'Outlook' : 'iCloud'}</Button>)}</div>
          <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">{HOW[provider].map(s => <li key={s}>{s}</li>)}</ol>
          <input className="field" placeholder="Paste the private calendar link" value={url} onChange={e => setUrl(e.target.value)} />
          <Button disabled={!url.trim() || !!busy} loading={busy === 'feed'} onClick={async () => { if (await save('feed', { busy_calendar_url: url }, 'Calendar connected', 'Your busy times are now kept off your booking times.')) setUrl(''); }}>{busy === 'feed' ? 'Checking link…' : 'Connect'}</Button>
        </div>}
      </section>

      <section key={`o${flash.off || 0}`} className={`panel space-y-4 p-5 ${flashCls('off')}`}>
        <h2 className="flex items-center gap-2 font-semibold"><CalendarX2 size={16} />Days off</h2>
        <div className="flex flex-wrap items-end gap-2"><input type="date" className="field w-auto" value={newDay} min={new Date().toISOString().slice(0, 10)} onChange={e => setNewDay(e.target.value)} />
          <Button variant="outline" disabled={!newDay || !!busy} loading={busy === 'off'} onClick={async () => { const next = [...new Set([...blocked, newDay])]; const label = new Date(`${newDay}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }); if (await save('off', { blocked_dates: next }, 'Day off added', `No calls get booked on ${label}.`)) setNewDay(''); }}>Add day off</Button></div>
        {!blocked.length ? <p className="subtext text-sm">None. Pick a date above to block it off.</p> : <ul className="flex flex-wrap gap-2">{blocked.map(d => <li key={d} className="flex items-center gap-2 rounded-full bg-muted px-3 py-1 text-xs">{new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}<button type="button" aria-label="Remove day off" disabled={!!busy} className="rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground disabled:opacity-50" onClick={() => save('off', { blocked_dates: blocked.filter(x => x !== d) }, 'Day off removed', 'That day is open for bookings again.')}><X size={12} /></button></li>)}</ul>}
      </section>
    </>}
  </SetupShell>;
}
