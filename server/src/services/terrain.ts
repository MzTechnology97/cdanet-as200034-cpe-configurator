import type { Db } from '../db.ts';
import { estimateAt, MAX_LINK_M, type ApModel, type RadioDefaults, type SignalEstimate, type TerrainEffect } from '../domain/coverage-model.ts';
import { distanceM, type LatLon } from '../domain/geo.ts';
import { diffractionLossDb, lineOfSight, pathPoints, resolveApAltitude, type ApAltitudeFrom, type ProfilePoint } from '../domain/los.ts';
import type { TerrainSampler, TerrainStore } from './terrain-store.ts';

/**
 * Terrain and obstacles between a point and an AP, for the expected signal (Copertura, AP vicini,
 * simulation) and Visibilità: the same profile and antenna altitudes everywhere, so they never
 * disagree. Ground: TINITALY 10 m where imported, else SRTM. Obstacles from the land cover
 * (ESA WorldCover): buildings are solid (they raise the profile, diffraction like a hill), trees
 * attenuate the stretch of the line of sight that crosses their crowns (foliage, ITU-R P.833).
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

/** Heights of the obstacles of the land cover (Impostazioni server → Simulazione radio), m. */
export interface ObstacleHeights {
  buildingM: number;
  treeM: number;
}

/** Obstacle heights of the settings. */
export const obstacles = (ctx: { cfg: { coverageBuildingM: number; coverageTreeM: number } }): ObstacleHeights => ({ buildingM: ctx.cfg.coverageBuildingM, treeM: ctx.cfg.coverageTreeM });

/** ESA WorldCover classes that are obstacles: 10 tree cover, 20 shrubland, 50 built-up. */
const TREE = 10;
const SHRUB = 20;
const BUILT = 50;
/** Shrubs: low vegetation, as trees of this height. */
const SHRUB_M = 2;
/** Obstacles this close to an antenna are the place it is mounted on: the antenna is above them. */
const NEAR_ANTENNA_M = 50;
/** Antennas are mounted above the roofs and trees around them (within this radius), by this much. */
const AROUND_M = 60;
const ABOVE_M = 2;
/** APs stand on the top of their hill: the highest ground within this radius of the UISP position. */
const AP_SPOT_M = 100;
/** Foliage at 5 GHz: specific attenuation and saturation (ITU-R P.833 order of magnitude), dB/m and dB. */
const FOLIAGE_DB_PER_M = 0.4;
const FOLIAGE_MAX_DB = 20;

/** Attenuation of [m] metres of tree crowns on the line of sight, dB. */
export function foliageLossDb(m: number): number {
  return m <= 0 ? 0 : FOLIAGE_MAX_DB * (1 - Math.exp((-FOLIAGE_DB_PER_M * m) / FOLIAGE_MAX_DB));
}

/** Terrain for the area around [points] (+ [marginM]); null without any elevation model. */
export async function terrainSampler(terrain: TerrainStore, points: LatLon[], marginM = 0): Promise<TerrainSampler | null> {
  if (!points.length) return null;
  const dLat = marginM / 111_320;
  const dLon = marginM / (111_320 * Math.cos((points[0]!.lat * Math.PI) / 180));
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  return terrain.sampler({ minLat: Math.min(...lats) - dLat, minLon: Math.min(...lons) - dLon, maxLat: Math.max(...lats) + dLat, maxLon: Math.max(...lons) + dLon });
}

export interface TerrainAp extends LatLon {
  /** Altitude reported by UISP (GPS on some APs, a height on others). */
  gpsAltitude: number | null;
  siteHeight: number | null;
  frequency: number | null;
}

export interface BuiltProfile {
  D: number;
  freq: number;
  /** Antenna altitudes, m a.s.l. */
  from: number;
  to: number;
  /** Bare ground and the obstacle on it (height above the ground and kind) at each point. */
  ground: number[];
  obstacle: Array<{ h: number; kind: 'edificio' | 'alberi' } | null>;
  /** Distances along the path from the CPE, m. */
  d: number[];
  altitudeFrom: ApAltitudeFrom | null;
}

/**
 * Profile from a CPE [cpeHeightM] above the ground at [point] to the AP antenna: ground and the
 * obstacles of the land cover. [stepM]: spacing (finer for one point, coarser for the cells of a
 * simulation). null when the elevation is missing somewhere on the path.
 */
