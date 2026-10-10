import type { AppContext } from '../context.ts';
import { nowIso } from '../db.ts';
import { buildApModel, estimateAt, MAX_LINK_M, rateCoverage } from '../domain/coverage-model.ts';
import { bearingDeg, distanceM } from '../domain/geo.ts';
import { isPtp } from './uisp.ts';
import { obstacles, pointingConfig, terrainBetween, terrainSampler } from './terrain.ts';
import { cpeHeights, fieldFailures } from './field-samples.ts';
import { parseMac } from '../domain/policy.ts';

/**
 * How reliable the coverage estimate is, measured on the real customers: for every connected CPE
 * with a signal and a plausible position, the model of its AP is rebuilt WITHOUT it and the
 * estimate at its place is compared with the signal it really gets (leave-one-out). Admins see the
 * summary, the history (to compare before/after a change of terrain, obstacles or settings), the
 * APs with the largest errors and the customers the model gets most wrong (UISP positions are
 * right: there the terrain, the obstacles or the antenna heights need a look). Runs on demand in
 * the background (a minute or two).
 */

export interface AccuracySummary {
  at: string;
  /** Terrain used: 10 m (TINITALY) somewhere, else SRTM only. */
  terrain: 'tinitaly' | 'srtm' | 'nessuno';
  settings: { eirpDbm: number; cpeGainDbi: number; buildingM: number; treeM: number; calibrationDb: number };
  customers: number;
  /** Error = estimate − real signal, dB. */
  biasDb: number;
  medianAbsDb: number;
  p90AbsDb: number;
  within6Pct: number;
  byTerrain: Record<string, { n: number; medianAbsDb: number; biasDb: number }>;
  /** Connected customers the model calls blocked, and those it would rate "improbabile". */
  blockedButConnected: number;
  unlikelyButConnected: number;
  /** Customers measured with the CPE height of their acceptance test (the others: the default). */
  realHeights?: number;
  /** Installations given up for radio reasons, and how the model rates them (it should not say "buono"). */
  failures?: { n: number; rated: Record<string, number> };
}

export interface AccuracyRun extends AccuracySummary {
  aps: Array<{ id: string; name: string; customers: number; biasDb: number; medianAbsDb: number }>;
  worst: Array<{ device: string; mac: string | null; ap: string; realDbm: number; estimateDbm: number; errorDb: number; terrain: string | null; distanceM: number }>;
}

const KEY = 'coverage.accuracy';
const q = (v: number[], p: number) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))]! : 0;
};
const r1 = (v: number) => Math.round(v * 10) / 10;

