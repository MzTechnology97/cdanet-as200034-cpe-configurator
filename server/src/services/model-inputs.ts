import type { AppContext } from '../context.ts';
import { buildApModel, MAX_LINK_M, networkCalibrationDb, type AntennaSetup, type ApModel, type RadioDefaults } from '../domain/coverage-model.ts';
import { distanceM } from '../domain/geo.ts';
import { parseMac } from '../domain/policy.ts';
import { cpeHeights } from './field-samples.ts';
import { obstacles, pointingConfig, terrainBetween, terrainSampler } from './terrain.ts';
import { isPtp } from './uisp.ts';

/**
 * What the coverage model learns from, with the terrain of each customer's own path: UISP's
 * customers per AP (modelInputs) plus the loss of the profile between each customer and its AP
 * (TINITALY/SRTM, buildings, trees). The model then calibrates and corrects locally only on what
 * the terrain does not explain. Profiles are kept (per AP, customer place, heights and terrain
 * version): the first request after a start computes them, the next ones read them.
 */

const cache = new Map<string, { t: number | null; e: number | null }>();
const MAX = 20_000;


export async function modelInputs(ctx: AppContext, radio?: RadioDefaults) {
  const inputs = await ctx.uisp!.modelInputs(radio);
  const h = pointingConfig(ctx.db);
  const obs = obstacles(ctx);
  const own = cpeHeights(ctx.db);
  const ver = ctx.terrain.status().updatedAt ?? '0';
  for (const a of inputs.aps) {
    if (isPtp(a.device)) continue;
    const target = { lat: a.location.lat, lon: a.location.lon, gpsAltitude: a.device.altitude, siteHeight: a.siteHeight, frequency: a.device.frequency };
    let at: Awaited<ReturnType<typeof terrainSampler>> | undefined;
    for (const c of a.clients) {
      if (c.signal === null) continue;
      const d = distanceM(a.location, c);
      if (d < 50 || d > MAX_LINK_M) continue;
      const mac = c.device.mac ? parseMac(c.device.mac) : null;
      const cpeM = (mac ? own.get(mac) : undefined) ?? h.cpeHeightM;
      const key = `${ver}|${a.device.id}|${c.lat.toFixed(5)},${c.lon.toFixed(5)}|${cpeM}|${h.apHeightM}|${a.siteHeight}|${obs.buildingM}|${obs.treeM}`;
      if (!cache.has(key)) {
        at ??= await terrainSampler(ctx.terrain, [a.location], MAX_LINK_M + 500);
        if (!at) break;
        const te = terrainBetween(at, c, cpeM, target, h.apHeightM, obs);
        cache.set(key, { t: te?.lossDb ?? null, e: te?.elevDeg ?? null });
        while (cache.size > MAX) cache.delete(cache.keys().next().value!);
      }
      const v = cache.get(key)!;
      c.terrainDb = v.t;
      c.elevDeg = v.e;
    }
  }
  const aps = inputs.aps.map((a) => ({ ...a, pattern: antennaSetup(ctx, a.device) }));
  // the network calibration on the same footing (terrain and real antennas taken out)
  const prior = networkCalibrationDb(aps.filter((a) => !isPtp(a.device)).map((a) => ({ ap: a.location, clients: a.clients, heading: a.heading, freqMHz: a.device.frequency, pattern: a.pattern })), inputs.radio) ?? 0;
  return { ...inputs, aps, prior };
}

/** UISP models with the antenna built in, and their pattern in the library. */
const BUILT_IN: Array<[RegExp, string]> = [
  [/^LAP-GPS/i, 'ubnt:LAP-GPS'],
  [/^LBE-5AC-LR/i, 'ubnt:LBE-5AC-LR'],
  [/^LBE-5AC-23/i, 'ubnt:LBE-5AC-23'],
  [/^LBE-5AC/i, 'ubnt:LBE-5AC-Gen2'],
  [/^NBE-5AC-19/i, 'ubnt:NBE-5AC-19'],
  [/^NBE-5AC/i, 'ubnt:NBE-5AC-Gen2'],
  [/^NS-5ACL|loco.*5ac/i, 'ubnt:NS-5AC-Loco'],
  [/^NS-5AC/i, 'ubnt:NS-5AC'],
  [/^PBE-5AC/i, 'ubnt:PBE-5AC-400'],
];

/** The pattern the AP has, when it is known: model built in or chosen by the admin. */
export function antennaIdOf(ctx: AppContext, device: { id: string; model: string | null }): { id: string | null; from: 'admin' | 'modello' | null } {
  const a = ctx.antennas.assigned()[device.id];
  if (a?.antennaId) return { id: a.antennaId, from: 'admin' };
  const m = BUILT_IN.find(([re]) => re.test(device.model ?? ''));
  return m ? { id: m[1], from: 'modello' } : { id: null, from: null };
}

/**
 * The real antenna of an AP for the model: only with a known azimuth (the admin's, else the one
 * typed in UISP). An azimuth guessed from the customers is a suggestion to confirm: a wrong one
 * would turn the pattern against the customers.
 */
export function antennaSetup(ctx: AppContext, device: { id: string; model: string | null; heading: number | null }): AntennaSetup | null {
  const a = ctx.antennas.assigned()[device.id];
  const p = ctx.antennas.pattern(antennaIdOf(ctx, device).id);
  const azimuth = a?.azimuth ?? device.heading;
  if (!p || azimuth === null || azimuth === undefined) return null;
  return { az: p.az, el: p.el, azimuth, tilt: a?.tilt ?? null };
}

/** Coverage model of each AP in [apIds], from its customers and their terrain. */
export async function apModels(ctx: AppContext, apIds: string[], radio?: RadioDefaults): Promise<Map<string, ApModel>> {
  const want = new Set(apIds);
  const { aps, prior, radio: r } = await modelInputs(ctx, radio);
  const out = new Map<string, ApModel>();
  for (const a of aps) if (want.has(a.device.id)) out.set(a.device.id, buildApModel(a.location, a.clients, a.heading, a.device.frequency, r, prior, a.pattern));
  return out;
}
