import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, CheckCircle2, Info, RefreshCw, LifeBuoy, TrendingUp, Bot, Send } from 'lucide-react';
import AdminTabs from '@/components/admin/AdminTabs';
import { Button } from '@/components/ui/button';
import { call } from '@/components/workspace/api';
import { PanelSkeleton } from '@/components/system/Loaders';
import { stageColors } from '@/lib/stages';
import RehearsalCard from '@/components/admin/RehearsalCard';
import { useAction } from '@/lib/feedback';

const TONE = { critical: 'needs_you', warning: 'client', info: 'talking' };
const usd = c => `$${Math.round((Number(c) || 0) / 100).toLocaleString()}`;
const ago = iso => { if (!iso) return 'never'; const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };

function Stat({ label, value, sub }) {
  return <div className="rounded-lg border bg-card p-4"><p className="text-[11px] font-medium text-muted-foreground">{label}</p><p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>{sub && <p className="mt-0.5 text-[11px] text-muted-foreground">{sub}</p>}</div>;
}

function HelpItem({ r, onDone }) {
  const [text, setText] = useState('');
  const { run, busy } = useAction();
  async function act(action) {
    const who = r.agent_name || r.agent_email;
    const ok = await run(action, async () => { await call('support', { action, id: r.id, body: text }); return true; }, {
      ok: action === 'reply' ? 'Reply sent' : 'Request closed',
      detail: action === 'reply' ? `Emailed to ${who}. It also shows in their help window.` : `${who}'s request is off the open list.`,
    });
    if (ok) { setText(''); onDone(); }
  }
  const c = r.context || {};
  return (
    <li className="space-y-2 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2"><p className="text-sm font-semibold">{r.agent_name || r.agent_email} <span className="font-normal text-muted-foreground">{r.agent_email}</span></p><span className="text-[11px] text-muted-foreground">{ago(r.created_at)}{r.page ? ` · from ${r.page}` : ''}</span></div>
      <p className="whitespace-pre-wrap text-sm">{r.message}</p>
      <div className="flex flex-wrap gap-1.5 text-[10px]">{[['Setup', c.setup], ['Next', c.next_step], ['Status', c.status], ['Texting reg.', c.a2p], ['Mode', c.mode], ['Balance', c.balance], ['Plan', c.subscription], ['Leads', c.leads]].filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => <span key={k} className="rounded-md bg-muted px-2 py-0.5"><span className="text-muted-foreground">{k}:</span> {String(v)}</span>)}</div>
      {!!c.open_issues?.length && <p className="text-[11px]" style={{ color: stageColors('needs_you').ink }}>Open issues: {c.open_issues.join(' · ')}</p>}
      <div className="flex gap-2"><textarea className="field min-h-16 flex-1 text-sm" placeholder="Reply (emailed to the agent)…" value={text} onChange={e => setText(e.target.value)} /></div>
      <div className="flex gap-2"><Button size="sm" className="gap-1.5" loading={busy === 'reply'} disabled={!!busy || !text.trim()} onClick={() => act('reply')}>{busy !== 'reply' && <Send size={13} />}Send reply</Button><Button size="sm" variant="ghost" loading={busy === 'close'} disabled={!!busy} onClick={() => act('close')}>Close without reply</Button></div>
    </li>
  );
}

