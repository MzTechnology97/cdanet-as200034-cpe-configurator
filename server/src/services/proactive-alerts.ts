import type { AppContext } from '../context.ts';
import { nowIso } from '../db.ts';
import type { ApLoad } from '../domain/ap-load.ts';

/**
 * Proactive alerts to the NOC, before the customers call: CPEs whose signal is clearly below the
 * one of their acceptance test (seen in two checks in a row), APs close to saturation in the
 * evening, and the POPs running on battery with the autonomy left (from how fast the charge drops).
 * Each alert at most once a week per CPE / AP; the POPs at the start, when little is left and when
 * the power is back. What was said about the POPs is kept in the database, so a restart of the
 * server (every update) does not say it again, and the power counts as back once the charge has
 * lasted 15 minutes.
 */

const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;

// ---- pure rules --------------------------------------------------------------------------------

export interface SignalRow {
  mac: string;
  name: string;
  acceptance: number;
  now: number;
}
/** The CPEs with the signal down by at least [dropDb] from the acceptance test, or under the minimum. */
export function signalDrops(rows: SignalRow[], t: { signalDropDb: number; signalMin: number }) {
  return rows
    .map((r) => ({ ...r, drop: Math.round(r.acceptance - r.now) }))
    .filter((r) => r.drop >= t.signalDropDb || r.now < t.signalMin)
    .sort((a, b) => b.drop - a.drop);
}

/** APs whose evening peak uses at least [busyPct] of the airtime or of the channel. */
export function busyAps(loads: Array<{ apId: string; name: string; load: ApLoad }>, busyPct: number) {
  return loads
    .map((l) => ({ ...l, busy: Math.max(l.load.eveningAirtimePct ?? 0, l.load.eveningUtilizationPct ?? 0) }))
    .filter((l) => l.busy >= busyPct)
    .sort((a, b) => b.busy - a.busy);
}

/**
 * Hours of battery left from the charge readings of the last hour (time ms, state of charge %):
 * the slope between the first and the last reading at least 20 minutes apart; null while the
 * charge does not drop or there are not enough readings.
 */
export function autonomyHours(history: Array<{ t: number; soc: number }>): number | null {
  if (history.length < 2) return null;
  const first = history[0]!;
  const last = history[history.length - 1]!;
  const h = (last.t - first.t) / HOUR;
  if (h < 1 / 3) return null;
  const perHour = (first.soc - last.soc) / h;
  if (perHour <= 0.2) return null;
  return Math.round((last.soc / perHour) * 10) / 10;
}

/** After a critical alert the power counts as back once the charge has lasted this long. */
export const POWER_STABLE_MS = 15 * 60_000;
/** After the power is back, no new critical alert for this long (a charge swinging at the threshold). */
export const POWER_CALM_MS = 2 * HOUR;

/** What the alerts keep about one POP, in the database so that it survives a restart. */
export interface PopAlertState {
  /** A critical alert is out, until the charge is back. */
  critical?: true;
  /** When the power came back after a critical alert (ms). */
  recoveredAt?: number;
  /** Charging since (ms), while a critical alert is out. */
  chargingSince?: number;
  /** Charge readings of the last hour (time ms, state of charge %). */
  socs: Array<{ t: number; soc: number }>;
}

export type PowerSay = 'critical' | 'back';

/**
 * One check of a POP's battery: the state to keep and what to tell the NOC, if anything. Critical
 * only: on battery with the autonomy under [lowHours] or the charge under [criticalSoc] (not again
 * within [POWER_CALM_MS] of a recovery); «di nuovo in carica» after such an alert, once the charge
 * has lasted [POWER_STABLE_MS]: a few minutes of charge at sunrise are not the power back.
 */
