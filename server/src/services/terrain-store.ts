import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gunzipSync, gzipSync } from 'node:zlib';
import { toUtm } from '../domain/utm.ts';
import type { Dem } from './dem.ts';
import { openGeoTiff } from './tiff.ts';
import { extractZipEntry } from './zip.ts';

/**
 * Terrain and obstacles for the coverage model and Visibilità, kept on the server in tiles of
 * 0.1° × 0.1° on a geographic grid of 1/10800° (~10 m):
 * - dtm/: ground elevation from TINITALY 1.1 (INGV, 10 m, CC BY 4.0), decimetres;
 * - cover/: land cover from ESA WorldCover 2021 (10 m, CC BY 4.0): trees, shrubs, buildings…
 * Imported on demand by the admin for the area of the network (downloads, converts, deletes the
 * originals). Where there is no tile, the elevation comes from the SRTM model (dem.ts) as before.
 */

export const TILE_DEG = 0.1;
/** Grid intervals per tile side: points from 0 to GRID included (edges shared with the neighbours). */
export const GRID = 1080;
const STEP = TILE_DEG / GRID;
const SIDE = GRID + 1;
const DTM_NONE = 65535;

export interface Bbox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

/** Synchronous terrain for an area: ground elevation (m a.s.l.) and land cover class (WorldCover code). */
export interface TerrainSampler {
  ground(lat: number, lon: number): number | null;
  cover(lat: number, lon: number): number | null;
  /** Elevation from TINITALY for at least part of the area (else SRTM only). */
  fine: boolean;
}

