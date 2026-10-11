import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTerrainTiles, fromTerrarium, terrainTilePng, terrarium, tileBbox } from '../src/services/terrain-tiles.ts';
import type { TerrainSampler } from '../src/services/terrain-store.ts';

/** Pixels of a PNG written by encodePng (RGB, filter 0). */
function readPng(b: Buffer) {
  assert.equal(b.subarray(1, 4).toString('latin1'), 'PNG');
  const w = b.readUInt32BE(16);
  const hgt = b.readUInt32BE(20);
  let at = 8;
  const idat: Buffer[] = [];
  while (at < b.length) {
    const len = b.readUInt32BE(at);
    const type = b.toString('latin1', at + 4, at + 8);
    if (type === 'IDAT') idat.push(b.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  return { w, hgt, px: (i: number, j: number) => [...raw.subarray(j * (w * 3 + 1) + 1 + i * 3, j * (w * 3 + 1) + 4 + i * 3)] as [number, number, number] };
}

describe('3D map terrain tiles', () => {
  it('Terrarium encodes heights to the decimetre and clamps the sea', () => {
    for (const h of [0, 1.25, 431.7, 1971.4, 3340]) assert.ok(Math.abs(fromTerrarium(...terrarium(h)) - h) < 0.01, String(h));
    assert.equal(fromTerrarium(...terrarium(-50)), -50);
    assert.deepEqual(terrarium(-40000), [0, 0, 0]);
  });

  it('tile box follows Web Mercator', () => {
    const b = tileBbox(10, 552, 396);
    assert.ok(b.minLon > 14 && b.maxLon < 14.5 && b.minLat > 37 && b.maxLat < 37.8, JSON.stringify(b));
    assert.ok(b.maxLat > b.minLat && b.maxLon > b.minLon);
  });

  it('a tile carries the ground of the sampler, north at the top', () => {
    // ground rises to the north: 1 m per 0.001° of latitude above 37°
    const at: TerrainSampler = { fine: true, ground: (lat) => (lat - 37) * 1000, cover: () => null };
    const png = terrainTilePng(at, 12, 2205, 1613, 16);
    const { w, hgt, px } = readPng(png);
    assert.equal(w, 16);
    assert.equal(hgt, 16);
    const top = fromTerrarium(...px(3, 0));
    const bottom = fromTerrarium(...px(3, 15));
    const b = tileBbox(12, 2205, 1613);
    assert.ok(top > bottom, `${top} > ${bottom}`);
    assert.ok(Math.abs(top - (b.maxLat - 37) * 1000) < 5 && Math.abs(bottom - (b.minLat - 37) * 1000) < 5);
  });

  it('tiles are computed once and kept, a new terrain import makes them again', async () => {
    let calls = 0;
    let version = 'a';
    const tiles = createTerrainTiles({
      sampler: async () => (calls++, { fine: true, ground: () => 100, cover: () => null }),
      version: () => version,
    });
    const [a, b] = await Promise.all([tiles.tile(12, 2205, 1613), tiles.tile(12, 2205, 1613)]);
    assert.ok(a && a === b);
    await tiles.tile(12, 2205, 1613);
    assert.equal(calls, 1);
    version = 'b';
    await tiles.tile(12, 2205, 1613);
    assert.equal(calls, 2);
    const none = createTerrainTiles({ sampler: async () => null, version: () => 'x' });
    assert.equal(await none.tile(12, 1, 1), null);
  });

  it('tiles kept on disk survive a restart, a new terrain throws them away', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tiles3d-'));
    try {
      let calls = 0;
      let version = 'a';
      const make = () => createTerrainTiles({ sampler: async () => (calls++, { fine: true, ground: () => 100, cover: () => null }), version: () => version, dir });
      const first = await make().tile(12, 2205, 1613);
      // a restart: a new service, the memory empty, the disk not
      const again = await make().tile(12, 2205, 1613);
      assert.equal(calls, 1);
      assert.deepEqual(again, first);
      version = 'b';
      await make().tile(12, 2205, 1613);
      assert.equal(calls, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
