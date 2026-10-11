import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync, gzipSync } from 'node:zlib';
import { buildingHeight, BUILDINGS_ZOOM, insideRings, rasterizeBuildings } from '../src/services/buildings.ts';
import { readMvt } from '../src/domain/mvt.ts';
import { obstacleAt } from '../src/services/terrain.ts';
import type { TerrainSampler } from '../src/services/terrain-store.ts';

// ---- a tiny MVT writer for the tests (one layer, polygons) ----
const varint = (n: number, out: number[]) => {
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
};
const zz = (n: number) => (n < 0 ? -2 * n - 1 : 2 * n);
const field = (f: number, wire: number, out: number[]) => varint(f * 8 + wire, out);
const bytes = (f: number, b: number[], out: number[]) => (field(f, 2, out), varint(b.length, out), out.push(...b));
const str = (s: string) => [...Buffer.from(s)];

function mvt(polys: Array<{ ring: Array<[number, number]>; height?: number }>): Buffer {
  const layer: number[] = [];
  bytes(1, str('buildings'), layer);
  for (const p of polys) {
    const geom: number[] = [];
    let x = 0;
    let y = 0;
    const [first, ...rest] = p.ring;
    geom.push((1 & 7) | (1 << 3), zz(first![0] - x), zz(first![1] - y));
    x = first![0];
    y = first![1];
    geom.push((2 & 7) | (rest.length << 3));
    for (const [px, py] of rest) {
      geom.push(zz(px - x), zz(py - y));
      x = px;
      y = py;
    }
    geom.push(7 | (1 << 3));
    const feat: number[] = [];
    if (p.height !== undefined) {
      const tags: number[] = [];
      varint(0, tags);
      varint(0, tags);
      bytes(2, tags, feat);
    }
    field(3, 0, feat);
    varint(3, feat);
    const g: number[] = [];
    for (const c of geom) varint(c, g);
    bytes(4, g, feat);
    bytes(2, feat, layer);
  }
  if (polys.some((p) => p.height !== undefined)) {
    bytes(3, str('height'), layer);
    const v: number[] = [];
    field(5, 0, v);
    varint(polys.find((p) => p.height !== undefined)!.height!, v);
    bytes(4, v, layer);
  }
  field(5, 0, layer);
  varint(4096, layer);
  field(15, 0, layer);
  varint(2, layer);
  const tile: number[] = [];
  bytes(3, layer, tile);
  return gzipSync(Buffer.from(tile));
}

describe('buildings of the basemap', () => {
  it('reads the polygons of a vector tile', () => {
    const t = readMvt(gunzipSync(mvt([{ ring: [[10, 10], [20, 10], [20, 20], [10, 20]], height: 12 }])));
    assert.equal(t[0]!.name, 'buildings');
    assert.equal(t[0]!.features[0]!.props.height, 12);
    assert.deepEqual(t[0]!.features[0]!.geometry[0], [[10, 10], [20, 10], [20, 20], [10, 20], [10, 10]]);
  });

  it('height: OpenStreetMap when mapped, small footprints are low', () => {
    assert.equal(buildingHeight({ height: 14 }, 200, 7), 14);
    assert.equal(buildingHeight({}, 200, 7), 7);
    assert.equal(buildingHeight({}, 20, 7), 3);
    assert.ok(insideRings([[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]], 5, 5));
    // a courtyard (hole) is not inside
    assert.ok(!insideRings([[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]], [[3, 3], [7, 3], [7, 7], [3, 7], [3, 3]]], 5, 5));
  });

  it('fills the grid points under a building, with its height', async () => {
    // one z15 tile: a big block in the middle (OSM height 12) and a shed in a corner
    const n = 2 ** BUILDINGS_ZOOM;
    const tx = Math.floor(((14.28 + 180) / 360) * n);
    const ty = Math.floor(((1 - Math.log(Math.tan((37.567 * Math.PI) / 180) + 1 / Math.cos((37.567 * Math.PI) / 180)) / Math.PI) / 2) * n);
    const tile = mvt([
      { ring: [[1000, 1000], [3000, 1000], [3000, 3000], [1000, 3000]], height: 12 },
      { ring: [[100, 100], [120, 100], [120, 120], [100, 120]] },
    ]);
    const reader = { tile: async (z: number, x: number, y: number) => (z === BUILDINGS_ZOOM && x === tx && y === ty ? tile : null) };
    const lonOf = (x: number) => (x / n) * 360 - 180;
    const latOf = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
    const north = latOf(ty);
    const west = lonOf(tx);
    const step = 1 / 10800;
    const side = 120;
    const { grid, count } = await rasterizeBuildings(reader, { north, west, step, side }, 7);
    assert.equal(count, 2);
    const at = (lat: number, lon: number) => grid[Math.round((north - lat) / step) * side + Math.round((lon - west) / step)];
    assert.equal(at(latOf(ty + 0.5), lonOf(tx + 0.5)), 12, 'middle of the block');
    assert.equal(at(latOf(ty + 0.1), lonOf(tx + 0.1)), 0, 'street outside');
    assert.equal(at(latOf(ty + 110 / 4096), lonOf(tx + 110 / 4096)), 3, 'the shed (smaller than the grid) is marked, low');
  });

  it('the footprints win over the land cover: a street in town is free', () => {
    const o = { buildingM: 7, treeM: 10 };
    const built = 50;
    const base = { fine: true, ground: () => 300, cover: () => built };
    const noBldg: TerrainSampler = { ...base, building: () => null };
    const street: TerrainSampler = { ...base, building: () => 0 };
    const house: TerrainSampler = { ...base, building: () => 11 };
    assert.deepEqual(obstacleAt(noBldg, 37, 14, o), { h: 7, kind: 'edificio' });
    assert.equal(obstacleAt(street, 37, 14, o), null);
    assert.deepEqual(obstacleAt(house, 37, 14, o), { h: 11, kind: 'edificio' });
    const trees: TerrainSampler = { fine: true, ground: () => 300, cover: () => 10, building: () => 0 };
    assert.deepEqual(obstacleAt(trees, 37, 14, o), { h: 10, kind: 'alberi' });
  });
});
