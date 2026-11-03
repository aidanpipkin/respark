// Offline tests for the Base44 runtime shims: HTTP integrations run against a mocked fetch.
import { deepStrictEqual, ok, rejects } from 'node:assert/strict';
import { createClientFromRequest, invokeFunction, invokeLLM, secrets, sendEmail, waitUntil } from './runtime.ts';
import { closeSql } from './entities.ts';

const SERVICE_KEY = 'service-role-test-key';
Deno.env.set('SUPABASE_URL', 'https://proj.supabase.co');
Deno.env.set('SUPABASE_ANON_KEY', 'anon-test-key');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', SERVICE_KEY);
Deno.env.set('PLATFORM_OWNER_EMAIL', 'Owner@Example.com');
Deno.env.set('RESEND_API_KEY', 're_test');
Deno.env.set('FROM_EMAIL', 'hello@leadrespark.test');
Deno.env.set('ANTHROPIC_API_KEY', 'sk-ant-test');
Deno.env.set('APP_URL', 'https://app.example.com');
if (!Deno.env.get('SUPABASE_DB_URL') && !Deno.env.get('DATABASE_URL')) Deno.env.set('DATABASE_URL', Deno.env.get('TEST_DATABASE_URL') || 'postgres://postgres@127.0.0.1:1/unused');

type Call = { url: string; init: RequestInit; body: unknown };
function mockFetch(responder: (call: Call) => Response | Promise<Response>): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let body: unknown = init.body;
    try { body = JSON.parse(String(init.body)); } catch { /* raw */ }
    const call = { url, init, body };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
}

Deno.test('secrets.get reads the environment', () => {
  deepStrictEqual(secrets.get('FROM_EMAIL'), 'hello@leadrespark.test');
  deepStrictEqual(secrets.get('NOPE_NOT_SET'), undefined);
});

