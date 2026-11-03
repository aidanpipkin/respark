import { useState } from 'react';
import { PanelSkeleton } from '@/components/system/Loaders';
import { Link, useOutletContext } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { call } from '@/components/workspace/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import PolicyForm, { missingPolicy } from '@/components/pipeline/PolicyForm';
import { BadgeCheck, MoreHorizontal } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import PageHeader from '@/components/workspace/PageHeader';
import EmptyState from '@/components/workspace/EmptyState';
import { stageColors } from '@/lib/stages';
import { notify } from '@/lib/feedback';

const STEP = { welcome: 'Congratulations text', submitted: 'Submitted text', premium: 'First premium reminder', c3: '3-month check-in', c6: '6-month check-in', c9: '9-month check-in + referral ask', c12: '1-year review + referral ask' };
const FREQ = { monthly: '/mo', quarterly: '/qtr', semi_annual: '/6 mo', annual: '/yr' };
const d = iso => iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';

function EditPolicy({ client, onClose }) {
  const qc = useQueryClient();
  const [p, setP] = useState({ carrier: client.carrier, product: client.product, policy_number: client.policy_number, coverage_amount: String(client.coverage_amount), premium_amount: String(client.premium_amount), premium_frequency: client.premium_frequency, coverage_start_date: client.coverage_start_date, first_draft_date: client.first_draft_date, beneficiary: client.beneficiary, notes: client.notes });
  const [busy, setBusy] = useState(false);
  const missing = missingPolicy(p);
  async function save() {
    setBusy(true);
    try { await call('outcomes', { action: 'update_policy', policy_id: client.id, policy: p }); await qc.invalidateQueries({ queryKey: ['clients'] }); notify.ok('Policy saved', `${client.client_name}'s texts now use these details.`); onClose(); }
    catch (e) { notify.err(e, 'Could not save the policy'); } finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={v => !v && onClose()}><DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto"><DialogHeader><DialogTitle>Policy for {client.client_name}</DialogTitle></DialogHeader>
    <PolicyForm value={p} onChange={setP} />
    <Button disabled={missing.length > 0} loading={busy} onClick={save}>{busy ? 'Saving…' : missing.length ? `Add ${missing[0]}` : 'Save policy'}</Button>
  </DialogContent></Dialog>;
}

const STATUS = { approved: ['Active', 'booked'], submitted: ['Waiting on approval', 'needs_you'], declined: ['Declined', 'closed'], lapsed: ['Lapsed', 'no_show'], cancelled: ['Cancelled', 'closed'] };
const FILTERS = [['', 'All'], ['submitted', 'Waiting on approval'], ['approved', 'Active'], ['lapsed', 'Lapsed'], ['cancelled', 'Cancelled']];

function PolicyStatus({ status }) {
  const [label, tone] = STATUS[status] || [status, 'closed'];
  const col = stageColors(tone);
  return <span className="inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium" style={{ background: col.soft, color: col.ink }}><span className="h-1.5 w-1.5 rounded-full" style={{ background: col.dot }} />{label}</span>;
}

function Row({ c, tz, onEdit }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState('');
  const DONE = { approved: ['Marked approved', 'The congratulations text and premium reminder are on their way.'], declined: ['Marked declined', 'Their client texts are stopped.'], lapsed: ['Marked lapsed', ''], cancelled: ['Marked cancelled', ''] };
  async function status(next) {
    setBusy(next);
    try {
      await call('outcomes', { action: 'policy_status', policy_id: c.id, status: next });
      await qc.invalidateQueries({ queryKey: ['clients'] });
      const [title, detail] = DONE[next] || ['Status updated', ''];
      notify.ok(title, detail ? `${c.client_name}. ${detail}` : c.client_name);
    }
    catch (e) { notify.err(e, 'Could not update the policy'); } finally { setBusy(''); }
  }
  return (
    <li className="grid gap-x-6 gap-y-2 px-4 py-3.5 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1.5fr)_minmax(0,1fr)_auto] lg:items-center">
      <div className="min-w-0">
        <Link to={`/contacts/${c.lead_id}`} className="text-sm font-medium hover:underline">{c.client_name}</Link>
        <div className="mt-1"><PolicyStatus status={c.status} /></div>
      </div>
      <div className="min-w-0 text-sm">
        <p className="truncate">{c.carrier}, {c.product}</p>
        <p className="text-[13px] text-muted-foreground">{c.coverage} coverage, {c.premium}{FREQ[c.premium_frequency] || ''}. Policy #{c.policy_number}</p>
        <p className="text-[13px] text-muted-foreground">Starts {d(c.coverage_start_date)}, first draft {d(c.first_draft_date)}</p>
      </div>
      <div className="text-[13px]">
        {c.needs_you ? <p style={{ color: stageColors('needs_you').ink }}>{c.needs_you}</p>
          : c.next_touch ? <p>{STEP[c.next_touch.key] || 'Annual review'}<span className="block text-muted-foreground">{new Date(c.next_touch.at).toLocaleDateString('en-US', { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric' })}</span></p>
            : <p className="text-muted-foreground">No texts scheduled</p>}
      </div>
      <div className="flex items-center gap-1.5 lg:justify-end">
        {c.status === 'submitted' && <Button size="sm" disabled={!!busy} loading={busy === 'approved'} onClick={() => status('approved')}>Mark approved</Button>}
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button size="sm" variant="ghost" className="w-8 px-0" aria-label="More" loading={!!busy && busy !== 'approved'}>{!(busy && busy !== 'approved') && <MoreHorizontal />}</Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onEdit(c)}>Edit policy</DropdownMenuItem>
            <DropdownMenuSeparator />
            {c.status === 'submitted' && <DropdownMenuItem onSelect={() => status('declined')}>Declined by carrier</DropdownMenuItem>}
            <DropdownMenuItem onSelect={() => status('lapsed')}>Mark lapsed</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => status('cancelled')}>Mark cancelled</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

export default function Clients() {
  const { settings } = useOutletContext();
  const tz = settings.home_timezone || 'America/Chicago';
  const [filter, setFilter] = useState('');
  const [edit, setEdit] = useState(null);
  const { data, isLoading, error } = useQuery({ queryKey: ['clients', filter], queryFn: () => call('outcomes', { action: 'clients', status: filter || undefined }) });
  return (
    <div>
      <PageHeader title="Clients" description="Closed policies get a congratulations text, a first-premium reminder, and check-ins at 3, 6, 9 and 12 months." />
      <div className="no-scrollbar -mx-4 mb-4 flex gap-1 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        {FILTERS.map(([k, l]) => <button key={k} type="button" onClick={() => setFilter(k)} className={`h-8 shrink-0 rounded-md px-3 text-sm transition-colors ${filter === k ? 'bg-foreground font-medium text-background' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}>{l}</button>)}
      </div>
      {isLoading ? <PanelSkeleton rows={4} /> : error ? <p className="text-sm text-destructive">{error.message}</p> : !data.clients.length ? (
        <section className="panel"><EmptyState icon={BadgeCheck} title={filter ? 'No clients with this status' : 'No clients yet'} description='When a call closes, log the outcome as "Closed" and enter the policy details.'>{!filter && <Button asChild><Link to="/pipeline">Go to Pipeline</Link></Button>}{filter && <Button variant="outline" onClick={() => setFilter('')}>Show all clients</Button>}</EmptyState></section>
      ) : (
        <ul className="panel divide-y">{data.clients.map(c => <Row key={c.id} c={c} tz={tz} onEdit={setEdit} />)}</ul>
      )}
      {edit && <EditPolicy client={edit} onClose={() => setEdit(null)} />}
    </div>
  );
}
