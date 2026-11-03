import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw, Phone, MoreHorizontal, Search, Loader2, Check, AlertTriangle, Info, Smartphone, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { PanelSkeleton } from '@/components/system/Loaders';
import PageHeader from '@/components/workspace/PageHeader';
import { call } from '@/components/workspace/api';
import { stageColors } from '@/lib/stages';
import { notify } from '@/lib/feedback';

const GRADE = { healthy: ['Healthy', 'booked'], watch: ['Watch', 'needs_you'], at_risk: ['At risk', 'no_show'] };
const pct = v => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
const money = c => `$${(c / 100).toFixed(2)}`;

function trustState(status, extra) {
  if (status === 'twilio-approved') return ['Active', 'booked'];
  if (status === 'pending-review' || status === 'in-review') return ['In review', 'needs_you'];
  if (status === 'twilio-rejected') return ['Rejected', 'no_show'];
  if (status === 'not-available') return ['Not available', 'closed'];
  if (status === 'error') return ['Needs attention', 'no_show'];
  return [extra || 'Waiting', 'closed'];
}

function Pill({ label, tone }) {
  const c = stageColors(tone);
  return <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium" style={{ background: c.soft, color: c.ink }}><span className="h-1.5 w-1.5 rounded-full" style={{ background: c.dot }} />{label}</span>;
}

function Ring({ score, grade }) {
  const c = stageColors(GRADE[grade]?.[1] || 'closed'); const r = 26, len = 2 * Math.PI * r; const v = score ?? 0;
  return <div className="relative h-16 w-16 shrink-0">
    <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90"><circle cx="32" cy="32" r={r} fill="none" strokeWidth="6" stroke="hsl(var(--muted))" /><circle cx="32" cy="32" r={r} fill="none" strokeWidth="6" strokeLinecap="round" stroke={c.dot} strokeDasharray={len} strokeDashoffset={len * (1 - v / 100)} style={{ transition: 'stroke-dashoffset .6s ease' }} /></svg>
    <div className="absolute inset-0 flex flex-col items-center justify-center"><span className="text-base font-semibold tabular-nums leading-none">{score ?? '—'}</span><span className="mt-0.5 text-[10px] text-muted-foreground">score</span></div>
  </div>;
}

function Stat({ label, value, sub }) {
  return <div className="bg-card px-3 py-2"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-0.5 text-base font-semibold tabular-nums">{value}</p>{sub && <p className="text-xs text-muted-foreground">{sub}</p>}</div>;
}

function Check1({ ok, wait, children }) {
  return <li className="flex items-center gap-2 text-[13px]">{ok ? <Check size={13} style={{ color: stageColors('booked').dot }} /> : wait ? <Loader2 size={12} className="text-muted-foreground" /> : <span className="h-3 w-3 rounded-full border border-muted-foreground/40" />}<span className={ok ? '' : 'text-muted-foreground'}>{children}</span></li>;
}

