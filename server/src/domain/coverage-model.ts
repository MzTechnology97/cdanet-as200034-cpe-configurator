import { bearingDeg, distanceM, type LatLon } from './geo.ts';

/**
 * Coverage of an AP learned from its customers: where the connected CPEs are (served sector,
 * reach) and what signal they get. Used to estimate the signal of a new CPE at a point.
 * Customer positions never leave the server: only the estimate does.
 */

export interface ClientSample {
  lat: number;
  lon: number;
  /** Signal at the CPE, dBm (null when UISP does not report it). */
  signal: number | null;
}

interface Sample {
  d: number;
  b: number;
  s: number | null;
}

export interface ApModel {
  samples: Sample[];
  /** Arc containing every customer (center and width, degrees from the AP); null with < 2 customers. */
  sector: { center: number; width: number } | null;
  /** 90th percentile of the customers' distance. */
  servedM: number | null;
  /** Log-distance fit: signal = a − 10·n·log10(d). */
  fit: { a: number; n: number; rmse: number; from: number } | null;
}

export interface SignalEstimate {
  signalDbm: number | null;
  low: number | null;
  high: number | null;
  /** Inside the arc where the AP already has customers (null = not enough customers to tell). */
  inSector: boolean | null;
  /** Farther than the customers already served. */
  beyondServed: boolean;
  confidence: 'alta' | 'media' | 'bassa';
  /** Customers the estimate is based on (hidden from installers unless allowed). */
  basis: number | null;
  /** Customers with a signal within ~500 m of the point and the same direction from the AP. */
  nearby: number;
}

const angleDiff = (a: number, b: number) => {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
};

/** Smallest arc containing all the bearings. */
export function servedArc(bearings: number[]): { center: number; width: number } | null {
  if (bearings.length < 2) return null;
  const b = [...bearings].map((x) => ((x % 360) + 360) % 360).sort((x, y) => x - y);
  let gap = 360 - b[b.length - 1]! + b[0]!;
  let start = b[0]!;
  for (let i = 1; i < b.length; i++) {
    const g = b[i]! - b[i - 1]!;
    if (g > gap) {
      gap = g;
      start = b[i]!;
    }
  }
  const width = Math.max(20, 360 - gap);
  return { center: Math.round((start + (360 - gap) / 2) % 360), width: Math.round(width) };
}

/** Horizontal beamwidth from the AP model name (LAP-120 → 120°, PrismAP-5-45 → 45°…); 90° otherwise. */
export function sectorWidth(model: string | null | undefined): number {
  const m = /(?:^|[^0-9])(30|45|60|90|120)(?:[^0-9]|$)/.exec(model ?? '');
  return m ? Number(m[1]) : 90;
}

/** [heading]: the antenna azimuth set in UISP, used instead of the arc guessed from the customers. */
export function buildApModel(ap: LatLon, clients: ClientSample[], heading: { center: number; width: number } | null = null): ApModel {
  const samples = clients.map((c) => ({ d: Math.max(30, distanceM(ap, c)), b: bearingDeg(ap, c), s: c.signal }));
  const ds = samples.map((s) => s.d).sort((a, b) => a - b);
  const servedM = ds.length ? Math.round(ds[Math.min(ds.length - 1, Math.floor(ds.length * 0.9))]!) : null;
  const sig = samples.filter((s): s is Sample & { s: number } => s.s !== null && s.s < 0 && s.s > -100);
  let fit: ApModel['fit'] = null;
  if (sig.length) {
    const x = sig.map((s) => -10 * Math.log10(s.d));
    const y = sig.map((s) => s.s);
    const mx = x.reduce((a, b) => a + b, 0) / x.length;
    const my = y.reduce((a, b) => a + b, 0) / y.length;
    const sxx = x.reduce((a, v) => a + (v - mx) ** 2, 0);
    let n = sig.length >= 3 && sxx > 1 ? x.reduce((a, v, i) => a + (v - mx) * (y[i]! - my), 0) / sxx : 2.2;
    if (!(n >= 1.6 && n <= 4.5)) n = 2.2; // implausible slope (few or clustered customers): free-space-like
    const a = my - n * mx;
    const rmse = Math.sqrt(sig.reduce((acc, s, i) => acc + (s.s - (a + n * x[i]!)) ** 2, 0) / sig.length);
    fit = { a, n, rmse: Math.max(3, rmse), from: sig.length };
  }
  return { samples, sector: heading ?? servedArc(samples.map((s) => s.b)), servedM, fit };
}

