import { bearingDeg, distanceM, type LatLon } from './geo.ts';

/**
 * Expected signal of a new CPE at a point, for Copertura, AP vicini and the radio simulation.
 *
 * Physics first: power radiated by the AP (EIRP) + CPE antenna gain − free-space loss at the AP
 * frequency − the antenna pattern (when UISP has the azimuth) − the terrain between the point and
 * the AP (diffraction over the hills, from the elevation model). Two calibrations on top:
 * - the network: how much the real customers of all the APs get above or below that theory (the
 *   EIRP and gains of the settings are rarely exact), a robust median over the APs;
 * - the AP: how this one does compared with the network (and how the signal falls with distance
 *   when there are enough customers), with a weight that grows with their number: one customer
 *   cannot move the estimate by 20 dB any more.
 *
 * Customer positions never leave the server: only the estimate does.
 */

/** Farthest link worth considering: CPEs hooked beyond 15 km are rare, beyond 20 km unrealistic. */
export const MAX_LINK_M = 20_000;
/** Closer than this to the AP the CPE position is the AP's or the site's, not the customer's. */
const MIN_SAMPLE_M = 50;

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
  /** Customers left out: on the AP itself (at the POP) or beyond 20 km: they say nothing about a new point. */
  ignored: number;
  /** Antenna sector: azimuth from UISP (with the beamwidth of the model) or the arc of the customers. */
  sector: { center: number; width: number } | null;
  /** The sector is the real antenna (azimuth in UISP), not guessed from the customers. */
  antenna: boolean;
  /** 90th percentile of the customers' distance. */
  servedM: number | null;
  /** Calibration of the whole network over the theory, dB (the same for every AP). */
  prior: number;
  /** Calibration from the AP's customers with a signal: offset from theory + network, slope, spread. */
  fit: { offset: number; n: number; rmse: number; from: number } | null;
}

/** Terrain between the point and the AP (elevation model): verdict of the line of sight and loss. */
export interface TerrainEffect {
  verdict: 'clear' | 'fresnel' | 'blocked';
  lossDb: number;
  /** Metres of the line of sight inside tree crowns (land cover), and their share of [lossDb]. */
  foliageM?: number;
  foliageDb?: number;
  /** Buildings (land cover) are what blocks or enters the Fresnel zone, not the bare ground. */
  buildings?: boolean;
}

export interface SignalEstimate {
  signalDbm: number | null;
  low: number | null;
  high: number | null;
  /** Inside the antenna sector (or the arc already served); null = direction unknown. */
  inSector: boolean | null;
  /** Farther than the customers already served. */
  beyondServed: boolean;
  /** Beyond the farthest realistic link (MAX_LINK_M). */
  tooFar: boolean;
  confidence: 'alta' | 'media' | 'bassa';
  /** Customers the estimate is based on (hidden from installers unless allowed). */
  basis: number | null;
  /** Customers with a signal within ~500 m of the point and the same direction from the AP. */
  nearby: number | null;
  /** No customers to calibrate with: theory only (less accurate). */
  theoretical?: boolean;
  /** Terrain considered (null: elevation model not available). */
  terrain: TerrainEffect | null;
}

/** Radio parameters (Impostazioni server → Simulazione radio). */
export interface RadioDefaults {
  /** Power radiated by the AP towards the customers (EIRP), dBm. */
  eirpDbm: number;
  /** Gain of the customer's CPE antenna, dBi. */
  cpeGainDbi: number;
}

/** Losses of a real link not in free space (cables, polarisation, a little fading), dB. */
const REAL_LOSS_DB = 4;
/** Outside the arc already served when the antenna azimuth is unknown, dB. */
const OFF_ARC_DB = 10;
/** Uncertainty of the theory alone, dB. */
const THEORY_SPREAD_DB = 8;
/** How far an AP's customers may move it from the network calibration. */
const OFFSET_MIN_DB = -15;
const OFFSET_MAX_DB = 8;
/** Limits of the network calibration (settings far off: better fix them in Impostazioni server). */
const PRIOR_MIN_DB = -10;
const PRIOR_MAX_DB = 15;

