import { Badge } from '../ui';

/**
 * The battery of a POP (its solar and battery systems), in Stato rete and Guasti Enel. Admins get
 * every value; installers only state, charge and charging/discharging (never where it comes from).
 */

export type PowerStatus = 'ok' | 'warn' | 'alarm' | 'silent';
export interface PopPower {
  status: PowerStatus;
  /** % (the lowest when the POP has more systems). */
  soc: number | null;
  batteryState: 'charging' | 'discharging' | 'idle' | null;
  /** Solar only: an outage of the power network hits its customers, not the POP. */
  offGrid: boolean;
  // admins only
  voltage?: number | null;
  pvW?: number | null;
  alarms?: number;
  /** unix seconds */
  lastTs?: number | null;
  sites?: number;
}

const TONE: Record<PowerStatus, 'good' | 'warn' | 'bad'> = { ok: 'good', warn: 'warn', alarm: 'bad', silent: 'warn' };
const STATE: Record<string, string> = { charging: 'in carica', discharging: 'in scarica', idle: 'a riposo' };
const dec = (v: number, d = 1) => v.toLocaleString('it-IT', { maximumFractionDigits: d });

/** «2 h fa», «35 min fa», «3 g fa». */
export function since(unix: number, now = Date.now()) {
  const m = Math.max(0, Math.round((now / 1000 - unix) / 60));
  return m < 60 ? `${m} min fa` : m < 48 * 60 ? `${Math.round(m / 60)} h fa` : `${Math.round(m / 1440)} g fa`;
}

/** «batteria 27% · in scarica · 24,6 V · FV 1,8 kW · 2 allarmi», or the silence. */
export function powerText(p: PopPower): string {
  if (p.status === 'silent') return p.lastTs ? `batteria: nessun dato da ${since(p.lastTs).replace(' fa', '')}` : 'batteria: dati non aggiornati';
  return [
    p.soc != null ? `batteria ${Math.round(p.soc)}%` : 'batteria',
    p.batteryState ? STATE[p.batteryState] : null,
    p.voltage != null ? `${dec(p.voltage)} V` : null,
    p.pvW != null ? (p.pvW >= 1000 ? `FV ${dec(p.pvW / 1000)} kW` : `FV ${Math.round(p.pvW)} W`) : null,
    p.alarms ? `${p.alarms} ${p.alarms === 1 ? 'allarme' : 'allarmi'}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Whether the battery needs a look (the «POP con batteria da controllare» of Stato rete). */
export const powerAlarm = (p?: PopPower | null) => p?.status === 'alarm' || p?.status === 'silent';

export function PowerBadge({ p, prefix }: { p: PopPower | null | undefined; prefix?: string }) {
  if (!p) return null;
  return (
    <>
      <Badge tone={TONE[p.status]}>
        {prefix ? `${prefix} · ` : ''}
        {powerText(p)}
      </Badge>
      {p.offGrid && <Badge tone="neutral">off-grid</Badge>}
    </>
  );
}
