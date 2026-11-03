import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { call } from '@/components/workspace/api';
import { useAction } from '@/lib/feedback';

const EVENT = 'lr-open-help';
/** Opens the help dialog from anywhere (sidebar, mobile menu, error states). */
export const openHelp = () => window.dispatchEvent(new Event(EVENT));

/** Help requests go to the LeadRespark team with the agent's setup and open issues attached. */
export default function HelpDialog() {
  const { pathname } = useLocation();
  const { run, busy } = useAction();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');

  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(EVENT, show);
    return () => window.removeEventListener(EVENT, show);
  }, []);

  const { data } = useQuery({ queryKey: ['my-help'], queryFn: () => call('support', { action: 'mine' }), enabled: open, staleTime: 30000 });
  const past = (data?.items || []).slice(0, 3);

  async function send(e) {
    e.preventDefault();
    const ok = await run('send', async () => { await call('support', { action: 'create', message: text, page: pathname }); return true; }, {
      ok: 'Sent',
      detail: "We'll reply here and by email.",
      next: { label: 'See requests', onClick: openHelp },
      invalidate: [['my-help']],
      errTitle: 'Your message was not sent',
    });
    if (ok) { setText(''); setOpen(false); }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Get help</DialogTitle>
          <DialogDescription>Tell us what's going on. Your account setup and any open issues are attached automatically, and we reply here and by email.</DialogDescription>
        </DialogHeader>
        <form onSubmit={send} className="space-y-3">
            <textarea className="field min-h-32" autoFocus maxLength={4000} placeholder="For example: my leads uploaded but nobody is being texted yet." value={text} onChange={e => setText(e.target.value)} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" loading={busy === 'send'} disabled={text.trim().length < 3}>{busy === 'send' ? 'Sending' : 'Send'}</Button>
            </div>
          </form>
        {past.length > 0 && (
          <div className="border-t pt-4">
            <p className="mb-2 text-sm font-medium">Your recent requests</p>
            <ul className="space-y-2">
              {past.map(r => (
                <li key={r.id} className="rounded-md bg-muted px-3 py-2 text-sm">
                  <p className="line-clamp-2">{r.message}</p>
                  {r.replies?.length
                    ? <p className="mt-1.5 line-clamp-3 border-l-2 border-primary pl-2 text-muted-foreground">{r.replies[r.replies.length - 1].body}</p>
                    : <p className="mt-1 text-xs text-muted-foreground">Waiting for a reply</p>}
                </li>
              ))}
            </ul>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
