// One-time migration endpoint: upserts Base44 entity records into the Supabase tables, keeping ids and
// timestamps (the same mapping as scripts/import-base44.ts). Used by the Base44 side (functions/exportToSupabase
// there) to push its data across at cutover, so the data never has to travel through a laptop.
//
// Auth: header x-import-token must equal the Vault secret `import_token`. Create it for the migration and
// delete it afterwards:
//   select vault.create_secret(encode(gen_random_bytes(24), 'hex'), 'import_token');
//   delete from vault.secrets where name = 'import_token';
// With no `import_token` in Vault the endpoint refuses everything.
//
// Body: { entity: 'Lead', rows: [...] }  →  { written, failed: [{ id, error }], unknown_fields: {...} }
import { getSql } from '../_shared/entities.ts';
import { ENTITIES, type ColumnType } from '../_shared/schema.ts';
import { serve } from '../_shared/runtime.ts';

const SYSTEM_DROP = new Set(['created_by']);
const WRITE_CAST: Record<ColumnType, string> = { text: 'text', integer: 'integer', 'double precision': 'float8', boolean: 'boolean', jsonb: 'text::jsonb', timestamptz: 'timestamptz', uuid: 'uuid' };

function normalizeTimestamp(v: unknown): unknown {
  if (typeof v !== 'string' || !v) return v;
  return /[zZ]$|[+-]\d{2}:?\d{2}$/.test(v) ? v : `${v}Z`;
}
function coerce(v: unknown, type: ColumnType): unknown {
  if (v === null || v === undefined) return null;
  switch (type) {
    case 'jsonb': return JSON.stringify(v);
    case 'timestamptz': return normalizeTimestamp(v);
    case 'boolean': return typeof v === 'string' ? v === 'true' : Boolean(v);
    case 'integer': return typeof v === 'number' ? Math.round(v) : Number(v);
    case 'double precision': return Number(v);
    case 'text': return typeof v === 'string' ? v : JSON.stringify(v);
    default: return v;
  }
}
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

serve(async (req: Request) => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const sql = getSql();
  const sent = req.headers.get('x-import-token') || '';
  const rows0 = await sql`select decrypted_secret from vault.decrypted_secrets where name = 'import_token' limit 1`;
  const expected = String((rows0[0] as { decrypted_secret?: string } | undefined)?.decrypted_secret || '');
  // No `import_token` in Vault means the migration endpoint is switched off: it does not exist as far as callers can tell.
  if (!expected) return json({ error: 'Not found' }, 404);
  if (!sent || !timingSafeEqual(sent, expected)) return json({ error: 'Not allowed.' }, 403);

  let body: { entity?: string; rows?: Record<string, unknown>[] } = {};
  try { body = await req.json(); } catch { return json({ error: 'Bad JSON' }, 400); }
  const meta = ENTITIES[String(body.entity || '')];
  if (!meta) return json({ error: `Unknown entity ${body.entity}` }, 400);
  const input = Array.isArray(body.rows) ? body.rows : [];
  if (input.length > 500) return json({ error: 'At most 500 rows per call' }, 400);

  const columns = Object.keys(meta.columns);
  const quoted = columns.map((c) => `"${c}"`);
  const unknown: Record<string, number> = {};
  const rows: Record<string, unknown>[] = [];
  const failed: { id: unknown; error: string }[] = [];
  for (const raw of input) {
    const row: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (SYSTEM_DROP.has(k)) continue;
      if (!meta.columns[k]) { unknown[k] = (unknown[k] || 0) + 1; continue; }
      row[k] = v;
    }
    if (!row.id) { failed.push({ id: raw.id, error: 'missing id' }); continue; }
    rows.push(row);
  }

  const upsert = async (tx: typeof sql, batch: Record<string, unknown>[]) => {
    const params: unknown[] = [];
    const tuples = batch.map((row) => `(${columns.map((c) => {
      if (!(c in row)) return 'DEFAULT';
      params.push(coerce(row[c], meta.columns[c]));
      return `$${params.length}::${WRITE_CAST[meta.columns[c]]}`;
    }).join(', ')})`);
    const updates = columns.filter((c) => c !== 'id').map((c) => `"${c}" = excluded."${c}"`).join(', ');
    await tx.unsafe(`INSERT INTO public."${meta.table}" (${quoted.join(', ')}) VALUES ${tuples.join(', ')} ON CONFLICT (id) DO UPDATE SET ${updates}`, params as never[]);
  };
  let written = 0;
  const run = async (batch: Record<string, unknown>[]) => {
    await sql.begin(async (tx) => {
      await tx.unsafe(`select set_config('respark.import', 'on', true)`);
      await upsert(tx as unknown as typeof sql, batch);
    });
  };
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    try { await run(batch); written += batch.length; } catch (batchError) {
      for (const row of batch) {
        try { await run([row]); written++; } catch (e) { failed.push({ id: row.id, error: (e as Error).message || String(batchError) }); }
      }
    }
  }
  return json({ entity: body.entity, table: meta.table, received: input.length, written, failed, unknown_fields: unknown });
});
