// Drop-in replacements for the Base44 imports used by legacy_base44/functions and shared:
//
//   import { createClientFromRequest } from 'npm:@base44/sdk@0.8.52';  →  from '../_shared/runtime.ts'
//   import { secrets, waitUntil } from 'base44:runtime';                →  from '../_shared/runtime.ts'
//
// Environment (set in the Supabase dashboard → Edge Functions → Secrets):
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_DB_URL   (injected by Supabase)
//   APP_URL                 public web app origin, stands in for the x-base44-app-url header
//   PLATFORM_OWNER_EMAIL    identity reported by auth.me() for service-role (cron) calls
//   RESEND_API_KEY, FROM_EMAIL                     SendEmail
//   ANTHROPIC_API_KEY, LLM_MODEL (optional)        InvokeLLM
//   STORAGE_BUCKET (default "uploads")             CreateFileSignedUrl / UploadFile
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.49.4';
import { type Entities, getSql, serviceEntities, userEntities } from './entities.ts';

// ---------------------------------------------------------------------------
// base44:runtime
// ---------------------------------------------------------------------------
declare const EdgeRuntime: { waitUntil?: (p: Promise<unknown>) => void } | undefined;

/** Keeps a promise alive after the response is sent (Supabase edge runtime), else fire-and-forget. */
export function waitUntil(promise: Promise<unknown>): void {
  const guarded = Promise.resolve(promise).catch((e) => console.error('[waitUntil]', e?.message || e));
  try {
    if (typeof EdgeRuntime !== 'undefined' && typeof EdgeRuntime?.waitUntil === 'function') { EdgeRuntime.waitUntil(guarded); return; }
  } catch { /* not in the edge runtime */ }
}

export const secrets = {
  get(name: string): string | undefined {
    return Deno.env.get(name) ?? undefined;
  },
};

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': Deno.env.get('CORS_ORIGIN') || '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-base44-app-url',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * Serves a legacy `export default async function (req)` handler as a Supabase edge function:
 * answers CORS preflight, adds CORS headers, and supplies the x-base44-app-url header the legacy
 * code reads (from APP_URL) when the caller did not send one.
 */
export function serve(handler: (req: Request) => Promise<Response> | Response): void {
  Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
    let request = req;
    const appUrl = Deno.env.get('APP_URL');
    if (appUrl && !req.headers.get('x-base44-app-url')) {
      const headers = new Headers(req.headers);
      headers.set('x-base44-app-url', appUrl);
      request = new Request(req, { headers });
    }
    try {
      return withCors(await handler(request));
    } catch (e) {
      console.error('[serve]', (e as Error)?.stack || e);
      return withCors(Response.json({ error: 'Internal error' }, { status: 500 }));
    }
  });
}

// ---------------------------------------------------------------------------
// Supabase clients
// ---------------------------------------------------------------------------
function env(name: string, required = true): string {
  const v = Deno.env.get(name);
  if (!v && required) throw new Error(`${name} is not set`);
  return v ?? '';
}

let adminClient: SupabaseClient | undefined;
function supabaseAdmin(): SupabaseClient {
  if (!adminClient) adminClient = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
  return adminClient;
}

function bearer(req: Request): string {
  const h = req.headers.get('authorization') || req.headers.get('Authorization') || '';
  return h.replace(/^Bearer\s+/i, '').trim();
}

export type User = { id: string; email: string; full_name: string; role: 'admin' | 'agent' | 'user'; roles: string[]; service_role?: boolean };

async function resolveUser(req: Request): Promise<User | null> {
  const token = bearer(req);
  if (!token) return null;
  // Cron (pg_cron / scheduled functions) and function-to-function calls send the service role key.
  // Base44 ran workflows as the app owner, so they land in the code's admin paths.
  if (token === env('SUPABASE_SERVICE_ROLE_KEY')) {
    return { id: 'service-role', email: (Deno.env.get('PLATFORM_OWNER_EMAIL') || '').toLowerCase(), full_name: 'System', role: 'admin', roles: ['admin'], service_role: true };
  }
  const anon = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await anon.auth.getUser(token);
  if (error || !data?.user) return null;
  const u = data.user;
  const sql = getSql();
  const rows = await sql`select email, full_name, role from public.profiles where id = ${u.id}::uuid`;
  const profile = rows[0] as { email?: string; full_name?: string; role?: string } | undefined;
  const role = (profile?.role === 'admin' ? 'admin' : profile?.role === 'user' ? 'user' : 'agent') as User['role'];
  const meta = (u.user_metadata ?? {}) as Record<string, string>;
  return { id: u.id, email: String(u.email || profile?.email || '').toLowerCase(), full_name: profile?.full_name || meta.full_name || meta.name || '', role, roles: [role] };
}

// ---------------------------------------------------------------------------
// Integrations
// ---------------------------------------------------------------------------
async function readTemplate(name: string): Promise<{ html: string; subject: string }> {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`Bad template name ${name}`);
  const base = new URL(`./emails/${name}`, import.meta.url);
  const html = await Deno.readTextFile(new URL(`${base.href}.html`));
  let subject = '';
  try { subject = (await Deno.readTextFile(new URL(`${base.href}.subject.txt`))).trim(); } catch { /* optional */ }
  return { html, subject };
}

