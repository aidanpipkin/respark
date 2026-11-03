// Scheduled every 15 minutes: platform health checks, setup nudges and billing alerts.
import { adminContext } from '../../shared/agentAccess.ts';
import { failure } from '../../shared/ghl.ts';
import { runHealth } from '../../shared/health.ts';

export default async function (req: Request) {
  try {
    const { base44 } = await adminContext(req);
    return Response.json(await runHealth(base44));
  } catch (e) { return failure(e as Error); }
}
