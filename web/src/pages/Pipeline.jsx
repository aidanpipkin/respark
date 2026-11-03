import { useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import PageHeader from '@/components/workspace/PageHeader';
import { PanelSkeleton } from '@/components/system/Loaders';
import { call } from '@/components/workspace/api';
import { stageColors } from '@/lib/stages';
import OutcomeDialog from '@/components/pipeline/OutcomeDialog';
import BookCallDialog from '@/components/appointments/BookCallDialog';
import ConfirmBadge from '@/components/appointments/ConfirmBadge';
import { notify } from '@/lib/feedback';

export { default as ConfirmBadge } from '@/components/appointments/ConfirmBadge';

const COLS = [
  { key: 'no_show', label: 'No-show', help: 'Rebooking the missed call' },
  { key: 'follow_up', label: 'Follow-up', help: 'Answering questions, gently closing' },
  { key: 'lost_banking', label: 'Lost at banking', help: 'Working the bank-details objection' },
  { key: 'lost_social', label: 'Lost at social', help: 'Working the SSN objection' },
];
const when = (iso, tz) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

function Column({ title, help, tone, count, children, empty }) {
  const c = stageColors(tone);
  return (
    <section className="flex w-[290px] shrink-0 snap-start flex-col rounded-lg bg-canvas">
      <div className="px-3 pb-2 pt-3">
        <h2 className="flex items-center gap-2 text-sm font-medium"><span className="h-2 w-2 rounded-full" style={{ background: c.dot }} />{title}<span className="text-muted-foreground tabular-nums">{count}</span></h2>
        {help && <p className="mt-0.5 text-xs text-muted-foreground">{help}</p>}
      </div>
      <div className="flex-1 space-y-2 px-2 pb-2">{children}{empty && <p className="rounded-md border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">Nobody here</p>}</div>
    </section>
  );
}

function Card({ tone, children, busy = false }) {
  return <article aria-busy={busy || undefined} className={`rounded-md border bg-card p-3 text-sm transition-opacity ${busy ? 'pointer-events-none opacity-50' : 'lr-rise'}`} style={{ boxShadow: `inset 3px 0 0 ${stageColors(tone).dot}` }}>{children}</article>;
}

function LeadCard({ c, col, tz, onRebook }) {
  const qc = useQueryClient();
  const [moving, setMoving] = useState(false);
  async function move(to) {
    setMoving(true);
    try {
      await call('outcomes', { action: 'move', lead_id: c.id, to });
      await qc.invalidateQueries({ queryKey: ['pipeline'] });
      notify.ok(`Moved to ${COLS.find(x => x.key === to)?.label || 'new column'}`, `${c.name} now gets the ${(COLS.find(x => x.key === to)?.label || '').toLowerCase()} follow-up texts.`);
    }
    catch (e) { notify.err(e, `Could not move ${c.name}`); } finally { setMoving(false); }
  }
  return (
    <Card tone={col} busy={moving}>
      <div className="flex items-start justify-between gap-2">
        <Link to={`/contacts/${c.id}`} className="font-medium hover:underline">{c.name}</Link>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><button type="button" aria-label="Options" className="-mr-1 -mt-1 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><MoreHorizontal size={15} /></button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onRebook(c)}>Book a call</DropdownMenuItem>
            <DropdownMenuItem asChild><Link to={`/inbox?lead=${c.id}`}>Open texts</Link></DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Move to</DropdownMenuLabel>
            {COLS.filter(x => x.key !== col).map(x => <DropdownMenuItem key={x.key} onSelect={() => move(x.key)}>{x.label}</DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {c.needs_you && <p className="mt-1 text-xs font-medium" style={{ color: stageColors('needs_you').ink }}>{c.needs_you}</p>}
      {c.replied_at && !c.needs_you && <p className="mt-1 text-xs font-medium" style={{ color: stageColors('talking').ink }}>Replied</p>}
      {c.note && <p className="mt-1 line-clamp-2 text-[13px] text-muted-foreground">{c.note}</p>}
      <p className="mt-2 text-xs text-muted-foreground">{c.next_touch ? `Next text ${when(c.next_touch, tz)}` : 'No text scheduled'}</p>
    </Card>
  );
}

export default function Pipeline() {
  const { settings } = useOutletContext();
  const tz = settings.home_timezone || 'America/Chicago';
  const { data, isLoading, error } = useQuery({ queryKey: ['pipeline'], queryFn: () => call('outcomes', { action: 'board' }), refetchInterval: 60000 });
  const [outcomeFor, setOutcomeFor] = useState(null);
  const [rebook, setRebook] = useState(null);

  return (
    <div>
      <PageHeader
        title="Pipeline"
        description="After a call, log what happened. Each column sends its own follow-up texts."
        actions={<Button variant="outline" asChild><Link to="/clients">Clients{data ? ` (${data.counts.clients})` : ''}</Link></Button>}
      />
      {isLoading ? <PanelSkeleton rows={4} /> : error ? <p className="text-sm text-destructive">{error.message}</p> : (
        <div className="space-y-6">
          {data.needs_outcome.length > 0 && (
            <section className="panel">
              <div className="flex h-12 items-center justify-between border-b px-4">
                <h2 className="section-title flex items-center gap-2"><span className="h-2 w-2 rounded-full" style={{ background: stageColors('needs_you').dot }} />Calls that need an outcome<span className="font-normal text-muted-foreground tabular-nums">{data.needs_outcome.length}</span></h2>
                <span className="hidden text-sm text-muted-foreground sm:block">Follow-up texts start once you log them</span>
              </div>
              <ul className="divide-y">
                {data.needs_outcome.map(a => (
                  <li key={a.appointment_id} className="flex items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0"><p className="truncate text-sm font-medium">{a.name}</p><p className="text-xs text-muted-foreground">{when(a.start_time, tz)}</p></div>
                    <Button size="sm" onClick={() => setOutcomeFor(a)}>Log outcome</Button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0">
            <Column title="Upcoming calls" help="Booked, waiting on the call" tone="booked" count={data.upcoming.length} empty={!data.upcoming.length}>
              {data.upcoming.map(a => (
                <Card key={a.appointment_id} tone="booked">
                  <Link to={`/contacts/${a.lead_id}`} className="font-medium hover:underline">{a.name}</Link>
                  <p className="text-xs text-muted-foreground">{when(a.start_time, tz)}</p>
                  <div className="mt-1"><ConfirmBadge c={a.confirmation} /></div>
                  {a.summary && <p className="mt-1 line-clamp-2 text-[13px] text-muted-foreground">{a.summary}</p>}
                  <Button size="sm" variant="outline" className="mt-2" onClick={() => setOutcomeFor(a)}>Log outcome</Button>
                </Card>
              ))}
            </Column>
            {COLS.map(col => (
              <Column key={col.key} title={col.label} help={col.help} tone={col.key} count={data.counts[col.key]} empty={!data.columns[col.key].length}>
                {data.columns[col.key].map(c => <LeadCard key={c.id} c={c} col={col.key} tz={tz} onRebook={setRebook} />)}
              </Column>
            ))}
          </div>
        </div>
      )}
      {outcomeFor && <OutcomeDialog open={!!outcomeFor} onOpenChange={v => !v && setOutcomeFor(null)} appointment={outcomeFor} />}
      {rebook && <BookCallDialog open={!!rebook} onOpenChange={v => !v && setRebook(null)} lead={{ id: rebook.id, first_name: rebook.name }} />}
    </div>
  );
}
