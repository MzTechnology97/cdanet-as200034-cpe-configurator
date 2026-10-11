import { inflateSync } from 'node:zlib';

/**
 * Tree heights for the coverage model: the canopy height map of Meta and the World Resources
 * Institute (CHM v2, ~1 m, CC BY 4.0, public on AWS Open Data). Its Cloud Optimized GeoTIFFs (one
 * per zoom-10 Web Mercator tile, uint8 metres, DEFLATE, 512 px blocks, overviews) are read over
 * HTTP by ranges: only the ~4 m overview and only the blocks over the area of the network, never
 * the whole files. On the terrain grid every point gets the tallest tree around it.
 */

export const CANOPY_URL = (quadkey: string) => `https://dataforgood-fb-data.s3.amazonaws.com/forests/v2/global/dinov3_global_chm_v2_ml3/chm/${quadkey}.tif`;
export const CANOPY_ZOOM = 10;
/** Overview read: 8192 px per zoom-10 tile (~3.8 m in Sicily). */
export const CANOPY_LEVEL_PX = 8192;
/** Below this a "tree" is grass, a hedge or noise of the model. */
export const MIN_TREE_M = 3;

export function quadkey(x: number, y: number, z: number): string {
  let q = '';
  for (let i = z; i > 0; i--) {
    const m = 1 << (i - 1);
    q += String((x & m ? 1 : 0) + (y & m ? 2 : 0));
  }
  return q;
}

const mercX = (lon: number, n: number) => ((lon + 180) / 360) * n;
const mercY = (lat: number, n: number) => ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n;

type Range = (url: string, start: number, length: number) => Promise<Buffer | null>;

interface Level {
  width: number;
  tile: number;
  offsets: number[];
  counts: number[];
}

/** The image of [wantPx] width in a COG: its block size and where the blocks are. Null: no file. */
async function openLevel(range: Range, url: string, wantPx: number): Promise<Level | null> {
  const head = await range(url, 0, 65536);
  if (!head || head.length < 16) return null;
  const le = head.toString('latin1', 0, 2) === 'II';
  const big = (le ? head.readUInt16LE(2) : head.readUInt16BE(2)) === 43;
  let buf = head;
  const u16 = (b: Buffer, o: number) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (b: Buffer, o: number) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const u64 = (b: Buffer, o: number) => Number(le ? b.readBigUInt64LE(o) : b.readBigUInt64BE(o));
  const need = async (o: number, n: number) => {
    if (o + n > buf.length) {
      const more = await range(url, 0, Math.max(o + n, buf.length * 2));
      if (!more || more.length < o + n) throw new Error('canopy: header too short');
      buf = more;
    }
  };
  let ifd = big ? u64(buf, 8) : u32(buf, 4);
  for (let guard = 0; ifd && guard < 20; guard++) {
    await need(ifd, 8);
    const n = big ? u64(buf, ifd) : u16(buf, ifd);
    const es = big ? 20 : 12;
    await need(ifd, (big ? 8 : 2) + n * es + 8);
    const tags = new Map<number, { type: number; count: number; at: number }>();
    for (let i = 0; i < n; i++) {
      const e = ifd + (big ? 8 : 2) + i * es;
      tags.set(u16(buf, e), { type: u16(buf, e + 2), count: big ? u64(buf, e + 4) : u32(buf, e + 4), at: e + (big ? 12 : 8) });
    }
    const one = (t: number) => {
      const v = tags.get(t);
      if (!v) return null;
      return v.type === 3 ? u16(buf, v.at) : v.type === 16 ? u64(buf, v.at) : u32(buf, v.at);
    };
    const width = one(256);
    const bits = one(258);
    if (width === wantPx && bits === 8) {
      if (one(259) !== 8 && one(259) !== 32946) throw new Error(`canopy: compression ${one(259)}`);
      const arr = async (t: number) => {
        const v = tags.get(t)!;
        const size = v.type === 16 ? 8 : v.type === 3 ? 2 : 4;
        const inline = v.count * size <= (big ? 8 : 4);
        const at = inline ? v.at : big ? u64(buf, v.at) : u32(buf, v.at);
        await need(at, v.count * size);
        return Array.from({ length: v.count }, (_, i) => (size === 8 ? u64(buf, at + i * 8) : size === 2 ? u16(buf, at + i * 2) : u32(buf, at + i * 4)));
      };
      return { width, tile: one(322) ?? 512, offsets: await arr(324), counts: await arr(325) };
    }
    ifd = big ? u64(buf, ifd + 8 + n * es) : u32(buf, ifd + 2 + n * es);
  }
  return null;
}

