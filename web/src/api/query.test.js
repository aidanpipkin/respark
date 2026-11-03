import { describe, expect, it } from 'vitest';
import {
  tableName, readRelation, columnRef, translateQuery, applyQuery, regexToPattern, parseSort, orderOptions,
  selectList, encodeCursor, decodeCursor, cursorFilter,
} from './query.js';

const one = q => { const r = translateQuery(q); expect(r).toHaveLength(1); return r[0]; };

describe('tableName', () => {
  it('maps entity names to snake_case tables', () => {
    const cases = {
      Lead: 'lead', AgentSettings: 'agent_settings', ConversationSummary: 'conversation_summary', MessageLog: 'message_log',
      SequenceStep: 'sequence_step', PromptVersion: 'prompt_version', ProvisioningLog: 'provisioning_log', SystemEvent: 'system_event',
      ConsentRecord: 'consent_record', AIDraft: 'ai_draft', Appointment: 'appointment', Campaign: 'campaign',
      A2PRegistration: 'a2p_registration', BillingAccount: 'billing_account', PlatformCredential: 'platform_credential',
    };
    for (const [k, v] of Object.entries(cases)) expect(tableName(k)).toBe(v);
  });
  it('reads agent-scoped tables through their v_ views', () => {
    expect(readRelation('Lead')).toBe('v_lead');
    expect(readRelation('ConversationSummary')).toBe('v_conversation_summary');
    expect(readRelation('ProvisioningLog')).toBe('provisioning_log');
    expect(readRelation('SystemEvent')).toBe('system_event');
  });
});

describe('translateQuery operators', () => {
  it('equality, null and nested paths', () => {
    expect(one({ status: 'open' })).toEqual({ column: 'status', operator: 'eq', value: 'open' });
    expect(one({ unread: true })).toEqual({ column: 'unread', operator: 'eq', value: 'true' });
    expect(one({ deleted_at: null })).toEqual({ column: 'deleted_at', operator: 'is', value: 'null' });
    expect(one({ 'meta.plan': 'pro' })).toEqual({ column: 'meta->>plan', operator: 'eq', value: 'pro' });
    expect(columnRef('a.b.c')).toBe('a->b->>c');
  });
  it('array membership (tags)', () => {
    expect(one({ tags: ['vip'] })).toEqual({ column: 'tags', operator: 'cs', value: '["vip"]' });
    expect(one({ tags: { $all: ['a', 'b c'] } })).toEqual({ column: 'tags', operator: 'cs', value: '["a","b c"]' });
    expect(one({ $or: [{ tags: ['vip'] }, { status: 'hot' }] })).toEqual({ or: 'tags.cs."[\\"vip\\"]",status.eq.hot' });
  });
  it('$in / $nin', () => {
    expect(one({ status: { $in: ['booked', 'held'] } })).toEqual({ column: 'status', operator: 'in', value: '(booked,held)' });
    expect(one({ status: { $in: ['a', null] } })).toEqual({ or: 'status.in.(a),status.is.null' });
    // $nin with null means "present and not one of": NOT IN already drops nulls.
    expect(one({ replied_at: { $nin: ['', null] } })).toEqual({ column: 'replied_at', operator: 'not.in', value: '("")' });
    // $nin without null keeps missing values, as Mongo does.
    expect(one({ status: { $nin: ['opted_out', 'closed'] } })).toEqual({ or: 'status.is.null,status.not.in.(opted_out,closed)' });
  });
  it('$ne', () => {
    expect(one({ status: { $ne: 'opted_out' } })).toEqual({ or: 'status.is.null,status.neq.opted_out' });
    expect(one({ status: { $ne: null } })).toEqual({ column: 'status', operator: 'not.is', value: 'null' });
  });
  it('$gt/$gte/$lt/$lte keep raw timestamps for .filter()', () => {
    const r = translateQuery({ start_time: { $gte: '2026-01-01T00:00:00.000Z', $lt: '2026-02-01T00:00:00.000Z' } });
    expect(r).toEqual([
      { column: 'start_time', operator: 'gte', value: '2026-01-01T00:00:00.000Z' },
      { column: 'start_time', operator: 'lt', value: '2026-02-01T00:00:00.000Z' },
    ]);
    expect(one({ n: { $gt: 5 } })).toEqual({ column: 'n', operator: 'gt', value: '5' });
    expect(one({ n: { $lte: new Date('2026-03-01T00:00:00Z') } }).value).toBe('2026-03-01T00:00:00.000Z');
  });
  it('$exists', () => {
    expect(one({ last_inbound_at: { $exists: true } })).toEqual({ column: 'last_inbound_at', operator: 'not.is', value: 'null' });
    expect(one({ last_inbound_at: { $exists: false } })).toEqual({ column: 'last_inbound_at', operator: 'is', value: 'null' });
    expect(translateQuery({ last_inbound_at: { $exists: true, $ne: '' } })).toEqual([
      { column: 'last_inbound_at', operator: 'not.is', value: 'null' },
      { or: 'last_inbound_at.is.null,last_inbound_at.neq.""' },
    ]);
  });
  it('$regex', () => {
    expect(regexToPattern('al\\.ex', 'i')).toEqual({ operator: 'ilike', value: '*al.ex*' });
    expect(regexToPattern('^555')).toEqual({ operator: 'like', value: '555*' });
    expect(regexToPattern('50\\%', 'i')).toEqual({ operator: 'ilike', value: '*50\\%*' });
    expect(regexToPattern('^a|b$', 'i')).toEqual({ operator: 'imatch', value: '^a|b$' });
    expect(one({ lead_name: { $regex: 'Smith', $options: 'i' } })).toEqual({ column: 'lead_name', operator: 'ilike', value: '*Smith*' });
    expect(one({ phone: { $regex: '555' } })).toEqual({ column: 'phone', operator: 'like', value: '*555*' });
  });
  it('$or / $and', () => {
    const t = 'al';
    expect(one({ $or: ['first_name', 'last_name'].map(k => ({ [k]: { $regex: t, $options: 'i' } })) }))
      .toEqual({ or: 'first_name.ilike.*al*,last_name.ilike.*al*' });
    expect(one({ $or: [{ a: 1, b: 'x y' }, { c: null }] })).toEqual({ or: 'and(a.eq.1,b.eq."x y"),c.is.null' });
    expect(translateQuery({ $and: [{ a: 1 }, { b: 2 }] })).toEqual([
      { column: 'a', operator: 'eq', value: '1' }, { column: 'b', operator: 'eq', value: '2' },
    ]);
    expect(translateQuery({ $or: [] })).toEqual([]);
  });
  it('quotes reserved characters inside logic strings', () => {
    expect(one({ $or: [{ t: '2026-01-01T00:00:00.000Z' }, { n: 'a,b' }, { q: 'say "hi"' }] }))
      .toEqual({ or: 't.eq."2026-01-01T00:00:00.000Z",n.eq."a,b",q.eq."say \\"hi\\""' });
  });
  it('rejects unknown operators', () => {
    expect(() => translateQuery({ a: { $where: 'x' } })).toThrow(/Unsupported/);
  });
  it('applyQuery drives a builder', () => {
    const calls = [];
    const builder = { filter: (...a) => { calls.push(['filter', ...a]); return builder; }, or: (...a) => { calls.push(['or', ...a]); return builder; } };
    applyQuery(builder, { agent_email: 'a@b.co', status: { $in: ['x'] }, $or: [{ a: 1 }, { b: 2 }] });
    expect(calls).toEqual([
      ['filter', 'agent_email', 'eq', 'a@b.co'],
      ['filter', 'status', 'in', '(x)'],
      ['or', 'a.eq.1,b.eq.2'],
    ]);
  });
});

