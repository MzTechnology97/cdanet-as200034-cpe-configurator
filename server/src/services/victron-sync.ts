import { HttpError } from '../auth.ts';
import { nowIso, type Db } from '../db.ts';
import type { VrmSettings } from './victron.ts';

/**
 * The Victron systems of the POPs, read from VRM every few minutes (admins only, read only): the
 * battery and the alarms of each installation, kept in `victron_sites`. Which POP each one powers
 * is chosen by an admin (`victron_links`); the GPS of the GX only suggests the nearest POP.
 * Stato rete and Guasti Enel show the state of the POPs' power from here. An off-grid POP (solar
 * only, said by the admin) is not hit by an Enel outage: only the customers around it are.
 */

export type PowerStatus = 'ok' | 'warn' | 'alarm' | 'silent';

/** One installation as kept after a sync. */
export interface VrmSite {
  idSite: number;
  name: string;
  lat: number | null;
  lon: number | null;
  /** Unix seconds of the last data received by VRM. */
  lastTs: number | null;
  alarms: number;
  soc: number | null;
  voltage: number | null;
  current: number | null;
  batteryState: 'charging' | 'discharging' | 'idle' | null;
  /** VRM's own low state-of-charge alarm. */
  lowSoc: 'ok' | 'warning' | 'alarm' | null;
  /** Photovoltaic power now (W), read for the installations linked to a POP. */
  pvW: number | null;
  /** What the GX has on its first AC input: the grid, a generator, shore power or nothing. */
  acInput: 'grid' | 'generator' | 'shore' | 'none' | null;
  /** Not on the Enel grid (set by the admin with the link). */
  offGrid: boolean;
}

/** The power of one POP: its installations put together (the worst state, the lowest battery). */
export interface PopPower {
  status: PowerStatus;
  soc: number | null;
  voltage: number | null;
  pvW: number | null;
  batteryState: VrmSite['batteryState'];
  alarms: number;
  lastTs: number | null;
  sites: number;
  /** Every installation of the POP is off-grid: an Enel outage hits only its customers. */
  offGrid: boolean;
}

/** Below this state of charge a POP is in warning even when VRM's own alarm is quiet. */
export const SOC_WARN = 30;
/** No data from VRM for longer than this: the installation is silent (GX off, no Internet). */
export const SILENT_SECONDS = 3600;
const SYNC_MS = 5 * 60_000;
const STATE_KEY = 'victron.sync';

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** One VRM installation (installations?extended=1) as kept: no owner, phone, e-mail or notes. */
export function vrmSite(r: Record<string, unknown>): VrmSite | null {
  const idSite = Number(r.idSite);
  if (!Number.isInteger(idSite) || idSite <= 0) return null;
  const ext = new Map<string, Record<string, unknown>>();
  for (const e of Array.isArray(r.extended) ? (r.extended as Array<Record<string, unknown>>) : []) if (typeof e?.code === 'string' && !ext.has(e.code)) ext.set(e.code, e);
  const raw = (code: string) => num(ext.get(code)?.rawValue);
  const lat = raw('lt');
  const lon = raw('lg');
  // enums in VRM's order: Idle/Charging/Discharging and No alarm/Warning/Alarm
  const bst = raw('bst');
  const asoc = raw('ASoc');
  // AC input 1: Not available/Grid/Generator/Shore power
  const si1 = raw('si1');
  return {
    idSite,
    name: String(r.name ?? '').slice(0, 120),
    lat: lat !== null && lon !== null && !(lat === 0 && lon === 0) ? lat : null,
    lon: lat !== null && lon !== null && !(lat === 0 && lon === 0) ? lon : null,
    lastTs: num(r.last_timestamp) && Number(r.last_timestamp) > 0 ? Number(r.last_timestamp) : null,
    alarms: Math.max(0, num(r.num_alarms) ?? 0, r.alarm === true ? 1 : 0),
    soc: raw('bs'),
    voltage: raw('bv'),
    current: raw('bc'),
    batteryState: bst === 1 ? 'charging' : bst === 2 ? 'discharging' : bst === 0 ? 'idle' : null,
    lowSoc: asoc === 2 ? 'alarm' : asoc === 1 ? 'warning' : asoc === 0 ? 'ok' : null,
    pvW: null,
    acInput: si1 === 1 ? 'grid' : si1 === 2 ? 'generator' : si1 === 3 ? 'shore' : si1 === 0 ? 'none' : null,
    offGrid: false,
  };
}

/** VRM hints at off-grid when the GX has no grid on its AC input (the admin confirms). */
export const offGridHint = (s: Pick<VrmSite, 'acInput'>) => s.acInput === 'none' || s.acInput === 'generator';

