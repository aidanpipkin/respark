// Translates the Mongo-style query objects used across src/ into PostgREST
// filters, and handles sort / limit / fields / keyset cursors. Pure functions:
// no network, so the whole file is unit-testable (see query.test.js).
//
// `translateQuery(q)` returns a list of top-level conjuncts (ANDed). Each is
// either `{ column, operator, value }` (applied with supabase's `.filter()`,
// value unquoted) or `{ or: '<postgrest logic string>' }` (applied with
// `.or()`, values quoted where PostgREST needs it), e.g.
// `or: 'first_name.ilike.*al*,last_name.ilike.*al*'`.

/** Entity name -> table name: Lead→lead, AgentSettings→agent_settings, A2PRegistration→a2p_registration, AIDraft→ai_draft. */
export function tableName(entity) {
  return String(entity)
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/([A-Z0-9]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

/** Field path -> PostgREST column reference. `meta.plan` → `meta->>plan`. */
export function columnRef(path) {
  const parts = String(path).split('.');
  if (parts.length === 1) return parts[0];
  const [root, ...rest] = parts;
  return root + rest.map((p, i) => (i === rest.length - 1 ? `->>${p}` : `->${p}`)).join('');
}

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date);
const isOperatorObject = v => isPlainObject(v) && Object.keys(v).length > 0 && Object.keys(v).every(k => k.startsWith('$'));

function raw(v) {
  if (v instanceof Date) return v.toISOString();
  if (v === null || v === undefined) return 'null';
  return String(v);
}

/** Quote a value for use inside a PostgREST list or logic string. */
export function quoteValue(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = raw(v);
  if (s === '') return '""';
  if (/[,.:()"\\\s]/.test(s)) return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  return s;
}

const listValue = arr => '(' + arr.map(quoteValue).join(',') + ')';
const arrayLiteral = arr => '{' + arr.map(quoteValue).join(',') + '}';

const SIMPLE_META = /[\^$.*+?()[\]{}|\\]/;

/**
 * Turn a Mongo regex into a PostgREST operator + pattern. Plain substrings
 * (metacharacters escaped with backslashes, as every call site in src/ does)
 * become `ilike`/`like` with `*` wildcards; anything else falls back to the
 * `imatch`/`match` (POSIX regex) operators.
 */
export function regexToPattern(regex, options = '') {
  const source = regex instanceof RegExp ? regex.source : String(regex);
  const flags = (regex instanceof RegExp ? regex.flags : '') + (options || '');
  const ci = flags.includes('i');
  let body = source;
  const anchoredStart = body.startsWith('^');
  const anchoredEnd = /(^|[^\\])\$$/.test(body);
  if (anchoredStart) body = body.slice(1);
  if (anchoredEnd) body = body.slice(0, -1);
  let literal = '';
  let simple = true;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\' && i + 1 < body.length) { literal += body[++i]; continue; }
    if (SIMPLE_META.test(ch)) { simple = false; break; }
    literal += ch;
  }
  if (!simple) return { operator: ci ? 'imatch' : 'match', value: source };
  const escaped = literal.replace(/[%_]/g, m => '\\' + m);
  return { operator: ci ? 'ilike' : 'like', value: (anchoredStart ? '' : '*') + escaped + (anchoredEnd ? '' : '*') };
}

// ---- Nodes ------------------------------------------------------------------
// leaf: { col, op, value (JS value or null), list (pre-rendered literal) }
// group: { kind: 'or' | 'and' | 'not.or', items }

const leaf = (col, op, value, list) => ({ col, op, value, list });
const group = (kind, items) => (items.length === 1 && kind !== 'not.or' ? items[0] : { kind, items });

function renderLeaf(n, quoted) {
  const v = n.list !== undefined ? n.list : quoted ? quoteValue(n.value) : raw(n.value);
  return `${n.col}.${n.op}.${v}`;
}

export function renderNode(n) {
  if (n.kind) return `${n.kind}(${n.items.map(renderNode).join(',')})`;
  return renderLeaf(n, true);
}

function fieldNodes(path, value) {
  const col = columnRef(path);
  if (!isOperatorObject(value)) {
    if (value === null || value === undefined) return [leaf(col, 'is', null, 'null')];
    if (Array.isArray(value)) return [leaf(col, 'cs', null, arrayLiteral(value))];
    return [leaf(col, 'eq', value)];
  }
  const out = [];
  for (const [op, v] of Object.entries(value)) {
    switch (op) {
      case '$eq': out.push(...fieldNodes(path, v)); break;
      case '$ne':
        // Mongo's $ne matches rows where the field is missing; SQL's <> does not.
        out.push(v === null ? leaf(col, 'not.is', null, 'null') : group('or', [leaf(col, 'is', null, 'null'), leaf(col, 'neq', v)]));
        break;
      case '$gt': out.push(leaf(col, 'gt', v)); break;
      case '$gte': out.push(leaf(col, 'gte', v)); break;
      case '$lt': out.push(leaf(col, 'lt', v)); break;
      case '$lte': out.push(leaf(col, 'lte', v)); break;
      case '$in': {
        const arr = Array.isArray(v) ? v : [v];
        const rest = arr.filter(x => x !== null && x !== undefined);
        const parts = [];
        if (rest.length) parts.push(leaf(col, 'in', null, listValue(rest)));
        if (rest.length !== arr.length) parts.push(leaf(col, 'is', null, 'null'));
        out.push(parts.length ? group('or', parts) : leaf(col, 'in', null, '()'));
        break;
      }
      case '$nin': {
        const arr = Array.isArray(v) ? v : [v];
        const rest = arr.filter(x => x !== null && x !== undefined);
        if (rest.length !== arr.length) {
          // "not null and not in (...)": SQL's NOT IN already drops nulls.
          out.push(rest.length ? leaf(col, 'not.in', null, listValue(rest)) : leaf(col, 'not.is', null, 'null'));
        } else if (rest.length) {
          // Mongo keeps rows where the field is missing; keep them too.
          out.push(group('or', [leaf(col, 'is', null, 'null'), leaf(col, 'not.in', null, listValue(rest))]));
        }
        break;
      }
      case '$exists': out.push(leaf(col, v ? 'not.is' : 'is', null, 'null')); break;
      case '$regex': {
        const { operator, value: pattern } = regexToPattern(v, value.$options);
        out.push(leaf(col, operator, pattern));
        break;
      }
      case '$options': break; // consumed by $regex
      case '$contains': case '$all': out.push(leaf(col, 'cs', null, arrayLiteral(Array.isArray(v) ? v : [v]))); break;
      default: throw new Error(`Unsupported query operator ${op} on ${path}`);
    }
  }
  return out;
}

function queryNodes(query) {
  const out = [];
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined) continue;
    if (key === '$and') { for (const sub of value) out.push(...queryNodes(sub)); continue; }
    if (key === '$or' || key === '$nor') {
      const branches = (value || []).map(sub => queryNodes(sub)).filter(n => n.length).map(n => group('and', n));
      if (branches.length) out.push(key === '$or' ? group('or', branches) : { kind: 'not.or', items: branches });
      continue;
    }
    if (key.startsWith('$')) throw new Error(`Unsupported top-level operator ${key}`);
    out.push(...fieldNodes(key, value));
  }
  return out;
}