Deno.test('waitUntil never throws and logs rejections', async () => {
  const errors: unknown[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { errors.push(a); };
  try {
    waitUntil(Promise.reject(new Error('boom')));
    waitUntil(Promise.resolve(1));
    await new Promise((r) => setTimeout(r, 10));
  } finally { console.error = orig; }
  deepStrictEqual(errors.length, 1);
});

Deno.test('SendEmail posts to Resend: text body, html body, template with escaping and subject', async () => {
  const m = mockFetch(() => Response.json({ id: 'em_1' }));
  try {
    const r = await sendEmail({ to: 'a@b.c', subject: 'Hi', body: 'plain text', from_name: 'LeadRespark' });
    deepStrictEqual(r, { success: true, id: 'em_1' });
    deepStrictEqual(m.calls[0].url, 'https://api.resend.com/emails');
    deepStrictEqual((m.calls[0].init.headers as Record<string, string>).Authorization, 'Bearer re_test');
    deepStrictEqual(m.calls[0].body, { from: 'LeadRespark <hello@leadrespark.test>', to: ['a@b.c'], subject: 'Hi', text: 'plain text' });

    await sendEmail({ to: ['x@y.z'], subject: 'H', body: '<div>hello</div>' });
    deepStrictEqual((m.calls[1].body as { html: string }).html, '<div>hello</div>');
    deepStrictEqual((m.calls[1].body as { from: string }).from, 'hello@leadrespark.test');

    await sendEmail({ to: 'agent@x.y', template_name: 'AgentWelcome', variables: { first_name: '<Ann>', brand_name: 'Brand & Co', workspace_url: 'https://w' } });
    const body = m.calls[2].body as { subject: string; html: string };
    deepStrictEqual(body.subject, 'Your workspace is ready, <Ann>');
    ok(body.html.includes('&lt;Ann&gt;'));
    ok(body.html.includes('Brand &amp; Co'));
    ok(!body.html.includes('{{'));
  } finally { m.restore(); }
  const bad = mockFetch(() => Response.json({ message: 'nope' }, { status: 422 }));
  try { await rejects(() => sendEmail({ to: 'a@b.c', subject: 's', body: 'b' }), /SendEmail failed \(422\): nope/); } finally { bad.restore(); }
});

Deno.test('InvokeLLM uses tool use for schemas, returns text otherwise, retries 5xx', async () => {
  const m = mockFetch((call) => {
    const b = call.body as { tools?: unknown[] };
    if (b.tools) return Response.json({ content: [{ type: 'tool_use', name: 'respond', input: { text: 'hi', angle: 'warm' } }] });
    return Response.json({ content: [{ type: 'text', text: 'plain answer' }] });
  });
  try {
    const out = await invokeLLM({ prompt: 'write', response_json_schema: { properties: { text: { type: 'string' }, angle: { type: 'string' } }, required: ['text'] } });
    deepStrictEqual(out, { text: 'hi', angle: 'warm' });
    const req = m.calls[0].body as Record<string, unknown>;
    deepStrictEqual(m.calls[0].url, 'https://api.anthropic.com/v1/messages');
    deepStrictEqual((m.calls[0].init.headers as Record<string, string>)['x-api-key'], 'sk-ant-test');
    deepStrictEqual(req.tool_choice, { type: 'tool', name: 'respond' });
    deepStrictEqual((req.tools as Array<{ input_schema: { type: string } }>)[0].input_schema.type, 'object');
    deepStrictEqual(req.model, 'claude-sonnet-4-5');
    deepStrictEqual(await invokeLLM({ prompt: 'say', model: 'claude-x' }), 'plain answer');
    deepStrictEqual((m.calls[1].body as { model: string }).model, 'claude-x');
  } finally { m.restore(); }
  let n = 0;
  const flaky = mockFetch(() => (n++ === 0 ? new Response('overloaded', { status: 529 }) : Response.json({ content: [{ type: 'text', text: 'ok' }] })));
  try { deepStrictEqual(await invokeLLM({ prompt: 'p' }), 'ok'); deepStrictEqual(n, 2); } finally { flaky.restore(); }
  const dead = mockFetch(() => new Response('bad request', { status: 400 }));
  try { await rejects(() => invokeLLM({ prompt: 'p' }), /AI provider 400/); deepStrictEqual(dead.calls.length, 1); } finally { dead.restore(); }
});

Deno.test('functions.invoke posts to the edge function URL with the service key', async () => {
  const m = mockFetch(() => Response.json({ sent: 3 }));
  try {
    const r = await invokeFunction('sequenceSender', { agent_email: 'a@b.c' });
    deepStrictEqual(r, { data: { sent: 3 }, status: 200 });
    deepStrictEqual(m.calls[0].url, 'https://proj.supabase.co/functions/v1/sequenceSender');
    const h = m.calls[0].init.headers as Record<string, string>;
    deepStrictEqual(h.Authorization, `Bearer ${SERVICE_KEY}`);
    deepStrictEqual(h['x-base44-app-url'], 'https://app.example.com');
    deepStrictEqual(m.calls[0].body, { agent_email: 'a@b.c' });
  } finally { m.restore(); }
  const bad = mockFetch(() => Response.json({ error: 'Administrator access required.' }, { status: 403 }));
  try { await rejects(() => invokeFunction('health'), /health failed \(403\): Administrator access required/); } finally { bad.restore(); }
  await rejects(() => invokeFunction('../evil'), /Bad function name/);
});

Deno.test('auth.me: service key is the platform admin, no token is null, user entities demand a sign-in', async () => {
  const asService = createClientFromRequest(new Request('https://x/fn', { headers: { Authorization: `Bearer ${SERVICE_KEY}` } }));
  const me = await asService.auth.me();
  deepStrictEqual(me?.role, 'admin');
  deepStrictEqual(me?.email, 'owner@example.com');
  deepStrictEqual(me?.service_role, true);
  const anon = createClientFromRequest(new Request('https://x/fn'));
  deepStrictEqual(await anon.auth.me(), null);
  await rejects(() => anon.entities.Lead.count({}), /Please sign in/);
  ok(typeof asService.asServiceRole.entities.Lead.filter === 'function');
  ok(typeof asService.asServiceRole.integrations.Core.SendEmail === 'function');
  ok(typeof asService.asServiceRole.integrations.Core.InvokeLLM === 'function');
});

Deno.test('auth.me: a user JWT is verified through supabase auth.getUser', async () => {
  const m = mockFetch((call) => {
    if (call.url.endsWith('/auth/v1/user')) {
      deepStrictEqual((call.init.headers as Headers | Record<string, string>) instanceof Headers ? (call.init.headers as Headers).get('authorization') : (call.init.headers as Record<string, string>).Authorization, 'Bearer user-jwt');
      return Response.json({ id: '33333333-3333-3333-3333-333333333333', email: 'Agent@Example.com', user_metadata: { full_name: 'Agent Smith' }, aud: 'authenticated', role: 'authenticated', app_metadata: {}, created_at: '2026-01-01T00:00:00Z' });
    }
    return new Response('unexpected', { status: 500 });
  });
  try {
    if (!Deno.env.get('TEST_DATABASE_URL')) return; // the profile lookup needs the test database
    const c = createClientFromRequest(new Request('https://x/fn', { headers: { Authorization: 'Bearer user-jwt' } }));
    const u = await c.auth.me();
    deepStrictEqual(u?.email, 'agent@example.com');
    deepStrictEqual(u?.full_name, 'Agent Smith');
    deepStrictEqual(u?.role, 'agent');
  } finally { m.restore(); await closeSql(); }
});
