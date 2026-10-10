/**
 * IA-AP automatic optimisation (pure part): the airMAX wireless configuration with another channel,
 * whether the CPEs can follow, the link metrics read from the AP's stations and the before/after
 * comparison that decides whether a channel is kept.
 */

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The channel of an AP: what is changed and restored (never the rest of the configuration). */
export interface Channel {
  centre: number;
  width: number;
  /** Control frequency for the radio (from the regulatory table; the centre for 20 MHz). */
  control: number;
  ieeeMode: string | null;
}

/** The channel currently set in an airMAX wireless configuration (null when unreadable). */
export function channelOf(config: unknown): Channel | null {
  const c = obj(config);
  const centre = num(c.centerFrequency);
  const width = num(c.channelWidth);
  if (centre === null || width === null) return null;
  return { centre, width, control: num(c.controlFrequency) ?? centre, ieeeMode: typeof c.ieeeModeString === 'string' ? c.ieeeModeString : null };
}

/** The row of the radio's regulatory table for [centre]/[width]: the channel exists and is allowed. */
export function regulatoryEntry(config: unknown, centre: number, width: number): { control: number } | null {
  for (const r of arr(obj(config).regulatoryDomainChannels)) {
    const e = obj(r);
    if (num(e.centerFrequency) === centre && num(e.channelWidth) === width) return { control: num(e.controlFrequency) ?? centre };
  }
  return null;
}

/** "11acvht20" → "11acvht40": the IEEE mode follows the width (ht and vht modes only). */
export function ieeeModeFor(mode: string | null, width: number): string | null {
  if (!mode) return null;
  return /(ht)(\d+)$/i.test(mode) ? mode.replace(/(ht)(\d+)$/i, `$1${width}`) : mode;
}

/**
 * The configuration as read from UISP with only the channel changed: centre, control frequency,
 * width and IEEE mode; automatic width off. Throws when the radio does not offer the channel.
 */
export function configWithChannel(config: unknown, centre: number, width: number): Record<string, unknown> {
  const c = { ...obj(config) };
  const widths = arr(obj(obj(c.boardInfo).radio1).channelWidthList).map(num).filter((x): x is number => x !== null);
  if (widths.length && !widths.includes(width)) throw new Error(`Larghezza ${width} MHz non supportata dalla radio (${widths.join(', ')})`);
  const entry = regulatoryEntry(config, centre, width);
  if (!entry) throw new Error(`Canale ${centre}/${width} MHz non presente nella tabella dei canali della radio`);
  c.centerFrequency = centre;
  c.controlFrequency = entry.control;
  c.channelWidth = width;
  c.isAutoChannelWidthEnabled = false;
  const mode = ieeeModeFor(typeof c.ieeeModeString === 'string' ? c.ieeeModeString : null, width);
  if (mode) c.ieeeModeString = mode;
  return c;
}

/** The configuration with the original channel back (restore). */
export function configWithOriginal(config: unknown, ch: Channel): Record<string, unknown> {
  const c = { ...obj(config) };
  c.centerFrequency = ch.centre;
  c.controlFrequency = ch.control;
  c.channelWidth = ch.width;
  if (ch.ieeeMode) c.ieeeModeString = ch.ieeeMode;
  return c;
}

/**
 * Whether a CPE can find the AP on [centre]/[width]: a CPE with a frequency list (scan list) only
 * looks there; an empty list scans every channel of the radio.
 */
export function cpeFollows(cpeConfig: unknown, centre: number, width: number): boolean {
  const allowed = arr(obj(cpeConfig).allowedFrequencies).map(num).filter((x): x is number => x !== null);
  if (!allowed.length) return true;
  return allowed.some((f) => Math.abs(f - centre) <= width / 2);
}

/** One CPE as the AP sees it. */
export interface LinkSample {
  mac: string;
  /** UISP id of the CPE (null when UISP does not know it). */
  id: string | null;
  name: string;
  signal: number | null;
  noise: number | null;
  capMbps: number | null;
  mcs: number | null;
}

/** The connected stations of an AP (UISP /devices/airmaxes/{id}/stations), by MAC. */
export function linkSamples(stations: unknown[] | null): Map<string, LinkSample> {
  const out = new Map<string, LinkSample>();
  for (const raw of stations ?? []) {
    const s = obj(raw);
    if (s.connected === false) continue;
    const mac = typeof s.mac === 'string' ? s.mac.toLowerCase() : null;
    if (!mac) continue;
    const cap = num(s.downlinkCapacity);
    const rx = num(s.rxMcsIndex);
    const tx = num(s.txMcsIndex);
    const ident = obj(s.deviceIdentification);
    out.set(mac, {
      mac,
      id: typeof ident.id === 'string' ? ident.id : null,
      name: String(ident.name ?? s.name ?? mac),
      signal: num(s.rxSignal),
      noise: num(s.noiseFloor),
      capMbps: cap === null ? null : Math.round(cap / 1e5) / 10,
      mcs: rx !== null && tx !== null ? (rx + tx) / 2 : (rx ?? tx),
    });
  }
  return out;
}

