// Pure helpers behind the audit fixes (no database, no network):
//   ghlAuth signInstallState / verifyInstallState (HMAC state for the agency install, 15-minute expiry)
//   msGraph signState / verifyState (constant-time compare)
//   runtime timingSafeEqual, fromAddress (FROM_EMAIL with a display name), clientIp (last x-forwarded-for hop),
//   corsHeadersFor (CORS_ORIGIN allow-list), appOrigin
//   webhookAuth secretFromUrl / validWebhookSecret / newWebhookSecret / legacySecretAllowed
import { deepStrictEqual, ok, rejects } from 'node:assert/strict';

Deno.env.set('SUPABASE_URL', 'https://proj.supabase.co');
Deno.env.set('SUPABASE_ANON_KEY', 'anon-test-key');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service-role-test-key');
Deno.env.set('APP_URL', 'https://app.example.com/');
Deno.env.set('MS_CLIENT_SECRET', 'ms-secret');
Deno.env.set('DATABASE_URL', Deno.env.get('TEST_DATABASE_URL') || 'postgres://unused:unused@127.0.0.1:1/unused');

import { signInstallState, verifyInstallState } from '../_shared/ghlAuth.ts';
import { signState, verifyState } from '../_shared/msGraph.ts';
import { timingSafeEqual, fromAddress, clientIp, corsHeadersFor, appOrigin } from '../_shared/runtime.ts';
import { secretFromUrl, validWebhookSecret, newWebhookSecret, legacySecretAllowed } from '../_shared/webhookAuth.ts';

const req = (headers: Record<string, string>) => new Request('https://fn.test/x', { headers });

Deno.test('ghl install state: round-trips, rejects forgery, wrong secret, tampering and expiry', async () => {
  const state = await signInstallState('Admin@Example.com', 15 * 60000, 'ghl-secret');
  deepStrictEqual(await verifyInstallState(state, 'ghl-secret'), 'admin@example.com');
  deepStrictEqual(await verifyInstallState(state, 'other-secret'), null, 'another client secret cannot verify it');
  deepStrictEqual(await verifyInstallState('', 'ghl-secret'), null);
  deepStrictEqual(await verifyInstallState('not.a.valid.state', 'ghl-secret'), null);
  const [payload, sig] = state.split('.');
  deepStrictEqual(await verifyInstallState(`${payload}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`, 'ghl-secret'), null, 'a flipped signature byte fails');
  const other = await signInstallState('someone@else.com', 15 * 60000, 'ghl-secret');
  deepStrictEqual(await verifyInstallState(`${payload}.${other.split('.')[1]}`, 'ghl-secret'), null, 'a signature from another payload fails');
  const expired = await signInstallState('admin@example.com', -1000, 'ghl-secret');
  deepStrictEqual(await verifyInstallState(expired, 'ghl-secret'), null, 'expired state is refused');
  deepStrictEqual(await verifyInstallState(state, ''), null, 'no secret configured → nothing verifies');
  await rejects(() => signInstallState('admin@example.com', 1000, ''), /GHL_CLIENT_SECRET/);
  ok(state !== await signInstallState('admin@example.com', 15 * 60000, 'ghl-secret'), 'each state carries a nonce');
});

Deno.test('msGraph state: round-trips and rejects a tampered signature', async () => {
  const state = await signState('Agent@Example.com');
  deepStrictEqual(await verifyState(state), 'agent@example.com');
  const [payload, sig] = state.split('.');
  deepStrictEqual(await verifyState(`${payload}.${sig.slice(1)}`), null);
  deepStrictEqual(await verifyState(`${payload}.`), null);
  deepStrictEqual(await verifyState(await signState('agent@example.com', -1)), null, 'expired');
});

Deno.test('timingSafeEqual compares whole strings and treats different lengths as unequal', () => {
  ok(timingSafeEqual('abc', 'abc'));
  ok(!timingSafeEqual('abc', 'abd'));
  ok(!timingSafeEqual('abc', 'abcd'));
  ok(!timingSafeEqual('', 'a'));
  ok(timingSafeEqual('', ''));
});

