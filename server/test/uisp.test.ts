import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { bearingDeg, cardinal, distanceM } from '../src/domain/geo.ts';
import { createGeocoder } from '../src/services/geocode.ts';
import { createUisp, normalizeDevice } from '../src/services/uisp.ts';
import { ADMIN, SAMPLE_TEMPLATE, testConfig } from './helpers.ts';

// UISP v2.1-shaped fixtures: two APs (one located via its site), one pending station.
const SITES = [
  { id: 'site-n2', identification: { name: 'Nodo 2 - Monte', type: 'site' }, description: { location: { latitude: 37.6, longitude: 14.1 } } },
  { id: 'site-n7', identification: { name: 'Nodo 7 - Valle', type: 'site' }, description: { location: { latitude: 37.51, longitude: 14.01 } } },
];
const AP_N2 = {
  identification: { id: 'ap-n2', name: 'AP N2 D01', mac: '24:A4:3C:00:00:01', role: 'ap', model: 'R5AC-Lite', site: { id: 'site-n2', name: 'Nodo 2 - Monte' }, authorized: true },
  overview: { status: 'active', stationsCount: 12, frequency: 5600, wirelessMode: 'ap-ptmp' },
  attributes: { ssid: 'CDA-NET-N2-D01' },
  location: { latitude: 37.6, longitude: 14.1 },
};
const AP_N7 = {
  identification: { id: 'ap-n7', name: 'AP N7 D03', mac: '24A43C000002', role: 'ap', site: { id: 'site-n7', name: 'Nodo 7 - Valle' }, authorized: true },
  overview: { status: 'active', stationsCount: 3 },
  attributes: { ssid: 'CDA-NET-N7-D03' },
  location: null, // falls back to the site position
};
const FAR_AP = {
  identification: { id: 'ap-far', name: 'AP lontano', role: 'ap', site: { id: 'x', name: 'Lontano' }, authorized: true },
  overview: { status: 'active' },
  attributes: { ssid: 'CDA-NET-N99-D01' },
  location: { latitude: 45.46, longitude: 9.19 },
};
const STATION = {
  identification: { id: 'cpe-1', name: 'ROSSI MARIO', mac: 'aa-bb-cc-dd-ee-ff', role: 'station', authorized: false, firmwareVersion: '8.7.4' },
  overview: { status: 'active', signal: -58, wirelessMode: 'sta-ptmp' },
  attributes: { ssid: 'CDA-NET-N2-D01', apDevice: { id: 'ap-n2', name: 'AP N2 D01' } },
};

function fakeUisp(opts: { authorizeMethod?: 'POST' | 'PUT' } = {}) {
  const calls: Array<{ method: string; path: string; body: unknown; token: string | null }> = [];
  const devices = [AP_N2, AP_N7, FAR_AP, STATION].map((d) => structuredClone(d));
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace('/nms/api/v2.1', '');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body, token: new Headers(init?.headers).get('x-auth-token') });
    if (url.host === 'geo.test') {
      return new Response(JSON.stringify([{ display_name: 'Via Roma 1, 94100 Enna', lat: '37.58', lon: '14.12', type: 'house' }]));
    }
    if (path === '/devices' && method === 'GET') return new Response(JSON.stringify(devices));
    if (path === '/sites' && method === 'GET') return new Response(JSON.stringify(SITES));
    const auth = /^\/devices\/([^/]+)\/authorize$/.exec(path);
    if (auth) {
      if (method !== (opts.authorizeMethod ?? 'POST')) return new Response('', { status: 405 });
      const d = devices.find((x) => x.identification.id === auth[1])!;
      d.identification.authorized = true;
      (d.identification as Record<string, unknown>).site = { id: body.siteId, name: SITES.find((s) => s.id === body.siteId)?.identification.name };
      return new Response('{}');
    }
    if (/^\/devices\/[^/]+\/backups$/.test(path)) {
      return method === 'POST' ? new Response('{}') : new Response(JSON.stringify([{ id: 'bk1', timestamp: '2026-10-08T10:00:00Z' }]));
    }
    if (/^\/devices\/[^/]+\/backups\/bk1$/.test(path)) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'application/octet-stream' } });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls, uisp: createUisp({ url: 'https://uisp.test', token: 'tok-secret', fetchImpl }) };
}

