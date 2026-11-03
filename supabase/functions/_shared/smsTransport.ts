// Chooses how a text is sent. Agents whose number lives in their own Twilio subaccount text
// directly through Twilio (fully automated, no GHL phone mapping). Everyone else uses GHL.
import { ghl } from './ghl.ts';
import { isRehearsal, isTestLead, fakeMessageId } from './rehearsal.ts';
import { tw, subCred, API } from './twilio.ts';
import { numberForLead } from './numbers.ts';

export type Route = { kind: 'twilio'; sub: string; from: string; webhook: string; accountId: string; messagingServiceSid: string } | { kind: 'ghl' };

const cache = new Map<string, { at: number; route: Route }>();

export async function routeFor(E: any, s: any): Promise<Route> {
  const hit = cache.get(s.agent_email);
  if (hit && Date.now() - hit.at < 60000) return hit.route;
  let route: Route = { kind: 'ghl' };
  if (s.phone_number) {
    const acct = (await E.TwilioAccount.filter({ agent_email: s.agent_email }, { limit: 1 })).items[0];
    if (acct?.phone_number && acct.phone_number === s.phone_number && acct.subaccount_sid) {
      // The A2P Messaging Service (created by a2pEngine on A2PRegistration) carries the registered campaign; sends go
      // through it once it exists. Cached with the route, so it is one extra read a minute, not one per text.
      const reg = (await E.A2PRegistration.filter({ agent_email: s.agent_email }, { limit: 1, fields: ['messaging_service_sid'] }).catch(() => ({ items: [] }))).items[0];
      route = { kind: 'twilio', sub: acct.subaccount_sid, from: acct.phone_number, webhook: acct.webhook_url || '', accountId: acct.id, messagingServiceSid: String(reg?.messaging_service_sid || '') };
    }
  }
  cache.set(s.agent_email, { at: Date.now(), route });
  return route;
}

export function e164(v: any) {
  const d = String(v || '').replace(/[^\d+]/g, '');
  if (/^\+[1-9]\d{7,14}$/.test(d)) return d;
  if (/^\d{10}$/.test(d)) return `+1${d}`;
  if (/^1\d{10}$/.test(d)) return `+${d}`;
  return '';
}

export type SendTextOptions = {
  /** Ask Twilio for delivery receipts. Default true; the sequence skips them from step 2 on (only step 1 needs one). */
  statusCallback?: boolean;
};

/** Sends a text to a lead. Returns { messageId, conversationId }. */
export async function sendText(E: any, s: any, lead: any, text: string, opts: SendTextOptions = {}) {
  if (isRehearsal(s)) return { messageId: fakeMessageId(), conversationId: '', from: '' };
  // Fictional 555-01xx test leads: logged exactly like a real send, but no carrier or CRM is ever called.
  if (isTestLead(lead)) return { messageId: fakeMessageId(), conversationId: '', from: s.phone_number || '', test: true };
  const route = await routeFor(E, s);
  if (route.kind === 'twilio') {
    const to = e164(lead.phone);
    if (!to) throw new Error('This contact does not have a valid mobile number.');
    const cred = await subCred(route.sub);
    // Each lead always hears from the same business number (texts and calls).
    const from = await numberForLead(E, s, lead, route.from);
    // With a Messaging Service the text is sent under the registered A2P campaign; From keeps the lead's sticky number.
    const msg = await tw(cred, `${API}/Accounts/${cred.sid}/Messages.json`, { To: to, From: from, Body: text, ...(route.messagingServiceSid ? { MessagingServiceSid: route.messagingServiceSid } : {}), ...(route.webhook && opts.statusCallback !== false ? { StatusCallback: route.webhook } : {}) });
    if (['failed', 'undelivered'].includes(msg.status)) throw new Error(`The carrier rejected the text${msg.error_message ? `: ${msg.error_message}` : '.'}`);
    return { messageId: msg.sid as string, conversationId: '', from };
  }
  const result = await ghl(s, '/conversations/messages', 'POST', { type: 'SMS', contactId: lead.ghl_contact_id, message: text, fromNumber: s.phone_number });
  return { messageId: result.messageId as string, conversationId: (result.conversationId || '') as string, from: s.phone_number || '' };
}

/** Sends a plain alert text to a phone number (e.g. the agent's own mobile). */
export async function sendRawText(E: any, s: any, to: string, text: string) {
  if (isRehearsal(s)) return fakeMessageId();
  const route = await routeFor(E, s);
  if (route.kind !== 'twilio') return null;
  const cred = await subCred(route.sub);
  const msg = await tw(cred, `${API}/Accounts/${cred.sid}/Messages.json`, { To: e164(to), From: route.from, Body: text });
  return msg.sid as string;
}

/** Twilio request signature: base64(HMAC-SHA1(authToken, url + sorted key/value pairs)). */
export async function validTwilioSignature(authToken: string, url: string, params: Record<string, string>, signature: string) {
  if (!signature || !authToken) return false;
  const data = url + Object.keys(params).sort().map(k => k + params[k]).join('');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(authToken), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
  const expected = btoa(String.fromCharCode(...mac));
  if (expected.length !== signature.length) return false;
  let diff = 0; for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}
