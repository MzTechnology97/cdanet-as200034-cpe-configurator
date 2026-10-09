/**
 * Line of sight between the CPE and an AP over the terrain profile, with earth curvature
 * (standard refraction, k = 4/3) and the first Fresnel zone. Terrain only: buildings and trees
 * are not in the elevation model, so "clear" means "no hill in the way".
 */

export interface ProfilePoint {
  /** Distance from the CPE, metres. */
  d: number;
  /** Ground elevation, metres a.s.l. */
  ground: number;
}

export interface LosResult {
  verdict: 'clear' | 'fresnel' | 'blocked';
  /** Worst point: where the clearance relative to 60% of the Fresnel radius is smallest. */
  worst: { d: number; clearanceM: number; fresnel60M: number } | null;
  /** Extra height of the CPE mast needed to free 60% of the first Fresnel zone (0 = already free). */
  raiseCpeM: number;
  /** Points for the chart: ground with earth bulge, line of sight, lower edge of 60% Fresnel. */
  chart: Array<{ d: number; ground: number; los: number; fresnel60: number }>;
}

const R_EFF = 6371000 * (4 / 3);

/** Radius (m) of the first Fresnel zone at d1/d2 metres from the ends, frequency in MHz. */
export function fresnelRadius(d1: number, d2: number, freqMHz: number): number {
  const D = d1 + d2;
  if (D <= 0) return 0;
  const lambda = 299.792458 / freqMHz;
  return Math.sqrt((lambda * d1 * d2) / D);
}

export function lineOfSight(profile: ProfilePoint[], fromAltitude: number, toAltitude: number, freqMHz = 5600): LosResult {
  if (profile.length < 2) return { verdict: 'clear', worst: null, raiseCpeM: 0, chart: [] };
  const D = profile[profile.length - 1]!.d;
  let worst: LosResult['worst'] = null;
  let worstMargin = Infinity;
  let blocked = false;
  let need = 0;
  const chart = profile.map(({ d, ground }) => {
    const bulge = (d * (D - d)) / (2 * R_EFF);
    const g = ground + bulge;
    const los = fromAltitude + ((toAltitude - fromAltitude) * d) / D;
    const f60 = 0.6 * fresnelRadius(d, D - d, freqMHz);
    // the ends are the antennas themselves
    if (d > 0 && d < D) {
      const clearance = los - g;
      if (clearance < 0) blocked = true;
      const margin = clearance - f60;
      if (margin < worstMargin) {
        worstMargin = margin;
        worst = { d: Math.round(d), clearanceM: Math.round(clearance * 10) / 10, fresnel60M: Math.round(f60 * 10) / 10 };
      }
      // raising the CPE by h lifts the line at d by h * (D - d) / D
      if (margin < 0) need = Math.max(need, -margin / ((D - d) / D));
    }
    return { d: Math.round(d), ground: Math.round(g * 10) / 10, los: Math.round(los * 10) / 10, fresnel60: Math.round((los - f60) * 10) / 10 };
  });
  return {
    verdict: blocked ? 'blocked' : worstMargin < 0 ? 'fresnel' : 'clear',
    worst,
    raiseCpeM: Math.ceil(need * 2) / 2,
    chart,
  };
}

/** n+1 points evenly spaced from a to b (great-circle interpolation is not needed at a few km). */
export function pathPoints(a: { lat: number; lon: number }, b: { lat: number; lon: number }, n: number) {
  return Array.from({ length: n + 1 }, (_, i) => ({ lat: a.lat + ((b.lat - a.lat) * i) / n, lon: a.lon + ((b.lon - a.lon) * i) / n, f: i / n }));
}
