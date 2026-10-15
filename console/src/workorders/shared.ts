/** What the Interventi pages share: kinds, statuses and the order as the server sends it. */

export type Tone = 'good' | 'warn' | 'bad' | 'neutral' | 'info';
export const KINDS: Record<string, string> = { new: 'Nuova installazione', repoint: 'Ripuntamento / cambio AP', repair: 'Guasto', survey: 'Sopralluogo' };
/** The colour of each kind, the same as the app and the calendar. */
export const KIND_TONE: Record<string, 'brand' | 'info' | 'warn' | 'good'> = { new: 'brand', repoint: 'info', repair: 'warn', survey: 'good' };
export const STATUS: Record<string, [string, Tone]> = { open: ['da fare', 'neutral'], started: ['in corso', 'info'], done: ['fatto', 'good'], postponed: ['rimandato', 'warn'], cancelled: ['annullato', 'bad'] };

export interface Order {
  id: number;
  day: string;
  slot: string;
  kind: string;
  customer: string;
  address: string;
  lat: number | null;
  lon: number | null;
  contact: string;
  pppoeUser: string;
  hasPassword: boolean;
  model: string | null;
  notes: string;
  status: string;
  statusNote?: string | null;
  overdue: boolean;
  assignedTo: number | null;
  assignee?: string | null;
  jobId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  doneAt?: string | null;
}

export const romeDay = (offset = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + offset * 86_400_000));
export const dayLabel = (d: string) => {
  if (d === romeDay()) return 'Oggi';
  if (d === romeDay(1)) return 'Domani';
  if (d === romeDay(-1)) return 'Ieri';
  return new Date(`${d}T12:00:00`).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', ...(d.slice(0, 4) !== romeDay().slice(0, 4) ? { year: 'numeric' } : {}) });
};