export interface TerrainImportState {
  running: boolean;
  phase: string;
  done: number;
  total: number;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

interface Manifest {
  tinitaly: string[];
  worldcover: string[];
  dtmTiles: number;
  coverTiles: number;
  updatedAt: string | null;
}

export const TINITALY_PAGE = 'https://tinitaly.pi.ingv.it/Download_Area1_1.html';
export const WORLDCOVER_URL = (name: string) => `https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_${name}_Map.tif`;

const tileKey = (iy: number, ix: number) => `${iy}_${ix}`;
const tileOf = (lat: number, lon: number) => ({ iy: Math.floor(lat / TILE_DEG + 1e-9), ix: Math.floor(lon / TILE_DEG + 1e-9) });

/** Approximate UTM 32 extent of a TINITALY tile from its name (e41005: E 1050 km, N 4100 km): generous, the file has the real one. */
export function tinitalyExtent(name: string): { e0: number; e1: number; n0: number; n1: number } | null {
  const m = /^([ew])(\d{3})(\d{2})$/.exec(name);
  if (!m) return null;
  const n0 = Number(m[2]) * 10_000;
  const e0 = (m[1] === 'e' ? 1_000_000 : 0) + Number(m[3]) * 10_000;
  return { e0: e0 - 1000, e1: e0 + 101_000, n0: n0 - 1000, n1: n0 + 51_000 };
}

/** WorldCover 3° tiles covering an area ("N36E012"…). */
export function worldCoverTiles(b: Bbox): string[] {
  const out: string[] = [];
  for (let la = Math.floor(b.minLat / 3) * 3; la <= b.maxLat; la += 3) {
    for (let lo = Math.floor(b.minLon / 3) * 3; lo <= b.maxLon; lo += 3) {
      out.push(`${la >= 0 ? 'N' : 'S'}${String(Math.abs(la)).padStart(2, '0')}${lo >= 0 ? 'E' : 'W'}${String(Math.abs(lo)).padStart(3, '0')}`);
    }
  }
  return out;
}

export function createTerrainStore(opts: { dir: string; dem: Dem; fetchImpl?: typeof fetch; maxTiles?: number; log?: (m: string) => void }) {
  const f = opts.fetchImpl ?? fetch;
  const max = opts.maxTiles ?? 160;
  const dtmDir = join(opts.dir, 'dtm');
  const coverDir = join(opts.dir, 'cover');
  const tmpDir = join(opts.dir, 'tmp');
  const dtm = new Map<string, Uint16Array | null>();
  const cover = new Map<string, Uint8Array | null>();
  const state: TerrainImportState = { running: false, phase: '', done: 0, total: 0, error: null, startedAt: null, finishedAt: null };

  const manifestPath = join(opts.dir, 'manifest.json');
  const manifest = (): Manifest => {
    try {
      return JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
    } catch {
      return { tinitaly: [], worldcover: [], dtmTiles: 0, coverTiles: 0, updatedAt: null };
    }
  };

  function cached<T>(m: Map<string, T | null>, key: string, load: () => T | null): T | null {
    if (m.has(key)) {
      const v = m.get(key)!;
      m.delete(key);
      m.set(key, v);
      return v;
    }
    const v = load();
    m.set(key, v);
    while (m.size > max) m.delete(m.keys().next().value!);
    return v;
  }
  const readTile = (dir: string, key: string) => {
    const p = join(dir, `${key}.bin.gz`);
    return existsSync(p) ? gunzipSync(readFileSync(p)) : null;
  };
  const dtmTile = (iy: number, ix: number) =>
    cached(dtm, tileKey(iy, ix), () => {
      const b = readTile(dtmDir, tileKey(iy, ix));
      return b ? new Uint16Array(b.buffer, b.byteOffset, b.length / 2) : null;
    });
  const coverTile = (iy: number, ix: number) =>
    cached(cover, tileKey(iy, ix), () => {
      const b = readTile(coverDir, tileKey(iy, ix));
      return b ? new Uint8Array(b.buffer, b.byteOffset, b.length) : null;
    });

  /** Position of a point inside its tile: grid coordinates from the north-west corner. */
  const gridPos = (lat: number, lon: number) => {
    const { iy, ix } = tileOf(lat, lon);
    return { iy, ix, gx: (lon - ix * TILE_DEG) / STEP, gy: ((iy + 1) * TILE_DEG - lat) / STEP };
  };

  function fineGround(lat: number, lon: number): number | null {
    const { iy, ix, gx, gy } = gridPos(lat, lon);
    const t = dtmTile(iy, ix);
    if (!t) return null;
    const x0 = Math.min(GRID - 1, Math.max(0, Math.floor(gx)));
    const y0 = Math.min(GRID - 1, Math.max(0, Math.floor(gy)));
    const fx = Math.min(1, Math.max(0, gx - x0));
    const fy = Math.min(1, Math.max(0, gy - y0));
    const v = [t[y0 * SIDE + x0]!, t[y0 * SIDE + x0 + 1]!, t[(y0 + 1) * SIDE + x0]!, t[(y0 + 1) * SIDE + x0 + 1]!];
    if (v.some((x) => x === DTM_NONE)) {
      const ok = v.filter((x) => x !== DTM_NONE);
      return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length / 10 : null;
    }
    return ((v[0]! * (1 - fx) + v[1]! * fx) * (1 - fy) + (v[2]! * (1 - fx) + v[3]! * fx) * fy) / 10;
  }

  function coverAt(lat: number, lon: number): number | null {
    const { iy, ix, gx, gy } = gridPos(lat, lon);
    const t = coverTile(iy, ix);
    if (!t) return null;
    const v = t[Math.min(GRID, Math.round(gy)) * SIDE + Math.min(GRID, Math.round(gx))]!;
    return v === 0 ? null : v;
  }

  async function sampler(b: Bbox): Promise<TerrainSampler | null> {
    const srtm = await opts.dem.sampler(b.minLat, b.minLon, b.maxLat, b.maxLon);
    const { iy: y0, ix: x0 } = tileOf(b.minLat, b.minLon);
    const { iy: y1, ix: x1 } = tileOf(b.maxLat, b.maxLon);
    let fine = false;
    for (let y = y0; y <= y1 && !fine; y++) for (let x = x0; x <= x1 && !fine; x++) fine = existsSync(join(dtmDir, `${tileKey(y, x)}.bin.gz`));
    if (!fine && !srtm) return null;
    const hasCover = existsSync(coverDir);
    return {
      fine,
      ground: (lat, lon) => (fine ? fineGround(lat, lon) : null) ?? srtm?.(lat, lon) ?? null,
      cover: (lat, lon) => (hasCover ? coverAt(lat, lon) : null),
    };
  }

  // ---- import ------------------------------------------------------------------------------

  async function download(url: string, to: string) {
    const r = await f(url, { signal: AbortSignal.timeout(30 * 60_000) });
    if (!r.ok || !r.body) throw new Error(`download ${url}: HTTP ${r.status}`);
    await pipeline(Readable.fromWeb(r.body as never), createWriteStream(to));
  }

  /** Output tiles of an area, row by row. */
  const tilesOf = (b: Bbox) => {
    const out: Array<{ iy: number; ix: number }> = [];
    const a = tileOf(b.minLat, b.minLon);
    const z = tileOf(b.maxLat - 1e-9, b.maxLon - 1e-9);
    for (let iy = a.iy; iy <= z.iy; iy++) for (let ix = a.ix; ix <= z.ix; ix++) out.push({ iy, ix });
    return out;
  };

  /** TINITALY GeoTIFF (UTM 32N) → elevation of the grid points of the tiles of [area] it covers (merged in tmp). */
  function convertTinitaly(tifPath: string, area: Bbox) {
    const t = openGeoTiff(tifPath);
    try {
      if (t.epsg !== 32632) throw new Error(`TINITALY: proiezione ${t.epsg} inattesa (atteso UTM 32N)`);
      const eMin = t.originX;
      const eMax = t.originX + t.width * t.pixelX;
      const nMax = t.originY;
      const nMin = t.originY - t.height * t.pixelY;
      for (const { iy, ix } of tilesOf(area)) {
        // UTM of the grid on a coarse lattice (every 20 points), interpolated in between: TM is smooth
        const K = 20;
        const lat = (gy: number) => (iy + 1) * TILE_DEG - gy * STEP;
        const lon = (gx: number) => ix * TILE_DEG + gx * STEP;
        const L = GRID / K + 1;
        const ue = new Float64Array(L * L);
        const un = new Float64Array(L * L);
        for (let a = 0; a < L; a++) {
          for (let c = 0; c < L; c++) {
            const u = toUtm(lat(a * K), lon(c * K), 32);
            ue[a * L + c] = u.e;
            un[a * L + c] = u.n;
          }
        }
        const minE = Math.min(...ue);
        const maxE = Math.max(...ue);
        const minN = Math.min(...un);
        const maxN = Math.max(...un);
        if (maxE < eMin || minE > eMax || maxN < nMin || minN > nMax) continue;
        const px0 = Math.max(0, Math.floor((minE - t.originX) / t.pixelX) - 2);
        const px1 = Math.min(t.width - 1, Math.ceil((maxE - t.originX) / t.pixelX) + 2);
        const py0 = Math.max(0, Math.floor((t.originY - maxN) / t.pixelY) - 2);
        const py1 = Math.min(t.height - 1, Math.ceil((t.originY - minN) / t.pixelY) + 2);
        if (px1 <= px0 || py1 <= py0) continue;
        const ww = px1 - px0 + 1;
        const win = t.read(px0, py0, ww, py1 - py0 + 1);
        const valid = (v: number) => Number.isFinite(v) && v !== t.nodata && v > -1000;
        const tmp = join(tmpDir, `dtm_${tileKey(iy, ix)}.bin`);
        const prev = existsSync(tmp) ? readFileSync(tmp) : readTile(dtmDir, tileKey(iy, ix));
        const out = prev ? new Uint16Array(prev.buffer.slice(prev.byteOffset, prev.byteOffset + prev.length)) : new Uint16Array(SIDE * SIDE).fill(DTM_NONE);
        let wrote = 0;
        for (let gy = 0; gy <= GRID; gy++) {
          const a = Math.min(L - 2, Math.floor(gy / K));
          const fa = gy / K - a;
          for (let gx = 0; gx <= GRID; gx++) {
            const c = Math.min(L - 2, Math.floor(gx / K));
            const fc = gx / K - c;
            const i00 = a * L + c;
            const e = (ue[i00]! * (1 - fc) + ue[i00 + 1]! * fc) * (1 - fa) + (ue[i00 + L]! * (1 - fc) + ue[i00 + L + 1]! * fc) * fa;
            const n = (un[i00]! * (1 - fc) + un[i00 + 1]! * fc) * (1 - fa) + (un[i00 + L]! * (1 - fc) + un[i00 + L + 1]! * fc) * fa;
            // pixel centres: (x + 0.5) * size from the origin
            const x = (e - t.originX) / t.pixelX - 0.5 - px0;
            const y = (t.originY - n) / t.pixelY - 0.5 - py0;
            if (x < 0 || y < 0 || x >= ww - 1 || y >= py1 - py0) continue;
            const x0 = Math.floor(x);
            const y0 = Math.floor(y);
            const fx = x - x0;
            const fy = y - y0;
            const q = [win[y0 * ww + x0]!, win[y0 * ww + x0 + 1]!, win[(y0 + 1) * ww + x0]!, win[(y0 + 1) * ww + x0 + 1]!];
            let h: number;
            if (q.every(valid)) h = (q[0]! * (1 - fx) + q[1]! * fx) * (1 - fy) + (q[2]! * (1 - fx) + q[3]! * fx) * fy;
            else {
              const ok = q.filter(valid);
              if (!ok.length) continue;
              h = ok.reduce((s, v) => s + v, 0) / ok.length;
            }
            out[gy * SIDE + gx] = Math.min(65534, Math.round(Math.max(0, h) * 10));
            wrote++;
          }
        }
        if (wrote) writeFileSync(tmp, Buffer.from(out.buffer));
      }
    } finally {
      t.close();
    }
  }

  /** WorldCover GeoTIFF (WGS 84) → land cover of the grid points of the tiles of [area] it covers. */
  function convertWorldCover(tifPath: string, area: Bbox) {
    const t = openGeoTiff(tifPath);
    try {
      const west = t.originX;
      const north = t.originY;
      const east = west + t.width * t.pixelX;
      const south = north - t.height * t.pixelY;
      mkdirSync(coverDir, { recursive: true });
      for (const { iy, ix } of tilesOf(area)) {
        const n0 = (iy + 1) * TILE_DEG;
        const w0 = ix * TILE_DEG;
        if (w0 >= east || w0 + TILE_DEG <= west || n0 <= south || n0 - TILE_DEG >= north) continue;
        const px0 = Math.max(0, Math.floor((w0 - west) / t.pixelX) - 1);
        const py0 = Math.max(0, Math.floor((north - n0) / t.pixelY) - 1);
        const ww = Math.min(t.width - px0, Math.ceil(TILE_DEG / t.pixelX) + 3);
        const hh = Math.min(t.height - py0, Math.ceil(TILE_DEG / t.pixelY) + 3);
        const win = t.read(px0, py0, ww, hh);
        const out = new Uint8Array(SIDE * SIDE);
        for (let gy = 0; gy <= GRID; gy++) {
          const y = Math.floor((north - (n0 - gy * STEP)) / t.pixelY) - py0;
          if (y < 0 || y >= hh) continue;
          for (let gx = 0; gx <= GRID; gx++) {
            const x = Math.floor((w0 + gx * STEP - west) / t.pixelX) - px0;
            if (x < 0 || x >= ww) continue;
            const v = win[y * ww + x]!;
            out[gy * SIDE + gx] = Number.isFinite(v) ? v : 0;
          }
        }
        writeFileSync(join(coverDir, `${tileKey(iy, ix)}.bin.gz`), gzipSync(Buffer.from(out.buffer), { level: 6 }));
        cover.delete(tileKey(iy, ix));
      }
    } finally {
      t.close();
    }
  }

  /**
   * Downloads and converts terrain (TINITALY) and land cover (WorldCover) for [area]: only the
   * source tiles not imported yet. Runs in the background; [state] says how far it is.
   */
  async function importArea(area: Bbox): Promise<void> {
    if (state.running) throw new Error('import_running');
    Object.assign(state, { running: true, phase: 'Elenco dei file', done: 0, total: 0, error: null, startedAt: new Date().toISOString(), finishedAt: null });
    const man = manifest();
    try {
      mkdirSync(tmpDir, { recursive: true });
      mkdirSync(dtmDir, { recursive: true });
      // TINITALY tiles touching the area (in UTM 32, with a margin)
      const corners = [
        toUtm(area.minLat, area.minLon, 32),
        toUtm(area.minLat, area.maxLon, 32),
        toUtm(area.maxLat, area.minLon, 32),
        toUtm(area.maxLat, area.maxLon, 32),
        toUtm((area.minLat + area.maxLat) / 2, area.minLon, 32),
        toUtm((area.minLat + area.maxLat) / 2, area.maxLon, 32),
      ];
      const E0 = Math.min(...corners.map((c) => c.e));
      const E1 = Math.max(...corners.map((c) => c.e));
      const N0 = Math.min(...corners.map((c) => c.n));
      const N1 = Math.max(...corners.map((c) => c.n));
      const page = await (await f(TINITALY_PAGE, { signal: AbortSignal.timeout(60_000) })).text();
      const names = [...new Set([...page.matchAll(/data_1\.1\/([ew]\d{5})_s10\/\1_s10\.zip/g)].map((m) => m[1]!))];
      const tin = names.filter((n) => {
        const x = tinitalyExtent(n);
        return x && x.e1 >= E0 && x.e0 <= E1 && x.n1 >= N0 && x.n0 <= N1 && !man.tinitaly.includes(n);
      });
      const wc = worldCoverTiles(area).filter((n) => !man.worldcover.includes(n));
      state.total = tin.length + wc.length;
      for (const n of tin) {
        state.phase = `Terreno TINITALY ${n}`;
        const zip = join(tmpDir, `${n}.zip`);
        const tif = join(tmpDir, `${n}.tif`);
        await download(new URL(`data_1.1/${n}_s10/${n}_s10.zip`, TINITALY_PAGE).href, zip);
        if (await extractZipEntry(zip, /\.tif$/i, tif)) convertTinitaly(tif, area);
        rmSync(zip, { force: true });
        rmSync(tif, { force: true });
        man.tinitaly.push(n);
        state.done++;
      }
      // merged elevation tiles: compressed into the store
      state.phase = 'Compressione del terreno';
      for (const file of readdirSync(tmpDir).filter((x) => x.startsWith('dtm_') && x.endsWith('.bin'))) {
        const key = file.slice(4, -4);
        writeFileSync(join(dtmDir, `${key}.bin.gz`), gzipSync(readFileSync(join(tmpDir, file)), { level: 6 }));
        rmSync(join(tmpDir, file), { force: true });
        dtm.delete(key);
      }
      for (const n of wc) {
        state.phase = `Suolo ESA WorldCover ${n}`;
        const tif = join(tmpDir, `wc_${n}.tif`);
        const r = await f(WORLDCOVER_URL(n), { method: 'HEAD', signal: AbortSignal.timeout(60_000) });
        if (r.ok) {
          await download(WORLDCOVER_URL(n), tif);
          convertWorldCover(tif, area);
          rmSync(tif, { force: true });
        }
        man.worldcover.push(n);
        state.done++;
      }
      man.dtmTiles = existsSync(dtmDir) ? readdirSync(dtmDir).length : 0;
      man.coverTiles = existsSync(coverDir) ? readdirSync(coverDir).length : 0;
      man.updatedAt = new Date().toISOString();
      writeFileSync(manifestPath, JSON.stringify(man));
      state.phase = 'Completato';
    } catch (err) {
      state.error = (err as Error).message;
      state.phase = 'Interrotto';
      opts.log?.(`terrain import: ${state.error}`);
      // what was converted so far is kept: a new import continues from there
      writeFileSync(manifestPath, JSON.stringify(man));
    } finally {
      state.running = false;
      state.finishedAt = new Date().toISOString();
    }
  }

  return {
    sampler,
    importArea,
    state: () => ({ ...state }),
    status: () => {
      const m = manifest();
      return { tinitaly: m.tinitaly.length, worldcover: m.worldcover.length, dtmTiles: m.dtmTiles, coverTiles: m.coverTiles, updatedAt: m.updatedAt, import: { ...state } };
    },
    /** For the tests: convert local files without downloading. */
    _convert: { tinitaly: convertTinitaly, worldCover: convertWorldCover, tmpDir, dtmDir },
  };
}
export type TerrainStore = ReturnType<typeof createTerrainStore>;
