import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, RefreshCw, MessageSquare, Loader2, Check, X, MoreHorizontal, ArrowDownUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import StatusChip from '@/components/workspace/StatusChip';
import EmptyState from '@/components/workspace/EmptyState';
import { stageOf, stageColors } from '@/lib/stages';
import { INBOX_TABS, shortAgo, waitTone } from '@/lib/inbox';

const initials = name => (String(name || '').replace(/\([^)]*\)/g, ' ').match(/[A-Za-z][A-Za-z'-]*/g) || ['?']).slice(0, 2).map(w => w[0].toUpperCase()).join('');

const EMPTY = {
  needs_human: ["You're all caught up", 'Nobody is waiting on you personally right now.'],
  drafts: ['Nothing to approve', 'Suggested replies that need your OK show up here.'],
  unanswered: ['Every reply has an answer', 'When a lead texts and nobody has answered yet, they show up here.'],
  unread: ['No new messages', "You've opened everything."],
  replied: ['No replies yet', 'When a lead texts back, the conversation shows up here. Texts nobody has answered yet are under All texts.'],
};

/** Two-tap confirm for actions that send or close many conversations at once. */
function ConfirmAction({ children, confirm, onConfirm, disabled }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => { if (!armed) return undefined; const t = setTimeout(() => setArmed(false), 4000); return () => clearTimeout(t); }, [armed]);
  return <button type="button" disabled={disabled} onClick={() => (armed ? (setArmed(false), onConfirm()) : setArmed(true))} className={`h-8 rounded-md px-2.5 text-[13px] font-medium transition-colors disabled:opacity-50 ${armed ? 'bg-primary text-primary-foreground' : 'hover:bg-white/10'}`}>{armed ? confirm : children}</button>;
}

function Waiting({ row, now }) {
  if (row.last_direction !== 'inbound' || ['opted_out', 'not_interested'].includes(row.status_chip)) return null;
  const tone = waitTone(row.last_time, now);
  const c = stageColors('needs_you');
  return <span className="shrink-0 text-xs tabular-nums" style={{ color: tone === 'calm' ? undefined : c.ink, fontWeight: tone === 'hot' ? 600 : 400 }} title="Waiting for an answer">waiting {shortAgo(row.last_time, now)}</span>;
}

function Row({ row, index, now, selected, focused, checked, selecting, onOpen, onCheck }) {
  const c = stageColors(stageOf(row.status_chip));
  return (
    <div
      data-index={index}
      onClick={e => (selecting || e.metaKey || e.ctrlKey ? onCheck(row.id, index, e.shiftKey) : onOpen(row, index))}
      className={`group relative flex cursor-pointer gap-3 border-b px-4 py-3 transition-colors ${selected ? 'bg-spark-soft' : checked ? 'bg-primary/5' : 'hover:bg-muted/50'} ${focused && !selected ? 'shadow-[inset_2px_0_0_hsl(var(--primary))]' : ''}`}
    >
      <button
        type="button"
        aria-label={checked ? `Unselect ${row.lead_name}` : `Select ${row.lead_name}`}
        onClick={e => { e.stopPropagation(); onCheck(row.id, index, e.shiftKey); }}
        className="relative mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
        style={checked ? { background: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))' } : { background: c.soft, color: c.ink }}
      >
        {checked ? <Check size={15} /> : <>
          <span className={selecting ? 'hidden' : 'group-hover:hidden'}>{initials(row.lead_name)}</span>
          <span className={`h-4 w-4 rounded border-2 ${selecting ? 'block' : 'hidden group-hover:block'}`} style={{ borderColor: c.ink }} />
        </>}
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className={`truncate text-sm ${row.unread ? 'font-semibold' : 'font-medium'}`}>{row.lead_name}</span>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{shortAgo(row.last_time, now)}</span>
        </div>
        <p className={`mt-0.5 truncate text-[13px] ${row.unread ? 'text-foreground' : 'text-muted-foreground'}`}>{row.last_direction === 'outbound' ? 'You: ' : ''}{row.last_message || 'No messages yet'}</p>
        <div className="mt-1.5 flex items-center gap-2">
          <StatusChip status={row.status_chip} />
          {row.has_pending_draft && <span className="shrink-0 text-xs font-medium text-primary">Reply ready</span>}
          <Waiting row={row} now={now} />
          {row.unread && <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-primary" aria-label="Unread" />}
        </div>
      </div>
    </div>
  );
}

export default function ConversationList({ counts, oldestWaiting, rows, selectedId, focusIndex, onOpen, checked, onCheck, onCheckAll, onClearChecks, onBulk, bulkBusy, bulkNote, search, setSearch, searchRef, filter, setFilter, sort, setSort, loading, error, refresh, hasMore, loadMore, loadingMore, syncing, syncOlder, onShortcuts, autoNext, setAutoNext }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, []);
  const sentinel = useRef(null), listRef = useRef(null);
  // Refresh spins long enough to be seen, even when the data comes back instantly.
  const [spinning, setSpinning] = useState(false);
  useEffect(() => { if (!spinning) return undefined; const t = setTimeout(() => setSpinning(false), 900); return () => clearTimeout(t); }, [spinning]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore) return undefined;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting && !loadingMore) loadMore(); }, { root: listRef.current, rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadMore, loadingMore, rows.length]);
  useEffect(() => {
    const list = listRef.current, el = list?.querySelector(`[data-index="${focusIndex}"]`);
    if (!list || !el) return;
    const top = el.offsetTop - list.offsetTop, bottom = top + el.offsetHeight;
    if (top < list.scrollTop) list.scrollTop = top; else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
  }, [focusIndex]);

  const nChecked = checked.size;
  const draftsChecked = rows.filter(r => checked.has(r.id) && r.has_pending_draft).length;
  const empty = EMPTY[filter] || ['Nothing here', 'Try another tab or search for a name or phone number.'];

  return (
    <section className="relative flex h-full min-h-0 flex-col">
      <div className="space-y-3 border-b px-4 pb-3 pt-4">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-lg font-semibold">Inbox</h1>
          <div className="flex items-center">
            <button type="button" onClick={() => setSort(sort === 'oldest' ? 'newest' : 'oldest')} className="flex h-8 items-center gap-1.5 rounded-md px-2 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground" title="Change order">
              <ArrowDownUp size={14} />{sort === 'oldest' ? 'Oldest first' : 'Newest first'}
            </button>
            <button type="button" onClick={() => { setSpinning(true); refresh(); }} aria-label="Refresh" title="Refresh" className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"><RefreshCw size={15} className={loading || spinning ? 'animate-spin' : ''} /></button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><button type="button" aria-label="Inbox options" className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"><MoreHorizontal size={16} /></button></DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuCheckboxItem checked={autoNext} onCheckedChange={v => setAutoNext(!!v)}>Open the next conversation after I reply</DropdownMenuCheckboxItem>
                <DropdownMenuSeparator />
                {rows.length > 0 && <DropdownMenuItem onSelect={onCheckAll}>Select all shown</DropdownMenuItem>}
                <DropdownMenuItem className="hidden lg:flex" onSelect={onShortcuts}>Keyboard shortcuts</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <label className="relative block">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input ref={searchRef} className="field pl-9" placeholder="Search name or phone" aria-label="Search name or phone" value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { setSearch(''); e.currentTarget.blur(); } }} />
        </label>
        <div className="no-scrollbar -mx-4 flex gap-1 overflow-x-auto px-4 lg:flex-wrap" role="tablist">
          {INBOX_TABS.map(t => {
            const n = t.count && counts ? counts[t.count] : 0;
            const on = filter === t.key;
            return (
              <button key={t.key} type="button" role="tab" aria-selected={on} onClick={() => setFilter(t.key)} className={`flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] transition-colors ${on ? 'bg-foreground font-medium text-background' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}>
                {t.label}
                {n > 0 && <span className={`tabular-nums ${on ? 'text-background/70' : t.hot ? 'font-semibold text-primary' : ''}`}>{n > 999 ? '999+' : n}</span>}
              </button>
            );
          })}
        </div>
        {filter === 'unanswered' && oldestWaiting && counts?.unanswered > 0 && <p className="text-xs text-muted-foreground">Longest wait: <span className="font-medium" style={{ color: stageColors('needs_you').ink }}>{shortAgo(oldestWaiting, now)}</span>. Use oldest first to clear them in order.</p>}
      </div>

      <div ref={listRef} className={`relative min-h-0 flex-1 overflow-y-auto ${nChecked ? 'pb-40' : ''}`}>
        {error && <div role="alert" className="flex items-center justify-between gap-3 px-4 py-3 text-sm text-destructive"><span>{error.message}</span><Button size="sm" variant="outline" onClick={() => { setSpinning(true); refresh(); }}>Try again</Button></div>}
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"><Loader2 size={16} className="animate-spin" />Loading conversations</div>
        ) : !rows.length ? (
          <EmptyState icon={MessageSquare} title={search ? 'No matches' : empty[0]} description={search ? 'Try a different name, or the last 4 digits of their phone.' : empty[1]}>
            {search ? <Button size="sm" variant="outline" onClick={() => setSearch('')}>Clear search</Button>
              : filter !== 'all' ? <Button size="sm" variant="outline" onClick={() => setFilter('all')}>See all texts</Button>
                : <Button size="sm" asChild><Link to="/contacts/import">Import leads</Link></Button>}
          </EmptyState>
        ) : rows.map((row, i) => (
          <Row key={row.id} row={row} index={i} now={now} selected={selectedId === row.id} focused={focusIndex === i} checked={checked.has(row.id)} selecting={nChecked > 0} onOpen={onOpen} onCheck={onCheck} />
        ))}
        {hasMore && <div ref={sentinel} className="flex justify-center py-4 text-sm text-muted-foreground">{loadingMore ? <Loader2 size={15} className="animate-spin" /> : <button type="button" onClick={loadMore} className="hover:text-foreground">Load more</button>}</div>}
        {!hasMore && syncOlder && <Button variant="ghost" className="w-full" loading={syncing} onClick={syncOlder}>{syncing ? 'Fetching…' : 'Fetch older conversations'}</Button>}
      </div>

      {nChecked > 0 && (
        <div className="absolute inset-x-3 bottom-3 z-10 rounded-lg bg-foreground p-2 text-background shadow-xl lr-rise">
          <div className="flex items-center justify-between gap-2 px-1.5 pb-1">
            <span className="flex items-center gap-1.5 text-[13px] font-medium" aria-live="polite">{bulkBusy && <Loader2 size={13} className="animate-spin" />}{nChecked} selected{bulkBusy ? ` · ${bulkBusy}` : ''}</span>
            <div className="flex items-center gap-1">
              {nChecked < rows.length && <button type="button" onClick={onCheckAll} className="rounded px-1.5 py-1 text-[13px] underline-offset-2 hover:underline">Select all {rows.length}</button>}
              <button type="button" aria-label="Clear selection" onClick={onClearChecks} className="rounded p-1 hover:bg-white/10"><X size={15} /></button>
            </div>
          </div>
          {bulkNote && <p className="px-1.5 pb-1.5 text-xs opacity-80">{bulkNote}</p>}
          <div className="flex flex-wrap gap-0.5">
            {draftsChecked > 0 && <ConfirmAction disabled={!!bulkBusy} confirm={`Send ${draftsChecked}? Tap again`} onConfirm={() => onBulk('approve_drafts')}>Approve {draftsChecked} {draftsChecked === 1 ? 'reply' : 'replies'}</ConfirmAction>}
            {draftsChecked > 0 && <button type="button" disabled={!!bulkBusy} onClick={() => onBulk('discard_drafts')} className="h-8 rounded-md px-2.5 text-[13px] font-medium hover:bg-white/10 disabled:opacity-50">Discard replies</button>}
            <button type="button" disabled={!!bulkBusy} onClick={() => onBulk('read')} className="h-8 rounded-md px-2.5 text-[13px] font-medium hover:bg-white/10 disabled:opacity-50">Mark read</button>
            <button type="button" disabled={!!bulkBusy} onClick={() => onBulk('unread')} className="h-8 rounded-md px-2.5 text-[13px] font-medium hover:bg-white/10 disabled:opacity-50">Mark unread</button>
            <button type="button" disabled={!!bulkBusy} onClick={() => onBulk('take_over')} className="h-8 rounded-md px-2.5 text-[13px] font-medium hover:bg-white/10 disabled:opacity-50">Take over</button>
            <button type="button" disabled={!!bulkBusy} onClick={() => onBulk('hand_back')} className="h-8 rounded-md px-2.5 text-[13px] font-medium hover:bg-white/10 disabled:opacity-50">Hand back to AI</button>
            <ConfirmAction disabled={!!bulkBusy} confirm={`Close ${nChecked}? Tap again`} onConfirm={() => onBulk('not_interested')}>Not interested</ConfirmAction>
          </div>
        </div>
      )}
    </section>
  );
}