/** The state of one installation: silent, then alarms, then low battery. */
export function powerStatus(s: Pick<VrmSite, 'lastTs' | 'alarms' | 'lowSoc' | 'soc'>, nowSec = Date.now() / 1000): PowerStatus {
  if (s.lastTs === null || nowSec - s.lastTs > SILENT_SECONDS) return 'silent';
  if (s.alarms > 0 || s.lowSoc === 'alarm') return 'alarm';
  if (s.lowSoc === 'warning' || (s.soc !== null && s.soc < SOC_WARN)) return 'warn';
  return 'ok';
}

const RANK: Record<PowerStatus, number> = {
  ok: 0,
  warn: 1,
  silent: 2,
  alarm: 3,
};

/** A POP with one or more installations: the worst state, the lowest battery, the PV summed. */
export function popPower(sites: VrmSite[], nowSec = Date.now() / 1000): PopPower | null {
  if (!sites.length) return null;
  const status = sites.map((s) => powerStatus(s, nowSec)).reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'ok' as PowerStatus);
  const low = sites.filter((s) => s.soc !== null).sort((a, b) => (a.soc as number) - (b.soc as number))[0];
  const pv = sites.filter((s) => s.pvW !== null);
  const ts = sites.map((s) => s.lastTs).filter((t): t is number => t !== null);
  return {
    status,
    soc: low?.soc ?? null,
    voltage: low?.voltage ?? sites.find((s) => s.voltage !== null)?.voltage ?? null,
    pvW: pv.length ? Math.round(pv.reduce((a, s) => a + (s.pvW as number), 0)) : null,
    batteryState: low?.batteryState ?? sites.find((s) => s.batteryState)?.batteryState ?? null,
    alarms: sites.reduce((a, s) => a + s.alarms, 0),
    // the oldest data: «ultimo dato 2 h fa» on a silent POP
    lastTs: ts.length ? Math.min(...ts) : null,
    sites: sites.length,
    offGrid: sites.every((s) => s.offGrid),
  };
}

/** What an installer sees of an assigned POP: the state, the battery and whether it is discharging. */
export interface InstallerPower {
  status: PowerStatus;
  soc: number | null;
  batteryState: VrmSite['batteryState'];
  offGrid: boolean;
}
export const installerPower = (p: PopPower): InstallerPower => ({
  status: p.status,
  soc: p.soc === null ? null : Math.round(p.soc),
  batteryState: p.batteryState,
  offGrid: p.offGrid,
});

/** Photovoltaic power (W) from the latest diagnostics of an installation: the PV of the system. */
export function pvFromDiagnostics(records: unknown): number | null {
  const list = Array.isArray(records) ? (records as Array<Record<string, unknown>>) : [];
  const pv = list
    .filter((d) => d?.code === 'Pdc')
    .map((d) => num(d.rawValue))
    .filter((v): v is number => v !== null);
  return pv.length ? pv.reduce((a, b) => a + b, 0) : null;
}

export interface SyncState {
  at: string | null;
  ms: number | null;
  sites: number;
  error: string | null;
}
const EMPTY: SyncState = { at: null, ms: null, sites: 0, error: null };

