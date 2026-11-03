import { prettyPhone, isTestPhone } from '@/lib/phone';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ArrowLeft, Info, MessageSquare, Loader2, MailOpen, ChevronDown, ExternalLink } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { call } from '@/components/workspace/api';
import EmptyState from '@/components/workspace/EmptyState';
import StatusChip from '@/components/workspace/StatusChip';
import LeadProfile from '@/components/inbox/LeadProfile';
import TakeoverControls from '@/components/inbox/TakeoverControls';
import MessageComposer from '@/components/inbox/MessageComposer';
import SuggestedReply from '@/components/inbox/SuggestedReply';
import SimulateReply from '@/components/inbox/SimulateReply';
import TestLeadBadge from '@/components/contacts/TestLeadBadge';
import CallButton from '@/components/calls/CallButton';
import CallBubble from '@/components/calls/CallBubble';

function dayLabel(d) {
  const day = new Date(d); const today = new Date(); const y = new Date(); y.setDate(today.getDate() - 1);
  if (day.toDateString() === today.toDateString()) return 'Today';
  if (day.toDateString() === y.toDateString()) return 'Yesterday';
  return day.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

export default function ConversationThread({ summary, onBack, onHandled, onChanged, onMarkUnread, onNext }) {
  const [profileOpen, setProfileOpen] = useState(false);
  const [pending, setPending] = useState([]);
  const scroller = useRef(null), stick = useRef(true), lastCount = useRef(0);
  const { data, isLoading, error, hasNextPage, fetchNextPage, isFetchingNextPage, refetch } = useInfiniteQuery({ queryKey: ['thread', summary.id], initialPageParam: undefined, queryFn: ({ pageParam }) => call('getThread', { summary_id: summary.id, cursor: pageParam }), getNextPageParam: p => p.next_cursor || undefined, refetchInterval: 15000 });
  const latest = data?.pages[0];
  const server = [...(data?.pages.flatMap(p => p.messages) || [])].sort((a, b) => new Date(a.dateAdded) - new Date(b.dateAdded));
  // Texts you just sent show right away, until the real message arrives (or a minute and a half passes).
  const shown = pending.filter(l => Date.now() - Date.parse(l.dateAdded) < 90000 && !server.some(m => m.direction === 'outbound' && (m.body || '').trim() === l.body.trim() && Date.parse(m.dateAdded) >= Date.parse(l.dateAdded) - 120000));
  const messages = [...server, ...shown];

  // Stay pinned to the newest message unless the agent scrolled up to read history.
  useLayoutEffect(() => {
    const el = scroller.current; if (!el) return;
    if (messages.length !== lastCount.current) { if (stick.current || lastCount.current === 0) el.scrollTop = el.scrollHeight; lastCount.current = messages.length; }
  });
  useEffect(() => { const el = scroller.current; if (!el) return; const on = () => { stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120; }; el.addEventListener('scroll', on, { passive: true }); return () => el.removeEventListener('scroll', on); }, []);

  const changed = () => { refetch(); onChanged?.(); };
  const showSent = text => { if (text) setPending(p => [...p, { id: `local-${Date.now()}`, body: text, direction: 'outbound', dateAdded: new Date().toISOString(), local: true }]); };
  const handled = (done, text) => { stick.current = true; showSent(text); refetch(); onHandled?.(done); };
  const firstName = String(summary.lead_name || '').split(' ')[0];
  const lead = latest?.lead;
  let lastDay = '';

  return <div className="flex h-full min-h-0">
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b px-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <button className="-ml-1 p-2 lg:hidden" aria-label="Back to conversations" onClick={onBack}><ArrowLeft size={20} /></button>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2"><h2 className="truncate text-[15px] font-semibold">{summary.lead_name}</h2><StatusChip status={lead?.status || summary.status_chip} /><TestLeadBadge phone={summary.phone || lead?.phone} /></div>
            <p className="truncate text-xs text-muted-foreground">{[prettyPhone(summary.phone || latest?.profile?.phone), latest?.from_number ? `via ${prettyPhone(latest.from_number)}` : (summary.campaign_name && summary.campaign_name !== 'Not enrolled' ? summary.campaign_name : '')].filter(Boolean).join(' · ')}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center">
          {summary.lead_id && <CallButton leadId={summary.lead_id} variant="ghost" size="sm" className="h-9 px-2.5 text-muted-foreground hover:text-foreground" label="Call" />}
          {summary.lead_id && <Link to={`/contacts/${summary.lead_id}`} className="hidden p-2.5 text-muted-foreground hover:text-foreground sm:block" title="Open lead"><ExternalLink size={16} /></Link>}
          <button className="p-2.5 text-muted-foreground hover:text-foreground" title="Mark unread (U)" aria-label="Mark unread" onClick={onMarkUnread}><MailOpen size={16} /></button>
          <button className="hidden p-2.5 text-muted-foreground hover:text-foreground lg:block" title="Next conversation (J)" aria-label="Next conversation" onClick={onNext}><ChevronDown size={18} /></button>
          <button className="p-2.5 text-muted-foreground hover:text-foreground 2xl:hidden" aria-label="Open contact profile" onClick={() => setProfileOpen(true)}><Info size={17} /></button>
        </div>
      </div>
      <TakeoverControls summary={summary} lead={lead} onChange={changed} />
      <div ref={scroller} className="min-h-0 flex-1 space-y-1.5 overflow-y-auto bg-background px-3 py-4 sm:px-6">
        {isLoading ? <div className="flex justify-center gap-2 py-12 text-xs text-muted-foreground"><Loader2 size={16} className="animate-spin" />Loading messages…</div>
          : error ? <div className="space-y-2 py-8 text-center"><p role="alert" className="text-xs text-destructive">{error.message}</p><Button size="sm" variant="outline" onClick={() => refetch()}>Try again</Button></div>
            : <>
              {hasNextPage && <Button variant="ghost" className="w-full text-xs" loading={isFetchingNextPage} onClick={() => { stick.current = false; fetchNextPage(); }}>{isFetchingNextPage ? 'Loading…' : 'Load earlier messages'}</Button>}
              {!messages.length && <EmptyState icon={MessageSquare} title="No messages yet" description="Your messages will appear here." />}
              {messages.map(m => {
                const d = dayLabel(m.dateAdded); const sep = d !== lastDay; lastDay = d; const out = m.direction === 'outbound'; const failed = /fail|undeliver/i.test(m.status || '');
                const sepEl = sep && <div className="my-4 flex items-center gap-3 text-xs text-muted-foreground"><span className="h-px flex-1 bg-border" />{d}<span className="h-px flex-1 bg-border" /></div>;
                if (m.type === 'Call') return <div key={m.id}>{sepEl}<CallBubble m={m} /></div>;
                return <div key={m.id}>
                  {sepEl}
                  <div className={`w-fit max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed sm:max-w-[70%] ${out ? 'ml-auto rounded-br-md bg-primary text-primary-foreground' : 'rounded-bl-md bg-muted'} ${m.local ? 'lr-rise' : ''}`}>
                    <p className="whitespace-pre-wrap break-words">{m.body || '(Non-text message)'}</p>
                    <p className={`mt-0.5 text-right text-[11px] ${failed ? 'font-medium text-destructive' : 'opacity-60'}`}>{failed ? 'Not delivered · ' : m.local ? 'Sending · ' : ''}{new Date(m.dateAdded).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</p>
                  </div>
                </div>;
              })}
            </>}
      </div>
      <SuggestedReply key={summary.lead_id} leadId={summary.lead_id} leadName={firstName} onDone={handled} onChange={changed} />
      {isTestPhone(summary.phone || lead?.phone) && summary.lead_id && <SimulateReply leadId={summary.lead_id} leadName={firstName} onDone={() => { stick.current = true; changed(); }} />}
      <MessageComposer key={summary.id} summary={summary} lead={lead} profile={latest?.profile} onSent={text => handled({ title: 'Reply sent', detail: firstName ? `${firstName} gets it in a moment.` : '' }, text)} />
    </div>
    <aside className="hidden w-64 shrink-0 overflow-auto border-l p-5 2xl:block"><LeadProfile data={latest} /></aside>
    <Sheet open={profileOpen} onOpenChange={setProfileOpen}><SheetContent className="w-[90vw] overflow-auto sm:max-w-md"><SheetHeader><SheetTitle>Contact details</SheetTitle><SheetDescription>Profile and contact preferences.</SheetDescription></SheetHeader><div className="mt-6"><LeadProfile data={latest} /></div></SheetContent></Sheet>
  </div>;
}
