import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquare } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { call } from '@/components/workspace/api';
import ConversationList from '@/components/inbox/ConversationList';
import ConversationThread from '@/components/inbox/ConversationThread';
import ShortcutsHelp from '@/components/inbox/ShortcutsHelp';
import EmptyState from '@/components/workspace/EmptyState';
import { INBOX_TABS, tabQuery, isTyping, isDesktop } from '@/lib/inbox';
import { notify } from '@/lib/feedback';

// GHL conversation sync is slow and the same for every tab, so run it at most every two minutes.
let lastSync = { at: 0, term: null };
const readPref = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const writePref = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

export default function Inbox() {
  const { settings, user } = useOutletContext();
  const me = user?.email;
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const validTab = k => INBOX_TABS.some(t => t.key === k);
  const [filter, setFilterState] = useState(() => validTab(params.get('filter')) ? params.get('filter') : readPref('lr-inbox-tab', 'replied'));
  const [sort, setSortState] = useState(() => readPref('lr-inbox-sort', 'newest'));
  const [search, setSearch] = useState(''), [term, setTerm] = useState('');
  const [selected, setSelected] = useState(null);
  const [focusIndex, setFocusIndex] = useState(-1);
  const [checked, setChecked] = useState(() => new Set());
  const anchor = useRef(-1);
  const [bulkBusy, setBulkBusy] = useState(''), [bulkNote, setBulkNote] = useState('');
  const [autoNext, setAutoNextState] = useState(() => readPref('lr-inbox-autonext', true));
  const [help, setHelp] = useState(false);
  const [cursor, setCursor] = useState(null), [syncing, setSyncing] = useState(false), [syncError, setSyncError] = useState(null);
  const searchRef = useRef(null);

  const setFilter = k => { setFilterState(k); writePref('lr-inbox-tab', k); setChecked(new Set()); setFocusIndex(-1); setBulkNote(''); if (params.get('filter')) { params.delete('filter'); setParams(params, { replace: true }); } };
  const setSort = v => { setSortState(v); writePref('lr-inbox-sort', v); };
  const setAutoNext = v => { setAutoNextState(v); writePref('lr-inbox-autonext', v); };

  useEffect(() => { const t = setTimeout(() => setTerm(search.trim()), 300); return () => clearTimeout(t); }, [search]);

  const { data, isLoading, error, hasNextPage, fetchNextPage, isFetchingNextPage, refetch } = useInfiniteQuery({
    queryKey: ['conversations', me, filter, term, sort],
    initialPageParam: undefined,
    queryFn: async ({ pageParam }) => {
      if (!pageParam && settings.connected && (Date.now() - lastSync.at > 120000 || lastSync.term !== term)) {
        lastSync = { at: Date.now(), term };
        call('syncInbox', { query: term }).then(r => { setCursor(r.next_cursor); if (r.synced) qc.invalidateQueries({ queryKey: ['conversations'] }); }).catch(() => {});
      }
      // Always your own conversations, even when you are also an administrator.
      const query = { agent_email: me, ...tabQuery(filter) };
      if (term) {
        const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); const digits = term.replace(/\D/g, '');
        query.$or = [{ lead_name: { $regex: esc, $options: 'i' } }, ...(digits.length >= 3 ? [{ phone: { $regex: digits } }] : [])];
      }
      return base44.entities.ConversationSummary.filter(query, { sort: sort === 'oldest' ? 'last_time' : '-last_time', limit: 50, cursor: pageParam });
    },
    getNextPageParam: p => p.has_more ? p.next_cursor : undefined,
    enabled: !!settings && !!me, retry: 1, refetchInterval: 20000, placeholderData: prev => prev,
  });
  const rows = useMemo(() => {
    const seen = new Set(); const out = [];
    for (const r of data?.pages.flatMap(p => p.items) || []) if (!seen.has(r.id)) { seen.add(r.id); out.push(r); }
    return out;
  }, [data]);

  const { data: countData, refetch: refetchCounts } = useQuery({ queryKey: ['inbox-counts'], queryFn: () => call('inbox', { action: 'counts' }), refetchInterval: 30000, staleTime: 10000 });
  const refreshAll = useCallback(() => { qc.invalidateQueries({ queryKey: ['conversations'] }); qc.invalidateQueries({ queryKey: ['inbox-counts'] }); qc.invalidateQueries({ queryKey: ['dashboard'] }); }, [qc]);

  // Keep the open conversation's row fresh (status, draft) as the list refreshes.
  useEffect(() => { if (!selected) return; const fresh = rows.find(r => r.id === selected.id); if (fresh && fresh !== selected && fresh.updated_date !== selected.updated_date) setSelected(fresh); }, [rows]);  
  useEffect(() => { if (selected) { const t = setTimeout(() => refetchCounts(), 1200); return () => clearTimeout(t); } }, [selected?.id, refetchCounts]);  

  // Deep link: /inbox?lead=<id>
  useEffect(() => { const id = params.get('lead'); if (!id) return; let active = true; base44.entities.ConversationSummary.filter({ agent_email: me, lead_id: id }, { limit: 1 }).then(p => { if (active && p.items[0]) setSelected(p.items[0]); }); return () => { active = false; }; }, [params]);

  const open = useCallback((row, i) => { setSelected(row); setFocusIndex(i ?? rows.findIndex(r => r.id === row.id)); }, [rows]);
  const step = useCallback((dir, openIt = isDesktop()) => {
    if (!rows.length) return;
    const base = focusIndex >= 0 ? focusIndex : (selected ? rows.findIndex(r => r.id === selected.id) : -1);
    const i = Math.max(0, Math.min(rows.length - 1, base + dir));
    setFocusIndex(i); if (openIt) setSelected(rows[i]);
  }, [rows, focusIndex, selected]);

  // After handling a conversation, move straight to the next one (desktop) so triage never stalls.
  // `done` ({ title, detail }) is the confirmation to show; when we moved on, it offers a way back.
  const handled = useCallback(done => {
    refreshAll();
    const i = selected ? rows.findIndex(r => r.id === selected.id) : -1;
    const next = autoNext && isDesktop() && selected ? (rows[i + 1] || (i > 0 ? rows[i - 1] : null)) : null;
    if (next) { setSelected(next); setFocusIndex(i + 1 < rows.length ? i + 1 : i - 1); }
    if (done?.title) {
      const prev = selected;
      notify.ok(done.title, next ? `${done.detail ? `${done.detail} ` : ''}Opened ${next.lead_name || 'the next conversation'}.` : done.detail || '', next && prev ? { label: 'Go back', onClick: () => setSelected(prev) } : null);
    }
  }, [refreshAll, autoNext, selected, rows]);

  const onCheck = useCallback((id, i, shift) => {
    const from = anchor.current;
    setChecked(prev => {
      const next = new Set(prev);
      if (shift && from >= 0 && from !== i) { const [a, b] = [Math.min(from, i), Math.max(from, i)]; for (let k = a; k <= b; k++) if (rows[k]) next.add(rows[k].id); }
      else if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    anchor.current = i;
  }, [rows]);

  async function bulk(op, ids = [...checked]) {
    if (!ids.length) return;
    setBulkNote('');
    const labels = { approve_drafts: 'Sending', discard_drafts: 'Discarding', read: 'Marking read', unread: 'Marking unread', take_over: 'Taking over', hand_back: 'Handing back', not_interested: 'Closing' };
    // Past-tense confirmations: [one item, many items].
    const doneLabels = {
      approve_drafts: ['Reply sent', n => `${n} replies sent`], discard_drafts: ['Suggested reply discarded', n => `${n} suggested replies discarded`],
      read: ['Marked read', n => `${n} conversations marked read`], unread: ['Marked unread', n => `${n} conversations marked unread`],
      take_over: ['You took over', n => `You took over ${n} conversations`], hand_back: ['Handed back to the AI', n => `${n} conversations handed back to the AI`],
      not_interested: ['Marked not interested', n => `${n} leads marked not interested`],
    };
    setBulkBusy(`${labels[op] || 'Working'}…`);
    let done = 0, skipped = 0; const reasons = {};
    try {
      for (let round = 0; round < 12; round++) {
        const r = await call('inbox', { action: 'bulk', op, ids });
        done += r.done || 0;
        if (!r.remaining || !r.done) { skipped += r.skipped || 0; Object.entries(r.reasons || {}).forEach(([k, v]) => { reasons[k] = (reasons[k] || 0) + v; }); break; }
        setBulkBusy(`${labels[op]}… ${done} done`);
      }
      const why = Object.entries(reasons).map(([k, v]) => `${v} ${k}`).join(' · ');
      const msg = `${done} done${skipped ? ` · ${skipped} skipped${why ? ` (${why})` : ''}` : ''}`;
      if (skipped) setBulkNote(msg); else { setChecked(new Set()); setBulkNote(''); }
      setBulkBusy('');
      refreshAll();
      const [one, many] = doneLabels[op] || ['Done', n => `${n} updated`];
      const skippedText = skipped ? `${skipped} skipped${why ? ` (${why})` : ''}. They are still selected.` : '';
      if (done) notify.ok(ids.length === 1 && done === 1 ? one : many(done), skippedText);
      else notify.info('Nothing changed', skippedText || 'None of these could be updated.');
      return msg;
    } catch (e) { setBulkBusy(''); setBulkNote(''); notify.err(e, 'Could not finish that'); }
  }

  // Keyboard triage.
  useEffect(() => {
    function onKey(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e)) return;
      const k = e.key;
      if (k === 'j' || k === 'ArrowDown') { e.preventDefault(); step(1); }
      else if (k === 'k' || k === 'ArrowUp') { e.preventDefault(); step(-1); }
      else if ((k === 'Enter' || k === 'o') && focusIndex >= 0 && rows[focusIndex]) { e.preventDefault(); open(rows[focusIndex], focusIndex); }
      else if (k === 'x' && focusIndex >= 0 && rows[focusIndex]) { e.preventDefault(); onCheck(rows[focusIndex].id, focusIndex, e.shiftKey); }
      else if (k === 'e' && selected) { e.preventDefault(); bulk('read', [selected.id]); handled(); }
      else if (k === 'u' && selected) { e.preventDefault(); bulk('unread', [selected.id]); }
      else if (k === 'r' && selected) { e.preventDefault(); window.dispatchEvent(new Event('lr-inbox-reply')); }
      else if (k === 'a' && selected) { e.preventDefault(); window.dispatchEvent(new Event('lr-inbox-approve')); }
      else if (k === '/') { e.preventDefault(); searchRef.current?.focus(); }
      else if (k === '?') { e.preventDefault(); setHelp(true); }
      else if (k === 'Escape') { if (checked.size) setChecked(new Set()); else if (selected) setSelected(null); }
      else if (/^[1-7]$/.test(k)) { const t = INBOX_TABS[Number(k) - 1]; if (t) setFilter(t.key); }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // re-bind each render so handlers see fresh state

  async function older() { setSyncing(true); setSyncError(null); try { const result = await call('syncInbox', { cursor, query: term }); await qc.invalidateQueries({ queryKey: ['conversations'] }); setCursor(result.next_cursor); notify.ok('Older conversations loaded', result.next_cursor ? 'Scroll down for more.' : 'That is everything.'); } catch (e) { notify.err(e, 'Could not fetch older conversations'); } finally { setSyncing(false); } }

  return <div className="flex h-[calc(100dvh-112px-env(safe-area-inset-bottom))] overflow-hidden bg-background lg:h-dvh">
      <div className={`w-full shrink-0 border-r lg:w-[380px] ${selected ? 'hidden lg:block' : 'block'}`}>
        <ConversationList counts={countData?.counts} oldestWaiting={countData?.oldest_waiting} rows={rows} selectedId={selected?.id} focusIndex={focusIndex} onOpen={open} checked={checked} onCheck={onCheck} onCheckAll={() => setChecked(new Set(rows.map(r => r.id)))} onClearChecks={() => { setChecked(new Set()); setBulkNote(''); }} onBulk={op => bulk(op)} bulkBusy={bulkBusy} bulkNote={bulkNote} search={search} setSearch={setSearch} searchRef={searchRef} filter={filter} setFilter={setFilter} sort={sort} setSort={setSort} loading={isLoading} error={error || syncError} connected={settings.connected} refresh={() => { lastSync.at = 0; refetch(); refetchCounts(); }} hasMore={hasNextPage} loadMore={fetchNextPage} loadingMore={isFetchingNextPage} syncing={syncing} syncOlder={cursor ? older : null} onShortcuts={() => setHelp(true)} autoNext={autoNext} setAutoNext={setAutoNext} />
      </div>
      <div className={`min-w-0 flex-1 ${selected ? 'block' : 'hidden lg:flex lg:items-center lg:justify-center'}`}>
        {selected ? <ConversationThread key={selected.id} summary={selected} onBack={() => setSelected(null)} onHandled={handled} onChanged={refreshAll} onMarkUnread={() => { bulk('unread', [selected.id]); setSelected(null); }} onNext={() => step(1, true)} />
          : <EmptyState icon={MessageSquare} title="Pick a conversation" description="J and K move through the list. R replies, A approves a suggested reply. Press ? for all shortcuts." />}
      </div>
    <ShortcutsHelp open={help} onOpenChange={setHelp} />
  </div>;
}
