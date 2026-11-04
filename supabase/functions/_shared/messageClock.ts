import { isRehearsal } from './rehearsal.ts';

// Intl.DateTimeFormat construction is the single most expensive thing the engine does per lead
// (hundreds of microseconds to milliseconds each, and the clock functions are called many times
// per lead per run). One formatter per time zone, built once per isolate, is reused for every call.
const PARTS_FMT = new Map<string, Intl.DateTimeFormat>();
const LABEL_FMT = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string) {
  let f = PARTS_FMT.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); PARTS_FMT.set(tz, f); }
  return f;
}
function labelFormatter(tz: string) {
  let f = LABEL_FMT.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }); LABEL_FMT.set(tz, f); }
  return f;
}

export function localParts(date, tz): any {
  const p: any = Object.fromEntries(partsFormatter(tz).formatToParts(new Date(date)).map(p => [p.type, p.value]));
  return { ...p, date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
const minute = t => { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t || '')) throw new Error('Invalid sending window.'); const [h, m] = t.split(':').map(Number); return h * 60 + m; };
function between(m, start, end) { const a = minute(start), b = minute(end); return a < b ? m >= a && m < b : m >= a || m < b; }
export function clockOpen(s, tz, sequence = false, at: Date | number = new Date()) {
  if (isRehearsal(s)) return true;
  const m = localParts(at, tz).minutes;
  if (m < 540 || m >= 1200 || !between(m, s.hard_floor || '09:00', s.hard_ceiling || '20:00') || between(m, s.quiet_start || '20:00', s.quiet_end || '09:00')) return false;
  if (!sequence) return true;
  return [s.send_window_1 || '11:00-13:00', s.send_window_2 || '17:00-19:00'].some(w => { const [a, b] = w.split('-'); return between(m, a, b); });
}
export function nextWindow(s, tz, at, sequence = true) {
  let t = new Date(at).getTime();
  for (let i = 0; i < 3 * 24 * 12; i++, t += 300000) if (clockOpen(s, tz, sequence, t)) return new Date(t).toISOString();
  throw new Error('No permitted sending window found.');
}
export function zonedMidnight(day, tz) {
  const [y, m, d] = day.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d);
  let t = target;
  for (let i = 0; i < 4; i++) { const p = localParts(t, tz); const observed = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute)); t += target - observed; }
  return new Date(t).toISOString();
}
export function dayBounds(at, tz) {
  const p = localParts(at, tz), date = new Date(`${p.date}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return { start: zonedMidnight(p.date, tz), end: zonedMidnight(date.toISOString().slice(0, 10), tz) };
}
export function labelSlot(iso, tz) { return labelFormatter(tz).format(new Date(iso)); }