export function buildProfile(at: TerrainSampler, point: LatLon, cpeHeightM: number, ap: TerrainAp, apHeightM: number, obstacles: ObstacleHeights | null, stepM = 25, maxPoints = 800): BuiltProfile | null {
  const D = distanceM(point, ap);
  const n = Math.max(12, Math.min(maxPoints, Math.round(D / stepM)));
  const pts = pathPoints(point, ap, n);
  const ground: number[] = [];
  const obstacle: BuiltProfile['obstacle'] = [];
  for (const p of pts) {
    const g = at.ground(p.lat, p.lon);
    if (g === null) return null;
    ground.push(g);
    const d = p.f * D;
    obstacle.push(obstacles && d > NEAR_ANTENNA_M && D - d > NEAR_ANTENNA_M ? obstacleAt(at, p.lat, p.lon, obstacles) : null);
  }
  // the AP position in UISP may be a few tens of metres off the summit it stands on: its ground is
  // the highest point around it, else the summit itself would hide it
  const apGround = Math.max(ground[n]!, highestAround(at, ap, AP_SPOT_M));
  ground[n] = apGround;
  const resolved = resolveApAltitude(ap.gpsAltitude, apGround, ap.siteHeight, apHeightM);
  // an antenna among roofs or trees is mounted above them (installers pick a spot that sees out):
  // at least ABOVE_M over the obstacles within AROUND_M, whatever height is set
  const cpeH = obstacles ? Math.max(cpeHeightM, localTop(at, point, obstacles) + ABOVE_M) : cpeHeightM;
  const apTop = obstacles ? apGround + localTop(at, ap, obstacles) + ABOVE_M : -Infinity;
  return {
    D,
    freq: ap.frequency && ap.frequency > 1000 ? ap.frequency : 5600,
    from: ground[0]! + cpeH,
    to: Math.max(resolved.altitude ?? ground[n]! + apHeightM, apTop),
    ground,
    obstacle,
    d: pts.map((p) => p.f * D),
    altitudeFrom: resolved.from,
  };
}

/**
 * What stands on the ground at a point: the building of the basemap footprints with its height
 * where they were imported (a street between two houses is free there), else the class of the
 * land cover with the average height; trees with their own height from the canopy map where it
 * was imported, else trees and shrubs of the land cover. A tree height of 0 in the settings turns
 * trees off.
 */
export function obstacleAt(at: TerrainSampler, lat: number, lon: number, o: ObstacleHeights): { h: number; kind: 'edificio' | 'alberi' } | null {
  const b = at.building?.(lat, lon) ?? null;
  if (b !== null && b > 0) return { h: b, kind: 'edificio' };
  const c = at.cover(lat, lon);
  if (c === BUILT && b === null && o.buildingM > 0) return { h: o.buildingM, kind: 'edificio' };
  // the canopy map knows each tree and its height: where it was imported it replaces the classes
  const t = at.canopy?.(lat, lon) ?? null;
  if (t !== null) return t > 0 && o.treeM > 0 ? { h: t, kind: 'alberi' } : null;
  if (c === TREE && o.treeM > 0) return { h: o.treeM, kind: 'alberi' };
  if (c === SHRUB && o.treeM > 0) return { h: Math.min(SHRUB_M, o.treeM), kind: 'alberi' };
  return null;
}

/** Highest ground within [r] metres of a point (5 × 5 samples), m a.s.l.; -Infinity when unknown. */
function highestAround(at: TerrainSampler, p: LatLon, r: number): number {
  if (r <= 0) return -Infinity;
  const dLat = r / 111_320;
  const dLon = r / (111_320 * Math.cos((p.lat * Math.PI) / 180));
  let top = -Infinity;
  for (let a = -2; a <= 2; a++) {
    for (let b = -2; b <= 2; b++) {
      if (a * a + b * b > 4) continue;
      const g = at.ground(p.lat + (a / 2) * dLat, p.lon + (b / 2) * dLon);
      if (g !== null && g > top) top = g;
    }
  }
  return top;
}

/** Highest obstacle of the land cover around a point (centre and 8 points at AROUND_M), m above the ground. */
function localTop(at: TerrainSampler, p: LatLon, o: ObstacleHeights): number {
  const dLat = AROUND_M / 111_320;
  const dLon = AROUND_M / (111_320 * Math.cos((p.lat * Math.PI) / 180));
  let top = 0;
  for (const a of [-1, 0, 1]) {
    for (const b of [-1, 0, 1]) {
      const h = obstacleAt(at, p.lat + a * dLat, p.lon + b * dLon, o)?.h ?? 0;
      if (h > top) top = h;
    }
  }
  return top;
}

