// Authenticates GHL webhook deliveries to ghlWebhook.
//
//   1. Marketplace events carry an Ed25519 signature (x-ghl-signature) over the raw body, verified with
//      GHL's public key. The handler still has to match the event's locationId to a workspace.
//   2. Custom automations call `ghlWebhook?secret=<per-agent secret>`; the secret is minted by adminMessaging
//      ({action:'webhook'} / 'rotate_webhook') onto agent_settings.ghl_webhook_secret. The caller is then
//      bound to that one agent: the handler requires the event's locationId to equal the agent's location_id.
//   3. The platform-wide RESPARK_WEBHOOK_SECRET is only accepted while GHL_LEGACY_WEBHOOK_SECRET_OK=true
//      (transition window for automations that still carry the old URL). Default off.
import { secrets, timingSafeEqual } from './runtime.ts';
import { getSql } from './entities.ts';

const publicKey = 'MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=';
const bytes = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

export type WebhookAgent = { id: string; agent_email: string; location_id: string };
export type WebhookAuth = { ok: boolean; agent?: WebhookAgent; via?: 'signature' | 'agent_secret' | 'legacy_secret' };

/** A per-agent webhook secret: 32 lowercase hex characters (16 random bytes). */
export const validWebhookSecret = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{32}$/.test(s);
export const newWebhookSecret = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');

/** Reads `?secret=` from the delivery URL; '' when absent. Exported for tests. */
export function secretFromUrl(url: string): string {
  try { return new URL(url).searchParams.get('secret') || ''; } catch { return ''; }
}

export const legacySecretAllowed = () => /^(1|true|yes)$/i.test(String(Deno.env.get('GHL_LEGACY_WEBHOOK_SECRET_OK') || ''));

export async function authenticWebhook(req: Request, raw: string): Promise<WebhookAuth> {
  const signature = req.headers.get('x-ghl-signature');
  if (signature !== null) {
    try {
      const key = await crypto.subtle.importKey('spki', bytes(publicKey), { name: 'Ed25519' }, false, ['verify']);
      const ok = await crypto.subtle.verify('Ed25519', key, bytes(signature), new TextEncoder().encode(raw));
      return ok ? { ok: true, via: 'signature' } : { ok: false };
    } catch { return { ok: false }; }
  }
  const provided = secretFromUrl(req.url);
  if (!provided || provided.length > 128) return { ok: false };
  // Per-agent secret: a database lookup, so timing is not a concern; the format check keeps junk out of the query.
  if (validWebhookSecret(provided)) {
    const rows = await getSql()`select id, agent_email, location_id from public.agent_settings where ghl_webhook_secret = ${provided} limit 2`;
    if (rows.length === 1) {
      const r = rows[0] as { id: string; agent_email: string; location_id: string | null };
      return { ok: true, via: 'agent_secret', agent: { id: String(r.id), agent_email: String(r.agent_email || '').toLowerCase(), location_id: String(r.location_id || '') } };
    }
  }
  // Legacy platform-wide secret, transition window only.
  const legacy = secrets.get('RESPARK_WEBHOOK_SECRET') || '';
  if (legacy && legacySecretAllowed() && timingSafeEqual(provided, legacy)) return { ok: true, via: 'legacy_secret' };
  return { ok: false };
}
