// One door for every AI call. Uses the platform's own API key when one is set in Secrets
// (ANTHROPIC_API_KEY or OPENAI_API_KEY): pay per message, no monthly cap. Falls back to
// Base44's built-in InvokeLLM (which spends Base44 integration credits) when no key is set
// or the provider is down, so messages keep flowing either way.
import { secrets } from './runtime.ts';
import { bump } from './signals.ts';
import { platformConfig } from './credits.ts';

// `system` is the stable part of a prompt (campaign instructions, knowledge). With Anthropic it is
// sent as a cached system block, so thousands of texts reuse it instead of paying for it each time.
type Params = { prompt: string; model?: string; response_json_schema?: any; system?: string; tier?: 'reply' | 'writer'; max_tokens?: number };

const ANTHROPIC_DEFAULT = 'claude-sonnet-5-5';
const OPENAI_DEFAULT = 'gpt-5-mini';
// Anthropic model ids a campaign may select (Campaign.ai_model / p.model). Anything else falls back to
// LLM_MODEL or the default, so a stale or mistyped id stored on a campaign never breaks replies.
export const ANTHROPIC_MODELS = new Set(['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-4-5', 'claude-haiku-4-5']);

function key(name: string) { try { return String(secrets.get(name) || '').trim(); } catch { return ''; } }

// Per-isolate cap on concurrent provider calls (LLM_MAX_INFLIGHT, default 6). A worker handling many
// replies at once would otherwise open dozens of 60 s sockets and trip the provider's rate limit.
const MAX_INFLIGHT = Math.max(1, Number(key('LLM_MAX_INFLIGHT')) || 6);
let inflight = 0;
const waiters: Array<() => void> = [];
async function acquire() { if (inflight < MAX_INFLIGHT) { inflight++; return; } await new Promise<void>(r => waiters.push(r)); inflight++; }
function release() { inflight--; const next = waiters.shift(); if (next) next(); }
/** How many provider calls this isolate has in flight (diagnostics and tests). */
export function llmInflight() { return { inflight, waiting: waiters.length, max: MAX_INFLIGHT }; }
async function limited<T>(fn: () => Promise<T>): Promise<T> { await acquire(); try { return await fn(); } finally { release(); } }

/** Which engine will answer, for diagnostics. */
export function llmProvider() {
  if (key('ANTHROPIC_API_KEY')) return 'anthropic';
  if (key('OPENAI_API_KEY')) return 'openai';
  return 'base44';
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Retry-After header (seconds or an HTTP date) as milliseconds, or null when absent/unparseable. */
export function retryAfterMs(header: string | null | undefined): number | null {
  const v = String(header || '').trim();
  if (!v) return null;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

const BACKOFF_CAP_MS = 8000;
async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let last: any;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e: any) {
      last = e;
      if (!e?.retryable || i === tries - 1) break;
      // Honour the provider's Retry-After on 429/5xx (capped), otherwise exponential backoff.
      const hinted = typeof e?.retryAfterMs === 'number' ? e.retryAfterMs : null;
      await sleep(Math.min(BACKOFF_CAP_MS, hinted ?? 600 * 2 ** i) + Math.random() * 400);
    }
  }
  throw last;
}

async function post(url: string, headers: Record<string, string>, body: any) {
  return await limited(async () => {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    const text = await r.text();
    if (!r.ok) {
      const err: any = new Error(`AI provider ${r.status}: ${text.slice(0, 200)}`);
      err.status = r.status; err.retryable = r.status === 429 || r.status >= 500;
      const ra = retryAfterMs(r.headers.get('retry-after')); if (ra !== null) err.retryAfterMs = ra;
      throw err;
    }
    return JSON.parse(text);
  });
}

function cleanSchema(schema: any): any {
  // Providers accept standard JSON Schema; drop nothing, just make sure it's an object schema.
  return schema && typeof schema === 'object' ? schema : { type: 'object', properties: {} };
}

/** The Anthropic model for a call: the caller's choice when it is a known id, else the configured default. */
export function anthropicModel(p: Pick<Params, 'model' | 'tier'>) {
  const asked = String(p.model || '').trim();
  if (asked && ANTHROPIC_MODELS.has(asked)) return asked;
  return (p.tier === 'writer' && key('LLM_WRITER_MODEL')) || key('LLM_MODEL') || ANTHROPIC_DEFAULT;
}

