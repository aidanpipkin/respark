// Agent launch checklist: status, send the two-way test text, and go live automatically.
import { setupContext } from '../../shared/setupAccess.ts';
import { failure } from '../../shared/ghl.ts';
import { readiness, sendSelfTest, tryActivate } from '../../shared/readiness.ts';

export default async function (req: Request) {
  try {
    const { E, s } = await setupContext(req);
    const input = await req.json().catch(() => ({}));
    if (input.action === 'send_test') await sendSelfTest(E, s);
    let fresh = (await E.AgentSettings.filter({ agent_email: s.agent_email }, { limit: 1 })).items[0] || s;
    if (await tryActivate(E, fresh)) fresh = (await E.AgentSettings.filter({ agent_email: s.agent_email }, { limit: 1 })).items[0];
    return Response.json(await readiness(E, fresh), { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return failure(e as Error); }
}