const angleDiff = (a: number, b: number) => {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
};

/** Free-space path loss, dB (distance in metres, frequency in MHz). */
export function freeSpaceLossDb(d: number, freqMHz: number | null): number {
  const f = freqMHz && freqMHz > 1000 ? freqMHz : 5600;
  return 20 * Math.log10(Math.max(30, d) / 1000) + 20 * Math.log10(f) + 32.44;
}

/** Sector antenna pattern (3GPP-like): 3 dB at the edge of the beam, at most 25 dB behind. */
export function patternLossDb(b: number, sector: { center: number; width: number }): number {
  return Math.min(25, 12 * (angleDiff(b, sector.center) / sector.width) ** 2);
}

/** Antenna gain towards bearing [b], dB (0 = main lobe), and whether [b] is inside the sector. */
function direction(m: Pick<ApModel, 'sector' | 'antenna'>, b: number): { lossDb: number; inSector: boolean | null } {
  if (!m.sector) return { lossDb: 0, inSector: null };
  const inSector = angleDiff(b, m.sector.center) <= m.sector.width / 2 + 10;
  if (m.antenna) return { lossDb: patternLossDb(b, m.sector), inSector };
  // arc guessed from the customers: the antenna may be wider, a softer penalty outside it
  return { lossDb: inSector ? 0 : OFF_ARC_DB, inSector };
}

/** Theory at [d] m: EIRP + CPE gain − free space − real losses (no pattern, no terrain). */
const theory = (d: number, freqMHz: number | null, r: RadioDefaults) => r.eirpDbm + r.cpeGainDbi - REAL_LOSS_DB - freeSpaceLossDb(d, freqMHz);

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

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const k = Math.floor(s.length / 2);
  return s.length % 2 ? s[k]! : (s[k - 1]! + s[k]!) / 2;
};

/** The customers of one AP as the model uses them: plausible positions only. */
function samplesOf(ap: LatLon, clients: ClientSample[]) {
  const all = clients.map((c) => ({ d: distanceM(ap, c), b: bearingDeg(ap, c), s: c.signal }));
  // a CPE at the AP itself (at the POP) or beyond 20 km says nothing about the coverage of a new point
  return { all, samples: all.filter((s) => s.d >= MIN_SAMPLE_M && s.d <= MAX_LINK_M) };
}

const withSignal = (samples: Sample[]) => samples.filter((s): s is Sample & { s: number } => s.s !== null && s.s < -20 && s.s > -100);

/**
 * Calibration of the network: median, over the APs with at least 3 customers with a signal, of how
 * much those customers get above (+) or below (−) the theory of the settings. null with fewer than
 * 3 such APs. Robust: an AP with misplaced customers or a wrong azimuth weighs like any other one.
 */
export function networkCalibrationDb(
  aps: Array<{ ap: LatLon; clients: ClientSample[]; heading: { center: number; width: number } | null; freqMHz: number | null }>,
  r: RadioDefaults,
): number | null {
  const offsets: number[] = [];
  for (const a of aps) {
    const { samples } = samplesOf(a.ap, a.clients);
    const sig = withSignal(samples);
    if (sig.length < 3) continue;
    const dir = { sector: a.heading ?? servedArc(samples.map((s) => s.b)), antenna: a.heading !== null };
    offsets.push(median(sig.map((s) => s.s - theory(s.d, a.freqMHz, r) + direction(dir, s.b).lossDb)));
  }
  if (offsets.length < 3) return null;
  return Math.round(Math.min(PRIOR_MAX_DB, Math.max(PRIOR_MIN_DB, median(offsets))) * 2) / 2;
}

