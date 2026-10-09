import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { elevationAngle, sampleHgt, tileName } from '../src/services/dem.ts';
import { gpsAltitude } from '../src/services/uisp.ts';
import { fakeUisp } from './fake-uisp.ts';
import { ADMIN, testConfig } from './helpers.ts';

/** n×n .hgt tile (big-endian int16, north row first). */
function hgt(n: number, value: (row: number, col: number) => number): Buffer {
  const b = Buffer.alloc(n * n * 2);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) b.writeInt16BE(value(r, c), (r * n + c) * 2);
  return b;
}

describe('Puntamento: terreno e tilt', () => {
  it('reads SRTM tiles', () => {
    assert.equal(tileName(37.58, 14.12), 'N37E014');
    assert.equal(tileName(-0.5, -1.2), 'S01W002');
    // 3×3: west column 100, east column 300 -> the middle is 200
    const t = hgt(3, (_r, c) => 100 + c * 100);
    assert.equal(sampleHgt(t, 37.5, 14.5), 200);
    assert.equal(sampleHgt(t, 37.5, 14.25), 150);
    assert.equal(sampleHgt(hgt(3, () => -32768), 37.5, 14.5), null, 'voids');
  });

  it('reads the AP altitude from its GPS when UISP reports it', () => {
    assert.equal(gpsAltitude({ location: { latitude: 37.6, longitude: 14.1, altitude: 932.4 } }), 932.4);
    assert.equal(gpsAltitude({ overview: { gps: { altitude: '871' } } }), 871);
    assert.equal(gpsAltitude({ location: { latitude: 37.6, longitude: 14.1 } }), null);
  });

  it('computes the tilt with earth curvature', () => {
    assert.equal(elevationAngle(2000, 500, 600), 2.9);
    assert.ok(elevationAngle(30000, 500, 500) < 0, 'same height far away: slightly below the horizon');
  });

  it('lists the nearest APs with altitude and tilt; installers get approximate positions', async () => {
    const uisp = fakeUisp();
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.host === 'dem.test') {
        if (url.pathname === '/skadi/N37/N37E014.hgt.gz') return new Response(gzipSync(hgt(3, () => 500)));
        return new Response('', { status: 404 });
      }
      return uisp.fetchImpl(input, init);
    }) as typeof fetch;
    const { app } = await buildApp(testConfig({ DEM_URL: 'https://dem.test/skadi' }), 'test', { db: openDatabase(':memory:'), logger: false, uisp: uisp.uisp, fetchImpl });
    const login = async (username: string, password: string) => ({ authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } })).json().token}` });
    const H = await login(ADMIN.username, ADMIN.password);

    const r = (await app.inject({ method: 'GET', url: '/api/pointing?lat=37.58&lon=14.12&height=6', headers: H })).json();
    assert.equal(r.from.ground, 500);
    assert.equal(r.from.altitude, 506);
    const ap = r.aps.find((a: { name: string }) => a.name === 'AP N2 D01');
    assert.equal(ap.altitude, 515, 'ground + 15 m antenna height');
    assert.equal(ap.altitudeFrom, 'terreno');
    assert.ok(ap.tiltDeg > 0 && ap.tiltDeg < 1, String(ap.tiltDeg));
    assert.equal(typeof ap.lat, 'number');

    await app.inject({ method: 'PUT', url: '/api/admin/pointing/config', headers: H, payload: { apHeightM: 30, cpeHeightM: 4 } });
    await app.inject({ method: 'POST', url: '/api/admin/users', headers: H, payload: { username: 'tecnico', password: 'Installer-Pass-123' } });
    const tid = (await app.inject({ method: 'GET', url: '/api/admin/assignments', headers: H })).json().users[0].id;
    await app.inject({ method: 'PUT', url: `/api/admin/assignments/${tid}`, headers: H, payload: { items: [{ key: 'ap:ap-n2', name: 'AP N2 D01' }] } });
    const T = await login('tecnico', 'Installer-Pass-123');
    const t = (await app.inject({ method: 'GET', url: '/api/pointing?lat=37.58&lon=14.12', headers: T })).json();
    assert.equal(t.from.height, 4, 'default CPE height from the admin');
    assert.deepEqual(t.aps.map((a: { name: string }) => a.name), ['AP N2 D01']);
    assert.equal(t.aps[0].altitude, 530);
    assert.equal(t.aps[0].lat, undefined);
    assert.ok(t.aps[0].approx);
    assert.equal(t.aps[0].distanceM % 50, 0);
    assert.equal(typeof t.aps[0].bearing, 'number');
    await app.close();
  });
});
