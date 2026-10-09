/**
 * When a work order starts and which alerts are due: the office plans by Italian local day and
 * a free-text slot ("09:00-11:00", "mattina 9.30"); the first time in it is the start.
 */

/** Minutes before the start at which the installer is reminded. */
export const REMINDER_OFFSETS = [24 * 60, 120, 60, 30] as const;
/** After this many minutes from the start an order not started yet is late. */
export const LATE_AFTER_MIN = 30;
/** Start of the working day when the slot says no time. */
export const DEFAULT_START = '08:00';

/** "09:00-11:00" → "09:00"; null when the slot has no time. */
export function slotStart(slot: string): string | null {
  const m = /(\d{1,2})[:.](\d{2})/.exec(slot);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** Offset of Europe/Rome from UTC at [ms], in minutes (60 or 120). */
function romeOffsetMin(ms: number): number {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', timeZoneName: 'shortOffset' })
    .formatToParts(new Date(ms))
    .find((p) => p.type === 'timeZoneName')?.value;
  const m = /GMT([+-]\d{1,2})(?::(\d{2}))?/.exec(part ?? '');
  return m ? Number(m[1]) * 60 + Math.sign(Number(m[1])) * Number(m[2] ?? 0) : 60;
}

/** The instant of [day] "YYYY-MM-DD" at [hhmm] Italian time. */
export function romeInstant(day: string, hhmm: string): Date {
  const [y, mo, d] = day.split('-').map(Number) as [number, number, number];
  const [h, mi] = hhmm.split(':').map(Number) as [number, number];
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  let t = asUtc - romeOffsetMin(asUtc) * 60_000;
  // across a DST change the first guess can be one hour off
  t = asUtc - romeOffsetMin(t) * 60_000;
  return new Date(t);
}

export function orderStart(day: string, slot: string): Date {
  return romeInstant(day, slotStart(slot) ?? DEFAULT_START);
}

export interface AlertState {
  day: string;
  slot: string;
  status: string;
  assignedTo: number | null;
  /** Offsets (minutes) already reminded, comma separated. */
  reminders: string;
  lateAt: string | null;
  missedAt: string | null;
}

export type Alert = { type: 'reminder'; offset: number; sent: number[] } | { type: 'late' } | { type: 'missed' };

/**
 * What to send now for an order (pure, unit-tested). One reminder at most: when an order is
 * created late, only the closest one goes out and the earlier ones count as sent.
 */
export function dueAlerts(o: AlertState, now: Date, today: string): Alert[] {
  if (o.assignedTo == null || o.status === 'done' || o.status === 'cancelled') return [];
  const out: Alert[] = [];
  const start = orderStart(o.day, o.slot).getTime();
  const t = now.getTime();
  if (o.status === 'open' && t < start) {
    const sent = new Set(o.reminders.split(',').filter(Boolean).map(Number));
    const due = REMINDER_OFFSETS.filter((off) => t >= start - off * 60_000 && !sent.has(off));
    if (due.length) {
      const offset = Math.min(...due);
      out.push({ type: 'reminder', offset, sent: REMINDER_OFFSETS.filter((off) => off >= offset || sent.has(off)) });
    }
  }
  if (o.status === 'open' && !o.lateAt && t > start + LATE_AFTER_MIN * 60_000 && o.day === today) out.push({ type: 'late' });
  if ((o.status === 'open' || o.status === 'started') && !o.missedAt && o.day < today) out.push({ type: 'missed' });
  return out;
}

/** "tra 1 h 30 min (alle 10:30)", "tra 25 minuti (alle 9:30)", "domani alle 09:00": the real time left, not the reminder's. */
export function inWords(start: Date, now: Date): string {
  const min = Math.max(0, Math.round((start.getTime() - now.getTime()) / 60_000));
  const at = start.toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' });
  const day = (d: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(d);
  if (day(start) !== day(now)) return `${min < 48 * 60 ? 'domani' : `il ${day(start).split('-').reverse().join('/')}`} alle ${at}`;
  if (min >= 60) return `tra ${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''} (alle ${at})`;
  return `tra ${min} minuti (alle ${at})`;
}
