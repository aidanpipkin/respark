// Public endpoint Twilio calls for (a) inbound texts to an agent's number and (b) delivery receipts.
// Every request is verified with the agent's Twilio subaccount signature before anything is read.
import { createClientFromRequest } from '../_shared/runtime.ts';
import { resilient } from '../_shared/entityRetry.ts';
import { subCred } from '../_shared/twilio.ts';
import { validTwilioSignature, e164 } from '../_shared/smsTransport.ts';
import { recordInbound } from '../_shared/messageWebhook.ts';
import { waitUntil } from '../_shared/runtime.ts';
import { recordDelivery } from '../_shared/messageDelivery.ts';
import { freshSettings } from '../_shared/ghlAuth.ts';
import { handleSelfTestReply } from '../_shared/readiness.ts';
import { handleVoice } from '../_shared/voice.ts';

const twiml = () => new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', { status: 200, headers: { 'Content-Type': 'text/xml' } });

export default async function (req: Request) {
  try {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    const raw = await req.text();
    if (raw.length > 20000) return new Response('Too large', { status: 413 });
    const params = Object.fromEntries(new URLSearchParams(raw).entries()) as Record<string, string>;
    const accountSid = params.AccountSid || '';
    if (!/^AC[0-9a-f]{32}$/i.test(accountSid)) return new Response('Bad request', { status: 400 });

    const base44 = resilient(createClientFromRequest(req));
    const E = base44.asServiceRole.entities;
    const acct = (await E.TwilioAccount.filter({ subaccount_sid: accountSid }, { limit: 1 })).items[0];
    if (!acct) return new Response('Unknown account', { status: 404 });

    const cred = await subCred(accountSid);
    // Twilio signs the exact URL it called: our stored webhook plus any query string (voice steps).
    const search = new URL(req.url).search;
    const url = (acct.webhook_url || '') + search;
    if (!(await validTwilioSignature(cred.token, url, params, req.headers.get('x-twilio-signature') || ''))) return new Response('Forbidden', { status: 403 });

    const page = await E.AgentSettings.filter({ agent_email: acct.agent_email }, { limit: 1 });
    if (!page.items[0]) return twiml();
    const s = await freshSettings(base44, page.items[0]);

    // Calls (click-to-call bridge, inbound calls, voicemail).
    const query = new URLSearchParams(search);
    if (query.get('voice')) return await handleVoice(base44, s, acct, query, params);

    // Delivery receipt.
    if (params.MessageStatus && !params.Body && params.SmsStatus !== 'received') {
      await recordDelivery(base44, s, params.MessageSid, String(params.MessageStatus).toLowerCase(), params.ErrorCode || '');
      return twiml();
    }

    // Inbound text.
    const from = e164(params.From), body = String(params.Body || '').slice(0, 4000);
    if (!from || !params.MessageSid) return twiml();
    // The agent answering their own setup test is not a lead.
    if (await handleSelfTestReply(E, s, from, body)) return twiml();
    // Only what Twilio must wait for happens before the 200 (dedupe, lead patch incl. STOP, the inbound log row);
    // the CRM lookup, inbox summary, alerts and the AI reply continue in the background.
    await recordInbound(base44, s, { from, to: params.To || '', body, messageSid: params.MessageSid, at: new Date().toISOString() }, { defer: waitUntil });
    return twiml();
  } catch (error) {
    console.error('Twilio webhook failed:', (error as Error).message);
    // 500 makes Twilio retry; replies are de-duplicated by MessageSid.
    return new Response('Retry', { status: 500 });
  }
}