/** HTTP range reader (null when the file does not exist: sea, outside the coverage). */
export function httpRange(fetchImpl: typeof fetch = fetch): Range {
  return async (url, start, length) => {
    const r = await fetchImpl(url, { headers: { Range: `bytes=${start}-${start + length - 1}` }, signal: AbortSignal.timeout(120_000) });
    if (r.status === 404 || r.status === 403) return null;
    if (!r.ok) throw new Error(`canopy: HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  };
}

/**
 * Reader of tree heights: heights at Web Mercator pixels of the overview, blocks fetched once and
 * kept while an area is converted. [bytes] counts what was read from the network.
 */
export function createCanopyReader(range: Range) {
  const levels = new Map<string, Promise<Level | null>>();
  const blocks = new Map<string, Promise<Uint8Array | null>>();
  let bytes = 0;
  const counted: Range = async (u, s, l) => {
    const b = await range(u, s, l);
    bytes += b?.length ?? 0;
    return b;
  };
  async function block(qk: string, bx: number, by: number): Promise<Uint8Array | null> {
    const key = `${qk}/${bx}/${by}`;
    let p = blocks.get(key);
    if (!p) {
      p = (async () => {
        let lv = levels.get(qk);
        if (!lv) levels.set(qk, (lv = openLevel(counted, CANOPY_URL(qk), CANOPY_LEVEL_PX)));
        const l = await lv;
        if (!l) return null;
        const per = Math.ceil(l.width / l.tile);
        const i = by * per + bx;
        if (!l.counts[i]) return null;
        const raw = await counted(CANOPY_URL(qk), l.offsets[i]!, l.counts[i]!);
        return raw ? new Uint8Array(inflateSync(raw)) : null;
      })();
      blocks.set(key, p);
    }
    return p;
  }
  const ready = new Map<string, Uint8Array | null>();
  /** Fetches (a few at a time) every block of the overview over a box of degrees. */
  async function ensure(b: { north: number; south: number; west: number; east: number }) {
    const n = 2 ** CANOPY_ZOOM;
    const P = CANOPY_LEVEL_PX;
    const x0 = Math.floor(mercX(b.west, n) * P) - 2;
    const x1 = Math.floor(mercX(b.east, n) * P) + 2;
    const y0 = Math.floor(mercY(b.north, n) * P) - 2;
    const y1 = Math.floor(mercY(b.south, n) * P) + 2;
    const jobs: Array<[string, number, number]> = [];
    for (let by = Math.floor(y0 / 512); by <= Math.floor(y1 / 512); by++) {
      for (let bx = Math.floor(x0 / 512); bx <= Math.floor(x1 / 512); bx++) {
        const per = P / 512;
        const qk = quadkey(Math.floor(bx / per), Math.floor(by / per), CANOPY_ZOOM);
        const key = `${qk}/${bx % per}/${by % per}`;
        if (!ready.has(key)) jobs.push([qk, bx % per, by % per]);
      }
    }
    for (let k = 0; k < jobs.length; k += 8) {
      await Promise.all(jobs.slice(k, k + 8).map(async ([qk, bx, by]) => ready.set(`${qk}/${bx}/${by}`, await block(qk, bx, by))));
    }
  }
  /** Tallest tree (m) within [radiusPx] pixels of the overview around a point (blocks ensured); 0 = none. */
  function maxAround(lat: number, lon: number, radiusPx = 1): number {
    const n = 2 ** CANOPY_ZOOM;
    const P = CANOPY_LEVEL_PX;
    const per = P / 512;
    const gx = Math.floor(mercX(lon, n) * P);
    const gy = Math.floor(mercY(lat, n) * P);
    let top = 0;
    for (let dy = -radiusPx; dy <= radiusPx; dy++) {
      for (let dx = -radiusPx; dx <= radiusPx; dx++) {
        const x = gx + dx;
        const y = gy + dy;
        const bx = Math.floor(x / 512);
        const by = Math.floor(y / 512);
        const b = ready.get(`${quadkey(Math.floor(bx / per), Math.floor(by / per), CANOPY_ZOOM)}/${bx % per}/${by % per}`);
        const v = b ? b[(y - by * 512) * 512 + (x - bx * 512)]! : 0;
        if (v > top && v < 255) top = v;
      }
    }
    return top;
  }
  return {
    get bytes() {
      return bytes;
    },
    ensure,
    maxAround,
    /** Forget the blocks (between areas): memory stays bounded. */
    clear() {
      blocks.clear();
      ready.clear();
    },
  };
}

/**
 * Tree heights over one terrain tile ([side]×[side] points from the north-west corner every
 * [step] degrees): the tallest tree within ~6 m of each point, 0 below MIN_TREE_M.
 */
export async function rasterizeCanopy(reader: ReturnType<typeof createCanopyReader>, box: { north: number; west: number; step: number; side: number }): Promise<Uint8Array> {
  const { north, west, step, side } = box;
  const grid = new Uint8Array(side * side);
  await reader.ensure({ north, south: north - step * (side - 1), west, east: west + step * (side - 1) });
  for (let gy = 0; gy < side; gy++) {
    const lat = north - gy * step;
    for (let gx = 0; gx < side; gx++) {
      const h = reader.maxAround(lat, west + gx * step, 1);
      grid[gy * side + gx] = h >= MIN_TREE_M ? h : 0;
    }
  }
  return grid;
}
