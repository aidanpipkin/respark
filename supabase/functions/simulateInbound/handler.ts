// Simulates a reply from one of the agent's fictional test leads (reserved 555-01xx numbers).
// It goes through the SAME path a real Twilio inbound text takes after signature validation
// (recordInbound: STOP/HELP handling, lead status, inbox summary, agent alert, AI reply), with the
// AI reply awaited so the Inbox can show it. { lead_id, body, agent_email? (admins) }.
import { context } from '../_shared/ghl.ts';
import { actingSettings } from '../_shared/agentAccess.ts';
import { failure } from '../_shared/ghl.ts';
import { freshSettings } from '../_shared/ghlAuth.ts';
import { isTestPhone, fakeMessageId } from '../_shared/rehearsal.ts';
import { recordInbound } from '../_shared/messageWebhook.ts';
import { flushBumps } from '../_shared/signals.ts';

const TIME_CAP_MS = 60000;
const NOT_TEST = 'Only test leads (555-01xx numbers) can receive simulated replies.';

export default async function (req: Request) {
  try {
    const { base44, user } = await context(req);
    const input = await req.json().catch(() => ({}));
    const s = await freshSettings(base44, await actingSettings(base44, user, input));
    const E = base44.asServiceRole.entities;
    const body = String(input.body || '').trim().slice(0, 1600);
    if (!body) throw new Error('Type the reply the lead would send.');
    const lead = await E.Lead.get(String(input.lead_id || '')).catch(() => null);
    if (!lead || lead.agent_email !== s.agent_email) return Response.json({ error: NOT_TEST }, { status: 400 });
    if (!isTestPhone(lead.phone)) return Response.json({ error: NOT_TEST }, { status: 400 });

    const started = Date.now();
    const work = recordInbound(base44, s, { from: lead.phone, to: s.phone_number || '', body, messageSid: `SIM${fakeMessageId().slice(3)}`, at: new Date().toISOString() }, { quick: true });
    // The reply is awaited so the UI can show it, but never past the time cap (the record itself is already written).
    const timeout = new Promise<any>(r => setTimeout(() => r({ timed_out: true }), TIME_CAP_MS));
    const result: any = await Promise.race([work, timeout]);
    await flushBumps(E).catch(() => {});
    if (result?.timed_out) return Response.json({ logged: null, reply: { skipped: 'Still working; refresh the thread in a moment.' }, ms: Date.now() - started });
    if (result?.ignored) throw new Error('The simulated reply could not be recorded.');
    return Response.json({ logged: result.logged, duplicate: !!result.duplicate, stopped: !!result.stopped, reply: result.reply ?? null, ms: Date.now() - started });
  } catch (e) { return failure(e as Error); }
}
