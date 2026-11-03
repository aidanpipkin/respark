import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import PageHeader from '@/components/workspace/PageHeader';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { call } from '@/components/workspace/api';
import { Upload, Check, FileSpreadsheet, ArrowRight, FlaskConical } from 'lucide-react';
import LeadWebhookCard from '@/components/contacts/LeadWebhookCard';
import { notify } from '@/lib/feedback';


// A ready-to-fill template: the columns the AI uses best, with one fictional example row.
function downloadSample() {
  const rows = [
    ['First Name', 'Last Name', 'Phone', 'Email', 'State', 'Date Inquired', 'Lead Source', 'Occupation', 'Who They Want To Protect', 'Notes'],
    ['Marcus', 'Example', '(479) 555-0142', 'marcus@example.com', 'AR', '2026-02-14', 'Facebook ad', 'Owner-operator truck driver', 'Wife and two daughters', 'Asked about living benefits. Out on the road 3 weeks at a time.'],
  ];
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a'); a.href = url; a.download = 'leadrespark-sample.csv'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify.ok('Sample downloaded', 'Fill it in or match your own columns to it, then drop the file here.');
}

const FIELDS = [
  ['first_name', 'First name', /^(first|fname|first.?name|given)/i],
  ['last_name', 'Last name', /^(last|lname|last.?name|surname|family)/i],
  ['phone', 'Mobile phone *', /(phone|mobile|cell|number)/i],
  ['email', 'Email', /e-?mail/i],
  ['state', 'State', /^(state|st|province|region)$/i],
  ['inquiry_date', 'Date they inquired', /(inquir|created|date.?added|lead.?date|submitted)/i],
  ['consent_date', 'Consent date', /(consent|opt.?in)/i],
  ['lead_source', 'Lead source', /(source|vendor|campaign)/i],
];
// Everything the AI can use to write about this person. Optional, but the more it knows, the better it writes.
const FACTS = [
  ['product_interest', 'Product they asked about', /(product|interest|coverage.?type|plan.?type|policy.?type)/i],
  ['prior_notes', 'Notes / comments', /(note|comment|remark|memo|description)/i],
  ['prior_outcome', 'What happened last time', /(outcome|disposition|result|status|stage)/i],
  ['reason_in_their_words', 'Why they wanted coverage', /(reason|why|goal|need)/i],
  ['who_to_protect', 'Who they want to protect', /(beneficiar|protect|spouse|family)/i],
  ['dependents', 'Kids / dependents', /(depend|kids|children)/i],
  ['coverage_requested', 'Coverage amount asked about', /(amount|face|coverage.?amount|death.?benefit)/i],
  ['date_of_birth', 'Date of birth', /(dob|birth)/i],
  ['age', 'Age', /^age$/i],
  ['occupation', 'Occupation', /(occupation|job|employ|profession|work)/i],
];
const ALL_FIELDS = [...FIELDS, ...FACTS];
const MAX_ROWS = 5000, CHUNK = 100;

function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some(v => v.trim())) rows.push(row); row = []; }
    else cell += c;
  }
  row.push(cell); if (row.some(v => v.trim())) rows.push(row);
  return rows;
}