/** Effect of a built profile: line of sight over ground + buildings, diffraction and foliage. */
/**
 * Extra loss of a link with its Fresnel zone disturbed, dB: √(1.5·D/100) − 0.5 with D in metres
 * (the empirical addition of UISP Design under 60 GHz): about 6 dB at 3 km, 12 dB at 10 km.
 */
export const obstructionPenaltyDb = (distanceM: number) => Math.round(Math.max(0, Math.sqrt((1.5 * distanceM) / 100) - 0.5) * 10) / 10;

export function profileEffect(p: BuiltProfile): TerrainEffect {
  if (p.D < 100) return { verdict: 'clear', lossDb: 0 };
  const R_EFF = 6371000 * (4 / 3);
  const bare: ProfilePoint[] = p.d.map((d, i) => ({ d, ground: p.ground[i]! }));
  const solid: ProfilePoint[] = p.d.map((d, i) => ({ d, ground: p.ground[i]! + (p.obstacle[i]?.kind === 'edificio' ? p.obstacle[i]!.h : 0) }));
  const los = lineOfSight(solid, p.from, p.to, p.freq);
  const bareVerdict = lineOfSight(bare, p.from, p.to, p.freq).verdict;
  // tree crowns crossed by the line of sight (above the ground, below the top of the crowns)
  let foliageM = 0;
  for (let i = 1; i < p.d.length - 1; i++) {
    const o = p.obstacle[i];
    if (o?.kind !== 'alberi') continue;
    const d = p.d[i]!;
    const bulge = (d * (p.D - d)) / (2 * R_EFF);
    const line = p.from + ((p.to - p.from) * d) / p.D;
    const base = p.ground[i]! + bulge;
    if (line > base && line < base + o.h) foliageM += (p.d[i + 1]! - p.d[i - 1]!) / 2;
  }
  const foliageDb = Math.round(foliageLossDb(foliageM) * 10) / 10;
  const diffraction = diffractionLossDb(solid, p.from, p.to, p.freq);
  // the loss of a link whose Fresnel zone is disturbed (ground, buildings or tree crowns in the
  // way): the empirical addition of UISP Design for the bands under 60 GHz, measured on our
  // connected customers far closer to the real signal than the knife-edge diffraction (median
  // error of the obstructed ones 40 → 12 dB). The verdict still says what is in the way.
  const disturbed = los.verdict !== 'clear' || foliageM > 0;
  return {
    verdict: los.verdict,
    lossDb: disturbed ? obstructionPenaltyDb(p.D) : 0,
    diffractionDb: Math.round(Math.min(60, diffraction + foliageDb) * 10) / 10,
    ...(foliageM > 0 ? { foliageM: Math.round(foliageM), foliageDb } : {}),
    ...(los.verdict !== bareVerdict ? { buildings: true } : {}),
    // the point as the AP antenna sees it: degrees above (+) or below (−) its horizontal
    elevDeg: Math.round(((Math.atan2(p.from - p.to, p.D) * 180) / Math.PI) * 10) / 10,
  };
}

/** Line-of-sight verdict and loss over terrain and obstacles from a CPE at [point] to the AP antenna. */
export function terrainBetween(at: TerrainSampler, point: LatLon, cpeHeightM: number, ap: TerrainAp, apHeightM: number, obstacles: ObstacleHeights | null, stepM = 25, maxPoints = 800): TerrainEffect | null {
  if (distanceM(point, ap) < 100) return { verdict: 'clear', lossDb: 0 };
  const p = buildProfile(at, point, cpeHeightM, ap, apHeightM, obstacles, stepM, maxPoints);
  return p ? profileEffect(p) : null;
}

/**
 * Expected signal of a new CPE at [point] from one AP of a list (nearestAps: distance and bearing
 * from the point): calibrated model + terrain and obstacles, the same for Copertura and AP vicini.
 */
export function estimateForAp(
  m: ApModel | undefined,
  ap: TerrainAp & { distanceM: number; bearing: number },
  point: LatLon,
  at: TerrainSampler | null,
  heights: { cpeM: number; apM: number },
  radio: RadioDefaults,
  obstacles: ObstacleHeights | null = null,
): SignalEstimate | null {
  if (!m) return null;
  // beyond any real link the terrain is not worth computing: the AP is out anyway
  const terrain = at && ap.distanceM <= MAX_LINK_M ? terrainBetween(at, point, heights.cpeM, ap, heights.apM, obstacles) : null;
  // bearing from the AP towards the point = reverse of the pointing direction
  return estimateAt(m, ap.distanceM, (ap.bearing + 180) % 360, ap.frequency, radio, terrain);
}