export function powerStep(
  prev: PopAlertState | undefined,
  p: { soc: number | null; batteryState: string | null; offGrid: boolean },
  now: number,
  t: { lowHours: number; criticalSoc: number },
): { next: PopAlertState; say: PowerSay | null; hours: number | null } {
  const socs = (prev?.socs ?? []).filter((x) => x.t > now - HOUR);
  if (p.soc != null) socs.push({ t: now, soc: p.soc });
  let critical = prev?.critical === true;
  let recoveredAt = prev?.recoveredAt;
  let chargingSince: number | undefined;
  let say: PowerSay | null = null;
  let hours: number | null = null;
  if (p.batteryState === 'discharging' && !p.offGrid) {
    hours = autonomyHours(socs);
    const lowTime = hours != null && hours <= t.lowHours;
    const lowCharge = p.soc != null && p.soc <= t.criticalSoc;
    const calm = (recoveredAt ?? 0) > now - POWER_CALM_MS;
    if ((lowTime || lowCharge) && !critical && !calm) {
      say = 'critical';
      critical = true;
    }
  } else if (critical && p.batteryState === 'charging') {
    chargingSince = prev?.chargingSince ?? now;
    if (now - chargingSince >= POWER_STABLE_MS) {
      say = 'back';
      critical = false;
      recoveredAt = now;
      chargingSince = undefined;
    }
  }
  if (recoveredAt !== undefined && recoveredAt <= now - POWER_CALM_MS) recoveredAt = undefined;
  return {
    next: { ...(critical ? { critical: true as const } : {}), ...(recoveredAt !== undefined ? { recoveredAt } : {}), ...(chargingSince !== undefined ? { chargingSince } : {}), socs },
    say,
    hours,
  };
}

/** A stored state as it was written: anything else (an older format, a broken value) starts over. */
const validState = (v: unknown): v is PopAlertState => {
  const s = v as PopAlertState | null;
  return (
    !!s &&
    typeof s === 'object' &&
    (s.critical === undefined || s.critical === true) &&
    (s.recoveredAt === undefined || Number.isFinite(s.recoveredAt)) &&
    (s.chargingSince === undefined || Number.isFinite(s.chargingSince)) &&
    Array.isArray(s.socs) &&
    s.socs.every((x) => Number.isFinite(x?.t) && Number.isFinite(x?.soc))
  );
};

// ---- the service -------------------------------------------------------------------------------

const KEY = 'alerts.notified';
const POWER_KEY = 'alerts.power';