async function anthropic(p: Params, apiKey: string) {
  const model = anthropicModel(p);
  const structured = !!p.response_json_schema;
  const body: any = { model, max_tokens: p.max_tokens || 1200, messages: [{ role: 'user', content: p.prompt }] };
  const systemBlocks: any[] = [];
  if (p.system) systemBlocks.push({ type: 'text', text: p.system, cache_control: { type: 'ephemeral' } });
  if (structured) {
    // Newer models don't allow forcing a tool, so ask for it plainly and accept JSON text too.
    body.tools = [{ name: 'respond', description: 'Return your final answer by calling this tool with the exact structure.', input_schema: cleanSchema(p.response_json_schema) }];
    body.tool_choice = { type: 'auto' };
    systemBlocks.push({ type: 'text', text: 'Always answer by calling the respond tool exactly once with every required field. Do not reply with plain text.' });
  }
  if (systemBlocks.length) body.system = systemBlocks;
  const ws = key('ANTHROPIC_WORKSPACE_ID');
  const out = await withRetry(() => post('https://api.anthropic.com/v1/messages', { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', ...(ws ? { 'anthropic-workspace-id': ws } : {}) }, body));
  if (structured) {
    const block = (out.content || []).find((b: any) => b.type === 'tool_use');
    if (block) return block.input;
    const text = (out.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
    throw new Error('AI provider returned no structured answer.');
  }
  return (out.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
}

async function openai(p: Params, apiKey: string) {
  const model = key('LLM_MODEL') || OPENAI_DEFAULT;
  const body: any = { model, messages: [...(p.system ? [{ role: 'system', content: p.system }] : []), { role: 'user', content: p.prompt }] };
  if (p.response_json_schema) body.response_format = { type: 'json_schema', json_schema: { name: 'respond', schema: cleanSchema(p.response_json_schema), strict: false } };
  const out = await withRetry(() => post('https://api.openai.com/v1/chat/completions', { Authorization: `Bearer ${apiKey}` }, body));
  const text = out.choices?.[0]?.message?.content || '';
  return p.response_json_schema ? JSON.parse(text) : text;
}

/** Drop-in replacement for base44.asServiceRole.integrations.Core.InvokeLLM. */
/** What answered the most recent call in this process, for diagnostics. */
export const lastLLM: { used: string; fallback_reason: string } = { used: '', fallback_reason: '' };

// PlatformSettings.llm_fallback_allowed, remembered for a minute so thousands of texts don't each read it.
let fallbackCache: { at: number; allowed: boolean } | null = null;
async function fallbackAllowed(base44: any) {
  if (fallbackCache && Date.now() - fallbackCache.at < 60000) return fallbackCache.allowed;
  let allowed = false;
  try { const E = base44?.asServiceRole?.entities; if (E) allowed = (await platformConfig(E)).llm_fallback_allowed === true; } catch { /* default: no fallback */ }
  fallbackCache = { at: Date.now(), allowed };
  return allowed;
}

/**
 * Thrown when the platform's own AI provider failed and falling back to Base44 credits is turned off.
 * name 'Transient' tells the sender to leave the job for the next run instead of flagging the lead.
 */
export class LLMUnavailable extends Error {
  retryable = true;
  constructor(reason: string) { super(`AI is temporarily unavailable (${reason.slice(0, 200)}). The text will be retried.`); this.name = 'Transient'; }
}

export async function invokeLLM(base44: any, p: Params): Promise<any> {
  const a = key('ANTHROPIC_API_KEY'), o = key('OPENAI_API_KEY');
  lastLLM.fallback_reason = '';
  try {
    if (a) { const r = await anthropic(p, a); lastLLM.used = 'anthropic'; await bump(base44, 'ai_own_calls'); return r; }
    if (o) { const r = await openai(p, o); lastLLM.used = 'openai'; await bump(base44, 'ai_own_calls'); return r; }
  } catch (e) {
    lastLLM.fallback_reason = String((e as Error).message).slice(0, 300);
    // Counted even when fallback is off: the health check turns the first failure of the day into an alert.
    await bump(base44, 'ai_fallback');
    if (!(await fallbackAllowed(base44))) {
      console.error('[llm] own-key provider failed; Base44 fallback is off, retrying later', (e as Error).message);
      throw new LLMUnavailable(lastLLM.fallback_reason);
    }
    console.error('[llm] own-key provider failed, falling back to Base44', (e as Error).message);
  }
  lastLLM.used = 'base44';
  await bump(base44, 'ai_base44_calls');
  return await withRetry(async () => {
    try { return await base44.asServiceRole.integrations.Core.InvokeLLM({ prompt: p.system ? `${p.system}\n\n${p.prompt}` : p.prompt, ...(p.response_json_schema ? { response_json_schema: p.response_json_schema } : {}) }); }
    catch (e: any) { const m = String(e?.message || ''); e.retryable = /429|rate|timeout|5\d\d/i.test(m) && !/credit/i.test(m); throw e; }
  }, 2);
}
