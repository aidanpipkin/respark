import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { call } from '@/components/workspace/api';
import { Button } from '@/components/ui/button';
import { notify } from '@/lib/feedback';

const TRACKS = { no_show: 'No-show rebook', follow_up: 'Post-call follow-up', lost_banking: 'Banking objection', lost_social: 'SSN objection', client: 'Client care' };

export default function SuggestedReply({ leadId, leadName, onDone, onChange }) {
  const [text, setText] = useState(''), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const { data, isLoading, refetch, error: loadError } = useQuery({ queryKey: ['suggested-reply', leadId], enabled: !!leadId, refetchInterval: 15000, queryFn: () => base44.entities.AIDraft.filter({ lead_id: leadId, status: 'pending' }, { sort: '-created_date', limit: 1 }) });
  const draft = data?.items[0];
  const latest = useRef(null);
  useEffect(() => { setText(draft?.proposed_text || ''); setError(''); }, [draft?.id]);

  async function review(action) {
    if (!draft || busy) return;
    setBusy(action); setError('');
    const edited = text !== draft.proposed_text, booking = draft.proposed_action === 'book_appointment', sent = text;
    try {
      await call('reviewDraft', { draft_id: draft.id, action: action === 'approve' && edited ? 'edit' : action, text });
      await refetch();
      if (action === 'approve') {
        onDone?.(booking
          ? { title: 'Call booked', detail: 'The confirmation text is on its way.' }
          : { title: edited ? 'Edited reply sent' : 'Reply sent', detail: leadName ? `${leadName} gets it in a moment.` : '' }, booking ? '' : sent);
      } else {
        notify.ok('Suggested reply discarded', 'Write your own below, or leave it for later.');
        onChange?.();
      }
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  }
  latest.current = review;
  useEffect(() => { const on = () => latest.current?.('approve'); window.addEventListener('lr-inbox-approve', on); return () => window.removeEventListener('lr-inbox-approve', on); }, []);

  if (!leadId || isLoading) return null;
  if (loadError) return <p className="p-4 text-xs text-destructive">{loadError.message}</p>;
  if (!draft) return null;
  const booking = draft.proposed_action === 'book_appointment';
  const kind = draft.source === 'sequence' ? `Follow-up ${draft.step_number || ''}` : draft.source === 'nudge' ? 'They went quiet' : draft.source === 'nurture' ? 'Long-term check-in' : draft.source === 'track' ? (TRACKS[draft.personalization?.track] || 'Pipeline follow-up') : 'Reply';
  return <section className="space-y-2 border-t bg-spark-soft px-3 py-3 sm:px-4">
    <div className="flex items-center justify-between gap-2"><h3 className="flex items-center gap-1.5 text-[13px] font-medium"><Sparkles size={14} className="text-primary" />Suggested reply<span className="font-normal text-muted-foreground">({kind.toLowerCase()})</span></h3><span className="hidden text-xs text-muted-foreground lg:block"><span className="kbd">A</span> to approve</span></div>
    {draft.source === 'sequence' && draft.personalization && <p className="text-xs text-muted-foreground">{draft.personalization.personalized ? `Written for this person${draft.personalization.angle ? ` · ${draft.personalization.angle}` : ''}` : 'Approved template'}</p>}
    {booking && <p className="text-xs">Approving checks the time, books the call and sends the confirmation.</p>}
    <textarea aria-label="Suggested reply" className="field min-h-[72px]" maxLength={300} value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); review('approve'); } }} disabled={!!busy || booking} />
    <div className="flex flex-wrap items-center justify-end gap-2">
      <span className="mr-auto text-xs text-muted-foreground tabular-nums">{text.length}/300</span>
      <Button type="button" size="sm" variant="ghost" loading={busy === 'discard'} disabled={!!busy} onClick={() => review('discard')}>{busy === 'discard' ? 'Discarding…' : 'Discard'}</Button>
      <Button type="button" size="sm" loading={busy === 'approve'} disabled={!!busy || !text.trim()} onClick={() => review('approve')}>{busy === 'approve' ? (booking ? 'Booking…' : 'Sending…') : booking ? 'Approve booking' : text !== draft.proposed_text ? 'Send edited reply' : 'Approve and send'}</Button>
    </div>
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </section>;
}
