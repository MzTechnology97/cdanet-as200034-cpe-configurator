import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { ADMIN, testConfig } from './helpers.ts';

describe('Field tools access', () => {
  it('gives CPE credentials only to the Android client, audited', async () => {
    const { app } = await buildApp(testConfig(), 'test', { db: openDatabase(':memory:'), logger: false });
    const admin = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: ADMIN.username, password: ADMIN.password } })).json().token;
    await app.inject({ method: 'POST', url: '/api/admin/users', headers: { authorization: `Bearer ${admin}` }, payload: { username: 'tecnico', password: 'Installer-Pass-123' } });
    const tok = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'tecnico', password: 'Installer-Pass-123' } })).json().token;
    const call = (headers: Record<string, string>, payload: object = { purpose: 'alignment', target: '192.168.1.254' }) =>
      app.inject({ method: 'POST', url: '/api/field/access', headers: { authorization: `Bearer ${tok}`, ...headers }, payload });

    assert.equal((await call({})).json().error, 'trusted_client_required');
    assert.equal((await call({ 'x-cda-client': 'android/0.9.0' })).statusCode, 426);
    const r = await call({ 'x-cda-client': 'android/1.2.0' });
    assert.equal(r.statusCode, 200, r.body);
    const b = r.json();
    assert.equal(b.credentials.password, 'Cpe-Admin-Secret-1');
    assert.deepEqual(b.hosts, ['192.168.1.254', '192.168.172.1']);
    assert.equal(b.targetFirmware, '8.7.4');
    assert.equal(b.thresholds.signalMin, -75);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal((await call({ 'x-cda-client': 'android/1.2.0' }, { purpose: 'hack' })).statusCode, 400);

    const ev = (await app.inject({ method: 'GET', url: '/api/admin/events', headers: { authorization: `Bearer ${admin}` } })).json();
    const access = ev.find((e: { action: string }) => e.action === 'field.access');
    assert.ok(access);
    assert.ok(!JSON.stringify(ev).includes('Cpe-Admin-Secret-1'));
    await app.close();
  });
});
