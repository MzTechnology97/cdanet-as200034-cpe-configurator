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

    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/coverage/simulation?apId=nope', headers: H })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/coverage/simulation?apId=ap-n2', headers: T })).statusCode, 403, 'installers: no simulation');
  });
});
