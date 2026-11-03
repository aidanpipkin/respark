// Generates supabase/migrations/0001_schema.sql and supabase/functions/_shared/schema.ts
// from the Base44 entity schemas in legacy_base44/entities/*.jsonc.
//
//   deno run -A scripts/gen-schema.ts
//
// The jsonc files are the source of truth for columns, enums, defaults and RLS; the index list
// below is hand-written from the query patterns in legacy_base44/functions and shared.
import { parse } from 'npm:jsonc-parser@3.3.1';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENTITIES_DIR = join(ROOT, 'legacy_base44', 'entities');
const SQL_OUT = join(ROOT, 'supabase', 'migrations', '0001_schema.sql');
const TS_OUT = join(ROOT, 'supabase', 'functions', '_shared', 'schema.ts');

type Prop = { type?: string | string[]; enum?: unknown[]; default?: unknown; description?: string; items?: Prop; rls?: { read?: boolean; write?: boolean }; format?: string };
type Entity = { name: string; properties?: Record<string, Prop>; required?: string[]; rls?: Record<string, unknown> };

// Indexes beyond the per-table agent_email index. `unique:` marks keys the code upserts on and
// expects to be single rows (engine cursors, dispatch jobs, singletons).
const INDEXES: Record<string, Array<string[] | { unique: string[] }>> = {
  Lead: [
    ['agent_email', 'status', 'next_send_at'], ['agent_email', 'campaign_id'], ['agent_email', 'phone'],
    ['agent_email', 'ghl_contact_id'], ['agent_email', 'track', 'track_next_at'], ['agent_email', 'last_inbound_at'],
    ['agent_email', 'updated_date'], ['agent_email', 'import_batch'], ['status', 'last_inbound_at'], ['agent_email', 'from_number'],
  ],
  MessageLog: [['agent_email', 'lead_id', 'event_type', 'occurred_at'], ['agent_email', 'ghl_message_id'], ['event_type', 'occurred_at']],
  MessageDispatch: [{ unique: ['key'] }, ['state', 'updated_date'], ['agent_email', 'kind', 'ghl_message_id'], ['kind', 'state', 'delivery_status']],
  ConversationSummary: [['agent_email', 'last_time'], ['agent_email', 'lead_id'], ['agent_email', 'ghl_contact_id']],
  Appointment: [['agent_email', 'start_time'], ['agent_email', 'lead_id', 'status'], ['agent_email', 'ghl_appointment_id'], ['status', 'start_time']],
  EngineCursor: [{ unique: ['key'] }],
  A2PRegistration: [['status', 'provider_step']],
  BillingAccount: [['stripe_customer_id'], ['subscription_status']],
  PlatformSettings: [{ unique: ['singleton_key'] }],
  PlatformCredential: [{ unique: ['key'] }],
  AIDraft: [['agent_email', 'lead_id', 'status'], ['campaign_id', 'status'], ['status', 'created_date']],
  AgentSettings: [['location_id'], ['public_slug'], ['domain'], ['lead_webhook_key'], ['status']],
  AgentBrief: [{ unique: ['key'] }],
  Campaign: [['agent_email', 'location_id'], ['agent_email', 'name']],
  SequenceStep: [['campaign_id', 'step_number']],
  PhoneNumber: [['agent_email', 'status']],
  TwilioAccount: [['phone_number'], ['subaccount_sid']],
  CallLog: [['agent_email', 'lead_id', 'started_at'], ['agent_email', 'started_at']],
  Policy: [['agent_email', 'lead_id'], ['agent_email', 'status']],
  LeadNote: [['agent_email', 'lead_id', 'created_at']],
  CreditTransaction: [['agent_email', 'created_at'], ['stripe_payment_intent_id']],
  WebsiteSubmission: [['agent_email', 'submitted_at'], ['request_key'], ['lead_id']],
  ConsentRecord: [['agent_email', 'submission_id']],
  ControlAudit: [['agent_email', 'lead_id', 'occurred_at']],
  SystemEvent: [['status', 'last_seen_at'], ['key'], ['agent_email', 'status']],
  SupportRequest: [['agent_email', 'created_at'], ['status']],
  Referral: [['referrer_email'], ['referee_email'], ['status']],
  SavedView: [['agent_email', 'position']],
  QuickReply: [['agent_email', 'position']],
  PromptVersion: [['campaign_id', 'version']],
  ProvisioningTask: [{ unique: ['key'] }, ['agent_email', 'created_date']],
  CalendarConnection: [['agent_email', 'status']],
  StatsSnapshot: [['agent_email', 'campaign_id']],
  PreviewRun: [['campaign_id']],
};

export function tableName(entity: string): string {
  if (entity === 'User') return 'profiles';
  return entity.replace(/(?<=[A-Za-z0-9])(?=[A-Z][a-z])/g, '_').toLowerCase();
}

