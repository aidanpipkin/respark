// The one place lead stages get their name and color. Every screen (chips, the Leads board,
// the Pipeline, the Inbox) reads from here, so a stage always looks the same everywhere.

export const STAGE_STYLE = {
  waiting:   { label: 'Waiting to start', tone: 'waiting' },
  texting:   { label: 'Being texted',     tone: 'texting' },
  talking:   { label: 'Talking',          tone: 'talking' },
  needs_you: { label: 'Needs you',        tone: 'needs_you' },
  booked:    { label: 'Booked',           tone: 'booked' },
  held:      { label: 'Call held',        tone: 'booked' },
  no_show:   { label: 'No-show',          tone: 'no_show' },
  follow_up: { label: 'Follow-up',        tone: 'follow_up' },
  lost_banking: { label: 'Lost at banking', tone: 'lost' },
  lost_social:  { label: 'Lost at social',  tone: 'lost' },
  after_call: { label: 'After the call',  tone: 'follow_up' },
  client:    { label: 'Client',           tone: 'client' },
  closed:    { label: 'Closed out',       tone: 'closed' },
  not_interested: { label: 'Not interested', tone: 'closed' },
  opted_out: { label: 'Opted out',        tone: 'opted_out' },
};

const STATUS_TO_STAGE = {
  queued: 'waiting', in_sequence: 'texting', replied: 'talking', engaged: 'talking', needs_human: 'needs_you',
  booked: 'booked', held: 'held', no_show: 'no_show', client: 'client', closed: 'closed',
  not_interested: 'not_interested', opted_out: 'opted_out',
  // Board / filter keys map to themselves.
  waiting: 'waiting', texting: 'texting', talking: 'talking', needs_you: 'needs_you', after_call: 'after_call',
  clients: 'client', closed_out: 'closed', follow_up: 'follow_up', lost_banking: 'lost_banking', lost_social: 'lost_social',
};

/** Stage for a lead (an active post-call track wins over the raw status). */
export function stageOf(status, track) {
  if (track && ['no_show', 'follow_up', 'lost_banking', 'lost_social'].includes(track) && !['client', 'opted_out', 'not_interested'].includes(status)) return track;
  return STATUS_TO_STAGE[status] || 'waiting';
}

/** Colors for a stage, as inline styles. */
export function stageColors(stage) {
  const t = (STAGE_STYLE[stage] || STAGE_STYLE.waiting).tone;
  return {
    dot: `hsl(var(--st-${t}))`,
    ink: `hsl(var(--st-${t}-ink))`,
    soft: `hsl(var(--st-${t}) / 0.13)`,
    faint: `hsl(var(--st-${t}) / 0.06)`,
    line: `hsl(var(--st-${t}) / 0.35)`,
  };
}

export const stageLabel = stage => (STAGE_STYLE[stage] || {}).label || String(stage || '').replace(/_/g, ' ');
