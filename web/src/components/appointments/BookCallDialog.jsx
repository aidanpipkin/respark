import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { notify } from '@/lib/feedback';
import { base44 } from '@/api/base44Client';
import { call } from '@/components/workspace/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';

const dayKey = (iso, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
const dayLabel = (iso, tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(iso));
const timeLabel = (iso, tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

function ContactPicker({ onPick }) {
  const qc = useQueryClient();
  const me = qc.getQueryData(['workspace'])?.user?.email;
  const [term, setTerm] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => { const t = setTimeout(() => setQ(term.trim()), 250); return () => clearTimeout(t); }, [term]);
  const searching = q.length >= 2;
  const { data, isFetching } = useQuery({
    queryKey: ['book-search', me, searching ? q : ''], placeholderData: p => p,
    queryFn: () => {
      const base = { ...(me ? { agent_email: me } : {}), status: { $nin: ['opted_out', 'not_interested', 'closed'] } };
      const fields = ['first_name', 'last_name', 'phone', 'state', 'status', 'timezone'];
      if (!searching) return base44.entities.Lead.filter(base, { sort: '-last_inbound_at', limit: 6, fields });
      const t = q.slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return base44.entities.Lead.filter({ ...base, status: { $ne: 'opted_out' }, $or: ['first_name', 'last_name', 'phone', 'email'].map(k => ({ [k]: { $regex: t, $options: 'i' } })) }, { limit: 8, fields });
    },
  });
  const items = data?.items || [];
  return <div className="space-y-2">
    <input autoFocus className="field" placeholder="Search by name or phone" value={term} onChange={e => setTerm(e.target.value)} />
    {!searching && items.length > 0 && <p className="pt-1 text-xs text-muted-foreground">Recent leads</p>}
    {items.length > 0 && <ul className={`max-h-64 divide-y overflow-auto rounded-md border transition-opacity ${isFetching ? 'opacity-60' : ''}`}>{items.map(l => <li key={l.id}><button type="button" className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-sm hover:bg-muted" onClick={() => onPick(l)}><span className="font-medium">{[l.first_name, l.last_name].filter(Boolean).join(' ') || l.phone}</span><span className="text-xs text-muted-foreground">{[l.state, l.phone].filter(Boolean).join(', ')}</span></button></li>)}</ul>}
    {searching && !isFetching && items.length === 0 && <p className="text-sm text-muted-foreground">No leads match.</p>}
    {!searching && !isFetching && items.length === 0 && <p className="text-sm text-muted-foreground">No open leads to book with (closed and opted-out leads are not listed; search by name to find anyone). <Link to="/contacts/import" className="font-medium text-primary hover:underline">Import your leads</Link> and you can book calls with any of them here. The AI also books calls on its own once texting is live.</p>}
  </div>;
}

/** Book a new call (pick contact, then time) or move an existing one. Everything stays in LeadRespark. */
export default function BookCallDialog({ open, onOpenChange, lead: initialLead = null, appointment = null, onDone }) {
  const qc = useQueryClient();
  const [lead, setLead] = useState(initialLead);
  useEffect(() => { if (initialLead) setLead(initialLead); }, [initialLead]);
  const leadId = appointment?.lead_id || lead?.id;
  const [slot, setSlot] = useState(''), [day, setDay] = useState(''), [sendText, setSendText] = useState(true);
  const [busy, setBusy] = useState(false);
  const { data, isLoading, error } = useQuery({ queryKey: ['open-times', leadId], enabled: open && !!leadId, queryFn: () => call('availability', { action: 'slots', lead_id: leadId }) });
  const tz = data?.agent_timezone || 'America/Chicago';
  const days = useMemo(() => { const m = new Map(); for (const s of data?.slots || []) { const k = dayKey(s, tz); if (!m.has(k)) m.set(k, []); m.get(k).push(s); } return [...m.entries()]; }, [data, tz]);
  const activeDay = day || days[0]?.[0];

  async function confirm() {
    setBusy(true);
    try {
      const r = await call('availability', appointment ? { action: 'reschedule', appointment_id: appointment.id, slot, notify: sendText } : { action: 'book', lead_id: leadId, slot, notify: sendText });
      await Promise.all([qc.invalidateQueries({ queryKey: ['appointments'] }), qc.invalidateQueries({ queryKey: ['contact'] }), qc.invalidateQueries({ queryKey: ['open-times'] })]);
      onDone?.(r);
      const textNote = r && 'texted' in r ? (r.texted ? ' They got a confirmation text.' : ` No text sent: ${r.text_error}`) : '';
      notify.ok(appointment ? 'Call moved' : 'Call booked', `${dayLabel(slot, tz)} at ${timeLabel(slot, tz)}.${textNote}`, { label: 'View calendar', to: '/appointments' });
      close(false);
    } catch (e) { notify.err(e, appointment ? 'Could not move the call' : 'Could not book the call'); } finally { setBusy(false); }
  }
  function close(v) { onOpenChange(v); if (!v) { setSlot(''); setDay(''); setLead(initialLead); } }

  return <Dialog open={open} onOpenChange={close}>
    <DialogContent className="max-w-lg">
      <DialogHeader>
        <DialogTitle>{appointment ? 'Move this call' : 'Book a call'}</DialogTitle>
        <DialogDescription>{lead || appointment ? `With ${appointment?.lead_name || [lead?.first_name, lead?.last_name].filter(Boolean).join(' ') || lead?.phone}. Times are in your time zone (${tz.replace(/_/g, ' ')}).` : 'Choose who the call is with.'}</DialogDescription>
      </DialogHeader>
      {!leadId ? <ContactPicker onPick={setLead} /> : isLoading ? <p className="py-6 text-center text-sm text-muted-foreground">Finding open times…</p> : error ? <p className="text-sm text-destructive">{error.message}</p> : !days.length ? <div className="space-y-3"><p className="text-sm text-muted-foreground">No open times in the next two weeks. Add hours or remove days off on the Availability page.</p><Button size="sm" variant="outline" asChild><Link to="/setup/calendar" onClick={() => close(false)}>Edit availability</Link></Button></div> : <div className="space-y-4">
        <div className="flex gap-2 overflow-x-auto pb-1">{days.map(([k, list]) => <Button key={k} type="button" size="sm" variant={k === activeDay ? 'default' : 'outline'} onClick={() => { setDay(k); setSlot(''); }}>{dayLabel(list[0], tz)}</Button>)}</div>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">{(days.find(([k]) => k === activeDay)?.[1] || []).map(s => <Button key={s} type="button" size="sm" variant={s === slot ? 'default' : 'outline'} onClick={() => setSlot(s)}>{timeLabel(s, tz)}</Button>)}</div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={sendText} onChange={e => setSendText(e.target.checked)} />Text them a confirmation</label>
        <Button className="w-full" disabled={!slot} loading={busy} onClick={confirm}>{busy ? 'Saving…' : slot ? `${appointment ? 'Move to' : 'Book'} ${dayLabel(slot, tz)} at ${timeLabel(slot, tz)}` : 'Pick a time'}</Button>
      </div>}
    </DialogContent>
  </Dialog>;
}
