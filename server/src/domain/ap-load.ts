/**
 * Load of an AP and capacity of a new link, from the UISP data of the real network: the evening
 * peak of the traffic of all its CPEs, the airtime, noise and SNR of its stations, and the curve
 * "signal at the CPE → link capacity" learned from the CPEs already connected. Pure, unit-tested.
 */

export interface Point {
  x: number;
  y: number;
}

/** Evening hours (local time) when the traffic peaks. */
export const EVENING = { from: 20, to: 23, timeZone: 'Europe/Rome' } as const;

const hourIn = (fmt: Intl.DateTimeFormat, ms: number) => Number(fmt.formatToParts(new Date(ms)).find((p) => p.type === 'hour')!.value) % 24;
const dayIn = (fmt: Intl.DateTimeFormat, ms: number) => fmt.formatToParts(new Date(ms)).filter((p) => p.type !== 'hour' && p.type !== 'literal').map((p) => p.value).join('-');

/**
 * Average over the days of the highest value between [EVENING.from] and [EVENING.to] (local time)
 * of an hourly series: "how busy is it in the evening, typically". null without evening samples.
 */
export function eveningPeak(series: Point[] | null | undefined): number | null {
  if (!series?.length) return null;
  const fmt = new Intl.DateTimeFormat('it-IT', { timeZone: EVENING.timeZone, hour: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' });
  const perDay = new Map<string, number>();
  for (const p of series) {
    if (typeof p?.y !== 'number' || !Number.isFinite(p.y)) continue;
    const h = hourIn(fmt, p.x);
    if (h < EVENING.from || h >= EVENING.to) continue;
    const d = dayIn(fmt, p.x);
    perDay.set(d, Math.max(perDay.get(d) ?? -Infinity, p.y));
  }
  if (!perDay.size) return null;
  return [...perDay.values()].reduce((a, b) => a + b, 0) / perDay.size;
}

const median = (v: number[]) => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const k = Math.floor(s.length / 2);
  return s.length % 2 ? s[k]! : (s[k - 1]! + s[k]!) / 2;
};
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const avgSeries = (o: unknown): Point[] => {
  const a = (o as { avg?: unknown } | null)?.avg;
  return Array.isArray(a) ? (a as Point[]) : [];
};

export type LoadLevel = 'libero' | 'medio' | 'carico';

export interface ApLoad {
  at: string;
  /** CPEs connected now. */
  stations: number | null;
  /** Average airtime used by one CPE, %. */
  cpeAirtimePct: number | null;
  /** Airtime of the AP at the evening peak (typical day), %. */
  eveningAirtimePct: number | null;
  /** Downlink utilization of the channel at the evening peak, %. */
  eveningUtilizationPct: number | null;
  /** Traffic of all the CPEs together (towards them) at the evening peak, Mbit/s. */
  eveningPeakMbps: number | null;
  /** Downlink capacity of the AP now, Mbit/s. */
  capacityMbps: number | null;
  noiseDbm: number | null;
  /** Median SNR of the CPEs (signal received by the AP − noise floor), dB. */
  snrDb: number | null;
  channelWidthMhz: number | null;
  level: LoadLevel | null;
}

/** Thresholds of the evening airtime / utilization: up to "medio", then "carico". */
export const LOAD_THRESHOLDS = { medium: 40, high: 70 };

export function loadLevel(airtimePct: number | null, utilizationPct: number | null): LoadLevel | null {
  const v = Math.max(airtimePct ?? -1, utilizationPct ?? -1);
  if (v < 0) return null;
  return v >= LOAD_THRESHOLDS.high ? 'carico' : v >= LOAD_THRESHOLDS.medium ? 'medio' : 'libero';
}

/** Load of an AP from its UISP week statistics and its stations list (either may be missing). */
export function summarizeLoad(stats: Record<string, unknown> | null, stations: unknown[] | null, ap: { dlCapacityMbps: number | null; stations: number | null }, now = new Date()): ApLoad {
  const st = (stations ?? []) as Array<Record<string, unknown>>;
  const connected = st.filter((s) => s.connected !== false);
  const pct = (v: number | null) => (v === null ? null : Math.round(v * 1000) / 10);
  // the radio interface: its "transmit" is the traffic towards all the CPEs
  const ifaces = (Array.isArray(stats?.interfaces) ? stats!.interfaces : []) as Array<Record<string, unknown>>;
  const radio = ifaces.find((i) => /ghz|wlan|ath|main|wireless|radio/i.test(String(i.name ?? ''))) ?? null;
  const peak = radio ? eveningPeak(avgSeries(radio.transmit)) : null;
  const airtime = pct(eveningPeak(avgSeries(stats?.airTime)));
  const util = pct(eveningPeak(avgSeries(stats?.downlinkUtilization)));
  const snr = median(connected.map((s) => (num(s.rxSignal) !== null && num(s.noiseFloor) !== null ? num(s.rxSignal)! - num(s.noiseFloor)! : null)).filter((v): v is number => v !== null));
  const width = num((stats?.frequency as Record<string, unknown> | undefined)?.channelWidth);
  return {
    at: now.toISOString(),
    stations: stations ? connected.length : ap.stations,
    cpeAirtimePct: pct(median(connected.map((s) => num((s.statistics as Record<string, unknown> | undefined)?.airTime)).filter((v): v is number => v !== null))),
    eveningAirtimePct: airtime,
    eveningUtilizationPct: util,
    eveningPeakMbps: peak === null ? null : Math.round(peak / 100_000) / 10,
    capacityMbps: ap.dlCapacityMbps,
    noiseDbm: median(connected.map((s) => num(s.noiseFloor)).filter((v): v is number => v !== null)),
    snrDb: snr === null ? null : Math.round(snr),
    channelWidthMhz: width,
    level: loadLevel(airtime, util),
  };
}

// ---- capacity of a new link ------------------------------------------------------------------

export interface CapacitySample {
  /** Signal at the CPE, dBm (the same quantity the coverage model estimates). */
  signal: number;
  /** Downlink capacity of the link, Mbit/s. */
  capMbps: number;
  /** Channel width of the AP, MHz. */
  widthMhz: number;
}

/** Curve "signal → capacity per MHz of channel", in 2 dB steps from −90 to −40 dBm, never decreasing. */
export interface CapacityCurve {
  from: number;
  step: number;
  /** Mbit/s per MHz at each step. */
  perMhz: number[];
  samples: number;
}

/** Capacity curve of the network from the CPEs connected: median per 2 dB, then monotonic. null with few samples. */
export function capacityCurve(samples: CapacitySample[]): CapacityCurve | null {
  const ok = samples.filter((s) => s.signal >= -95 && s.signal <= -30 && s.capMbps > 0 && s.widthMhz > 0);
  if (ok.length < 20) return null;
  const from = -90;
  const step = 2;
  const n = 26;
  const buckets: number[][] = Array.from({ length: n }, () => []);
  for (const s of ok) buckets[Math.min(n - 1, Math.max(0, Math.round((s.signal - from) / step)))]!.push(s.capMbps / s.widthMhz);
  let med: Array<number | null> = buckets.map((b) => (b.length >= 3 ? median(b) : null));
  // fill the gaps by interpolation, the ends with the nearest value
  const known = med.map((v, i) => (v === null ? -1 : i)).filter((i) => i >= 0);
  if (known.length < 2) return null;
  med = med.map((v, i) => {
    if (v !== null) return v;
    const lo = [...known].reverse().find((k) => k < i);
    const hi = known.find((k) => k > i);
    if (lo === undefined) return med[hi!]!;
    if (hi === undefined) return med[lo]!;
    return med[lo]! + ((med[hi]! - med[lo]!) * (i - lo)) / (hi - lo);
  });
  // a stronger signal never gives less capacity
  const perMhz: number[] = [];
  for (const v of med as number[]) perMhz.push(Math.max(v, perMhz[perMhz.length - 1] ?? 0));
  return { from, step, perMhz: perMhz.map((v) => Math.round(v * 1000) / 1000), samples: ok.length };
}

/** Expected downlink capacity at [signal] on a channel of [widthMhz], times the AP's own [factor]. */
export function capacityAt(c: CapacityCurve, signal: number, widthMhz: number, factor = 1): number {
  const x = (signal - c.from) / c.step;
  const i = Math.min(c.perMhz.length - 2, Math.max(0, Math.floor(x)));
  const f = Math.min(1, Math.max(0, x - i));
  const v = c.perMhz[i]! + (c.perMhz[i + 1]! - c.perMhz[i]!) * f;
  return Math.round(v * widthMhz * factor);
}

/** How an AP does compared with the network curve (its CPEs' capacity / curve), 0.5–2; 1 with few CPEs. */
export function apCapacityFactor(c: CapacityCurve, own: CapacitySample[]): number {
  const r = own.filter((s) => s.capMbps > 0).map((s) => s.capMbps / Math.max(1, capacityAt(c, s.signal, s.widthMhz)));
  if (r.length < 3) return 1;
  return Math.min(2, Math.max(0.5, Math.round(median(r)! * 100) / 100));
}
