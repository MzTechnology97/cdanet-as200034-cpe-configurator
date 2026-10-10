import type { ApLoad } from './ap-load.ts';
import { bearingDeg, distanceM, type LatLon } from './geo.ts';

const angleDiff = (a: number, b: number) => {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
};

/**
 * Assistente rete: what to fix on the network, from the UISP data of every AP (stations, a week of
 * statistics, the spectrum the AP measures) and the coverage model. Rules and statistics, not
 * guesses: every finding says what was measured and what to do. Pure, unit-tested.
 */

export interface StationInput {
  deviceId: string | null;
  name: string;
  mac: string | null;
  /** Signal of the CPE received by the AP, and the noise floor there, dBm. */
  rxSignal: number | null;
  noise: number | null;
  /** Share of the AP airtime this CPE uses, 0–1. */
  airtime: number | null;
  /** Modulation (MCS index) now and the ideal one for its signal, both directions. */
  rxMcs: number | null;
  rxMcsIdeal: number | null;
  txMcs: number | null;
  txMcsIdeal: number | null;
  /** Downlink capacity now and the theoretical one, Mbit/s. */
  capMbps: number | null;
  capTheoMbps: number | null;
  /** Signal per chain (polarisation), dBm. */
  chains: number[];
  /** Change of the signal over the week: last day vs the first two days, dB (null: no history). */
  trendDb: number | null;
  /** Spectrum measured by the CPE at the customer's place: [MHz, index] (empty when not reported). */
  spectrum: Array<[number, number]>;
}