export default function AdminCommand() {
  const { data, isLoading, error, refetch, isFetching } = useQuery({ queryKey: ['command-center'], queryFn: () => call('commandCenter', {}), refetchInterval: 60000 });
  const { run, busy } = useAction();
  const running = busy === 'health';
  async function runNow() {
    await run('health', async () => { await call('commandCenter', { action: 'run_health' }); return (await refetch()).data; }, {
      ok: 'Checks finished',
      detail: d => { const h = d?.health || {}; return h.critical ? `${h.critical} critical issue${h.critical === 1 ? '' : 's'} found. See open signals below.` : h.warnings ? `${h.warnings} thing${h.warnings === 1 ? '' : 's'} to look at below.` : 'All systems normal.'; },
    });
  }
  async function resolveKey(key) {
    await run(`resolve:${key}`, () => call('commandCenter', { action: 'resolve', key }), { ok: 'Signal resolved', detail: 'It reopens if the problem happens again.', invalidate: [['command-center']] });
  }

  return (
    <div>
      <AdminTabs />
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="page-title">Command Center</h1><p className="subtext mt-1">Health, growth and support across every agent. Refreshes every minute.</p></div>
        <Button variant="outline" className="gap-2" disabled={running} aria-busy={running || undefined} onClick={runNow}><RefreshCw size={14} className={running || isFetching ? 'animate-spin' : ''} />{running ? 'Checking' : 'Run checks now'}</Button>
      </div>
      {isLoading ? <PanelSkeleton rows={6} /> : error ? <p className="text-destructive">{error.message}</p> : <div className="space-y-6">

        {/* Health banner */}
        {(() => { const bad = data.health.critical, warn = data.health.warnings; const tone = stageColors(bad ? 'needs_you' : warn ? 'client' : 'booked'); return (
          <section key={data.health.last_check} className="lr-done flex flex-wrap items-center gap-4 rounded-lg border p-5" style={{ background: tone.faint, borderColor: tone.line }}>
            {bad || warn ? <AlertTriangle size={26} style={{ color: tone.dot }} /> : <CheckCircle2 size={26} style={{ color: tone.dot }} />}
            <div className="min-w-0 flex-1"><p className="text-lg font-semibold" style={{ color: tone.ink }}>{bad ? `${bad} critical issue${bad === 1 ? '' : 's'}` : warn ? `${warn} thing${warn === 1 ? '' : 's'} to look at` : 'All systems normal'}</p><p className="text-xs text-muted-foreground">Last health check {ago(data.health.last_check)}</p></div>
            <div className="flex flex-wrap gap-2">{data.health.jobs.map(j => <span key={j.key} title={j.last_run ? `Last ran ${ago(j.last_run)}` : 'No run recorded yet'} className="flex items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-[11px]"><span className="h-2 w-2 rounded-full" style={{ background: j.minutes_ago === null ? 'hsl(var(--muted-foreground))' : stageColors(j.ok ? 'booked' : 'needs_you').dot }} />{j.label}<span className="text-muted-foreground">{j.minutes_ago === null ? '—' : ago(j.last_run)}</span></span>)}</div>
          </section>); })()}

        {/* Signals */}
        <section className="panel overflow-hidden">
          <h2 className="flex items-center gap-2 border-b px-5 py-4 text-sm font-semibold"><Activity size={16} />Open signals <span className="text-muted-foreground">{data.signals.length}</span></h2>
          {!data.signals.length ? <p className="p-6 text-center text-sm text-muted-foreground">Nothing needs attention.</p> : <ul className="divide-y">{data.signals.map(s => { const c = stageColors(TONE[s.severity] || 'talking'); const Icon = s.severity === 'info' ? Info : AlertTriangle; return (
            <li key={s.id} className="flex flex-wrap items-start gap-3 px-5 py-3.5" style={{ boxShadow: `inset 3px 0 0 ${c.dot}` }}>
              <Icon size={16} className="mt-0.5 shrink-0" style={{ color: c.dot }} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{s.title}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{s.agent_email && <span className="font-medium text-foreground">{s.agent_email} · </span>}{s.detail}</p>
                <p className="mt-1 text-[10px] text-muted-foreground">{s.kind.replace(/_/g, ' ')} · first {ago(s.first_seen_at)} · last {ago(s.last_seen_at)}{s.occurrences > 1 ? ` · seen ${s.occurrences}×` : ''}{s.agent_notified_at ? ` · agent emailed ${ago(s.agent_notified_at)}` : ''}{s.owner_notified_at ? ` · you were alerted ${ago(s.owner_notified_at)}` : ''}</p>
              </div>
              <Button size="sm" variant="ghost" loading={busy === `resolve:${s.key}`} onClick={() => resolveKey(s.key)}>{busy === `resolve:${s.key}` ? 'Resolving' : 'Resolve'}</Button>
            </li>); })}</ul>}
        </section>

        {/* Growth + activity */}
        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Monthly recurring revenue" value={usd(data.growth.mrr_cents)} sub={`${data.growth.paying} paying${data.growth.trialing ? ` · ${data.growth.trialing} trialing` : ''}`} />
          <Stat label="Signups" value={data.growth.signups_7d} sub={`last 7 days · ${data.growth.signups_30d} in 30 days`} />
          <Stat label="Texts sent (7d)" value={data.activity.texts_7d.toLocaleString()} sub={`${data.activity.texts_24h.toLocaleString()} in the last 24h`} />
          <Stat label="Reply rate (7d)" value={`${data.activity.reply_rate_7d}%`} sub={`${data.activity.replies_7d.toLocaleString()} replies · ${data.activity.booked_7d} booked · ${data.activity.closed_7d} closed`} />
        </section>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* Funnel */}
          <section className="panel p-5">
            <h2 className="flex items-center gap-2 text-sm font-semibold"><TrendingUp size={16} />Agent launch funnel</h2>
            <p className="mt-1 text-xs text-muted-foreground">Where new agents drop off. Stalled agents get nudged automatically at 1, 3 and 7 days.</p>
            <ol className="mt-4 space-y-2.5">{data.funnel.map(([label, n], i) => { const top = data.funnel[0][1] || 1; const prev = i ? data.funnel[i - 1][1] : n; const pct = Math.round((n / top) * 100); const tones = ['waiting', 'texting', 'texting', 'talking', 'talking', 'booked', 'client']; const c = stageColors(tones[i]); return (
              <li key={label}><div className="flex justify-between text-xs"><span>{label}</span><span className="tabular-nums text-muted-foreground">{n}{i > 0 && prev ? ` · ${Math.round((n / prev) * 100)}% of previous` : ''}</span></div>
                <div className="mt-1 h-2 overflow-hidden rounded-full" style={{ background: c.soft }}><div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct}%`, background: c.dot }} /></div></li>); })}</ol>
          </section>

          {/* AI + rehearsal */}
          <div className="space-y-6">
            <section className="panel p-5">
              <h2 className="flex items-center gap-2 text-sm font-semibold"><Bot size={16} />AI engine today</h2>
              <div className="mt-3 grid grid-cols-3 gap-3 text-center">
                <div><p className="text-xl font-semibold tabular-nums">{data.ai.own_today}</p><p className="text-[11px] text-muted-foreground">On your key</p></div>
                <div><p className="text-xl font-semibold tabular-nums" style={{ color: data.ai.fallback_today ? stageColors('needs_you').ink : undefined }}>{data.ai.fallback_today}</p><p className="text-[11px] text-muted-foreground">Fell back</p></div>
                <div><p className="text-xl font-semibold tabular-nums">{data.ai.base44_today}</p><p className="text-[11px] text-muted-foreground">Base44 credits</p></div>
              </div>
            </section>
            <RehearsalCard last={data.rehearsal} onChange={refetch} />
          </div>
        </div>

        {/* Help inbox */}
        <section className="panel overflow-hidden">
          <h2 className="flex items-center gap-2 border-b px-5 py-4 text-sm font-semibold"><LifeBuoy size={16} />Help requests <span className="text-muted-foreground">{data.help.length} open</span></h2>
          {!data.help.length ? <p className="p-6 text-center text-sm text-muted-foreground">No open requests.</p> : <ul className="divide-y">{data.help.map(r => <HelpItem key={r.id} r={r} onDone={refetch} />)}</ul>}
        </section>
      </div>}
    </div>
  );
}
