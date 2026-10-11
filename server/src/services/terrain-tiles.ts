import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import type { Bbox, TerrainSampler } from './terrain-store.ts';

/**
 * Elevation tiles for the 3D map (admins): the same terrain as the coverage model (TINITALY where
 * imported, SRTM elsewhere) as Web Mercator PNG tiles in the Terrarium encoding, which MapLibre
 * reads as a raster-dem source: height = R·256 + G + B/256 − 32768 metres.
 */

export const TERRAIN_MIN_ZOOM = 10;
export const TERRAIN_MAX_ZOOM = 14;
export const TERRAIN_TILE_PX = 256;

const lonOf = (x: number, n: number) => (x / n) * 360 - 180;
const latOf = (y: number, n: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;

/** Geographic box of a tile (z/x/y, Web Mercator). */
export function tileBbox(z: number, x: number, y: number): Bbox {
  const n = 2 ** z;
  return { minLat: latOf(y + 1, n), maxLat: latOf(y, n), minLon: lonOf(x, n), maxLon: lonOf(x + 1, n) };
}

/** Terrarium colour of a height (m): sea level and unknown ground are 0. */
export function terrarium(h: number): [number, number, number] {
  const v = Math.max(0, Math.min(65535.99, h + 32768));
  const i = Math.floor(v);
  return [i >> 8, i & 255, Math.floor((v - i) * 256)];
}

/** Height (m) of a Terrarium colour. */
export const fromTerrarium = (r: number, g: number, b: number) => r * 256 + g + b / 256 - 32768;

/** Minimal PNG (8-bit RGB, no filter): zlib of the rows, CRC of each chunk. */
export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/** One Terrarium tile from [at]: the height at the centre of every pixel. */
export function terrainTilePng(at: TerrainSampler, z: number, x: number, y: number, px = TERRAIN_TILE_PX): Buffer {
  const n = 2 ** z * px;
  const rgb = new Uint8Array(px * px * 3);
  for (let j = 0; j < px; j++) {
    const lat = latOf(y * px + j + 0.5, n);
    for (let i = 0; i < px; i++) {
      const h = at.ground(lat, lonOf(x * px + i + 0.5, n)) ?? 0;
      rgb.set(terrarium(h), (j * px + i) * 3);
    }
  }
  return encodePng(px, px, rgb);
}

/**
 * Tiles for the 3D map, kept in memory (the latest [max]) and, with [dir], on disk: making one
 * takes seconds the first time, then it is read back even after a restart. The terrain changes
 * only when the admin imports it again ([version]): the old tiles on disk are then thrown away.
 */
export function createTerrainTiles(opts: { sampler: (b: Bbox) => Promise<TerrainSampler | null>; version: () => string; max?: number; dir?: string }) {
  let diskVersion: string | null = null;
  /** Folder of this terrain version (the others removed). */
  const folder = (ver: string) => {
    if (!opts.dir) return null;
    const safe = ver.replace(/[^\w.-]/g, '_');
    if (diskVersion !== safe) {
      mkdirSync(opts.dir, { recursive: true });
      const mark = join(opts.dir, 'version');
      const old = existsSync(mark) ? readFileSync(mark, 'utf8') : null;
      if (old !== safe) {
        rmSync(join(opts.dir, 'tiles'), { recursive: true, force: true });
        writeFileSync(mark, safe);
      }
      diskVersion = safe;
    }
    return join(opts.dir, 'tiles');
  };
  const cache = new Map<string, Buffer | null>();
  const max = opts.max ?? 400;
  const running = new Map<string, Promise<Buffer | null>>();
  return {
    async tile(z: number, x: number, y: number): Promise<Buffer | null> {
      const key = `${opts.version()}/${z}/${x}/${y}`;
      if (cache.has(key)) {
        const v = cache.get(key)!;
        cache.delete(key);
        cache.set(key, v);
        return v;
      }
      const busy = running.get(key);
      if (busy) return busy;
      const job = (async () => {
        const dir = folder(opts.version());
        const file = dir ? join(dir, String(z), String(x), `${y}.png`) : null;
        if (file && existsSync(file)) {
          const png = readFileSync(file);
          cache.set(key, png);
          return png;
        }
        const at = await opts.sampler(tileBbox(z, x, y));
        const png = at ? terrainTilePng(at, z, x, y) : null;
        if (png && file) {
          mkdirSync(join(dir!, String(z), String(x)), { recursive: true });
          writeFileSync(file, png);
        }
        cache.set(key, png);
        while (cache.size > max) cache.delete(cache.keys().next().value!);
        return png;
      })().finally(() => running.delete(key));
      running.set(key, job);
      return job;
    },
  };
}