describe('geo', () => {
  it('computes distance, bearing and Italian cardinal points', () => {
    const rome = { lat: 41.9028, lon: 12.4964 };
    const milan = { lat: 45.4642, lon: 9.19 };
    assert.ok(Math.abs(distanceM(rome, milan) / 1000 - 477) < 5);
    assert.equal(cardinal(bearingDeg(rome, milan)), 'NO');
    assert.equal(cardinal(0), 'N');
    assert.equal(cardinal(268), 'O');
  });
});

describe('UISP client', () => {
  it('normalises devices defensively', () => {
    const d = normalizeDevice(STATION);
    assert.equal(d.mac, 'AA:BB:CC:DD:EE:FF');
    assert.equal(d.authorized, false);
    assert.equal(d.apId, 'ap-n2');
    assert.equal(normalizeDevice({}).id, '');
  });

  it('returns only the nearest APs within the radius, with bearing', async () => {
    const { uisp, calls } = fakeUisp();
    const list = await uisp.nearestAps({ lat: 37.55, lon: 14.05 }, 5, 15);
    assert.deepEqual(list.map((a) => a.id), ['ap-n7', 'ap-n2']); // ap-far excluded (Milano)
    assert.ok(list[0]!.distanceM < list[1]!.distanceM);
    assert.equal(typeof list[0]!.bearing, 'number');
    assert.ok(calls.every((c) => c.token === 'tok-secret'));
  });

  it('falls back to PUT when POST /authorize is not available', async () => {
    const { uisp, calls } = fakeUisp({ authorizeMethod: 'PUT' });
    await uisp.authorize('cpe-1', 'site-n2');
    assert.deepEqual(calls.filter((c) => c.path.endsWith('/authorize')).map((c) => c.method), ['POST', 'PUT']);
  });

  it('geocodes through Nominatim', async () => {
    const { fetchImpl, calls } = fakeUisp();
    const g = createGeocoder({ url: 'https://geo.test', fetchImpl });
    const r = await g.search('Via Roma 1 Enna');
    assert.equal(r[0]?.lat, 37.58);
    await g.search('via roma 1 enna'); // cached (case-insensitive)
    assert.equal(calls.filter((c) => c.path === '/search').length, 1);
  });
});

