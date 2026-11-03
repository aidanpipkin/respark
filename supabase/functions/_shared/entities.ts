// Base44 entity SDK surface on top of Postgres.
//
// Every legacy call site uses one of: filter, list, get, create, bulkCreate, update, bulkUpdate,
// updateMany, upsert, count, delete, deleteMany. Queries are Mongo-style objects; this module
// compiles them to parameterized SQL (values are never interpolated). Table and column metadata
// comes from schema.ts, generated from the jsonc entity schemas by scripts/gen-schema.ts.
import postgres, { type TransactionSql } from 'npm:postgres@3.4.7';
import { ENTITIES, type ColumnType, type EntityMeta } from './schema.ts';

export type Sql = ReturnType<typeof postgres>;
export type Query = Record<string, unknown>;
export type FilterOptions = { sort?: string; limit?: number; cursor?: string | null; fields?: string[]; skip?: number };
export type Page<T = Record<string, unknown>> = { items: T[]; has_more: boolean; next_cursor: string | null };
export type Scope = { email: string; userId?: string; admin: boolean } | null;

const DEFAULT_LIMIT = 50;

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

// Postgres prints "2026-11-03 08:33:00.123+00"; the code expects the ISO form Base44 returned.
function parseTimestamp(v: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?(?:([+-]\d{2})(?::?(\d{2}))?)?$/.exec(v);
  if (!m) return new Date(v).toISOString();
  const iso = `${m[1]}T${m[2]}${m[3] ?? ''}${m[4] ? `${m[4]}:${m[5] ?? '00'}` : 'Z'}`;
  return new Date(iso).toISOString();
}

export function connect(url?: string, extra: Record<string, unknown> = {}): Sql {
  const dsn = url ?? Deno.env.get('SUPABASE_DB_URL') ?? Deno.env.get('DATABASE_URL');
  if (!dsn) throw new Error('SUPABASE_DB_URL (or DATABASE_URL) is not set.');
  return postgres(dsn, {
    max: 3,
    idle_timeout: 20,
    connect_timeout: 15,
    // Supavisor (the Supabase pooler) in transaction mode rejects named prepared statements.
    prepare: false,
    connection: { TimeZone: 'UTC' },
    types: {
      timestamptz: { to: 1184, from: [1184, 1114], serialize: (x: unknown) => (x instanceof Date ? x.toISOString() : String(x)), parse: parseTimestamp },
      bigint: { to: 20, from: [20], serialize: (x: unknown) => String(x), parse: Number },
      numeric: { to: 1700, from: [1700], serialize: (x: unknown) => String(x), parse: Number },
    },
    ...extra,
  });
}

let shared: Sql | undefined;
export function getSql(): Sql {
  if (!shared) shared = connect();
  return shared;
}

// ---------------------------------------------------------------------------
// Query compiler
// ---------------------------------------------------------------------------

class Params {
  values: unknown[] = [];
  add(v: unknown, cast: string): string {
    this.values.push(v);
    return `$${this.values.length}${cast ? `::${cast}` : ''}`;
  }
}

// jsonb goes through ::text first: postgres.js JSON-encodes a parameter it sees cast to jsonb,
// which would double-encode the JSON string we already built.
const CAST: Record<ColumnType, string> = { text: 'text', integer: 'float8', 'double precision': 'float8', boolean: 'boolean', jsonb: 'text::jsonb', timestamptz: 'timestamptz', uuid: 'uuid' };
const WRITE_CAST: Record<ColumnType, string> = { ...CAST, integer: 'integer' };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof RegExp);
}
function isOperatorObject(v: unknown): v is Record<string, unknown> {
  return isPlainObject(v) && Object.keys(v).length > 0 && Object.keys(v).every((k) => k.startsWith('$'));
}

const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

type Target = { expr: string; type: ColumnType; jsonPath: string[] | null };

export class EntityError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; this.name = 'EntityError'; }
}

function unknownField(meta: EntityMeta, entity: string, field: string): never {
  throw new EntityError(`Entity ${entity} has no field "${field}" (table ${meta.table}); add it to legacy_base44/entities and rerun scripts/gen-schema.ts.`);
}

