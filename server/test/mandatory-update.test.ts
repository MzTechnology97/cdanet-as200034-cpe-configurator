import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ADMIN, testApp } from './helpers.ts';

describe('Aggiornamento obbligatorio dell’app', () => {
  it('blocks every call of an app older than the latest release, except the update channel', async () => {
    const t = await testApp();
    const apk = Buffer.from('fake-apk-1.31.0');
    mkdirSync(t.cfg.releases.dir, { recursive: true });
    writeFileSync(join(t.cfg.releases.dir, 'CDA-Net-CPE-1.31.0.apk'), apk);
    writeFileSync(
      join(t.cfg.releases.dir, 'latest.json'),
      JSON.stringify({ versionCode: 13100, versionName: '1.31.0', sha256: createHash('sha256').update(apk).digest('hex'), fileName: 'CDA-Net-CPE-1.31.0.apk' }),
    );
    const login = (headers: Record<string, string>) =>
      t.app.inject({ method: 'POST', url: '/api/auth/login', headers, payload: { username: ADMIN.username, password: ADMIN.password } });

    // older app: no login, no API; the error says which version is needed
    const old = await login({ 'x-cda-client': 'android/1.30.0' });
    assert.equal(old.statusCode, 426);
    assert.deepEqual(old.json(), { error: 'client_update_required', minVersion: '1.31.0' });
    // apps before v1.31 send no header on login: their OkHttp user agent is enough
    assert.equal((await login({ 'user-agent': 'okhttp/4.12.0' })).statusCode, 426);
    // the update channel and the APK stay reachable, and the update is marked mandatory
    const upd = await t.app.inject({ method: 'GET', url: '/api/mobile/update', headers: { 'user-agent': 'okhttp/4.12.0' } });
    assert.equal(upd.statusCode, 200);
    assert.equal(upd.json().mandatory, true);
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/mobile/apk', headers: { 'x-cda-client': 'android/1.30.0' } })).statusCode, 200);
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/health', headers: { 'x-cda-client': 'android/1.0.0' } })).statusCode, 200);

    // the current app and the web console work
    const ok = await login({ 'x-cda-client': 'android/1.31.0' });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal((await login({ 'x-cda-client': 'android/1.31.0-debug' })).statusCode, 200);
    assert.equal((await login({ 'user-agent': 'Mozilla/5.0 Chrome/130' })).statusCode, 200);
    const H = { authorization: `Bearer ${ok.json().token}` };
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/meta', headers: { ...H, 'x-cda-client': 'android/1.30.0' } })).statusCode, 426, 'also with a valid session');

    // switched off from Impostazioni server: only the pinned minimum applies
    const put = await t.app.inject({ method: 'PUT', url: '/api/admin/server-settings', headers: H, payload: { values: { appForceLatest: false } } });
    assert.equal(put.statusCode, 200, put.body);
    assert.equal((await login({ 'x-cda-client': 'android/1.30.0' })).statusCode, 200);
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/mobile/update' })).json().mandatory, false);
    await t.app.close();
  });
});
