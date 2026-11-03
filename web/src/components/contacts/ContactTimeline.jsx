import { useInfiniteQuery } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowUpRight, Flag, RefreshCw, CircleDot } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { Button } from '@/components/ui/button';
import { PanelSkeleton } from '@/components/system/Loaders';

const KINDS = {
  sms_sent: ['Text sent', ArrowUpRight],
  inbound_sms: ['They replied', ArrowDownLeft],
  needs_human: ['Flagged for you', Flag],
  status_changed: ['Status changed', RefreshCw],
};
const HIDDEN = ['sms_delivery'];

/** Everything that has happened with this lead, newest first. */
export default function ContactTimeline({ id }) {
  const { data, isLoading, error, hasNextPage, fetchNextPage, isFetchingNextPage, refetch, isRefetching } = useInfiniteQuery({
    queryKey: ['contact-timeline', id], initialPageParam: undefined,
    queryFn: ({ pageParam }) => base44.entities.MessageLog.filter({ lead_id: id }, { sort: '-occurred_at', limit: 30, cursor: pageParam }),
    getNextPageParam: p => (p.has_more ? p.next_cursor : undefined),
  });
  const items = (data?.pages.flatMap(p => p.items) || []).filter(m => !HIDDEN.includes(m.event_type));

  return (
    <section className="panel">
      <div className="flex h-12 items-center border-b px-4"><h2 className="section-title">Activity</h2></div>
      {isLoading ? <PanelSkeleton rows={3} className="border-0" /> : error ? <div className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm text-destructive"><span>{error.message}</span><Button size="sm" variant="outline" loading={isRefetching} onClick={() => refetch()}>Try again</Button></div> : !items.length ? (
        <p className="p-4 text-sm text-muted-foreground">Nothing yet. Texts, replies and changes show up here.</p>
      ) : (
        <ol className="divide-y">
          {items.map(m => {
            const [label, Icon] = KINDS[m.event_type] || [String(m.event_type || 'Activity').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()), CircleDot];
            return (
              <li key={m.id} className="flex gap-3 px-4 py-3">
                <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${m.direction === 'inbound' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}><Icon size={13} /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="text-sm font-medium">{label}</p>
                    <time className="shrink-0 text-xs text-muted-foreground">{new Date(m.occurred_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time>
                  </div>
                  {m.body && <p className="mt-0.5 whitespace-pre-wrap text-sm text-muted-foreground">{m.body}</p>}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {hasNextPage && <div className="border-t p-2 text-center"><Button variant="ghost" loading={isFetchingNextPage} onClick={() => fetchNextPage()}>{isFetchingNextPage ? 'Loading…' : 'Show earlier activity'}</Button></div>}
    </section>
  );
}