export default function ImportLeads() {
  const qc = useQueryClient();
  const { data: opts, error: optsError } = useQuery({ queryKey: ['import-options'], queryFn: () => call('importLeads', { action: 'options' }) });
  const [headers, setHeaders] = useState([]), [rows, setRows] = useState([]), [map, setMap] = useState({}), [fileName, setFileName] = useState('');
  const [source, setSource] = useState(''), [campaignId, setCampaignId] = useState(''), [attested, setAttested] = useState(false), [registryScrubbed, setRegistryScrubbed] = useState(false);
  const [progress, setProgress] = useState(null), [err, setErr] = useState('');
  const [testBusy, setTestBusy] = useState(false);
  const fileRef = useRef(null);
  const launch = useQuery({ queryKey: ['launch'], queryFn: () => call('launch', {}), staleTime: 30000 });
  // If the agent leaves mid-import, the import keeps going; tell them when it finishes.
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const campaign = campaignId || opts?.campaigns?.find(c => c.status === 'active')?.id || opts?.campaigns?.find(c => c.name === 'Life Insurance Respark')?.id || opts?.campaigns?.[0]?.id || '';

  function load(file) {
    setErr(''); setProgress(null);
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { setErr('That file is over 10 MB. Split it into smaller files.'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const all = parseCsv(String(reader.result || '').replace(/^﻿/, ''));
      if (all.length < 2) { setErr('The file needs a header row and at least one lead.'); return; }
      const h = all[0].map(v => v.trim());
      const auto = {};
      for (const [key, , re] of ALL_FIELDS) { const idx = h.findIndex((name, i) => re.test(name) && !Object.values(auto).includes(i)); if (idx >= 0) auto[key] = idx; }
      if (auto.phone === undefined) { const idx = h.findIndex(n => /phone|mobile|cell/i.test(n)); if (idx >= 0) auto.phone = idx; }
      setHeaders(h); setRows(all.slice(1, MAX_ROWS + 1)); setMap(auto); setFileName(file.name);
      if (all.length - 1 > MAX_ROWS) setErr(`Only the first ${MAX_ROWS.toLocaleString()} leads will be imported. Upload the rest in another file.`);
    };
    reader.readAsText(file);
  }

  const [keepRest, setKeepRest] = useState(true);
  const used = useMemo(() => new Set(Object.values(map).filter(i => i !== '' && i !== undefined)), [map]);
  const rest = headers.map((h, i) => i).filter(i => !used.has(i) && headers[i]);
  const mapped = useMemo(() => rows.map(r => {
    const core = Object.fromEntries(FIELDS.map(([k]) => [k, map[k] !== undefined && map[k] !== '' ? r[map[k]] ?? '' : '']).filter(([, v]) => v !== ''));
    const facts = Object.fromEntries(FACTS.map(([k]) => [k, map[k] !== undefined && map[k] !== '' ? String(r[map[k]] ?? '').trim() : '']).filter(([, v]) => v));
    const extra = keepRest ? Object.fromEntries(rest.map(i => [headers[i], String(r[i] ?? '').trim()]).filter(([, v]) => v).slice(0, 20)) : {};
    return { ...core, facts, extra };
  }), [rows, map, keepRest, headers]);
  const ready = rows.length && map.phone !== undefined && map.phone !== '' && source && attested && campaign;

  async function run() {
    setErr('');
    const batchId = crypto.randomUUID();
    const total = { imported: 0, held: 0, duplicate: 0, skipped: 0, errors: 0, done: 0, of: mapped.length, problems: [] };
    setProgress({ ...total });
    for (let i = 0; i < mapped.length; i += CHUNK) {
      try {
        const r = await call('importLeads', { rows: mapped.slice(i, i + CHUNK), source, campaign_id: campaign, attested: true, registry_scrubbed: registryScrubbed, batch_id: batchId });
        for (const k of ['imported', 'held', 'duplicate', 'skipped', 'errors']) total[k] += r[k] || 0;
        for (const x of r.results || []) if (['skipped', 'error', 'held'].includes(x.status) && total.problems.length < 200) total.problems.push({ row: i + x.i + 2, reason: x.reason });
      } catch (e) { total.errors += Math.min(CHUNK, mapped.length - i); if (total.problems.length < 200) total.problems.push({ row: `${i + 2}–${Math.min(i + CHUNK, mapped.length) + 1}`, reason: e.message }); }
      total.done = Math.min(i + CHUNK, mapped.length);
      setProgress({ ...total });
    }
    await Promise.all(['lead-list', 'lead-stages', 'launch', 'dashboard'].map(k => qc.invalidateQueries({ queryKey: [k] })));
    if (!mounted.current) notify.ok(`Import finished: ${total.imported.toLocaleString()} lead${total.imported === 1 ? '' : 's'} added`, total.held + total.duplicate + total.skipped + total.errors ? 'Some rows were held or skipped.' : '', { label: 'Go to Leads', to: '/contacts' });
  }

  // Five fictional 555-01xx leads (no consent attestation: they are never texted for real), shown in the same results panel.
  async function createTestLeads() {
    if (testBusy) return;
    setErr(''); setTestBusy(true);
    try {
      const r = await call('importLeads', { action: 'test_leads' });
      const problems = (r.results || []).filter(x => ['skipped', 'error', 'held', 'duplicate'].includes(x.status)).map(x => ({ row: x.i + 1, reason: x.reason }));
      setProgress({ imported: r.imported || 0, held: r.held || 0, duplicate: r.duplicate || 0, skipped: r.skipped || 0, errors: r.errors || 0, done: (r.results || []).length, of: (r.results || []).length, problems, test: true, campaign: r.campaign });
      await Promise.all(['lead-list', 'lead-stages', 'launch', 'dashboard'].map(k => qc.invalidateQueries({ queryKey: [k] })));
    } catch (e) { setErr(e.message); } finally { setTestBusy(false); }
  }

  const business = opts?.business_name || 'my business';
  const finished = progress && progress.done >= progress.of;
  const live = !!launch.data?.live;
  const nextSetup = launch.data?.items?.find(i => !i.done);
  const resetImport = () => { setProgress(null); setRows([]); setHeaders([]); setFileName(''); setAttested(false); setRegistryScrubbed(false); setErr(''); if (fileRef.current) fileRef.current.value = ''; };
  const [dragging, setDragging] = useState(false);
  const select = (key, value) => setMap({ ...map, [key]: value === '' ? '' : Number(value) });
  const columnSelect = ([key, label]) => (
    <label key={key}>
      <span className="field-label">{label}</span>
      <select className="field" value={map[key] ?? ''} onChange={e => select(key, e.target.value)}>
        <option value="">Not in my file</option>
        {headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
      </select>
    </label>
  );

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader back={{ to: '/contacts', label: 'Leads' }} title="Import leads" description="Upload a CSV of past leads. Your campaign starts texting them automatically once you're live." />
      {optsError && <p className="mb-4 text-sm text-destructive">{optsError.message}</p>}

      {!progress && (
        <div className="space-y-6">
          <section className="panel">
            <div className="flex h-12 items-center justify-between border-b px-4"><h2 className="section-title">1. Upload your file</h2><button type="button" onClick={downloadSample} className="text-sm text-muted-foreground hover:text-foreground hover:underline">Download a sample CSV</button></div>
            <div className="p-4">
              <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={e => load(e.target.files?.[0])} />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                onDragOver={e => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={e => { e.preventDefault(); setDragging(false); load(e.dataTransfer.files?.[0]); }}
                className={`flex w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-10 text-center transition-colors ${dragging ? 'border-primary bg-primary/5' : 'border-input hover:border-primary/50 hover:bg-muted/40'}`}
              >
                {fileName ? <FileSpreadsheet size={22} className="text-primary" /> : <Upload size={22} className="text-muted-foreground" />}
                {fileName
                  ? <><span className="text-sm font-medium">{fileName}</span><span className="text-sm text-muted-foreground">{rows.length.toLocaleString()} leads found. Click to choose a different file.</span></>
                  : <><span className="text-sm font-medium">Drop a CSV here, or click to choose one</span><span className="text-sm text-muted-foreground">Export it from your old CRM or spreadsheet. Up to 5,000 leads per file.</span></>}
              </button>
              <p className="mt-3 text-xs text-muted-foreground">Needs a mobile phone column. Include state: only leads in states you're licensed in get texted.</p>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-dashed px-3 py-2.5">
                <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground">Want to see it work first?</span> Add 5 fictional test leads (555-01xx numbers). They run through the real engine but are never texted or charged; you can play the lead from the Inbox.</p>
                <Button type="button" size="sm" variant="outline" loading={testBusy} onClick={createTestLeads}><FlaskConical size={14} />Create test leads</Button>
              </div>
            </div>
          </section>

          {headers.length > 0 && (
            <section className="panel">
              <div className="flex h-12 items-center border-b px-4"><h2 className="section-title">2. Match your columns</h2></div>
              <div className="space-y-5 p-4">
                <div className="grid gap-3 sm:grid-cols-2">{FIELDS.map(columnSelect)}</div>
                <div className="border-t pt-4">
                  <h3 className="text-sm font-medium">What the AI should know about each person</h3>
                  <p className="mt-0.5 text-sm text-muted-foreground">Optional. The more it knows, the more personal every text is. Health details are always kept out of texts.</p>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">{FACTS.map(columnSelect)}</div>
                  {rest.length > 0 && <label className="mt-4 flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={keepRest} onChange={e => setKeepRest(e.target.checked)} /><span>Also give the AI my other columns as background ({rest.slice(0, 6).map(i => headers[i]).join(', ')}{rest.length > 6 ? `, and ${rest.length - 6} more` : ''})</span></label>}
                </div>
                {mapped[0] && <p className="rounded-md bg-muted px-3 py-2 text-sm">First lead: <span className="font-medium">{[mapped[0].first_name, mapped[0].last_name].filter(Boolean).join(' ') || 'No name'}</span>, {mapped[0].phone || 'no phone'}, {mapped[0].state || 'no state'}</p>}
              </div>
            </section>
          )}

          {headers.length > 0 && (
            <section className="panel">
              <div className="flex h-12 items-center border-b px-4"><h2 className="section-title">3. Consent and campaign</h2></div>
              <div className="space-y-4 p-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block"><span className="field-label">Where these leads came from</span><select className="field" value={source} onChange={e => setSource(e.target.value)}><option value="">Choose a source</option>{opts?.sources?.map(x => <option key={x}>{x}</option>)}</select></label>
                  <label className="block"><span className="field-label">Campaign</span><select className="field" value={campaign} onChange={e => setCampaignId(e.target.value)}>{opts?.campaigns?.map(c => <option key={c.id} value={c.id}>{c.name}{c.status === 'paused' ? ' (paused)' : c.status !== 'active' ? ' (starts when you go live)' : ''}</option>)}</select></label>
                </div>
                <p className="rounded-md border px-3 py-2.5 text-sm leading-relaxed" style={{ background: 'hsl(var(--st-client) / 0.07)', borderColor: 'hsl(var(--st-client) / 0.35)' }}>Carriers and the TCPA require that each person agreed to get texts from <span className="font-medium">{opts?.business_name || 'your business'}</span>. Bought or shared lists without that consent can't be texted and can get your number blocked.</p>
                <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={attested} onChange={e => setAttested(e.target.checked)} /><span>Everyone in this file asked {business} for information and gave prior express written consent to receive texts from {business}. No one on it has asked us to stop. I can produce that consent if asked.</span></label>
                <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-1" checked={registryScrubbed} onChange={e => setRegistryScrubbed(e.target.checked)} /><span>I scrubbed this list against the National Do Not Call Registry in the last 31 days. <span className="text-muted-foreground">Optional: written consent makes the registry check unnecessary. Bought lists without consent cannot be texted either way.</span></span></label>
              </div>
            </section>
          )}

          {err && <p role="alert" className="text-sm text-destructive">{err}</p>}
          {headers.length > 0 && (
            <div className="flex items-center justify-end gap-3">
              {!ready && <span className="text-sm text-muted-foreground">{map.phone === undefined || map.phone === '' ? 'Match the phone column' : !source ? 'Choose where the leads came from' : !attested ? 'Confirm consent' : ''}</span>}
              <Button disabled={!ready} onClick={run}>Import {rows.length.toLocaleString()} leads<ArrowRight /></Button>
            </div>
          )}

          {!headers.length && <LeadWebhookCard />}
        </div>
      )}

      {progress && (
        <section className="panel lr-rise">
          {finished ? (
            <div className="flex flex-col items-center border-b px-6 py-10 text-center">
              <span className={`flex h-14 w-14 items-center justify-center rounded-full text-white lr-pop ${progress.imported ? 'bg-success' : 'bg-muted-foreground'}`}><Check size={28} strokeWidth={3} /></span>
              <h2 className="mt-4 text-xl font-semibold">{progress.imported ? `${progress.imported.toLocaleString()} ${progress.test ? 'test ' : ''}lead${progress.imported === 1 ? '' : 's'} ${progress.test ? 'created' : 'imported'}` : progress.test ? 'No new test leads' : 'No new leads imported'}</h2>
              <p className="mt-1.5 max-w-md text-sm leading-relaxed text-muted-foreground">
                {progress.test && progress.imported ? `Enrolled in ${progress.campaign || 'your campaign'}. Their texts are logged like real ones but never sent. Open one in the Inbox and use "Simulate a reply" to play the lead.`
                  : !progress.imported ? 'Every row was already in your leads, held or skipped. The details are below.'
                  : live ? 'Your AI starts texting them during sending hours. Replies land in your inbox.'
                    : 'They are saved and ready. Texting starts on its own as soon as you finish setup and go live.'}
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-2">
                <Button asChild><Link to="/contacts">Go to Leads<ArrowRight /></Link></Button>
                {!live && <Button asChild variant="outline"><Link to={nextSetup?.href || '/dashboard'}>Finish setup</Link></Button>}
                <Button variant="ghost" onClick={resetImport}>{progress.test ? 'Import a file' : 'Import another file'}</Button>
              </div>
              {!live && nextSetup && <p className="mt-3 text-xs text-muted-foreground">Next setup step: {nextSetup.label}</p>}
            </div>
          ) : <div className="flex h-12 items-center gap-2 border-b px-4"><h2 className="section-title">Importing. Keep this page open.</h2></div>}
          <div className="space-y-4 p-4">
            {!finished && <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${Math.round((progress.done / Math.max(progress.of, 1)) * 100)}%` }} /></div>}
            <p className="text-sm text-muted-foreground">{progress.done.toLocaleString()} of {progress.of.toLocaleString()} processed</p>
            <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-5">
              {[['Ready to text', progress.imported], ['Held (not licensed there)', progress.held], ['Already had', progress.duplicate], ['Skipped', progress.skipped], ['Errors', progress.errors]].map(([l, v]) => <div key={l} className="bg-card p-3"><dd className="text-lg font-semibold tabular-nums">{v.toLocaleString()}</dd><dt className="text-xs text-muted-foreground">{l}</dt></div>)}
            </dl>
            {progress.problems.length > 0 && <details className="text-sm"><summary className="cursor-pointer text-muted-foreground hover:text-foreground">Rows that need attention ({progress.problems.length}{progress.problems.length === 200 ? '+' : ''})</summary><ul className="mt-2 max-h-60 space-y-1 overflow-auto text-xs">{progress.problems.map((p, i) => <li key={i}>Row {p.row}: {p.reason}</li>)}</ul></details>}
          </div>
        </section>
      )}
    </div>
  );
}
