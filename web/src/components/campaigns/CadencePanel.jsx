import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { call } from '@/components/workspace/api';
import { useAction } from '@/lib/feedback';

const DAYS = 60;

/** Day-by-day picture of a cadence: one column per day, a dot per text. */
function Timeline({ steps }) {
  const perDay = Array.from({ length: DAYS }, () => []);
  for (const st of steps) if (st.day < DAYS) perDay[st.day].push(st);
  return (
    <div>
      <div className="flex h-9 items-end gap-[2px]" aria-hidden="true">
        {perDay.map((list, d) => (
          <div key={d} className="flex flex-1 flex-col-reverse gap-[2px]" title={`Day ${d + 1}: ${list.length} text${list.length === 1 ? '' : 's'}`}>
            {list.map(st => <span key={st.step} className={`h-2.5 rounded-[2px] ${st.kind === 'opener' ? 'bg-foreground' : st.kind === 'breakup' || st.kind === 'close' ? 'bg-muted-foreground/60' : 'bg-primary'}`} />)}
            {!list.length && <span className="h-[3px] rounded-[1px] bg-border" />}
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-xs text-muted-foreground tabular-nums"><span>Day 1</span><span>Day 30</span><span>Day 60</span></div>
    </div>
  );
}

/** Lets the agent choose how hard the campaign follows up, and shows exactly what that means. */
export default function CadencePanel({ campaign }) {
  const { data } = useQuery({ queryKey: ['cadence', campaign.id], queryFn: () => call('playbooks', { action: 'cadence', campaign_id: campaign.id }), staleTime: 300000 });
  const { run, busy } = useAction();
  const [flash, setFlash] = useState(0);
  if (!data?.options) return null;
  const current = data.cadence;
  const active = data.options.find(o => o.key === current) || data.options[0];
  const texts = active.steps.length;

  async function choose(key) {
    if (key === current) return;
    const label = data.options.find(o => o.key === key)?.label || 'New cadence';
    const ok = await run(key, async () => { await call('playbooks', { action: 'set_cadence', campaign_id: campaign.id, cadence: key }); return true; }, {
      ok: 'Cadence changed',
      detail: `New leads in ${campaign.name} start on ${label.toLowerCase()}.`,
      invalidate: [['cadence', campaign.id], ['campaigns']],
    });
    if (ok) setFlash(f => f + 1);
  }

  return (
    <section className="rounded-lg border">
      <div className="border-b px-4 py-3">
        <h3 className="text-sm font-medium">Follow-up cadence</h3>
        <p className="mt-0.5 text-[13px] text-muted-foreground">Texts go out Monday to Saturday, 10am to 5:30pm in each lead's time zone. Never on Sundays or holidays, never more than 3 in 24 hours, and the series stops the moment someone replies.</p>
      </div>
      <div className="grid gap-px bg-border sm:grid-cols-2">
        {data.options.map(o => {
          const on = o.key === current;
          return (
            <button key={o.key} type="button" onClick={() => choose(o.key)} disabled={!!busy} aria-pressed={on} aria-busy={busy === o.key || undefined} className={`bg-card p-4 text-left transition-colors ${on ? (flash ? 'lr-done' : '') : 'hover:bg-muted/40'} ${busy === o.key ? 'animate-pulse' : ''}`}>
              <span className="flex items-center gap-2">
                <span className={`flex h-4 w-4 items-center justify-center rounded-full border ${on ? 'border-primary' : 'border-input'}`}>{on && <span className="h-2 w-2 rounded-full bg-primary" />}</span>
                <span className="text-sm font-medium">{o.label}</span>
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">{busy === o.key ? 'Saving' : `${o.steps.length} texts`}</span>
              </span>
              <span className="mt-1.5 block text-[13px] text-muted-foreground">{o.description}</span>
            </button>
          );
        })}
      </div>
      <div className="space-y-2 border-t px-4 py-3">
        <Timeline steps={active.steps} />
        <p className="text-xs text-muted-foreground">{texts} texts at most per lead. Fewer go out on Sundays and holidays. New leads start on this cadence; leads already in the series keep the one they started with.</p>
      </div>
    </section>
  );
}
