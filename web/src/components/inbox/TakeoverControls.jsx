import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { call } from '@/components/workspace/api';
import { notify } from '@/lib/feedback';

/** Who's handling this conversation (the AI or the agent), and the switch between them. */
export default function TakeoverControls({ summary, lead, onChange }) {
  const [busy, setBusy] = useState('');
  const [flash, setFlash] = useState(false);
  useEffect(() => { if (!flash) return undefined; const t = setTimeout(() => setFlash(false), 1300); return () => clearTimeout(t); }, [flash]);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [ai, setAi] = useState(true);
  const [sequence, setSequence] = useState(false);
  const yours = lead?.status === 'needs_human';
  const optedOut = lead?.status === 'opted_out';

  async function act(action) {
    setBusy(action); setError('');
    try {
      await call('conversationControl', { summary_id: summary.id, action, resume_ai: ai, resume_sequence: sequence });
      setOpen(false);
      onChange();
      setFlash(true);
      if (action === 'take_over') {
        notify.ok('You took over', 'The AI is paused for this lead. Write your reply below.');
        window.dispatchEvent(new Event('lr-inbox-reply'));
      } else {
        notify.ok('Handed back to the AI', ai && sequence ? 'AI replies and follow-up texts are back on.' : ai ? 'The AI answers when they text back.' : 'Follow-up texts start again.');
      }
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  }

  const state = optedOut ? 'Opted out. No more texts will be sent.' : yours ? "You're handling this one. The AI is paused." : lead?.ai_paused ? 'AI replies are paused.' : 'The AI is handling this conversation.';

  return (
    <>
      <div className={`flex min-h-11 items-center justify-between gap-3 border-b bg-canvas px-4 py-1.5 ${flash ? 'lr-done' : ''}`}>
        <p className="text-[13px] text-muted-foreground">{state}</p>
        {lead && !optedOut && (yours || lead.ai_paused
          ? <Button size="sm" variant="outline" disabled={!!busy} onClick={() => setOpen(true)}>Hand back to AI</Button>
          : <Button size="sm" variant="outline" loading={busy === 'take_over'} onClick={() => act('take_over')}>{busy === 'take_over' ? 'Pausing the AI…' : 'Take over'}</Button>)}
      </div>
      {error && !open && <p role="alert" className="border-b px-4 py-2 text-sm text-destructive">{error}</p>}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Hand back to the AI</DialogTitle>
            <DialogDescription>Choose what can start again. Opt-outs, licensed states and sending hours are still checked before every text.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm">
              <input type="checkbox" className="mt-0.5" checked={ai} onChange={e => setAi(e.target.checked)} />
              <span><span className="font-medium">AI replies</span><span className="block text-muted-foreground">The AI answers when they text back.</span></span>
            </label>
            <label className={`flex items-start gap-3 rounded-md border p-3 text-sm ${lead?.last_inbound_at ? 'opacity-60' : 'cursor-pointer'}`}>
              <input type="checkbox" className="mt-0.5" checked={sequence} disabled={!!lead?.last_inbound_at} onChange={e => setSequence(e.target.checked)} />
              <span><span className="font-medium">Follow-up texts</span><span className="block text-muted-foreground">{lead?.last_inbound_at ? 'Not available after they have replied.' : 'Continue the campaign’s scheduled texts.'}</span></span>
            </label>
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button loading={busy === 'resume'} disabled={!ai && !sequence} onClick={() => act('resume')}>{busy === 'resume' ? 'Handing back…' : 'Hand back'}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
