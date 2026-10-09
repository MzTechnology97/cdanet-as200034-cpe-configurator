import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { testApp } from './helpers.ts';

const ANDROID = { 'x-cda-client': 'android/1.30.0' };

describe('Accesso rapido biometrico dall’app', () => {
  it('registers the phone after a full login, logs in with the device key, revokes with sessions', async () => {
    const t = await testApp();
    const admin = await t.login();
    await t.app.inject({ method: 'POST', url: '/api/admin/users', headers: t.auth(admin), payload: { username: 'tecnico', password: 'Installer-Pass-123' } });
    const tec = await t.login('tecnico', 'Installer-Pass-123');
    const call = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object, headers: Record<string, string> = {}) => t.app.inject({ method, url, headers, payload });

    // Android app only, signed in
    assert.equal((await call('POST', '/api/auth/devices', { name: 'Pixel 8' }, t.auth(tec))).statusCode, 403);
    assert.equal((await call('POST', '/api/auth/devices', { name: 'Pixel 8' }, ANDROID)).statusCode, 401);
    const reg = await call('POST', '/api/auth/devices', { name: 'Pixel 8' }, t.auth(tec, ANDROID));
    assert.equal(reg.statusCode, 201, reg.body);
    const { id, secret } = reg.json();
    assert.ok(secret.length >= 40);
    assert.ok(!JSON.stringify(t.db.prepare('SELECT * FROM auth_devices').all()).includes(secret), 'only the hash is stored');

    // quick login: a full session, no password
    const q = await call('POST', '/api/auth/device-login', { id, secret }, ANDROID);
    assert.equal(q.statusCode, 200, q.body);
    assert.equal(q.json().user.username, 'tecnico');
    const me = await call('GET', '/api/auth/me', undefined, { authorization: `Bearer ${q.json().token}` });
    assert.equal(me.json().user.username, 'tecnico');
    assert.equal((await call('POST', '/api/auth/device-login', { id, secret: 'x'.repeat(43) }, ANDROID)).json().error, 'device_revoked');
    assert.equal((await call('POST', '/api/auth/device-login', { id, secret }, {})).statusCode, 403, 'app only');

    const list = (await call('GET', '/api/auth/devices', undefined, t.auth(tec))).json().devices;
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'Pixel 8');
    assert.equal(list[0].active, true);
    assert.ok(list[0].lastUsedAt);

    // "esci da tutti i dispositivi" revokes the phone too
    await call('POST', '/api/auth/logout-all', {}, t.auth(q.json().token));
    assert.equal((await call('POST', '/api/auth/device-login', { id, secret }, ANDROID)).json().error, 'device_revoked');
    const tec2 = await t.login('tecnico', 'Installer-Pass-123');
    assert.equal((await call('GET', '/api/auth/devices', undefined, t.auth(tec2))).json().devices[0].active, false);

    // a new registration works again; removing it from the account stops it
    const reg2 = (await call('POST', '/api/auth/devices', { name: 'Pixel 8' }, t.auth(tec2, ANDROID))).json();
    assert.equal((await call('POST', '/api/auth/device-login', reg2, ANDROID)).statusCode, 200);
    const other = await t.login();
    assert.equal((await call('DELETE', `/api/auth/devices/${reg2.id}`, undefined, t.auth(other))).statusCode, 404, 'only the owner');
    assert.equal((await call('DELETE', `/api/auth/devices/${reg2.id}`, undefined, t.auth(tec2))).statusCode, 200);
    assert.equal((await call('POST', '/api/auth/device-login', reg2, ANDROID)).statusCode, 401);

    // a deactivated account cannot use it
    const reg3 = (await call('POST', '/api/auth/devices', { name: 'Pixel 8' }, t.auth(tec2, ANDROID))).json();
    const tid = (t.db.prepare("SELECT id FROM users WHERE username = 'tecnico'").get() as { id: number }).id;
    t.db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(tid);
    assert.equal((await call('POST', '/api/auth/device-login', reg3, ANDROID)).statusCode, 401);

    const events = JSON.stringify(t.db.prepare("SELECT action FROM events WHERE action LIKE 'account.quick_login%'").all());
    assert.ok(events.includes('account.quick_login_on') && events.includes('account.quick_login') && events.includes('account.quick_login_off'));
    await t.app.close();
  });
});