/**
 * Model of one AP from its customers. [heading]: antenna azimuth set in UISP (real sector).
 * [freqMHz] and [r]: the theory the customers are compared with; [priorDb]: network calibration.
 */
export function buildApModel(
  ap: LatLon,
  clients: ClientSample[],
  heading: { center: number; width: number } | null = null,
  freqMHz: number | null = null,
  r: RadioDefaults = { eirpDbm: 30, cpeGainDbi: 23 },
  priorDb = 0,
): ApModel {
  const { all, samples } = samplesOf(ap, clients);
  const ds = samples.map((s) => s.d).sort((a, b) => a - b);
  const servedM = ds.length ? Math.round(ds[Math.min(ds.length - 1, Math.floor(ds.length * 0.9))]!) : null;
  const sector = heading ?? servedArc(samples.map((s) => s.b));
  const m: ApModel = { samples, ignored: all.length - samples.length, sector, antenna: heading !== null, servedM, prior: priorDb, fit: null };
  const sig = withSignal(samples);
  if (!sig.length) return m;
  // y = what the customer gets beyond theory + network at 1 km (pattern included), x = −10·log10(d / 1 km)
  const x = sig.map((s) => -10 * Math.log10(s.d / 1000));
  const y = sig.map((s) => s.s - theory(1000, freqMHz, r) - priorDb + direction(m, s.b).lossDb);
  let n = 2;
  const mx = x.reduce((a, v) => a + v, 0) / x.length;
  const sxx = x.reduce((a, v) => a + (v - mx) ** 2, 0);
  // the slope is learned only from many customers spread in distance; else free space (n = 2)
  if (sig.length >= 6 && sxx > 0.5 * sig.length) {
    const my = y.reduce((a, v) => a + v, 0) / y.length;
    n = Math.min(3.5, Math.max(2, x.reduce((a, v, i) => a + (v - mx) * (y[i]! - my), 0) / sxx));
  }
  const res = y.map((v, i) => v - n * x[i]!);
  const raw = sig.length >= 3 ? median(res) : res.reduce((a, v) => a + v, 0) / res.length;
  // few customers: their offset counts less (one customer → half), and never beyond the limits
  const offset = Math.min(OFFSET_MAX_DB, Math.max(OFFSET_MIN_DB, raw)) * (sig.length / (sig.length + 1));
  const rmse = Math.sqrt(res.reduce((a, v) => a + (v - offset) ** 2, 0) / res.length);
  m.fit = { offset, n, rmse: Math.max(3, rmse), from: sig.length };
  return m;
}

/**
 * Expected signal at [d] m and bearing [b] (from the AP towards the point). [terrain]: loss over
 * the profile between the point and the AP (null: elevation model not available).
 */