describe('sort, fields', () => {
  it('parses sort strings', () => {
    expect(parseSort('start_time')).toEqual({ column: 'start_time', ascending: true });
    expect(parseSort('-last_time')).toEqual({ column: 'last_time', ascending: false });
    expect(parseSort(undefined)).toEqual({ column: 'id', ascending: true });
    expect(orderOptions('-created_date')).toEqual({ column: 'created_date', ascending: false, nullsFirst: true });
    expect(orderOptions('step_number')).toEqual({ column: 'step_number', ascending: true, nullsFirst: false });
  });
  it('builds select lists with id', () => {
    expect(selectList()).toBe('*');
    expect(selectList(['name'])).toBe('id,name');
    expect(selectList(['id', 'start_time', 'status'])).toBe('id,start_time,status');
  });
});

describe('cursor', () => {
  it('round-trips the sort value and id', () => {
    const row = { id: 'abc', last_time: '2026-05-01T10:00:00.000Z', name: 'Zoë' };
    const c = encodeCursor(row, '-last_time');
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(c)).toEqual({ c: 'last_time', v: row.last_time, id: 'abc' });
    expect(decodeCursor(encodeCursor({ id: 7, name: 'Zoë' }, 'name'))).toEqual({ c: 'name', v: 'Zoë', id: 7 });
    expect(decodeCursor('not base64 json')).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
  });
  it('produces keyset filters matching the ordering', () => {
    const asc = encodeCursor({ id: 'r1', start_time: '2026-01-01T00:00:00.000Z' }, 'start_time');
    expect(cursorFilter(asc, 'start_time')).toBe('or(start_time.gt."2026-01-01T00:00:00.000Z",start_time.is.null,and(start_time.eq."2026-01-01T00:00:00.000Z",id.gt.r1))');
    const desc = encodeCursor({ id: 'r1', last_time: '2026-01-01T00:00:00.000Z' }, '-last_time');
    expect(cursorFilter(desc, '-last_time')).toBe('or(last_time.lt."2026-01-01T00:00:00.000Z",and(last_time.eq."2026-01-01T00:00:00.000Z",id.gt.r1))');
    expect(cursorFilter(encodeCursor({ id: 'r1', v: null }, 'v'), 'v')).toBe('and(v.is.null,id.gt.r1)');
    expect(cursorFilter(encodeCursor({ id: 'r1', v: null }, '-v'), '-v')).toBe('or(and(v.is.null,id.gt.r1),v.not.is.null)');
    expect(cursorFilter(encodeCursor({ id: 'r1' }, undefined), undefined)).toBe('id.gt.r1');
    expect(cursorFilter(encodeCursor({ id: 'r1' }, '-id'), '-id')).toBe('id.lt.r1');
    expect(cursorFilter(undefined, 'x')).toBeNull();
  });
});
