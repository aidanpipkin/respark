import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, Upload, MessageSquare, X, Bookmark, Download, PauseCircle, Users, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, DropdownMenuLabel } from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import PageHeader from '@/components/workspace/PageHeader';
import StatusChip from '@/components/workspace/StatusChip';
import TestLeadBadge from '@/components/contacts/TestLeadBadge';
import EmptyState from '@/components/workspace/EmptyState';
import { Bone } from '@/components/system/Loaders';
import { call } from '@/components/workspace/api';
import { stageOf, stageColors } from '@/lib/stages';
import { prettyPhone } from '@/lib/phone';
import { notify } from '@/lib/feedback';

// Stages in the order an agent cares about them. Counts come from the server, so they're exact at any size.
const STAGES = [
  { key: 'all', label: 'All leads', help: 'Everyone you have uploaded.' },
  { key: 'needs_you', label: 'Needs you', tone: 'needs_you', help: 'Asked for you, or the AI wants your judgment.' },
  { key: 'talking', label: 'Talking', tone: 'talking', help: 'Replied and talking with your AI.' },
  { key: 'booked', label: 'Booked', tone: 'booked', help: 'A call is on your calendar.' },
  { key: 'after_call', label: 'After the call', tone: 'after_call', help: 'No-shows, follow-ups and objections.' },
  { key: 'texting', label: 'Being texted', tone: 'texting', help: "In the follow-up series. Hasn't replied yet." },
  { key: 'waiting', label: 'Waiting to start', tone: 'waiting', help: 'Uploaded. First text not sent yet.' },
  { key: 'clients', label: 'Clients', tone: 'client', help: 'Closed and in client care.' },
  { key: 'closed_out', label: 'Closed out', tone: 'closed', help: 'Said no or finished. Texting stopped.' },
  { key: 'opted_out', label: 'Opted out', tone: 'opted_out', help: 'Texted STOP. Never contacted again.' },
];
const SORTS = [['', 'Most relevant'], ['reply', 'Latest reply'], ['texted', 'Latest text sent'], ['newest', 'Newest uploaded'], ['name', 'Name A–Z']];

function rel(iso) {
  if (!iso) return '';
  const m = (Date.now() - Date.parse(iso)) / 60000;
  const a = Math.abs(m);
  const t = a < 60 ? `${Math.max(1, Math.round(a))}m` : a < 1440 ? `${Math.round(a / 60)}h` : `${Math.round(a / 1440)}d`;
  return m < 0 ? `in ${t}` : `${t} ago`;
}
function lastActivity(l) {
  const inb = l.last_inbound_at, out = l.last_outbound_at;
  if (inb && (!out || inb >= out)) return { text: `Replied ${rel(inb)}`, strong: true };
  if (out) return { text: `Texted ${rel(out)}` };
  return { text: 'Not texted yet' };
}
function nextUp(l) {
  if (['opted_out', 'not_interested', 'closed'].includes(l.status)) return 'Done';
  if (l.status === 'needs_human') return 'Waiting on you';
  if (l.sequence_paused || l.ai_paused) return 'Paused';
  if (l.status === 'booked') return 'Call booked';
  const next = [l.next_send_at, l.track_next_at, l.next_nudge_at, l.next_nurture_at].filter(Boolean).sort()[0];
  return next ? `Next text ${rel(next)}` : '—';
}
/** A button on the dark selection bar, with a spinner while its action runs. */
function BarButton({ busy, active, children, ...props }) {
  return <button type="button" disabled={!!busy} aria-busy={active || undefined} className="flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium hover:bg-white/10 disabled:opacity-50 aria-busy:opacity-90" {...props}>{active && <Loader2 size={13} className="animate-spin" />}{children}</button>;
}

const nameOf = l => [l.first_name, l.last_name].filter(Boolean).join(' ') || prettyPhone(l.phone) || 'Unnamed lead';

