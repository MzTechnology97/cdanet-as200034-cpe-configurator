import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { crc32, deflateRawSync, deflateSync } from 'node:zlib';
import { toUtm } from '../src/domain/utm.ts';
import { createDem } from '../src/services/dem.ts';
import { foliageLossDb, profileEffect, type BuiltProfile } from '../src/services/terrain.ts';
import { createTerrainStore, tinitalyExtent, worldCoverTiles } from '../src/services/terrain-store.ts';
import { openGeoTiff } from '../src/services/tiff.ts';

/** Little-endian classic TIFF: float32 strips (one row each) or uint8 DEFLATE tiles, with GeoTIFF tags. */
function geoTiff(o: { width: number; height: number; float?: Float32Array; bytes?: Uint8Array; tile?: number; scale: number; origin: [number, number]; epsg: number; nodata?: string }): Buffer {
  const parts: Buffer[] = [];
  let pos = 8;
  const add = (b: Buffer) => {
    const at = pos;
    parts.push(b);
    pos += b.length;
    if (pos % 2) {
      parts.push(Buffer.alloc(1));
      pos++;
    }
    return at;
  };
  const offsets: number[] = [];
  const counts: number[] = [];
  if (o.float) {
    for (let y = 0; y < o.height; y++) {
      const row = Buffer.from(o.float.buffer, o.float.byteOffset + y * o.width * 4, o.width * 4);
      offsets.push(add(Buffer.from(row)));
      counts.push(row.length);
    }
  } else {
    const t = o.tile!;
    for (let ty = 0; ty < Math.ceil(o.height / t); ty++) {
      for (let tx = 0; tx < Math.ceil(o.width / t); tx++) {
        const block = Buffer.alloc(t * t);
        for (let y = 0; y < t; y++) for (let x = 0; x < t; x++) if (ty * t + y < o.height && tx * t + x < o.width) block[y * t + x] = o.bytes![(ty * t + y) * o.width + tx * t + x]!;
        const z = deflateSync(block);
        offsets.push(add(z));
        counts.push(z.length);
      }
    }
  }
  const longs = (v: number[]) => {
    const b = Buffer.alloc(v.length * 4);
    v.forEach((x, i) => b.writeUInt32LE(x, i * 4));
    return b;
  };
  const doubles = (v: number[]) => {
    const b = Buffer.alloc(v.length * 8);
    v.forEach((x, i) => b.writeDoubleLE(x, i * 8));
    return b;
  };
  const shorts = (v: number[]) => {
    const b = Buffer.alloc(v.length * 2);
    v.forEach((x, i) => b.writeUInt16LE(x, i * 2));
    return b;
  };
  const geoKeys = [1, 1, 0, 1, o.epsg === 4326 ? 2048 : 3072, 0, 1, o.epsg];
  const entries: Array<[number, number, number, Buffer]> = [];
  const short = (tag: number, v: number) => entries.push([tag, 3, 1, shorts([v])]);
  short(256, o.width);
  short(257, o.height);
  short(258, o.float ? 32 : 8);
  short(259, o.float ? 1 : 8);
  short(262, 1);
  short(277, 1);
  short(339, o.float ? 3 : 1);
  if (o.float) {
    entries.push([273, 4, offsets.length, longs(offsets)]);
    short(278, 1);
    entries.push([279, 4, counts.length, longs(counts)]);
  } else {
    short(322, o.tile!);
    short(323, o.tile!);
    entries.push([324, 4, offsets.length, longs(offsets)]);
    entries.push([325, 4, counts.length, longs(counts)]);
  }
  entries.push([33550, 12, 3, doubles([o.scale, o.scale, 0])]);
  entries.push([33922, 12, 6, doubles([0, 0, 0, o.origin[0], o.origin[1], 0])]);
  entries.push([34735, 3, geoKeys.length, shorts(geoKeys)]);
  if (o.nodata) entries.push([42113, 2, o.nodata.length + 1, Buffer.from(`${o.nodata}\0`, 'latin1')]);
  entries.sort((a, b) => a[0] - b[0]);
  const values = entries.map(([, , , v]) => (v.length > 4 ? add(v) : -1));
  const ifd = Buffer.alloc(2 + entries.length * 12 + 4);
  ifd.writeUInt16LE(entries.length, 0);
  entries.forEach(([tag, type, count, v], i) => {
    const o2 = 2 + i * 12;
    ifd.writeUInt16LE(tag, o2);
    ifd.writeUInt16LE(type, o2 + 2);
    ifd.writeUInt32LE(count, o2 + 4);
    if (v.length <= 4) v.copy(ifd, o2 + 8);
    else ifd.writeUInt32LE(values[i]!, o2 + 8);
  });
  const ifdAt = add(ifd);
  const head = Buffer.alloc(8);
  head.write('II', 0, 'latin1');
  head.writeUInt16LE(42, 2);
  head.writeUInt32LE(ifdAt, 4);
  return Buffer.concat([head, ...parts]);
}