export function createVictronSync(db: Db, victron: VrmSettings, opts: { pauseMs?: number } = {}) {
  let running: Promise<SyncState> | null = null;
  let timer: NodeJS.Timeout | null = null;
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const state = (): SyncState => {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(STATE_KEY) as { value: string } | undefined;
    return r ? { ...EMPTY, ...(JSON.parse(r.value) as SyncState) } : EMPTY;
  };
  const saveState = (v: SyncState) =>
    db
      .prepare(`INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(STATE_KEY, JSON.stringify(v), nowIso());

  const rowSite = (r: Record<string, unknown>): VrmSite => ({
    idSite: Number(r.id_site),
    name: String(r.name),
    lat: num(r.lat),
    lon: num(r.lon),
    lastTs: num(r.last_ts),
    alarms: Number(r.alarms ?? 0),
    soc: num(r.soc),
    voltage: num(r.voltage),
    current: num(r.current),
    batteryState: (r.battery_state as VrmSite['batteryState']) ?? null,
    lowSoc: (r.low_soc as VrmSite['lowSoc']) ?? null,
    pvW: num(r.pv_w),
    acInput: (r.ac_input as VrmSite['acInput']) ?? null,
    offGrid: Number(r.off_grid ?? 0) === 1,
  });

  /** Every installation of the last sync, with the POP it powers (null: not linked yet). */
  const sites = (): Array<VrmSite & { popId: string | null }> =>
    (
      db.prepare('SELECT s.*, l.pop_id, l.off_grid FROM victron_sites s LEFT JOIN victron_links l ON l.id_site = s.id_site ORDER BY s.name COLLATE NOCASE').all() as Array<
        Record<string, unknown>
      >
    ).map((r) => ({
      ...rowSite(r),
      popId: (r.pop_id as string | null) ?? null,
    }));

  async function run(): Promise<SyncState> {
    const client = victron.client();
    if (!client) {
      saveState({ ...state(), error: null });
      return state();
    }
    const started = Date.now();
    try {
      const me = await client.me();
      const list = await client.get(`/users/${me.id}/installations?extended=1`, 30_000);
      const read = (Array.isArray(list.records) ? (list.records as Array<Record<string, unknown>>) : []).map(vrmSite).filter((s): s is VrmSite => s !== null);
      // the PV power from the diagnostics, only for the installations that power a POP (VRM: ~3 requests/s)
      const linked = new Set(
        (
          db.prepare('SELECT id_site FROM victron_links').all() as Array<{
            id_site: number;
          }>
        ).map((r) => r.id_site),
      );
      for (const s of read) {
        if (!linked.has(s.idSite)) continue;
        await pause(opts.pauseMs ?? 400);
        const d = await client.get(`/installations/${s.idSite}/diagnostics?count=1000`).catch(() => null);
        s.pvW = d ? pvFromDiagnostics(d.records) : null;
      }
      const at = nowIso();
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM victron_sites').run();
        const ins = db.prepare(
          `INSERT INTO victron_sites(id_site, name, lat, lon, last_ts, alarms, soc, voltage, current, battery_state, low_soc, pv_w, ac_input, seen_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        );
        for (const s of read) ins.run(s.idSite, s.name, s.lat, s.lon, s.lastTs, s.alarms, s.soc, s.voltage, s.current, s.batteryState, s.lowSoc, s.pvW, s.acInput, at);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      const v = {
        at,
        ms: Date.now() - started,
        sites: read.length,
        error: null,
      };
      saveState(v);
      return v;
    } catch (e) {
      const v = { ...state(), error: (e as HttpError).code ?? 'vrm_error' };
      saveState(v);
      return v;
    }
  }

  return {
    state: () => ({
      ...state(),
      running: running !== null,
      configured: victron.client() !== null,
    }),
    sites,

    /** The power of every POP with at least one installation linked. */
    byPop(nowSec = Date.now() / 1000): Map<string, PopPower> {
      const groups = new Map<string, VrmSite[]>();
      for (const s of sites()) if (s.popId) groups.set(s.popId, [...(groups.get(s.popId) ?? []), s]);
      const out = new Map<string, PopPower>();
      for (const [pop, list] of groups) {
        const p = popPower(list, nowSec);
        if (p) out.set(pop, p);
      }
      return out;
    },

    /** The POPs powered only by their solar systems: an Enel outage hits only their customers. */
    offGridPops(): Set<string> {
      return new Set([...this.byPop()].filter(([, p]) => p.offGrid).map(([id]) => id));
    },

    /** An admin's choice: [popId] null unlinks the installation; [offGrid] undefined keeps the saved one. */
    link(idSite: number, popId: string | null, userId: number, offGrid?: boolean) {
      if (popId === null) db.prepare('DELETE FROM victron_links WHERE id_site = ?').run(idSite);
      else {
        const prev = db.prepare('SELECT off_grid FROM victron_links WHERE id_site = ?').get(idSite) as { off_grid: number } | undefined;
        db.prepare(
          `INSERT INTO victron_links(id_site, pop_id, off_grid, linked_by, linked_at) VALUES(?, ?, ?, ?, ?)
           ON CONFLICT(id_site) DO UPDATE SET pop_id = excluded.pop_id, off_grid = excluded.off_grid, linked_by = excluded.linked_by, linked_at = excluded.linked_at`,
        ).run(idSite, popId, offGrid === undefined ? (prev?.off_grid ?? 0) : offGrid ? 1 : 0, userId, nowIso());
      }
    },

    syncNow(): Promise<SyncState> {
      running ??= run().finally(() => {
        running = null;
      });
      return running;
    },

    start(everyMs = SYNC_MS) {
      const tick = () => void this.syncNow().catch(() => {});
      timer = setInterval(tick, everyMs);
      timer.unref();
      setTimeout(tick, 30_000).unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
export type VictronSync = ReturnType<typeof createVictronSync>;
