import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { approxPoint, roughDistance } from '../src/domain/approx.ts';
import { distanceM } from '../src/domain/geo.ts';
import { readPmtilesHeader } from '../src/routes/map.ts';
import { ADMIN, testConfig } from './helpers.ts';

/** Minimal PMTiles v3 header (bounds of Sicily, zoom 0-15) followed by some data. */
function fakePmtiles(): Buffer {
  const b = Buffer.alloc(4096, 7);
  b.write('PMTiles', 0, 'latin1');
  b[7] = 3;
  b[100] = 0;
  b[101] = 15;
  for (const [at, v] of [[102, 11.85], [106, 35.45], [110, 15.7], [114, 38.85]] as const) b.writeInt32LE(Math.round(v * 1e7), at);
  return b;
}

describe('Mappa (Protomaps)', () => {
  it('approximate POP/AP positions are stable, near but never the real point', () => {
    const real = { lat: 37.60123, lon: 14.10456 };
    const a = approxPoint(real.lat, real.lon, 'ap:x', 'secret');
    assert.deepEqual(approxPoint(real.lat, real.lon, 'ap:x', 'secret'), a, 'same object, same point');
    assert.notDeepEqual(approxPoint(real.lat, real.lon, 'ap:y', 'secret'), a);
    const d = distanceM(real, a);
    assert.ok(d > 0 && d < a.radiusM, `${d} m`);
    assert.equal(roughDistance(734), 750);
    assert.equal(roughDistance(1234), 1200);
  });

  it('reads the PMTiles header and serves byte ranges', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdanet-map-'));
    const file = join(dir, 'basemap.pmtiles');
    writeFileSync(file, fakePmtiles());
    assert.deepEqual(readPmtilesHeader(file), { minZoom: 0, maxZoom: 15, bounds: [11.85, 35.45, 15.7, 38.85] });

    const { app } = await buildApp(testConfig({ MAP_FILE: file }), 'test', { db: openDatabase(':memory:'), logger: false, uisp: null });
    const tok = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: ADMIN.username, password: ADMIN.password } })).json().token;
    const cfg = (await app.inject({ method: 'GET', url: '/api/map/config', headers: { authorization: `Bearer ${tok}` } })).json();
    assert.deepEqual(cfg.basemap.bounds, [11.85, 35.45, 15.7, 38.85]);
    assert.match(cfg.basemap.url, /^\/map\/basemap\.pmtiles\?v=\d+$/);
    const r = await app.inject({ method: 'GET', url: '/map/basemap.pmtiles', headers: { range: 'bytes=0-6' } });
    assert.equal(r.statusCode, 206);
    assert.equal(r.body, 'PMTiles');
    assert.equal(r.headers['content-range'], 'bytes 0-6/4096');
    assert.equal((await app.inject({ method: 'GET', url: '/map/basemap.pmtiles' })).statusCode, 416);
    assert.equal((await app.inject({ method: 'GET', url: '/map/basemap.pmtiles', headers: { range: 'bytes=9999-' } })).statusCode, 416);
    // diagnostics of the map embedded in the app: logged, validated, rate limited
    const log = (payload: object) => app.inject({ method: 'POST', url: '/api/map/client-log', payload });
    assert.equal((await log({ kind: 'basemap_empty', message: '0 tile', ua: 'Android WebView', size: '360x640' })).statusCode, 204);
    assert.equal((await log({ kind: 'x', message: 'y', extra: 1 })).statusCode, 400);
    for (let i = 0; i < 60; i++) await log({ kind: 'error', message: 'flood' });
    assert.equal((await log({ kind: 'error', message: 'flood' })).statusCode, 429);
    await app.close();

    const none = await buildApp(testConfig({ MAP_FILE: join(dir, 'missing.pmtiles') }), 'test', { db: openDatabase(':memory:'), logger: false, uisp: null });
    const t2 = (await none.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: ADMIN.username, password: ADMIN.password } })).json().token;
    assert.equal((await none.app.inject({ method: 'GET', url: '/api/map/config', headers: { authorization: `Bearer ${t2}` } })).json().basemap, null, 'fallback to public tiles');
    await none.app.close();
  });
});
