import type { LatLon } from '../domain/geo.ts';
import type { TerrainSampler } from './terrain-store.ts';

/**
 * The skyline of the terrain seen from a point (augmented reality of the app): for every
 * direction, the highest elevation angle of the ground within [maxM], with the earth curvature
 * (4/3 radius, as the radio profile). Ground only: buildings and trees are what the camera shows
 * and the model cannot know exactly, so the gap between the two skylines is the information.
 */

export interface Horizon {
  /** Azimuth step, degrees (true north, clockwise): index i is i × stepDeg. */
  stepDeg: number;
  /** Elevation angle of the skyline, degrees (negative: below the horizontal). */
  el: number[];
  /** Distance of the point making the skyline, m. */
  dist: number[];
  /** Ground and eye altitude, m a.s.l. */
  ground: number;
  eye: number;
  maxM: number;
}

const R_EFF = 6371000 * (4 / 3);

/** Distances sampled along a ray: fine near the point (roofs, the next hill), coarse far away. */
export function rayDistances(maxM: number): number[] {
  const out: number[] = [];
  for (let d = 20; d <= maxM; d += d < 1000 ? 15 : d < 5000 ? 40 : 90) out.push(d);
  return out;
}

export function computeHorizon(at: TerrainSampler, p: LatLon, eyeM: number, opts: { stepDeg?: number; maxM?: number } = {}): Horizon | null {
  const step = opts.stepDeg ?? 0.5;
  const maxM = opts.maxM ?? 25000;
  const g0 = at.ground(p.lat, p.lon);
  if (g0 === null) return null;
  const eye = g0 + eyeM;
  const ds = rayDistances(maxM);
  const mLat = 111_320;
  const mLon = 111_320 * Math.cos((p.lat * Math.PI) / 180);
  const n = Math.round(360 / step);
  const el: number[] = new Array(n);
  const dist: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i * step * Math.PI) / 180;
    const north = Math.cos(a) / mLat;
    const east = Math.sin(a) / mLon;
    let best = -Infinity;
    let at_ = 0;
    for (const d of ds) {
      const g = at.ground(p.lat + north * d, p.lon + east * d);
      if (g === null) continue;
      const t = (g - (d * d) / (2 * R_EFF) - eye) / d;
      if (t > best) {
        best = t;
        at_ = d;
      }
    }
    el[i] = best === -Infinity ? 0 : Math.round((Math.atan(best) * 180) / Math.PI * 100) / 100;
    dist[i] = at_;
  }
  return { stepDeg: step, el, dist, ground: Math.round(g0 * 10) / 10, eye: Math.round(eye * 10) / 10, maxM };
}
