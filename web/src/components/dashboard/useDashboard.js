import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';

export const RANGES = [
  { key: 'today', label: 'Today', days: 0 },
  { key: '7d', label: '7 days', days: 6 },
  { key: '30d', label: '30 days', days: 29 },
  { key: '90d', label: '90 days', days: 89 },
];

/** Home page numbers for one agent, a time range and (optionally) one campaign. */
export default function useDashboard(email, range, campaign) {
  return useQuery({
    queryKey: ['dashboard', email, range, campaign],
    enabled: !!email,
    staleTime: 60000,
    queryFn: async () => {
      const L = base44.entities.Lead, A = base44.entities.Appointment;
      const now = new Date();
      const start = new Date(now); start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - (RANGES.find(r => r.key === range)?.days ?? 6));
      const scope = { agent_email: email, ...(campaign === 'all' ? {} : { campaign_id: campaign }) };
      const dates = { $gte: start.toISOString(), $lte: now.toISOString() };
      const week = { $gte: now.toISOString(), $lte: new Date(+now + 7 * 86400000).toISOString() };
      const [texted, replied, booked, held, optOuts, upcoming, needs, needsCount] = await Promise.all([
        L.count({ ...scope, last_outbound_at: dates }),
        L.count({ ...scope, last_inbound_at: dates }),
        A.count({ ...scope, status: { $in: ['booked', 'held', 'no_show', 'rescheduled'] }, created_date: dates }),
        A.count({ ...scope, status: 'held', start_time: dates }),
        L.count({ ...scope, status: 'opted_out', last_inbound_at: dates }),
        A.filter({ ...scope, status: { $in: ['booked', 'rescheduled'] }, start_time: week }, { sort: 'start_time', limit: 6 }),
        L.filter({ ...scope, status: 'needs_human' }, { sort: '-last_inbound_at', limit: 6 }),
        L.count({ ...scope, status: 'needs_human' }),
      ]);
      return { texted, replied, booked, held, optOuts, upcoming: upcoming.items, needs: needs.items, needsCount };
    },
  });
}
