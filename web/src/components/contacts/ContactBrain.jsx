import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Phone, Trash2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PanelSkeleton } from '@/components/system/Loaders';
import { call } from '@/components/workspace/api';
import { notify } from '@/lib/feedback';

const FACTS = [
  ['product_interest', 'Product they asked about'], ['reason_in_their_words', 'Why they wanted coverage'], ['who_to_protect', 'Who they want to protect'],
  ['dependents', 'Kids or dependents'], ['occupation', 'Occupation'], ['date_of_birth', 'Date of birth'], ['age', 'Age'],
  ['coverage_requested', 'Coverage they asked about'], ['prior_outcome', 'What happened last time'], ['prior_notes', 'Notes from your old CRM'],
];

function useBrain(leadId) {
  const qc = useQueryClient();
  const key = ['contact-brain', leadId];
  const q = useQuery({ queryKey: key, queryFn: () => call('contactNotes', { action: 'list', lead_id: leadId }) });
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  // Returns the updated notes and facts, or null on failure. `inline: false` reports errors as a toast instead.
  async function run(body, { ok, detail, inline = true, busyKey = body.action } = {}) {
    setBusy(busyKey); setErr('');
    try {
      const next = await call('contactNotes', { lead_id: leadId, ...body });
      qc.setQueryData(key, next);
      if (ok) notify.ok(ok, detail || '');
      return next || {};
    } catch (e) { if (inline) setErr(e.message); else notify.err(e); return null; } finally { setBusy(''); }
  }
  return { ...q, run, busy, err };
}

/** Briefly highlights whatever just changed. */
function useFlash() {
  const [on, setOn] = useState(null);
  useEffect(() => { if (on === null) return undefined; const t = setTimeout(() => setOn(null), 1300); return () => clearTimeout(t); }, [on]);
  return [on, setOn];
}

/** What the AI knows about this person. Editable, used to personalize texts. */
export function ContactFacts({ leadId }) {
  const { data, isLoading, error, run, busy, err } = useBrain(leadId);
  const [editing, setEditing] = useState(false);
  const [facts, setFacts] = useState({});
  const [flash, setFlash] = useFlash();
  if (isLoading) return <PanelSkeleton rows={3} />;
  if (error) return <section className="panel p-5 text-sm text-destructive">{error.message}</section>;
  const known = FACTS.filter(([k]) => data.facts[k]);
  const extra = Object.entries(data.facts.extra || {});
  const startEdit = () => { setFacts(Object.fromEntries(FACTS.map(([k]) => [k, data.facts[k] || '']))); setEditing(true); };
  const save = async e => { e.preventDefault(); if (await run({ action: 'save_facts', facts }, { ok: 'Details saved', detail: 'The AI uses them to make texts more personal.' })) { setEditing(false); setFlash(true); } };

  return (
    <section className="panel">
      <div className="flex h-12 items-center justify-between border-b px-4">
        <h2 className="section-title">What the AI knows</h2>
        {!editing && <Button size="sm" variant="ghost" onClick={startEdit}>Edit</Button>}
      </div>
      {editing ? (
        <form onSubmit={save} className="space-y-3 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {FACTS.map(([k, label]) => (
              <label key={k} className={`block ${k === 'prior_notes' || k === 'reason_in_their_words' ? 'sm:col-span-2' : ''}`}>
                <span className="field-label">{label}</span>
                {k === 'prior_notes' || k === 'reason_in_their_words'
                  ? <textarea className="field min-h-20" maxLength={1500} value={facts[k]} onChange={e => setFacts({ ...facts, [k]: e.target.value })} />
                  : <input className="field" type={k === 'date_of_birth' ? 'date' : 'text'} maxLength={200} value={facts[k]} onChange={e => setFacts({ ...facts, [k]: e.target.value })} />}
              </label>
            ))}
          </div>
          {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button><Button type="submit" loading={busy === 'save_facts'}>{busy === 'save_facts' ? 'Saving…' : 'Save'}</Button></div>
        </form>
      ) : (
        <div className={`p-4 ${flash ? 'lr-done' : ''}`}>
          {!known.length && !extra.length
            ? <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted-foreground">Nothing beyond name and state yet. Add what you know so texts can be personal.</p><Button size="sm" variant="outline" onClick={startEdit}>Add details</Button></div>
            : <dl className="divide-y">
              {known.map(([k, label]) => <div key={k} className="grid gap-1 py-2 text-sm sm:grid-cols-[12rem_1fr] sm:gap-4"><dt className="text-muted-foreground">{label}</dt><dd className="whitespace-pre-wrap">{data.facts[k]}</dd></div>)}
              {extra.map(([k, v]) => <div key={k} className="grid gap-1 py-2 text-sm sm:grid-cols-[12rem_1fr] sm:gap-4"><dt className="text-muted-foreground">{k.replace(/_/g, ' ')}</dt><dd>{String(v)}</dd></div>)}
            </dl>}
          <p className="mt-3 text-xs text-muted-foreground">Health details are never used in texts.</p>
        </div>
      )}
    </section>
  );
}