/** One-entry ZIP (DEFLATE). */
function zip(name: string, data: Buffer): Buffer {
  const z = deflateRawSync(data);
  const crc = crc32(data);
  const n = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(z.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(n.length, 26);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(z.length, 20);
  cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(n.length, 28);
  cd.writeUInt32LE(0, 42);
  const cdAt = local.length + n.length + z.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(cd.length + n.length, 12);
  end.writeUInt32LE(cdAt, 16);
  return Buffer.concat([local, n, z, cd, n, end]);
}

describe('Terreno e ostacoli: dati', () => {
  it('UTM: central meridian and symmetry (WGS 84, Krüger series)', () => {
    const cm = toUtm(45, 9, 32);
    assert.ok(Math.abs(cm.e - 500000) < 0.01 && Math.abs(cm.n - 4982950.4) < 0.5, JSON.stringify(cm));
    const w = toUtm(37.5, 6, 32);
    const e = toUtm(37.5, 12, 32);
    assert.ok(Math.abs(w.e - 500000 + (e.e - 500000)) < 0.01 && Math.abs(w.n - e.n) < 0.01);
    // 1° of longitude at 37.5°N is ~88.4 km on the ground (scale 0.9996 on the meridian)
    assert.ok(Math.abs(toUtm(37.5, 10, 32).e - 500000 - 88_400) < 300);
  });

  it('reads GeoTIFF windows: float strips and DEFLATE tiles', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tiff-'));
    try {
      const f = new Float32Array(30 * 20).map((_, i) => i);
      writeFileSync(join(dir, 'a.tif'), geoTiff({ width: 30, height: 20, float: f, scale: 10, origin: [1000, 5000], epsg: 32632, nodata: '-9999' }));
      const a = openGeoTiff(join(dir, 'a.tif'));
      assert.deepEqual([a.width, a.height, a.epsg, a.nodata, a.originX, a.originY, a.pixelX], [30, 20, 32632, -9999, 1000, 5000, 10]);
      assert.deepEqual([...a.read(28, 18, 3, 2)].map((v) => (Number.isNaN(v) ? null : v)), [568, 569, null, 598, 599, null]);
      a.close();
      const b8 = new Uint8Array(40 * 40).map((_, i) => (i % 40 < 20 ? 50 : 10));
      writeFileSync(join(dir, 'b.tif'), geoTiff({ width: 40, height: 40, bytes: b8, tile: 16, scale: 0.001, origin: [14, 38], epsg: 4326 }));
      const b = openGeoTiff(join(dir, 'b.tif'));
      assert.equal(b.epsg, 4326);
      assert.deepEqual([...b.read(18, 33, 4, 1)], [50, 50, 10, 10]);
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names of the source tiles', () => {
    assert.deepEqual(tinitalyExtent('e41005'), { e0: 1_049_000, e1: 1_151_000, n0: 4_099_000, n1: 4_151_000 });
    assert.equal(tinitalyExtent('w41090')!.e0, 899_000);
    assert.deepEqual(worldCoverTiles({ minLat: 37.2, minLon: 14.5, maxLat: 37.9, maxLon: 15.2 }), ['N36E012', 'N36E015']);
  });

  it('imports TINITALY and WorldCover for an area and samples them (downloads simulated)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'terrain-'));
    try {
      // a 20 km UTM 32 tile with a plane rising 1 m every 10 m eastwards, and a land cover with
      // buildings in the western half and trees in the eastern half
      const P = toUtm(37.55, 14.25, 32);
      const e0 = Math.floor(P.e / 10_000) * 10_000 - 5000;
      const n0 = Math.floor(P.n / 10_000) * 10_000 - 5000;
      const name = `w${String(Math.floor(n0 / 10_000)).padStart(3, '0')}${String(Math.floor(e0 / 10_000) % 100).padStart(2, '0')}`;
      const W = 2000;
      const H = 2000;
      const elev = new Float32Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) elev[y * W + x] = 100 + x;
      const tin = zip(`${name}_s10/${name}_s10.tif`, geoTiff({ width: W, height: H, float: elev, scale: 10, origin: [e0, n0 + 20_000], epsg: 32632, nodata: '-9999' }));
      const cw = 1200;
      const cover = new Uint8Array(cw * cw).map((_, i) => (i % cw < cw / 2 ? 50 : 10));
      const wc = geoTiff({ width: cw, height: cw, bytes: cover, tile: 256, scale: 0.1 / 1200, origin: [14.2, 37.6], epsg: 4326 });
      const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('Download_Area1_1.html')) return new Response(`<a href="data_1.1/${name}_s10/${name}_s10.zip">x</a> <a href="data_1.1/e46505_s10/e46505_s10.zip">far</a>`);
        if (url.endsWith(`${name}_s10.zip`)) return new Response(new Uint8Array(tin));
        if (url.includes('ESA_WorldCover_10m_2021_v200_N36E012_Map.tif')) return init?.method === 'HEAD' ? new Response(null) : new Response(new Uint8Array(wc));
        return new Response('', { status: 404 });
      }) as typeof fetch;
      const store = createTerrainStore({ dir, dem: createDem({ dir: join(dir, 'srtm'), baseUrl: '' }), fetchImpl });
      const area = { minLat: 37.5, minLon: 14.2, maxLat: 37.6, maxLon: 14.3 };
      await store.importArea(area);
      const st = store.status();
      assert.equal(st.import.error, null, st.import.error ?? '');
      assert.equal(st.tinitaly, 1);
      assert.equal(st.worldcover, 1);
      assert.equal(st.dtmTiles, 1);
      const at = (await store.sampler(area))!;
      assert.equal(at.fine, true);
      for (const [la, lo] of [[37.55, 14.25], [37.52, 14.21], [37.59, 14.29]] as const) {
        const u = toUtm(la, lo, 32);
        const want = 100 + (u.e - e0) / 10 - 0.5;
        assert.ok(Math.abs(at.ground(la, lo)! - want) < 0.6, `${la},${lo}: ${at.ground(la, lo)} vs ${want}`);
      }
      assert.equal(at.cover(37.55, 14.22), 50, 'buildings in the western half');
      assert.equal(at.cover(37.55, 14.28), 10, 'trees in the eastern half');
      // an import again does not download what it already has
      await store.importArea(area);
      assert.equal(store.status().tinitaly, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Terreno e ostacoli: effetto sul collegamento', () => {
  /** 2 km flat profile at 300 m, antennas 10 m above; obstacles of [kind] and [h] between [a] and [b] m. */
  const prof = (kind: 'edificio' | 'alberi' | null, h: number, a: number, b: number): BuiltProfile => {
    const d = Array.from({ length: 81 }, (_, i) => i * 25);
    return { D: 2000, freq: 5600, from: 310, to: 310, ground: d.map(() => 300), obstacle: d.map((x) => (kind && x >= a && x <= b ? { h, kind } : null)), d, altitudeFrom: 'terreno' };
  };

  it('buildings are solid, trees attenuate with the stretch of crowns crossed', () => {
    assert.deepEqual(profileEffect(prof(null, 0, 0, 0)), { verdict: 'clear', lossDb: 0 });
    const town = profileEffect(prof('edificio', 15, 900, 1100));
    assert.equal(town.verdict, 'blocked');
    assert.equal(town.buildings, true);
    assert.ok(town.lossDb > 10, JSON.stringify(town));
    const wood = profileEffect(prof('alberi', 15, 900, 1100));
    assert.equal(wood.verdict, 'clear', 'trees do not block, they attenuate');
    assert.ok(wood.foliageM! >= 175 && wood.foliageM! <= 225, JSON.stringify(wood));
    assert.ok(Math.abs(wood.foliageDb! - foliageLossDb(wood.foliageM!)) < 0.1);
    assert.ok(wood.lossDb > 10 && wood.lossDb <= 20.1, JSON.stringify(wood));
    const low = profileEffect(prof('alberi', 5, 900, 1100));
    assert.equal(low.foliageM ?? 0, 0, 'crowns under the line of sight');
    assert.ok(foliageLossDb(10) > 3 && foliageLossDb(10) < 4.5);
    assert.ok(foliageLossDb(1000) <= 20);
  });
});
