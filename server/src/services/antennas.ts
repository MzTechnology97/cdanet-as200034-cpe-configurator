import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db.ts';
import { nowIso } from '../db.ts';
import { readZipEntries } from './zip.ts';

/**
 * Antennas of the APs: the radiation patterns published by the makers (Ubiquiti airMAX, RF
 * elements horns, sectors and dishes), downloaded by the server when the admin asks (they are
 * the makers' files: never in the repository), and for every AP which antenna it has, where it
 * points (azimuth) and its downtilt. UISP knows the azimuth only when someone typed it, and
 * nothing about an RF elements horn on a Rocket: the admin says it here.
 */

/** A radiation pattern: attenuation from the peak (dB ≥ 0) every degree. */
export interface AntennaPattern {
  id: string;
  vendor: 'Ubiquiti' | 'RF elements';
  name: string;
  gainDbi: number | null;
  /** Half-power beamwidths, degrees (from the pattern). */
  hBeam: number;
  vBeam: number;
  /** az[i]: i degrees clockwise from boresight. */
  az: number[];
  /** el[i]: i degrees below boresight (360 − i: above). */
  el: number[];
}

export const UBNT_URL = 'https://dl.ui.com/antenna-pattern-data/airMax/';
export const UBNT_FILES = [
  'Sectors/PrismAP-5-30', 'Sectors/PrismAP-5-45', 'Sectors/PrismAP-5-60', 'Sectors/PrismAP-5-90', 'Sectors/airPrismHD',
  'Sectors/AM-5AC21-60', 'Sectors/AM-5AC22-45', 'Sectors/AM-5G16-120', 'Sectors/AM-5G17-90', 'Sectors/AM-5G19-120', 'Sectors/AM-5G20-90',
  'LiteAP/LAP-GPS', 'LiteBeam/LBE-5AC-23', 'LiteBeam/LBE-5AC-Gen2', 'LiteBeam/LBE-5AC-LR',
  'NanoBeam/NBE-5AC-19', 'NanoBeam/NBE-5AC-Gen2', 'NanoBeam/NBE-M5-16', 'NanoBeam/NBE-M5-19',
  'NanoStation/NS-5AC-Loco', 'NanoStation/NS-5AC', 'NanoStation/NSM5', 'NanoStation/locoM5',
  'PowerBeam/PBE-5AC-400-ISO', 'PowerBeam/PBE-5AC-400', 'PowerBeam/PBE-M5-300', 'PowerBeam/PBE-M5-400',
];
export const RFE_URL = 'https://rfelements.com/assets/Uploads/Google-Network-Planner-Radiation-Patterns2.zip';

/** Half-power width of a cut: degrees around its peak (an electrical downtilt moves it) within 3 dB. */
export function beamwidth(cut: number[]): number {
  const peak = cut.indexOf(Math.min(...cut));
  let r = 0;
  while (r < 180 && cut[(peak + r) % 360]! - cut[peak]! <= 3) r++;
  let l = 0;
  while (l < 180 && cut[(peak - l + 360) % 360]! - cut[peak]! <= 3) l++;
  return Math.max(1, r + l - 1);
}

/** The cut rotated so that its smallest loss is at index 0 (the boresight), losses from the peak. */
function normalize(values: number[]): number[] {
  const min = Math.min(...values);
  return values.map((v) => Math.round((v - min) * 10) / 10);
}

/**
 * Ubiquiti .ant (Radio Mobile): 720 values in dB (0 at the peak, negative below): 360 horizontal
 * from the boresight clockwise, then 360 vertical with 90 at the horizon and 91… below.
 */
export function parseAnt(text: string): { az: number[]; el: number[] } | null {
  const v = text.split(/\s+/).filter(Boolean).map(Number);
  if (v.length < 720 || v.some((x) => !Number.isFinite(x))) return null;
  const az = normalize(v.slice(0, 360).map((x) => -x));
  const vert = v.slice(360, 720).map((x) => -x);
  // index i of [el] = i degrees below the horizon → value at 90 + i
  const el = normalize(Array.from({ length: 360 }, (_, i) => vert[(90 + i) % 360]!));
  return { az, el };
}

/** GAIN of a .msi file next to the .ant, dBi (dBd + 2.15). */
export function msiGain(text: string): number | null {
  const m = /^GAIN\s+([\d.]+)\s*(dBi|dBd)?/im.exec(text);
  if (!m) return null;
  return Math.round((Number(m[1]) + (m[2]?.toLowerCase() === 'dbd' ? 2.15 : 0)) * 10) / 10;
}

