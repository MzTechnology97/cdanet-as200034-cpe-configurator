import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { ADMIN, testConfig } from './helpers.ts';
import { fakeUisp } from './fake-uisp.ts';

describe('Connettori: UISP configured from the console', () => {
  it('tests before saving, saves with sealed token, applies live and falls back to .env', async () => {
    const fake = fakeUisp();
    const db = openDatabase(':memory:');
    const { app, ctx } = await buildApp(testConfig(), 'test', { db, logger: false, fetchImpl: fake.fetchImpl });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: ADMIN.username, password: ADMIN.password } });
    const H = { authorization: `Bearer ${login.json().token}` };
    const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) => app.inject({ method, url, headers: H, payload });

    const before = (await call('GET', '/api/admin/connectors')).json();
    assert.equal(before.uisp.source, 'none');
    assert.equal(before.uisp.active, false);
    assert.equal((await call('GET', '/api/coverage?lat=37.58&lon=14.12')).json().error, 'uisp_not_configured');

    // test without saving: wrong token, then the right one (API URL pasted with /nms/api/v2.1 is accepted)
    const bad = (await call('POST', '/api/admin/connectors/uisp/test', { url: 'https://uisp.test', token: 'wrong' })).json();
    assert.equal(bad.ok, false);
    const good = (await call('POST', '/api/admin/connectors/uisp/test', { url: 'https://uisp.test/nms/api/v2.1/', token: 'tok-secret' })).json();
    assert.equal(good.ok, true, JSON.stringify(good));
    assert.equal(good.version, '3.1.65');
    assert.equal(good.aps, 3);
    assert.equal((await call('GET', '/api/admin/connectors')).json().uisp.source, 'none'); // nothing saved by a test

    // save -> active immediately, token never returned
    const saved = await call('PUT', '/api/admin/connectors/uisp', {
      enabled: true,
      url: 'https://uisp.test',
      token: 'tok-secret',
      ignoreTls: false,
      autoBackup: false,
      coverageMaxKm: 8,
      cacheSeconds: 30,
    });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().active, true);
    assert.equal(saved.json().tokenHint, '…cret');
    assert.ok(!saved.body.includes('tok-secret'));
    const row = db.prepare("SELECT value FROM settings WHERE key = 'connector.uisp'").get() as { value: string };
    assert.ok(!row.value.includes('tok-secret'), 'token sealed at rest');
    const cov = (await call('GET', '/api/coverage?lat=37.58&lon=14.12')).json();
    assert.equal(cov.maxKm, 8);
    assert.ok(cov.aps.length > 0);
    assert.equal(ctx.uispSettings.autoBackup, false);

    // empty token keeps the saved one; test also uses the saved token
    const kept = (await call('PUT', '/api/admin/connectors/uisp', { enabled: true, url: 'https://uisp.test', coverageMaxKm: 10 })).json();
    assert.equal(kept.tokenHint, '…cret');
    assert.equal((await call('POST', '/api/admin/connectors/uisp/test', { url: 'https://uisp.test' })).json().ok, true);

    // ignore TLS builds an insecure client without breaking the configuration
    const insecure = (await call('PUT', '/api/admin/connectors/uisp', { enabled: true, url: 'https://uisp.test', ignoreTls: true })).json();
    assert.equal(insecure.ignoreTls, true);
    assert.equal(insecure.active, true);

    // disable, then reset to .env (none here)
    assert.equal((await call('PUT', '/api/admin/connectors/uisp', { enabled: false, url: 'https://uisp.test' })).json().active, false);
    const reset = (await call('DELETE', '/api/admin/connectors/uisp')).json();
    assert.equal(reset.source, 'none');
    const events = (await call('GET', '/api/admin/events')).json().map((e: { action: string }) => e.action);
    assert.ok(events.includes('connector.uisp.update') && events.includes('connector.uisp.reset'));

    // installers cannot see or change connectors
    await call('POST', '/api/admin/users', { username: 'tecnico', password: 'Installer-Pass-123' });
    const inst = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'tecnico', password: 'Installer-Pass-123' } });
    const r = await app.inject({ method: 'GET', url: '/api/admin/connectors', headers: { authorization: `Bearer ${inst.json().token}` } });
    assert.equal(r.statusCode, 403);
    await app.close();
  });

  it('uses the .env configuration when nothing is saved in the console', async () => {
    const fake = fakeUisp();
    const { app } = await buildApp(testConfig({ UISP_API_URL: 'https://uisp.test', UISP_API_TOKEN: 'tok-secret' }), 'test', {
      db: openDatabase(':memory:'),
      logger: false,
      fetchImpl: fake.fetchImpl,
    });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: ADMIN.username, password: ADMIN.password } });
    const v = (await app.inject({ method: 'GET', url: '/api/admin/connectors', headers: { authorization: `Bearer ${login.json().token}` } })).json();
    assert.equal(v.uisp.source, 'env');
    assert.equal(v.uisp.active, true);
    assert.ok(!JSON.stringify(v).includes('tok-secret'));
    await app.close();
  });
});
