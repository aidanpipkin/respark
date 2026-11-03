// Run with scripts/test.sh (starts a throwaway Postgres, applies the migration, runs deno test).
// Needs TEST_DATABASE_URL pointing at a database where 0001_schema.sql has been applied.
import { deepStrictEqual, ok, rejects } from 'node:assert/strict';

const assert = (v: unknown, msg?: string) => (msg === undefined ? ok(v) : ok(v, msg));
const assertEquals = (a: unknown, b: unknown, msg?: string) => (msg === undefined ? deepStrictEqual(a, b) : deepStrictEqual(a, b, msg));
// Like std's assertRejects: optional error class and message substring; resolves with the error.
async function assertRejects(fn: () => Promise<unknown>, _cls?: unknown, includes?: string): Promise<unknown> {
  let caught: unknown;
  await rejects(async () => { try { await fn(); } catch (e) { caught = e; throw e; } });
  if (includes && !String((caught as Error)?.message).includes(includes)) throw new Error(`expected error containing "${includes}", got "${(caught as Error)?.message}"`);
  return caught;
}
import { connect, serviceEntities, userEntities, type Sql } from './entities.ts';
import { ENTITIES } from './schema.ts';

Deno.env.set('ENTITIES_STRICT', '1');
const url = Deno.env.get('TEST_DATABASE_URL');
if (!url) throw new Error('TEST_DATABASE_URL is not set; run scripts/test.sh');

const sql: Sql = connect(url, { max: 3 });
const E = serviceEntities(sql);
const A = 'alice@example.com', B = 'bob@example.com';

async function reset() {
  const tables = Object.values(ENTITIES).map((m) => m.table).filter((t) => t !== 'profiles');
  await sql.unsafe(`TRUNCATE ${tables.map((t) => `public."${t}"`).join(', ')}`);
  await sql.unsafe(`DELETE FROM public.profiles`);
}

