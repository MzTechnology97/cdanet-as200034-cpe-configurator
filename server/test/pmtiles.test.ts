import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { findEntry, parseDirectory, PmTilesReader, zxyToTileId } from '../src/domain/pmtiles.ts';
import { testConfig } from './helpers.ts';

const varint = (n: number): number[] => {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
  return out;
};

/** PMTiles v3 with gzip directory and tiles, like the Protomaps builds (single root directory). */
function buildPmtiles(tiles: Array<{ z: number; x: number; y: number; data: string }>): Buffer {
  const items = tiles.map((t) => ({ id: zxyToTileId(t.z, t.x, t.y), data: gzipSync(Buffer.from(t.data)) })).sort((a, b) => a.id - b.id);
  let offset = 0;
  const entries = items.map((t) => {
    const e = { id: t.id, offset, length: t.data.length };
    offset += t.data.length;
    return e;
  });
  const dir: number[] = [...varint(entries.length)];
  let last = 0;
  for (const e of entries) (dir.push(...varint(e.id - last)), (last = e.id));
  for (const _ of entries) dir.push(...varint(1));
  for (const e of entries) dir.push(...varint(e.length));
  entries.forEach((e, i) => dir.push(...varint(i > 0 ? 0 : e.offset + 1)));
  const root = gzipSync(Buffer.from(dir));
  const h = Buffer.alloc(127);
  h.write('PMTiles', 0, 'latin1');
  h[7] = 3;
  const put = (at: number, v: number) => h.writeBigUInt64LE(BigInt(v), at);
  const dataOffset = 127 + root.length;
  put(8, 127);
  put(16, root.length);
  put(40, dataOffset); // no leaf directories
  put(56, dataOffset);
  put(64, offset);
  h[97] = 2; // internal compression gzip
  h[98] = 2; // tile compression gzip
  h[99] = 1; // MVT
  h[100] = 0;
  h[101] = 14;
  for (const [at, v] of [[102, 11.85], [106, 35.45], [110, 15.7], [114, 38.85]] as const) h.writeInt32LE(Math.round(v * 1e7), at);
  return Buffer.concat([h, root, ...items.map((t) => t.data)]);
}

describe('Mappa: tile singole dal file PMTiles', () => {
  it('follows the spec: Hilbert ids, directory columns, run lengths', () => {
    // z0, then z1 in Hilbert order (0,0) (0,1) (1,1) (1,0), then z2
    assert.deepEqual([zxyToTileId(0, 0, 0), zxyToTileId(1, 0, 0), zxyToTileId(1, 0, 1), zxyToTileId(1, 1, 1), zxyToTileId(1, 1, 0), zxyToTileId(2, 0, 0)], [0, 1, 2, 3, 4, 5]);
    assert.equal(zxyToTileId(12, 2210, 1586) > zxyToTileId(11, 2047, 2047), true);
    assert.throws(() => zxyToTileId(2, 4, 0));
    const dir = parseDirectory(Buffer.from([2, 5, 3, 3, 0, 10, 20, 1, 0]));
    assert.deepEqual(dir, [
      { tileId: 5, offset: 0, length: 10, runLength: 3 },
      { tileId: 8, offset: 10, length: 20, runLength: 0 },
    ]);
    assert.equal(findEntry(dir, 7)?.tileId, 5, 'inside the run');
    assert.equal(findEntry(dir, 4), null);
    assert.equal(findEntry(dir, 100)?.tileId, 8, 'leaf directory covers the rest');
  });

  it('serves single tiles over plain HTTP (no byte ranges)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdanet-tiles-'));
    const file = join(dir, 'basemap.pmtiles');
    writeFileSync(file, buildPmtiles([{ z: 0, x: 0, y: 0, data: 'earth z0' }, { z: 12, x: 2210, y: 1586, data: 'roads enna' }]));
    const r = new PmTilesReader(file);
    assert.equal(gunzipSync((await r.tile(12, 2210, 1586))!).toString(), 'roads enna');
    assert.equal(await r.tile(12, 2211, 1586), null);
    await r.close();

    const { app } = await buildApp(testConfig({ MAP_FILE: file }), 'test', { db: openDatabase(':memory:'), logger: false, uisp: null });
    const cfg = (await app.inject({ method: 'GET', url: '/api/map/config' })).json();
    assert.match(cfg.basemap.tiles, /^\/map\/tiles\/\{z\}\/\{x\}\/\{y\}\.mvt\?v=\d+$/);
    const t = await app.inject({ method: 'GET', url: '/map/tiles/12/2210/1586.mvt?v=1' });
    assert.equal(t.statusCode, 200);
    assert.equal(t.headers['content-encoding'], 'gzip');
    assert.equal(t.headers['content-type'], 'application/vnd.mapbox-vector-tile');
    assert.match(String(t.headers['cache-control']), /max-age=86400/);
    assert.equal(gunzipSync(t.rawPayload).toString(), 'roads enna');
    assert.equal((await app.inject({ method: 'GET', url: '/map/tiles/0/0/0.mvt' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/map/tiles/12/2211/1586.mvt' })).statusCode, 204, 'no tile (sea, outside the area)');
    assert.equal((await app.inject({ method: 'GET', url: '/map/tiles/2/9/0.mvt' })).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/map/tiles/a/0/0.mvt' })).statusCode, 400);
    await app.close();
  });
});