/** Several readings of the same AP averaged per CPE (a single reading is noisy). */
export function averageSamples(readings: Array<Map<string, LinkSample>>): Map<string, LinkSample> {
  const out = new Map<string, LinkSample>();
  const mean = (v: Array<number | null>) => {
    const x = v.filter((n): n is number => n !== null);
    return x.length ? Math.round((x.reduce((a, b) => a + b, 0) / x.length) * 10) / 10 : null;
  };
  const macs = new Set(readings.flatMap((r) => [...r.keys()]));
  for (const mac of macs) {
    const rs = readings.map((r) => r.get(mac)).filter((x): x is LinkSample => !!x);
    out.set(mac, { mac, id: rs[0]!.id, name: rs[0]!.name, signal: mean(rs.map((r) => r.signal)), noise: mean(rs.map((r) => r.noise)), capMbps: mean(rs.map((r) => r.capMbps)), mcs: mean(rs.map((r) => r.mcs)) });
  }
  return out;
}

const median = (v: number[]) => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Summary of the links of an AP: what the comparison looks at. */
export interface LinkSummary {
  stations: number;
  capacityMbps: number;
  medianSnrDb: number | null;
  medianMcs: number | null;
  weakestDbm: number | null;
  noiseDbm: number | null;
}

export function summarize(m: Map<string, LinkSample>, only?: Set<string>): LinkSummary {
  const v = [...m.values()].filter((s) => !only || only.has(s.mac));
  const snr = v.map((s) => (s.signal !== null && s.noise !== null ? s.signal - s.noise : null)).filter((x): x is number => x !== null);
  const sig = v.map((s) => s.signal).filter((x): x is number => x !== null);
  const r = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);
  return {
    stations: v.length,
    capacityMbps: Math.round(v.reduce((a, s) => a + (s.capMbps ?? 0), 0)),
    medianSnrDb: r(median(snr)),
    medianMcs: r(median(v.map((s) => s.mcs).filter((x): x is number => x !== null))),
    weakestDbm: sig.length ? Math.min(...sig) : null,
    noiseDbm: r(median(v.map((s) => s.noise).filter((x): x is number => x !== null))),
  };
}

/** Rules of the comparison. */
export const OPTIMIZER_RULES = {
  /** Total capacity of the CPEs at least this much higher to call a channel better (+5%). */
  betterCapacity: 1.05,
  /** …and the median SNR not lower than this (dB). */
  snrTolerance: 1,
  /** The weakest customer may not lose more than this (dB). */
  weakestTolerance: 3,
  /** Below this capacity ratio the channel is worse (−3%). */
  worseCapacity: 0.97,
};

export type Verdict = 'migliore' | 'peggiore' | 'uguale' | 'cpe_mancanti';

export interface Comparison {
  verdict: Verdict;
  /** CPEs connected before and missing after. */
  missing: Array<{ mac: string; name: string }>;
  before: LinkSummary;
  after: LinkSummary;
  /** Capacity after / before on the same CPEs. */
  capacityRatio: number | null;
}

/**
 * Before/after on the CPEs connected before: any missing CPE fails the channel; better means more
 * total capacity (+5%) without losing SNR or pushing the weakest customer down.
 */
export function compareLinks(before: Map<string, LinkSample>, after: Map<string, LinkSample>): Comparison {
  const missing = [...before.values()].filter((s) => !after.has(s.mac)).map((s) => ({ mac: s.mac, name: s.name }));
  const common = new Set([...before.keys()].filter((m) => after.has(m)));
  const b = summarize(before, common);
  const a = summarize(after, common);
  const ratio = b.capacityMbps > 0 ? Math.round((a.capacityMbps / b.capacityMbps) * 1000) / 1000 : null;
  const R = OPTIMIZER_RULES;
  const snrOk = b.medianSnrDb === null || a.medianSnrDb === null || a.medianSnrDb >= b.medianSnrDb - R.snrTolerance;
  const weakOk = b.weakestDbm === null || a.weakestDbm === null || a.weakestDbm >= b.weakestDbm - R.weakestTolerance;
  let verdict: Verdict;
  if (missing.length) verdict = 'cpe_mancanti';
  else if (ratio !== null && ratio >= R.betterCapacity && snrOk && weakOk) verdict = 'migliore';
  else if ((ratio !== null && ratio < R.worseCapacity) || !weakOk) verdict = 'peggiore';
  else verdict = 'uguale';
  return { verdict, missing, before: summarize(before), after: summarize(after), capacityRatio: ratio };
}
