import type { Db } from '../db.ts';
import { estimateAt, MAX_LINK_M, type ApModel, type RadioDefaults, type SignalEstimate, type TerrainEffect } from '../domain/coverage-model.ts';
import { distanceM, type LatLon } from '../domain/geo.ts';
import { diffractionLossDb, lineOfSight, pathPoints, resolveApAltitude } from '../domain/los.ts';
import type { Dem } from './dem.ts';

/**
 * Terrain between a point and an AP, for the expected signal (Copertura, AP vicini, simulation):
 * the same profile and antenna altitudes as "Visibilità", so the two never disagree.
 */

export interface PointingConfig {
  /** Height of the AP antennas above the ground (UISP has no field for it). */
  apHeightM: number;
  /** Default height of the CPE above the ground (the technician can change it). */
  cpeHeightM: number;
}
const DEFAULT: PointingConfig = { apHeightM: 15, cpeHeightM: 6 };

/** Antenna heights set by the admin in Copertura → Puntamento (app). */
export function pointingConfig(db: Db): PointingConfig {
  const r = db.prepare("SELECT value FROM settings WHERE key = 'pointing.config'").get() as { value: string } | undefined;
  return { ...DEFAULT, ...(r ? (JSON.parse(r.value) as Partial<PointingConfig>) : {}) };
}

export type Elevation = (lat: number, lon: number) => number | null;

/** Elevation for the area around [points] (+ [marginM]); null without elevation model. */
export async function terrainSampler(dem: Dem, points: LatLon[], marginM = 0): Promise<Elevation | null> {
  if (!dem.enabled || !points.length) return null;
  const dLat = marginM / 111_320;
  const dLon = marginM / (111_320 * Math.cos((points[0]!.lat * Math.PI) / 180));
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  return dem.sampler(Math.min(...lats) - dLat, Math.min(...lons) - dLon, Math.max(...lats) + dLat, Math.max(...lons) + dLon);
}

export interface TerrainAp extends LatLon {
  /** Altitude reported by UISP (GPS on some APs, a height on others). */
  gpsAltitude: number | null;
  siteHeight: number | null;
  frequency: number | null;
}

/**
 * Line-of-sight verdict and diffraction loss over the terrain from a CPE [cpeHeightM] above the
 * ground at [point] to the AP antenna. [stepM]: spacing of the profile (finer for one point, coarser
 * for the cells of a simulation). null when the elevation is missing somewhere on the path.
 */
export function terrainBetween(at: Elevation, point: LatLon, cpeHeightM: number, ap: TerrainAp, apHeightM: number, stepM = 75, maxPoints = 160): TerrainEffect | null {
  const D = distanceM(point, ap);
  if (D < 100) return { verdict: 'clear', lossDb: 0 };
  const n = Math.max(12, Math.min(maxPoints, Math.round(D / stepM)));
  const pts = pathPoints(point, ap, n);
  const ground: number[] = [];
  for (const p of pts) {
    const g = at(p.lat, p.lon);
    if (g === null) return null;
    ground.push(g);
  }
  const from = ground[0]! + cpeHeightM;
  const to = resolveApAltitude(ap.gpsAltitude, ground[n]!, ap.siteHeight ?? apHeightM).altitude ?? ground[n]! + apHeightM;
  const freq = ap.frequency && ap.frequency > 1000 ? ap.frequency : 5600;
  const profile = pts.map((p, i) => ({ d: p.f * D, ground: ground[i]! }));
  return { verdict: lineOfSight(profile, from, to, freq).verdict, lossDb: diffractionLossDb(profile, from, to, freq) };
}

/**
 * Expected signal of a new CPE at [point] from one AP of a list (nearestAps: distance and bearing
 * from the point): calibrated model + terrain, the same for Copertura and AP vicini.
 */
export function estimateForAp(
  m: ApModel | undefined,
  ap: TerrainAp & { distanceM: number; bearing: number },
  point: LatLon,
  at: Elevation | null,
  heights: { cpeM: number; apM: number },
  radio: RadioDefaults,
): SignalEstimate | null {
  if (!m) return null;
  // beyond any real link the terrain is not worth computing: the AP is out anyway
  const terrain = at && ap.distanceM <= MAX_LINK_M ? terrainBetween(at, point, heights.cpeM, ap, heights.apM) : null;
  // bearing from the AP towards the point = reverse of the pointing direction
  return estimateAt(m, ap.distanceM, (ap.bearing + 180) % 360, ap.frequency, radio, terrain);
}
