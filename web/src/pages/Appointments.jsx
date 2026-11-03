import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, ChevronLeft, ChevronRight, MoreHorizontal } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { call } from '@/components/workspace/api';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, DropdownMenuLabel } from '@/components/ui/dropdown-menu';
import PageHeader from '@/components/workspace/PageHeader';
import StatusChip from '@/components/workspace/StatusChip';
import EmptyState from '@/components/workspace/EmptyState';
import { PanelSkeleton } from '@/components/system/Loaders';
import BookCallDialog from '@/components/appointments/BookCallDialog';
import ConfirmBadge from '@/components/appointments/ConfirmBadge';
import OutcomeDialog from '@/components/pipeline/OutcomeDialog';
import CallButton from '@/components/calls/CallButton';
import ThinCalendarBanner from '@/components/appointments/ThinCalendarBanner';
import { notify } from '@/lib/feedback';

const ACTIVE = ['booked', 'rescheduled'];
const pretty = p => String(p || '').replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3');
const dayKey = (iso, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

function dayHeading(key, tz) {
  const today = dayKey(new Date().toISOString(), tz);
  const tomorrow = dayKey(new Date(Date.now() + 86400000).toISOString(), tz);
  if (key === today) return 'Today';
  if (key === tomorrow) return 'Tomorrow';
  return new Date(`${key}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

/** The times the AI can offer right now: proof the calendar is connected, and a quick read on availability. */
function OpenTimes({ tz, day }) {
  const { data, isLoading, error } = useQuery({ queryKey: ['open-times', 'calendar'], queryFn: () => call('availability', { action: 'slots' }), staleTime: 120000 });
  const slots = (data?.slots || []).filter(t => !day || dayKey(t, tz) === day);
  const fmtTime = t => new Date(t).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  const groups = [];
  for (const t of slots.slice(0, day ? 40 : 8)) { const k = dayKey(t, tz); const g = groups.find(x => x.k === k); if (g) g.times.push(t); else groups.push({ k, times: [t] }); }
  return (
    <section className="panel mb-5">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div><h2 className="section-title">{day ? 'Open times this day' : 'Next open times'}</h2><p className="text-[13px] text-muted-foreground">What the AI offers leads: your hours, minus anything on your personal calendar.</p></div>
        <Link to="/setup/calendar" className="shrink-0 text-sm font-medium text-primary hover:underline">Edit</Link>
      </div>
      <div className="px-4 py-3">
        {isLoading ? <div className="h-5 w-2/3 rounded bg-muted lr-shimmer" />
          : error ? <p className="text-sm text-destructive">{error.message}</p>
          : !groups.length ? <p className="text-sm text-muted-foreground">{day ? 'No open times this day.' : 'No open times in the next two weeks.'} Your personal calendar may be blocking most of your hours. Check your hours and calendar on the Availability page.</p>
          : <ul className="space-y-1.5">{groups.map(g => <li key={g.k} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm"><span className="w-28 shrink-0 font-medium">{dayHeading(g.k, tz)}</span><span className="text-muted-foreground">{g.times.map(fmtTime).join(', ')}</span></li>)}</ul>}
      </div>
    </section>
  );
}

function AppointmentRow({ a, tz, onMove, onOutcome }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const past = Date.parse(a.start_time) < Date.now();
  const time = new Date(a.start_time).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
  async function cancel(handBack) {
    setBusy(true);
    try {
      await call('availability', { action: 'cancel', appointment_id: a.id, hand_back: handBack });
      await Promise.all([qc.invalidateQueries({ queryKey: ['appointments'] }), qc.invalidateQueries({ queryKey: ['open-times'] })]);
      const when = new Date(a.start_time).toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' });
      notify.ok('Call cancelled', `${a.lead_name || 'The call'} on ${when} at ${time}. ${handBack ? 'The AI will text them new times.' : 'Follow up with them yourself.'}`);
    }
    catch (e) { notify.err(e, 'Could not cancel the call'); } finally { setBusy(false); }
  }
  return (
    <li className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3.5">
      <div className="w-16 shrink-0 pt-0.5 text-sm font-medium tabular-nums">{time}</div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {a.lead_id ? <Link to={`/contacts/${a.lead_id}`} className="text-sm font-medium hover:underline">{a.lead_name || 'Phone call'}</Link> : <span className="text-sm font-medium">{a.lead_name || 'Phone call'}</span>}
          {a.status !== 'booked' && <StatusChip status={a.status} />}
          {a.status === 'booked' && !past && <ConfirmBadge c={a.confirmation} />}
        </div>
        <p className="mt-0.5 text-[13px] text-muted-foreground">{a.phone_to_call ? pretty(a.phone_to_call) : 'No phone on file'}{a.outcome ? `. Outcome: ${a.outcome.replace(/_/g, ' ')}` : ''}</p>
        {a.ai_summary && <p className="mt-1 line-clamp-2 text-[13px] text-muted-foreground">{a.ai_summary}</p>}
      </div>
      {a.status === 'booked' && (
        <div className="flex items-center gap-1.5">
          {past ? <Button size="sm" onClick={onOutcome}>Log outcome</Button> : a.lead_id && <CallButton leadId={a.lead_id} size="sm" label="Call" />}
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button size="sm" variant="ghost" className="w-8 px-0" aria-label="More" loading={busy}>{!busy && <MoreHorizontal />}</Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              {!past && <DropdownMenuItem onSelect={onMove}>Move to another time</DropdownMenuItem>}
              {past && <DropdownMenuItem onSelect={onOutcome}>Log outcome</DropdownMenuItem>}
              {!past && <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Cancel the call</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => cancel(true)}>Cancel, AI offers new times</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => cancel(false)}>Cancel, I'll follow up</DropdownMenuItem>
              </>}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </li>
  );
}

function Agenda({ email, tz, day, onMove, onOutcome, onBook }) {
  const { data, isLoading, error, hasNextPage, fetchNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['appointments', 'agenda', email, day || 'upcoming'], enabled: !!email, initialPageParam: undefined,
    queryFn: ({ pageParam }) => {
      const start = day ? new Date(`${day}T00:00:00`) : new Date(Date.now() - 12 * 3600000);
      const end = new Date(start); end.setDate(end.getDate() + 1);
      return base44.entities.Appointment.filter({ agent_email: email, start_time: day ? { $gte: start.toISOString(), $lt: end.toISOString() } : { $gte: start.toISOString() } }, { sort: 'start_time', limit: 30, cursor: pageParam });
    },
    getNextPageParam: p => (p.has_more ? p.next_cursor : undefined),
  });
  const groups = useMemo(() => {
    const m = new Map();
    for (const a of data?.pages.flatMap(p => p.items) || []) { const k = dayKey(a.start_time, tz); if (!m.has(k)) m.set(k, []); m.get(k).push(a); }
    return [...m.entries()];
  }, [data, tz]);

  if (isLoading) return <PanelSkeleton rows={4} />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!groups.length) return <section className="panel"><EmptyState icon={CalendarDays} title={day ? 'No calls this day' : 'No upcoming calls'} description="Calls your AI books show up here. You can also book one yourself."><Button onClick={onBook}>Book a call</Button><Button variant="outline" asChild><Link to="/setup/calendar">Set your hours</Link></Button></EmptyState></section>;
  return (
    <div className="space-y-6">
      {groups.map(([k, items]) => (
        <section key={k}>
          <h2 className="mb-2 text-sm font-medium text-muted-foreground">{dayHeading(k, tz)}</h2>
          <ul className="panel divide-y">{items.map(a => <AppointmentRow key={a.id} a={a} tz={tz} onMove={() => onMove(a)} onOutcome={() => onOutcome(a)} />)}</ul>
        </section>
      ))}
      {hasNextPage && <div className="text-center"><Button variant="outline" disabled={isFetchingNextPage} onClick={() => fetchNextPage()}>{isFetchingNextPage ? 'Loading…' : 'Show more'}</Button></div>}
    </div>
  );
}

function Month({ email, tz, month, setMonth, selected, onDay }) {
  const first = new Date(`${month}-01T12:00:00`);
  const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const start = new Date(first.getFullYear(), first.getMonth(), 1), end = new Date(first.getFullYear(), first.getMonth() + 1, 1);
  const { data } = useQuery({
    queryKey: ['appointments', 'month', email, month], enabled: !!email,
    queryFn: () => base44.entities.Appointment.filter({ agent_email: email, status: { $in: [...ACTIVE, 'held', 'no_show'] }, start_time: { $gte: start.toISOString(), $lt: end.toISOString() } }, { limit: 500, fields: ['start_time', 'status'] }),
  });
  const counts = useMemo(() => { const m = {}; for (const a of data?.items || []) { const k = dayKey(a.start_time, tz); m[k] = (m[k] || 0) + 1; } return m; }, [data, tz]);
  const today = dayKey(new Date().toISOString(), tz);
  const shift = n => { const d = new Date(first); d.setMonth(d.getMonth() + n); setMonth(d.toISOString().slice(0, 7)); };
  return (
    <section className="panel">
      <div className="flex h-12 items-center justify-between border-b px-3">
        <Button variant="ghost" size="icon" aria-label="Previous month" onClick={() => shift(-1)}><ChevronLeft /></Button>
        <h2 className="section-title">{first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</h2>
        <Button variant="ghost" size="icon" aria-label="Next month" onClick={() => shift(1)}><ChevronRight /></Button>
      </div>
      <div className="grid grid-cols-7 border-b text-center text-xs text-muted-foreground">{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => <span key={d} className="py-2">{d}</span>)}</div>
      <div className="grid grid-cols-7">
        {Array.from({ length: first.getDay() }, (_, i) => <div key={`b${i}`} className="border-b border-r" />)}
        {Array.from({ length: days }, (_, i) => {
          const key = `${month}-${String(i + 1).padStart(2, '0')}`;
          const n = counts[key] || 0;
          const on = selected === key;
          return (
            <button key={key} type="button" onClick={() => onDay(key)} className={`flex min-h-16 flex-col items-start gap-1 border-b border-r p-2 text-left transition-colors sm:min-h-20 ${on ? 'bg-primary/5' : 'hover:bg-muted/50'}`}>
              <span className={`flex h-6 w-6 items-center justify-center rounded-full text-[13px] tabular-nums ${key === today ? 'bg-primary font-semibold text-primary-foreground' : on ? 'font-semibold' : ''}`}>{i + 1}</span>
              {n > 0 && <span className="rounded px-1.5 text-xs font-medium" style={{ background: 'hsl(var(--st-booked) / 0.13)', color: 'hsl(var(--st-booked-ink))' }}>{n} call{n > 1 ? 's' : ''}</span>}
            </button>
          );
        })}
      </div>
    </section>
  );
}

export default function Appointments() {
  const { settings, user } = useOutletContext();
  const tz = settings.home_timezone || 'America/Chicago';
  const [view, setView] = useState('upcoming');
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [day, setDay] = useState('');
  const [booking, setBooking] = useState(false);
  const [bookLead, setBookLead] = useState(null);
  const [moving, setMoving] = useState(null);
  const [params, setParams] = useSearchParams();
  // Arriving from a call or a lead page with ?book=<lead id>: open the booking dialog on that lead.
  useEffect(() => {
    const id = params.get('book'); if (!id) return;
    base44.entities.Lead.filter({ id }, { limit: 1 }).then(p => { if (p.items[0]) { setBookLead(p.items[0]); setBooking(true); } }).catch(() => {});
    params.delete('book'); setParams(params, { replace: true });
  }, [params, setParams]);
  const [outcomeFor, setOutcomeFor] = useState(null);
  const dayRef = useRef(null);
  // On phones the day's details sit below the month grid: bring them into view when a day is picked.
  useEffect(() => { if (day && dayRef.current && window.innerWidth < 1280) dayRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [day]);

  return (
    <div>
      <PageHeader
        title="Calendar"
        actions={<>
          <Button variant="outline" asChild><Link to="/setup/calendar">Availability</Link></Button>
          <Button onClick={() => setBooking(true)}>Book a call</Button>
        </>}
      />
      <ThinCalendarBanner className="mb-5" />
      <div className="mb-5 flex items-center justify-between gap-3">
        <div className="flex rounded-md border p-0.5" role="tablist">
          {[['upcoming', 'Upcoming'], ['month', 'Month']].map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={view === k} onClick={() => { setView(k); if (k === 'upcoming') setDay(''); }} className={`h-8 rounded px-3 text-sm ${view === k ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground'}`}>{l}</button>)}
        </div>
        <span className="text-sm text-muted-foreground">Times in {tz.replace(/_/g, ' ')}</span>
      </div>

      {view === 'month' ? (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <Month email={user?.email} tz={tz} month={month} setMonth={setMonth} selected={day} onDay={setDay} />
          <div ref={dayRef} className="scroll-mt-20">{day ? <><OpenTimes tz={tz} day={day} /><Agenda email={user?.email} tz={tz} day={day} onMove={setMoving} onOutcome={setOutcomeFor} onBook={() => setBooking(true)} /></> : <p className="pt-2 text-sm text-muted-foreground">Pick a day to see its calls and open times.</p>}</div>
        </div>
      ) : (
        <><OpenTimes tz={tz} day="" /><Agenda email={user?.email} tz={tz} day="" onMove={setMoving} onOutcome={setOutcomeFor} onBook={() => setBooking(true)} /></>
      )}

      <BookCallDialog open={booking} onOpenChange={v => { setBooking(v); if (!v) setBookLead(null); }} lead={bookLead} />
      {outcomeFor && <OutcomeDialog open={!!outcomeFor} onOpenChange={v => !v && setOutcomeFor(null)} appointment={outcomeFor} />}
      {moving && <BookCallDialog open={!!moving} onOpenChange={v => !v && setMoving(null)} appointment={moving} />}
    </div>
  );
}
