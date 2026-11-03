import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Bone } from '@/components/system/Loaders';
import { call } from '@/components/workspace/api';
import { useAction } from '@/lib/feedback';

/** Getting live: progress, the one next step, and the full list on demand. Hidden once live. */
export default function SetupChecklist() {
  const { data, isLoading, refetch } = useQuery({ queryKey: ['launch'], queryFn: () => call('launch', {}), refetchInterval: 30000 });
  const [open, setOpen] = useState(false);
  const { run, busy } = useAction();
  const [sent, setSent] = useState(false);

  if (isLoading) return <div className="panel p-5"><Bone className="h-4 w-48" /><Bone className="mt-3 h-1.5 w-full" /></div>;
  if (!data || (data.live && data.items.every(i => i.done))) return null;

  const done = data.items.filter(i => i.done).length;
  const total = data.items.length;
  const next = data.items.find(i => !i.done);

  async function sendTest() {
    const ok = await run('test', async () => { await call('launch', { action: 'send_test' }); return true; }, {
      ok: 'Test text sent',
      detail: 'Reply YES from your phone. This list checks itself off when your reply arrives.',
    });
    if (ok) { setSent(true); await refetch(); }
  }

  return (
    <section className="panel border-primary/40 ring-1 ring-primary/15" aria-label="Setup">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3 p-5">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="section-title">{data.live ? 'Finish setting up' : 'Get your texting live'}</h2>
            <span className="text-sm text-muted-foreground tabular-nums">{done} of {total} done</span>
          </div>
          <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${(done / total) * 100}%` }} /></div>
          {next && <p className="mt-2.5 text-sm text-muted-foreground">Next: <span className="font-medium text-foreground">{next.label}</span>{next.detail ? `. ${next.detail}` : ''}</p>}
          {next?.key === 'test' && !data.can_test && <p className="mt-1.5 text-sm text-muted-foreground">Test texts unlock once your texting registration is approved.</p>}
          {next?.key === 'test' && sent && <p role="status" className="lr-rise mt-1.5 text-sm font-medium text-foreground">Now reply YES from your phone.</p>}
        </div>
        {next && (next.key === 'test'
          ? <Button size="lg" loading={busy === 'test'} disabled={!data.can_test} onClick={sendTest} title={data.can_test ? undefined : 'Available once your registration is approved'}>{busy === 'test' ? 'Sending' : next.detail || sent ? 'Resend test text' : 'Text me a test'}</Button>
          : <Button size="lg" asChild><Link to={next.href || '/dashboard'}>Continue</Link></Button>)}
      </div>
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} className="flex w-full items-center justify-center gap-1 border-t py-2 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground">
        {open ? 'Hide steps' : 'All steps'}<ChevronDown size={15} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <ol className="divide-y border-t">
          {data.items.map(item => {
            const body = (<>
              <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${item.done ? 'border-primary bg-primary text-primary-foreground' : 'border-input'}`}>{item.done && <Check size={12} strokeWidth={3} />}</span>
              <span className={`flex-1 ${item.done ? 'text-muted-foreground' : ''}`}>{item.label}</span>
              {item.detail && <span className="hidden max-w-[45%] truncate text-xs text-muted-foreground sm:block">{item.detail}</span>}
            </>);
            const linked = !item.done && item.href && item.href !== '/dashboard';
            return (
              <li key={item.key}>
                {linked
                  ? <Link to={item.href} className="flex items-center gap-3 px-5 py-3 text-sm transition-colors hover:bg-muted/50">{body}</Link>
                  : <div className="flex items-center gap-3 px-5 py-3 text-sm">{body}</div>}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