Deno.test('fromAddress: bare address, display name, and FROM_EMAIL that already carries a name', () => {
  deepStrictEqual(fromAddress('hello@x.com'), 'hello@x.com');
  deepStrictEqual(fromAddress('hello@x.com', 'Sam Agent'), 'Sam Agent <hello@x.com>');
  deepStrictEqual(fromAddress('LeadRespark <hello@x.com>'), 'LeadRespark <hello@x.com>');
  deepStrictEqual(fromAddress('"LeadRespark" <hello@x.com>'), 'LeadRespark <hello@x.com>');
  deepStrictEqual(fromAddress('LeadRespark <hello@x.com>', 'Sam Agent'), 'Sam Agent <hello@x.com>', 'from_name replaces the display name instead of wrapping twice');
  deepStrictEqual(fromAddress('hello@x.com', 'Evil <x@y.z>"'), 'Evil x@y.z <hello@x.com>', 'angle brackets and quotes are stripped from the name');
});

Deno.test('clientIp: cf-connecting-ip first, otherwise the LAST x-forwarded-for hop', () => {
  deepStrictEqual(clientIp(req({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 3.3.3.3' })), '3.3.3.3');
  deepStrictEqual(clientIp(req({ 'x-forwarded-for': '  9.9.9.9 ' })), '9.9.9.9');
  deepStrictEqual(clientIp(req({ 'cf-connecting-ip': '5.5.5.5', 'x-forwarded-for': '1.1.1.1, 2.2.2.2' })), '5.5.5.5');
  deepStrictEqual(clientIp(req({})), 'unknown');
  deepStrictEqual(clientIp(req({ 'x-forwarded-for': `${'a'.repeat(100)}` })).length, 64);
});

Deno.test('corsHeadersFor: wildcard by default, allow-list echoes a listed origin only', () => {
  Deno.env.delete('CORS_ORIGIN');
  const star = corsHeadersFor(req({ origin: 'https://evil.example' }));
  deepStrictEqual(star['Access-Control-Allow-Origin'], '*');
  ok(!star['Access-Control-Allow-Headers'].includes('x-base44-app-url'), 'the app-url header is no longer accepted from browsers');
  Deno.env.set('CORS_ORIGIN', 'https://app.example.com, https://staging.example.com/');
  try {
    deepStrictEqual(corsHeadersFor(req({ origin: 'https://staging.example.com' }))['Access-Control-Allow-Origin'], 'https://staging.example.com');
    const denied = corsHeadersFor(req({ origin: 'https://evil.example' }));
    deepStrictEqual(denied['Access-Control-Allow-Origin'], 'https://app.example.com', 'an unlisted origin gets the first listed one (browser refuses)');
    deepStrictEqual(denied.Vary, 'Origin');
    deepStrictEqual(corsHeadersFor()['Access-Control-Allow-Origin'], 'https://app.example.com');
  } finally { Deno.env.delete('CORS_ORIGIN'); }
});

Deno.test('appOrigin strips the trailing slash and falls back to the legacy domain', () => {
  deepStrictEqual(appOrigin(), 'https://app.example.com');
  const saved = Deno.env.get('APP_URL')!;
  Deno.env.delete('APP_URL');
  try { deepStrictEqual(appOrigin(), 'https://respark-pipkingroup.com'); } finally { Deno.env.set('APP_URL', saved); }
});

Deno.test('webhookAuth helpers: secret parsing, format, generation, legacy switch', () => {
  deepStrictEqual(secretFromUrl('https://p.supabase.co/functions/v1/ghlWebhook?secret=abc'), 'abc');
  deepStrictEqual(secretFromUrl('https://p.supabase.co/functions/v1/ghlWebhook'), '');
  deepStrictEqual(secretFromUrl('not a url'), '');
  const s = newWebhookSecret();
  ok(validWebhookSecret(s), s);
  ok(!validWebhookSecret(s.toUpperCase()));
  ok(!validWebhookSecret(`${s}0`));
  ok(!validWebhookSecret('respark-shared-secret'));
  ok(!validWebhookSecret(undefined));
  Deno.env.delete('GHL_LEGACY_WEBHOOK_SECRET_OK');
  ok(!legacySecretAllowed(), 'legacy platform-wide secret is off by default');
  Deno.env.set('GHL_LEGACY_WEBHOOK_SECRET_OK', 'true');
  try { ok(legacySecretAllowed()); } finally { Deno.env.delete('GHL_LEGACY_WEBHOOK_SECRET_OK'); }
});
