import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Send, Zap, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { call } from '@/components/workspace/api';
import { fillQuickReply, smsSegments } from '@/lib/inbox';
import QuickRepliesDialog from '@/components/inbox/QuickRepliesDialog';

// Drafts survive switching conversations, so an agent can bounce between threads without losing work.
const drafts = new Map();

export default function MessageComposer({ summary, lead, profile, onSent }) {
  const [text, setTextState] = useState(() => drafts.get(summary.id) || '');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [manage, setManage] = useState(false);
  const box = useRef(null);
  const setText = v => { setTextState(v); if (v) drafts.set(summary.id, v); else drafts.delete(summary.id); setRequestKey(crypto.randomUUID()); };
  const { data: quick } = useQuery({ queryKey: ['quick-replies'], queryFn: () => call('inbox', { action: 'quick_list' }), staleTime: 300000 });
  const optedOut = lead?.status === 'opted_out';
  const firstName = profile?.first_name || lead?.first_name || String(summary.lead_name || '').split(' ')[0];

  useEffect(() => { const on = () => box.current?.focus(); window.addEventListener('lr-inbox-reply', on); return () => window.removeEventListener('lr-inbox-reply', on); }, []);

  async function send(e) {
    e?.preventDefault();
    if (busy || !text.trim() || optedOut) return;
    setBusy(true); setError('');
    try {
      const sent = text;
      const result = await call('sendMessage', { summary_id: summary.id, text, request_key: requestKey });
      if (result.sent) { setText(''); onSent?.(sent); requestAnimationFrame(() => box.current?.focus()); }
      else setError(result.reason || result.message || 'The text was not sent. Try again.');
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  function insert(q) {
    const filled = fillQuickReply(q.text, { first_name: firstName, my_name: quick?.my_name });
    setText(text.trim() ? `${text.trim()} ${filled}` : filled);
    call('inbox', { action: 'quick_used', id: q.id }).catch(() => {});
    requestAnimationFrame(() => { const el = box.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } });
  }

  const segs = smsSegments(text);
  return <form onSubmit={send} className="shrink-0 border-t bg-background px-3 pb-3 pt-2.5 sm:px-4">
    {!optedOut && <div className="no-scrollbar -mx-1 mb-2 flex items-center gap-1 overflow-x-auto px-1">
      <Zap size={12} className="shrink-0 text-muted-foreground" />
      {(quick?.items || []).map(q => <button key={q.id} type="button" onClick={() => insert(q)} title={fillQuickReply(q.text, { first_name: firstName, my_name: quick?.my_name })} className="h-7 shrink-0 rounded-md border bg-background px-2.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground">{q.label}</button>)}
      <button type="button" onClick={() => setManage(true)} aria-label="Edit quick replies" className="shrink-0 rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"><Settings2 size={12} /></button>
    </div>}
    <div className="flex items-end gap-2">
      <textarea ref={box} id={`message-${summary.id}`} aria-label="Your reply" className="field max-h-40 min-h-[44px] flex-1 resize-none py-2.5" rows={text.length > 80 ? 3 : 1} maxLength={1600} value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send(e); if (e.key === 'Escape') e.currentTarget.blur(); }} placeholder={optedOut ? 'This person opted out of texts.' : 'Write a reply'} disabled={busy || optedOut} />
      <Button type="submit" size="icon" className="h-11 w-11 shrink-0" loading={busy} disabled={!text.trim() || optedOut} aria-label={busy ? 'Sending' : 'Send'}>{!busy && <Send size={16} />}</Button>
    </div>
    <div className="mt-1.5 flex items-center justify-between gap-3 text-xs text-muted-foreground">
      <span>Replying yourself pauses the AI for this lead.<span className="hidden lg:inline"> <span className="kbd">⌘ Enter</span> sends.</span></span>
      {text && <span className={`shrink-0 tabular-nums ${segs > 2 ? 'font-semibold text-foreground' : ''}`}>{text.length} chars · {segs} {segs === 1 ? 'text' : 'texts'}</span>}
    </div>
    {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
    <QuickRepliesDialog open={manage} onOpenChange={setManage} />
  </form>;
}