const escapeHtml = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
function fill(template: string, vars: Record<string, unknown>, escape: boolean): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, k) => (escape ? escapeHtml(vars[k]) : String(vars[k] ?? '')));
}

export type SendEmailArgs = { to: string | string[]; subject?: string; body?: string; from_name?: string; template_name?: string; variables?: Record<string, unknown>; reply_to?: string };

/** Base44 Core.SendEmail on Resend. `body` may be plain text or HTML; templates come from _shared/emails. */
export async function sendEmail(args: SendEmailArgs): Promise<{ success: boolean; id?: string }> {
  const apiKey = env('RESEND_API_KEY');
  const fromEmail = env('FROM_EMAIL');
  let subject = args.subject || '';
  let html: string | undefined;
  let text: string | undefined;
  if (args.template_name) {
    const t = await readTemplate(args.template_name);
    const vars = args.variables ?? {};
    html = fill(t.html, vars, true);
    if (!subject) subject = fill(t.subject, vars, false);
  } else if (/^\s*<(!doctype|html|body|div|table|p|h\d|mj)/i.test(args.body || '')) {
    html = args.body;
  } else {
    text = args.body || '';
  }
  const from = args.from_name ? `${String(args.from_name).replace(/[<>"]/g, '')} <${fromEmail}>` : fromEmail;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: Array.isArray(args.to) ? args.to : [args.to], subject: subject.slice(0, 998), ...(html ? { html } : { text }), ...(args.reply_to ? { reply_to: args.reply_to } : {}) }),
    signal: AbortSignal.timeout(20000),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`SendEmail failed (${r.status}): ${out?.message || out?.name || 'unknown error'}`), { status: r.status });
  return { success: true, id: out?.id };
}

export type InvokeLLMArgs = { prompt: string; response_json_schema?: Record<string, unknown>; model?: string; system?: string; max_tokens?: number; temperature?: number };

/** Base44 Core.InvokeLLM on the Anthropic Messages API. With a schema the answer comes back as an object via tool use. */
export async function invokeLLM(args: InvokeLLMArgs): Promise<unknown> {
  const apiKey = env('ANTHROPIC_API_KEY');
  const model = args.model || Deno.env.get('LLM_MODEL') || 'claude-sonnet-4-5';
  const structured = !!args.response_json_schema;
  const body: Record<string, unknown> = { model, max_tokens: args.max_tokens || 1200, messages: [{ role: 'user', content: args.prompt }] };
  if (args.temperature !== undefined) body.temperature = args.temperature;
  const system: string[] = [];
  if (args.system) system.push(args.system);
  if (structured) {
    body.tools = [{ name: 'respond', description: 'Return the final answer with exactly this structure.', input_schema: { type: 'object', ...args.response_json_schema } }];
    body.tool_choice = { type: 'tool', name: 'respond' };
  }
  if (system.length) body.system = system.join('\n\n');
  let last: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
    const text = await r.text();
    if (!r.ok) {
      last = Object.assign(new Error(`AI provider ${r.status}: ${text.slice(0, 200)}`), { status: r.status, retryable: r.status === 429 || r.status >= 500 });
      if (!(last as { retryable?: boolean }).retryable) throw last;
      await new Promise((res) => setTimeout(res, 600 * 2 ** attempt + Math.random() * 400));
      continue;
    }
    const out = JSON.parse(text);
    const content: Array<{ type: string; text?: string; input?: unknown }> = out.content || [];
    if (structured) {
      const tool = content.find((b) => b.type === 'tool_use');
      if (tool) return tool.input;
      const m = content.filter((b) => b.type === 'text').map((b) => b.text).join('').match(/\{[\s\S]*\}/);
      if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
      throw new Error('AI provider returned no structured answer.');
    }
    return content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  }
  throw last ?? new Error('AI provider unavailable');
}

