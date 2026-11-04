import { useRef, useState } from 'react';
import { PanelSkeleton } from '@/components/system/Loaders';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { call } from '@/components/workspace/api';
import { Button } from '@/components/ui/button';
import { FileText, Upload, AlertTriangle } from 'lucide-react';
import { notify } from '@/lib/feedback';
import ConfirmButton from '@/components/workspace/ConfirmButton';

const PRODUCTS = [['iul', 'IUL'], ['final_expense', 'Final expense'], ['mortgage', 'Mortgage protection'], ['all', 'Every campaign']];
const SUGGESTED = ['Mutual of Omaha IUL', 'Transamerica IUL', 'North American IUL'];
const BLANK = { name: '', url: '', products: ['iul'], approved: false };

/** Link to a document: https links open directly; stored files (storage paths) get a signed URL when opened. */
function DocLink({ url, children }) {
  const [busy, setBusy] = useState(false);
  const cls = 'font-medium hover:text-primary';
  if (/^https:\/\//.test(url || '')) return <a href={url} target="_blank" rel="noreferrer" className={cls}>{children}</a>;
  async function open(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    const w = window.open('', '_blank', 'noopener'); // open first so the popup blocker allows it after the await
    try {
      const { signed_url } = await base44.integrations.Core.CreateFileSignedUrl({ file_uri: url });
      if (w) w.location.href = signed_url; else window.location.assign(signed_url);
    } catch (err) { if (w) w.close(); console.error('[DocumentsPanel] could not sign document url', err); notify.err(err, 'Could not open the document'); }
    finally { setBusy(false); }
  }
  return <a href="#" onClick={open} className={cls} aria-busy={busy || undefined}>{children}</a>;
}

/** Pre-call documents linked and attached in every booked-call email. */
export default function DocumentsPanel() {
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['admin-documents'], queryFn: () => call('adminDocuments', {}) });
  const [form, setForm] = useState(BLANK), [busy, setBusy] = useState(''), [flash, setFlash] = useState('');
  const productNames = list => (list || []).map(p => PRODUCTS.find(x => x[0] === p)?.[1] || p).join(', ');
  const fileRef = useRef(null);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // Upload and save in one step: pick the PDF and it's added (named from the file unless a name was typed).
  async function upload(file) {
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { notify.err('That file isn\'t a PDF.', 'Not added'); return; }
    if (file.size > 15 * 1024 * 1024) { notify.err('Keep PDFs under 15 MB so emails deliver.', 'File too large'); return; }
    setBusy('upload');
    // Store the durable storage path (file_uri), never the 1-hour signed URL: links and email attachments are signed when used.
    let file_uri = '';
    try { ({ file_uri } = await base44.integrations.Core.UploadFile({ file })); }
    catch (e) { console.error('[DocumentsPanel] upload failed', e); notify.err(`${e?.message || 'Unknown error'}. Try again, or refresh the page and sign in again.`, 'Upload failed'); setBusy(''); return; }
    if (!file_uri) { notify.err('No file path came back. Try again.', 'Upload failed'); setBusy(''); return; }
    const doc = { ...form, url: file_uri, name: (form.name || '').trim() || file.name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim(), approved: true };
    setForm(doc); setBusy('');
    if (await run({ action: 'save', document: doc }, 'save', 'Document added', `${doc.name} now goes out with every booked-call email for ${productNames(doc.products)}.`, doc.name)) setForm(BLANK);
  }
  async function run(body, key, title, detail, flashName = '') {
    setBusy(key);
    try {
      await call('adminDocuments', body); await refetch();
      notify.ok(title, detail);
      if (flashName) { setFlash(flashName); setTimeout(() => setFlash(''), 1300); }
      return true;
    } catch (e) { console.error('[DocumentsPanel] save failed', e); notify.err(e, 'Document not saved'); return false; }
    finally { setBusy(''); }
  }
  function pick() { if (!form.approved) { notify.err('Tick the consumer-approved box first, then choose the PDF.', 'One more step'); return; } fileRef.current?.click(); }

  if (isLoading) return <PanelSkeleton rows={3} />;
  if (error) return <section className="panel p-5 text-sm text-destructive">{error.message}</section>;
  const have = data.documents.map(d => d.name.toLowerCase());
  const missing = SUGGESTED.filter(n => !have.some(h => h.includes(n.split(' ')[0].toLowerCase())));
  return <section className="panel space-y-4 p-5">
    <div><h2 className="flex items-center gap-2 font-semibold"><FileText size={16} />Pre-call documents</h2>
      <p className="subtext mt-1 text-sm">Linked and attached in the email every lead gets when they book. Matched to the campaign's product.</p></div>
    {!!missing.length && <p className="flex gap-2 rounded-lg bg-primary/5 p-3 text-xs"><AlertTriangle size={14} className="mt-0.5 shrink-0 text-primary" />Still to upload: {missing.join(', ')}.</p>}
    <ul className="divide-y text-sm">{data.documents.map(d => <li key={d.id} className={`flex flex-wrap items-center justify-between gap-2 py-2 ${flash === d.name ? 'lr-done' : ''}`}>
      <div><DocLink url={d.url}>{d.name}</DocLink><p className="text-xs text-muted-foreground">{(d.products || []).map(p => PRODUCTS.find(x => x[0] === p)?.[1] || p).join(', ')}{d.active === false ? ' · off' : ''}</p></div>
      <div className="flex gap-2">{d.active === false
        ? <Button size="sm" variant="outline" loading={busy === `on:${d.id}`} disabled={!!busy} onClick={() => run({ action: 'save', document: { ...d, active: true } }, `on:${d.id}`, 'Document turned on', `${d.name} goes out with booked-call emails again.`, d.name)}>Turn on</Button>
        : <ConfirmButton size="sm" variant="ghost" loading={busy === `off:${d.id}`} disabled={!!busy} title={d.builtin ? `Turn off ${d.name}?` : `Remove ${d.name}?`} description={d.builtin ? 'It stops going out with booked-call emails. You can turn it back on any time.' : 'The file is removed from booked-call emails. You would need to upload it again to bring it back.'} confirmLabel={d.builtin ? 'Turn off' : 'Remove'} destructive={!d.builtin} onConfirm={() => run({ action: 'remove', id: d.id }, `off:${d.id}`, d.builtin ? 'Document turned off' : 'Document removed', `${d.name} no longer goes out with booked-call emails.`, d.builtin ? d.name : '')}>{d.builtin ? 'Turn off' : 'Remove'}</ConfirmButton>}</div>
    </li>)}</ul>
    <div className="space-y-3 rounded-lg border p-4">
      <h3 className="text-sm font-semibold">Add a document</h3>
      <input ref={fileRef} type="file" accept="application/pdf" className="hidden" onChange={e => upload(e.target.files?.[0])} />
      <p className="text-xs text-muted-foreground">1. Name it (optional) and pick the products. 2. Tick the box. 3. Choose the PDF. It saves automatically.</p>
      <label className="block"><span className="field-label">Name shown to the lead</span><input className="field" list="doc-names" value={form.name} maxLength={100} onChange={e => set('name', e.target.value)} placeholder="e.g. Mutual of Omaha IUL Express" /><datalist id="doc-names">{SUGGESTED.map(n => <option key={n} value={n} />)}</datalist></label>
      <div className="flex flex-wrap gap-3 text-sm">{PRODUCTS.map(([k, l]) => <label key={k} className="flex items-center gap-1"><input type="checkbox" checked={form.products.includes(k)} onChange={e => set('products', e.target.checked ? [...form.products, k] : form.products.filter(x => x !== k))} />{l}</label>)}</div>
      <label className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5" checked={form.approved} onChange={e => set('approved', e.target.checked)} />This is the carrier's approved consumer-facing version (not "for agent use only"), and it's current. Carriers require approval for advertising sent to consumers; some products aren't available in every state.</label>
      <Button type="button" className="gap-2" loading={busy === 'upload' || busy === 'save'} disabled={!!busy} onClick={pick}>{!(busy === 'upload' || busy === 'save') && <Upload size={14} />}{busy === 'upload' ? 'Uploading' : busy === 'save' ? 'Saving' : 'Choose PDF and add'}</Button>
      <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">Or paste a link instead</summary>
        <div className="mt-2 flex flex-wrap gap-2"><input className="field flex-1" placeholder="https://…/brochure.pdf" value={form.url} onChange={e => set('url', e.target.value.trim())} /><Button type="button" variant="outline" loading={busy === 'link'} disabled={!!busy} onClick={async () => { if (!form.approved) return notify.err('Tick the consumer-approved box first.', 'One more step'); if (!/^https:\/\//.test(form.url)) return notify.err('Paste a link that starts with https://', 'Check the link'); if (!form.name.trim()) return notify.err('Give it a name so the lead knows what it is.', 'Name needed'); if (await run({ action: 'save', document: form }, 'link', 'Document added', `${form.name} now goes out with every booked-call email for ${productNames(form.products)}.`, form.name)) setForm(BLANK); }}>Add link</Button></div>
      </details>
    </div>
  </section>;
}