export function createCoverageAccuracy(ctx: AppContext) {
  const state = { running: false, error: null as string | null, startedAt: null as string | null };

  const stored = (): { history: AccuracySummary[]; last: AccuracyRun | null } => {
    const r = ctx.db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as { value: string } | undefined;
    return r ? (JSON.parse(r.value) as { history: AccuracySummary[]; last: AccuracyRun | null }) : { history: [], last: null };
  };

  async function measure(): Promise<AccuracyRun> {
    if (!ctx.uisp) throw new Error('uisp_not_configured');
    const radio = { eirpDbm: ctx.cfg.coverageEirpDbm, cpeGainDbi: ctx.cfg.coverageCpeGainDbi };
    const { aps, prior } = await ctx.uisp.modelInputs(radio);
    const h = pointingConfig(ctx.db);
    const obs = obstacles(ctx);
    const min = ctx.cfg.thresholds.signalMin;
    const heights = cpeHeights(ctx.db);
    let realHeights = 0;
    const rows: Array<{ ap: string; err: number; real: number; est: number; verdict: string | null; device: string; mac: string | null; d: number; rating: string }> = [];
    let fine = false;
    let any = false;
    for (const a of aps) {
      if (isPtp(a.device)) continue;
      const withSignal = a.clients.filter((c) => c.signal !== null && c.signal < -20 && c.signal > -100);
      if (withSignal.length < 2) continue;
      const at = await terrainSampler(ctx.terrain, [a.location], MAX_LINK_M + 500);
      if (at) {
        any = true;
        fine ||= at.fine;
      }
      const target = { lat: a.location.lat, lon: a.location.lon, gpsAltitude: a.device.altitude, siteHeight: a.siteHeight, frequency: a.device.frequency };
      for (const c of withSignal) {
        const d = distanceM(a.location, c);
        if (d < 50 || d > MAX_LINK_M) continue; // positions the model ignores anyway
        const m = buildApModel(a.location, a.clients.filter((x) => x !== c), a.heading, a.device.frequency, radio, prior);
        // the real height of the CPE when its acceptance test says it, else the default
        const mac = c.device.mac ? parseMac(c.device.mac) : null;
        const own = mac ? heights.get(mac) : undefined;
        if (own !== undefined) realHeights++;
        const terrain = at ? terrainBetween(at, c, own ?? h.cpeHeightM, target, h.apHeightM, obs) : null;
        const e = estimateAt(m, d, bearingDeg(a.location, c), a.device.frequency, radio, terrain);
        if (e.signalDbm === null) continue;
        rows.push({ ap: a.device.id, err: e.signalDbm - c.signal!, real: c.signal!, est: e.signalDbm, verdict: terrain?.verdict ?? null, device: c.device.name, mac: c.device.mac, d: Math.round(d), rating: rateCoverage('active', e, min) });
      }
    }
    // the negative cases: where an installation failed, what would the model have said?
    const rated: Record<string, number> = {};
    let n = 0;
    for (const f of fieldFailures(ctx.db)) {
      const a = f.apName ? aps.find((x) => x.device.name.toLowerCase() === f.apName!.toLowerCase()) : undefined;
      if (!a) continue;
      const at = await terrainSampler(ctx.terrain, [a.location, f], 500);
      const target = { lat: a.location.lat, lon: a.location.lon, gpsAltitude: a.device.altitude, siteHeight: a.siteHeight, frequency: a.device.frequency };
      const m = buildApModel(a.location, a.clients, a.heading, a.device.frequency, radio, prior);
      const terrain = at ? terrainBetween(at, f, h.cpeHeightM, target, h.apHeightM, obs) : null;
      const e = estimateAt(m, distanceM(a.location, f), bearingDeg(a.location, f), a.device.frequency, radio, terrain);
      const r = rateCoverage(a.device.status === 'active' ? 'active' : a.device.status, e, min);
      rated[r] = (rated[r] ?? 0) + 1;
      n++;
    }
    const errs = rows.map((x) => x.err);
    const abs = errs.map(Math.abs);
    const byTerrain: AccuracySummary['byTerrain'] = {};
    for (const v of ['clear', 'fresnel', 'blocked', 'n/d']) {
      const g = rows.filter((x) => (x.verdict ?? 'n/d') === v);
      if (g.length) byTerrain[v] = { n: g.length, medianAbsDb: r1(q(g.map((x) => Math.abs(x.err)), 0.5)), biasDb: r1(g.reduce((s, x) => s + x.err, 0) / g.length) };
    }
    const apName = new Map(aps.map((a) => [a.device.id, a.device.name]));
    const perAp = [...new Set(rows.map((x) => x.ap))].map((id) => {
      const g = rows.filter((x) => x.ap === id);
      return { id, name: apName.get(id) ?? id, customers: g.length, biasDb: r1(g.reduce((s, x) => s + x.err, 0) / g.length), medianAbsDb: r1(q(g.map((x) => Math.abs(x.err)), 0.5)) };
    });
    return {
      at: nowIso(),
      terrain: fine ? 'tinitaly' : any ? 'srtm' : 'nessuno',
      settings: { ...radio, buildingM: obs.buildingM, treeM: obs.treeM, calibrationDb: prior },
      customers: rows.length,
      biasDb: rows.length ? r1(errs.reduce((s, v) => s + v, 0) / rows.length) : 0,
      medianAbsDb: r1(q(abs, 0.5)),
      p90AbsDb: r1(q(abs, 0.9)),
      within6Pct: rows.length ? Math.round((100 * abs.filter((v) => v <= 6).length) / rows.length) : 0,
      byTerrain,
      blockedButConnected: rows.filter((x) => x.verdict === 'blocked' && x.real >= min).length,
      unlikelyButConnected: rows.filter((x) => x.rating === 'improbabile' && x.real >= min).length,
      realHeights,
      failures: { n, rated },
      aps: perAp.filter((a) => a.customers >= 3).sort((x, y) => Math.abs(y.biasDb) - Math.abs(x.biasDb)).slice(0, 15),
      worst: rows
        .sort((x, y) => Math.abs(y.err) - Math.abs(x.err))
        .slice(0, 30)
        .map((x) => ({ device: x.device, mac: x.mac, ap: apName.get(x.ap) ?? x.ap, realDbm: x.real, estimateDbm: x.est, errorDb: x.err, terrain: x.verdict, distanceM: x.d })),
    };
  }

  /** Starts a measurement in the background; the result is kept with the history (last 30). */
  function start(): boolean {
    if (state.running) return false;
    Object.assign(state, { running: true, error: null, startedAt: nowIso() });
    void measure()
      .then((run) => {
        const { history } = stored();
        const { aps: _a, worst: _w, ...summary } = run;
        const value = JSON.stringify({ history: [...history, summary].slice(-30), last: run });
        ctx.db
          .prepare(
            `INSERT INTO settings(key, value, updated_at, updated_by) VALUES(?, ?, ?, NULL)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          )
          .run(KEY, value, nowIso());
      })
      .catch((err: Error) => (state.error = err.message))
      .finally(() => (state.running = false));
    return true;
  }

  return { start, measure, view: () => ({ ...stored(), running: state.running, error: state.error, startedAt: state.startedAt }) };
}
export type CoverageAccuracy = ReturnType<typeof createCoverageAccuracy>;
