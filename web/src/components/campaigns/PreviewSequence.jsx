import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { call } from '@/components/workspace/api';

const factLabels = { first_name: 'Name', city: 'City', state: 'State', age: 'Age', inquiry_when: 'When they asked', months_since_inquiry: 'Months since', lead_source: 'Lead source', product_interest: 'Interested in', coverage_requested: 'Coverage asked', who_to_protect: 'Who they protect', dependents: 'Dependents', reason_in_their_words: 'Their reason', driver_type: 'Driver type', years_driving: 'Years driving', home_time_pattern: 'Home time', has_retirement_plan: 'Retirement plan', prior_outcome: 'Prior outcome', prior_notes: 'Agent notes', crm_notes: 'CRM notes', other_details: 'Other details', tags: 'Tags', priority_reply: 'Priority', occupation: 'Occupation', extra_details: 'Extra details' };
const slotLabel = { am: 'morning', pm: 'afternoon' };

/** Writes the first texts of the series for a sample person so the agent sees exactly what goes out. Nothing is sent. */
export default function PreviewSequence({ campaign, onClose }) {
  const samples = useQuery({ queryKey: ['preview-samples', campaign.id], queryFn: () => call('previewSequence', { action: 'samples', campaign_id: campaign.id }) });
  const [sample, setSample] = useState('');
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const list = samples.data?.samples || [];
  useEffect(() => { if (!sample && list.length) setSample(list[0].key); }, [list, sample]);

  async function run() {
    setBusy(true); setError(''); setData(null);
    try { setData(await call('previewSequence', { campaign_id: campaign.id, sample, limit: 8 })); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  return (
    <Dialog open onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-h-[94dvh] max-w-3xl overflow-auto">
        <DialogHeader>
          <DialogTitle>Preview the texts</DialogTitle>
          <DialogDescription>Pick a sample person. The AI writes the first texts of the series for them from their profile and notes, then checks each one against your compliance rules. Nothing is sent.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 sm:grid-cols-3">
          {samples.isLoading && [0, 1, 2].map(i => <div key={i} className="h-16 rounded-lg bg-muted lr-shimmer" />)}
          {list.map(s => {
            const [name, note] = String(s.label).split(' · ');
            return (
              <button key={s.key} type="button" disabled={busy} onClick={() => setSample(s.key)} className={`rounded-lg border p-3 text-left transition-colors ${sample === s.key ? 'border-primary bg-primary/5' : 'bg-card hover:bg-muted/50'}`}>
                <span className="block text-sm font-medium">{name}</span>
                {note && <span className="mt-0.5 block text-xs text-muted-foreground">{note}</span>}
              </button>
            );
          })}
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">{busy ? 'About a minute. Each text is written, checked, and rewritten once if it misses a rule.' : 'Shows the first 8 texts of the series.'}</p>
          <Button onClick={run} disabled={busy || !sample}>{busy && <Loader2 className="animate-spin" />}{busy ? 'Writing…' : data ? 'Write again' : 'Write the texts'}</Button>
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {data && (
          <div className="space-y-4">
            <details className="rounded-lg border p-3 text-sm">
              <summary className="cursor-pointer font-medium">What the AI knows about {data.profile.first_name}</summary>
              <dl className="mt-3 grid gap-x-4 gap-y-2 sm:grid-cols-2">{Object.entries(data.profile).map(([k, v]) => <div key={k}><dt className="text-xs text-muted-foreground">{factLabels[k] || k}</dt><dd className="text-sm">{String(v)}</dd></div>)}</dl>
            </details>
            <ol className="space-y-3">
              {data.results.map(r => (
                <li key={`${r.step_number}${r.variant}`} className="rounded-lg border p-4">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span><span className="font-medium text-foreground">Text {r.step_number}{r.variant === 'none' ? '' : ` (version ${r.variant})`}</span> · Day {Number(r.day_offset) + 1}{r.slot ? `, ${slotLabel[r.slot]}` : ''} · {r.lever}</span>
                    <span>{r.personalized ? 'Written for them' : 'Template'}</span>
                  </div>
                  <p className="rounded-2xl rounded-br-md bg-primary px-3.5 py-2.5 text-sm leading-6 text-primary-foreground">{r.text}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="tabular-nums">{r.characters} characters</span>
                    {r.angle && <span>· {r.angle}</span>}
                    {r.facts_used?.map(f => <span key={f} className="rounded-md bg-muted px-1.5">{factLabels[f] || f}</span>)}
                  </div>
                  {!r.personalized && r.fallback_reason && <p className="mt-2 text-xs text-muted-foreground">Used the template because: {r.fallback_reason}</p>}
                </li>
              ))}
            </ol>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
