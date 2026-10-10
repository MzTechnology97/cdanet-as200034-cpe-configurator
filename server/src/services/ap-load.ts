import type { Db } from '../db.ts';
import { nowIso } from '../db.ts';
import { apCapacityFactor, capacityAt, capacityCurve, summarizeLoad, type ApLoad, type CapacityCurve, type CapacitySample } from '../domain/ap-load.ts';
import { isAp, isPtp, type Uisp } from './uisp.ts';

/**
 * Load of every AP and the capacity curve of the network, refreshed every hour in the background
 * from UISP (stations and a week of statistics per AP, 4 at a time) and kept in the database, so
 * Copertura answers at once and the numbers survive a restart.
 */

const KEY = 'ap.load';
const HOUR = 3_600_000;

interface Stored {
  at: string | null;
  loads: Record<string, ApLoad>;
  curve: CapacityCurve | null;
  factors: Record<string, number>;
  widths: Record<string, number>;
}

export function createApLoad(db: Db, getUisp: () => Uisp | null, log?: (m: string) => void) {
  let data: Stored = (() => {
    try {
      const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as { value: string } | undefined;
      return r ? (JSON.parse(r.value) as Stored) : { at: null, loads: {}, curve: null, factors: {}, widths: {} };
    } catch {
      return { at: null, loads: {}, curve: null, factors: {}, widths: {} };
    }
  })();
  let running = false;
  let timer: NodeJS.Timeout | null = null;

  async function refresh(): Promise<void> {
    const uisp = getUisp();
    if (!uisp || running) return;
    running = true;
    try {
      const devices = await uisp.allDevices();
      const signalOf = new Map(devices.filter((d) => !isAp(d)).map((d) => [d.id, d.signal]));
      const aps = devices.filter((d) => isAp(d) && !isPtp(d) && d.status === 'active' && (d.stations ?? 0) > 0);
      const loads: Record<string, ApLoad> = {};
      const widths: Record<string, number> = {};
      const own = new Map<string, CapacitySample[]>();
      let next = 0;
      const worker = async () => {
        while (next < aps.length) {
          const ap = aps[next++]!;
          const [stations, stats] = await Promise.all([uisp.apStations(ap.id).catch(() => null), uisp.weekStatistics(ap.id).catch(() => null)]);
          const load = summarizeLoad(stats, stations, ap);
          loads[ap.id] = load;
          const width = load.channelWidthMhz ?? 20;
          widths[ap.id] = width;
          // the CPE's own signal (what the coverage model estimates) with the capacity of its link
          own.set(
            ap.id,
            ((stations ?? []) as Array<Record<string, unknown>>).flatMap((s) => {
              const id = (s.deviceIdentification as { id?: string } | undefined)?.id;
              const sig = id ? signalOf.get(id) : null;
              const cap = typeof s.downlinkCapacity === 'number' ? s.downlinkCapacity / 1e6 : null;
              return s.connected !== false && typeof sig === 'number' && cap !== null && cap > 0 ? [{ signal: sig, capMbps: cap, widthMhz: width }] : [];
            }),
          );
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
      const curve = capacityCurve([...own.values()].flat());
      const factors: Record<string, number> = {};
      if (curve) for (const [id, s] of own) factors[id] = apCapacityFactor(curve, s);
      data = { at: nowIso(), loads, curve, factors, widths };
      db.prepare(
        `INSERT INTO settings(key, value, updated_at, updated_by) VALUES(?, ?, ?, NULL)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(KEY, JSON.stringify(data), nowIso());
    } catch (err) {
      log?.(`ap load: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  }

  return {
    refresh,
    /** First refresh shortly after the start (if the stored one is older than an hour), then hourly. */
    start() {
      const age = data.at ? Date.now() - Date.parse(data.at) : Infinity;
      setTimeout(() => void refresh(), age > HOUR ? 30_000 : HOUR - age).unref();
      timer = setInterval(() => void refresh(), HOUR);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
    },
    at: () => data.at,
    load: (apId: string): ApLoad | null => data.loads[apId] ?? null,
    /** Expected downlink capacity of a new CPE receiving [signal] dBm from [apId], Mbit/s; null without data. */
    capacity(apId: string, signal: number | null, widthMhz?: number | null): number | null {
      if (!data.curve || signal === null) return null;
      const w = widthMhz ?? data.widths[apId] ?? data.loads[apId]?.channelWidthMhz ?? 20;
      return capacityAt(data.curve, signal, w, data.factors[apId] ?? 1);
    },
    curve: () => data.curve,
    /** For the tests. */
    _set(d: Partial<Stored>) {
      data = { ...data, ...d };
    },
  };
}
export type ApLoadService = ReturnType<typeof createApLoad>;
