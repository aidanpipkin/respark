// Stripe → LeadRespark webhook. Keeps every BillingAccount in step with Stripe the moment something
// changes (failed/paid invoices, subscription changes, disputes, saved cards) instead of waiting for
// the daily Subscription Sync, and turns money problems into signals for the agent and the owner.
//
// ---- Stripe dashboard setup (one time, per mode: test and live) --------------------------------
// 1. Developers → Webhooks → "Add endpoint". Endpoint URL (Base44 serves functions under /functions/,
//    the same pattern the Twilio webhook uses, see purchaseNumber/numbers `${appOrigin}/functions/twilioWebhook`):
//        https://respark-pipkingroup.com/functions/stripeWebhook
//    (The platform URL https://respark-pipkingroup.com/api/apps/6ad0dedae8a9cd807152d78a/functions/stripeWebhook
//    also reaches this function; either works, pick one and keep it.)
// 2. Events to send (exactly these):
//        invoice.payment_failed, invoice.paid, customer.subscription.updated,
//        customer.subscription.deleted, charge.dispute.created, setup_intent.succeeded
// 3. Copy the endpoint's "Signing secret" (whsec_...) into Base44 → Secrets as STRIPE_WEBHOOK_SECRET.
//    Until it is set this endpoint answers 503 and Stripe keeps retrying; nothing is processed unsigned.
// 4. Send a test event from the dashboard; a 200 with {"ok":true} means the signature matched.
// ------------------------------------------------------------------------------------------------
// Verification: HMAC-SHA256 over `${t}.${rawBody}` with the signing secret, compared constant-time
// against every v1 signature in the header; timestamps older than 5 minutes are rejected (replay).
// Idempotent: each event id is remembered in EngineCursor (stripe_evt:<id>) for 7 days.
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';
import { secrets, waitUntil } from 'base44:runtime';
import { resilient } from '../../shared/entityRetry.ts';
import { syncSubscription } from '../../shared/subscription.ts';
import { raise, resolve } from '../../shared/signals.ts';
import { APP_ORIGIN } from '../../shared/appointmentJourney.ts';

const SKEW_MS = 5 * 60 * 1000;
const KEEP_MS = 7 * 24 * 3600 * 1000;
let warnedMissingSecret = false;

function webhookSecret() {
  let v = '';
  try { v = String(secrets.get('STRIPE_WEBHOOK_SECRET') || '').trim(); } catch { /* not in secrets */ }
  if (!v) { try { v = String(Deno.env.get('STRIPE_WEBHOOK_SECRET') || '').trim(); } catch { /* no env access */ } }
  return v;
}

const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

