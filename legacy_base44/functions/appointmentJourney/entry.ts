// Booked-call journey. Called by a workflow the moment an appointment is created or moved
// ({ appointment_id }) and by the 15-minute reminder sweep ({ action: 'run' }).
import { adminContext } from '../../shared/agentAccess.ts';
import { failure } from '../../shared/ghl.ts';
import { appOrigin } from '../../shared/agentSite.ts';
import { onBooked, runJourney } from '../../shared/appointmentJourney.ts';

export default async function (req: Request) {
  try {
    const { base44 } = await adminContext(req);
    const input = await req.json().catch(() => ({}));
    const origin = appOrigin(req);
    if (input.action === 'run') return Response.json(await runJourney(base44, origin));
    if (typeof input.appointment_id !== 'string') throw new Error('Choose an appointment.');
    return Response.json(await onBooked(base44, input.appointment_id, origin));
  } catch (error) { return failure(error as Error); }
}
