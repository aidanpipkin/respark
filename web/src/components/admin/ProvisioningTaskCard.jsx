import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { call } from '@/components/workspace/api';
import { notify } from '@/lib/feedback';

const DONE = {
  start: ['Task started', 'It moved to working.'],
  attention: ['Marked as needs attention', 'The agent sees your note.'],
  a2p_status: ['Status saved', 'The agent sees the new registration status.'],
  assign_number: ['Number assigned', 'The agent can text from it once registration is approved.'],
};

export default function ProvisioningTaskCard({ task, onChanged }) {
  const [detail, setDetail] = useState(null), [phone, setPhone] = useState(''), [reference, setReference] = useState(''), [note, setNote] = useState(''), [confirmed, setConfirmed] = useState(false), [status, setStatus] = useState(''), [busy, setBusy] = useState('');

  async function action(action) {
    setBusy(action);
    try {
      const r = await call('adminProvisioning', { action, task_id: task.id, phone_number: phone, provider_reference: reference, note, confirmed, status });
      if (action === 'detail') { setDetail(r); setPhone(r.phone_number || task.requested_number || ''); setReference(r.registration?.provider_reference || ''); }
      else {
        setDetail(null); setConfirmed(false);
        const [t, d] = DONE[action] || ['Saved', ''];
        notify.ok(t, `${task.agent_email}: ${d}`);
        await onChanged();
      }
    } catch (e) { notify.err(e, action === 'detail' ? 'Task not loaded' : 'Task not updated'); }
    finally { setBusy(''); }
  }

  const r = detail?.registration;
  const choices = { queued: ['brand_submitted', 'rejected'], brand_submitted: ['campaign_submitted', 'rejected'], campaign_submitted: ['approved', 'rejected'], rejected: ['brand_submitted'] }[r?.status] || [];
  const finish = r ? 'a2p_status' : 'assign_number';

  return (
    <article className="panel space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><p className="font-semibold">{task.agent_email}</p><p className="subtext">{task.kind.replaceAll('_', ' ')} · {task.status.replaceAll('_', ' ')}</p></div>
        {detail
          ? <Button variant="ghost" disabled={!!busy} onClick={() => setDetail(null)}>Close</Button>
          : <Button variant="outline" loading={busy === 'detail'} disabled={!!busy} onClick={() => action('detail')}>Review task</Button>}
      </div>
      <p className="subtext">{task.public_note}</p>
      {detail && (
        <div className="lr-rise space-y-4 border-t pt-4">
          {r && <dl className="grid gap-3 text-sm">{Object.entries(r).filter(([k]) => !['id', 'created_by_id', 'created_date', 'updated_date'].includes(k)).map(([key, value]) => <div key={key}><dt className="font-semibold">{key.replaceAll('_', ' ')}</dt><dd className="whitespace-pre-wrap break-words text-muted-foreground">{String(value)}</dd></div>)}</dl>}
          {task.kind === 'phone_number' && <><p className="subtext">Purchase or assign this number in the provider console first. Completion verifies the number against this agent's active inventory; no beta setup fee is charged.</p><label className="block"><span className="field-label">Assigned number</span><input className="field" value={phone} onChange={e => setPhone(e.target.value)} /></label></>}
          {r && <><label className="block"><span className="field-label">Carrier reference</span><input className="field" maxLength={200} value={reference} onChange={e => setReference(e.target.value)} /></label><label className="block"><span className="field-label">Verified carrier status</span><select className="field" value={status} onChange={e => setStatus(e.target.value)}><option value="">Select status</option>{choices.map(v => <option key={v} value={v}>{v.replaceAll('_', ' ')}</option>)}</select></label></>}
          <label className="block"><span className="field-label">Agent-visible note (no provider names or credentials)</span><textarea className="field" maxLength={2000} value={note} onChange={e => setNote(e.target.value)} /></label>
          <label className="flex gap-3 text-sm"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />I verified this number or registration status with the provider.</label>
          <div className="flex flex-wrap gap-3">
            <Button variant="outline" loading={busy === 'start'} disabled={!!busy || task.status === 'done'} onClick={() => action('start')}>Start work</Button>
            <Button variant="outline" loading={busy === 'attention'} disabled={!!busy || task.status === 'done'} onClick={() => action('attention')}>Needs attention</Button>
            <Button loading={busy === finish} disabled={!!busy || !confirmed || task.status === 'done' || (!!r && !status)} onClick={() => action(finish)}>{r ? 'Save verified status' : 'Verify and assign number'}</Button>
          </div>
        </div>
      )}
    </article>
  );
}