/** Private notes. The AI reads them for context but never quotes them. */
export function ContactNotes({ leadId }) {
  const { data, isLoading, error, run, busy, err } = useBrain(leadId);
  const [note, setNote] = useState('');
  const [kind, setKind] = useState('note');
  const [flash, setFlash] = useFlash();
  const add = async e => {
    e.preventDefault();
    const before = new Set((data?.notes || []).map(n => n.id));
    const next = await run({ action: 'add', body: note, kind }, { ok: kind === 'call' ? 'Call notes added' : 'Note added', detail: 'The AI reads it for context but never quotes it.' });
    if (next) { setNote(''); setFlash(next.notes?.find(n => !before.has(n.id))?.id ?? null); }
  };
  if (isLoading) return <PanelSkeleton rows={2} />;
  if (error) return <section className="panel p-5 text-sm text-destructive">{error.message}</section>;

  return (
    <section className="panel">
      <div className="flex h-12 items-center border-b px-4"><h2 className="section-title">Notes</h2></div>
      <form onSubmit={add} className="space-y-2 p-4">
        <textarea className="field min-h-20" maxLength={2000} placeholder="Prefers evenings. Wife just had a baby. Wants to revisit after open enrollment." value={note} onChange={e => setNote(e.target.value)} />
        <div className="flex items-center justify-between gap-3">
          <div className="flex rounded-md border p-0.5 text-[13px]" role="radiogroup" aria-label="Note type">
            {[['note', 'Note'], ['call', 'Call notes']].map(([v, l]) => <button key={v} type="button" role="radio" aria-checked={kind === v} onClick={() => setKind(v)} className={`h-7 rounded px-2.5 ${kind === v ? 'bg-muted font-medium' : 'text-muted-foreground'}`}>{l}</button>)}
          </div>
          <Button type="submit" size="sm" loading={busy === 'add'} disabled={!!busy || !note.trim()}>{busy === 'add' ? 'Saving…' : 'Add note'}</Button>
        </div>
        {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
      </form>
      {data.notes.length > 0 && (
        <ul className="divide-y border-t">
          {data.notes.map(n => (
            <li key={n.id} className={`group flex gap-3 px-4 py-3 ${flash === n.id ? 'lr-done lr-rise' : ''}`}>
              <div className="min-w-0 flex-1">
                <p className="whitespace-pre-wrap text-sm">{n.body}</p>
                <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">{n.kind === 'call' && <Phone size={11} />}{n.kind === 'call' ? 'Call notes, ' : ''}{new Date(n.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</p>
              </div>
              <button type="button" aria-label="Delete note" disabled={!!busy} className="h-7 w-7 shrink-0 rounded-md text-muted-foreground opacity-60 hover:bg-muted hover:text-foreground hover:opacity-100 disabled:cursor-default" onClick={() => run({ action: 'delete', note_id: n.id }, { ok: 'Note deleted', inline: false, busyKey: `delete:${n.id}` })}>{busy === `delete:${n.id}` ? <Loader2 size={14} className="mx-auto animate-spin" /> : <Trash2 size={14} className="mx-auto" />}</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function ContactBrain({ leadId }) {
  return <div className="space-y-6"><ContactFacts leadId={leadId} /><ContactNotes leadId={leadId} /></div>;
}
