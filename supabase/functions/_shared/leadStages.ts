// The stages an agent thinks in, mapped onto lead fields. Shared by the Leads board, exports,
// saved views and the rehearsal, so a stage means exactly the same thing everywhere.
export const POST_CALL_TRACKS = ['no_show', 'follow_up', 'lost_banking', 'lost_social'];
const noTrack = { $or: [{ track: { $exists: false } }, { track: '' }, { track: null }, { track: null }] };

export const STAGE_QUERIES: Record<string, any> = {
  all: {},
  needs_you: { status: 'needs_human' },
  talking: { status: { $in: ['replied', 'engaged'] } },
  booked: { status: 'booked' },
  after_call: { $or: [{ track: { $in: POST_CALL_TRACKS } }, { status: { $in: ['held', 'no_show'] } }] },
  texting: { $and: [{ status: 'in_sequence' }, noTrack] },
  waiting: { status: 'queued' },
  clients: { status: 'client' },
  closed_out: { status: { $in: ['not_interested', 'closed'] } },
  opted_out: { status: 'opted_out' },
};

export const STAGE_LABELS: Record<string, string> = {
  all: 'All leads', needs_you: 'Needs you', talking: 'Talking', booked: 'Booked', after_call: 'After the call', texting: 'Being texted',
  waiting: 'Waiting to start', clients: 'Clients', closed_out: 'Closed out', opted_out: 'Opted out',
};

/** Plain-English stage for one lead (post-call tracks win over raw status). */
export function stageOfLead(l: any) {
  if (l.track && POST_CALL_TRACKS.includes(l.track) && !['client', 'opted_out', 'not_interested'].includes(l.status)) return 'after_call';
  return ({ queued: 'waiting', in_sequence: 'texting', replied: 'talking', engaged: 'talking', needs_human: 'needs_you', booked: 'booked', held: 'after_call', no_show: 'after_call', client: 'clients', closed: 'closed_out', not_interested: 'closed_out', opted_out: 'opted_out' } as Record<string, string>)[l.status] || 'waiting';
}
