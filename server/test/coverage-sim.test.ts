import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { fakeUisp } from './fake-uisp.ts';
import { ADMIN, testConfig } from './helpers.ts';

describe('Copertura: radio simulation of an AP (admins)', () => {
  it('returns a grid of estimated signals around the AP, for admins only', async () => {
    const uisp = fakeUisp();
    const { app } = await buildApp(testConfig(), 'test', { db: openDatabase(':memory:'), logger: false, uisp: uisp.uisp, fetchImpl: uisp.fetchImpl });
    const login = async (username: string, password: string) => ({ authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } })).json().token}` });
    const H = await login(ADMIN.username, ADMIN.password);
    await app.inject({ method: 'POST', url: '/api/admin/users', headers: H, payload: { username: 'tecnico', password: 'Installer-Pass-123' } });
    const T = await login('tecnico', 'Installer-Pass-123');

    const sim = await app.inject({ method: 'GET', url: '/api/admin/coverage/simulation?apId=ap-n2', headers: H });
    assert.equal(sim.statusCode, 200, sim.body);
    const s = sim.json();
    assert.equal(s.ap.id, 'ap-n2');
    assert.equal(typeof s.ap.lat, 'number');
    assert.equal(s.minDbm, -75);
    assert.ok(Array.isArray(s.cells));
    for (const c of s.cells) assert.ok(typeof c.dbm === 'number' && typeof c.lat === 'number' && typeof c.lon === 'number');
    if (s.cells.length) assert.ok(s.radiusM >= 1500 && s.cellM > 0);

    // an AP with no customers: theoretical simulation instead of nothing
    const fresh = (await app.inject({ method: 'GET', url: '/api/admin/coverage/simulation?apId=ap-n7', headers: H })).json();
    assert.equal(fresh.theoretical, true, JSON.stringify({ ...fresh, cells: fresh.cells?.length }));
    assert.ok(fresh.cells.length > 100);
    assert.ok(fresh.cells.every((c: { confidence: string }) => c.confidence === 'bassa'));
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/coverage/simulation?apId=nope', headers: H })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/coverage/simulation?apId=ap-n2', headers: T })).statusCode, 403, 'installers: no simulation');
  });
});

describe('Copertura: il terreno entra nella stima', () => {
  /** n×n .hgt tile (big-endian int16, north row first). */
  const hgt = (n: number, value: (row: number, col: number) => number) => {
    const b = Buffer.alloc(n * n * 2);
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) b.writeInt16BE(value(r, c), (r * n + c) * 2);
    return b;
  };

  it('a ridge between the point and the AP lowers the estimate, as Visibilità says', async () => {
    const { gzipSync } = await import('node:zlib');
    const uisp = fakeUisp();
    // flat at 500 m, a 1500 m ridge between longitude 14.120 and 14.125 (east of the AP at 14.1)
    const n = 1201;
    const tile = gzipSync(hgt(n, (_r, c) => (c >= 144 && c <= 150 ? 1500 : 500)));
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.host === 'dem.test') return url.pathname === '/skadi/N37/N37E014.hgt.gz' ? new Response(tile) : new Response('', { status: 404 });
      return uisp.fetchImpl(input, init);
    }) as typeof fetch;
    const { app } = await buildApp(testConfig({ DEM_URL: 'https://dem.test/skadi' }), 'test', { db: openDatabase(':memory:'), logger: false, uisp: uisp.uisp, fetchImpl });
    const H = { authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: ADMIN })).json().token}` };
    const n2 = async (lon: number) => {
      const r = (await app.inject({ method: 'GET', url: `/api/coverage?lat=37.6&lon=${lon}&limit=20`, headers: H })).json();
      return r.aps.find((a: { id: string }) => a.id === 'ap-n2');
    };
    const west = await n2(14.05); // ~4.4 km, flat
    const east = await n2(14.15); // ~4.4 km, behind the ridge
    assert.equal(west.estimate.terrain.verdict, 'clear', JSON.stringify(west.estimate));
    assert.equal(east.estimate.terrain.verdict, 'blocked', JSON.stringify(east.estimate));
    assert.ok(east.estimate.terrain.lossDb > 20);
    assert.ok(east.estimate.signalDbm <= west.estimate.signalDbm - 20, `${east.estimate.signalDbm} vs ${west.estimate.signalDbm}`);
    assert.notEqual(east.rating, 'buono');

    // AP vicini: the same estimate
    const pointing = (await app.inject({ method: 'GET', url: '/api/pointing?lat=37.6&lon=14.15&limit=15', headers: H })).json();
    const p = pointing.aps.find((a: { id: string }) => a.id === 'ap-n2');
    assert.equal(p.estimate.signalDbm, east.estimate.signalDbm);

    // the simulation knows the terrain too, and never goes beyond 20 km
    const sim = (await app.inject({ method: 'GET', url: '/api/admin/coverage/simulation?apId=ap-n2', headers: H })).json();
    assert.equal(sim.terrain, true);
    assert.ok(sim.radiusM <= 20000);
    assert.ok(sim.cells.some((c: { blocked?: boolean }) => c.blocked), 'cells behind the ridge');
    assert.ok(sim.cells.some((c: { blocked?: boolean }) => !c.blocked));
  });
});

describe('Copertura: affidabilità e terreno (admin)', () => {
  it('measures the model on the customers, keeps the history, and shows the terrain status', async () => {
    const uisp = fakeUisp();
    const { app } = await buildApp(testConfig(), 'test', { db: openDatabase(':memory:'), logger: false, uisp: uisp.uisp, fetchImpl: uisp.fetchImpl });
    const login = async (username: string, password: string) => ({ authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } })).json().token}` });
    const H = await login(ADMIN.username, ADMIN.password);
    await app.inject({ method: 'POST', url: '/api/admin/users', headers: H, payload: { username: 'tecnico', password: 'Installer-Pass-123' } });
    const T = await login('tecnico', 'Installer-Pass-123');
    const run = async () => {
      assert.equal((await app.inject({ method: 'POST', url: '/api/admin/coverage/accuracy', headers: H, payload: {} })).json().started, true);
      for (let i = 0; i < 100 && (await app.inject({ method: 'GET', url: '/api/admin/coverage/accuracy', headers: H })).json().running; i++) await new Promise((r) => setTimeout(r, 50));
      return (await app.inject({ method: 'GET', url: '/api/admin/coverage/accuracy', headers: H })).json();
    };
    const first = await run();
    assert.equal(first.error, null);
    assert.ok(first.last && first.last.customers >= 0, JSON.stringify(first.last));
    assert.equal(typeof first.last.medianAbsDb, 'number');
    assert.ok(Array.isArray(first.last.worst));
    const second = await run();
    assert.equal(second.history.length, 2, 'history kept for before/after');
    assert.equal(second.history[0].worst, undefined, 'the history has summaries only');
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/coverage/accuracy', headers: T })).statusCode, 403);

    const terrain = (await app.inject({ method: 'GET', url: '/api/admin/terrain', headers: H })).json();
    assert.equal(terrain.dtmTiles, 0);
    assert.ok(terrain.area && terrain.area.minLat < 37.6 && terrain.area.maxLat > 37.6, JSON.stringify(terrain.area));
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/terrain/import', headers: T, payload: {} })).statusCode, 403);
  });
});
