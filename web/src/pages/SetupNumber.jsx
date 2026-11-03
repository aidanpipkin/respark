import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, Check, ArrowRight } from 'lucide-react';
import { notify } from '@/lib/feedback';
import { call } from '@/components/workspace/api';
import { Button } from '@/components/ui/button';
import { PanelSkeleton } from '@/components/system/Loaders';
import SetupShell from '@/components/setup/SetupShell';

const pretty = p => String(p || '').replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3');

export default function SetupNumber() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ['setup-status'], queryFn: () => call('getSetupStatus') });
  const [area, setArea] = useState('');
  const [results, setResults] = useState(null);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState('');
  const task = data?.tasks?.find(t => t.kind === 'phone_number');
  const pending = !!task && ['queued', 'working'].includes(task.status);
  const code = area || data?.area_code || '';

  async function search(e) {
    e.preventDefault();
    setBusy('search'); setPick('');
    try {
      setResults(await call('searchNumbers', { area_code: code }));
    }
    catch (x) { notify.err(x, 'Search failed'); } finally { setBusy(''); }
  }
  async function request(phone = '') {
    setBusy('buy');
    try {
      const res = await call('purchaseNumber', { confirmed: true, phone_number: phone, area_code: code });
      await Promise.all(['setup-status', 'launch', 'numbers'].map(k => qc.invalidateQueries({ queryKey: [k] })));
      // When the number is live, the setup shell announces the finished step and the next one.
      if (res.status !== 'done') notify.info('Request sent', "We'll email you when your number is ready. You can start texting registration meanwhile.", { label: 'Next: Texting registration', to: '/setup/texting-registration' });
    } catch (x) { notify.err(x, 'Could not get that number'); } finally { setBusy(''); }
  }

  return (
    <SetupShell title="Your texting number" description="Pick a local number. Your leads see texts and calls from it, and you can add more numbers later.">
      {isLoading ? <PanelSkeleton rows={3} /> : error ? <p className="text-sm text-destructive">{error.message}</p> : data.phone_number ? (
        <section className="panel flex flex-wrap items-center justify-between gap-3 p-4 lr-rise">
          <div className="flex items-center gap-3"><span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground lr-pop"><Check size={16} /></span><div><p className="text-sm text-muted-foreground">Your number</p><p className="text-lg font-semibold tabular-nums">{pretty(data.phone_number)}</p></div></div>
          <Button variant="outline" asChild><Link to="/numbers">Manage numbers</Link></Button>
        </section>
      ) : !data.checklist?.billing && data.card?.status !== 'card_saved' ? (
        <section className="panel flex flex-wrap items-center justify-between gap-3 p-4 text-sm"><span>Save your card on <Link to="/setup/billing" className="font-medium underline-offset-4 hover:underline">Plan &amp; billing</Link> first, then come back to pick your number.</span><Button size="sm" asChild><Link to="/setup/billing">Go to Plan &amp; billing<ArrowRight /></Link></Button></section>
      ) : (
        <>
          <form onSubmit={search} className="panel flex flex-wrap items-end gap-3 p-4">
            <label className="block w-40"><span className="field-label">Area code</span><input className="field" inputMode="numeric" pattern="[2-9][0-9]{2}" maxLength={3} required placeholder="314" value={code} onChange={e => setArea(e.target.value.replace(/\D/g, ''))} /></label>
            <Button type="submit" disabled={code.length !== 3} loading={busy === 'search'}>{busy !== 'search' && <Search />}Find numbers</Button>
            <p className="w-full text-xs text-muted-foreground">Choose an area code where most of your leads live. Local numbers get more replies.</p>
          </form>

          {results && (
            <section className="panel lr-rise">
              <div className="flex h-12 items-center border-b px-4"><h2 className="section-title">Available numbers</h2></div>
              {results.message && <p className="px-4 pt-3 text-sm text-muted-foreground">{results.message}</p>}
              {results.numbers.length > 0 && (
                <ul className="max-h-80 divide-y overflow-y-auto">
                  {results.numbers.map(n => (
                    <li key={n.phone_number}>
                      <button type="button" onClick={() => setPick(n.phone_number)} className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors ${pick === n.phone_number ? 'bg-primary/5' : 'hover:bg-muted/50'}`}>
                        <span className="flex items-center gap-3"><span className={`h-4 w-4 rounded-full border ${pick === n.phone_number ? 'border-[5px] border-primary' : 'border-input'}`} /><span className="text-sm font-medium tabular-nums">{pretty(n.phone_number)}</span></span>
                        <span className="truncate text-sm text-muted-foreground">{String(n.friendly_name || '').split('·')[1]?.trim() || ''}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap items-center justify-end gap-3 border-t p-3">
                {results.manual && <Button variant="outline" disabled={!!busy || pending} loading={busy === 'buy' && !pick} onClick={() => request()}>Ask us to find a number</Button>}
                {results.numbers.length > 0 && <Button disabled={!pick || (!!busy && busy !== 'buy') || pending} loading={busy === 'buy' && !!pick} onClick={() => request(pick)}>{busy === 'buy' ? 'Setting it up…' : pick ? `Get ${pretty(pick)}` : 'Choose a number'}</Button>}
              </div>
            </section>
          )}
          {task && task.status !== 'done' && <section className="panel p-4 lr-rise"><p className="text-sm font-medium">Request {task.status.replaceAll('_', ' ')}</p><p className="mt-1 text-sm text-muted-foreground">{task.public_note}</p>{pending && <Button size="sm" variant="outline" className="mt-3" asChild><Link to="/setup/texting-registration">Start texting registration meanwhile<ArrowRight /></Link></Button>}</section>}
        </>
      )}
    </SetupShell>
  );
}
