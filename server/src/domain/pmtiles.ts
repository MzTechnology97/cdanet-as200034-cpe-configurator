import { open, type FileHandle } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

/**
 * Minimal PMTiles v3 reader: the server answers /map/tiles/{z}/{x}/{y} from the basemap file, so
 * clients make ordinary requests instead of byte ranges (some Android WebViews fail on those).
 * Spec: https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md
 */

export interface PmHeader {
  rootOffset: number;
  rootLength: number;
  leafOffset: number;
  tileDataOffset: number;
  internalCompression: number;
  tileCompression: number;
  tileType: number;
  minZoom: number;
  maxZoom: number;
}

export interface DirEntry {
  tileId: number;
  offset: number;
  length: number;
  runLength: number;
}

/** Compression codes of the spec. */
export const COMPRESSION = { none: 1, gzip: 2 } as const;

const u64 = (b: Buffer, at: number) => Number(b.readBigUInt64LE(at));

export function parseHeader(b: Buffer): PmHeader {
  if (b.length < 127 || b.toString('latin1', 0, 7) !== 'PMTiles' || b[7] !== 3) throw new Error('not a PMTiles v3 archive');
  return {
    rootOffset: u64(b, 8),
    rootLength: u64(b, 16),
    leafOffset: u64(b, 40),
    tileDataOffset: u64(b, 56),
    internalCompression: b[97]!,
    tileCompression: b[98]!,
    tileType: b[99]!,
    minZoom: b[100]!,
    maxZoom: b[101]!,
  };
}

/** Hilbert-curve tile id of z/x/y (tiles of the lower zooms come first). */
export function zxyToTileId(z: number, x: number, y: number): number {
  if (z > 26) throw new Error('zoom too high');
  const n = 2 ** z;
  if (x < 0 || y < 0 || x >= n || y >= n) throw new Error('tile outside the zoom level');
  let acc = (4 ** z - 1) / 3;
  let tx = x;
  let ty = y;
  for (let s = n / 2; s >= 1; s /= 2) {
    const rx = (tx & s) > 0 ? 1 : 0;
    const ry = (ty & s) > 0 ? 1 : 0;
    acc += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) {
        tx = s - 1 - tx;
        ty = s - 1 - ty;
      }
      [tx, ty] = [ty, tx];
    }
  }
  return acc;
}

function decompress(b: Buffer, compression: number): Buffer {
  if (compression === COMPRESSION.gzip) return gunzipSync(b);
  if (compression === COMPRESSION.none || compression === 0) return b;
  throw new Error(`compression ${compression} not supported`);
}

/** Directory: varint columns (tile id deltas, run lengths, lengths, offsets). */
export function parseDirectory(raw: Buffer): DirEntry[] {
  let pos = 0;
  const varint = () => {
    let v = 0;
    let mul = 1;
    for (;;) {
      const byte = raw[pos++];
      if (byte === undefined) throw new Error('truncated directory');
      v += (byte & 0x7f) * mul;
      if (byte < 0x80) return v;
      mul *= 128;
    }
  };
  const n = varint();
  const entries: DirEntry[] = [];
  let last = 0;
  for (let i = 0; i < n; i++) {
    last += varint();
    entries.push({ tileId: last, offset: 0, length: 0, runLength: 0 });
  }
  for (const e of entries) e.runLength = varint();
  for (const e of entries) e.length = varint();
  entries.forEach((e, i) => {
    const v = varint();
    e.offset = v === 0 && i > 0 ? entries[i - 1]!.offset + entries[i - 1]!.length : v - 1;
  });
  return entries;
}

/** The entry covering [tileId]: a tile (runLength > 0) or a leaf directory (runLength 0). */
export function findEntry(entries: DirEntry[], tileId: number): DirEntry | null {
  let lo = 0;
  let hi = entries.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = entries[mid]!.tileId - tileId;
    if (c === 0) return entries[mid]!;
    if (c < 0) lo = mid + 1;
    else hi = mid - 1;
  }
  const e = hi >= 0 ? entries[hi]! : null;
  if (!e) return null;
  if (e.runLength === 0) return e;
  return tileId - e.tileId < e.runLength ? e : null;
}

export class PmTilesReader {
  private header: PmHeader | null = null;
  /**
   * One file handle for every read. The promise is kept, not the handle: concurrent first requests
   * (a map asks for many tiles at once) would otherwise open the file several times, and the
   * handles left behind are closed by the garbage collector, which ends the process on Node 26.
   */
  private fh: Promise<FileHandle> | null = null;
  private dirs = new Map<string, DirEntry[]>();
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  private async read(offset: number, length: number): Promise<Buffer> {
    this.fh ??= open(this.file, 'r');
    const fh = await this.fh.catch((e: unknown) => {
      this.fh = null; // missing file now: a later request may succeed
      throw e;
    });
    const b = Buffer.alloc(length);
    const { bytesRead } = await fh.read(b, 0, length, offset);
    return b.subarray(0, bytesRead);
  }

  async getHeader(): Promise<PmHeader> {
    this.header ??= parseHeader(await this.read(0, 127));
    return this.header;
  }

  private async directory(offset: number, length: number): Promise<DirEntry[]> {
    const key = `${offset}:${length}`;
    const hit = this.dirs.get(key);
    if (hit) return hit;
    const h = await this.getHeader();
    const entries = parseDirectory(decompress(await this.read(offset, length), h.internalCompression));
    if (this.dirs.size > 256) this.dirs.delete(this.dirs.keys().next().value as string); // small LRU-ish cache
    this.dirs.set(key, entries);
    return entries;
  }

  /** Tile bytes as stored (compressed with header.tileCompression), or null when absent. */
  async tile(z: number, x: number, y: number): Promise<Buffer | null> {
    const h = await this.getHeader();
    if (z < h.minZoom || z > h.maxZoom) return null;
    const id = zxyToTileId(z, x, y);
    let dir = await this.directory(h.rootOffset, h.rootLength);
    for (let depth = 0; depth < 4; depth++) {
      const e = findEntry(dir, id);
      if (!e) return null;
      if (e.runLength > 0) return this.read(h.tileDataOffset + e.offset, e.length);
      dir = await this.directory(h.leafOffset + e.offset, e.length);
    }
    return null;
  }

  async close(): Promise<void> {
    const fh = this.fh;
    this.fh = null;
    await (await fh?.catch(() => null))?.close();
  }
}
