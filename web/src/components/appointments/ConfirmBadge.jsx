import { stageColors } from '@/lib/stages';

const STATES = {
  confirmed: ['Confirmed', 'booked'],
  pending: ['Not confirmed yet', 'closed'],
  reschedule: ['Wants to reschedule', 'needs_you'],
};

/** Whether the lead confirmed their call (they reply to the reminder text). */
export default function ConfirmBadge({ c }) {
  const m = STATES[c];
  if (!m) return null;
  const col = stageColors(m[1]);
  return <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: col.ink }}><span className="h-1.5 w-1.5 rounded-full" style={{ background: col.dot }} />{m[0]}</span>;
}
