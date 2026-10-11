import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import { distanceM } from '../domain/geo.ts';
import type { GeocodeResult } from './geocode.ts';
import type { Bbox } from './terrain-store.ts';
import { extractZipEntry } from './zip.ts';

/**
 * House numbers of the national archive ANNCSU (Agenzia delle Entrate – ISTAT, open data,
 * monthly): the coordinates of every civic number the Comune georeferenced. Downloaded by the
 * server when the admin asks, for one region, kept only inside the area of the network. Used to
 * pin an address found by the geocoder (often only the street) on the house: same street, same
 * number, a few km from where the geocoder put it.
 */

export const ANNCSU_URL = (region: string) => `https://anncsu.open.agenziaentrate.gov.it/age-inspire/opendata/anncsu/getds.php?INDIR_${region}`;
export const REGIONS: Record<string, string> = {
  SICI: 'Sicilia', CALA: 'Calabria', CAMP: 'Campania', PUGL: 'Puglia', BASI: 'Basilicata', SARD: 'Sardegna', LAZI: 'Lazio', ABRU: 'Abruzzo', MOLI: 'Molise', TOSC: 'Toscana', UMBR: 'Umbria', MARC: 'Marche', EMIL: 'Emilia Romagna', LIGU: 'Liguria', PIEM: 'Piemonte', LOMB: 'Lombardia', VENE: 'Veneto', FRIU: 'Friuli Venezia Giulia', TREN: 'Trentino Alto Adige', VALL: "Valle d'Aosta",
};

const ABBR: Array<[RegExp, string]> = [
  [/^v\.?le\b/, 'viale'],
  [/^v\.\s*/, 'via '],
  [/^c\.?so\b/, 'corso'],
  [/^p\.?zza\b/, 'piazza'],
  [/^p\.?za\b/, 'piazza'],
  [/^c\.?da\b/, 'contrada'],
  [/^l\.?go\b/, 'largo'],
  [/^vic\.?\b/, 'vicolo'],
];