/** RF elements CSV (Google Network Planner): gain in dBi every degree from −179 to 180, azimuth and elevation. */
export function parseRfeCsv(text: string): { name: string; gainDbi: number | null; az: number[]; el: number[] } | null {
  const lines = text.split(/\r?\n/);
  const specAt = lines.findIndex((l) => l.startsWith('----SpecMetadata'));
  const spec = specAt >= 0 ? lines[specAt + 2]?.split(',') : undefined;
  const dataAt = lines.findIndex((l) => l.startsWith('----PatternData'));
  if (dataAt < 0) return null;
  const az = new Array<number>(360).fill(NaN);
  const el = new Array<number>(360).fill(NaN);
  for (const l of lines.slice(dataAt + 2)) {
    const [a, g1, g2] = l.split(',').map(Number);
    if (!Number.isFinite(a) || !Number.isFinite(g1)) continue;
    const i = (((Math.round(a!) % 360) + 360) % 360) as number;
    az[i] = -g1!;
    // elevation angle positive upwards: i degrees below = angle −i
    if (Number.isFinite(g2)) el[(360 - i) % 360] = -g2!;
  }
  if (az.some((x) => Number.isNaN(x)) || el.some((x) => Number.isNaN(x))) return null;
  return { name: spec?.[1] ?? '', gainDbi: spec?.[5] ? Number(spec[5]) : null, az: normalize(az), el: normalize(el) };
}

export interface ApAntenna {
  antennaId: string | null;
  /** Degrees from true north; null = not known (UISP or the customers' arc are used). */
  azimuth: number | null;
  /** Mechanical + electrical downtilt, degrees (positive = down); null = unknown (vertical pattern not used). */
  tilt: number | null;
  updatedAt: string;
}

const SETTINGS_KEY = 'antennas.ap';

export function createAntennas(opts: { dir: string; db: Db; fetchImpl?: typeof fetch; log?: (m: string) => void }) {
  const f = opts.fetchImpl ?? fetch;
  const file = join(opts.dir, 'library.json');
  let lib: AntennaPattern[] | null = null;
  const state = { running: false, done: 0, total: 0, error: null as string | null, finishedAt: null as string | null };

  const library = (): AntennaPattern[] => {
    if (lib) return lib;
    try {
      lib = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as AntennaPattern[]) : [];
    } catch {
      lib = [];
    }
    return lib;
  };

  async function get(url: string): Promise<Buffer> {
    const r = await f(url, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }

  /** Downloads the makers' patterns (about 1 MB in all) and rebuilds the library. */
  async function importLibrary(): Promise<void> {
    if (state.running) throw new Error('import_running');
    Object.assign(state, { running: true, done: 0, total: UBNT_FILES.length + 1, error: null });
    const out: AntennaPattern[] = [];
    try {
      for (const path of UBNT_FILES) {
        const name = path.split('/').pop()!;
        try {
          const files = readZipEntries(await get(`${UBNT_URL}${path}.zip`)).filter((e) => !e.name.includes('__MACOSX'));
          // horizontal polarization when there are two (the patterns are almost the same)
          const ant = files.filter((e) => /\.ant$/i.test(e.name)).sort((a, b) => Number(/v(pol)?\.ant$/i.test(a.name)) - Number(/v(pol)?\.ant$/i.test(b.name)))[0];
          const p = ant ? parseAnt(ant.data.toString('latin1')) : null;
          const msi = files.find((e) => /\.msi$/i.test(e.name));
          if (p) out.push({ id: `ubnt:${name}`, vendor: 'Ubiquiti', name, gainDbi: msi ? msiGain(msi.data.toString('latin1')) : null, hBeam: beamwidth(p.az), vBeam: beamwidth(p.el), ...p });
        } catch (e) {
          opts.log?.(`antennas ${name}: ${(e as Error).message}`);
        }
        state.done++;
      }
      for (const e of readZipEntries(await get(RFE_URL)).filter((x) => /\.csv$/i.test(x.name))) {
        const p = parseRfeCsv(e.data.toString('latin1'));
        const name = (p?.name || e.name.replace(/\.csv$/i, '')).trim();
        if (p) out.push({ id: `rfe:${name}`, vendor: 'RF elements', name, gainDbi: p.gainDbi, hBeam: beamwidth(p.az), vBeam: beamwidth(p.el), az: p.az, el: p.el });
      }
      state.done++;
      mkdirSync(opts.dir, { recursive: true });
      writeFileSync(file, JSON.stringify(out));
      lib = out;
    } catch (e) {
      state.error = (e as Error).message;
    } finally {
      state.running = false;
      state.finishedAt = nowIso();
    }
  }

  const assigned = (): Record<string, ApAntenna> => {
    const r = opts.db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY) as { value: string } | undefined;
    return r ? (JSON.parse(r.value) as Record<string, ApAntenna>) : {};
  };

  return {
    library,
    importLibrary,
    state: () => ({ ...state }),
    pattern: (id: string | null | undefined) => (id ? (library().find((p) => p.id === id) ?? null) : null),
    /** What the admin said for every AP. */
    assigned,
    set(apId: string, a: Omit<ApAntenna, 'updatedAt'> | null, userId: number | null) {
      const all = assigned();
      if (a && (a.antennaId || a.azimuth !== null || a.tilt !== null)) all[apId] = { ...a, updatedAt: nowIso() };
      else delete all[apId];
      opts.db
        .prepare(
          `INSERT INTO settings(key, value, updated_at, updated_by) VALUES(?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        )
        .run(SETTINGS_KEY, JSON.stringify(all), nowIso(), userId);
    },
  };
}
export type Antennas = ReturnType<typeof createAntennas>;