function resolve(meta: EntityMeta, entity: string, field: string): Target {
  if (meta.columns[field]) return { expr: quoteIdent(field), type: meta.columns[field], jsonPath: null };
  const [head, ...rest] = field.split('.');
  if (rest.length && meta.columns[head] === 'jsonb') {
    // Dotted path into a jsonb column, e.g. {'details.batch': 'x'}. Segments are restricted to
    // identifier characters so the path literal needs no escaping.
    if (rest.some((s) => !/^[A-Za-z0-9_-]+$/.test(s))) throw new EntityError(`Invalid field path ${field}`);
    return { expr: `(${quoteIdent(head)} #> '{${rest.join(',')}}')`, type: 'jsonb', jsonPath: rest };
  }
  return unknownField(meta, entity, field);
}

function toParam(v: unknown, type: ColumnType): unknown {
  if (v === undefined) return null;
  if (type === 'jsonb') return JSON.stringify(v);
  if (type === 'timestamptz' && v instanceof Date) return v.toISOString();
  if (type === 'boolean' && typeof v === 'string') return v === 'true';
  return v;
}

function compare(t: Target, op: '=' | '<>' | '>' | '>=' | '<' | '<=', value: unknown, p: Params): string {
  if (value === null || value === undefined) {
    if (op === '=') return `${t.expr} IS NULL`;
    if (op === '<>') return `${t.expr} IS NOT NULL`;
    return 'FALSE';
  }
  if (t.type === 'jsonb' && !t.jsonPath && op === '=' && !Array.isArray(value) && !isPlainObject(value)) {
    // Mongo matches a scalar against array elements as well as against the value itself.
    const param = p.add(JSON.stringify(value), CAST.jsonb);
    return `(${t.expr} = ${param} OR (jsonb_typeof(${t.expr}) = 'array' AND ${t.expr} @> jsonb_build_array(${param})))`;
  }
  if (op === '<>') return `${t.expr} IS DISTINCT FROM ${p.add(toParam(value, t.type), CAST[t.type])}`;
  return `${t.expr} ${op} ${p.add(toParam(value, t.type), CAST[t.type])}`;
}

function inList(t: Target, values: unknown[], negate: boolean, p: Params): string {
  const hasNull = values.some((v) => v === null || v === undefined);
  const list = values.filter((v) => v !== null && v !== undefined);
  let match: string;
  if (!list.length) match = 'FALSE';
  else if (t.type === 'jsonb' && !t.jsonPath) {
    const arr = p.add(list.map((v) => JSON.stringify(v)), 'text[]::jsonb[]');
    match = `(${t.expr} = ANY(${arr}) OR (jsonb_typeof(${t.expr}) = 'array' AND EXISTS (SELECT 1 FROM jsonb_array_elements(${t.expr}) e WHERE e.value = ANY(${arr}))))`;
  } else {
    match = `${t.expr} = ANY(${p.add(list.map((v) => toParam(v, t.type)), `${CAST[t.type]}[]`)})`;
  }
  if (!negate) return hasNull ? `(${match} OR ${t.expr} IS NULL)` : match;
  // $nin also matches rows where the field is missing, unless null is in the list.
  return hasNull ? `(${t.expr} IS NOT NULL AND NOT ${match})` : `(${t.expr} IS NULL OR NOT ${match})`;
}

function regex(t: Target, pattern: unknown, options: unknown, p: Params): string {
  const src = pattern instanceof RegExp ? pattern.source : String(pattern);
  const flags = (pattern instanceof RegExp ? pattern.flags : '') + String(options ?? '');
  const expr = t.type === 'text' ? t.expr : `(${t.expr})::text`;
  return `${expr} ${flags.includes('i') ? '~*' : '~'} ${p.add(src, 'text')}`;
}

