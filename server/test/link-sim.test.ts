import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { linkSignalDbm } from '../src/domain/coverage-model.ts';
import { fakeUisp } from './fake-uisp.ts';
import { ADMIN, testConfig } from './helpers.ts';

describe('Simulazione A → B (21/10/2026)', () => {
  it('the budget: EIRP and gain, free space, the real losses and the terrain', () => {
    const clear = linkSignalDbm(5000, 5600, 30, 23, 0);
    assert.equal(linkSignalDbm(5000, 5600, 30, 23, 12), clear - 12, 'the terrain lowers it dB for dB');
    assert.ok(linkSignalDbm(10000, 5600, 30, 23, 0) <= clear - 5, 'twice as far: about 6 dB less');
  });

  it('two points by hand: profile, Fresnel, obstacles, signal and modulation; admins and specialists only', async () => {
    const fake = fakeUisp();
    const db = openDatabase(':memory:');
    const { app } = await buildApp(testConfig(), 'test', { db, logger: false, uisp: fake.uisp });
    const login = async (u: { username: string; password: string }) => ({
      authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: u })).json().token}`,
    });
    const A = await login(ADMIN);
    const get = (q: string, h = A) => app.inject({ method: 'GET', url: `/api/coverage/link?${q}`, headers: h });
    const r = await get('aLat=37.58&aLon=14.12&bLat=37.6&bLon=14.1&aH=6&bH=15&freq=5500&eirp=36&gain=23');
    if (r.statusCode === 503) {
      assert.match(r.body, /dem_/); // no elevation model in this test run
    } else {
      assert.equal(r.statusCode, 200, r.body);
      const j = r.json();
      assert.ok(j.distanceM > 2500 && j.distanceM < 3200, String(j.distanceM));
      assert.equal(j.frequencyMhz, 5500);
      assert.ok(Array.isArray(j.chart) && j.chart.length >= 12);
      assert.ok(['clear', 'fresnel', 'blocked'].includes(j.verdict), j.verdict);
      assert.equal(typeof j.estimate.signalDbm, 'number');
      assert.equal(j.estimate.signalDbm, linkSignalDbm(j.distanceM, 5500, 36, 23, j.lossDb), 'the budget of the profile');
      assert.equal(typeof j.diffractionDb, 'number');
      assert.equal(j.physical.signalDbm, linkSignalDbm(j.distanceM, 5500, 36, 23, j.diffractionDb), 'and with the pure diffraction');
      assert.deepEqual([j.a.heightM, j.b.heightM, j.radio.eirpDbm, j.tooFar], [6, 15, 36, false]);
      assert.deepEqual(j.ap, { lat: 37.6, lon: 14.1 });
    }
    assert.equal((await get('aLat=37.58&aLon=14.12&bLat=37.58&bLon=14.12')).json().error, 'link_too_short');
    assert.equal((await get('aLat=37.58&aLon=14.12&bLat=39.5&bLon=14.12')).json().error, 'link_too_long');
    assert.equal((await get('aLat=137&aLon=14.12&bLat=37.6&bLon=14.1')).statusCode, 400);
    // installers: not this tool (two points of their choice on CDA Net's terrain is a staff tool)
    await app.inject({ method: 'POST', url: '/api/admin/users', headers: A, payload: { username: 'tecnico', password: 'Installer-Pass-123' } });
    assert.equal((await get('aLat=37.58&aLon=14.12&bLat=37.6&bLon=14.1', await login({ username: 'tecnico', password: 'Installer-Pass-123' }))).statusCode, 403);
    await app.close();
  });
});
