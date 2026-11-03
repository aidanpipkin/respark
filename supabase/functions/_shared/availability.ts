// Agent availability kept entirely inside LeadRespark:
//  - weekly hours and calls/day are pushed to the agent's booking calendar,
//  - days off are skipped,
//  - busy times come from the agent's private calendar link (Google, Outlook or iCloud "iCal/ICS"
//    address), so nobody has to connect a calendar anywhere else.
import { zonedMidnight, localParts } from './messageClock.ts';
import { msConnected, graphBusy } from './msGraph.ts';

const DAY = 86400000;
const HORIZON_DAYS = 15;
const CACHE_MS = 10 * 60 * 1000;
const ALLOWED_HOSTS = /(^|\.)(calendar\.google\.com|outlook\.office365\.com|outlook\.live\.com|outlook\.office\.com|icloud\.com)$/i;

export function normalizeFeedUrl(raw: string) {
  const t = String(raw || '').trim().replace(/^webcals?:\/\//i, 'https://');
  if (!t) return '';
  let u: URL;
  try { u = new URL(t); } catch { throw new Error('Paste the full private calendar link.'); }
  if (u.protocol !== 'https:' || !ALLOWED_HOSTS.test(u.hostname)) throw new Error('Use the private iCal/ICS link from Google Calendar, Outlook or iCloud.');
  return u.toString();
}

// ---------- ICS parsing (enough for busy/free: single, all-day and simple recurring events) ----------
function unfold(text: string) { return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, ''); }

function wallToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, tz: string) {
  // Midnight of that local day in tz, then add the local time of day.
  const day = `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  try { return Date.parse(zonedMidnight(day, tz)) + ((h * 60 + mi) * 60 + s) * 1000; }
  catch { return Date.UTC(y, mo - 1, d, h, mi, s); }
}

export function parseIcsDate(value: string, params: string, fallbackTz: string): { t: number; allDay: boolean; tz: string } | null {
  const v = value.trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h === undefined) return { t: wallToUtc(+y, +mo, +d, 0, 0, 0, fallbackTz), allDay: true, tz: fallbackTz };
  if (z) return { t: Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0)), allDay: false, tz: 'UTC' };
  const tzid = /TZID=("?)([^;:"]+)\1/i.exec(params)?.[2] || fallbackTz;
  let tz = tzid;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(); } catch { tz = WINDOWS_TZ[tzid] || fallbackTz; }
  return { t: wallToUtc(+y, +mo, +d, +h, +mi, +(s || 0), tz), allDay: false, tz };
}

// Outlook often uses Windows zone names.
const WINDOWS_TZ: Record<string, string> = {
  'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago', 'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix', 'Pacific Standard Time': 'America/Los_Angeles', 'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu', 'UTC': 'UTC', 'GMT Standard Time': 'Europe/London',
};

const DOW = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

export function parseIcs(text: string, fallbackTz: string, from = Date.now(), days = HORIZON_DAYS) {
  const to = from + days * DAY;
  const busy: Array<[number, number]> = [];
  const blocks = unfold(text).split('BEGIN:VEVENT').slice(1).map(b => b.split('END:VEVENT')[0]);
  for (const block of blocks.slice(0, 5000)) {
    const props: Record<string, Array<{ params: string; value: string }>> = {};
    for (const line of block.split('\n')) {
      const i = line.indexOf(':'); if (i < 0) continue;
      const head = line.slice(0, i), value = line.slice(i + 1);
      const [name, ...rest] = head.split(';');
      (props[name.toUpperCase()] ||= []).push({ params: rest.join(';'), value });
    }
    const one = (k: string) => props[k]?.[0];
    if (/TRANSPARENT/i.test(one('TRANSP')?.value || '') || /CANCELLED/i.test(one('STATUS')?.value || '')) continue;
    if (/^FREE$/i.test(one('X-MICROSOFT-CDO-BUSYSTATUS')?.value || '')) continue;
    const ds = one('DTSTART'); if (!ds) continue;
    const start = parseIcsDate(ds.value, ds.params, fallbackTz); if (!start) continue;
    const de = one('DTEND');
    let end = de ? parseIcsDate(de.value, de.params, fallbackTz)?.t : undefined;
    if (end === undefined) {
      const dur = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(one('DURATION')?.value || '');
      end = start.t + (dur ? ((+(dur[1] || 0) * 24 + +(dur[2] || 0)) * 60 + +(dur[3] || 0)) * 60000 : start.allDay ? DAY : 3600000);
    }
    const length = Math.max(0, end - start.t);
    const exdates = new Set((props.EXDATE || []).flatMap(x => x.value.split(',').map(v => parseIcsDate(v, x.params, fallbackTz)?.t)).filter(Boolean) as number[]);
    const rrule = one('RRULE')?.value;
    const push = (s: number) => { if (!exdates.has(s) && s < to && s + length > from) busy.push([s, s + length]); };
    if (!rrule) { push(start.t); continue; }
    const r = Object.fromEntries(rrule.split(';').map(p => p.split('=')));
    const freq = r.FREQ, interval = Math.max(1, Number(r.INTERVAL) || 1);
    const until = r.UNTIL ? parseIcsDate(r.UNTIL, '', fallbackTz)?.t ?? Infinity : Infinity;
    const count = r.COUNT ? Number(r.COUNT) : Infinity;
    if (!['DAILY', 'WEEKLY'].includes(freq)) { push(start.t); continue; } // monthly/yearly: rare for busy blocks; keep the first one
    const byday = r.BYDAY ? r.BYDAY.split(',').map((d: string) => DOW.indexOf(d.slice(-2))) : null;
    let n = 0;
    // Walk local calendar days in the event's own timezone so the wall-clock time survives DST changes.
    const etz = start.tz === 'UTC' ? fallbackTz : start.tz;
    const sl = localParts(start.t, etz);
    const secs = (Number(sl.hour) * 60 + Number(sl.minute)) * 60;
    const d0 = Date.UTC(+sl.year, +sl.month - 1, +sl.day);
    for (let k = 0; k < 3660 && n < count; k++) {
      const day = new Date(d0 + k * DAY);
      const t = wallToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), Math.floor(secs / 3600), Math.floor(secs % 3600 / 60), 0, etz);
      if (t > until || t > to) break;
      const dow = day.getUTCDay();
      let hit = false;
      if (freq === 'DAILY') hit = k % interval === 0;
      else { const week = Math.floor(k / 7); hit = week % interval === 0 && (byday ? byday.includes(dow) : k % 7 === 0); }
      if (!hit) continue;
      n++;
      push(t);
    }
  }
  busy.sort((a, b) => a[0] - b[0]);
  return busy.slice(0, 1000);
}

/**
 * Busy intervals from the agent's calendar link and, when connected, their Microsoft 365 calendar
 * (Graph), cached together for 10 minutes. Never throws.
 */
export async function busyIntervals(E: any, s: any, force = false): Promise<{ busy: Array<[number, number]>; error: string; fetched_at: string }> {
  const graphOn = msConnected(s);
  if (!s.busy_calendar_url && !graphOn) return { busy: [], error: '', fetched_at: '' };
  const cache = s.busy_cache || {};
  if (!force && cache.fetched_at && Date.now() - Date.parse(cache.fetched_at) < CACHE_MS) {
    return { busy: (cache.busy || []).map((b: string[]) => [Date.parse(b[0]), Date.parse(b[1])]), error: cache.error || '', fetched_at: cache.fetched_at };
  }
  let busy: Array<[number, number]> = [];
  const errors: string[] = [];
  let failed = false;
  if (s.busy_calendar_url) {
    try {
      const res = await fetch(normalizeFeedUrl(s.busy_calendar_url), { headers: { Accept: 'text/calendar' }, redirect: 'follow', signal: AbortSignal.timeout(12000) });
      if (!res.ok) throw new Error(res.status === 404 || res.status === 401 || res.status === 403 ? 'The calendar link no longer works. Paste a fresh private link.' : `Calendar link returned ${res.status}.`);
      const text = (await res.text()).slice(0, 8_000_000);
      if (!/BEGIN:VCALENDAR/.test(text)) throw new Error('That link is not a calendar (ICS) feed.');
      busy = parseIcs(text, s.home_timezone || 'America/Chicago');
    } catch (e) { errors.push((e as Error).message.slice(0, 200)); failed = true; }
  }
  if (graphOn) {
    try { busy = busy.concat(await graphBusy(E, s, Date.now(), Date.now() + HORIZON_DAYS * DAY)); }
    catch (e) { errors.push(`Microsoft 365: ${(e as Error).message.slice(0, 160)}`); failed = true; }
  }
  const error = errors.join(' ');
  if (failed && !busy.length) busy = (cache.busy || []).map((b: string[]) => [Date.parse(b[0]), Date.parse(b[1])]); // keep last known busy times
  const fetched_at = new Date().toISOString();
  await E.AgentSettings.update(s.id, { busy_cache: { fetched_at, error, busy: busy.slice(0, 500).map(([a, b]) => [new Date(a).toISOString(), new Date(b).toISOString()]) } }).catch(() => {});
  return { busy, error, fetched_at };
}

/** Removes slots that clash with busy time (plus buffer) or fall on a day off. */
export function filterSlots(slots: string[], busy: Array<[number, number]>, blockedDates: string[], tz: string, minutes = 20, bufferMinutes = 15) {
  const blocked = new Set(blockedDates || []);
  const pad = bufferMinutes * 60000;
  return slots.filter(iso => {
    const a = Date.parse(iso), b = a + minutes * 60000;
    if (blocked.has(localParts(a, tz).date)) return false;
    return !busy.some(([s, e]) => a < e + pad && b > s - pad);
  });
}

export function openHoursFor(hours: any[]) {
  return hours.map((h: any) => {
    const [oh, om] = h.open.split(':').map(Number); const [ch, cm] = h.close.split(':').map(Number);
    return { daysOfTheWeek: [Number(h.day)], hours: [{ openHour: oh, openMinute: om, closeHour: ch, closeMinute: cm }] };
  });
}

export function validHours(hours: any) {
  if (!Array.isArray(hours) || hours.length > 7) return false;
  if (new Set(hours.map((h: any) => h.day)).size !== hours.length) return false;
  return hours.every((h: any) => Number.isInteger(h.day) && h.day >= 0 && h.day <= 6 && /^([01]\d|2[0-3]):[0-5]\d$/.test(h.open) && /^([01]\d|2[0-3]):[0-5]\d$/.test(h.close) && h.open < h.close);
}
