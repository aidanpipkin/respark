import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Info, X } from 'lucide-react';
import { base44 } from '@/api/base44Client';
import { stageColors } from '@/lib/stages';
import { notify } from '@/lib/feedback';

const TONE = { critical: 'needs_you', warning: 'client', info: 'talking' };
const ORDER = { critical: 0, warning: 1, info: 2 };
const STORE = 'lr-hidden-alerts';

/** Problems on the agent's account that they can fix, most urgent first. */
export default function AccountAlerts({ email }) {
  const { data } = useQuery({
    queryKey: ['account-alerts', email], enabled: !!email, refetchInterval: 120000, staleTime: 60000, retry: false,
    queryFn: () => base44.entities.SystemEvent.filter({ agent_email: email, agent_visible: true, status: 'open' }, { sort: '-last_seen_at', limit: 5 }),
  });
  const [hidden, setHidden] = useState(() => { try { return JSON.parse(sessionStorage.getItem(STORE) || '[]'); } catch { return []; } });
  const items = (data?.items || [])
    .filter(a => !hidden.includes(`${a.key}:${a.occurrences}`))
    .sort((a, b) => (ORDER[a.severity] ?? 3) - (ORDER[b.severity] ?? 3));
  if (!items.length) return null;

  function hide(a) {
    const next = [...hidden, `${a.key}:${a.occurrences}`];
    setHidden(next);
    try { sessionStorage.setItem(STORE, JSON.stringify(next)); } catch { /* storage blocked */ }
    notify.ok('Alert dismissed', 'It comes back if the problem happens again.');
  }

  return (
    <div className="mb-6 space-y-2" data-print-hide>
      {items.map(a => {
        const c = stageColors(TONE[a.severity] || 'talking');
        const Icon = a.severity === 'info' ? Info : AlertTriangle;
        return (
          <div key={a.id} role={a.severity === 'critical' ? 'alert' : 'status'} className="lr-rise flex items-start gap-3 rounded-lg border px-4 py-3" style={{ background: c.faint, borderColor: c.line }}>
            <Icon size={17} className="mt-0.5 shrink-0" style={{ color: c.dot }} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium" style={{ color: c.ink }}>{a.title}</p>
              {a.detail && <p className="mt-0.5 text-sm text-muted-foreground">{a.detail}</p>}
              {a.action_href && <Link to={a.action_href} className="mt-1.5 inline-block text-sm font-medium underline-offset-4 hover:underline" style={{ color: c.ink }}>{a.action_label || 'Fix this'}</Link>}
            </div>
            {a.severity !== 'critical' && <button type="button" aria-label="Dismiss" onClick={() => hide(a)} className="-mr-1 rounded-md p-1 text-muted-foreground hover:bg-black/5"><X size={15} /></button>}
          </div>
        );
      })}
    </div>
  );
}
