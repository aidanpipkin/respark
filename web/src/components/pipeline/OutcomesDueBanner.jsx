import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { call } from '@/components/workspace/api';
import { Button } from '@/components/ui/button';

/** Reminds the agent to log outcomes; follow-up texts wait for it. */
export default function OutcomesDueBanner() {
  const { data } = useQuery({ queryKey: ['pipeline'], queryFn: () => call('outcomes', { action: 'board' }), staleTime: 60000 });
  const n = data?.needs_outcome?.length || 0;
  if (!n) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3" style={{ background: 'hsl(var(--st-needs_you) / 0.06)', borderColor: 'hsl(var(--st-needs_you) / 0.35)' }}>
      <p className="text-sm"><span className="font-medium">{n} call{n > 1 ? 's' : ''} need{n > 1 ? '' : 's'} an outcome.</span> <span className="text-muted-foreground">Follow-up texts start once you log what happened.</span></p>
      <Button size="sm" asChild><Link to="/pipeline">Log outcomes</Link></Button>
    </div>
  );
}
