import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { CANOPY_LEVEL_PX, CANOPY_URL, CANOPY_ZOOM, createCanopyReader, MIN_TREE_M, quadkey, rasterizeCanopy } from '../src/services/canopy.ts';
import { buildProfile, obstacleAt } from '../src/services/terrain.ts';
import type { TerrainSampler } from '../src/services/terrain-store.ts';

/**
 * A COG like the canopy map: full image (not used), then the 8192 px overview with 512 px DEFLATE
 * blocks; one block holds a 20 m wood, everything else is empty (count 0).
 */
function fakeCog(woodBlock: [number, number]): Buffer {
  const per = CANOPY_LEVEL_PX / 512;
  const block = new Uint8Array(512 * 512);
  for (let y = 100; y < 200; y++) for (let x = 100; x < 200; x++) block[y * 512 + x] = 20;
  block[300 * 512 + 300] = 2; // a bush: below the minimum
  const data = deflateSync(block);
  const ifd = (width: number, offsetsAt: number, countsAt: number, n: number, next: number) => {
    const tags: Array<[number, number, number, number]> = [
      [256, 4, 1, width],
      [257, 4, 1, width],
      [258, 3, 1, 8],
      [259, 3, 1, 8],
      [322, 3, 1, 512],
      [323, 3, 1, 512],
      [324, 4, n, offsetsAt],
      [325, 4, n, countsAt],
    ];
    const b = Buffer.alloc(2 + tags.length * 12 + 4);
    b.writeUInt16LE(tags.length, 0);
    tags.forEach(([t, ty, c, v], i) => {
      b.writeUInt16LE(t, 2 + i * 12);
      b.writeUInt16LE(ty, 4 + i * 12);
      b.writeUInt32LE(c, 6 + i * 12);
      if (ty === 3 && c === 1) b.writeUInt16LE(v, 10 + i * 12);
      else b.writeUInt32LE(v, 10 + i * 12);
    });
    b.writeUInt32LE(next, 2 + tags.length * 12);
    return b;
  };
  const n = per * per;
  // layout: header 8 | IFD0 (full image, 1 block, empty) | IFD1 (overview) | arrays | block data
  const ifdSize = 2 + 8 * 12 + 4;
  const ifd0At = 8;
  const ifd1At = ifd0At + ifdSize;
  const arr0 = ifd1At + ifdSize; // full image: 1 offset + 1 count (inline would fit, kept simple)
  const offAt = arr0 + 8;
  const cntAt = offAt + n * 4;
  const dataAt = cntAt + n * 4;
  const out = Buffer.alloc(dataAt + data.length);
  out.write('II', 0, 'latin1');
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(ifd0At, 4);
  ifd(32768, arr0, arr0 + 4, 1, ifd1At).copy(out, ifd0At);
  ifd(CANOPY_LEVEL_PX, offAt, cntAt, n, 0).copy(out, ifd1At);
  const k = woodBlock[1] * per + woodBlock[0];
  out.writeUInt32LE(dataAt, offAt + k * 4);
  out.writeUInt32LE(data.length, cntAt + k * 4);
  Buffer.from(data).copy(out, dataAt);
  return out;
}

describe('tree heights (canopy map)', () => {
  it('quadkeys of the Bing grid', () => {
    assert.equal(quadkey(0, 0, 1), '0');
    assert.equal(quadkey(1, 1, 1), '3');
    assert.equal(quadkey(3, 5, 3), '213');
    assert.match(CANOPY_URL('1220103200'), /chm\/1220103200\.tif$/);
  });

  it('reads only the blocks it needs and keeps the trees, not the bushes', async () => {
    // the zoom-10 tile and a block of it near Enna
    const n = 2 ** CANOPY_ZOOM;
    const lon = 14.27;
    const lat = 37.58;
    const gx = ((lon + 180) / 360) * n;
    const gy = ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n;
    const tx = Math.floor(gx);
    const ty = Math.floor(gy);
    const bx = Math.floor(((gx - tx) * CANOPY_LEVEL_PX) / 512);
    const by = Math.floor(((gy - ty) * CANOPY_LEVEL_PX) / 512);
    const cog = fakeCog([bx, by]);
    const url = CANOPY_URL(quadkey(tx, ty, CANOPY_ZOOM));
    const reads: number[] = [];
    const reader = createCanopyReader(async (u, start, length) => {
      if (u !== url) return null; // other tiles: missing (sea)
      reads.push(length);
      return cog.subarray(start, start + length);
    });
    // pixel (150, 150) of the block is in the wood; (300, 300) is the bush
    const pxLon = (px: number) => ((tx + (bx * 512 + px + 0.5) / CANOPY_LEVEL_PX) / n) * 360 - 180;
    const pxLat = (py: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * (ty + (by * 512 + py + 0.5) / CANOPY_LEVEL_PX)) / n))) * 180) / Math.PI;
    const box = { north: pxLat(90), west: pxLon(90), step: (pxLon(310) - pxLon(90)) / 20, side: 21 };
    const grid = await rasterizeCanopy(reader, box);
    assert.equal(Math.max(...grid), 20);
    assert.ok(grid.filter((v) => v === 20).length >= 50, 'the wood');
    assert.ok(!grid.includes(2), `nothing below ${MIN_TREE_M} m`);
    assert.ok(reads.length <= 3, `header and one block, not the file (${reads.length} reads)`);
  });

  it('the canopy wins over the land cover: a field mapped as trees is free, a tall tree is tall', () => {
    const o = { buildingM: 7, treeM: 8 };
    const base = { fine: true, ground: () => 300, cover: () => 10, building: () => 0 };
    assert.equal(obstacleAt({ ...base, canopy: () => 0 } as TerrainSampler, 37, 14, o), null);
    assert.deepEqual(obstacleAt({ ...base, canopy: () => 18 } as TerrainSampler, 37, 14, o), { h: 18, kind: 'alberi' });
    assert.deepEqual(obstacleAt({ ...base, canopy: () => null } as TerrainSampler, 37, 14, o), { h: 8, kind: 'alberi' });
    // trees off in the settings
    assert.equal(obstacleAt({ ...base, canopy: () => 18 } as TerrainSampler, 37, 14, { buildingM: 7, treeM: 0 }), null);
  });

  it('antennas stay at sane heights: no CPE over a 25 m pine, the UISP site height of the AP kept', () => {
    const o = { buildingM: 8, treeM: 8 };
    const point = { lat: 37.5, lon: 14.2 };
    const ap = { lat: 37.53, lon: 14.2, gpsAltitude: null, siteHeight: 10, frequency: 5600 };
    // a 25 m wood everywhere around both, flat ground at 300 m
    const at = { fine: true, ground: () => 300, cover: () => 10, building: () => 0, canopy: () => 25 } as TerrainSampler;
    const p = buildProfile(at, point, 6, ap, 15, o)!;
    assert.equal(p.from - 300, 10, 'CPE raised at most over an average tree (8 + 2 m)');
    assert.equal(p.to - 300, 10, 'AP at its UISP site height');
    // the house of the point: its real roof
    const house = { ...at, building: (lat: number) => (Math.abs(lat - 37.5) < 1e-4 ? 14 : 0), canopy: () => 0 } as TerrainSampler;
    assert.equal(buildProfile(house, point, 6, ap, 15, o)!.from - 300, 16, 'CPE 2 m over its own 14 m roof');
    // AP without site height nor GPS: the default height, raised over the trees around (capped)
    const noSite = buildProfile(at, point, 6, { ...ap, siteHeight: null }, 15, o)!;
    assert.equal(noSite.to - 300, 15);
  });
});