/** Street name for matching: lower case, no accents or punctuation, usual abbreviations expanded. */
export function normStreet(s: string): string {
  let t = s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[''`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const [re, full] of ABBR) t = t.replace(re, full);
  return t.replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** "Via Roma 12/B, Enna" → street "via roma", number 12, exponent "b"; null without a number. */
export function parseAddress(q: string): { street: string; number: number; exp: string } | null {
  const head = q.split(',')[0]!;
  const m = /^(.*?\D)\s*(\d{1,4})\s*(?:\/?\s*([a-z]))?\b/i.exec(head.trim());
  if (!m) return null;
  const street = normStreet(m[1]!);
  if (!street) return null;
  return { street, number: Number(m[2]), exp: (m[3] ?? '').toLowerCase() };
}

type Civic = [number, string, number, number]; // number, exponent, lat, lon

interface Index {
  region: string;
  file: string;
  at: string;
  civics: number;
  streets: Record<string, Civic[]>;
}

export function createAnncsu(opts: { dir: string; fetchImpl?: typeof fetch; log?: (m: string) => void }) {
  const f = opts.fetchImpl ?? fetch;
  const file = join(opts.dir, 'anncsu.json.gz');
  let index: Index | null | undefined;
  const state = { running: false, phase: '', error: null as string | null, finishedAt: null as string | null };

  const load = (): Index | null => {
    if (index !== undefined) return index;
    try {
      index = existsSync(file) ? (JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as Index) : null;
    } catch {
      index = null;
    }
    return index;
  };

  /** Downloads the region (a zip of a CSV, tens of MB) and keeps the civic numbers inside [area]. */
  async function importRegion(region: string, area: Bbox): Promise<void> {
    if (state.running) throw new Error('import_running');
    if (!REGIONS[region]) throw new Error('unknown_region');
    Object.assign(state, { running: true, phase: `Scaricamento dei civici (${REGIONS[region]})`, error: null });
    const tmp = join(opts.dir, 'tmp');
    const zip = join(tmp, 'anncsu.zip');
    const csv = join(tmp, 'anncsu.csv');
    try {
      mkdirSync(tmp, { recursive: true });
      const r = await f(ANNCSU_URL(region), { headers: { 'User-Agent': 'CDA-Net-CPE-Configurator' }, signal: AbortSignal.timeout(30 * 60_000) });
      if (!r.ok || !r.body) throw new Error(`ANNCSU: HTTP ${r.status}`);
      const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') ?? '')?.[1] ?? `INDIR_${region}`;
      await pipeline(Readable.fromWeb(r.body as never), createWriteStream(zip));
      state.phase = 'Lettura dei civici';
      if (!(await extractZipEntry(zip, /\.csv$/i, csv))) throw new Error('ANNCSU: CSV non trovato');
      rmSync(zip, { force: true });
      const streets: Record<string, Civic[]> = {};
      let n = 0;
      let cols: string[] | null = null;
      const rl = createInterface({ input: createReadStream(csv, { encoding: 'latin1' }), crlfDelay: Infinity });
      for await (const line of rl) {
        const c = line.split(';');
        if (!cols) {
          cols = c;
          continue;
        }
        const at = (k: string) => c[cols!.indexOf(k)] ?? '';
        const lon = Number(at('COORD_X_COMUNE').replace(',', '.'));
        const lat = Number(at('COORD_Y_COMUNE').replace(',', '.'));
        const num = Number(at('CIVICO'));
        if (!lat || !lon || !num || lat < area.minLat || lat > area.maxLat || lon < area.minLon || lon > area.maxLon) continue;
        const key = normStreet(at('ODONIMO'));
        (streets[key] ??= []).push([num, at('ESPONENTE').toLowerCase(), Math.round(lat * 1e6) / 1e6, Math.round(lon * 1e6) / 1e6]);
        n++;
      }
      const ix: Index = { region, file: name, at: new Date().toISOString(), civics: n, streets };
      writeFileSync(file, gzipSync(JSON.stringify(ix)));
      index = ix;
      state.phase = 'Completato';
    } catch (e) {
      state.error = (e as Error).message;
      state.phase = 'Interrotto';
      opts.log?.(`anncsu: ${state.error}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      state.running = false;
      state.finishedAt = new Date().toISOString();
    }
  }

  /**
   * The geocoder's results with the house pinned: when the query has a street and a number and
   * the archive has that number on that street within [maxM] of a result, the result moves there.
   */
  function refine(results: GeocodeResult[], q: string, maxM = 4000): GeocodeResult[] {
    const ix = load();
    const a = parseAddress(q);
    if (!ix || !a) return results;
    const list = ix.streets[a.street];
    if (!list) return results;
    const same = list.filter(([n, e]) => n === a.number && (!a.exp || e === a.exp));
    if (!same.length) return results;
    return results.map((r) => {
      let best: Civic | null = null;
      let bestD = maxM;
      for (const c of same) {
        const d = distanceM(r, { lat: c[2], lon: c[3] });
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      // the label of the geocoder often stops at the street: the number in front, as Nominatim writes it
      const num = `${a.number}${a.exp ? `/${a.exp.toUpperCase()}` : ''}`;
      const label = /^\d/.test(r.label) ? r.label : `${num}, ${r.label}`;
      return best ? { ...r, lat: best[2], lon: best[3], label: `${label} · civico ANNCSU`, type: 'anncsu' } : r;
    });
  }

  return {
    importRegion,
    refine,
    /** For the tests. */
    _set(ix: Index | null) {
      index = ix;
    },
    state: () => ({ ...state }),
    status: () => {
      const ix = load();
      return ix ? { region: ix.region, regionName: REGIONS[ix.region] ?? ix.region, file: ix.file, at: ix.at, civics: ix.civics, streets: Object.keys(ix.streets).length } : null;
    },
  };
}
export type Anncsu = ReturnType<typeof createAnncsu>;
