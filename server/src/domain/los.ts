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

/** Diffraction loss (dB) of a single knife edge with parameter ν (ITU-R P.526, approximation). */
export function knifeEdgeLossDb(nu: number): number {
  if (nu <= -0.78) return 0;
  return 6.9 + 20 * Math.log10(Math.sqrt((nu - 0.1) ** 2 + 1) + nu - 0.1);
}

/**
 * Loss (dB) caused by the terrain between two antennas: Deygout method (the main edge, then the
 * main edge of each side, ITU-R P.526) over the profile with earth curvature. 0 when the path and
 * 60% of the Fresnel zone are clear; a few dB when a hill only enters the Fresnel zone; tens of dB
 * when a ridge hides the AP. Terrain only, as for the line of sight.
 */
export function diffractionLossDb(profile: ProfilePoint[], fromAltitude: number, toAltitude: number, freqMHz = 5600): number {
  if (profile.length < 3) return 0;
  const lambda = 299.792458 / freqMHz;
  const edge = (i0: number, i1: number, h0: number, h1: number) => {
    let best: { i: number; nu: number } | null = null;
    const a = profile[i0]!.d;
    const span = profile[i1]!.d - a;
    if (span <= 0) return null;
    for (let i = i0 + 1; i < i1; i++) {
      const d1 = profile[i]!.d - a;
      const d2 = span - d1;
      if (d1 <= 0 || d2 <= 0) continue;
      const h = profile[i]!.ground + (d1 * d2) / (2 * R_EFF) - (h0 + ((h1 - h0) * d1) / span);
      const nu = h * Math.sqrt((2 * span) / (lambda * d1 * d2));
      if (!best || nu > best.nu) best = { i, nu };
    }
    return best;
  };
  const deygout = (i0: number, i1: number, h0: number, h1: number, depth: number): number => {
    const e = edge(i0, i1, h0, h1);
    if (!e || e.nu <= -0.78) return 0;
    let loss = knifeEdgeLossDb(e.nu);
    if (depth > 0) {
      const top = profile[e.i]!.ground;
      loss += deygout(i0, e.i, h0, top, depth - 1) + deygout(e.i, i1, top, h1, depth - 1);
    }
    return loss;
  };
  return Math.round(Math.min(60, deygout(0, profile.length - 1, fromAltitude, toAltitude, 1)) * 10) / 10;
}

/**
 * Altitude of the AP antenna, metres a.s.l. UISP's location.altitude is the GPS altitude on GPS
 * APs; on the others it holds small values (a height above the ground typed in UISP). Otherwise:
 * terrain + antenna height (site height in UISP, else the admin default). Pure, unit-tested.
 */
export function resolveApAltitude(reported: number | null, ground: number | null, height: number): { altitude: number | null; from: 'gps' | 'uisp' | 'terreno' | null } {
  if (reported !== null) {
    // GPS altitude: kept, but never under the ground + 5 m (the vertical GPS error is ±15 m: an
    // antenna "inside" the hill it stands on would hide every customer)
    if (ground !== null ? reported >= ground - 30 : reported >= 100) return { altitude: ground !== null ? Math.max(reported, ground + 5) : reported, from: 'gps' };
    if (ground !== null && reported >= 0 && reported < 100) return { altitude: ground + reported, from: 'uisp' };
  }
  return ground === null ? { altitude: null, from: null } : { altitude: ground + height, from: 'terreno' };
}
