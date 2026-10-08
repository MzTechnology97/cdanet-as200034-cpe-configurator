import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { summarizeSeries } from '../src/services/uisp.ts';
import { fakeUisp } from './fake-uisp.ts';
import { ADMIN, SAMPLE_TEMPLATE, testConfig } from './helpers.ts';

describe('UISP signal history', () => {
  it('summarises series defensively', () => {
    assert.deepEqual(summarizeSeries(undefined), { points: [], min: null, avg: null, max: null, trend: null });
    const s = summarizeSeries({ avg: [{ x: 3, y: -60 }, { x: 1, y: -50 }, { x: 2, y: null }, { x: 4, y: -70 }] });
    assert.deepEqual(s.points, [[1, -50], [3, -60], [4, -70]]);
    assert.equal(s.min, -70);
    assert.equal(s.max, -50);
    assert.equal(s.trend, null); // too few points
    const long = summarizeSeries({ avg: Array.from({ length: 500 }, (_, i) => ({ x: i, y: -50 - i / 50 })) });
    assert.ok(long.points.length <= 201);
    assert.ok(long.trend! < -7);
  });

  it('serves the history of the CPE of a job, with outages', async () => {
    const fake = fakeUisp();
    const { app } = await buildApp(testConfig(), 'test', { db: openDatabase(':memory:'), logger: false, uisp: fake.uisp });
    const tok = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: ADMIN.username, password: ADMIN.password } })).json().token;
    const H = { authorization: `Bearer ${tok}` };
    await app.inject({ method: 'POST', url: '/api/admin/profiles/LiteBeam%205AC/templates', headers: H, payload: { name: 'Standard', template: SAMPLE_TEMPLATE, boardMatch: 'board\.name=LiteBeam 5AC' } });
    await app.inject({ method: 'PUT', url: '/api/admin/wireless-networks/CDA-NET-N2-D01', headers: H, payload: { wpa2Password: 'test-psk-12345' } });
    const job = (
      await app.inject({
        method: 'POST', url: '/api/provisioning/jobs', headers: { ...H, 'x-cda-client': 'android/1.3.0' },
        payload: { model: 'LiteBeam 5AC', mac: 'AA:BB:CC:DD:EE:FF', serial: 'S', ssid: 'CDA-NET-N2-D01', pppoeUser: 'rossi.mario@cda-net.it', pppoePassword: 'x' },
      })
    ).json();
    const r = await app.inject({ method: 'GET', url: `/api/provisioning/jobs/${job.jobId}/uisp/statistics?range=week`, headers: H });
    assert.equal(r.statusCode, 200, r.body);
    const b = r.json();
    assert.equal(b.device.id, 'cpe-1');
    assert.equal(b.signal.max, -58);
    assert.equal(b.signal.min, -66);
    assert.ok(b.signal.trend < -5, 'degradation detected');
    assert.equal(b.downlinkCapacity.avg, 250000);
    assert.equal(b.outages.length, 1);
    const call = fake.calls.find((c) => c.path.endsWith('/statistics'));
    assert.ok(call);
    assert.equal((await app.inject({ method: 'GET', url: `/api/provisioning/jobs/${job.jobId}/uisp/statistics?range=year`, headers: H })).statusCode, 400);
    await app.close();
  });
});
