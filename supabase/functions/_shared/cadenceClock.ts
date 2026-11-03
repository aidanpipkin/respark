// When cadence follow-ups may go out, in the lead's own time zone.
// Monday to Saturday, 9:30am to 6:30pm, never on Sundays or federal holidays. That window sits
// inside every state's limits (the strictest are 8am-8pm, no Sundays in some states) and avoids
// the evening hours when opt-outs spike.
import { localParts, zonedMidnight } from './messageClock.ts';
import { isRehearsal } from './rehearsal.ts';

const OPEN = 9 * 60 + 30, CLOSE = 18 * 60 + 30;
const SLOTS: Record<string, [number, number]> = { am: [10 * 60, 12 * 60], pm: [14 * 60 + 30, 17 * 60 + 30] };

function nth(year: number, month: number, weekday: number, n: number) { // nth weekday of month (n = -1: last)
  if (n > 0) { const first = new Date(Date.UTC(year, month, 1)).getUTCDay(); return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7; }
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate(); const lastW = new Date(Date.UTC(year, month, lastDay)).getUTCDay();
  return lastDay - ((lastW - weekday + 7) % 7);
}
const pad = (n: number) => String(n).padStart(2, '0');
function observed(y: number, m: number, d: number) { // weekend holidays move to Friday/Monday
  const w = new Date(Date.UTC(y, m, d)).getUTCDay();
  const dt = new Date(Date.UTC(y, m, d + (w === 6 ? -1 : w === 0 ? 1 : 0)));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}
const holidayCache = new Map<number, Set<string>>();
export function holidays(y: number) {
  if (holidayCache.has(y)) return holidayCache.get(y)!;
  const set = new Set<string>([
    observed(y, 0, 1), `${y}-01-${pad(nth(y, 0, 1, 3))}`, `${y}-02-${pad(nth(y, 1, 1, 3))}`, `${y}-05-${pad(nth(y, 4, 1, -1))}`,
    observed(y, 5, 19), observed(y, 6, 4), `${y}-09-${pad(nth(y, 8, 1, 1))}`, `${y}-10-${pad(nth(y, 9, 1, 2))}`,
    observed(y, 10, 11), `${y}-11-${pad(nth(y, 10, 4, 4))}`, observed(y, 11, 25),
  ]);
  holidayCache.set(y, set);
  return set;
}

/** Is this a day follow-ups may go out (not Sunday, not a federal holiday) in this time zone? */
export function sendingDay(at: number | Date, tz: string) {
  const p = localParts(at, tz);
  const weekday = new Date(`${p.date}T12:00:00Z`).getUTCDay();
  return weekday !== 0 && !holidays(Number(p.year)).has(p.date);
}

/** May a cadence follow-up go out right now? */
export function cadenceOpen(s: any, tz: string, at: number | Date = Date.now()) {
  if (isRehearsal(s)) return true;
  if (!sendingDay(at, tz)) return false;
  const m = localParts(at, tz).minutes;
  return m >= OPEN && m < CLOSE;
}

/** Stable per-lead spread across the window so a list never goes out in one burst. */
function spread(leadId: string, span: number) {
  let h = 0; for (const c of String(leadId)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % Math.max(1, span);
}

/**
 * When a step is due: the lead's start date plus `day` days, inside the step's slot, at a minute
 * that's stable for this lead. Returns null if that day is a Sunday or holiday (the step is skipped).
 */
export function stepTime(s: any, lead: any, startedIso: string, day: number, slot: string, mustSend = false) {
  const tz = lead.timezone || s.home_timezone || 'America/Chicago';
  const start = localParts(Date.parse(startedIso), tz);
  const d = new Date(`${start.date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + Math.round(day));
  const date = d.toISOString().slice(0, 10);
  const midnight = Date.parse(zonedMidnight(date, tz));
  if (!sendingDay(midnight + 12 * 3600000, tz)) return mustSend ? nextCadenceWindow(s, tz, midnight + 34 * 3600000) : null;
  const [a, b] = SLOTS[slot] || SLOTS.am;
  return new Date(midnight + (a + spread(`${lead.id}:${day}:${slot}`, b - a)) * 60000).toISOString();
}

/** The next moment a cadence follow-up may go out, from `at` on. */
export function nextCadenceWindow(s: any, tz: string, at: number) {
  let t = at;
  for (let i = 0; i < 10 * 24 * 12; i++, t += 300000) if (cadenceOpen(s, tz, t)) return new Date(t).toISOString();
  return new Date(at + 86400000).toISOString();
}