function sameString(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True when the `stripe-signature` header signs this exact body with our secret, within the allowed skew. */
async function verify(secret: string, header: string, raw: string) {
  const parts = Object.create(null) as Record<string, string[]>;
  for (const kv of header.split(',')) { const i = kv.indexOf('='); if (i < 1) continue; const k = kv.slice(0, i).trim(), v = kv.slice(i + 1).trim(); (parts[k] ||= []).push(v); }
  const t = Number(parts.t?.[0]);
  if (!Number.isFinite(t) || Math.abs(Date.now() - t * 1000) > SKEW_MS) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${raw}`))));
  return (parts.v1 || []).some(sig => sameString(expected, sig.toLowerCase()));
}

const money = (c: number) => `$${(Number(c || 0) / 100).toFixed(2)}`;

async function accountFor(E: any, customer: string) {
  if (!customer) return null;
  return (await E.BillingAccount.filter({ stripe_customer_id: customer }, { limit: 1 })).items[0] || null;
}

async function agentFor(E: any, email: string) {
  return (await E.AgentSettings.filter({ agent_email: email }, { limit: 1, fields: ['agent_email', 'first_name', 'brand_name'] })).items[0] || null;
}

/** Re-reads the subscription from Stripe (or uses the object Stripe just sent) and writes it on the account. */
async function refresh(E: any, a: any, sub?: any) {
  if (sub?.id && !a.subscription_id) { a = { ...a, subscription_id: sub.id }; await E.BillingAccount.update(a.id, { subscription_id: sub.id }); }
  if (sub?.id && a.subscription_id && sub.id !== a.subscription_id) return a; // an old subscription of the same customer: ignore
  try { return await syncSubscription(E, a, sub?.id === a.subscription_id ? sub : undefined); }
  catch (e) { console.error('[stripeWebhook] sync failed', a.agent_email, (e as Error).message); return a; }
}

async function handle(base44: any, event: any) {
  const E = base44.asServiceRole.entities;
  const o = event.data?.object || {};
  const customer = typeof o.customer === 'string' ? o.customer : o.customer?.id || '';
  const a = await accountFor(E, customer);
  const email = a?.agent_email || o.metadata?.agent_email || '';
  const billing = `${APP_ORIGIN}/credits`;

  switch (event.type) {
    case 'invoice.payment_failed': {
      if (!a) return 'no account';
      const fresh = await refresh(E, a);
      const s = await agentFor(E, a.agent_email);
      const amount = money(o.amount_due);
      await raise(base44, {
        key: `payment_failed:${a.agent_email}`, kind: 'payment_failed', agent_email: a.agent_email, agent_visible: true, severity: 'warning',
        title: `Your subscription payment of ${amount} didn’t go through`,
        detail: `Stripe could not charge your card (${o.last_finalization_error?.message || o.collection_method || 'card declined'}). We’ll retry automatically; update your card now so texting never pauses.`,
        action_label: 'Update card', action_href: '/credits', notifyOwner: true,
        data: { invoice: o.id, amount_due: o.amount_due, attempt: o.attempt_count, subscription_status: fresh.subscription_status },
        notifyAgent: { subject: 'Your LeadRespark payment didn’t go through', body: `Hi ${s?.first_name || 'there'},\n\nYour LeadRespark subscription payment (${amount}) didn't go through. Your leads, conversations and calendar are all safe, and Stripe will retry automatically.\n\nUpdate your card here (takes a minute): ${billing}\n\nLeadRespark`, cooldownHours: 24 },
      });
      return 'raised';
    }
    case 'invoice.paid': {
      if (!a) return 'no account';
      await refresh(E, a);
      await resolve(base44, `payment_failed:${a.agent_email}`, 'Paid');
      return 'synced';
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      if (!a) return 'no account';
      await refresh(E, a, o);
      if (event.type === 'customer.subscription.deleted') await raise(base44, { key: `subscription_ended:${a.agent_email}`, kind: 'subscription_ended', agent_email: a.agent_email, severity: 'info', title: 'Subscription ended', detail: `Stripe subscription ${o.id} is ${o.status}${o.cancellation_details?.reason ? ` (${o.cancellation_details.reason})` : ''}.`, notifyOwner: true, data: { subscription: o.id, status: o.status } });
      return 'synced';
    }
    case 'charge.dispute.created': {
      const charge = typeof o.charge === 'string' ? o.charge : o.charge?.id || '';
      await raise(base44, {
        key: `dispute:${o.id}`, kind: 'dispute', severity: 'critical', scope: 'platform', agent_email: email || undefined, notifyOwner: true,
        title: `Payment dispute opened for ${money(o.amount)}${email ? ` (${email})` : ''}`,
        detail: `Reason: ${o.reason || 'unknown'}. Status: ${o.status || ''}. Respond in the Stripe dashboard before ${o.evidence_details?.due_by ? new Date(o.evidence_details.due_by * 1000).toLocaleDateString('en-US') : 'the deadline'}; charge ${charge}.`,
        data: { dispute: o.id, charge, amount: o.amount, reason: o.reason, customer },
      });
      return 'raised';
    }
    case 'setup_intent.succeeded': {
      if (!a) return 'no account';
      // The card is only saved once the agent confirms consent in saveBillingCard; here we just make sure
      // the account points at this setup intent so that confirmation finds it.
      if (a.setup_intent_id !== o.id && o.metadata?.agent_email === a.agent_email) await E.BillingAccount.update(a.id, { setup_intent_id: o.id });
      return 'noted';
    }
    default: return 'ignored';
  }
}

/** Forget event ids older than 7 days (best effort, in the background). */
async function purge(E: any) {
  const old = await E.EngineCursor.filter({ key: { $regex: '^stripe_evt:' }, created_date: { $lte: new Date(Date.now() - KEEP_MS).toISOString() } }, { limit: 50, fields: ['id'] });
  for (const row of old.items) await E.EngineCursor.delete(row.id).catch(() => {});
}

export default async function (req: Request) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const secret = webhookSecret();
  if (!secret) {
    if (!warnedMissingSecret) { warnedMissingSecret = true; console.error('[stripeWebhook] STRIPE_WEBHOOK_SECRET is not set; add it in Base44 Secrets (see the function header).'); }
    return new Response('Stripe webhook secret is not configured.', { status: 503 });
  }
  const raw = await req.text();
  if (raw.length > 1_000_000) return new Response('Too large', { status: 413 });
  if (!(await verify(secret, req.headers.get('stripe-signature') || '', raw))) return new Response('Bad signature', { status: 400 });
  let event: any;
  try { event = JSON.parse(raw); } catch { return new Response('Bad JSON', { status: 400 }); }
  if (!event?.id || !event.type) return new Response('Bad event', { status: 400 });

  const base44 = resilient(createClientFromRequest(req));
  const E = base44.asServiceRole.entities;
  const key = `stripe_evt:${String(event.id).slice(0, 80)}`;
  try {
    if ((await E.EngineCursor.filter({ key }, { limit: 1 })).items[0]) return Response.json({ ok: true, duplicate: true });
    const result = await handle(base44, event);
    await E.EngineCursor.upsert([{ key, cursor: JSON.stringify({ at: new Date().toISOString(), type: event.type, result }).slice(0, 500) }], { key: 'key' });
    if (Math.random() < 0.05) { try { waitUntil(purge(E).catch(() => {})); } catch { /* no background slot */ } }
    return Response.json({ ok: true, result });
  } catch (e) {
    console.error('[stripeWebhook]', event.type, (e as Error).message);
    // 500 makes Stripe retry; the event id is only remembered after a successful run.
    return new Response('Retry', { status: 500 });
  }
}
