import { createClientFromRequest } from '../_shared/runtime.ts';
import { resilient } from '../_shared/entityRetry.ts';
import { authenticWebhook } from '../_shared/webhookAuth.ts';
import { handleMessageEvent, handleAppointmentEvent } from '../_shared/messageWebhook.ts';
import { freshSettings } from '../_shared/ghlAuth.ts';

const TYPES = ['InboundMessage', 'OutboundMessage', 'AppointmentCreate', 'AppointmentUpdate', 'AppointmentDelete'];

export default async function (req: Request) {
  try {
    if (req.method !== 'POST') return Response.json({ error: 'Method not allowed' }, { status: 405 });
    const raw = await req.text();
    if (raw.length > 64000) return Response.json({ error: 'Payload too large' }, { status: 413 });
    const auth = await authenticWebhook(req, raw);
    if (!auth.ok) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    const event = JSON.parse(raw);
    if (typeof event.locationId !== 'string' || !event.locationId || event.locationId.length > 100) return Response.json({ error: 'Invalid location' }, { status: 400 });
    // A per-agent secret only speaks for that agent's workspace.
    if (auth.agent && event.locationId !== auth.agent.location_id) return Response.json({ error: 'Location does not match this webhook key' }, { status: 403 });
    if (!TYPES.includes(event.type)) return Response.json({ ignored: true });
    const base44 = resilient(createClientFromRequest(req)), E = base44.asServiceRole.entities;
    const page = await E.AgentSettings.filter({ location_id: event.locationId }, { limit: 2 });
    if (page.items.length !== 1) return Response.json({ error: 'Unknown or ambiguous account' }, { status: 400 });
    if (auth.agent && page.items[0].id !== auth.agent.id) return Response.json({ error: 'Location does not match this webhook key' }, { status: 403 });
    const s = await freshSettings(base44, page.items[0]);
    const result = event.type.includes('Message') ? await handleMessageEvent(base44, s, event) : await handleAppointmentEvent(base44, s, event);
    if (!s.onboarding_checks?.webhook_received && !result.ignored) {
      await E.AgentSettings.update(s.id, { onboarding_checks: { ...((s.onboarding_checks && typeof s.onboarding_checks === 'object') ? s.onboarding_checks : {}), webhook_received: true } }).catch(() => {});
    }
    return Response.json(result);
  } catch (error) {
    console.error('Webhook processing failed:', (error as Error).message);
    return Response.json({ error: 'Event could not be processed; retry delivery.' }, { status: 503 });
  }
}