function sqlType(p: Prop): string {
  const t = Array.isArray(p.type) ? (p.type.includes('string') ? 'string' : p.type[0]) : p.type;
  switch (t) {
    case 'string': return 'text';
    case 'integer': return 'integer';
    // JSON numbers are doubles; only a description that says "integer"/"whole number" narrows the type.
    case 'number': return /\b(integer|whole number)\b/i.test(p.description || '') ? 'integer' : 'double precision';
    case 'boolean': return 'boolean';
    case 'array': case 'object': return 'jsonb';
    default: return 'text';
  }
}

const q = (s: string) => `'${String(s).replace(/'/g, "''")}'`;
const ident = (s: string) => `"${s}"`;

function sqlDefault(p: Prop, type: string): string {
  if (p.default === undefined) return '';
  if (type === 'jsonb') return ` default ${q(JSON.stringify(p.default))}::jsonb`;
  if (type === 'boolean') return ` default ${p.default ? 'true' : 'false'}`;
  if (type === 'integer' || type === 'double precision') return ` default ${Number(p.default)}`;
  return ` default ${q(String(p.default))}`;
}

function readsOwner(rls: Record<string, unknown> | undefined): boolean {
  return JSON.stringify(rls?.read ?? null).includes('data.agent_email');
}
function readsAdmin(rls: Record<string, unknown> | undefined): boolean {
  const r = rls?.read; if (r === false || r === undefined) return false;
  return JSON.stringify(r).includes('"role":"admin"');
}
function adminMay(rls: Record<string, unknown> | undefined, op: string): boolean {
  const r = rls?.[op]; if (r === false || r === undefined) return false;
  return JSON.stringify(r).includes('"role":"admin"');
}