export interface AdvisorInput {
  apId: string;
  apName: string;
  location: LatLon | null;
  /** Antenna azimuth (UISP), degrees, and beamwidth from the model name. */
  heading: number | null;
  beamWidth: number;
  /** Channel: centre and width, MHz. */
  frequency: number | null;
  widthMhz: number | null;
  /** Occupancy of the spectrum measured by the AP: [MHz, index] every 5 MHz (higher = busier). */
  spectrum: Array<[number, number]>;
  stations: StationInput[];
  load: ApLoad | null;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const median = (v: number[]) => {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const k = Math.floor(s.length / 2);
  return s.length % 2 ? s[k]! : (s[k - 1]! + s[k]!) / 2;
};
const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

/** Signal trend of one station from its hourly series: mean of the last 24 h − mean of the first 48 h. */
export function signalTrend(series: Array<{ x: number; y: number }> | null | undefined): number | null {
  const pts = (series ?? []).filter((p) => typeof p?.y === 'number' && Number.isFinite(p.y) && p.y < 0);
  if (pts.length < 72) return null;
  const sorted = [...pts].sort((a, b) => a.x - b.x);
  const t0 = sorted[0]!.x;
  const t1 = sorted[sorted.length - 1]!.x;
  const first = mean(sorted.filter((p) => p.x < t0 + 48 * 3_600_000).map((p) => p.y));
  const last = mean(sorted.filter((p) => p.x > t1 - 24 * 3_600_000).map((p) => p.y));
  return first === null || last === null ? null : Math.round((last - first) * 10) / 10;
}

const bands = (v: unknown): Array<[number, number]> => (Array.isArray(v) ? v : []).filter((b): b is [number, number] => Array.isArray(b) && typeof b[0] === 'number' && typeof b[1] === 'number');

/**
 * Spectrum of the link as both ends see it: for every frequency of the AP's spectrum, the average of
 * the AP's index and the median index of its CPEs (the customers' side counts as much as the AP's).
 */
export function linkSpectrum(ap: Array<[number, number]>, cpes: Array<Array<[number, number]>>): Array<[number, number]> {
  const withData = cpes.filter((c) => c.length);
  if (!withData.length) return ap;
  return ap.map(([f, v]) => {
    const near = withData.map((c) => c.reduce((best, p) => (Math.abs(p[0] - f) < Math.abs(best[0] - f) ? p : best))).filter((p) => Math.abs(p[0] - f) <= 5).map((p) => p[1]);
    const m = median(near);
    return [f, m === null ? v : Math.round(((v + m) / 2) * 10) / 10];
  });
}

/** The advisor input of an AP from the raw UISP stations list and week statistics. */
export function advisorInput(
  ap: { id: string; name: string; location: LatLon | null; heading: number | null; frequency: number | null; beamWidth?: number },
  stations: unknown[] | null,
  stats: Record<string, unknown> | null,
  load: ApLoad | null,
): AdvisorInput {
  const freq = (stats?.frequency ?? {}) as { frequencyCenter?: unknown; channelWidth?: unknown; frequencyBands?: unknown };
  const series = (stats?.stations ?? {}) as Record<string, { signal?: { avg?: Array<{ x: number; y: number }> }; stationFrequency?: { frequencyBands?: unknown } }>;
  const bySeries = new Map(Object.entries(series).map(([k, v]) => [k.toLowerCase(), v]));
  const spectrum = bands(freq.frequencyBands);
  return {
    apId: ap.id,
    apName: ap.name,
    location: ap.location,
    heading: ap.heading,
    beamWidth: ap.beamWidth ?? 90,
    frequency: num(freq.frequencyCenter) ?? ap.frequency,
    widthMhz: num(freq.channelWidth) ?? load?.channelWidthMhz ?? null,
    spectrum,
    load,
    stations: ((stations ?? []) as Array<Record<string, unknown>>)
      .filter((s) => s.connected !== false)
      .map((s) => {
        const id = s.deviceIdentification as { id?: string; name?: string } | undefined;
        const st = s.statistics as { airTime?: unknown } | undefined;
        const mac = typeof s.mac === 'string' ? s.mac : null;
        const chains = Array.isArray(s.rxChain) ? (s.rxChain as unknown[]).map(num).filter((v): v is number => v !== null && v < 0) : [];
        return {
          deviceId: id?.id ?? null,
          name: id?.name ?? (typeof s.name === 'string' ? s.name : mac ?? '—'),
          mac,
          rxSignal: num(s.rxSignal),
          noise: num(s.noiseFloor),
          airtime: num(st?.airTime),
          rxMcs: num(s.rxMcsIndex),
          rxMcsIdeal: num(s.rxMcsIndexIdeal),
          txMcs: num(s.txMcsIndex),
          txMcsIdeal: num(s.txMcsIndexIdeal),
          capMbps: num(s.downlinkCapacity) === null ? null : Math.round(num(s.downlinkCapacity)! / 1e6),
          capTheoMbps: num((s.statistics as { theoreticalDownlinkCapacity?: unknown } | undefined)?.theoreticalDownlinkCapacity) === null ? null : Math.round(num((s.statistics as { theoreticalDownlinkCapacity?: number }).theoreticalDownlinkCapacity)! / 1e6),
          chains,
          trendDb: mac ? signalTrend(bySeries.get(mac.toLowerCase())?.signal?.avg) : null,
          spectrum: bands(mac ? bySeries.get(mac.toLowerCase())?.stationFrequency?.frequencyBands : null),
        };
      }),
  };
}

export type Severity = 'critico' | 'attenzione' | 'info';

export interface Finding {
  /** Stable key: the same problem keeps the same id from one run to the next (dismiss, "new"). */
  id: string;
  severity: Severity;
  kind: string;
  apId: string;
  apName: string;
  cpe?: { id: string | null; name: string; mac: string | null };
  title: string;
  /** What was measured. */
  detail: string;
  /** What to do. */
  action: string;
  /** Parameters suggested for the action (channel, width…). */
  params?: Record<string, number | string>;
}

/** Thresholds of the rules (tuned on the real network, October 2026). */
export const RULES = {
  snrCritical: 12,
  snrWarning: 20,
  /** Levels below the ideal modulation that are not normal any more (2 below is usual). */
  mcsGap: 3,
  /** From this many levels below the ideal a single CPE needs attention (4–5: worth knowing). */
  mcsGapWarning: 6,
  /** Share of an AP's CPEs below their ideal modulation that points to the channel (critical: 75%). */
  mcsShare: 0.5,
  mcsShareCritical: 0.75,
  airtimeShare: 0.05,
  airtimeCritical: 0.1,
  airtimeVsMedian: 3,
  trendWarning: -6,
  trendCritical: -10,
  belowExpected: -10,
  chainGap: 8,
  busyWarning: 50,
  busyCritical: 70,
  noiseWarning: -78,
  /** Spectrum: a channel at least this much quieter (index) is worth the change. */
  channelGain: 4,
  /** CPE side busier than the AP side on the channel by this much (index): local interference. */
  cpeInterference: 6,
  /** Own APs closer than this on overlapping channels can interfere. */
  coChannelM: 6000,
};

/**
 * Change of a link's signal when the channel moves from [from] to [to] MHz: free-space loss
 * (20·log10 of the ratio) and the frequency response of the two antennas, AP and CPE. 5 GHz panels
 * and dishes have their best gain around the middle of the band and lose about 1.5 dB each at its
 * edges (±350 MHz from 5500), more outside: a generic curve, without the datasheet of every model.
 */
export function frequencyShiftDb(from: number, to: number): number {
  const antenna = (f: number) => -1.5 * ((f - ANTENNA_CENTRE_MHZ) / 350) ** 2;
  return Math.round((-20 * Math.log10(to / from) + 2 * (antenna(to) - antenna(from))) * 10) / 10;
}
const ANTENNA_CENTRE_MHZ = 5500;

/** Mean occupancy of the spectrum over [centre ± width/2]; null when outside the measured range. */
export function channelOccupancy(spectrum: Array<[number, number]>, centre: number, width: number): number | null {
  const v = spectrum.filter(([f]) => Math.abs(f - centre) <= width / 2).map(([, x]) => x);
  if (!spectrum.length || centre - width / 2 < spectrum[0]![0] - 3 || centre + width / 2 > spectrum[spectrum.length - 1]![0] + 3) return null;
  return v.length ? Math.round(mean(v)! * 10) / 10 : null;
}

const overlap = (a: { f: number; w: number }, b: { f: number; w: number }) => Math.abs(a.f - b.f) < (a.w + b.w) / 2;

/**
 * Best channel of [width] for an AP: the quietest stretch of its spectrum within [range], avoiding
 * the channels of our own APs within [coChannelM] (counted as very busy). null without spectrum.
 */
export function bestChannel(
  spectrum: Array<[number, number]>,
  width: number,
  range: { from: number; to: number },
  neighbours: Array<{ f: number; w: number }>,
  /** The links of the AP: the weakest must stay above [minDbm] at the new frequency. */
  links?: { from: number; signals: number[]; minDbm: number },
): ChannelChoice | null {
  return rankChannels(spectrum, width, range, neighbours, links)[0] ?? null;
}

export interface ChannelChoice {
  centre: number;
  /** Occupancy of the channel plus the penalties (near AP, loss of the weakest customer). */
  occupancy: number;
  /** Signal of the weakest customer on this channel, dBm (null: no customers). */
  weakestDbm: number | null;
}

/** Every usable channel of [width] in [range], best first (same rules as [bestChannel]). */
export function rankChannels(
  spectrum: Array<[number, number]>,
  width: number,
  range: { from: number; to: number },
  neighbours: Array<{ f: number; w: number }>,
  links?: { from: number; signals: number[]; minDbm: number },
): ChannelChoice[] {
  const out: ChannelChoice[] = [];
  const weakest = links?.signals.length ? Math.min(...links.signals) : null;
  for (let c = Math.ceil((range.from + width / 2) / 5) * 5; c + width / 2 <= range.to; c += 5) {
    const occ = channelOccupancy(spectrum, c, width);
    if (occ === null) continue;
    // the weakest customer at the new frequency (antennas off their best band, more path loss)
    const after = weakest !== null && links ? Math.round((weakest + frequencyShiftDb(links.from, c)) * 10) / 10 : null;
    if (after !== null && after < links!.minDbm && after < weakest!) continue;
    const score = occ + (neighbours.some((n) => overlap({ f: c, w: width }, n)) ? 100 : 0) + (after !== null && weakest !== null ? Math.max(0, weakest - after) : 0);
    if (score < 100) out.push({ centre: c, occupancy: score, weakestDbm: after });
  }
  // best first; on equal score the channel nearer the current one (smaller change for the antennas)
  return out.sort((a, b) => a.occupancy - b.occupancy || (links ? Math.abs(a.centre - links.from) - Math.abs(b.centre - links.from) : a.centre - b.centre));
}

/**
 * Channels to try on an AP for the automatic optimisation: the best [n] of its link spectrum for
 * each width in [widths] (the current one by default), far enough from each other to be really
 * different (half a channel), never on a near AP, the current channel excluded. Best first.
 */
export function channelCandidates(inputs: AdvisorInput[], apId: string, o: { range: { from: number; to: number }; minDbm?: number }, widths?: number[], n = 3): Array<ChannelChoice & { width: number }> {
  const ap = inputs.find((i) => i.apId === apId);
  if (!ap || ap.frequency === null || ap.widthMhz === null) return [];
  const near = ap.location ? inputs.filter((x) => x.apId !== apId && x.frequency !== null && x.widthMhz !== null && x.location !== null && distanceM(ap.location!, x.location!) <= RULES.coChannelM) : [];
  const neighbours = near.map((x) => ({ f: x.frequency!, w: x.widthMhz! }));
  const spectrum = linkSpectrum(ap.spectrum, ap.stations.map((s) => s.spectrum));
  const links = { from: ap.frequency, signals: ap.stations.map((s) => s.rxSignal).filter((v): v is number => v !== null), minDbm: o.minDbm ?? -75 };
  const all = (widths?.length ? widths : [ap.widthMhz])
    .flatMap((w) => rankChannels(spectrum, w, o.range, neighbours, links).map((c) => ({ ...c, width: w })))
    .filter((c) => !(c.centre === ap.frequency && c.width === ap.widthMhz))
    .sort((a, b) => a.occupancy - b.occupancy);
  const out: Array<ChannelChoice & { width: number }> = [];
  for (const c of all) {
    if (out.length >= n) break;
    if (out.some((x) => x.width === c.width && Math.abs(x.centre - c.centre) < c.width / 2)) continue;
    out.push(c);
  }
  return out;
}

export interface AdvisorOptions {
  /** Frequencies the suggestions may use (licensed band of the network), MHz: whole channels inside. */
  range: { from: number; to: number };
  /** Minimum signal of a link (acceptance test), dBm: a new channel must not push a customer below it. */
  minDbm?: number;
  /** Expected signal at the CPE by the coverage model (without the CPE itself), by device id. */
  expected?: Map<string, number>;
  /** Signal of the CPE as UISP reports it (the CPE's side), by device id. */
  cpeSignal?: Map<string, number | null>;
  /** CPEs of busy APs that another, freer AP would serve well: by device id. */
  rebalance?: Map<string, { apName: string; signalDbm: number; level: string | null }>;
}

const fmt = (v: number) => String(Math.round(v * 10) / 10).replace('.', ',');

/** Findings of the whole network: CPEs to fix, APs to fix, channels and widths to change. */
export function analyzeNetwork(inputs: AdvisorInput[], o: AdvisorOptions): Finding[] {
  const out: Finding[] = [];
  const own = inputs.filter((i) => i.frequency !== null && i.widthMhz !== null && i.location !== null);
  // channels already suggested to other APs: a near AP must not be sent onto them, and of two APs
  // on the same channel only one is told to move
  const planned = new Map<string, Array<{ f: number; w: number }>>();
  const plan = (apId: string, f: number, w: number) => planned.set(apId, [...(planned.get(apId) ?? []), { f, w }]);
  for (const ap of inputs) {
    const base = { apId: ap.apId, apName: ap.apName };
    const st = ap.stations;
    const medAir = median(st.map((s) => s.airtime).filter((v): v is number => v !== null)) ?? 0;
    // ---- CPEs ----
    for (const s of st) {
      const cpe = { id: s.deviceId, name: s.name, mac: s.mac };
      const key = s.deviceId ?? s.mac ?? s.name;
      const snr = s.rxSignal !== null && s.noise !== null ? s.rxSignal - s.noise : null;
      if (snr !== null && snr < RULES.snrWarning) {
        out.push({ ...base, cpe, id: `snr:${key}`, kind: 'snr', severity: snr < RULES.snrCritical ? 'critico' : 'attenzione', title: `SNR basso: ${Math.round(snr)} dB`, detail: `Segnale all’AP ${s.rxSignal} dBm, rumore ${s.noise} dBm.`, action: 'Riallinea la CPE e controlla ostacoli e cavo; se il rumore è alto per tutto l’AP, vedi i suggerimenti di canale dell’AP.' });
      }
      const gap = Math.max(s.rxMcsIdeal !== null && s.rxMcs !== null ? s.rxMcsIdeal - s.rxMcs : 0, s.txMcsIdeal !== null && s.txMcs !== null ? s.txMcsIdeal - s.txMcs : 0);
      if (gap > RULES.mcsGap) {
        out.push({ ...base, cpe, id: `mcs:${key}`, kind: 'mcs', severity: gap >= RULES.mcsGapWarning ? 'attenzione' : 'info', title: `Modulazione sotto l’ideale di ${gap} livelli`, detail: `MCS ricezione ${s.rxMcs ?? '—'} (ideale ${s.rxMcsIdeal ?? '—'}), trasmissione ${s.txMcs ?? '—'} (ideale ${s.txMcsIdeal ?? '—'}): il segnale basterebbe, qualcosa disturba.`, action: 'Probabile interferenza o riflessioni: controlla puntamento e catene; se tocca più CPE dello stesso AP, cambia canale.' });
      }
      if (s.airtime !== null && s.airtime >= RULES.airtimeShare && s.airtime >= RULES.airtimeVsMedian * medAir) {
        out.push({ ...base, cpe, id: `airtime:${key}`, kind: 'airtime', severity: s.airtime >= RULES.airtimeCritical ? 'critico' : 'attenzione', title: `Occupa il ${fmt(s.airtime * 100)}% dell’airtime dell’AP`, detail: `La mediana delle CPE di questo AP è ${fmt(medAir * 100)}%: una CPE lenta (modulazione bassa) rallenta tutti.`, action: 'Migliora il collegamento di questa CPE (puntamento, palo più alto, altro AP) o limitane la banda.' });
      }
      if (s.trendDb !== null && s.trendDb <= RULES.trendWarning) {
        out.push({ ...base, cpe, id: `trend:${key}`, kind: 'trend', severity: s.trendDb <= RULES.trendCritical ? 'critico' : 'attenzione', title: `Segnale in calo di ${fmt(-s.trendDb)} dB in una settimana`, detail: 'Ultime 24 ore rispetto ai primi due giorni della settimana.', action: 'Un calo lento indica antenna che si sposta, vegetazione che cresce o un connettore che si ossida: programma un sopralluogo prima del guasto.' });
      }
      const exp = s.deviceId ? o.expected?.get(s.deviceId) : undefined;
      const real = s.deviceId ? o.cpeSignal?.get(s.deviceId) : undefined;
      if (exp !== undefined && typeof real === 'number' && real - exp <= RULES.belowExpected) {
        out.push({ ...base, cpe, id: `expected:${key}`, kind: 'expected', severity: 'attenzione', title: `${fmt(exp - real)} dB sotto il segnale atteso`, detail: `Riceve ${real} dBm, il modello di copertura si aspetta ${Math.round(exp)} dBm in quel punto (dalle CPE vicine dello stesso AP).`, action: 'Antenna probabilmente disallineata o ostruita: riallinea con lo strumento Puntamento dell’app.' });
      }
      if (s.chains.length >= 2 && Math.max(...s.chains) - Math.min(...s.chains) >= RULES.chainGap) {
        out.push({ ...base, cpe, id: `chains:${key}`, kind: 'chains', severity: 'attenzione', title: `Polarizzazioni sbilanciate di ${Math.round(Math.max(...s.chains) - Math.min(...s.chains))} dB`, detail: `Catene: ${s.chains.join(' / ')} dBm.`, action: 'Controlla cavo, connettori e la rotazione dell’antenna (polarizzazione).' });
      }
      // the customer's side much busier than the AP's on the channel in use: local interference
      if (s.spectrum.length && ap.frequency !== null && ap.widthMhz !== null) {
        const mine = channelOccupancy(s.spectrum, ap.frequency, ap.widthMhz);
        const apSide = channelOccupancy(ap.spectrum, ap.frequency, ap.widthMhz);
        if (mine !== null && apSide !== null && mine - apSide >= RULES.cpeInterference) {
          out.push({ ...base, cpe, id: `cpenoise:${key}`, kind: 'cpenoise', severity: 'attenzione', title: 'Interferenza dal lato del cliente', detail: `Sul canale ${ap.frequency}/${ap.widthMhz} MHz la CPE misura un’occupazione di ${fmt(mine)}, l’AP ${fmt(apSide)}: c’è qualcosa vicino al cliente che trasmette su quel canale.`, action: 'Antenna più direttiva o meglio puntata, schermatura, oppure un canale libero anche dal lato del cliente (vedi il suggerimento dell’AP).' });
        }
      }
      const rb = s.deviceId ? o.rebalance?.get(s.deviceId) : undefined;
      if (rb) {
        out.push({ ...base, cpe, id: `rebalance:${key}`, kind: 'rebalance', severity: 'info', title: `Potrebbe passare su ${rb.apName}`, detail: `Questo AP è carico la sera; da ${rb.apName}${rb.level ? ` (${rb.level} la sera)` : ''} il modello stima ${rb.signalDbm} dBm.`, action: `Valuta un ripuntamento verso ${rb.apName} per alleggerire l’AP.`, params: { ap: rb.apName, segnale: rb.signalDbm } });
      }
    }
    // ---- the AP ----
    // many CPEs below their ideal modulation: interference on the channel, not single installations
    const gaps = st.filter((s) => s.rxMcsIdeal !== null && s.rxMcs !== null);
    const below = gaps.filter((s) => Math.max(s.rxMcsIdeal! - s.rxMcs!, s.txMcsIdeal !== null && s.txMcs !== null ? s.txMcsIdeal - s.txMcs : 0) > RULES.mcsGap);
    if (gaps.length >= 4 && below.length / gaps.length >= RULES.mcsShare) {
      const share = Math.round((100 * below.length) / gaps.length);
      out.push({ ...base, id: `mcsap:${ap.apId}`, kind: 'mcs', severity: below.length / gaps.length >= RULES.mcsShareCritical ? 'critico' : 'attenzione', title: `${share}% delle CPE sotto la modulazione ideale`, detail: `${below.length} CPE su ${gaps.length} lavorano più di ${RULES.mcsGap} livelli sotto la modulazione che il loro segnale permetterebbe: tipico di un canale disturbato.`, action: 'Cambia canale (vedi il suggerimento se c’è) o restringi il canale; poi ricontrolla le modulazioni.' });
    }
    const l = ap.load;
    const busy = Math.max(l?.eveningAirtimePct ?? -1, l?.eveningUtilizationPct ?? -1);
    if (busy >= RULES.busyWarning) {
      out.push({ ...base, id: `busy:${ap.apId}`, kind: 'busy', severity: busy >= RULES.busyCritical ? 'critico' : 'attenzione', title: `Carico serale ${Math.round(busy)}%`, detail: `Airtime ${l?.eveningAirtimePct ?? '—'}%, utilizzo del canale ${l?.eveningUtilizationPct ?? '—'}%, picco ${l?.eveningPeakMbps ?? '—'} Mbit/s su ${l?.capacityMbps ?? '—'} con ${l?.stations ?? '—'} CPE (20–23, media della settimana).`, action: 'Sposta le CPE più lente o più lontane su AP vicini liberi, allarga il canale se lo spettro lo permette, o aggiungi un settore.' });
    }
    const noise = l?.noiseDbm ?? median(st.map((s) => s.noise).filter((v): v is number => v !== null));
    if (noise !== null && noise >= RULES.noiseWarning) {
      out.push({ ...base, id: `noise:${ap.apId}`, kind: 'noise', severity: 'attenzione', title: `Rumore alto all’AP: ${noise} dBm`, detail: 'Il rumore di fondo tipico è tra −95 e −85 dBm: qui qualcosa trasmette sullo stesso canale.', action: 'Cambia canale (vedi il suggerimento se c’è) o restringi il canale.' });
    }
    if (ap.frequency === null || ap.widthMhz === null) continue;
    const me = { f: ap.frequency, w: ap.widthMhz };
    const near = ap.location ? own.filter((x) => x.apId !== ap.apId && distanceM(ap.location!, x.location!) <= RULES.coChannelM) : [];
    // the same channel is fine on sectors that look elsewhere (frequency reuse): a clash is when one
    // AP stands inside the other's beam (azimuth and beamwidth from UISP)
    const sees = (a: AdvisorInput, b: AdvisorInput) => a.heading !== null && angleDiff(bearingDeg(a.location!, b.location!), a.heading) <= a.beamWidth / 2 + 15;
    const clash = near.filter((x) => overlap(me, { f: x.frequency!, w: x.widthMhz! }) && distanceM(ap.location!, x.location!) > 30 && (sees(ap, x) || sees(x, ap)));
    // the clash is already solved by moving the other APs
    const movedByOthers = clash.length > 0 && clash.every((x) => planned.has(x.apId));
    if (clash.length) {
      out.push({ ...base, id: `cochannel:${ap.apId}`, kind: 'cochannel', severity: 'attenzione', title: `Canale sovrapposto a ${clash.length === 1 ? clash[0]!.apName : `${clash.length} AP vicini`}`, detail: `${ap.frequency}/${ap.widthMhz} MHz; ${clash.map((x) => `${x.apName} ${x.frequency}/${x.widthMhz} MHz a ${fmt(distanceM(ap.location!, x.location!) / 1000)} km`).join(', ')}.`, action: movedByOthers ? `Due nostri AP vicini sullo stesso canale si disturbano: basta spostare ${clash.map((x) => x.apName).join(', ')} (vedi il canale suggerito su ${clash.length === 1 ? 'quell’AP' : 'quegli AP'}).` : 'Due nostri AP vicini sullo stesso canale si disturbano: sposta questo sul canale suggerito.' });
    }
    // channel and width from the spectrum the AP measures; near APs count with their channel and
    // with the ones suggested to them
    const neighbours = near.flatMap((x) => [{ f: x.frequency!, w: x.widthMhz! }, ...(planned.get(x.apId) ?? [])]);
    // the spectrum of the link: what the AP measures and what its CPEs measure at the customers
    const spectrum = linkSpectrum(ap.spectrum, st.map((s) => s.spectrum));
    const cpeSide = st.some((s) => s.spectrum.length);
    const current = channelOccupancy(spectrum, ap.frequency, ap.widthMhz);
    const links = { from: ap.frequency, signals: st.map((s) => s.rxSignal).filter((v): v is number => v !== null), minDbm: o.minDbm ?? -75 };
    const weakNow = links.signals.length ? Math.min(...links.signals) : null;
    const best = bestChannel(spectrum, ap.widthMhz, o.range, neighbours, links);
    if (best && current !== null && (current - best.occupancy >= RULES.channelGain || (clash.length && !movedByOthers)) && best.centre !== ap.frequency) {
      plan(ap.apId, best.centre, ap.widthMhz);
      out.push({ ...base, id: `channel:${ap.apId}`, kind: 'channel', severity: clash.length && !movedByOthers ? 'attenzione' : 'info', title: `Canale più libero: ${best.centre} MHz`, detail: `Occupazione dello spettro misurata dall’AP${cpeSide ? ' e dalle sue CPE' : ''}: ${fmt(current)} sul canale attuale (${ap.frequency}/${ap.widthMhz} MHz), ${fmt(best.occupancy)} su ${best.centre} MHz; nessun nostro AP entro ${RULES.coChannelM / 1000} km su quel canale.${weakNow !== null && best.weakestDbm !== null && Math.abs(best.weakestDbm - weakNow) >= 0.5 ? ` Cliente più debole: da ${weakNow} a circa ${fmt(best.weakestDbm)} dBm (antenne fuori dal loro centro banda e perdita di percorso a ${best.centre} MHz).` : ''}`, action: `Imposta l’AP su ${best.centre} MHz, ${ap.widthMhz} MHz di canale (le CPE seguono da sole), in un orario di basso traffico.`, params: { frequenza: best.centre, ampiezza: ap.widthMhz } });
    }
    const snrs = st.map((s) => (s.rxSignal !== null && s.noise !== null ? s.rxSignal - s.noise : null)).filter((v): v is number => v !== null);
    const medSnr = median(snrs);
    if (medSnr !== null && medSnr < RULES.snrWarning && ap.widthMhz >= 40) {
      const w = ap.widthMhz / 2;
      const ch = bestChannel(spectrum, w, o.range, neighbours, links);
      if (ch) plan(ap.apId, ch.centre, w);
      out.push({ ...base, id: `narrow:${ap.apId}`, kind: 'width', severity: 'attenzione', title: `Canale da restringere a ${w} MHz`, detail: `SNR mediano delle CPE ${Math.round(medSnr)} dB: dimezzando il canale il rumore cala di 3 dB e i collegamenti deboli tengono modulazioni più alte.`, action: `Passa a ${w} MHz${ch ? ` su ${ch.centre} MHz` : ''}.`, params: { ampiezza: w, ...(ch ? { frequenza: ch.centre } : {}) } });
    } else if (medSnr !== null && medSnr >= 30 && busy >= RULES.busyWarning && ap.widthMhz <= 40) {
      const w = ap.widthMhz * 2;
      const ch = bestChannel(spectrum, w, o.range, neighbours, links);
      if (ch) plan(ap.apId, ch.centre, w);
      if (ch) out.push({ ...base, id: `wide:${ap.apId}`, kind: 'width', severity: 'info', title: `Canale da allargare a ${w} MHz`, detail: `L’AP è carico la sera (${Math.round(busy)}%) ma le CPE hanno margine (SNR mediano ${Math.round(medSnr)} dB) e lo spettro ha ${w} MHz liberi su ${ch.centre} MHz (occupazione ${fmt(ch.occupancy)}).`, action: `Passa a ${w} MHz su ${ch.centre} MHz: raddoppia la capacità, controlla poi che le CPE più lontane restino sopra il minimo.`, params: { ampiezza: w, frequenza: ch.centre } });
    }
  }
  const order: Record<Severity, number> = { critico: 0, attenzione: 1, info: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity] || a.apName.localeCompare(b.apName));
}
