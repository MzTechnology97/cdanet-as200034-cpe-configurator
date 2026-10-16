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
    // no template yet: only the factory address; then the LAN address of every template, default first
    assert.deepEqual(b.hosts, ['192.168.172.1']);
    const H = { authorization: `Bearer ${admin}` };
    const draft = (await app.inject({ method: 'POST', url: '/api/admin/profiles/LiteBeam%205AC/form/read', headers: H, payload: {} })).json();
    const lan = (await app.inject({ method: 'POST', url: '/api/admin/profiles/LiteBeam%205AC/form/apply', headers: H, payload: { template: draft.template, changes: { lanIp: '192.168.5.1', sshPort: 2222 } } })).json();
    const made = await app.inject({ method: 'POST', url: '/api/admin/profiles/LiteBeam%205AC/templates', headers: H, payload: { name: 'Standard', template: lan.template, boardMatch: 'board\.name=LiteBeam' } });
    assert.equal(made.statusCode, 201, made.body);
    const b2 = (await call({ 'x-cda-client': 'android/1.2.0' })).json();
    assert.deepEqual(b2.hosts, ['192.168.5.1', '192.168.172.1']);
    assert.equal(b2.sshPort, 2222);
    assert.deepEqual(b2.sshPorts, [2222, 22]);
    assert.equal(b.targetFirmware, '8.7.4');
    // kept on the phone as long as the app may work without Internet (24 h by default)
    const hours = (Date.parse(b.expiresAt) - Date.now()) / 3600_000;
    assert.ok(hours > 23.9 && hours <= 24, String(hours));
    assert.equal((await app.inject({ method: 'GET', url: '/api/meta', headers: { authorization: `Bearer ${tok}` } })).json().offlineSessionHours, 24);
    assert.equal(b.thresholds.signalMin, -75);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal((await call({ 'x-cda-client': 'android/1.2.0' }, { purpose: 'hack' })).statusCode, 400);

    // what the app did offline: in the log at the time it happened, never too old or in the future
    const sent = await app.inject({
      method: 'POST',
      url: '/api/field/offline-events',
      headers: { authorization: `Bearer ${tok}`, 'x-cda-client': 'android/1.2.0' },
      payload: {
        events: [
          { at: new Date(Date.now() - 3 * 3600_000).toISOString(), action: 'field.offline_use', target: '192.168.1.254', detail: 'diagnosi' },
          { at: new Date(Date.now() - 30 * 3600_000).toISOString(), action: 'session.offline_resume' },
          { at: new Date(Date.now() + 3600_000).toISOString(), action: 'session.offline_resume' },
        ],
      },
    });
    assert.deepEqual(sent.json(), { saved: 1 });
    const ev = (await app.inject({ method: 'GET', url: '/api/admin/events', headers: { authorization: `Bearer ${admin}` } })).json();
    const offEv = ev.find((e: { action: string }) => e.action === 'field.offline_use');
    assert.ok(offEv && /^senza Internet · diagnosi/.test(offEv.detail) && Date.parse(offEv.createdAt) < Date.now() - 2.9 * 3600_000, JSON.stringify(offEv));
    const access = ev.find((e: { action: string }) => e.action === 'field.access');
    assert.ok(access);
    assert.ok(!JSON.stringify(ev).includes('Cpe-Admin-Secret-1'));
    await app.close();
  });
});