export function createProactiveAlerts(ctx: AppContext, log?: (m: string) => void) {
  const { db } = ctx;
  /** Signal drops seen in the last check (a drop must be seen twice before the alert). */
  let lastDrops = new Set<string>();
  let timers: NodeJS.Timeout[] = [];

  /** The POPs' battery alerts as last saved: critical alert out, recovery, charge readings. */
  const powerStates = (): Record<string, PopAlertState> => {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(POWER_KEY) as { value: string } | undefined;
    let all: Record<string, unknown> = {};
    try {
      all = r ? (JSON.parse(r.value) as Record<string, unknown>) : {};
    } catch {
      /* a broken value: start over */
    }
    return Object.fromEntries(Object.entries(all ?? {}).filter((e): e is [string, PopAlertState] => validState(e[1])));
  };
  const savePowerStates = (v: Record<string, PopAlertState>) =>
    db
      .prepare('INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(POWER_KEY, JSON.stringify(v), nowIso());

  const notified = (): Record<string, string> => {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as { value: string } | undefined;
    return r ? (JSON.parse(r.value) as Record<string, string>) : {};
  };
  const remember = (keys: string[]) => {
    const n = notified();
    const now = nowIso();
    for (const k of keys) n[k] = now;
    for (const [k, at] of Object.entries(n)) if (Date.parse(at) < Date.now() - 4 * WEEK) delete n[k];
    db.prepare('INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(KEY, JSON.stringify(n), now);
  };
  const recent = (key: string, n = notified()) => !!n[key] && Date.parse(n[key]!) > Date.now() - WEEK;

  /** Hourly: signal drops (twice in a row) and busy APs. */
  async function hourly() {
    if (!ctx.uisp) return;
    const devices = await ctx.uisp.allDevices();
    const byMac = new Map(devices.filter((d) => d.mac).map((d) => [d.mac!, d]));
    // the acceptance signal of the newest installation of each CPE still on the network
    const rows = (
      db
        .prepare(
          `SELECT j.mac, j.device_name name, a.data FROM provisioning_jobs j JOIN job_acceptance a ON a.job_id = j.id
            WHERE j.status = 'success' AND NOT EXISTS (SELECT 1 FROM provisioning_jobs n WHERE n.mac = j.mac AND n.status = 'success' AND n.created_at > j.created_at)`,
        )
        .all() as Array<{ mac: string; name: string; data: string }>
    )
      .map((r) => {
        const d = byMac.get(r.mac);
        const acceptance = (JSON.parse(r.data) as { radio?: { signal?: number } }).radio?.signal;
        return d && d.status === 'active' && d.signal != null && acceptance != null ? { mac: r.mac, name: r.name || d.name, acceptance, now: d.signal } : null;
      })
      .filter((r): r is SignalRow => !!r);
    const drops = signalDrops(rows, ctx.cfg.thresholds);
    const n = notified();
    const fresh = drops.filter((d) => lastDrops.has(d.mac) && !recent(`signal:${d.mac}`, n));
    lastDrops = new Set(drops.map((d) => d.mac));
    if (fresh.length) {
      ctx.notify.proactive(
        `📉 Segnale in calo su ${fresh.length} ${fresh.length === 1 ? 'CPE' : 'CPE'}`,
        fresh.slice(0, 8).map((d) => `${d.name}: ${d.now} dBm, ${d.drop > 0 ? `${d.drop} dB in meno del collaudo` : 'sotto il minimo'}`).concat(fresh.length > 8 ? [`…e altre ${fresh.length - 8}: vedi Salute CPE.`] : []),
      );
      remember(fresh.map((d) => `signal:${d.mac}`));
    }

    const aps = devices.filter((d) => d.role === 'ap' || d.wirelessMode.startsWith('ap'));
    const loads = aps.map((a) => ({ apId: a.id, name: a.name, load: ctx.apLoad.load(a.id) })).filter((x): x is { apId: string; name: string; load: ApLoad } => !!x.load);
    const busy = busyAps(loads, ctx.cfg.proactive.apBusyPct).filter((b) => !recent(`ap:${b.apId}`, n));
    if (busy.length) {
      ctx.notify.proactive(
        `📶 ${busy.length === 1 ? 'AP vicino' : `${busy.length} AP vicini`} alla saturazione la sera`,
        busy.slice(0, 8).map((b) => `${b.name}: ${Math.round(b.busy)}% la sera${b.load.stations != null ? ` · ${b.load.stations} CPE` : ''}`).concat(['Valuta un canale più largo, un ripuntamento verso un altro AP o un AP in più (IA-AP).']),
      );
      remember(busy.map((b) => `ap:${b.apId}`));
    }
  }

  /**
   * Every 5 minutes, critical alerts only: a POP on battery says nothing (with solar panels it
   * happens every night) until its autonomy falls under the hours set or its charge under the
   * critical %; the power back is said only after such an alert, once the charge has lasted 15
   * minutes. Not again within 2 hours of a recovery, so a charge swinging around the threshold
   * does not flood the group. The state is saved, so an update of the server repeats nothing.
   */
  async function power() {
    const pops = ctx.victronSync.byPop();
    if (!pops.size) return;
    const names = new Map(ctx.uisp ? (await ctx.uisp.sites().catch(() => [])).map((s) => [s.id, s.name]) : []);
    const now = Date.now();
    const prev = powerStates();
    // only the POPs that still have a battery system linked are kept
    const next: Record<string, PopAlertState> = {};
    const messages: Array<[string, string[]]> = [];
    const limits = { lowHours: ctx.cfg.proactive.popLowHours, criticalSoc: ctx.cfg.proactive.popCriticalSoc };
    for (const [popId, p] of pops) {
      const { next: state, say, hours } = powerStep(prev[popId], p, now, limits);
      next[popId] = state;
      if (!say) continue;
      const name = `POP ${names.get(popId) ?? popId}`;
      if (say === 'critical') {
        const soc = p.soc != null ? `${Math.round(p.soc)}%` : 'carica sconosciuta';
        messages.push([`⚠️ ${name}: batteria critica`, [hours != null ? `Carica ${soc}, circa ${hours} h di autonomia.` : `Carica ${soc}.`, 'Il POP non è alimentato: verifica la corrente o il fotovoltaico.']]);
      } else messages.push([`✅ ${name}: di nuovo in carica`, ['Dopo l’avviso di batteria critica: la corrente è tornata (o il fotovoltaico basta).']]);
    }
    // saved before telling: a failure while sending never makes the same alert go out twice
    savePowerStates(next);
    for (const [title, lines] of messages) ctx.notify.proactive(title, lines, true);
  }

  const safe = (f: () => Promise<void>, what: string) => () => void f().catch((e) => log?.(`alerts ${what}: ${(e as Error).message}`));
  return {
    hourly,
    power,
    start() {
      if (timers.length) return;
      timers = [setInterval(safe(hourly, 'hourly'), HOUR), setInterval(safe(power, 'power'), 5 * 60_000)];
      for (const t of timers) t.unref();
      setTimeout(safe(hourly, 'hourly'), 5 * 60_000).unref();
    },
    stop() {
      for (const t of timers) clearInterval(t);
      timers = [];
    },
  };
}
export type ProactiveAlerts = ReturnType<typeof createProactiveAlerts>;