Deno.test('entities adapter', async (t) => {
  await reset();

  await t.step('create applies schema defaults, returns ISO timestamps, drops nulls', async () => {
    const lead = await E.Lead.create({ agent_email: A, location_id: 'loc1', ghl_contact_id: 'c1', first_name: 'Ann', phone: '+15551230001', tags: ['vip', 'import'], lead_facts: { age: 44 } });
    assert(typeof lead.id === 'string' && (lead.id as string).length > 10);
    assertEquals(lead.ai_paused, true); // schema default
    assertEquals(lead.current_step, 0);
    assertEquals(lead.status, undefined); // no default, no null key
    assert(!('last_name' in lead));
    assert(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(String(lead.created_date)));
    assertEquals(lead.tags, ['vip', 'import']);
    assertEquals(lead.lead_facts, { age: 44 });
  });

  await t.step('create keeps a supplied id and created_date (imports)', async () => {
    const row = await E.Lead.create({ id: 'abcdefabcdefabcdefabcdef', created_date: '2024-01-02T03:04:05.678Z', agent_email: B, location_id: 'loc2', ghl_contact_id: 'c2', phone: '+15551230002', status: 'replied', state: 'TX', tags: ['vip'] });
    assertEquals(row.id, 'abcdefabcdefabcdefabcdef');
    assertEquals(row.created_date, '2024-01-02T03:04:05.678Z');
  });

  await t.step('enum CHECK constraints reject bad values', async () => {
    await assertRejects(() => E.Lead.create({ agent_email: A, location_id: 'l', ghl_contact_id: 'x', status: 'bogus' }));
  });

  await t.step('unknown fields are rejected in strict mode', async () => {
    await assertRejects(() => E.Lead.create({ agent_email: A, nonsense: 1 }), Error, 'no field "nonsense"');
    await assertRejects(() => E.Lead.filter({ nonsense: 1 }), Error, 'no field "nonsense"');
  });

  await t.step('get, update, not-found error shape', async () => {
    const lead = await E.Lead.create({ agent_email: A, location_id: 'loc1', ghl_contact_id: 'c3', phone: '+15551230003', status: 'queued' });
    const got = await E.Lead.get(lead.id as string);
    assertEquals(got.phone, '+15551230003');
    const upd = await E.Lead.update(lead.id as string, { status: 'engaged', nudge_count: 2 });
    assertEquals(upd.status, 'engaged');
    assert(String(upd.updated_date) >= String(got.updated_date));
    const err = await assertRejects(() => E.Lead.get('missing-id'), Error, 'Entity Lead with ID missing-id not found');
    assertEquals((err as { status?: number }).status, 404);
    await assertRejects(() => E.Lead.update('missing-id', { status: 'queued' }), Error, 'not found');
  });

  await t.step('optimistic lock on updated_date round-trips exactly', async () => {
    const lead = await E.Lead.create({ agent_email: A, location_id: 'loc1', ghl_contact_id: 'c4', phone: '+15551230004' });
    const r1 = await E.Lead.updateMany({ id: lead.id, updated_date: lead.updated_date }, { $set: { send_lock_token: 't1' } });
    assertEquals(r1, { success: true, updated: 1 });
    // Stale timestamp: must not match.
    const r2 = await E.Lead.updateMany({ id: lead.id, updated_date: lead.updated_date }, { $set: { send_lock_token: 't2' } });
    assertEquals(r2.updated, 0);
    assertEquals((await E.Lead.get(lead.id as string)).send_lock_token, 't1');
  });

  await t.step('operators', async () => {
    await reset();
    const rows = await E.Lead.bulkCreate([
      { agent_email: A, location_id: 'l', ghl_contact_id: 'o1', phone: '+1555000001', status: 'queued', current_step: 1, next_send_at: '2026-01-01T00:00:00.000Z', tags: ['a', 'b'], state: 'TX', first_name: 'Marcus', lead_facts: { kids: 2, batch: 'x1' } },
      { agent_email: A, location_id: 'l', ghl_contact_id: 'o2', phone: '+1555000002', status: 'replied', current_step: 2, next_send_at: '2026-02-01T00:00:00.000Z', tags: ['b'], state: 'CA', first_name: 'marcia', lead_facts: { kids: 0 } },
      { agent_email: A, location_id: 'l', ghl_contact_id: 'o3', phone: '+1555000003', status: 'engaged', current_step: 3, next_send_at: '', tags: [], first_name: 'Zed' },
      { agent_email: B, location_id: 'l', ghl_contact_id: 'o4', phone: '+1555000004', status: 'closed', current_step: 4, ai_paused: false },
    ]);
    assertEquals(rows.length, 4);
    const ids = async (q: Record<string, unknown>) => ((await E.Lead.filter(q, { sort: 'ghl_contact_id', limit: 100 })) as { items: Record<string, unknown>[] }).items.map((r) => r.ghl_contact_id);

    assertEquals(await ids({ status: 'queued' }), ['o1']);
    assertEquals(await ids({ status: { $eq: 'replied' } }), ['o2']);
    assertEquals(await ids({ status: { $in: ['queued', 'closed'] } }), ['o1', 'o4']);
    assertEquals(await ids({ status: { $nin: ['queued', 'closed'] } }), ['o2', 'o3']);
    assertEquals(await ids({ status: { $ne: 'queued' } }), ['o2', 'o3', 'o4']);
    assertEquals(await ids({ current_step: { $gt: 2 } }), ['o3', 'o4']);
    assertEquals(await ids({ current_step: { $gte: 2, $lt: 4 } }), ['o2', 'o3']);
    assertEquals(await ids({ current_step: { $lte: 1 } }), ['o1']);
    // Missing fields: $exists, null equality, $ne against missing, $nin with null
    assertEquals(await ids({ state: { $exists: true } }), ['o1', 'o2']);
    assertEquals(await ids({ state: { $exists: false } }), ['o3', 'o4']);
    assertEquals(await ids({ state: null }), ['o3', 'o4']);
    assertEquals(await ids({ state: { $ne: null } }), ['o1', 'o2']);
    assertEquals(await ids({ state: { $ne: 'TX' } }), ['o2', 'o3', 'o4']);
    assertEquals(await ids({ state: { $exists: true, $nin: ['', null] } }), ['o1', 'o2']);
    assertEquals(await ids({ state: { $nin: ['TX'] } }), ['o2', 'o3', 'o4']);
    assertEquals(await ids({ state: { $in: ['TX', null] } }), ['o1', 'o3', 'o4']);
    // String comparisons on ISO text fields, the engine's "due" pattern
    assertEquals(await ids({ next_send_at: { $gt: '', $lte: '2026-01-15T00:00:00.000Z' } }), ['o1']);
    // Regex with and without options
    assertEquals(await ids({ first_name: { $regex: '^marc', $options: 'i' } }), ['o1', 'o2']);
    assertEquals(await ids({ first_name: { $regex: '^marc' } }), ['o2']);
    assertEquals(await ids({ first_name: /^Z/ }), ['o3']);
    // $or / $and / $not
    assertEquals(await ids({ $or: [{ status: 'queued' }, { agent_email: B }] }), ['o1', 'o4']);
    assertEquals(await ids({ $and: [{ agent_email: A }, { current_step: { $gte: 2 } }] }), ['o2', 'o3']);
    assertEquals(await ids({ agent_email: A, $or: [{ next_send_at: { $lte: '2026-01-15' } }, { next_send_at: { $exists: false } }] }), ['o1', 'o3']); // '' sorts before any ISO string, in Mongo too
    assertEquals(await ids({ current_step: { $not: { $gt: 2 } } }), ['o1', 'o2']);
    assertEquals(await ids({ $not: { status: 'queued' } }), ['o2', 'o3', 'o4']);
    // jsonb array membership and $in on arrays
    assertEquals(await ids({ tags: 'a' }), ['o1']);
    assertEquals(await ids({ tags: 'b' }), ['o1', 'o2']);
    assertEquals(await ids({ tags: { $in: ['a', 'zzz'] } }), ['o1']);
    assertEquals(await ids({ tags: { $all: ['a', 'b'] } }), ['o1']);
    assertEquals(await ids({ tags: { $size: 0 } }), ['o3']);
    assertEquals(await ids({ tags: [] }), ['o3']);
    // Dotted path into jsonb
    assertEquals(await ids({ 'lead_facts.batch': 'x1' }), ['o1']);
    assertEquals(await ids({ 'lead_facts.kids': { $gte: 1 } }), ['o1']);
    assertEquals(await ids({ 'lead_facts.kids': { $exists: true } }), ['o1', 'o2']);
    // Booleans and id filters
    assertEquals(await ids({ ai_paused: false }), ['o4']);
    assertEquals(await ids({ ai_paused: { $ne: true } }), ['o4']);
    assertEquals(await ids({ id: { $in: [rows[0].id, rows[3].id] } }), ['o1', 'o4']);
    // Timestamp comparisons on system columns
    assertEquals((await ids({ created_date: { $gte: '2000-01-01T00:00:00.000Z' } })).length, 4);
    assertEquals(await ids({ created_date: { $lt: '2000-01-01T00:00:00.000Z' } }), []);
    // Empty $in matches nothing, empty query matches all
    assertEquals(await ids({ status: { $in: [] } }), []);
    assertEquals((await ids({})).length, 4);
  });

  await t.step('count, sort, fields, skip, legacy positional filter, list', async () => {
    assertEquals(await E.Lead.count({ agent_email: A }), 3);
    assertEquals(await E.Lead.count(), 4);
    const desc = (await E.Lead.filter({}, { sort: '-current_step', limit: 2 })) as { items: Record<string, unknown>[] };
    assertEquals(desc.items.map((r) => r.current_step), [4, 3]);
    const proj = (await E.Lead.filter({ agent_email: A }, { sort: 'phone', limit: 10, fields: ['phone'] })) as { items: Record<string, unknown>[] };
    assertEquals(Object.keys(proj.items[0]).sort(), ['id', 'phone']);
    const skipped = (await E.Lead.filter({}, { sort: 'current_step', limit: 10, skip: 3 })) as { items: Record<string, unknown>[] };
    assertEquals(skipped.items.map((r) => r.current_step), [4]);
    const arr = await E.Lead.filter({ agent_email: A }, '-current_step', 2) as Record<string, unknown>[];
    assert(Array.isArray(arr));
    assertEquals(arr.map((r) => r.current_step), [3, 2]);
    const listed = await E.Lead.list('current_step', 2, 1);
    assertEquals(listed.map((r) => r.current_step), [2, 3]);
  });

  await t.step('cursor pagination walks every row once, asc and desc, with nulls in the sort column', async () => {
    await reset();
    const rows = [];
    for (let i = 0; i < 23; i++) rows.push({ agent_email: A, location_id: 'l', ghl_contact_id: `p${i}`, phone: `+1555${String(i).padStart(6, '0')}`, next_send_at: i % 4 === 0 ? undefined : `2026-01-${String((i % 7) + 1).padStart(2, '0')}T00:00:00.000Z` });
    await E.Lead.bulkCreate(rows);
    for (const sort of ['next_send_at', '-next_send_at', 'phone', '-created_date']) {
      const seen: string[] = [];
      let cursor: string | null | undefined;
      let pages = 0;
      do {
        const page = (await E.Lead.filter({ agent_email: A }, { sort, limit: 5, cursor })) as { items: Record<string, unknown>[]; has_more: boolean; next_cursor: string | null };
        pages++;
        for (const r of page.items) seen.push(r.ghl_contact_id as string);
        assertEquals(page.has_more, page.next_cursor !== null);
        cursor = page.next_cursor;
      } while (cursor && pages < 20);
      assertEquals(seen.length, 23, `sort ${sort} visited ${seen.length}`);
      assertEquals(new Set(seen).size, 23, `sort ${sort} duplicated rows`);
      assertEquals(pages, 5);
    }
    await assertRejects(() => E.Lead.filter({}, { cursor: '!!not-a-cursor' }), Error, 'Invalid cursor');
  });

  await t.step('updateMany with $set and $inc, bare object as $set', async () => {
    const r = await E.Lead.updateMany({ agent_email: A, ghl_contact_id: { $in: ['p1', 'p2'] } }, { $set: { status: 'replied' }, $inc: { nudge_count: 2 } });
    assertEquals(r.updated, 2);
    const again = await E.Lead.updateMany({ ghl_contact_id: 'p1' }, { $inc: { nudge_count: 1 } });
    assertEquals(again.updated, 1);
    const p1 = ((await E.Lead.filter({ ghl_contact_id: 'p1' }, { limit: 1 })) as { items: Record<string, unknown>[] }).items[0];
    assertEquals(p1.nudge_count, 3);
    assertEquals(p1.status, 'replied');
    await E.Lead.updateMany({ ghl_contact_id: 'p3' }, { status: 'engaged' });
    assertEquals(await E.Lead.count({ status: 'engaged' }), 1);
  });

  await t.step('upsert on a single key: insert then update, defaults applied, records returned', async () => {
    const first = await E.MessageDispatch.upsert([{ key: 'job:1', agent_email: A, location_id: 'l', kind: 'send', lead_id: 'x' }], { key: 'key' });
    assertEquals(first.records.length, 1);
    assertEquals(first.records[0].state, 'new');
    await E.MessageDispatch.updateMany({ id: first.records[0].id, state: 'new' }, { $set: { state: 'working', token: 'tok' } });
    const second = await E.MessageDispatch.upsert([{ key: 'job:1', agent_email: A, location_id: 'l', kind: 'send', lead_id: 'x' }], { key: 'key' });
    assertEquals(second.records[0].id, first.records[0].id);
    assertEquals(second.records[0].state, 'working'); // untouched fields survive
    assertEquals(await E.MessageDispatch.count({ key: 'job:1' }), 1);
    const cursor = await E.EngineCursor.upsert([{ key: 'sequence', cursor: 'abc' }], { key: 'key' });
    await E.EngineCursor.upsert([{ key: 'sequence', cursor: 'def' }], { key: 'key' });
    assertEquals((await E.EngineCursor.get(cursor.records[0].id as string)).cursor, 'def');
  });

  await t.step('upsert on a composite key', async () => {
    const a = await E.ConversationSummary.upsert([{ agent_email: A, location_id: 'l', ghl_contact_id: 'cc1', lead_name: 'One', unread: true }], { key: ['agent_email', 'ghl_contact_id'] });
    const b = await E.ConversationSummary.upsert([{ agent_email: B, location_id: 'l', ghl_contact_id: 'cc1', lead_name: 'Other agent same contact id' }], { key: ['agent_email', 'ghl_contact_id'] });
    assert(a.records[0].id !== b.records[0].id);
    const a2 = await E.ConversationSummary.upsert([{ agent_email: A, location_id: 'l', ghl_contact_id: 'cc1', last_message: 'hi' }], { key: ['agent_email', 'ghl_contact_id'] });
    assertEquals(a2.records[0].id, a.records[0].id);
    assertEquals(a2.records[0].lead_name, 'One');
    assertEquals(a2.records[0].last_message, 'hi');
    assertEquals(await E.ConversationSummary.count({ ghl_contact_id: 'cc1' }), 2);
    // Several rows in one call, mixed insert/update
    const many = await E.ConversationSummary.upsert([
      { agent_email: A, location_id: 'l', ghl_contact_id: 'cc1', unread: false },
      { agent_email: A, location_id: 'l', ghl_contact_id: 'cc2', unread: true },
    ], { key: ['agent_email', 'ghl_contact_id'] });
    assertEquals(many.records.map((r) => r.ghl_contact_id), ['cc1', 'cc2']);
    assertEquals(many.records[0].unread, false);
    await assertRejects(() => E.ConversationSummary.upsert([{ agent_email: A }], { key: '' }), Error, 'needs a key');
  });

  await t.step('concurrent upserts on a unique key never duplicate the row', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => E.MessageDispatch.upsert([{ key: 'race:1', agent_email: A, location_id: 'l', kind: 'send', lead_id: `w${i}` }], { key: 'key' })));
    assertEquals(new Set(results.map((r) => r.records[0].id)).size, 1);
    assertEquals(await E.MessageDispatch.count({ key: 'race:1' }), 1);
  });

  await t.step('bulkUpdate, delete, deleteMany', async () => {
    const steps = await E.SequenceStep.bulkCreate([1, 2, 3].map((n) => ({ agent_email: A, location_id: 'l', campaign_id: 'camp1', step_number: n, body: `v${n}` })));
    const updated = await E.SequenceStep.bulkUpdate(steps.map((s) => ({ id: s.id as string, body: `${s.body}!` })));
    assertEquals(updated.map((s) => s.body), ['v1!', 'v2!', 'v3!']);
    const del = await E.SequenceStep.delete(steps[0].id as string);
    assertEquals(del.success, true);
    await assertRejects(() => E.SequenceStep.delete(steps[0].id as string), Error, 'not found');
    const dm = await E.SequenceStep.deleteMany({ campaign_id: 'camp1' });
    assertEquals(dm.deleted, 2);
    await assertRejects(() => E.SequenceStep.deleteMany({}), Error, 'refusing');
  });

  await t.step('User entity maps to profiles', async () => {
    await sql`insert into auth.users (id, email, raw_user_meta_data) values ('11111111-1111-1111-1111-111111111111', ${A}, ${sql.json({ full_name: 'Alice A' })})`;
    const users = await E.User.filter({ email: A }, '-created_date', 1) as Record<string, unknown>[];
    assertEquals(users.length, 1);
    assertEquals(users[0].full_name, 'Alice A');
    assertEquals(users[0].role, 'agent');
    const u = await E.User.update(users[0].id as string, { role: 'admin' });
    assertEquals(u.role, 'admin');
    await assertRejects(() => E.User.update(users[0].id as string, { role: 'king' }));
  });

  await t.step('per-user client scopes rows and hides read:false fields; admin sees everything', async () => {
    await E.Lead.create({ agent_email: B, location_id: 'secret-loc', ghl_contact_id: 'hidden1', phone: '+1555999', send_lock_token: 'tok' });
    const alice = userEntities({ email: A, role: 'agent' }, sql);
    const bob = userEntities({ email: B, role: 'agent' }, sql);
    const admin = userEntities({ email: 'root@example.com', role: 'admin' }, sql);
    assertEquals(await alice.Lead.count(), 23);
    assertEquals(await bob.Lead.count({}), 1);
    assertEquals(await bob.Lead.count({ agent_email: A }), 1); // scope wins over the caller's filter
    const row = ((await bob.Lead.filter({}, { limit: 1 })) as { items: Record<string, unknown>[] }).items[0];
    assertEquals(row.location_id, undefined);
    assertEquals(row.send_lock_token, undefined);
    assertEquals(row.ghl_contact_id, undefined);
    assertEquals(row.phone, '+1555999');
    await assertRejects(() => alice.Lead.get(row.id as string), Error, 'not found');
    assertEquals((await admin.Lead.get(row.id as string)).location_id, 'secret-loc');
    assertEquals(await admin.Lead.count(), 24);
    // Writes through a scoped client are forced onto the caller's email.
    const mine = await bob.Lead.create({ agent_email: A, location_id: 'l', ghl_contact_id: 'forced', phone: '+1555888' });
    assertEquals(mine.agent_email, B);
    assertEquals((await bob.Lead.updateMany({ ghl_contact_id: 'hidden1' }, { $set: { status: 'queued' } })).updated, 1);
    assertEquals((await alice.Lead.updateMany({ ghl_contact_id: 'hidden1' }, { $set: { status: 'queued' } })).updated, 0);
  });

  await t.step('row level security policies gate authenticated reads', async () => {
    const asUser = async (email: string, uid: string, q: string) => {
      return await sql.begin(async (tx) => {
        await tx.unsafe(`select set_config('request.jwt.claims', '${JSON.stringify({ email, sub: uid })}', true), set_config('request.jwt.claim.sub', '${uid}', true)`);
        await tx.unsafe(`set local role authenticated`);
        return await tx.unsafe(q);
      });
    };
    const aliceUid = '11111111-1111-1111-1111-111111111111';
    await sql`update public.profiles set role = 'agent' where id = ${aliceUid}`;
    await sql`insert into auth.users (id, email) values ('22222222-2222-2222-2222-222222222222', ${B})`;
    // Lead has hidden fields: owners use the view, the base table is admin-only.
    assertEquals((await asUser(A, aliceUid, 'select count(*)::int as n from public.lead'))[0].n, 0);
    assertEquals((await asUser(A, aliceUid, 'select count(*)::int as n from public.v_lead'))[0].n, 23);
    assertEquals((await asUser(B, '22222222-2222-2222-2222-222222222222', 'select count(*)::int as n from public.v_lead'))[0].n, 2);
    await assertRejects(() => asUser(A, aliceUid, 'select location_id from public.v_lead limit 1'));
    // QuickReply has no hidden fields: owner policy on the table itself.
    await E.QuickReply.bulkCreate([{ agent_email: A, text: 'a' }, { agent_email: B, text: 'b' }]);
    assertEquals((await asUser(A, aliceUid, 'select count(*)::int as n from public.quick_reply'))[0].n, 1);
    // Admin sees all, including hidden columns on the base table.
    await sql`update public.profiles set role = 'admin' where id = ${aliceUid}`;
    assertEquals((await asUser(A, aliceUid, 'select count(*)::int as n from public.lead'))[0].n, 25);
    assertEquals((await asUser(A, aliceUid, 'select count(*)::int as n from public.quick_reply'))[0].n, 2);
    // Nobody but the service role reads platform credentials.
    assertEquals((await asUser(A, aliceUid, 'select count(*)::int as n from public.platform_credential'))[0].n, 0);
    // Writes from authenticated non-admins are refused.
    await sql`update public.profiles set role = 'agent' where id = ${aliceUid}`;
    await assertRejects(() => asUser(A, aliceUid, `insert into public.quick_reply (agent_email, text) values ('${A}', 'x')`));
  });

  await sql.end();
});
