import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CalendarClock } from 'lucide-react';
import { call } from '@/components/workspace/api';
import { stageColors } from '@/lib/stages';

const WEEK = 7 * 86400000;

/** Shown when the AI has almost no call times to offer in the next week. Quiet otherwise. */
export default function ThinCalendarBanner({ className = '' }) {
  const { data } = useQuery({ queryKey: ['open-times', 'calendar'], queryFn: () => call('availability', { action: 'slots' }), staleTime: 120000, retry: false });
  if (!data) return null;
  const week = (data.slots || []).filter(t => Date.parse(t) < Date.now() + WEEK).length;
  if (week >= 10) return null;
  const c = stageColors('needs_you');
  return (
    <div className={`flex flex-wrap items-center gap-3 rounded-xl p-4 text-sm lr-rise ${className}`} style={{ background: c.soft, color: c.ink }}>
      <CalendarClock size={18} className="shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{week === 0 ? 'No open call times in the next 7 days' : `Only ${week} open call ${week === 1 ? 'time' : 'times'} in the next 7 days`}</p>
        <p className="opacity-90">When the AI runs out of times, interested leads are held for you instead of booked. Open a few more hours or unlink the calendar that is blocking them.</p>
      </div>
      <Link to="/setup/calendar" className="shrink-0 rounded-md bg-white/70 px-3 py-1.5 font-medium hover:bg-white">Open more hours</Link>
    </div>
  );
}
