import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import { call } from '@/components/workspace/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import AdminTabs from '@/components/admin/AdminTabs';
import { PanelSkeleton } from '@/components/system/Loaders';
import { notify, useAction } from '@/lib/feedback';

const money = c => `$${((c || 0) / 100).toFixed(2)}`;
const words = v => String(v || '').replaceAll('_', ' ');
const waiting = s => s.self_serve && !s.beta_access && !s.connected;

function CreditsDialog({ agent, onClose, onDone }) {
  const [amount, setAmount] = useState('10');
  const { run, busy } = useAction();
  const [err, setErr] = useState('');
  useEffect(() => { setAmount('10'); setErr(''); }, [agent]);
  async function submit(e) {
    e.preventDefault();
    const dollars = Number(amount);
    if (!Number.isFinite(dollars) || dollars === 0) { setErr('Enter a dollar amount other than zero.'); return; }
    setErr('');
    const who = agent.brand_name || agent.agent_email;
    const ok = await run('credits', async () => { await call('adminAgents', { action: 'grant_credits', id: agent.id, amount_cents: Math.round(dollars * 100) }); await onDone(agent); return true; }, {
      ok: dollars > 0 ? 'Credits added' : 'Credits corrected',
      detail: dollars > 0 ? `${money(Math.round(dollars * 100))} in free texts added for ${who}.` : `${money(Math.round(-dollars * 100))} removed from ${who}.`,
      errTitle: 'Credits not added',
    });
    if (ok) onClose();
  }
  return (
    <Dialog open={!!agent} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Add free credits</DialogTitle>
          <DialogDescription>For {agent?.brand_name || agent?.agent_email}. Current balance {money(agent?.credits?.balance_cents)}. Use a negative amount to correct a mistake.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-3">
          <label className="block"><span className="field-label">Amount in dollars</span>
            <input autoFocus inputMode="decimal" className="field" value={amount} onChange={e => setAmount(e.target.value)} />
          </label>
          {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" loading={busy === 'credits'}>{busy === 'credits' ? 'Adding' : 'Add credits'}</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function AgentRow({ s, onCredits, onApprove, approving, flash }) {
  const c = s.credits;
  const creditWarn = c && (c.recharge_error || (!c.auto_recharge && c.balance_cents < 300));
  return (
    <li className={`flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center ${flash ? 'lr-done' : ''}`}>
      <Link to={`/admin/onboard?agent=${encodeURIComponent(s.agent_email)}`} className="min-w-0 flex-1 hover:underline-offset-4">
        <p className="truncate text-sm font-medium">{s.brand_name || s.agent_email} <span className="ml-1 rounded bg-muted px-1.5 py-0.5 text-xs font-normal capitalize text-muted-foreground">{s.status}</span></p>
        <p className="truncate text-[13px] text-muted-foreground">{s.agent_email}{s.self_serve ? ' · signed up themselves' : ''}</p>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          Step {s.onboarding_step || 1} of 9 · Registration {words(s.a2p_status || 'not_started')}
          {s.provisioning?.state ? ` · Build ${words(s.provisioning.state)}` : ''}
          {!s.connected ? ' · Not connected' : ''}
        </p>
        {s.provisioning?.error && <p className="mt-0.5 text-[13px] text-destructive">{s.provisioning.error}</p>}
      </Link>
      <div className="flex shrink-0 items-center gap-3">
        {c && <p className={`text-[13px] tabular-nums ${creditWarn ? 'text-destructive' : 'text-muted-foreground'}`}>{money(c.balance_cents)} · {c.card ? (c.auto_recharge ? 'auto-recharge on' : 'auto-recharge off') : 'no card'} · {c.lifetime_texts} texts{c.recharge_error ? ' · recharge failed' : ''}</p>}
        {waiting(s)
          ? <Button size="sm" loading={approving === s.agent_email} disabled={!!approving && approving !== s.agent_email} onClick={() => onApprove(s.agent_email)}>{approving === s.agent_email ? 'Approving' : 'Approve'}</Button>
          : c && <Button size="sm" variant="outline" onClick={() => onCredits(s)}>Add credits</Button>}
      </div>
    </li>
  );
}

export default function AdminAgents() {
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [approving, setApproving] = useState('');
  const [flash, setFlash] = useState('');
  const flashRow = key => { setFlash(key); setTimeout(() => setFlash(f => (f === key ? '' : f)), 1300); };
  const [crediting, setCrediting] = useState(null);
  const qc = useQueryClient();
  useEffect(() => { const t = setTimeout(() => setTerm(search.trim()), 250); return () => clearTimeout(t); }, [search]);
  const { data, isLoading, error, hasNextPage, fetchNextPage, isFetchingNextPage, refetch } = useInfiniteQuery({
    queryKey: ['admin-agents', term], initialPageParam: undefined,
    queryFn: ({ pageParam }) => call('adminAgents', { action: 'list', search: term, cursor: pageParam }),
    getNextPageParam: p => (p.has_more ? p.next_cursor : undefined),
  });
  const all = useMemo(() => data?.pages.flatMap(p => p.items) || [], [data]);
  const pending = all.filter(waiting), rest = all.filter(s => !waiting(s));

  async function approve(email) {
    setApproving(email);
    try {
      await call('adminAgents', { action: 'save', agent_email: email, beta_access: true });
      await Promise.all([refetch(), qc.invalidateQueries({ queryKey: ['pending-approvals'] })]);
      flashRow(email);
      notify.ok('Agent approved', `${email} can now build their workspace. They were moved to All agents.`);
    } catch (e) { notify.err(e, 'Approval failed'); }
    finally { setApproving(''); }
  }
  const row = s => <AgentRow key={s.id} s={s} flash={flash === s.agent_email} approving={approving} onApprove={approve} onCredits={setCrediting} />;

  return (
    <div>
      <AdminTabs />
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div><h1 className="page-title">Agents</h1><p className="mt-1 text-sm text-muted-foreground">Every workspace, its setup progress and credits.</p></div>
        <Button asChild><Link to="/admin/onboard"><Plus />New agent</Link></Button>
      </div>
      <label className="relative mb-5 block max-w-md">
        <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input className="field pl-9" placeholder="Search email or brand" value={search} onChange={e => setSearch(e.target.value)} />
      </label>
      {isLoading ? <PanelSkeleton rows={4} /> : error ? <p role="alert" className="text-sm text-destructive">{error.message}</p> : <div className="space-y-6">
        {pending.length > 0 && <section>
          <h2 className="section-title mb-2">Waiting for approval</h2>
          <p className="mb-3 text-sm text-muted-foreground">They signed up while new workspaces need your approval. Approving lets them build their workspace and start billing.</p>
          <ul className="panel divide-y">{pending.map(row)}</ul>
        </section>}
        <section>
          {pending.length > 0 && <h2 className="section-title mb-2">All agents</h2>}
          {rest.length ? <ul className="panel divide-y">{rest.map(row)}</ul> : !pending.length && <p className="text-sm text-muted-foreground">No matching agents.</p>}
        </section>
        {hasNextPage && <Button variant="outline" loading={isFetchingNextPage} onClick={() => fetchNextPage()}>{isFetchingNextPage ? 'Loading' : 'Load more'}</Button>}
      </div>}
      <CreditsDialog agent={crediting} onClose={() => setCrediting(null)} onDone={async a => { await refetch(); flashRow(a.agent_email); }} />
    </div>
  );
}
