// Drop-in replacement for the Base44 SDK client, implemented on Supabase.
// Keeps the `base44.auth / entities / functions / integrations` surface the
// rest of src/ already uses, so call sites did not have to change.
import { createClient } from '@supabase/supabase-js';
import { applyQuery, cursorFilter, encodeCursor, orderOptions, readRelation, selectList, tableName } from '@/api/query';

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
const UPLOAD_BUCKET = import.meta.env.VITE_SUPABASE_UPLOAD_BUCKET || 'uploads';
const SIGNED_URL_TTL = 60 * 60; // 1 hour

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('[supabase] VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set (see web/.env.example).');
}

export const supabase = createClient(SUPABASE_URL || 'http://localhost:54321', SUPABASE_ANON_KEY || 'anon', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

// ---- Errors -------------------------------------------------------------------

function httpError(message, status, data) {
  const e = new Error(message || 'Request failed');
  e.status = status;
  e.data = data;
  e.response = { status, data };
  return e;
}

function fromSupabaseError(error, fallbackStatus = 400) {
  if (!error) return httpError('Unknown error', fallbackStatus);
  const status = error.status || (error.code === 'PGRST116' ? 404 : fallbackStatus);
  return httpError(error.message, status, { error: error.message, code: error.code, details: error.details, hint: error.hint });
}

// ---- Session helpers ------------------------------------------------------------

/** The current user's access token, or null when signed out. Replaces localStorage.base44_access_token reads. */
export async function getAccessToken() {
  const { data } = await supabase.auth.getSession();
  return data?.session?.access_token || null;
}

/** Absolute URL of an edge function. */
export function functionsUrl(name) {
  return `${SUPABASE_URL}/functions/v1/${name}`;
}

/** Headers for a call to the backend: anon key always, user token when signed in (anon key otherwise). */
export async function authHeaders() {
  const token = await getAccessToken();
  return { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token || SUPABASE_ANON_KEY}` };
}

const origin = () => (typeof window !== 'undefined' ? window.location.origin : '');
const samePath = p => (typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') ? p : '/');
const redirectUrl = returnTo => origin() + samePath(returnTo || '/');

// ---- Auth ---------------------------------------------------------------------

const auth = {
  /** `{ id, email, full_name, role, ... }`, role/full_name from `profiles` (id = auth.uid()). Throws 401 when signed out. */
  async me() {
    const { data: { session }, error } = await supabase.auth.getSession();
    if (error) throw fromSupabaseError(error, 401);
    if (!session) throw httpError('Not authenticated', 401, { error: 'Not authenticated' });
    const user = session.user;
    const { data: profile, error: profileError } = await supabase.from('profiles').select('role, full_name').eq('id', user.id).maybeSingle();
    if (profileError) throw fromSupabaseError(profileError, 403);
    const meta = user.user_metadata || {};
    return {
      id: user.id,
      email: user.email,
      full_name: profile?.full_name || meta.full_name || meta.name || '',
      role: profile?.role || 'user',
      created_date: user.created_at,
      ...profile,
    };
  },

  async isAuthenticated() {
    const { data } = await supabase.auth.getSession();
    return !!data?.session;
  },

  async loginViaEmailPassword(email, password) {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw fromSupabaseError(error, 401);
    return { access_token: data.session?.access_token, user: data.user };
  },

  /** Sign up. Returns `{ session }`: non-null when email confirmation is disabled, else an OTP email is sent. */
  async register({ email, password, full_name } = {}) {
    const { data, error } = await supabase.auth.signUp({
      email, password,
      options: { emailRedirectTo: redirectUrl('/welcome'), data: full_name ? { full_name } : undefined },
    });
    if (error) throw fromSupabaseError(error);
    return { user: data.user, session: data.session, access_token: data.session?.access_token };
  },

  /** Confirm the 6-digit code from the sign-up email. */
  async verifyOtp({ email, otpCode, type = 'signup' }) {
    const { data, error } = await supabase.auth.verifyOtp({ email, token: otpCode, type });
    if (error) throw fromSupabaseError(error);
    return { access_token: data.session?.access_token, user: data.user };
  },

  async resendOtp(email, type = 'signup') {
    const { error } = await supabase.auth.resend({ type, email, options: { emailRedirectTo: redirectUrl('/welcome') } });
    if (error) throw fromSupabaseError(error);
    return { sent: true };
  },

  async resetPasswordRequest(email) {
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: redirectUrl('/reset-password') });
    if (error) throw fromSupabaseError(error);
    return { sent: true };
  },

  /**
   * Complete a password reset. Supabase's recovery link lands on /reset-password
   * with a session already in the URL (handled by detectSessionInUrl) or, with a
   * custom email template, a `token_hash`; either way `resetToken` is optional.
   */
  async resetPassword({ resetToken, newPassword } = {}) {
    if (resetToken && resetToken !== 'session') {
      const { error } = await supabase.auth.verifyOtp({ token_hash: resetToken, type: 'recovery' });
      if (error) throw fromSupabaseError(error);
    }
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) throw httpError('This reset link is invalid or has expired.', 401);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) throw fromSupabaseError(error);
    await supabase.auth.signOut();
    return { ok: true };
  },

  /** True when the page was opened from a recovery link (URL params or a live session). */
  async hasRecoverySession() {
    if (typeof window === 'undefined') return false;
    const params = new URLSearchParams(window.location.search);
    if (params.get('token') || params.get('token_hash') || params.get('code')) return true;
    if (/access_token=|type=recovery/.test(window.location.hash)) return true;
    return auth.isAuthenticated();
  },

  async loginWithProvider(provider, returnTo) {
    const { error } = await supabase.auth.signInWithOAuth({ provider, options: { redirectTo: redirectUrl(returnTo) } });
    if (error) throw fromSupabaseError(error);
  },

  async logout(redirectTo) {
    try { await supabase.auth.signOut(); } catch (e) { console.warn('[supabase] signOut failed', e); }
    if (redirectTo && typeof window !== 'undefined') {
      const target = /^https?:/i.test(redirectTo) ? (redirectTo.startsWith(origin()) ? redirectTo : '/login') : samePath(redirectTo);
      window.location.assign(target);
    }
  },

  /** Supabase manages the session itself; kept for call-site compatibility. */
  setToken() {},

  redirectToLogin(returnUrl) {
    if (typeof window === 'undefined') return;
    let path = '/';
    try { const u = new URL(returnUrl || window.location.href, origin()); if (u.origin === origin()) path = u.pathname + u.search; } catch { /* keep "/" */ }
    window.location.assign('/login' + (path !== '/' && path !== '/login' ? '?returnTo=' + encodeURIComponent(path) : ''));
  },
};

// ---- Entities -------------------------------------------------------------------

function entity(name) {
  const table = tableName(name);
  const view = readRelation(name);
  const from = () => supabase.from(table); // writes
  const read = () => supabase.from(view); // reads: the owner-scoped view when there is one
  return {
    table,
    view,
    /** `{ items, has_more, next_cursor }` with keyset pagination. */
    async filter(query = {}, { sort, limit = 50, cursor, fields } = {}) {
      const { column, ascending } = orderOptions(sort);
      let q = read().select(selectList(fields));
      q = applyQuery(q, query);
      const after = cursorFilter(cursor, sort);
      if (after) q = q.or(after);
      q = q.order(column, { ascending, nullsFirst: !ascending });
      if (column !== 'id') q = q.order('id', { ascending: true });
      const n = Math.max(1, Math.min(Number(limit) || 50, 1000));
      q = q.limit(n + 1);
      const { data, error } = await q;
      if (error) throw fromSupabaseError(error);
      const rows = data || [];
      const has_more = rows.length > n;
      const items = has_more ? rows.slice(0, n) : rows;
      return { items, has_more, next_cursor: has_more && items.length ? encodeCursor(items[items.length - 1], sort) : null };
    },
    async list(options) { return this.filter({}, options); },
    async get(id) {
      const { data, error } = await read().select('*').eq('id', id).maybeSingle();
      if (error) throw fromSupabaseError(error);
      if (!data) throw httpError(`${name} not found`, 404, { error: 'Not found' });
      return data;
    },
    async count(query = {}) {
      let q = read().select('id', { count: 'exact', head: true });
      q = applyQuery(q, query);
      const { count, error } = await q;
      if (error) throw fromSupabaseError(error);
      return count || 0;
    },
    async create(values) {
      const { data, error } = await from().insert(values).select().single();
      if (error) throw fromSupabaseError(error);
      return data;
    },
    async update(id, values) {
      const { data, error } = await from().update(values).eq('id', id).select().single();
      if (error) throw fromSupabaseError(error);
      return data;
    },
    async delete(id) {
      const { error } = await from().delete().eq('id', id);
      if (error) throw fromSupabaseError(error);
      return { id };
    },
  };
}

const entities = new Proxy({}, {
  get(cache, name) {
    if (typeof name !== 'string') return undefined;
    if (!cache[name]) cache[name] = entity(name);
    return cache[name];
  },
});

// ---- Functions ----------------------------------------------------------------

async function parseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

const functions = {
  /**
   * POST to `${VITE_SUPABASE_URL}/functions/v1/${name}` with the user's token
   * (anon key when signed out, so public pages work). Resolves `{ data, status }`;
   * rejects with `error.response.{status,data}` on non-2xx, as the SDK did.
   */
  async invoke(name, payload = {}, { method = 'POST', headers = {} } = {}) {
    let response;
    try {
      response = await fetch(functionsUrl(name), {
        method,
        headers: { 'Content-Type': 'application/json', ...(await authHeaders()), ...headers },
        body: method === 'GET' ? undefined : JSON.stringify(payload ?? {}),
      });
    } catch (e) {
      throw httpError(`Network error calling ${name}: ${e.message}`, undefined, undefined);
    }
    const data = await parseBody(response);
    if (!response.ok) {
      const message = (data && typeof data === 'object' && (data.error?.message || data.error || data.message || data.msg)) || response.statusText || `Function ${name} failed`;
      throw httpError(typeof message === 'string' ? message : JSON.stringify(message), response.status, typeof data === 'object' && data ? data : { error: String(message) });
    }
    return { data: data ?? {}, status: response.status };
  },
};

// ---- Storage (integrations.Core) ----------------------------------------------------

function objectPath(file, prefix) {
  const name = (file?.name || 'file').replace(/[^\w.\-]+/g, '_').slice(-120);
  const rand = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);
  return `${prefix}/${new Date().toISOString().slice(0, 10)}/${rand}-${name}`;
}

async function upload(file, prefix) {
  const path = objectPath(file, prefix);
  const { error } = await supabase.storage.from(UPLOAD_BUCKET).upload(path, file, { contentType: file?.type || undefined, upsert: false });
  if (error) throw fromSupabaseError(error);
  return path;
}

async function signedUrl(path, expiresIn = SIGNED_URL_TTL) {
  const { data, error } = await supabase.storage.from(UPLOAD_BUCKET).createSignedUrl(path, expiresIn);
  if (error) throw fromSupabaseError(error);
  return data.signedUrl;
}

const Core = {
  /** Uploads to the private `uploads` bucket; `file_url` is a 1-hour signed URL, `file_uri` the durable object path. */
  async UploadFile({ file }) {
    const file_uri = await upload(file, 'files');
    return { file_uri, file_url: await signedUrl(file_uri) };
  },
  async UploadPrivateFile({ file }) {
    const file_uri = await upload(file, 'private');
    return { file_uri };
  },
  async CreateFileSignedUrl({ file_uri, expires_in = SIGNED_URL_TTL }) {
    return { signed_url: await signedUrl(file_uri, expires_in) };
  },
};

export const base44 = {
  auth,
  entities,
  functions,
  integrations: { Core },
  supabase,
};

export default base44;