/** Expected signal of a CPE at distance [d] and bearing [b] from the AP. */
export function estimateSignal(m: ApModel, d: number, b: number): SignalEstimate {
  const inSector = m.sector ? angleDiff(b, m.sector.center) <= m.sector.width / 2 + 10 : null;
  const beyondServed = m.servedM !== null && m.samples.length >= 3 && d > m.servedM * 1.2;
  if (!m.fit) return { signalDbm: null, low: null, high: null, inSector, beyondServed, confidence: 'bassa', basis: m.samples.length, nearby: 0 };
  const dist = Math.max(30, d);
  const pred = (x: number) => m.fit!.a - 10 * m.fit!.n * Math.log10(x);
  let est = pred(dist);
  // local correction: residuals of the customers near the point (same direction, similar distance)
  let wsum = 0;
  let rsum = 0;
  let nearby = 0;
  for (const s of m.samples) {
    if (s.s === null) continue;
    const gap = Math.sqrt(dist * dist + s.d * s.d - 2 * dist * s.d * Math.cos(((b - s.b) * Math.PI) / 180));
    if (gap > 1500) continue;
    if (gap <= 500) nearby++;
    const w = 1 / (gap + 100) ** 2;
    wsum += w;
    rsum += w * (s.s - pred(s.d));
  }
  if (wsum > 0) est += rsum / wsum;
  let spread = nearby >= 2 ? Math.min(m.fit.rmse, 4) : m.fit.rmse + 2;
  if (inSector === false) {
    est -= 10; // outside the arc already served: antenna pattern unknown
    spread += 6;
  }
  if (beyondServed) spread += 3;
  const confidence = inSector !== false && !beyondServed && m.fit.from >= 5 && nearby >= 1 ? 'alta' : inSector !== false && m.fit.from >= 3 ? 'media' : 'bassa';
  return {
    signalDbm: Math.round(est),
    low: Math.round(est - spread),
    high: Math.round(Math.min(-30, est + spread)),
    inSector,
    beyondServed,
    confidence,
    basis: m.samples.length,
    nearby,
  };
}

/** How promising an AP is for a new CPE at the checked point. */
export type CoverageRating = 'buono' | 'possibile' | 'senza stima' | 'improbabile' | 'non attivo';

const RATING_ORDER: Record<CoverageRating, number> = { buono: 0, possibile: 1, 'senza stima': 2, improbabile: 3, 'non attivo': 4 };

/** Rating of one AP: [minDbm] is the minimum signal accepted at the acceptance test. */
type Estimated = Pick<SignalEstimate, 'signalDbm' | 'high' | 'inSector'>;

export function rateCoverage(status: string, e: Estimated | null, minDbm: number): CoverageRating {
  if (status !== 'active') return 'non attivo';
  if (!e || e.signalDbm === null) return 'senza stima';
  if (e.high !== null && e.high < minDbm) return 'improbabile'; // not even the optimistic bound is enough
  return e.signalDbm >= minDbm && e.inSector !== false ? 'buono' : 'possibile';
}

/**
 * Every AP within range, best first: likely good ones by estimated signal, then the possible ones,
 * those without an estimate (by distance) and last the unlikely and the inactive ones. The limit is
 * applied after this, so a good AP a bit farther away is not hidden by closer, worse ones.
 */
export function rankCoverage<T extends { distanceM: number; status: string; estimate: Estimated | null }>(aps: T[], minDbm: number): Array<T & { rating: CoverageRating }> {
  return aps
    .map((a) => ({ ...a, rating: rateCoverage(a.status, a.estimate, minDbm) }))
    .sort((a, b) => RATING_ORDER[a.rating] - RATING_ORDER[b.rating] || (b.estimate?.signalDbm ?? -999) - (a.estimate?.signalDbm ?? -999) || a.distanceM - b.distanceM);
}
