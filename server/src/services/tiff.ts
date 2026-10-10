import { closeSync, openSync, readSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

/**
 * Minimal GeoTIFF reader for the terrain import (TINITALY, ESA WorldCover): first image only,
 * one band, strips or tiles, no compression or DEFLATE, no predictor, 8-bit unsigned or 32-bit
 * float samples. Reads windows from disk without loading the whole file.
 */

export interface GeoTiff {
  width: number;
  height: number;
  /** Top-left corner of the top-left pixel and pixel size, in the file's coordinates. */
  originX: number;
  originY: number;
  pixelX: number;
  pixelY: number;
  /** EPSG code of the projection (32632 = UTM 32N, 4326 = WGS 84). */
  epsg: number | null;
  nodata: number | null;
  /** Samples of [w]×[h] pixels from (x0, y0), row by row; pixels outside the image are NaN. */
  read(x0: number, y0: number, w: number, h: number): Float32Array;
  close(): void;
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8 };

export function openGeoTiff(path: string): GeoTiff {
  const fd = openSync(path, 'r');
  const at = (n: number, pos: number) => {
    const b = Buffer.alloc(n);
    readSync(fd, b, 0, n, pos);
    return b;
  };
  const head = at(16, 0);
  const le = head.toString('latin1', 0, 2) === 'II';
  const big = (le ? head.readUInt16LE(2) : head.readUInt16BE(2)) === 43;
  const u16 = (b: Buffer, o: number) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (b: Buffer, o: number) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  const u64 = (b: Buffer, o: number) => Number(le ? b.readBigUInt64LE(o) : b.readBigUInt64BE(o));
  const f64 = (b: Buffer, o: number) => (le ? b.readDoubleLE(o) : b.readDoubleBE(o));
  const ifd = big ? u64(head, 8) : u32(head, 4);
  const count = big ? u64(at(8, ifd), 0) : u16(at(2, ifd), 0);
  const esz = big ? 20 : 12;
  const body = at(count * esz, ifd + (big ? 8 : 2));
  const tags = new Map<number, number[] | string>();
  for (let i = 0; i < count; i++) {
    const o = i * esz;
    const tag = u16(body, o);
    const type = u16(body, o + 2);
    const n = big ? u64(body, o + 4) : u32(body, o + 4);
    const bytes = (TYPE_SIZE[type] ?? 1) * n;
    const inline = bytes <= (big ? 8 : 4);
    const vb = inline ? body.subarray(o + (big ? 12 : 8), o + esz) : at(bytes, big ? u64(body, o + 12) : u32(body, o + 8));
    if (type === 2) {
      tags.set(tag, vb.toString('latin1').replace(/\0+$/, ''));
      continue;
    }
    const v: number[] = [];
    for (let k = 0; k < n; k++) {
      if (type === 3) v.push(u16(vb, k * 2));
      else if (type === 4) v.push(u32(vb, k * 4));
      else if (type === 16) v.push(u64(vb, k * 8));
      else if (type === 12) v.push(f64(vb, k * 8));
      else if (type === 1) v.push(vb[k]!);
    }
    tags.set(tag, v);
  }
  const num = (t: number) => (tags.get(t) as number[] | undefined)?.[0];
  const arr = (t: number) => (tags.get(t) as number[] | undefined) ?? [];
  const width = num(256)!;
  const height = num(257)!;
  const bits = num(258) ?? 8;
  const format = num(339) ?? 1;
  const compression = num(259) ?? 1;
  if (![1, 8, 32946].includes(compression)) throw new Error(`TIFF: compressione ${compression} non supportata`);
  if ((num(317) ?? 1) !== 1) throw new Error('TIFF: predictor non supportato');
  if (!((bits === 8 && format === 1) || (bits === 32 && format === 3))) throw new Error(`TIFF: campioni ${bits} bit formato ${format} non supportati`);
  const tiled = tags.has(322);
  const bw = tiled ? num(322)! : width;
  const bh = tiled ? num(323)! : (num(278) ?? height);
  const offsets = arr(tiled ? 324 : 273);
  const lengths = arr(tiled ? 325 : 279);
  const across = Math.ceil(width / bw);
  const scale = arr(33550);
  const tie = arr(33922);
  const keys = arr(34735);
  let epsg: number | null = null;
  for (let k = 4; k + 3 < keys.length; k += 4) if (keys[k] === 3072 || keys[k] === 2048) epsg = keys[k + 3]!;
  const nd = tags.get(42113);
  const nodata = typeof nd === 'string' && nd.trim() !== '' ? Number(nd) : null;

  // blocks (strips or tiles) decoded on demand, the last few kept
  const cache = new Map<number, Buffer>();
  const block = (i: number) => {
    let b = cache.get(i);
    if (!b) {
      const raw = at(lengths[i]!, offsets[i]!);
      b = compression === 1 ? raw : inflateSync(raw);
      cache.set(i, b);
      if (cache.size > 64) cache.delete(cache.keys().next().value!);
    }
    return b;
  };
  const sample = (b: Buffer, idx: number) => (bits === 8 ? b[idx]! : le ? b.readFloatLE(idx * 4) : b.readFloatBE(idx * 4));

  return {
    width,
    height,
    originX: (tie[3] ?? 0) - (tie[0] ?? 0) * (scale[0] ?? 1),
    originY: (tie[4] ?? 0) + (tie[1] ?? 0) * (scale[1] ?? 1),
    pixelX: scale[0] ?? 1,
    pixelY: scale[1] ?? 1,
    epsg,
    nodata,
    read(x0, y0, w, h) {
      const out = new Float32Array(w * h).fill(Number.NaN);
      for (let y = Math.max(0, y0); y < Math.min(height, y0 + h); y++) {
        const by = Math.floor(y / bh);
        for (let bx = Math.floor(Math.max(0, x0) / bw); bx * bw < Math.min(width, x0 + w); bx++) {
          const b = block(by * across + bx);
          const rowInBlock = y - by * bh;
          const xa = Math.max(x0, bx * bw, 0);
          const xb = Math.min(x0 + w, (bx + 1) * bw, width);
          for (let x = xa; x < xb; x++) out[(y - y0) * w + (x - x0)] = sample(b, rowInBlock * bw + (x - bx * bw)) as number;
        }
      }
      return out;
    },
    close() {
      cache.clear();
      closeSync(fd);
    },
  };
}
