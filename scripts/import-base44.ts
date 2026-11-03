// Imports Base44 JSONL exports into the Supabase tables, keeping ids and timestamps.
//
//   DATABASE_URL=postgres://postgres:...@db.<ref>.supabase.co:5432/postgres \
//   deno run -A scripts/import-base44.ts --dir ./exports [--only Lead,Campaign] [--batch 200] [--dry-run] [--strict]
//
// Expects one file per entity named <EntityName>.jsonl (Lead.jsonl, AgentSettings.jsonl, ...),
// one record per line exactly as the Base44 entities API returns it (see scripts/export-base44.md).
// Idempotent: rows are upserted on id, so re-running after a partial import or a fresh export is safe.
// Rows a batch cannot insert are retried one by one and the failures written to <dir>/failed/<Entity>.jsonl.
import { parseArgs } from 'node:util';
import { basename, join } from 'node:path';
import { connect, type Sql } from '../supabase/functions/_shared/entities.ts';
import { ENTITIES, type ColumnType } from '../supabase/functions/_shared/schema.ts';

const { values: args } = parseArgs({
  options: {
    dir: { type: 'string', short: 'd' },
    only: { type: 'string' },
    batch: { type: 'string', default: '200' },
    'dry-run': { type: 'boolean', default: false },
    strict: { type: 'boolean', default: false },
  },
});
if (!args.dir) { console.error('usage: import-base44.ts --dir <folder> [--only A,B] [--batch N] [--dry-run] [--strict]'); Deno.exit(2); }

// Base44 adds these to every record; created_by (an email) has no column.
const SYSTEM_DROP = new Set(['created_by']);
const WRITE_CAST: Record<ColumnType, string> = { text: 'text', integer: 'integer', 'double precision': 'float8', boolean: 'boolean', jsonb: 'text::jsonb', timestamptz: 'timestamptz', uuid: 'uuid' };

function normalizeTimestamp(v: unknown): unknown {
  if (typeof v !== 'string' || !v) return v;
  // Exports carry "2026-08-19T01:27:12.951000" (UTC, no offset); Postgres would read it in the session zone.
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

async function* readJsonl(path: string): AsyncGenerator<Record<string, unknown>> {
  const file = await Deno.open(path, { read: true });
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of file.readable) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line);
    }
  }
  if (buf.trim()) yield JSON.parse(buf.trim());
}

type Stats = { read: number; written: number; failed: number; unknownFields: Map<string, number> };