/**
 * Translate a query object into conjuncts for a supabase query builder.
 * Leaves: `{column, operator, value}` for `.filter()`; groups: `{ or }` for `.or()`.
 */
export function translateQuery(query) {
  return queryNodes(query).map(n => {
    if (!n.kind) return { column: n.col, operator: n.op, value: n.list !== undefined ? n.list : raw(n.value) };
    if (n.kind === 'or') return { or: n.items.map(renderNode).join(',') };
    return { or: renderNode(n) };
  });
}

/** Apply translated conjuncts to a supabase/postgrest query builder. */
export function applyQuery(builder, query) {
  for (const c of translateQuery(query)) {
    builder = c.or !== undefined ? builder.or(c.or) : builder.filter(c.column, c.operator, c.value);
  }
  return builder;
}

// ---- Sort / fields / cursor -------------------------------------------------

/** `'field'` / `'-field'` -> `{ column, ascending }`; defaults to id ascending. */
export function parseSort(sort) {
  const s = Array.isArray(sort) ? sort[0] : sort;
  if (!s) return { column: 'id', ascending: true };
  const desc = s.startsWith('-');
  return { column: desc ? s.slice(1) : s.replace(/^\+/, ''), ascending: !desc };
}

/** Options for `.order()`: Postgres defaults (ASC NULLS LAST / DESC NULLS FIRST) made explicit. */
export function orderOptions(sort) {
  const { column, ascending } = parseSort(sort);
  return { column: columnRef(column), ascending, nullsFirst: !ascending };
}

/** Select list for PostgREST; `id` is always included so cursors work. */
export function selectList(fields) {
  if (!fields || !fields.length) return '*';
  const list = fields.map(f => columnRef(f));
  if (!list.includes('id')) list.unshift('id');
  return list.join(',');
}

const utf8ToB64 = s => (typeof btoa === 'function' ? btoa(String.fromCharCode(...new TextEncoder().encode(s))) : Buffer.from(s, 'utf8').toString('base64'));
const b64ToUtf8 = s => (typeof atob === 'function' ? new TextDecoder().decode(Uint8Array.from(atob(s), c => c.charCodeAt(0))) : Buffer.from(s, 'base64').toString('utf8'));
const b64url = {
  encode: s => utf8ToB64(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  decode: s => b64ToUtf8(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)),
};

/** Keyset cursor: the last row's sort value and id, base64url-encoded. */
export function encodeCursor(row, sort) {
  const { column } = parseSort(sort);
  const value = row[column];
  return b64url.encode(JSON.stringify({ c: column, v: value === undefined ? null : value, id: row.id }));
}

export function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(b64url.decode(String(cursor)));
    if (!parsed || typeof parsed !== 'object' || !('id' in parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * PostgREST logic string selecting the rows strictly after the cursor row under
 * `ORDER BY column ASC NULLS LAST | DESC NULLS FIRST, id ASC` (see orderOptions).
 * Returns null when the cursor is empty or invalid.
 */
export function cursorFilter(cursor, sort) {
  const c = decodeCursor(cursor);
  if (!c) return null;
  const { column, ascending } = parseSort(sort);
  const col = columnRef(c.c || column);
  const idAfter = leaf('id', 'gt', c.id);
  if (col === 'id') return renderNode(ascending ? idAfter : leaf('id', 'lt', c.id));
  if (c.v === null || c.v === undefined) {
    // Cursor row has a null sort value: ASC -> trailing null block; DESC ->
    // leading null block, every non-null row still follows.
    const inNulls = group('and', [leaf(col, 'is', null, 'null'), idAfter]);
    return renderNode(ascending ? inNulls : group('or', [inNulls, leaf(col, 'not.is', null, 'null')]));
  }
  const tie = group('and', [leaf(col, 'eq', c.v), idAfter]);
  return renderNode(ascending
    ? group('or', [leaf(col, 'gt', c.v), leaf(col, 'is', null, 'null'), tie])
    : group('or', [leaf(col, 'lt', c.v), tie]));
}
