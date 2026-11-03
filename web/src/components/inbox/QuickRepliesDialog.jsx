import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, Plus, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { call } from '@/components/workspace/api';
import { notify } from '@/lib/feedback';

function Row({ item, onSaved }) {
  const [label, setLabel] = useState(item?.label || ''), [text, setText] = useState(item?.text || ''), [busy, setBusy] = useState(''), [err, setErr] = useState(''), [flash, setFlash] = useState(false);
  const dirty = !item || label !== item.label || text !== item.text;
  useEffect(() => { if (!flash) return undefined; const t = setTimeout(() => setFlash(false), 1300); return () => clearTimeout(t); }, [flash]);
  async function save() {
    setBusy('save'); setErr('');
    try {
      await call('inbox', { action: 'quick_save', id: item?.id, label, text });
      if (!item) { setLabel(''); setText(''); }
      await onSaved();
      if (item) setFlash(true);
      notify.ok(item ? 'Quick reply saved' : 'Quick reply added', item ? '' : 'It now shows above your reply box.');
    } catch (e) { setErr(e.message); } finally { setBusy(''); }
  }
  async function remove() { setBusy('delete'); setErr(''); try { await call('inbox', { action: 'quick_delete', id: item.id }); await onSaved(); notify.ok('Quick reply deleted'); } catch (e) { setErr(e.message); setBusy(''); } }
  return <div className={`space-y-1.5 rounded-lg border p-3 ${flash ? 'lr-done' : ''}`}>
    <div className="flex gap-2"><input className="field h-9 w-32 text-xs" placeholder="Button label" maxLength={24} value={label} onChange={e => setLabel(e.target.value)} />{item && <button type="button" aria-label="Delete quick reply" disabled={!!busy} onClick={remove} className="ml-auto p-2 text-muted-foreground hover:text-destructive disabled:opacity-60">{busy === 'delete' ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}</button>}</div>
    <textarea className="field min-h-[60px] text-xs" placeholder="Hi {first_name}, …" maxLength={480} value={text} onChange={e => setText(e.target.value)} />
    {dirty && <div className="flex justify-end"><Button size="sm" loading={busy === 'save'} disabled={!!busy || !text.trim()} onClick={save}>{item ? (busy === 'save' ? 'Saving…' : 'Save') : <>{busy !== 'save' && <Plus size={13} className="mr-1" />}{busy === 'save' ? 'Adding…' : 'Add'}</>}</Button></div>}
    {err && <p className="text-xs text-destructive">{err}</p>}
  </div>;
}

export default function QuickRepliesDialog({ open, onOpenChange }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['quick-replies'], queryFn: () => call('inbox', { action: 'quick_list' }), enabled: open });
  const refresh = () => qc.invalidateQueries({ queryKey: ['quick-replies'] });
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[85dvh] max-w-lg overflow-auto">
      <DialogHeader><DialogTitle>Quick replies</DialogTitle><DialogDescription>One tap drops these into your reply. Use {'{first_name}'} for the lead's name and {'{my_name}'} for yours.</DialogDescription></DialogHeader>
      <div className="space-y-2">{(data?.items || []).map(q => <Row key={q.id} item={q} onSaved={refresh} />)}<Row key={`new-${data?.items?.length || 0}`} onSaved={refresh} /></div>
    </DialogContent>
  </Dialog>;
}