describe('UISP + GPS API', () => {
  it('stores the CPE position, suggests APs and accepts the CPE in UISP from the history', async () => {
    const fake = fakeUisp();
    const cfg = testConfig({ GEOCODER_URL: 'https://geo.test' });
    const { app } = await buildApp(cfg, 'test', { db: openDatabase(':memory:'), logger: false, uisp: fake.uisp, fetchImpl: fake.fetchImpl });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: ADMIN.username, password: ADMIN.password } });
    const H = { authorization: `Bearer ${login.json().token}` };
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, extra: Record<string, string> = {}) =>
      app.inject({ method, url, headers: { ...H, ...extra }, payload });

    assert.equal((await call('GET', '/api/meta')).json().uisp, true);

    // address -> coordinates -> nearest APs with node/district parsed from the SSID
    const geo = (await call('GET', '/api/geocode?q=Via%20Roma%201%20Enna')).json();
    const cov = (await call('GET', `/api/coverage?lat=${geo[0].lat}&lon=${geo[0].lon}`)).json();
    assert.equal(cov.aps[0].id, 'ap-n2');
    assert.equal(cov.aps[0].node, 2);
    assert.equal(cov.aps[0].district, 1);
    assert.ok(cov.aps.every((a: { distanceM: number }) => a.distanceM <= 15_000));
    assert.equal((await call('GET', '/api/coverage?lat=0&lon=0')).statusCode, 400);

    // provisioning with GPS position
    await call('POST', '/api/admin/profiles/LiteBeam%205AC/templates', { name: 'Standard', template: SAMPLE_TEMPLATE, boardMatch: 'board\\.name=LiteBeam 5AC' });
    await call('PUT', '/api/admin/wireless-networks/CDA-NET-N2-D01', { wpa2Password: 'test-psk-12345' });
    const job = (
      await call(
        'POST',
        '/api/provisioning/jobs',
        {
          model: 'LiteBeam 5AC',
          mac: 'AABBCCDDEEFF',
          serial: 'S1',
          ssid: 'CDA-NET-N2-D01',
          pppoeUser: 'rossi.mario@cda-net.it',
          pppoePassword: 'x',
          location: { latitude: 37.5801234, longitude: 14.1201234, accuracy: 6, source: 'gps' },
        },
        { 'x-cda-client': 'android/1.0.7' },
      )
    ).json();
    assert.match(job.config.text, /^system\.latitude=37\.580123$/m);
    assert.match(job.config.text, /^system\.longitude=14\.120123$/m);
    const hist = (await call('GET', '/api/provisioning/jobs')).json();
    assert.equal(hist[0].latitude, 37.5801234);
    assert.equal(hist[0].locationSource, 'gps');

    // UISP status: pending device found by MAC, proposed site = site of the AP it is associated with
    const st = (await call('GET', `/api/provisioning/jobs/${job.jobId}/uisp`)).json();
    assert.equal(st.device.id, 'cpe-1');
    assert.equal(st.device.authorized, false);
    assert.deepEqual(st.proposedSite, { id: 'site-n2', name: 'Nodo 2 - Monte' });

    const acc = (await call('POST', `/api/admin/provisioning/jobs/${job.jobId}/uisp/authorize`, {})).json();
    assert.deepEqual(acc, { ok: true, deviceId: 'cpe-1', site: 'Nodo 2 - Monte', backup: 'created' });
    assert.ok(fake.calls.some((c) => c.method === 'POST' && c.path === '/devices/cpe-1/authorize' && (c.body as { siteId: string }).siteId === 'site-n2'));
    assert.ok(fake.calls.some((c) => c.method === 'POST' && c.path === '/devices/cpe-1/backups'));
    assert.equal((await call('POST', `/api/admin/provisioning/jobs/${job.jobId}/uisp/authorize`, {})).json().error, 'uisp_already_authorized');
    const after = (await call('GET', '/api/provisioning/jobs')).json()[0];
    assert.equal(after.uispSite, 'Nodo 2 - Monte');
    assert.ok(after.uispAuthorizedAt);

    // backups
    const bks = (await call('GET', `/api/admin/provisioning/jobs/${job.jobId}/uisp/backups`)).json();
    assert.equal(bks[0].id, 'bk1');
    const file = await call('GET', `/api/admin/provisioning/jobs/${job.jobId}/uisp/backups/bk1`);
    assert.equal(file.statusCode, 200);
    assert.deepEqual([...file.rawPayload], [1, 2, 3]);
    assert.match(String(file.headers['content-disposition']), /attachment; filename="backup-ROSSI_MARIO-bk1\.unms"/);

    // token never reaches the client
    for (const r of [st, acc, bks, cov]) assert.ok(!JSON.stringify(r).includes('tok-secret'));
    await app.close();
  });

  it('reports UISP as not configured without credentials', async () => {
    const { app } = await buildApp(testConfig(), 'test', { db: openDatabase(':memory:'), logger: false, uisp: null });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: ADMIN.username, password: ADMIN.password } });
    const H = { authorization: `Bearer ${login.json().token}` };
    assert.equal((await app.inject({ method: 'GET', url: '/api/coverage?lat=37.5&lon=14.1', headers: H })).json().error, 'uisp_not_configured');
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/admin/uisp/status', headers: H })).json(), { configured: false });
    await app.close();
  });
});
