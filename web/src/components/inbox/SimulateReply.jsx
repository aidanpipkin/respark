import { useState } from 'react';
import { FlaskConical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { call } from '@/components/workspace/api';
import { notify } from '@/lib/feedback';

/** Why the AI did not answer, in plain words (the simulator returns replyToInbound's result as-is). */
function explain(reply) {
  if (!reply) return 'No AI reply was attempted.';
  if (reply.sent) return '';
  if (reply.drafted) return 'The AI drafted a reply for you to approve (review mode).';
  if (reply.stopped) return 'They opted out, so the AI stays silent.';
  if (reply.needs_human) return 'The AI handed this one to you.';
  if (reply.held) return `Held: ${typeof reply.held === 'string' ? reply.held : 'the AI wants your judgment'}.`;
  if (reply.skipped) return `Skipped: ${reply.skipped}.`;
  if (reply.error) return `The AI reply failed: ${reply.error}`;
  return 'No reply was sent.';
}

/** Test-lead only: type what the fictional lead would text back and run it through the real inbound path. */
export default function SimulateReply({ leadId, leadName, onDone }) {
  const [text, setText] = useState(''), [busy, setBusy] = useState(false);
  async function send(e) {
    e?.preventDefault();
    if (busy || !text.trim()) return;
    setBusy(true);
    try {
      const r = await call('simulateInbound', { lead_id: leadId, body: text.trim() });
      setText('');
      const secs = Math.max(1, Math.round((r.ms || 0) / 1000));
      if (r.reply?.sent) notify.ok('Reply simulated', `AI answered in ${secs}s.`);
      else notify.info('Reply simulated', explain(r.reply));
      onDone?.();
    } catch (err) { notify.err(err); } finally { setBusy(false); }
  }
  return <form onSubmit={send} className="shrink-0 border-t border-dashed border-amber-400/60 bg-amber-50/40 px-3 py-2 dark:bg-amber-950/20 sm:px-4">
    <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-amber-900 dark:text-amber-200"><FlaskConical size={12} />Simulate a reply from {leadName || 'this lead'}</div>
    <div className="flex items-end gap-2">
      <input aria-label="What the test lead texts back" className="field h-9 flex-1 py-1.5 text-sm" maxLength={600} value={text} onChange={e => setText(e.target.value)} placeholder="e.g. Sure, what times do you have?" disabled={busy} />
      <Button type="submit" size="sm" variant="outline" className="h-9 shrink-0" loading={busy} disabled={!text.trim()}>Send as lead</Button>
    </div>
    <p className="mt-1 text-[11px] text-muted-foreground">Runs the real inbound path (STOP, status, alerts, AI reply). Nothing is texted for real.</p>
  </form>;
}
