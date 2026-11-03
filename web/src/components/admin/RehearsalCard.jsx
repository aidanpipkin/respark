import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FlaskConical, Play, Square, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { call } from '@/components/workspace/api';
import { stageColors } from '@/lib/stages';
import { notify } from '@/lib/feedback';
import ConfirmButton from '@/components/workspace/ConfirmButton';

const speedTone = ms => stageColors(ms < 800 ? 'booked' : ms < 2000 ? 'client' : 'needs_you');

/** Dress rehearsal: thousands of fictional leads through the real engine with sending switched off. */
export default function RehearsalCard({ last, onChange }) {
  const [busy, setBusy] = useState('');
  const running = last?.status === 'running';
  const { data } = useQuery({ queryKey: ['rehearsal-status'], queryFn: () => call('rehearsal', { action: 'status' }), enabled: running, refetchInterval: running ? 30000 : false });
  const r = data?.rehearsal || last;
  const DONE = {
    start: ['Rehearsal started', 'Progress shows here and refreshes every 30 seconds.'],
    'start-ai': ['AI rehearsal started', 'About 100 AI calls on your key. Progress shows here.'],
    status: ['Progress updated', ''],
    stop: ['Rehearsal stopped', 'The fictional leads are being cleaned up.'],
    clean: ['Rehearsal data cleaned up', 'The fictional leads were removed.'],
  };
  async function act(action, extra = {}, key = action) {
    setBusy(key);
    try { await call('rehearsal', { action, ...extra }); await onChange?.(); const [t, d] = DONE[key] || ['Done', '']; notify.ok(t, d); }
    catch (e) { notify.err(e, 'Rehearsal action failed'); } finally { setBusy(''); }
  }
  const p = r?.progress;
  return (
    <section className="panel space-y-4 p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold"><FlaskConical size={16} />Dress rehearsal</h2>
          <p className="mt-1 text-xs text-muted-foreground">Runs fictional leads through the real engine with texting, billing and GHL switched off. Nothing is sent to anyone.</p>
        </div>
        {r && <span className="rounded-full px-2.5 py-1 text-[10px] font-semibold" style={{ background: stageColors(r.status === 'complete' ? 'booked' : r.status === 'running' ? 'texting' : 'closed').soft, color: stageColors(r.status === 'complete' ? 'booked' : r.status === 'running' ? 'texting' : 'closed').ink }}>{r.status}</span>}
      </div>

      {p && <div className="space-y-3">
        <div>
          <div className="flex justify-between text-xs"><span>{p.sent.toLocaleString()} texts processed</span><span className="tabular-nums text-muted-foreground">{p.percent}% of {p.total.toLocaleString()} leads started</span></div>
          <div className="mt-1 h-2 overflow-hidden rounded-full" style={{ background: stageColors('texting').soft }}><div className="h-full rounded-full transition-all duration-700" style={{ width: `${p.percent}%`, background: stageColors('texting').dot }} /></div>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center text-xs">
          <div className="rounded-lg bg-muted/50 p-2"><p className="text-base font-semibold tabular-nums">{r.throughput?.per_minute ?? 0}</p><p className="text-muted-foreground">texts/min</p></div>
          <div className="rounded-lg bg-muted/50 p-2"><p className="text-base font-semibold tabular-nums" style={{ color: p.flagged ? stageColors('needs_you').ink : undefined }}>{p.flagged}</p><p className="text-muted-foreground">flagged</p></div>
          <div className="rounded-lg bg-muted/50 p-2"><p className="text-base font-semibold tabular-nums" style={{ color: p.uncertain ? stageColors('needs_you').ink : undefined }}>{p.uncertain}</p><p className="text-muted-foreground">uncertain</p></div>
        </div>
        {r.speed_ms && <div><p className="mb-1.5 text-xs font-medium text-muted-foreground">Agent screens at {p.total.toLocaleString()} leads</p>
          <div className="flex flex-wrap gap-1.5">{[['Stage counts', r.speed_ms.leads_stage_counts], ['Leads list', r.speed_ms.leads_list], ['Search', r.speed_ms.leads_search], ['Inbox', r.speed_ms.inbox_list]].map(([l, ms]) => { const c = speedTone(ms); return <span key={l} className="rounded-full px-2.5 py-1 text-[11px]" style={{ background: c.soft, color: c.ink }}>{l}: {ms}ms</span>; })}</div></div>}
        {r.projection && <p className="text-[11px] text-muted-foreground">Real agents start {r.projection.real_agent_first_texts_per_day.toLocaleString()} new leads a day (25 every 5 minutes, inside sending hours), so 5,000 leads get their first text over about {r.projection.days_to_text_5000} days. Spreading sends out protects new numbers with the carriers.</p>}
        <p className="text-[10px] text-muted-foreground">Seeded in {Math.round((r.seed_ms || 0) / 1000)}s{r.checked_at ? ` · checked ${new Date(r.checked_at).toLocaleTimeString()}` : ''}{r.ai ? ' · AI writer on' : ' · AI writer off (templates)'}</p>
      </div>}

      <div className="flex flex-wrap gap-2">
        {!running ? <>
          <Button size="sm" className="gap-1.5" loading={busy === 'start'} disabled={!!busy} onClick={() => act('start', { count: 5000 })}>{busy !== 'start' && <Play size={13} />}{busy === 'start' ? 'Seeding 5,000 leads' : 'Run 5,000-lead rehearsal'}</Button>
          <Button size="sm" variant="outline" loading={busy === 'start-ai'} disabled={!!busy} onClick={() => act('start', { count: 100, ai: true }, 'start-ai')} title="Uses real AI calls on your key (about 100)">With AI (100 leads)</Button>
        </> : <>
          <Button size="sm" variant="outline" className="gap-1.5" disabled={!!busy} onClick={() => act('status')}><RefreshCw size={13} className={busy === 'status' ? 'animate-spin' : ''} />Check now</Button>
          <ConfirmButton size="sm" variant="ghost" className="gap-1.5" loading={busy === 'stop'} disabled={!!busy} title="Stop the rehearsal?" description="The run ends and every rehearsal lead, message and appointment is deleted. The measurements stay." confirmLabel="Stop and clean up" destructive onConfirm={() => act('stop')}>{busy !== 'stop' && <Square size={13} />}Stop and clean up</ConfirmButton>
        </>}
        {r && !running && r.status !== 'stopped' && <ConfirmButton size="sm" variant="ghost" loading={busy === 'clean'} disabled={!!busy} title="Delete the rehearsal data?" description="Every rehearsal lead, message and appointment is removed. The measurements stay." confirmLabel="Delete" destructive onConfirm={() => act('stop', {}, 'clean')}>Clean up data</ConfirmButton>}
      </div>
    </section>
  );
}