function bucketAndPath(uri: string): { bucket: string; path: string } {
  const bucket = Deno.env.get('STORAGE_BUCKET') || 'uploads';
  const clean = String(uri || '').replace(/^storage:\/\//, '').replace(/^\/+/, '');
  return { bucket, path: clean.startsWith(`${bucket}/`) ? clean.slice(bucket.length + 1) : clean };
}

/** Base44 Core.CreateFileSignedUrl on Supabase Storage. file_uri is "<path>" or "<bucket>/<path>". */
export async function createFileSignedUrl(args: { file_uri: string; expires_in?: number }): Promise<{ signed_url: string }> {
  const { bucket, path } = bucketAndPath(args.file_uri);
  const { data, error } = await supabaseAdmin().storage.from(bucket).createSignedUrl(path, args.expires_in || 3600);
  if (error || !data?.signedUrl) throw new Error(`CreateFileSignedUrl failed: ${error?.message || 'no url'}`);
  return { signed_url: data.signedUrl };
}

/** Base44 Core.UploadFile on Supabase Storage. Returns the stored path as file_uri plus a public URL. */
export async function uploadFile(args: { file: Blob | Uint8Array | ArrayBuffer; path?: string; content_type?: string }): Promise<{ file_uri: string; file_url: string }> {
  const bucket = Deno.env.get('STORAGE_BUCKET') || 'uploads';
  const path = args.path || `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}`;
  const { error } = await supabaseAdmin().storage.from(bucket).upload(path, args.file, { contentType: args.content_type, upsert: true });
  if (error) throw new Error(`UploadFile failed: ${error.message}`);
  const { data } = supabaseAdmin().storage.from(bucket).getPublicUrl(path);
  return { file_uri: path, file_url: data.publicUrl };
}

/**
 * Public URL of an edge function, for webhook addresses shown to admins/agents and pasted into
 * vendors. Base44 served functions at `${app}/functions/<name>`; Supabase serves them at
 * `${SUPABASE_URL}/functions/v1/<name>` (override the base with FUNCTIONS_URL, e.g. a custom domain).
 */
export function functionUrl(name: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`Bad function name ${name}`);
  const base = (Deno.env.get('FUNCTIONS_URL') || `${env('SUPABASE_URL')}/functions/v1`).replace(/\/$/, '');
  return `${base}/${name}`;
}

/** Calls another edge function the way Base44's functions.invoke did; the callee sees an admin (service-role) caller. */
export async function invokeFunction(name: string, body: unknown = {}, headers: Record<string, string> = {}): Promise<{ data: unknown; status: number }> {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`Bad function name ${name}`);
  const r = await fetch(`${env('SUPABASE_URL')}/functions/v1/${name}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('SUPABASE_SERVICE_ROLE_KEY')}`, 'Content-Type': 'application/json', ...(Deno.env.get('APP_URL') ? { 'x-base44-app-url': Deno.env.get('APP_URL')! } : {}), ...headers },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(Number(Deno.env.get('FUNCTION_INVOKE_TIMEOUT_MS')) || 150000),
  });
  const text = await r.text();
  let data: unknown = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  if (!r.ok) throw Object.assign(new Error(`${name} failed (${r.status}): ${typeof data === 'object' && data && 'error' in data ? (data as { error: string }).error : text.slice(0, 200)}`), { status: r.status, data });
  return { data, status: r.status };
}

// ---------------------------------------------------------------------------
// createClientFromRequest
// ---------------------------------------------------------------------------
export type Base44Client = {
  auth: { me(): Promise<User | null> };
  entities: Entities;
  asServiceRole: {
    entities: Entities;
    integrations: { Core: { SendEmail: typeof sendEmail; InvokeLLM: typeof invokeLLM; CreateFileSignedUrl: typeof createFileSignedUrl; UploadFile: typeof uploadFile } };
  };
  integrations: { Core: { SendEmail: typeof sendEmail; InvokeLLM: typeof invokeLLM; CreateFileSignedUrl: typeof createFileSignedUrl; UploadFile: typeof uploadFile } };
  functions: { invoke: typeof invokeFunction };
  users: { inviteUser(email: string, role?: string): Promise<{ success: boolean }> };
};

export function createClientFromRequest(req: Request): Base44Client {
  const sql = getSql();
  let userPromise: Promise<User | null> | undefined;
  const me = () => (userPromise ??= resolveUser(req));
  const service = serviceEntities(sql);
  const core = { SendEmail: sendEmail, InvokeLLM: invokeLLM, CreateFileSignedUrl: createFileSignedUrl, UploadFile: uploadFile };

  // `entities` (user-scoped) needs the resolved user, so each method awaits auth.me() first.
  const scopedEntities = new Proxy({} as Entities, {
    get(_t, entity) {
      if (typeof entity !== 'string') return undefined;
      return new Proxy({}, {
        get(_e, method) {
          if (typeof method !== 'string') return undefined;
          return async (...args: unknown[]) => {
            const user = await me();
            if (!user) throw Object.assign(new Error('Please sign in.'), { status: 401 });
            const target = (userEntities(user, sql) as Record<string, Record<string, (...a: unknown[]) => unknown>>)[entity];
            if (!target) throw new Error(`Unknown entity ${entity}`);
            if (typeof target[method] !== 'function') throw new Error(`Entity ${entity} has no method ${method}`);
            return target[method](...args);
          };
        },
      });
    },
  });

  return {
    auth: { me },
    entities: scopedEntities,
    asServiceRole: { entities: service, integrations: { Core: core } },
    integrations: { Core: core },
    functions: { invoke: invokeFunction },
    users: {
      async inviteUser(email: string, role = 'agent') {
        const { error } = await supabaseAdmin().auth.admin.inviteUserByEmail(email, { data: { role }, redirectTo: Deno.env.get('APP_URL') ? `${Deno.env.get('APP_URL')}/` : undefined });
        if (error) throw new Error(`inviteUser failed: ${error.message}`);
        return { success: true };
      },
    },
  };
}
