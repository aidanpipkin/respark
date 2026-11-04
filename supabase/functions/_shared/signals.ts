// Signals: the one backbone every "something needs attention" flows through.
// A signal is recorded once per key (repeats just bump the count), shows up in the admin Command
// Center, can surface to the agent as an in-app banner, and notifies people with cooldowns so
// nobody gets spammed. Health checks, billing, setup nudges and help requests all use this.
import { appOrigin } from './runtime.ts';
import { textAgent, emailAgent } from './agentNotify.ts';
import { platformConfig } from './credits.ts';

export type Signal = {
  key: string; kind: string; title: string; detail?: string;
  severity?: 'info' | 'warning' | 'critical'; scope?: 'platform' | 'agent';
  agent_email?: string; lead_id?: string; data?: Record<string, any>;
  action_label?: string; action_href?: string;
  agent_visible?: boolean;
  /** Tell the platform owner (text + email). Defaults to true for critical. */
  notifyOwner?: boolean;
  /** Email (and optionally text) the agent, at most once per cooldown. */
  notifyAgent?: { subject: string; body: string; text?: string; cooldownHours?: number };
};

const now = () => new Date().toISOString();
const hoursSince = (iso?: string) => iso ? (Date.now() - Date.parse(iso)) / 3600000 : Infinity;

async function ownerSettings(E: any) {
  const c = await platformConfig(E);
  const email = c.owner_email;
  if (!email) return { email: '', s: null };
  // No AgentSettings for the owner: a stub still lets textAgent use the platform alert number (owner_alert_*).
  const s = (await E.AgentSettings.filter({ agent_email: email }, { limit: 1 })).items[0] || { agent_email: email, home_timezone: c.default_timezone || 'America/Chicago' };
  return { email, s };
}

/** Records (or refreshes) a signal and sends any due notifications. Returns the event. */
export async function raise(base44: any, sig: Signal) {
  const E = base44.asServiceRole.entities;
  const severity = sig.severity || 'warning';
  const open = (await E.SystemEvent.filter({ key: sig.key, status: 'open' }, { limit: 1 })).items[0];
  const fields = {
    kind: sig.kind, severity, scope: sig.scope || (sig.agent_email ? 'agent' : 'platform'), agent_email: sig.agent_email || '', lead_id: sig.lead_id || '',
    title: sig.title.slice(0, 200), detail: String(sig.detail || '').slice(0, 2000), data: sig.data || {},
    action_label: sig.action_label || '', action_href: sig.action_href || '', agent_visible: !!sig.agent_visible, last_seen_at: now(),
  };
  let ev = open
    ? await E.SystemEvent.update(open.id, { ...fields, occurrences: (Number(open.occurrences) || 1) + 1 })
    : await E.SystemEvent.create({ key: sig.key, ...fields, status: 'open', first_seen_at: now(), occurrences: 1 });

  // Owner: critical things right away, repeats at most every 6 hours.
  const tellOwner = sig.notifyOwner ?? severity === 'critical';
  if (tellOwner && hoursSince(ev.owner_notified_at) >= 6) {
    const { email, s } = await ownerSettings(E);
    const line = `${sig.agent_email ? `[${sig.agent_email}] ` : ''}${sig.title}${sig.detail ? `: ${String(sig.detail).slice(0, 300)}` : ''}`;
    // Email first and on its own, so a texting problem can never swallow the alert.
    let delivered = false;
    const link = sig.action_href ? `${appOrigin()}${sig.action_href}` : `${appOrigin()}/admin/command`;
    if (email) {
      try { await base44.asServiceRole.integrations.Core.SendEmail({ to: email, subject: `LeadRespark ${severity === 'critical' ? 'ALERT' : 'notice'}: ${sig.title}`.slice(0, 180), body: `${line}\n\n${sig.action_label || 'Open'}: ${link}`, from_name: 'LeadRespark' }); delivered = true; }
      catch (e) { console.error('[signals] owner email failed', (e as Error).message); }
    }
    if (s) {
      try { const r: any = await textAgent(base44, s, `LeadRespark alert: ${line.slice(0, 240)} ${link}`, `signal:${sig.key}:${Math.floor(Date.now() / 21600000)}`, { anyHour: severity === 'critical' }); if (r?.sent) delivered = true; }
      catch (e) { console.error('[signals] owner text failed', (e as Error).message); }
    }
    if (delivered) ev = await E.SystemEvent.update(ev.id, { owner_notified_at: now() });
  }

  // Agent: plain-language email (and optional text) with the fix, on a cooldown.
  if (sig.notifyAgent && sig.agent_email && hoursSince(ev.agent_notified_at) >= (sig.notifyAgent.cooldownHours ?? 24)) {
    const s = (await E.AgentSettings.filter({ agent_email: sig.agent_email }, { limit: 1 })).items[0];
    if (s) {
      try {
        await emailAgent(base44, s, sig.notifyAgent.subject, sig.notifyAgent.body);
        if (sig.notifyAgent.text) await textAgent(base44, s, sig.notifyAgent.text, `signal-agent:${sig.key}:${Math.floor(Date.now() / 86400000)}`).catch(() => {});
        ev = await E.SystemEvent.update(ev.id, { agent_notified_at: now() });
      } catch (e) { console.error('[signals] agent notify failed', (e as Error).message); }
    }
  }
  return ev;
}

