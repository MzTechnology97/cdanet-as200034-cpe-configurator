/**
 * Ubiquiti CPEs for the customer side of the radio model: antenna gain (datasheet), beam width and
 * the names UISP gives them. The AP side always stays what UISP says (model, azimuth, altitude).
 * A customer's signal depends on its antenna: a NanoStation Loco (13 dBi) hears 10 dB less than a
 * LiteBeam (23 dBi) at the same place, so the calibration uses every real CPE at the gain of its
 * model and an estimate is given for the CPE that will be installed.
 */
export interface CpeModel {
  id: string;
  name: string;
  gainDbi: number;
  /** Half-power beam width, degrees (horizontal). */
  beamDeg: number;
  /** Indicative maximum distance of a good link, m (to keep a weak CPE off long links). */
  maxLinkM: number;
  /** Proposed for new installations (airMAX ac on sale); the others are only recognised in UISP. */
  current: boolean;
  /** Names of UISP (model or model name), lower case, matched exactly or as a prefix. */
  uisp: string[];
}

export const CPE_MODELS: CpeModel[] = [
  { id: 'loco5ac', name: 'NanoStation 5AC Loco', gainDbi: 13, beamDeg: 45, maxLinkM: 3000, current: true, uisp: ['nanostation 5ac loco', 'loco5ac'] },
  { id: 'ns5ac', name: 'NanoStation 5AC', gainDbi: 16, beamDeg: 45, maxLinkM: 5000, current: true, uisp: ['nanostation 5ac', 'ns-5ac'] },
  { id: 'nbe5ac16', name: 'NanoBeam 5AC 16', gainDbi: 16, beamDeg: 30, maxLinkM: 5000, current: false, uisp: ['nanobeam 5ac 16', 'nbe-5ac-16'] },
  { id: 'nbe5ac', name: 'NanoBeam 5AC', gainDbi: 19, beamDeg: 15, maxLinkM: 8000, current: true, uisp: ['nanobeam 5ac', 'nbe-5ac-gen2', 'nbe-5ac-19'] },
  { id: 'lbe5ac', name: 'LiteBeam 5AC', gainDbi: 23, beamDeg: 7, maxLinkM: 12000, current: true, uisp: ['litebeam 5ac', 'lbe-5ac-gen2', 'lbe-5ac-23'] },
  { id: 'pbe5ac300', name: 'PowerBeam 5AC 300', gainDbi: 22, beamDeg: 7, maxLinkM: 12000, current: false, uisp: ['powerbeam 5ac 300', 'pbe-5ac-300'] },
  { id: 'pbe5ac', name: 'PowerBeam 5AC', gainDbi: 25, beamDeg: 6, maxLinkM: 15000, current: true, uisp: ['powerbeam 5ac', 'pbe-5ac-gen2', 'pbe-5ac-400', 'powerbeam 5ac 400', 'powerbeam 5ac iso', 'pbe-5ac-iso'] },
  { id: 'lbe5aclr', name: 'LiteBeam 5AC Long-Range', gainDbi: 26, beamDeg: 5, maxLinkM: 20000, current: true, uisp: ['litebeam 5ac long-range', 'lbe-5ac-lr'] },
  { id: 'pbe5ac500', name: 'PowerBeam 5AC 500', gainDbi: 27, beamDeg: 5, maxLinkM: 20000, current: true, uisp: ['powerbeam 5ac 500', 'pbe-5ac-500'] },
  { id: 'pbe5ac620', name: 'PowerBeam 5AC 620', gainDbi: 29, beamDeg: 4, maxLinkM: 25000, current: true, uisp: ['powerbeam 5ac 620', 'pbe-5ac-620'] },
  // airMAX M, still in the field
  { id: 'locom5', name: 'NanoStation Loco M5', gainDbi: 13, beamDeg: 45, maxLinkM: 3000, current: false, uisp: ['nanostation loco m5', 'locom5'] },
  { id: 'nsm5', name: 'NanoStation M5', gainDbi: 16, beamDeg: 43, maxLinkM: 5000, current: false, uisp: ['nanostation m5', 'nsm5'] },
  { id: 'nbm516', name: 'NanoBeam M5 16', gainDbi: 16, beamDeg: 30, maxLinkM: 5000, current: false, uisp: ['nanobeam m5 16', 'nbe-m5-16'] },
  { id: 'nbm519', name: 'NanoBeam M5 19', gainDbi: 19, beamDeg: 15, maxLinkM: 8000, current: false, uisp: ['nanobeam m5 19', 'nbe-m5-19'] },
  { id: 'lbm5', name: 'LiteBeam M5', gainDbi: 23, beamDeg: 7, maxLinkM: 12000, current: false, uisp: ['litebeam m5', 'lbe-m5-23'] },
  { id: 'pbm5300', name: 'PowerBeam M5 300', gainDbi: 22, beamDeg: 8, maxLinkM: 12000, current: false, uisp: ['powerbeam m5 300', 'pbe-m5-300'] },
  { id: 'pbm5400', name: 'PowerBeam M5 400', gainDbi: 25, beamDeg: 6, maxLinkM: 15000, current: false, uisp: ['powerbeam m5 400', 'pbe-m5-400'] },
];

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * The model of a UISP device name ("NanoStation 5AC loco", "LBE-5AC-Gen2"…): the longest name that
 * matches, so "NanoStation 5AC loco" is not taken for "NanoStation 5AC". Null for other radios
 * (airFiber, LTU, Wave…).
 */
export function cpeModelOf(...names: Array<string | null | undefined>): CpeModel | null {
  let best: { m: CpeModel; len: number } | null = null;
  for (const raw of names) {
    if (!raw) continue;
    const n = norm(raw);
    for (const m of CPE_MODELS) {
      for (const u of m.uisp) {
        if ((n === u || n.startsWith(`${u} `) || n.startsWith(`${u}-`) || n.startsWith(u)) && (!best || u.length > best.len)) best = { m, len: u.length };
      }
    }
  }
  return best?.m ?? null;
}

export const cpeModelById = (id: string | null | undefined) => (id ? (CPE_MODELS.find((m) => m.id === id) ?? null) : null);

/**
 * The CPE to propose for a link of [distanceM] with [signalDbm] expected with the reference gain
 * [refGainDbi]: the lowest-gain current model that reaches [targetDbm] and is meant for that
 * distance (a narrower beam also keeps interference out); null when not even the biggest does.
 */
export function recommendCpe(signalDbm: number, refGainDbi: number, distanceM: number, targetDbm: number): { model: CpeModel; signalDbm: number } | null {
  const ok = CPE_MODELS.filter((m) => m.current)
    .sort((a, b) => a.gainDbi - b.gainDbi)
    .map((m) => ({ model: m, signalDbm: Math.round(signalDbm + m.gainDbi - refGainDbi) }))
    .find((x) => x.signalDbm >= targetDbm && distanceM <= x.model.maxLinkM);
  return ok ?? null;
}
