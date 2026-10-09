import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { ADMIN, testConfig } from './helpers.ts';

const ANDROID = { 'x-cda-client': 'android/1.25.0' };

describe('Impostazioni server dal web (invece del .env)', () => {
  it('sets the CPE password and network from the console, never exposing secrets', async () => {
    const db = openDatabase(':memory:');
    const cfg = testConfig();
    const { app } = await buildApp(cfg, 'test', { db, logger: false, uisp: null });
    const login = async (u: string, p: string) => ({ authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: p } })).json().token}` });
    const H = await login(ADMIN.username, ADMIN.password);
    const call = (method: 'GET' | 'PUT' | 'POST', url: string, payload?: object, headers: Record<string, string> = H) => app.inject({ method, url, headers, payload });

    const v0 = (await call('GET', '/api/admin/server-settings')).json();
    const pw = v0.settings.find((s: { key: string }) => s.key === 'cpe.adminPassword');
    assert.equal(pw.source, 'env');
    assert.equal(pw.isSet, true);
    assert.equal(pw.value, null, 'secrets are never returned');
    assert.ok(!JSON.stringify(v0).includes('Cpe-Admin-Secret-1'));

    const r = await call('PUT', '/api/admin/server-settings', { values: { 'cpe.adminPassword': 'Nuova-Password-Cpe-9', 'network.lanIp': '192.168.10.254', jwtTtlHours: 12 } });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json().restartNeeded, ['jwtTtlHours']);
    assert.ok(!r.body.includes('Nuova-Password-Cpe-9'));
    const stored = (db.prepare("SELECT value FROM settings WHERE key = 'server.settings'").get() as { value: string }).value;
    assert.ok(!stored.includes('Nuova-Password-Cpe-9'), 'sealed in the database');
    assert.equal(r.json().settings.find((s: { key: string }) => s.key === 'cpe.adminPassword').source, 'web');

    // applied at once: the field tools get the new password and the new LAN IP
    await call('POST', '/api/admin/users', { username: 'tecnico', password: 'Installer-Pass-123' });
    const T = await login('tecnico', 'Installer-Pass-123');
    const access = (await call('POST', '/api/field/access', { purpose: 'diagnosis' }, { ...T, ...ANDROID })).json();
    assert.equal(access.credentials.password, 'Nuova-Password-Cpe-9');
    assert.ok(access.hosts.includes('192.168.10.254'));

    // validation, unknown keys, admins only, activity log without values
    assert.equal((await call('PUT', '/api/admin/server-settings', { values: { 'network.lanIp': '999.1.1.1' } })).statusCode, 400);
    assert.equal((await call('PUT', '/api/admin/server-settings', { values: { nonEsiste: 1 } })).json().error, 'unknown_setting');
    assert.equal((await call('GET', '/api/admin/server-settings', undefined, T)).statusCode, 403);
    const log = JSON.stringify(db.prepare("SELECT * FROM events WHERE action = 'server.settings'").all());
    assert.ok(log.includes('cpe.adminPassword') && !log.includes('Nuova-Password-Cpe-9'));

    // back to the .env value
    await call('PUT', '/api/admin/server-settings', { values: { 'network.lanIp': null } });
    assert.equal((await call('GET', '/api/admin/server-settings')).json().settings.find((s: { key: string }) => s.key === 'network.lanIp').value, cfg.network.lanIp);
    assert.equal(cfg.network.lanIp, '192.168.1.254');
    assert.equal((await call('POST', '/api/admin/server-settings/restart', {})).statusCode, 200);
    await app.close();

    // after a restart the values set from the web are applied again
    const cfg2 = testConfig();
    cfg2.masterKey = cfg.masterKey; // same server, same master key
    const again = await buildApp(cfg2, 'test', { db, logger: false, uisp: null });
    const H2 = { authorization: `Bearer ${(await again.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'tecnico', password: 'Installer-Pass-123' } })).json().token}` };
    const a2 = (await again.app.inject({ method: 'POST', url: '/api/field/access', headers: { ...H2, ...ANDROID }, payload: {} })).json();
    assert.equal(a2.credentials.password, 'Nuova-Password-Cpe-9');
    assert.equal(again.ctx.cfg.jwtTtlHours, 12);
    await again.app.close();
  });
});