export function estimateAt(m: ApModel, d: number, b: number, freqMHz: number | null, r: RadioDefaults, terrain: TerrainEffect | null = null): SignalEstimate {
  const dist = Math.max(30, d);
  const dir = direction(m, b);
  const tooFar = d > MAX_LINK_M;
  const terrainDb = terrain?.lossDb ?? 0;
  const base = theory(1000, freqMHz, r) + m.prior - dir.lossDb - terrainDb;
  const fit = m.fit;
  const n = fit?.n ?? 2;
  const pred = (x: number) => base + (fit?.offset ?? 0) - 10 * n * Math.log10(Math.max(30, x) / 1000);
  let est = pred(dist);
  let nearby = 0;
  let spread = THEORY_SPREAD_DB;
  if (fit) {
    // local correction: customers near the point (same direction, similar distance) that do
    // better or worse than the calibrated model
    let wsum = 0;
    let rsum = 0;
    let close = 0;
    for (const s of m.samples) {
      if (s.s === null || s.s >= -20 || s.s <= -100) continue;
      const gap = Math.sqrt(dist * dist + s.d * s.d - 2 * dist * s.d * Math.cos(((b - s.b) * Math.PI) / 180));
      if (gap > 1500) continue;
      close++;
      if (gap <= 500) nearby++;
      const w = 1 / (gap + 100) ** 2;
      wsum += w;
      // the customer's own residual: its signal against the model at its place (no terrain known there)
      rsum += w * (s.s - (theory(1000, freqMHz, r) + m.prior - direction(m, s.b).lossDb + fit.offset - 10 * n * Math.log10(s.d / 1000)));
    }
    if (wsum > 0) est += (rsum / wsum) * Math.min(1, close / 2);
    spread = nearby >= 2 ? Math.min(fit.rmse, 4) : Math.min(THEORY_SPREAD_DB, fit.rmse + 6 / Math.sqrt(fit.from));
  }
  const beyondServed = m.servedM !== null && m.samples.length >= 3 && d > m.servedM * 1.2;
  if (dir.inSector === false) spread += m.antenna ? 3 : 6;
  if (beyondServed) spread += 2;
  if (!terrain && d > 1500) spread += 2; // hills not checked
  if (terrain && terrain.verdict !== 'clear') spread += 2;
  // a hill in the way: real customers show the profile is sometimes wrong (position of the CPE in
  // UISP, real heights), so the optimistic bound keeps part of the loss: a small obstruction stays
  // "possibile, verifica sul posto", a ridge like the one hiding a whole valley stays unlikely
  const blocked = terrain?.verdict === 'blocked';
  const upside = blocked ? Math.min(terrain.lossDb, 20) / 2 : 0;
  const from = fit?.from ?? 0;
  const confidence =
    dir.inSector !== false && !beyondServed && !tooFar && terrain !== null && !blocked && from >= 5 && nearby >= 1
      ? 'alta'
      : dir.inSector !== false && !tooFar && !blocked && from >= 3
        ? 'media'
        : 'bassa';
  return {
    signalDbm: Math.round(est),
    low: Math.round(est - spread),
    high: Math.round(Math.min(-30, est + spread + upside)),
    inSector: dir.inSector,
    beyondServed,
    tooFar,
    confidence,
    basis: m.samples.length,
    nearby,
    ...(fit ? {} : { theoretical: true }),
    terrain,
  };
}

/** Kept for the callers that only have the theory (an AP without a model). */
export function theoreticalSignal(m: Pick<ApModel, 'sector'> & Partial<Pick<ApModel, 'antenna'>>, d: number, b: number, freqMHz: number | null, r: RadioDefaults, terrain: TerrainEffect | null = null): SignalEstimate {
  return estimateAt({ samples: [], ignored: 0, sector: m.sector, antenna: m.antenna ?? m.sector !== null, servedM: null, prior: 0, fit: null }, d, b, freqMHz, r, terrain);
}

/** How promising an AP is for a new CPE at the checked point. */
export type CoverageRating = 'buono' | 'possibile' | 'senza stima' | 'improbabile' | 'non attivo';

const RATING_ORDER: Record<CoverageRating, number> = { buono: 0, possibile: 1, 'senza stima': 2, improbabile: 3, 'non attivo': 4 };

/** Rating of one AP: [minDbm] is the minimum signal accepted at the acceptance test. */
type Estimated = Pick<SignalEstimate, 'signalDbm' | 'high' | 'inSector' | 'theoretical'> & Partial<Pick<SignalEstimate, 'tooFar' | 'terrain'>>;

export function rateCoverage(status: string, e: Estimated | null, minDbm: number): CoverageRating {
  if (status !== 'active') return 'non attivo';
  if (!e || e.signalDbm === null) return 'senza stima';
  if (e.tooFar) return 'improbabile'; // beyond any real link
  if (e.high !== null && e.high < minDbm) return 'improbabile'; // not even the optimistic bound is enough
  if (e.theoretical) return 'possibile'; // theory only: never more than "to be checked"
  if (e.terrain?.verdict === 'blocked') return 'possibile'; // a hill in the way: check on site
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