function fieldCondition(t: Target, value: unknown, p: Params): string {
  if (value instanceof RegExp) return regex(t, value, '', p);
  if (!isOperatorObject(value)) return compare(t, '=', value, p);
  const parts: string[] = [];
  for (const [op, v] of Object.entries(value)) {
    switch (op) {
      case '$eq': parts.push(compare(t, '=', v, p)); break;
      case '$ne': parts.push(compare(t, '<>', v, p)); break;
      case '$gt': parts.push(compare(t, '>', v, p)); break;
      case '$gte': parts.push(compare(t, '>=', v, p)); break;
      case '$lt': parts.push(compare(t, '<', v, p)); break;
      case '$lte': parts.push(compare(t, '<=', v, p)); break;
      case '$in': parts.push(inList(t, Array.isArray(v) ? v : [v], false, p)); break;
      case '$nin': parts.push(inList(t, Array.isArray(v) ? v : [v], true, p)); break;
      case '$exists': parts.push(`${t.expr} IS ${v ? 'NOT ' : ''}NULL`); break;
      case '$regex': parts.push(regex(t, v, value.$options, p)); break;
      case '$options': break;
      case '$not': parts.push(`(${t.expr} IS NULL OR NOT (${fieldCondition(t, v, p)}))`); break;
      case '$size': parts.push(`jsonb_array_length(${t.expr}) = ${p.add(Number(v), 'int')}`); break;
      case '$all': parts.push(`${t.expr} @> ${p.add(JSON.stringify(v), CAST.jsonb)}`); break;
      default: throw new EntityError(`Unsupported query operator ${op}`);
    }
  }
  return parts.length === 1 ? parts[0] : `(${parts.join(' AND ')})`;
}

export function compileWhere(meta: EntityMeta, entity: string, query: Query | undefined, p: Params): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query ?? {})) {
    if (key === '$or' || key === '$and' || key === '$nor') {
      const subs = (Array.isArray(value) ? value : [value]).map((q) => compileWhere(meta, entity, q as Query, p));
      if (!subs.length) continue;
      const joined = subs.map((s) => `(${s})`).join(key === '$and' ? ' AND ' : ' OR ');
      parts.push(key === '$nor' ? `NOT (${joined})` : `(${joined})`);
      continue;
    }
    if (key === '$not') { parts.push(`NOT (${compileWhere(meta, entity, value as Query, p)})`); continue; }
    if (key.startsWith('$')) throw new EntityError(`Unsupported top-level operator ${key}`);
    parts.push(fieldCondition(resolve(meta, entity, key), value, p));
  }
  return parts.length ? parts.join(' AND ') : 'TRUE';
}