/** Marks a signal resolved (it's fixed). */
export async function resolve(base44: any, key: string, note = '') {
  const E = base44.asServiceRole.entities;
  await E.SystemEvent.updateMany({ key, status: 'open' }, { $set: { status: 'resolved', resolved_at: now(), ...(note ? { detail: note } : {}) } });
}

/** After a check runs: resolve every open signal of `kind` that wasn't raised this time. */
export async function resolveStale(base44: any, kind: string, stillOpen: string[]) {
  const E = base44.asServiceRole.entities;
  const open = (await E.SystemEvent.filter({ kind, status: 'open' }, { limit: 200, fields: ['key'] })).items;
  for (const ev of open) if (!stillOpen.includes(ev.key)) await E.SystemEvent.update(ev.id, { status: 'resolved', resolved_at: now() });
}

/** Records that a scheduled job ran, so the health check can tell when one stops. */
export async function heartbeat(base44: any, job: string, info: Record<string, any> = {}) {
  try { await base44.asServiceRole.entities.EngineCursor.upsert([{ key: `heartbeat:${job}`, cursor: JSON.stringify({ at: now(), ...info }).slice(0, 2000) }], { key: 'key' }); } catch { /* never block the job */ }
}

// Daily counters accumulate in memory and are written once per invocation (flushBumps), instead of
// two entity writes per bump. A short timer also flushes them for callers that never call flushBumps.
const pendingBumps = new Map<string, number>();
let bumpClient: any = null;
let bumpTimer: ReturnType<typeof setTimeout> | null = null;
const entitiesOf = (x: any) => x?.asServiceRole?.entities || x?.entities || x;

/** Counts something per day (e.g. AI fallbacks) cheaply. Buffered; see flushBumps. */
export async function bump(base44: any, counter: string, by = 1) {
  try {
    const key = `count:${counter}:${now().slice(0, 10)}`;
    pendingBumps.set(key, (pendingBumps.get(key) || 0) + by);
    if (base44) bumpClient = base44;
    if (!bumpTimer) bumpTimer = setTimeout(() => { bumpTimer = null; flushBumps(bumpClient).catch(() => {}); }, 2000);
  } catch { /* counters are best-effort */ }
}

/** Writes the buffered counters. Call once at the end of a function run (and in its finally). Takes base44 or its entities. */
export async function flushBumps(x: any) {
  const E = entitiesOf(x || bumpClient);
  if (!E?.EngineCursor || !pendingBumps.size) return;
  if (bumpTimer) { clearTimeout(bumpTimer); bumpTimer = null; }
  const batch = [...pendingBumps.entries()];
  pendingBumps.clear();
  for (const [key, by] of batch) {
    try {
      const row = (await E.EngineCursor.upsert([{ key }], { key: 'key' })).records[0];
      await E.EngineCursor.update(row.id, { cursor: String((Number(row.cursor) || 0) + by) });
    } catch { /* counters are best-effort */ }
  }
}