function NumberCard({ n, trust, onAct, busy, flash }) {
  const h = n.health || {}; const st = h.stats || {}; const [gradeLabel, tone] = GRADE[h.grade] || ['Checking', 'closed'];
  const [editing, setEditing] = useState(false), [label, setLabel] = useState(n.label || '');
  return <div key={flash || 'card'} className={`panel flex flex-col gap-4 p-4 ${flash ? 'lr-done' : ''}`}>
    <div className="flex items-start gap-4">
      <Ring score={h.score} grade={h.grade} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2"><h3 className="text-base font-semibold tabular-nums">{n.pretty}</h3>{n.is_primary && <span className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs font-medium"><Star size={11} />Main</span>}{n.status === 'paused' && <Pill label="Paused for new leads" tone="closed" />}{n.status === 'unpaid' && <Pill label="Off · fee unpaid" tone="no_show" />}</div>
        {editing ? <form className="mt-1 flex gap-2" onSubmit={e => { e.preventDefault(); onAct('label', n, { label }); setEditing(false); }}><input autoFocus className="field h-8 text-xs" maxLength={30} value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Florida leads" /><Button size="sm" type="submit">Save</Button><Button size="sm" type="button" variant="ghost" onClick={() => { setLabel(n.label || ''); setEditing(false); }}>Cancel</Button></form>
          : <button className="mt-0.5 text-xs text-muted-foreground hover:text-foreground" onClick={() => setEditing(true)}>{busy ? 'Saving…' : n.label || 'Add a label'}{n.locality ? ` · ${n.locality}` : ''}</button>}
        <div className="mt-2"><Pill label={gradeLabel} tone={tone} /></div>
      </div>
      <DropdownMenu><DropdownMenuTrigger asChild><button aria-label="Number options" disabled={!!busy} className="rounded-md p-2 text-muted-foreground hover:bg-muted">{busy ? <Loader2 size={16} className="animate-spin" /> : <MoreHorizontal size={16} />}</button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {!n.is_primary && n.status === 'active' && <DropdownMenuItem onClick={() => onAct('primary', n)}>Make main number</DropdownMenuItem>}
          {!n.is_primary && n.status === 'active' && <DropdownMenuItem onClick={() => onAct('pause', n)}>Pause new leads</DropdownMenuItem>}
          {n.status === 'paused' && <DropdownMenuItem onClick={() => onAct('resume', n)}>Resume new leads</DropdownMenuItem>}
          <DropdownMenuItem onClick={() => setEditing(true)}>Rename</DropdownMenuItem>
          {!n.is_primary && <><DropdownMenuSeparator /><DropdownMenuItem className="text-destructive" onClick={() => onAct('release_ask', n)}>Release number…</DropdownMenuItem></>}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>

    <div className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border bg-border">
      <Stat label="Leads" value={(n.leads ?? 0).toLocaleString()} sub="on this number" />
      <Stat label="Texts 7d" value={(st.sent ?? 0).toLocaleString()} sub={st.sent24 ? `${st.sent24} today` : ' '} />
      <Stat label="Delivered" value={pct(st.delivery_rate)} sub={st.filtered ? `${st.filtered} filtered` : 'none filtered'} />
      <Stat label="Replies" value={pct(st.reply_rate)} sub={`${st.replies ?? 0} this week`} />
      <Stat label="Opt-outs" value={pct(st.opt_out_rate)} sub="under 3% is healthy" />
      <Stat label="Calls" value={st.calls ? `${st.answered}/${st.calls}` : '—'} sub="answered" />
    </div>

    <ul className="space-y-1.5">
      <Check1 ok={n.in_messaging_service} wait={!n.in_messaging_service}>Registered for texting (10DLC)</Check1>
      <Check1 ok={trust?.shaken === 'twilio-approved' && n.shaken_assigned} wait={['pending-review', 'in-review'].includes(trust?.shaken)}>Verified caller ID (STIR/SHAKEN)</Check1>
      <Check1 ok={trust?.vi === 'twilio-approved' && n.vi_assigned} wait={['pending-review', 'in-review'].includes(trust?.vi)}>Spam-label monitoring with carriers</Check1>
      {trust?.cnam !== 'not-available' && <Check1 ok={trust?.cnam === 'twilio-approved' && n.cnam_assigned} wait={['pending-review', 'in-review'].includes(trust?.cnam)}>Shows "{trust?.cnam_name}" on caller ID</Check1>}
    </ul>

    {!!h.issues?.length && <ul className="space-y-1.5 border-t pt-3">{h.issues.filter(i => i.level !== 'info').slice(0, 4).map((i, k) => <li key={k} className="flex gap-2 text-[13px] leading-5" style={{ color: i.level === 'bad' ? stageColors('no_show').ink : stageColors('needs_you').ink }}><AlertTriangle size={13} className="mt-0.5 shrink-0" />{i.text}</li>)}
      {h.issues.every(i => i.level === 'info') && <li className="flex gap-2 text-[13px] text-muted-foreground"><Info size={13} className="mt-0.5 shrink-0" />Looking good. Protection finishes switching on as carriers approve it.</li>}</ul>}
    {n.last_error && <p className="text-xs text-destructive">{n.last_error}</p>}
    <p className="text-xs text-muted-foreground">{n.health_checked_at ? `Checked ${new Date(n.health_checked_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : 'First check running…'}{n.monthly_fee_cents ? ` · ${money(n.monthly_fee_cents)}/mo` : ' · included'}</p>
  </div>;
}

function AddNumber({ open, onOpenChange, fee, onDone }) {
  const [area, setArea] = useState(''), [list, setList] = useState(null), [pick, setPick] = useState(''), [label, setLabel] = useState(''), [busy, setBusy] = useState(''), [err, setErr] = useState('');
  async function search(e) { e?.preventDefault(); setBusy('search'); setErr(''); setPick(''); try { const r = await call('numbers', { action: 'search', area_code: area }); setList(r.numbers); if (r.message) setErr(r.message); } catch (x) { notify.err(x, 'Search failed'); } finally { setBusy(''); } }
  async function buy() {
    setBusy('buy'); setErr('');
    const picked = list?.find(n => n.phone_number === pick)?.pretty || pick;
    try {
      await call('numbers', { action: 'buy', phone_number: pick, label, confirmed: true });
      await onDone();
      notify.ok('Number added', `${picked} is being registered for texting, verified caller ID and spam-label monitoring.`);
      onOpenChange(false); setList(null); setPick(''); setLabel('');
    } catch (x) { notify.err(x, 'Could not add the number'); } finally { setBusy(''); }
  }
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[90dvh] max-w-md overflow-auto">
    <DialogHeader><DialogTitle>Add a number</DialogTitle><DialogDescription>New leads are spread across your numbers, and each lead always hears from the same one.</DialogDescription></DialogHeader>
    <form onSubmit={search} className="flex gap-2"><input className="field" inputMode="numeric" maxLength={3} placeholder="Area code, e.g. 314" value={area} onChange={e => setArea(e.target.value.replace(/\D/g, ''))} /><Button type="submit" disabled={area.length !== 3} loading={busy === 'search'} className="gap-1.5">{busy !== 'search' && <Search size={14} />}Search</Button></form>
    <p className="text-[11px] text-muted-foreground">Tip: pick area codes where your leads live. Local numbers get answered more.</p>
    {list && <div className="max-h-64 space-y-1 overflow-auto lr-rise">{list.map(n => <button key={n.phone_number} type="button" onClick={() => setPick(n.phone_number)} className={`flex w-full items-center justify-between rounded-lg border px-3 py-2.5 text-left text-sm transition ${pick === n.phone_number ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'}`}><span className="font-medium tabular-nums">{n.pretty}</span><span className="text-[11px] text-muted-foreground">{n.locality}</span></button>)}</div>}
    {pick && <><input className="field" placeholder="Label (optional), e.g. Texas leads" maxLength={30} value={label} onChange={e => setLabel(e.target.value)} />
      <div className="rounded-lg bg-muted/60 p-3 text-xs leading-5">{fee ? <><b>{money(fee)}/month</b> from your credits, first month today.</> : 'Included in your plan.'} We register it for texting, verified caller ID and spam-label monitoring automatically.</div>
      <Button className="w-full" loading={busy === 'buy'} onClick={buy}>{busy === 'buy' ? 'Setting it up…' : 'Add this number'}</Button></>}
    {err && <p className="text-xs text-muted-foreground">{err}</p>}
  </DialogContent></Dialog>;
}

function CellCard({ cell }) {
  const qc = useQueryClient(); const [v, setV] = useState(''), [busy, setBusy] = useState(false), [flash, setFlash] = useState(0);
  async function save(e) {
    e.preventDefault(); setBusy(true);
    try { await call('numbers', { action: 'set_cell', phone: v }); await qc.invalidateQueries({ queryKey: ['numbers'] }); notify.ok('Cell saved', 'Call now rings this phone first.'); setV(''); setFlash(f => f + 1); }
    catch (x) { notify.err(x, 'Could not save your cell'); } finally { setBusy(false); }
  }
  return <div key={flash} className={`panel flex flex-wrap items-center gap-3 p-4 ${flash ? 'lr-done' : ''}`}><Smartphone size={18} className="text-muted-foreground" /><div className="min-w-0 flex-1"><p className="text-sm font-semibold">Your cell for calls</p><p className="text-[11px] text-muted-foreground">{cell ? `When you tap Call, we ring ${cell.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3')} first, then connect the lead. Lead callbacks ring here too.` : 'Add it so Call can ring you first and lead callbacks reach you.'}</p></div>
    <form onSubmit={save} className="flex gap-2"><input className="field h-9 w-40 text-xs" inputMode="tel" placeholder={cell ? 'Change cell' : '(555) 555-5555'} value={v} onChange={e => setV(e.target.value)} /><Button size="sm" disabled={v.replace(/\D/g, '').length < 10} loading={busy}>Save</Button></form></div>;
}

export default function Numbers() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['numbers'], queryFn: () => call('numbers', { action: 'list' }), refetchInterval: 60000 });
  const [adding, setAdding] = useState(false), [busy, setBusy] = useState(''), [releasing, setReleasing] = useState(null), [checking, setChecking] = useState(false), [flash, setFlash] = useState({});
  const refresh = () => Promise.all(['numbers', 'launch', 'setup-status'].map(k => qc.invalidateQueries({ queryKey: [k] })));
  const DONE = {
    primary: n => ['Main number set', `${n.pretty} is now your main number.`],
    pause: n => ['Number paused', `${n.pretty} won't get new leads. Its current conversations keep working.`],
    resume: n => ['Number resumed', `${n.pretty} is getting new leads again.`],
    label: (n, x) => ['Label saved', x.label ? `${n.pretty} is now "${x.label}".` : `Label removed from ${n.pretty}.`],
    release: n => ['Number released', `${n.pretty} is gone. Its leads move to your other numbers.`],
  };
  async function act(op, n, extra = {}) {
    if (op === 'release_ask') { setReleasing(n); return; }
    setBusy(n.id);
    try {
      await call('numbers', { action: op, id: n.id, confirmed: true, ...extra });
      await refresh();
      const [title, detail] = DONE[op]?.(n, extra) || ['Saved', ''];
      notify.ok(title, detail);
      if (op !== 'release') setFlash(f => ({ ...f, [n.id]: Date.now() }));
    } catch (x) { notify.err(x); } finally { setBusy(''); setReleasing(null); }
  }
  async function check() {
    setChecking(true);
    try { await call('numbers', { action: 'check' }); await refresh(); notify.ok('Health check done', 'Scores and stats below are up to date.'); setFlash(Object.fromEntries((data?.numbers || []).map(n => [n.id, Date.now()]))); }
    catch (x) { notify.err(x, 'Health check failed'); } finally { setChecking(false); }
  }

  if (isLoading) return <PanelSkeleton />;
  if (error) return <div className="panel p-6 text-sm text-destructive">{error.message}</div>;
  const t = data.trust; const nums = data.numbers || [];
  const rows = [
    ['Texting registration', 'Carriers know who you are, so texts aren\'t blocked (A2P 10DLC).', data.texting.approved ? ['Active', 'booked'] : data.texting.status === 'not_started' ? ['Not started', 'closed'] : ['In review', 'needs_you']],
    ['Verified caller ID', 'Your calls carry an "A" STIR/SHAKEN signature, the top trust level.', trustState(t?.shaken)],
    ['Spam-label monitoring', 'Numbers are registered with AT&T (Hiya), T-Mobile (First Orion) and Verizon (TNS) to prevent "Spam Likely".', trustState(t?.vi)],
    ['Business name on caller ID', t?.cnam === 'not-available' ? 'Needs a business with an EIN.' : `Shows "${t?.cnam_name || 'your brand'}" when you call.`, trustState(t?.cnam)],
  ];

  return <div className="space-y-6">
    <PageHeader
      title="Phone numbers"
      description="Each lead hears from one number, for texts and calls. Spread volume across numbers to stay clear of spam filters."
      actions={nums.length > 0 && <><Button variant="outline" loading={checking} onClick={check}>{!checking && <RefreshCw />}{checking ? 'Checking…' : 'Check health'}</Button>{data.own_texting_number && <Button disabled={!data.can_buy || nums.length >= data.max} onClick={() => setAdding(true)}><Plus />Add a number</Button>}</>}
    />

    {!data.own_texting_number ? <div className="panel p-8 text-center"><Phone className="mx-auto text-muted-foreground" /><h2 className="mt-3 text-base font-semibold">Get your first number</h2><p className="subtext mx-auto mt-1 max-w-md">Choose a local number for texting and calling. You can add more once it's set up.</p><Button asChild className="mt-4"><Link to="/setup/number">Choose a number</Link></Button></div> : <>
      <div className="panel p-4"><div className="mb-3"><h2 className="section-title">Spam protection</h2><p className="text-sm text-muted-foreground">Applied to every number automatically.</p></div>
        <div className="grid gap-3 sm:grid-cols-2">{rows.map(([title, desc, [lbl, tone]]) => <div key={title} className="flex items-start justify-between gap-3 rounded-md border p-3"><div><p className="text-sm font-medium">{title}</p><p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">{desc}</p></div><Pill label={lbl} tone={tone} /></div>)}</div>
        {t?.note && <p className="mt-3 text-sm text-muted-foreground">{t.note}</p>}
      </div>
      <CellCard cell={data.agent_cell} />
      <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">{nums.map(n => <NumberCard key={n.id} n={n} trust={t} busy={busy === n.id} flash={flash[n.id]} onAct={act} />)}</div>
      <div className="panel p-4 text-sm leading-relaxed text-muted-foreground"><p className="mb-1 font-medium text-foreground">Keeping numbers healthy</p>Keep each number under about 300 texts a day; add numbers instead of pushing one harder. Keep opt-outs under 3% and replies coming: personal, short texts with no links do best. If a number drops to At risk, pause it for new leads for a few days. Its current conversations keep working.</div>
    </>}

    <AddNumber open={adding} onOpenChange={setAdding} fee={data.fee_cents} onDone={refresh} />
    <Dialog open={!!releasing} onOpenChange={v => !v && setReleasing(null)}><DialogContent className="max-w-sm"><DialogHeader><DialogTitle>Release {releasing?.pretty}?</DialogTitle><DialogDescription>The number is gone for good. Its {releasing?.leads || 0} leads move to your other numbers on their next text, so they'll see a new number.</DialogDescription></DialogHeader><div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setReleasing(null)}>Keep it</Button><Button variant="destructive" loading={busy === releasing?.id} onClick={() => act('release', releasing)}>{busy === releasing?.id ? 'Releasing…' : 'Release number'}</Button></div></DialogContent></Dialog>
  </div>;
}