function StageRail({ stage, counts, onPick }) {
  return (
    <>
      {/* Desktop: vertical list. */}
      <nav aria-label="Lead stages" className="hidden w-44 shrink-0 lg:block xl:w-52">
        <ul className="space-y-0.5">
          {STAGES.map(s => {
            const on = s.key === stage, n = counts[s.key];
            const c = s.tone ? stageColors(s.tone) : null;
            return (
              <li key={s.key}>
                <button type="button" onClick={() => onPick(s.key)} className={`flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm transition-colors ${on ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'}`}>
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: c ? c.dot : 'hsl(var(--foreground))' }} />
                  <span className="flex-1 truncate">{s.label}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">{n === undefined ? '' : n.toLocaleString()}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      {/* Phone: scrolling chips. */}
      <nav aria-label="Lead stages" className="no-scrollbar -mx-4 flex gap-1.5 overflow-x-auto px-4 lg:hidden">
        {STAGES.map(s => {
          const on = s.key === stage, n = counts[s.key];
          const c = s.tone ? stageColors(s.tone) : null;
          return (
            <button key={s.key} type="button" onClick={() => onPick(s.key)} className={`flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[13px] ${on ? 'border-foreground bg-foreground text-background' : 'bg-card text-muted-foreground'}`}>
              {c && <span className="h-1.5 w-1.5 rounded-full" style={{ background: c.dot }} />}{s.label}{n ? <span className="tabular-nums opacity-70">{n.toLocaleString()}</span> : null}
            </button>
          );
        })}
      </nav>
    </>
  );
}

export default function Contacts() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const stage = STAGES.some(s => s.key === params.get('stage')) ? params.get('stage') : 'all';
  const tag = params.get('tag') || '';
  const setFilter = next => {
    const q = { stage, tag, ...next }, out = {};
    if (q.stage && q.stage !== 'all') out.stage = q.stage;
    if (q.tag) out.tag = q.tag;
    setParams(out);
  };

  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [sort, setSort] = useState('');
  const [picked, setPicked] = useState(() => new Set());
  const [busy, setBusy] = useState('');
  const [flashed, setFlashed] = useState(() => new Set());
  const [tagInput, setTagInput] = useState('');
  const [naming, setNaming] = useState(false);
  const [viewName, setViewName] = useState('');

  useEffect(() => { const t = setTimeout(() => setTerm(search.trim()), 300); return () => clearTimeout(t); }, [search]);
  useEffect(() => { setPicked(new Set()); }, [stage, term, sort, tag]);
  useEffect(() => { if (!flashed.size) return undefined; const t = setTimeout(() => setFlashed(new Set()), 1300); return () => clearTimeout(t); }, [flashed]);

  const counts = useQuery({ queryKey: ['lead-stages', tag, term], queryFn: () => call('leads', { action: 'stages', tag, search: term }), staleTime: 30000, refetchInterval: 60000, placeholderData: p => p });
  const tagsQ = useQuery({ queryKey: ['lead-tags'], queryFn: () => call('leads', { action: 'tags' }), staleTime: 60000 });
  const viewsQ = useQuery({ queryKey: ['lead-views'], queryFn: () => call('leads', { action: 'views' }), staleTime: 300000 });
  const list = useInfiniteQuery({
    queryKey: ['lead-list', stage, term, sort, tag], initialPageParam: null,
    queryFn: ({ pageParam }) => call('leads', { action: 'list', stage, search: term, sort, tag, cursor: pageParam }),
    getNextPageParam: p => p.next_cursor || undefined,
  });
  const rows = useMemo(() => list.data?.pages.flatMap(p => p.items) || [], [list.data]);
  const c = counts.data?.counts || {};
  const info = STAGES.find(s => s.key === stage);
  const views = viewsQ.data?.views || [];
  const tags = tagsQ.data?.tags || [];
  const allPicked = rows.length > 0 && rows.every(r => picked.has(r.id));

  const toggle = id => setPicked(p => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const refresh = () => Promise.all(['lead-list', 'lead-stages', 'lead-tags'].map(k => qc.invalidateQueries({ queryKey: [k] })));

  async function bulk(op, value) {
    setBusy(op);
    const ids = [...picked];
    try {
      const r = await call('leads', { action: 'bulk', op, ids, value });
      const verb = { pause: 'paused', resume: 'resumed', not_interested: 'marked not interested', tag_add: `tagged "${value}"`, tag_remove: `untagged "${value}"` }[op];
      const detail = { pause: 'No texts go out to them until you resume.', resume: 'Their texts pick up where they left off.', not_interested: 'Texting has stopped for them.', tag_remove: '' }[op];
      if (!op.startsWith('tag')) setPicked(new Set());
      setTagInput('');
      await refresh();
      setFlashed(new Set(ids));
      notify.ok(`${r.updated} lead${r.updated === 1 ? '' : 's'} ${verb}`, op === 'tag_add' ? '' : detail || '', op === 'tag_add' && tag !== value ? { label: 'Show tagged', to: `/contacts?tag=${encodeURIComponent(value)}` } : null);
    } catch (e) { notify.err(e, 'Could not update those leads'); } finally { setBusy(''); }
  }
  async function saveView(e) {
    e.preventDefault();
    if (!viewName.trim()) return;
    setBusy('view');
    try {
      const name = viewName.trim();
      await call('leads', { action: 'save_view', name, stage, tag, search: term, sort });
      setViewName(''); setNaming(false);
      await qc.invalidateQueries({ queryKey: ['lead-views'] });
      notify.ok('View saved', `Open "${name}" any time from Views.`);
    } catch (x) { notify.err(x, 'Could not save the view'); } finally { setBusy(''); }
  }
  async function deleteView(id) {
    try { await call('leads', { action: 'delete_view', id }); await qc.invalidateQueries({ queryKey: ['lead-views'] }); notify.ok('View deleted'); }
    catch (x) { notify.err(x, 'Could not delete the view'); }
  }
  function applyView(v) { setSort(v.sort || ''); setSearch(v.search || ''); const out = {}; if (v.stage && v.stage !== 'all') out.stage = v.stage; if (v.tag) out.tag = v.tag; setParams(out); }
  async function exportCsv() {
    setBusy('export');
    try {
      const r = await call('leads', { action: 'export', stage, tag, search: term });
      const url = URL.createObjectURL(new Blob([r.csv], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url; a.download = `leads-${stage}${tag ? `-${tag}` : ''}-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      notify.ok(`Exported ${r.count.toLocaleString()} lead${r.count === 1 ? '' : 's'}`, `${r.truncated ? 'The first 20,000, ' : ''}with consent details. Check your downloads.`);
    } catch (e) { notify.err(e, 'Could not export'); } finally { setBusy(''); }
  }

  return (
    <div className={picked.size ? 'pb-36' : ''}>
      <PageHeader
        title="Leads"
        description={counts.data ? `${(c.all || 0).toLocaleString()} leads` : ' '}
        actions={<>
          <Button variant="outline" loading={busy === 'export'} onClick={exportCsv} title="Download what's shown, with consent details">{busy !== 'export' && <Download />}{busy === 'export' ? 'Exporting…' : 'Export'}</Button>
          <Button asChild><Link to="/contacts/import"><Upload />Import leads</Link></Button>
        </>}
      />

      <div className="flex flex-col gap-4 lg:flex-row lg:gap-8">
        <StageRail stage={stage} counts={c} onPick={key => setFilter({ stage: key })} />

        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative min-w-[200px] flex-1">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <input className="field pl-9 pr-8" placeholder="Search leads" value={search} onChange={e => setSearch(e.target.value)} />
              {search && <button type="button" aria-label="Clear search" onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"><X size={14} /></button>}
            </label>
            {tags.length > 0 && (
              <select aria-label="Tag" className="field w-auto" value={tag} onChange={e => setFilter({ tag: e.target.value })}>
                <option value="">All tags</option>
                {tags.map(t => <option key={t.name} value={t.name}>{t.name} ({t.count})</option>)}
                {tag && !tags.some(t => t.name === tag) && <option value={tag}>{tag}</option>}
              </select>
            )}
            <select aria-label="Sort" className="field w-auto" value={sort} onChange={e => setSort(e.target.value)}>{SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="outline"><Bookmark />Views</Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                {views.length > 0 && <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Saved views</DropdownMenuLabel>}
                {views.map(v => (
                  <DropdownMenuItem key={v.id} onSelect={() => applyView(v)} className="group justify-between">
                    <span className="truncate">{v.name}</span>
                    <span role="button" tabIndex={0} aria-label={`Delete ${v.name}`} onClick={e => { e.stopPropagation(); e.preventDefault(); deleteView(v.id); }} className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"><X size={13} /></span>
                  </DropdownMenuItem>
                ))}
                {views.length > 0 && <DropdownMenuSeparator />}
                <DropdownMenuItem onSelect={() => setNaming(true)}>Save current view…</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {(tag || stage !== 'all') && (
            <p className="text-sm text-muted-foreground">
              {info.help}
              {tag && <> Tagged <span className="font-medium text-foreground">{tag}</span>. <button type="button" className="font-medium text-foreground underline-offset-4 hover:underline" onClick={() => setFilter({ tag: '' })}>Clear tag</button></>}
            </p>
          )}

          <section className="panel overflow-hidden">
            <div className="hidden grid-cols-[20px_minmax(0,1fr)_auto_32px] items-center gap-4 border-b bg-canvas px-4 py-2 text-xs font-medium text-muted-foreground md:grid xl:grid-cols-[20px_minmax(0,1.6fr)_130px_minmax(0,1fr)_130px_32px]">
              <input type="checkbox" aria-label="Select all shown" checked={allPicked} onChange={e => setPicked(e.target.checked ? new Set(rows.map(r => r.id)) : new Set())} />
              <span>Name</span><span>Stage</span><span className="hidden xl:block">Last activity</span><span className="hidden xl:block">Next</span><span />
            </div>
            {list.isLoading ? (
              <div className="divide-y">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="flex items-center gap-4 px-4 py-3.5"><Bone className="h-4 w-4" /><Bone className="h-4 w-1/3" /><Bone className="ml-auto h-4 w-20" /></div>)}</div>
            ) : list.error ? (
              <div className="flex flex-wrap items-center justify-between gap-3 p-5 text-sm text-destructive"><span>{list.error.message}</span><Button size="sm" variant="outline" loading={list.isRefetching} onClick={() => list.refetch()}>Try again</Button></div>
            ) : !rows.length ? (
              term ? <EmptyState icon={Search} title="No leads match that search" description="Try a first or last name, or the last 4 digits of their phone."><Button variant="outline" onClick={() => setSearch('')}>Clear search</Button></EmptyState>
                : tag ? <EmptyState icon={Users} title={`No leads tagged ${tag}${stage === 'all' ? '' : ` in ${info.label.toLowerCase()}`}`} description="Tags you add from the selection bar show up here."><Button variant="outline" onClick={() => setFilter({ tag: '' })}>Clear tag</Button></EmptyState>
                : stage === 'all' ? <EmptyState icon={Users} title="No leads yet" description="Upload a list of past leads and your AI starts texting them once you're live."><Button asChild><Link to="/contacts/import">Import leads</Link></Button></EmptyState>
                  : <EmptyState icon={Users} title={`Nobody in ${info.label.toLowerCase()}`} description="Leads move here on their own as conversations progress."><Button variant="outline" onClick={() => setFilter({ stage: 'all' })}>See all leads</Button></EmptyState>
            ) : (
              <ul className="divide-y">
                {rows.map(l => {
                  const col = stageColors(stageOf(l.status, l.track));
                  const last = lastActivity(l);
                  const name = nameOf(l);
                  const isPicked = picked.has(l.id);
                  return (
                    <li
                      key={l.id}
                      onClick={() => navigate(`/contacts/${l.id}`)}
                      style={{ boxShadow: `inset 3px 0 0 ${col.dot}`, ...(isPicked ? { background: col.faint } : {}) }}
                      className={`${flashed.has(l.id) ? 'lr-done ' : ''}grid cursor-pointer grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-4 py-3 transition-colors hover:bg-muted/40 md:grid-cols-[20px_minmax(0,1fr)_auto_32px] xl:grid-cols-[20px_minmax(0,1.6fr)_130px_minmax(0,1fr)_130px_32px]`}
                    >
                      <input type="checkbox" aria-label={`Select ${name}`} checked={isPicked} onClick={e => e.stopPropagation()} onChange={() => toggle(l.id)} />
                      <div className="min-w-0">
                        <p className="flex min-w-0 items-center gap-2 text-sm font-medium"><span className="truncate">{name}</span>{l.state && <span className="font-normal text-muted-foreground">{l.state}</span>}<TestLeadBadge phone={l.phone} /></p>
                        <p className="truncate text-[13px] text-muted-foreground">
                          {l.status === 'needs_human' && l.needs_human_reason ? <span style={{ color: col.ink }}>{l.needs_human_reason}</span> : (l.ai_summary || prettyPhone(l.phone))}
                        </p>
                        {l.tags?.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{l.tags.slice(0, 4).map(t => <button key={t} type="button" onClick={e => { e.stopPropagation(); setFilter({ tag: t }); }} className="rounded bg-muted px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">{t}</button>)}</div>}
                        <p className="mt-0.5 text-xs text-muted-foreground xl:hidden">{last.text}{!['Done', '—'].includes(nextUp(l)) ? ` · ${nextUp(l)}` : ''}</p>
                      </div>
                      <div><StatusChip status={l.status} track={l.track} /></div>
                      <p className={`hidden text-[13px] xl:block ${last.strong ? 'font-medium' : 'text-muted-foreground'}`}>{last.text}</p>
                      <p className="hidden items-center gap-1.5 text-[13px] text-muted-foreground xl:flex">{(l.sequence_paused || l.ai_paused) && !['opted_out', 'not_interested', 'closed'].includes(l.status) && <PauseCircle size={13} />}{nextUp(l)}</p>
                      <Link to={`/inbox?lead=${l.id}`} onClick={e => e.stopPropagation()} aria-label={`Open texts with ${name}`} title="Open conversation" className="hidden h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground md:flex"><MessageSquare size={15} /></Link>
                    </li>
                  );
                })}
              </ul>
            )}
            {list.hasNextPage && (
              <div className="border-t p-2 text-center">
                <Button variant="ghost" loading={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>
                  {list.isFetchingNextPage ? 'Loading…' : `Show more${c[stage] ? ` (${rows.length.toLocaleString()} of ${c[stage].toLocaleString()})` : ''}`}
                </Button>
              </div>
            )}
          </section>
        </div>
      </div>

      {picked.size > 0 && (
        <div className="fixed inset-x-3 bottom-[calc(68px+env(safe-area-inset-bottom))] z-40 mx-auto max-w-3xl rounded-lg bg-foreground p-2 text-background shadow-xl lr-rise lg:bottom-6 lg:left-[264px]">
          <div className="flex flex-wrap items-center gap-1">
            <span className="px-2 text-[13px] font-medium">{picked.size} selected</span>
            {rows.length > picked.size && <button type="button" className="rounded px-1.5 py-1 text-[13px] underline-offset-2 hover:underline" onClick={() => setPicked(new Set(rows.map(r => r.id)))}>Select all {rows.length}</button>}
            <span className="flex-1" />
            <BarButton busy={busy} active={busy === 'pause'} onClick={() => bulk('pause')}>Pause</BarButton>
            <BarButton busy={busy} active={busy === 'resume'} onClick={() => bulk('resume')}>Resume</BarButton>
            <BarButton busy={busy} active={busy === 'not_interested'} onClick={() => bulk('not_interested')}>Not interested</BarButton>
            <form className="flex items-center gap-1" onSubmit={e => { e.preventDefault(); if (tagInput.trim()) bulk('tag_add', tagInput.trim()); }}>
              <input className="h-8 w-28 rounded-md border border-white/20 bg-transparent px-2 text-[13px] text-background placeholder:text-background/50 focus:outline-none focus:ring-1 focus:ring-white/40" list="lead-tag-options" placeholder="Tag" value={tagInput} maxLength={30} onChange={e => setTagInput(e.target.value)} />
              <datalist id="lead-tag-options">{tags.map(t => <option key={t.name} value={t.name} />)}</datalist>
              <button type="submit" disabled={!!busy || !tagInput.trim()} className="flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium hover:bg-white/10 disabled:opacity-40">{busy === 'tag_add' && <Loader2 size={13} className="animate-spin" />}Add</button>
              <button type="button" disabled={!!busy || !tagInput.trim()} onClick={() => bulk('tag_remove', tagInput.trim())} className="flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] font-medium hover:bg-white/10 disabled:opacity-40">{busy === 'tag_remove' && <Loader2 size={13} className="animate-spin" />}Remove</button>
            </form>
            <button type="button" aria-label="Clear selection" onClick={() => setPicked(new Set())} className="rounded p-1.5 hover:bg-white/10"><X size={15} /></button>
          </div>
        </div>
      )}

      <Dialog open={naming} onOpenChange={setNaming}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Save this view</DialogTitle><DialogDescription>Saves the current stage, tag, search and sort so you can come back in one click.</DialogDescription></DialogHeader>
          <form onSubmit={saveView} className="space-y-3">
            <input autoFocus className="field" placeholder="For example: Hot Texas leads" maxLength={40} value={viewName} onChange={e => setViewName(e.target.value)} />
            <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setNaming(false)}>Cancel</Button><Button type="submit" loading={busy === 'view'} disabled={!viewName.trim()}>{busy === 'view' ? 'Saving…' : 'Save view'}</Button></div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
