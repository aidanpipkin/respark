import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { call } from '@/components/workspace/api';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import PolicyForm, { EMPTY_POLICY, missingPolicy } from '@/components/pipeline/PolicyForm';
import BookCallDialog from '@/components/appointments/BookCallDialog';
import { UserX, MessageCircleQuestion, Landmark, ShieldQuestion, BadgeCheck, Check } from 'lucide-react';
import { notify } from '@/lib/feedback';

export const OUTCOMES = [
  ['no_show', 'No-show', 'They missed the call', UserX],
  ['follow_up', 'Follow-up', 'Talked, still deciding', MessageCircleQuestion],
  ['lost_banking', 'Lost at banking', 'Stopped at bank details', Landmark],
  ['lost_social', 'Lost at social', 'Stopped at SSN', ShieldQuestion],
  ['closed', 'Closed', 'Application written', BadgeCheck],
];
const NOTE_HINT = {
  no_show: 'Optional: anything you know (e.g. texted they were driving).',
  follow_up: 'What did they say? What is holding them back? What do they care about most?',
  lost_banking: 'What exactly did they say about the bank details?',
  lost_social: 'What exactly did they say about their Social Security number?',
  closed: 'Optional: how the call went, what they valued, family details to remember.',
};

/** One click after the call: pick what happened. Closed requires the policy details. */
export default function OutcomeDialog({ open, onOpenChange, appointment = null, lead = null, onDone }) {
  const qc = useQueryClient();
  const [outcome, setOutcome] = useState(''), [note, setNote] = useState(''), [policy, setPolicy] = useState(EMPTY_POLICY), [policyStatus, setPolicyStatus] = useState('approved');
  const [busy, setBusy] = useState(false), [done, setDone] = useState(null), [rebook, setRebook] = useState(false);
  const name = appointment?.name || appointment?.lead_name || [lead?.first_name, lead?.last_name].filter(Boolean).join(' ') || 'this contact';
  const leadId = appointment?.lead_id || lead?.id;
  const missing = outcome === 'closed' ? missingPolicy(policy) : [];
  const needsNote = ['follow_up', 'lost_banking', 'lost_social'].includes(outcome) && !note.trim();

  function close(v) { onOpenChange(v); if (!v) { setOutcome(''); setNote(''); setPolicy(EMPTY_POLICY); setPolicyStatus('approved'); setDone(null); } }
  async function save() {
    setBusy(true);
    try {
      const r = await call('outcomes', { action: 'set', outcome, note, appointment_id: appointment?.appointment_id || appointment?.id, lead_id: leadId, policy: outcome === 'closed' ? policy : undefined, policy_status: policyStatus });
      setDone(r);
      await Promise.all(['pipeline', 'appointments', 'clients', 'contact', 'dashboard-outcomes'].map(k => qc.invalidateQueries({ queryKey: [k] })));
      onDone?.(r);
    } catch (e) { notify.err(e, 'Could not save the outcome'); } finally { setBusy(false); }
  }

  return <>
    <Dialog open={open && !rebook} onOpenChange={close}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader><DialogTitle>How did the call go?</DialogTitle><DialogDescription>With {name}. This picks the right follow-up texts automatically.</DialogDescription></DialogHeader>
        {done ? <div className="space-y-3 text-sm lr-rise">
          <p className="flex items-center gap-2 font-medium"><span className="flex h-6 w-6 items-center justify-center rounded-full bg-success text-white lr-pop"><Check size={13} strokeWidth={3} /></span>Outcome saved. Moved to {done.label}.</p>
          <p className="text-muted-foreground">{done.track === 'client' ? (policyStatus === 'approved' ? 'The congratulations text with their policy details is going out now, followed by the premium reminder and check-ins.' : 'They get a "your application is submitted" text now. Mark it approved on the Clients page when the carrier approves it.') : 'Their follow-up texts are scheduled. Any reply comes to your Inbox.'}</p>
          <div className="flex flex-wrap gap-2">{done.track !== 'client' && <Button onClick={() => setRebook(true)}>Rebook a call now</Button>}<Button variant={done.track === 'client' ? 'default' : 'outline'} onClick={() => close(false)}>Done</Button></div>
        </div> : <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">{OUTCOMES.map(([k, label, sub, Icon]) => <button key={k} type="button" onClick={() => setOutcome(k)} className={`rounded-lg border p-3 text-left transition-colors ${outcome === k ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-muted/50'}`}><Icon size={18} className={k === 'closed' ? 'text-success' : 'text-muted-foreground'} /><p className="mt-2 text-sm font-medium">{label}</p><p className="text-xs text-muted-foreground">{sub}</p></button>)}</div>
          {outcome && <>
            {outcome === 'closed' && <div className="space-y-3 rounded-lg border p-4">
              <div className="flex flex-wrap gap-2 text-sm"><span className="font-medium">Policy status:</span>
                <label className="flex items-center gap-1"><input type="radio" checked={policyStatus === 'approved'} onChange={() => setPolicyStatus('approved')} />Approved / in force</label>
                <label className="flex items-center gap-1"><input type="radio" checked={policyStatus === 'submitted'} onChange={() => setPolicyStatus('submitted')} />Submitted, waiting on approval</label></div>
              <PolicyForm value={policy} onChange={setPolicy} />
              <p className="text-xs text-muted-foreground">Required. The client's texts use these exact details, and the AI uses them to look after this client.</p>
            </div>}
            <label className="block"><span className="field-label">Call notes{needsNote ? ' *' : ''}</span><textarea className="field min-h-20" maxLength={2000} placeholder={NOTE_HINT[outcome]} value={note} onChange={e => setNote(e.target.value)} /></label>
            <Button className="w-full sm:w-auto" disabled={needsNote || missing.length > 0} loading={busy} onClick={save}>{busy ? 'Saving…' : missing.length ? `Add ${missing.slice(0, 2).join(', ')}${missing.length > 2 ? '…' : ''}` : needsNote ? 'Add a quick note' : `Save: ${OUTCOMES.find(o => o[0] === outcome)[1]}`}</Button>
          </>}
        </div>}
      </DialogContent>
    </Dialog>
    {rebook && <BookCallDialog open={rebook} onOpenChange={v => { setRebook(v); if (!v) close(false); }} lead={{ id: leadId, first_name: name }} />}
  </>;
}
