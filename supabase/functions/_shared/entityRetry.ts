// Makes entity calls survive Base44's per-caller rate limit (350 list calls / 60s).
// Wraps base44.entities and base44.asServiceRole.entities so every method retries
// on "Rate limit exceeded ... Retry after Ns" with jittered backoff.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function isRateLimit(e: any): boolean {
  const m = String(e?.message || e || '');
  return /rate limit|too many requests|\b429\b/i.test(m) || e?.status === 429 || e?.response?.status === 429;
}

export function isInfraError(e: any): boolean {
  if (isRateLimit(e)) return true;
  const m = String(e?.message || e || '');
  return /timed? ?out|ECONNRESET|socket hang up|fetch failed|network|\b50[234]\b|service unavailable|bad gateway/i.test(m);
}

function retryAfterMs(e: any): number {
  const m = String(e?.message || '').match(/retry after (\d+)\s*s/i);
  return m ? Number(m[1]) * 1000 : 1000;
}

// On Postgres the adapter never rate-limits, so the wrapper only covers short connection blips.
// Keep it cheap: a worker runs inside a ~90 s budget, and a long retry ladder on a dead database
// would eat it (and hold a pooler slot) for nothing. ENTITY_RETRY_TRIES overrides the default of 2.
const TRIES = Math.max(1, Number(Deno.env.get('ENTITY_RETRY_TRIES')) || 2);
const BASE_MS = 250, CAP_MS = 1500, JITTER_MS = 250;

export async function withRetry(fn: () => Promise<any>, tries = TRIES) {
  let last: any;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (!isInfraError(e) || i === tries - 1) throw e;
      const base = isRateLimit(e) ? retryAfterMs(e) : BASE_MS * 2 ** i;
      await sleep(Math.min(base, CAP_MS) + Math.floor(Math.random() * JITTER_MS));
    }
  }
  throw last;
}

const WRAPPED = Symbol.for('lr.entityRetry');

function wrapEntity(ent: any) {
  if (!ent || typeof ent !== 'object') return ent;
  return new Proxy(ent, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r);
      if (typeof v !== 'function') return v;
      if (p === 'subscribe') return v.bind(t);
      return (...args: any[]) => withRetry(() => v.apply(t, args));
    },
  });
}

function wrapEntities(ents: any) {
  if (!ents || ents[WRAPPED]) return ents;
  const cache = new Map<PropertyKey, any>();
  return new Proxy(ents, {
    get(t, p, r) {
      if (p === WRAPPED) return true;
      const v = Reflect.get(t, p, r);
      if (typeof p !== 'string' || !v || typeof v !== 'object') return v;
      if (!cache.has(p)) cache.set(p, wrapEntity(v));
      return cache.get(p);
    },
  });
}

export function resilient<T = any>(base44: any): T {
  if (!base44 || base44[WRAPPED]) return base44;
  let sr: any;
  return new Proxy(base44, {
    get(t, p, r) {
      if (p === WRAPPED) return true;
      const v = Reflect.get(t, p, r);
      if (p === 'entities') return wrapEntities(v);
      if (p === 'asServiceRole') {
        if (!sr) sr = new Proxy(v, {
          get(st, sp, sr2) {
            const sv = Reflect.get(st, sp, sr2);
            return sp === 'entities' ? wrapEntities(sv) : sv;
          },
        });
        return sr;
      }
      return v;
    },
  });
}
