import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { call } from '@/components/workspace/api';
import { Bone } from '@/components/system/Loaders';

const rate = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '—');

/** Campaign numbers and the opening-text A/B test. */
export default function CampaignMetrics({ campaign }) {
  const { data, error, isLoading } = useQuery({
    queryKey: ['campaign-metrics', campaign.id], staleTime: 60000,
    queryFn: async () => {
      const L = base44.entities.Lead, q = { campaign_id: campaign.id };
      const has = f => ({ [f]: { $exists: true, $ne: '' } });
      const [loaded, progress, replied, ...ab] = await Promise.all([
        L.count(q), call('campaignProgress', { campaign_id: campaign.id }), L.count({ ...q, ...has('last_inbound_at') }),
        ...['A', 'B'].flatMap(v => [L.count({ ...q, variant: v, ...has('last_outbound_at') }), L.count({ ...q, variant: v, ...has('last_inbound_at') }), L.count({ ...q, variant: v, status: { $in: ['booked', 'held', 'no_show'] } })]),
      ]);
      const statuses = Object.fromEntries((progress.statuses || []).map(r => [r.status, r.count]));
      return { loaded, replied, statuses, A: { texted: ab[0], replied: ab[1], booked: ab[2] }, B: { texted: ab[3], replied: ab[4], booked: ab[5] } };
    },
  });
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  const stats = [['Leads', data?.loaded], ['Being texted', data?.statuses.in_sequence], ['Replied', data?.replied], ['Booked', data?.statuses.booked], ['Opted out', data?.statuses.opted_out]];
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-5">
        {stats.map(([label, value], i) => <div key={label} className={`bg-card px-3 py-2.5 ${i === stats.length - 1 && stats.length % 2 ? 'col-span-2 sm:col-span-1' : ''}`}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-0.5 text-lg font-semibold tabular-nums">{isLoading ? <Bone className="mt-1 h-5 w-10" /> : (value ?? 0).toLocaleString()}</dd></div>)}
      </dl>
      {campaign.ab_enabled !== false && !((data?.A?.texted || 0) + (data?.B?.texted || 0)) && (
        <p className="text-[13px] text-muted-foreground">Testing two opening texts{campaign.ab_lead_cap ? ` on the first ${campaign.ab_lead_cap} leads` : ''}. Results show here once texts go out, and the better one takes over.</p>
      )}
      {campaign.ab_enabled !== false && ((data?.A?.texted || 0) + (data?.B?.texted || 0)) > 0 && (
        <p className="text-[13px] text-muted-foreground">
          Opening text test{campaign.ab_lead_cap ? ` (first ${campaign.ab_lead_cap} leads)` : ''}: version A {rate(data?.A.replied, data?.A.texted)} replied, {rate(data?.A.booked, data?.A.texted)} booked. Version B {rate(data?.B.replied, data?.B.texted)} replied, {rate(data?.B.booked, data?.B.texted)} booked.{campaign.ab_winner ? ` Version ${campaign.ab_winner} won.` : ''}
        </p>
      )}
    </div>
  );
}
