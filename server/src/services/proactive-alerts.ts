import type { AppContext } from '../context.ts';
import { nowIso } from '../db.ts';
import type { ApLoad } from '../domain/ap-load.ts';

/**
 * Proactive alerts to the NOC, before the customers call: CPEs whose signal is clearly below the
 * one of their acceptance test (seen in two checks in a row), APs close to saturation in the
 * evening, and the POPs running on battery with the autonomy left (from how fast the charge drops).
 * Each alert at most once a week per CPE / AP; the POPs at the start, when little is left and when
 * the power is back.
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

// ---- the service -------------------------------------------------------------------------------

const KEY = 'alerts.notified';

export function createProactiveAlerts(ctx: AppContext, log?: (m: string) => void) {
  const { db } = ctx;
  /** Signal drops seen in the last check (a drop must be seen twice before the alert). */
  let lastDrops = new Set<string>();
  /** Charge readings of each POP (last hour) and what was already said about it. */
  const socs = new Map<string, Array<{ t: number; soc: number }>>();
  const popSaid = new Map<string, 'battery' | 'low'>();
  let timers: NodeJS.Timeout[] = [];

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

  /** Every 5 minutes: the POPs on battery, their autonomy, the power back. */
  async function power() {
    const pops = ctx.victronSync.byPop();
    if (!pops.size) return;
    const names = new Map(ctx.uisp ? (await ctx.uisp.sites().catch(() => [])).map((s) => [s.id, s.name]) : []);
    const now = Date.now();
    for (const [popId, p] of pops) {
      const name = `POP ${names.get(popId) ?? popId}`;
      const h = (socs.get(popId) ?? []).filter((x) => x.t > now - HOUR);
      if (p.soc != null) h.push({ t: now, soc: p.soc });
      socs.set(popId, h);
      const said = popSaid.get(popId);
      if (p.batteryState === 'discharging' && !p.offGrid) {
        const hours = autonomyHours(h);
        const soc = p.soc != null ? `${Math.round(p.soc)}%` : 'carica sconosciuta';
        if (!said && hours != null) {
          ctx.notify.proactive(`🔋 ${name} a batteria`, [`Carica ${soc}, autonomia stimata circa ${hours} h.`], true);
          popSaid.set(popId, 'battery');
        } else if (said === 'battery' && hours != null && hours <= ctx.cfg.proactive.popLowHours) {
          ctx.notify.proactive(`⚠️ ${name}: autonomia quasi finita`, [`Carica ${soc}, circa ${hours} h rimaste.`], true);
          popSaid.set(popId, 'low');
        }
      } else if (said && p.batteryState === 'charging') {
        ctx.notify.proactive(`✅ ${name}: batteria in carica`, ['La corrente è tornata (o il fotovoltaico basta).'], true);
        popSaid.delete(popId);
      }
    }
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
