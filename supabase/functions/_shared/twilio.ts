// Minimal Twilio REST client. The master credentials live in Base44 Secrets;
// each agent works inside their own Twilio subaccount.
import { secrets } from './runtime.ts';

export type TwilioCred = { sid: string; token: string };

export function masterCred(): TwilioCred {
  // Accept the documented names and the names entered in Base44 Secrets (Twillio_SID / Twillio_Auth).
  const sid = String(secrets.get('TWILIO_ACCOUNT_SID') || secrets.get('Twillio_SID') || secrets.get('TWILIO_SID') || '').trim();
  const token = String(secrets.get('TWILIO_AUTH_TOKEN') || secrets.get('Twillio_Auth') || secrets.get('TWILIO_AUTH') || '').trim();
  if (!/^AC[0-9a-f]{32}$/i.test(sid) || !token) throw new Error('Twilio is not connected. Add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in Secrets.');
  return { sid, token };
}

export function twilioConfigured() {
  try { masterCred(); return true; } catch { return false; }
}

export class TwilioError extends Error {
  status: number; code?: number;
  constructor(message: string, status: number, code?: number) { super(message); this.name = 'TwilioError'; this.status = status; this.code = code; }
}

function encode(params: Record<string, any>) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) for (const item of v) body.append(k, String(item));
    else body.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  return body;
}

/** Calls Twilio. `url` is absolute. GET when params is undefined and method not given. */
export async function tw(cred: TwilioCred, url: string, params?: Record<string, any>, method?: string) {
  const m = method || (params ? 'POST' : 'GET');
  const target = m === 'GET' && params ? `${url}?${encode(params)}` : url;
  const res = await fetch(target, {
    method: m,
    headers: { Authorization: `Basic ${btoa(`${cred.sid}:${cred.token}`)}`, Accept: 'application/json', ...(m !== 'GET' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    body: m !== 'GET' && params ? encode(params) : undefined,
    signal: AbortSignal.timeout(25000),
  });
  const text = await res.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text.slice(0, 300) }; }
  if (!res.ok) throw new TwilioError(data.message || `Twilio request failed (${res.status}).`, res.status, data.code);
  return data;
}

export const API = 'https://api.twilio.com/2010-04-01';
export const TRUST = 'https://trusthub.twilio.com/v1';
export const MSG = 'https://messaging.twilio.com/v1';

/** Prepaid balance of the platform's master Twilio account (subaccount usage is billed to it). */
export async function masterBalance(): Promise<{ balance: number; currency: string }> {
  const master = masterCred();
  const r = await tw(master, `${API}/Accounts/${master.sid}/Balance.json`);
  return { balance: Number(r.balance), currency: String(r.currency || 'USD') };
}

// Subaccount credentials are pure configuration; remember them for 10 minutes so every text and
// webhook does not cost a round trip to Twilio's master account.
const SUBCRED_TTL_MS = 10 * 60 * 1000;
const subCredCache = new Map<string, { at: number; cred: TwilioCred }>();
export function forgetSubCred(subSid?: string) { if (subSid) subCredCache.delete(subSid); else subCredCache.clear(); }

/** Credentials for a subaccount (the parent can read each subaccount's auth token). */
export async function subCred(subSid: string): Promise<TwilioCred> {
  const hit = subCredCache.get(subSid);
  if (hit && Date.now() - hit.at < SUBCRED_TTL_MS) return hit.cred;
  const acct = await tw(masterCred(), `${API}/Accounts/${encodeURIComponent(subSid)}.json`);
  if (!acct.auth_token) throw new Error('Could not open the Twilio subaccount.');
  if (acct.status !== 'active') throw new Error(`The Twilio subaccount is ${acct.status}.`);
  const cred = { sid: subSid, token: acct.auth_token };
  if (subCredCache.size > 5000) subCredCache.clear();
  subCredCache.set(subSid, { at: Date.now(), cred });
  return cred;
}

/** Finds the agent's Twilio subaccount, or creates one. Records it in TwilioAccount. */
export async function ensureSubaccount(E: any, s: any) {
  const saved = (await E.TwilioAccount.filter({ agent_email: s.agent_email }, { limit: 1 })).items[0];
  if (saved?.subaccount_sid) return saved.subaccount_sid as string;
  const master = masterCred();
  const name = `${String(s.brand_name || s.agent_email).slice(0, 40)} – Respark ${String(s.id || s.location_id || '').slice(-8)}`.slice(0, 64);
  // Reuse a subaccount with our exact name (e.g. a retry after a partial failure). Filtering by name
  // keeps this one request no matter how many agents exist.
  const list = await tw(master, `${API}/Accounts.json`, { FriendlyName: name, Status: 'active', PageSize: 5 }, 'GET');
  const match = (list.accounts || []).find((a: any) => a.sid !== master.sid && a.friendly_name === name);
  let sid = match?.sid, source = 'matched';
  if (!sid) { const created = await tw(master, `${API}/Accounts.json`, { FriendlyName: name }); sid = created.sid; source = 'created'; }
  try {
    await E.TwilioAccount.create({ agent_email: s.agent_email, subaccount_sid: sid, friendly_name: name, location_id: s.location_id || '', source, created_at: new Date().toISOString() });
  } catch (e) {
    // Unique index on twilio_account(lower(agent_email)): a parallel call recorded its subaccount first. Use that one
    // and log ours so an admin can close the orphan in the Twilio console.
    if ((e as { code?: string })?.code !== '23505') throw e;
    const winner = (await E.TwilioAccount.filter({ agent_email: s.agent_email }, { limit: 1 })).items[0];
    if (!winner?.subaccount_sid) throw e;
    if (winner.subaccount_sid !== sid) console.error(`[twilio] orphaned subaccount ${sid} (${source}) for ${s.agent_email}: ${winner.subaccount_sid} was recorded first`);
    return winner.subaccount_sid as string;
  }
  return sid as string;
}

/** Turns a Trust Hub evaluation into plain-English problems. */
export function evaluationProblems(evaluation: any) {
  if (evaluation?.status === 'compliant') return [];
  const out: string[] = [];
  for (const r of evaluation?.results || []) {
    if (r.passed === true || r.valid === true) continue;
    const fields = (r.fields || []).filter((f: any) => f.passed !== true && f.valid !== true).map((f: any) => `${String(f.friendly_name || f.object_field || '').trim()}${f.failure_reason ? `: ${f.failure_reason}` : ''}`).filter(Boolean);
    out.push(`${r.friendly_name || r.object_type || 'Item'}${r.failure_reason ? ` – ${r.failure_reason}` : ''}${fields.length ? ` (${fields.join('; ')})` : ''}`);
  }
  return out.length ? out : ['Twilio could not verify the registration details.'];
}
