import { STAGE_STYLE, stageOf, stageColors, stageLabel } from '@/lib/stages';

// Non-lead statuses (campaigns, appointments) keep a neutral look.
const OTHER = { active: ['Active', 'booked'], draft: ['Not started', 'closed'], paused: ['Paused', 'closed'], pending: ['Pending', 'needs_you'], cancelled: ['Cancelled', 'closed'], rescheduled: ['Rescheduled', 'texting'], not_enrolled: ['Not enrolled', 'waiting'] };

/** Pill with the stage's color. Pass a lead status (and optionally its track) or a stage key. */
export default function StatusChip({ status = 'draft', track, className = '', label: override }) {
  let stage, label;
  if (OTHER[status] && !STAGE_STYLE[status]) { [label, stage] = OTHER[status]; if (override) label = override; }
  else { stage = STAGE_STYLE[status] ? status : stageOf(status, track); label = stageLabel(stage); }
  const c = stageColors(stage);
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium ${className}`} style={{ background: c.soft, color: c.ink }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: c.dot }} />{label}
    </span>
  );
}