async function importEntity(sql: Sql, entity: string, path: string, batchSize: number, dryRun: boolean, strict: boolean, failedDir: string): Promise<Stats> {
  const meta = ENTITIES[entity];
  const stats: Stats = { read: 0, written: 0, failed: 0, unknownFields: new Map() };
  const failed: string[] = [];
  const columns = Object.keys(meta.columns);
  const quoted = columns.map((c) => `"${c}"`);

  const upsertRows = async (tx: Sql, rows: Record<string, unknown>[]) => {
    const params: unknown[] = [];
    const tuples = rows.map((row) => `(${columns.map((c) => {
      if (!(c in row)) return 'DEFAULT'; // schema default applies, as Base44 did on create
      params.push(coerce(row[c], meta.columns[c]));
      return `$${params.length}::${WRITE_CAST[meta.columns[c]]}`;
    }).join(', ')})`);
    const updates = columns.filter((c) => c !== 'id').map((c) => `"${c}" = excluded."${c}"`).join(', ');
    const text = `INSERT INTO public."${meta.table}" (${quoted.join(', ')}) VALUES ${tuples.join(', ')} ON CONFLICT (id) DO UPDATE SET ${updates}`;
    await tx.unsafe(text, params as never[]);
  };

  const flush = async (batch: Record<string, unknown>[]) => {
    if (!batch.length || dryRun) { stats.written += batch.length; return; }
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(`select set_config('respark.import', 'on', true)`);
        await upsertRows(tx as unknown as Sql, batch);
      });
      stats.written += batch.length;
    } catch (batchError) {
      // Find the offenders (enum violations, bad timestamps) without losing the good rows.
      for (const row of batch) {
        try {
          await sql.begin(async (tx) => {
            await tx.unsafe(`select set_config('respark.import', 'on', true)`);
            await upsertRows(tx as unknown as Sql, [row]);
          });
          stats.written++;
        } catch (e) {
          stats.failed++;
          failed.push(JSON.stringify({ ...row, _error: (e as Error).message || String(batchError) }));
        }
      }
    }
  };

  let batch: Record<string, unknown>[] = [];
  for await (const raw of readJsonl(path)) {
    stats.read++;
    const row: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      if (SYSTEM_DROP.has(k)) continue;
      if (!meta.columns[k]) {
        stats.unknownFields.set(k, (stats.unknownFields.get(k) ?? 0) + 1);
        if (strict) throw new Error(`${entity}: unknown field "${k}" (row ${raw.id}); add it to legacy_base44/entities/${entity}.jsonc and rerun scripts/gen-schema.ts`);
        continue;
      }
      row[k] = v;
    }
    if (!row.id) { stats.failed++; failed.push(JSON.stringify({ ...raw, _error: 'missing id' })); continue; }
    batch.push(row);
    if (batch.length >= batchSize) { await flush(batch); batch = []; }
  }
  await flush(batch);
  if (failed.length) {
    await Deno.mkdir(failedDir, { recursive: true });
    await Deno.writeTextFile(join(failedDir, `${entity}.jsonl`), failed.join('\n') + '\n');
  }
  return stats;
}

async function main() {
  const dir = args.dir!;
  const only = args.only ? new Set(args.only.split(',').map((s) => s.trim())) : null;
  const batchSize = Math.max(1, Number(args.batch) || 200);
  const dryRun = !!args['dry-run'];
  const files: Array<[string, string]> = [];
  for await (const e of Deno.readDir(dir)) {
    if (!e.isFile || !e.name.endsWith('.jsonl')) continue;
    const name = basename(e.name, '.jsonl');
    const entity = ENTITIES[name] ? name : Object.keys(ENTITIES).find((k) => ENTITIES[k].table === name);
    if (!entity) { console.warn(`skip ${e.name}: no entity named ${name}`); continue; }
    if (entity === 'User') { console.warn(`skip ${e.name}: users live in Supabase Auth; invite them (see docs/PORTING.md)`); continue; }
    if (only && !only.has(entity)) continue;
    files.push([entity, join(dir, e.name)]);
  }
  // Settings and campaigns first so anything reading them during import sees complete accounts.
  const order = ['PlatformSettings', 'PlatformCredential', 'AgentSettings', 'Campaign', 'SequenceStep', 'Lead'];
  files.sort((a, b) => (order.indexOf(a[0]) === -1 ? 99 : order.indexOf(a[0])) - (order.indexOf(b[0]) === -1 ? 99 : order.indexOf(b[0])) || a[0].localeCompare(b[0]));
  if (!files.length) { console.error(`no <Entity>.jsonl files in ${dir}`); Deno.exit(1); }

  const sql = connect(undefined, { max: 1 });
  let totalFailed = 0;
  try {
    for (const [entity, path] of files) {
      const s = await importEntity(sql, entity, path, batchSize, dryRun, !!args.strict, join(dir, 'failed'));
      totalFailed += s.failed;
      const unknown = [...s.unknownFields].map(([k, n]) => `${k}×${n}`).join(', ');
      console.log(`${dryRun ? '[dry-run] ' : ''}${entity.padEnd(22)} read ${String(s.read).padStart(6)}  written ${String(s.written).padStart(6)}  failed ${String(s.failed).padStart(4)}${unknown ? `  dropped unknown fields: ${unknown}` : ''}`);
    }
  } finally { await sql.end({ timeout: 5 }); }
  if (totalFailed) { console.error(`${totalFailed} row(s) failed; see ${join(dir, 'failed')}/`); Deno.exit(1); }
}

await main();