// ---------------------------------------------------------------------------
// Cursor: base64url of [sort value, id]
// ---------------------------------------------------------------------------
function encodeCursor(value: unknown, id: unknown): string {
  return btoa(JSON.stringify([value ?? null, id])).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeCursor(cursor: string): [unknown, string] {
  try {
    const json = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'));
    const arr = JSON.parse(json);
    if (!Array.isArray(arr) || arr.length !== 2) throw new Error();
    return [arr[0], String(arr[1])];
  } catch { throw new EntityError('Invalid cursor'); }
}

function parseSort(sort: string | undefined): { field: string; desc: boolean } {
  const s = (sort || 'created_date').trim();
  return s.startsWith('-') ? { field: s.slice(1), desc: true } : { field: s, desc: false };
}

// ---------------------------------------------------------------------------
// Row shaping
// ---------------------------------------------------------------------------
function shapeRow(row: Record<string, unknown>, hide: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    // Base44 documents simply lack unset fields; nulls would change `in` checks and JSON prompts.
    if (v === null || hide.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

const SYSTEM_FIELDS = new Set(['id', 'created_date', 'updated_date']);

// ---------------------------------------------------------------------------
// Entity client
// ---------------------------------------------------------------------------
export type EntityClient = ReturnType<typeof entityClient>;

export function entityClient(sql: Sql, entity: string, scope: Scope = null) {
  const meta = ENTITIES[entity];
  if (!meta) throw new EntityError(`Unknown entity ${entity}`);
  const table = `public.${quoteIdent(meta.table)}`;
  const strict = Deno.env.get('ENTITIES_STRICT') === '1';
  const scoped = !!scope && !scope.admin && !!meta.ownerField;
  const hide = scope && !scope.admin ? meta.hidden : [];

  const scopedQuery = (query: Query | undefined): Query => {
    if (!scoped) return query ?? {};
    return { ...(query ?? {}), [meta.ownerField!]: scope!.email };
  };

  const notFound = (id: string) => new EntityError(`Entity ${entity} with ID ${id} not found`, 404);

  // Splits a write payload into known columns; unknown fields are dropped (schemaless Base44 kept
  // them) with a warning, or rejected when ENTITIES_STRICT=1 (tests).
  function writable(data: Record<string, unknown>, { keepSystem = false } = {}): Array<[string, unknown, ColumnType]> {
    const out: Array<[string, unknown, ColumnType]> = [];
    for (const [k, v] of Object.entries(data ?? {})) {
      if (v === undefined) continue;
      if (SYSTEM_FIELDS.has(k) && !keepSystem) continue;
      const type = meta.columns[k];
      if (!type) {
        if (strict) unknownField(meta, entity, k);
        console.warn(`[entities] ${entity}: dropping unknown field "${k}"`);
        continue;
      }
      out.push([k, toParam(v, type), type]);
    }
    return out;
  }

  function stamp(data: Record<string, unknown>): Record<string, unknown> {
    const d = { ...data };
    if (scoped && meta.ownerField) d[meta.ownerField] = scope!.email;
    if (scope?.userId && d.created_by_id === undefined && meta.columns.created_by_id) d.created_by_id = scope.userId;
    return d;
  }

  async function insertOne(tx: Sql, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    const cols = writable(stamp(data), { keepSystem: true }).filter(([k]) => k !== 'updated_date');
    const p = new Params();
    const text = cols.length
      ? `INSERT INTO ${table} (${cols.map(([k]) => quoteIdent(k)).join(', ')}) VALUES (${cols.map(([, v, t]) => p.add(v, WRITE_CAST[t])).join(', ')}) RETURNING *`
      : `INSERT INTO ${table} DEFAULT VALUES RETURNING *`;
    const rows = await tx.unsafe(text, p.values as never[]);
    return shapeRow(rows[0], hide);
  }

  function setClause(set: Record<string, unknown>, inc: Record<string, unknown>, p: Params): string {
    const parts = writable(set).map(([k, v, t]) => `${quoteIdent(k)} = ${p.add(v, WRITE_CAST[t])}`);
    for (const [k, v] of Object.entries(inc ?? {})) {
      const type = meta.columns[k];
      if (!type) unknownField(meta, entity, k);
      parts.push(`${quoteIdent(k)} = COALESCE(${quoteIdent(k)}, 0) + ${p.add(Number(v), WRITE_CAST[type])}`);
    }
    if (!parts.length) throw new EntityError('Nothing to update');
    return parts.join(', ');
  }

  async function updateById(tx: Sql, id: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    const p = new Params();
    const cols = writable(data);
    if (!cols.length) return get(id);
    const set = cols.map(([k, v, t]) => `${quoteIdent(k)} = ${p.add(v, WRITE_CAST[t])}`).join(', ');
    const where = compileWhere(meta, entity, scopedQuery({ id }), p);
    const rows = await tx.unsafe(`UPDATE ${table} SET ${set} WHERE ${where} RETURNING *`, p.values as never[]);
    if (!rows.length) throw notFound(id);
    return shapeRow(rows[0], hide);
  }

  async function get(id: string): Promise<Record<string, unknown>> {
    const p = new Params();
    const where = compileWhere(meta, entity, scopedQuery({ id }), p);
    const rows = await sql.unsafe(`SELECT * FROM ${table} WHERE ${where} LIMIT 1`, p.values as never[]);
    if (!rows.length) throw notFound(id);
    return shapeRow(rows[0], hide);
  }

  async function page(query: Query | undefined, opts: FilterOptions): Promise<Page> {
    const { field, desc } = parseSort(opts.sort);
    const sortCol = resolve(meta, entity, field);
    const limit = Math.max(1, Math.min(Number(opts.limit) || DEFAULT_LIMIT, 5000));
    const p = new Params();
    const conds = [compileWhere(meta, entity, scopedQuery(query), p)];
    if (opts.cursor) {
      const [value, id] = decodeCursor(opts.cursor);
      const idParam = p.add(id, CAST[meta.columns.id]);
      const f = sortCol.expr;
      if (value === null) {
        conds.push(desc ? `(${f} IS NULL AND "id" < ${idParam})` : `(${f} IS NOT NULL OR (${f} IS NULL AND "id" > ${idParam}))`);
      } else {
        const v = p.add(toParam(value, sortCol.type), CAST[sortCol.type]);
        conds.push(desc ? `(${f} < ${v} OR ${f} IS NULL OR (${f} = ${v} AND "id" < ${idParam}))` : `(${f} > ${v} OR (${f} = ${v} AND "id" > ${idParam}))`);
      }
    }
    const select = opts.fields?.length ? [...new Set(['id', field, ...opts.fields])].map((c) => resolve(meta, entity, c).expr).join(', ') : '*';
    const order = desc ? `${sortCol.expr} DESC NULLS LAST, "id" DESC` : `${sortCol.expr} ASC NULLS FIRST, "id" ASC`;
    const offset = !opts.cursor && opts.skip ? ` OFFSET ${p.add(Math.max(0, Number(opts.skip) || 0), 'int')}` : '';
    const rows = await sql.unsafe(`SELECT ${select} FROM ${table} WHERE ${conds.join(' AND ')} ORDER BY ${order} LIMIT ${p.add(limit + 1, 'int')}${offset}`, p.values as never[]);
    const has_more = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return { items: items.map((r) => shapeRow(r, hide)), has_more, next_cursor: has_more && last ? encodeCursor(last[field], last.id) : null };
  }

  return {
    /** filter(query, {sort, limit, cursor, fields, skip}) → page; filter(query, sort?, limit?, skip?) → array (legacy form). */
    async filter(query?: Query, sortOrOpts?: string | FilterOptions, limit?: number, skip?: number): Promise<Page | Record<string, unknown>[]> {
      if (isPlainObject(sortOrOpts)) return page(query, sortOrOpts as FilterOptions);
      return (await page(query, { sort: sortOrOpts as string | undefined, limit, skip })).items;
    },
    async list(sort?: string, limit?: number, skip?: number): Promise<Record<string, unknown>[]> {
      return (await page({}, { sort, limit, skip })).items;
    },
    get,
    async count(query?: Query): Promise<number> {
      const p = new Params();
      const where = compileWhere(meta, entity, scopedQuery(query), p);
      const rows = await sql.unsafe(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, p.values as never[]);
      return Number(rows[0].n);
    },
    create(data: Record<string, unknown>): Promise<Record<string, unknown>> {
      return insertOne(sql, data ?? {});
    },
    bulkCreate(rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
      if (!rows?.length) return Promise.resolve([]);
      return sql.begin(async (tx) => {
        const out: Record<string, unknown>[] = [];
        for (const r of rows) out.push(await insertOne(tx as unknown as Sql, r));
        return out;
      }) as Promise<Record<string, unknown>[]>;
    },
    update(id: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
      return updateById(sql, id, data ?? {});
    },
    bulkUpdate(rows: Array<Record<string, unknown> & { id: string }>): Promise<Record<string, unknown>[]> {
      return sql.begin(async (tx) => {
        const out: Record<string, unknown>[] = [];
        for (const { id, ...data } of rows ?? []) out.push(await updateById(tx as unknown as Sql, id, data));
        return out;
      }) as Promise<Record<string, unknown>[]>;
    },
    async updateMany(query: Query, change: { $set?: Record<string, unknown>; $inc?: Record<string, unknown> } & Record<string, unknown>): Promise<{ success: boolean; updated: number }> {
      // A bare object (no $ operators) is treated as $set, as the Base44 SDK did.
      const set = change?.$set ?? (change && !('$inc' in change) ? change : {});
      const p = new Params();
      const clause = setClause(set as Record<string, unknown>, (change?.$inc ?? {}) as Record<string, unknown>, p);
      const where = compileWhere(meta, entity, scopedQuery(query), p);
      const res = await sql.unsafe(`UPDATE ${table} SET ${clause} WHERE ${where}`, p.values as never[]);
      return { success: true, updated: res.count };
    },
    async upsert(rows: Record<string, unknown>[], options: { key: string | string[] }): Promise<{ records: Record<string, unknown>[] }> {
      const keys = Array.isArray(options?.key) ? options.key : [options?.key];
      if (!keys.length || keys.some((k) => !k)) throw new EntityError('upsert needs a key');
      for (const k of keys) if (!meta.columns[k]) unknownField(meta, entity, k);
      const records = await sql.begin(async (tx) => {
        const out: Record<string, unknown>[] = [];
        for (const raw of rows ?? []) {
          const row = stamp(raw);
          const match: Query = Object.fromEntries(keys.map((k) => [k, row[k] ?? null]));
          const tryUpdate = async () => {
            const p = new Params();
            const cols = writable(row).filter(([k]) => !keys.includes(k));
            const where = compileWhere(meta, entity, scopedQuery(match), p);
            const text = cols.length
              ? `UPDATE ${table} SET ${cols.map(([k, v, t]) => `${quoteIdent(k)} = ${p.add(v, WRITE_CAST[t])}`).join(', ')} WHERE ${where} RETURNING *`
              : `SELECT * FROM ${table} WHERE ${where}`;
            const rs = await (tx as unknown as Sql).unsafe(text, p.values as never[]);
            return rs[0];
          };
          let found = await tryUpdate();
          if (!found) {
            try {
              // A savepoint keeps a unique-key race from aborting the whole transaction.
              out.push(await (tx as unknown as TransactionSql).savepoint((sp: TransactionSql) => insertOne(sp as unknown as Sql, row)) as Record<string, unknown>);
              continue;
            } catch (e) {
              // Two workers raced on a unique key: the other one inserted, so update instead.
              if ((e as { code?: string }).code !== '23505') throw e;
              found = await tryUpdate();
            }
          }
          out.push(shapeRow(found, hide));
        }
        return out;
      });
      return { records: records as Record<string, unknown>[] };
    },
    async delete(id: string): Promise<{ success: boolean; deleted: number }> {
      const p = new Params();
      const where = compileWhere(meta, entity, scopedQuery({ id }), p);
      const res = await sql.unsafe(`DELETE FROM ${table} WHERE ${where}`, p.values as never[]);
      if (!res.count) throw notFound(id);
      return { success: true, deleted: res.count };
    },
    async deleteMany(query: Query): Promise<{ success: boolean; deleted: number }> {
      if (!query || !Object.keys(query).length) throw new EntityError('deleteMany needs a query; refusing to delete everything');
      const p = new Params();
      const where = compileWhere(meta, entity, scopedQuery(query), p);
      const res = await sql.unsafe(`DELETE FROM ${table} WHERE ${where}`, p.values as never[]);
      return { success: true, deleted: res.count };
    },
  };
}

/** `entities.Lead`, `entities.AgentSettings`, ... with the Base44 method surface. */
export type Entities = Record<string, EntityClient>;

export function createEntities(sql: Sql, scope: Scope = null): Entities {
  const cache = new Map<string, EntityClient>();
  return new Proxy({} as Entities, {
    get(_t, name) {
      if (typeof name !== 'string') return undefined;
      if (!ENTITIES[name]) return undefined;
      if (!cache.has(name)) cache.set(name, entityClient(sql, name, scope));
      return cache.get(name);
    },
    has(_t, name) { return typeof name === 'string' && name in ENTITIES; },
    ownKeys() { return Object.keys(ENTITIES); },
    getOwnPropertyDescriptor(_t, name) {
      return typeof name === 'string' && ENTITIES[name] ? { enumerable: true, configurable: true, value: entityClient(sql, name, scope) } : undefined;
    },
  });
}

/** Service-role entities (no row scoping, hidden fields visible), like base44.asServiceRole.entities. */
export function serviceEntities(sql: Sql = getSql()): Entities {
  return createEntities(sql, null);
}

/** Entities as one user: non-admins only see rows where agent_email is theirs and never see hidden fields. */
export function userEntities(user: { email: string; id?: string; role?: string }, sql: Sql = getSql()): Entities {
  return createEntities(sql, { email: String(user.email || '').toLowerCase(), userId: user.id, admin: user.role === 'admin' });
}