async function main() {
  const entities: Entity[] = [];
  for await (const e of Deno.readDir(ENTITIES_DIR)) {
    if (!e.name.endsWith('.jsonc')) continue;
    entities.push(parse(await Deno.readTextFile(join(ENTITIES_DIR, e.name))) as Entity);
  }
  entities.sort((a, b) => a.name.localeCompare(b.name));

  const sql: string[] = [];
  const meta: Record<string, unknown> = {};
  sql.push(`-- Generated by scripts/gen-schema.ts from legacy_base44/entities/*.jsonc. Edit the generator, not this file.
-- Conventions: Base44 ids are kept as text; created_date/updated_date are timestamptz(3) so the
-- millisecond ISO strings the code round-trips (optimistic locks on updated_date) compare exactly.
-- Date-like business fields (next_send_at, occurred_at, ...) stay text: the code compares them as ISO strings.

create extension if not exists pgcrypto;

create or replace function public.set_updated_date() returns trigger
language plpgsql as $$
begin
  new.updated_date = now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- profiles: replaces the Base44 User entity. One row per auth user.
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique,
  full_name text,
  role text not null default 'agent' check (role in ('admin', 'agent', 'user')),
  created_date timestamptz(3) not null default now(),
  updated_date timestamptz(3) not null default now()
);
create trigger profiles_updated before update on public.profiles for each row execute function public.set_updated_date();

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare owner boolean;
begin
  -- The platform owner (PlatformSettings.owner_email) is an admin from the first sign-in; everyone else is an agent.
  select exists(select 1 from public.platform_settings where lower(owner_email) = lower(new.email)) into owner;
  insert into public.profiles (id, email, full_name, role)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', ''),
          case when owner then 'admin' when new.raw_user_meta_data->>'role' in ('agent', 'user') then new.raw_user_meta_data->>'role' else 'agent' end)
  on conflict (id) do update set email = excluded.email;
  return new;
end $$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'admin' from public.profiles where id = auth.uid()), false)
$$;

create or replace function public.jwt_email() returns text
language sql stable as $$
  select lower(coalesce(auth.jwt()->>'email', ''))
$$;

alter table public.profiles enable row level security;
create policy profiles_self_select on public.profiles for select to authenticated using (id = auth.uid() or public.is_admin());
create policy profiles_admin_update on public.profiles for update to authenticated using (public.is_admin()) with check (public.is_admin());
`);

  const views: string[] = [];
  for (const ent of entities) {
    if (ent.name === 'User') { meta.User = { table: 'profiles', columns: { id: 'uuid', email: 'text', full_name: 'text', role: 'text', created_date: 'timestamptz', updated_date: 'timestamptz' }, hidden: [], ownerField: 'email' }; continue; }
    const table = tableName(ent.name);
    const props = ent.properties ?? {};
    const cols: string[] = [
      `id text primary key default gen_random_uuid()::text`,
      `created_date timestamptz(3) not null default now()`,
      `updated_date timestamptz(3) not null default now()`,
      `created_by_id text`,
      `is_sample boolean default false`,
    ];
    const columns: Record<string, string> = { id: 'text', created_date: 'timestamptz', updated_date: 'timestamptz', created_by_id: 'text', is_sample: 'boolean' };
    const hidden: string[] = [];
    const checks: string[] = [];
    for (const [name, p] of Object.entries(props)) {
      if (columns[name]) continue; // the schema repeats a system column
      const type = sqlType(p);
      columns[name] = type;
      let line = `${ident(name)} ${type}${sqlDefault(p, type)}`;
      if (p.enum && type === 'text') {
        const vals = p.enum.filter((v) => typeof v === 'string') as string[];
        checks.push(`constraint ${table}_${name}_check check (${ident(name)} is null or ${ident(name)} in (${vals.map(q).join(', ')}))`);
      }
      if (p.rls?.read === false) hidden.push(name);
      cols.push(line);
    }
    sql.push(`-- ---------------------------------------------------------------------------\n-- ${ent.name}\n-- ---------------------------------------------------------------------------`);
    sql.push(`create table if not exists public.${table} (\n  ${[...cols, ...checks].join(',\n  ')}\n);`);
    sql.push(`create trigger ${table}_updated before update on public.${table} for each row execute function public.set_updated_date();`);

    const hasEmail = 'agent_email' in columns;
    const seen = new Set<string>();
    const addIndex = (fields: string[], unique = false) => {
      const key = fields.join(',');
      if (seen.has(key)) return; seen.add(key);
      const missing = fields.filter((f) => !columns[f]);
      if (missing.length) throw new Error(`${ent.name}: index on unknown column(s) ${missing.join(', ')}`);
      sql.push(`create ${unique ? 'unique ' : ''}index if not exists ${table}_${fields.join('_')}_idx on public.${table} (${fields.map(ident).join(', ')});`);
    };
    if (hasEmail) addIndex(['agent_email']);
    for (const ix of INDEXES[ent.name] ?? []) Array.isArray(ix) ? addIndex(ix) : addIndex(ix.unique, true);

    // RLS. The service role (edge functions) bypasses RLS. Authenticated users only ever read:
    // every jsonc grants create/update/delete to admins at most, so writes go through functions.
    sql.push(`alter table public.${table} enable row level security;`);
    const owner = readsOwner(ent.rls) && hasEmail;
    const admin = readsAdmin(ent.rls);
    const ownerCond = ent.name === 'SystemEvent' ? `(agent_email = public.jwt_email() and agent_visible = true)` : `agent_email = public.jwt_email()`;
    if (hidden.length === 0) {
      const parts = [owner ? ownerCond : '', admin ? 'public.is_admin()' : ''].filter(Boolean);
      if (parts.length) sql.push(`create policy ${table}_select on public.${table} for select to authenticated using (${parts.join(' or ')});`);
    } else {
      // Fields with "rls": {"read": false} stay off the owner's direct reads: the base table is admin-only
      // and owners read through a view that leaves those columns out.
      if (admin) sql.push(`create policy ${table}_admin_select on public.${table} for select to authenticated using (public.is_admin());`);
      const visible = Object.keys(columns).filter((c) => !hidden.includes(c));
      const where = ent.name === 'AgentSettings' || owner ? `${ownerCond} or public.is_admin()` : 'public.is_admin()';
      views.push(`create or replace view public.v_${table} with (security_barrier) as\n  select ${visible.map(ident).join(', ')} from public.${table} where ${where};\ngrant select on public.v_${table} to authenticated;`);
    }
    for (const op of ['insert', 'update', 'delete'] as const) {
      const jsonOp = op === 'insert' ? 'create' : op;
      if (!adminMay(ent.rls, jsonOp)) continue;
      const clause = op === 'insert' ? `with check (public.is_admin())` : op === 'update' ? `using (public.is_admin()) with check (public.is_admin())` : `using (public.is_admin())`;
      sql.push(`create policy ${table}_admin_${op} on public.${table} for ${op} to authenticated ${clause};`);
    }
    sql.push('');
    meta[ent.name] = { table, columns, hidden, ownerField: hasEmail ? 'agent_email' : null, required: ent.required ?? [] };
  }

  sql.push(`-- ---------------------------------------------------------------------------
-- Owner-safe views for tables whose jsonc hides fields ("rls": {"read": false}).
-- Views run as their owner (postgres) so they see past RLS; the where clause scopes rows.
-- ---------------------------------------------------------------------------`);
  sql.push(...views);
  sql.push(`
-- Create profile rows for new auth users. Must come after platform_settings exists.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

grant usage on schema public to anon, authenticated, service_role;
grant select on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;
`);

  await Deno.writeTextFile(SQL_OUT, sql.join('\n'));
  await Deno.writeTextFile(TS_OUT, `// Generated by scripts/gen-schema.ts. Column types drive parameter casts in entities.ts.
export type ColumnType = 'text' | 'integer' | 'double precision' | 'boolean' | 'jsonb' | 'timestamptz' | 'uuid';
export type EntityMeta = { table: string; columns: Record<string, ColumnType>; hidden: string[]; ownerField: string | null; required?: string[] };
export const ENTITIES: Record<string, EntityMeta> = ${JSON.stringify(meta, null, 2)};
`);
  console.log(`wrote ${SQL_OUT} (${entities.length - 1} tables + profiles) and ${TS_OUT}`);
}

if (import.meta.main) await main();
