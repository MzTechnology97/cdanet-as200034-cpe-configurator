import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { ADMIN, testConfig } from './helpers.ts';

const TOKEN = '42|Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0UvWxYz123456';

/** MyWic fake: the account checks FTTH and FTTC of two operators and the FWA of Eolo. */
function fakeMyWic() {
  const calls: Array<{ path: string; auth: string | null; method: string }> = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get('authorization');
    calls.push({ path: url.pathname, auth, method: init?.method ?? 'GET' });
    if (url.host !== 'coverage.mywic.it') return new Response('{}', { status: 404 });
    if (auth !== `Bearer ${TOKEN}`) return Response.json({ message: 'Unauthenticated.' }, { status: 401 });
    if (url.pathname === '/api/v1/coverage/providers')
      return Response.json([
        { name: 'openfiber', technology: 'FTTH' },
        { name: 'tim', technology: 'FTTH' },
        { name: 'tim', technology: 'FTTC' },
        { name: 'eolo', technology: 'WIRELESS' },
      ]);
    return Response.json({ message: 'Not found' }, { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('Connettore copertura multi-operatore (MyWic)', () => {
  it('keeps the token sealed and tests which operators and technologies it can check', async () => {
    const fake = fakeMyWic();
    const db = openDatabase(':memory:');
    const { app } = await buildApp(testConfig(), 'test', { db, logger: false, uisp: null, fetchImpl: fake.fetchImpl });
    const login = async (u: string, p: string) => ({ authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: p } })).json().token}` });
    const A = await login(ADMIN.username, ADMIN.password);
    const call = (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: object, headers = A) => app.inject({ method, url, headers, payload });

    const empty = (await call('GET', '/api/admin/connectors')).json().mywic;
    assert.deepEqual([empty.configured, empty.tokenSet], [false, false]);
    assert.equal((await call('PUT', '/api/admin/connectors/mywic', { enabled: true })).json().error, 'mywic_incomplete');

    const t = (await call('POST', '/api/admin/connectors/mywic/test', { token: TOKEN })).json();
    assert.equal(t.ok, true);
    assert.deepEqual(t.providers, [
      { name: 'eolo', technologies: ['WIRELESS'] },
      { name: 'openfiber', technologies: ['FTTH'] },
      { name: 'tim', technologies: ['FTTC', 'FTTH'] },
    ]);
    assert.ok(fake.calls.every((c) => c.method === 'GET' && c.auth === `Bearer ${TOKEN}`), 'read only, bearer token');

    const saved = (await call('PUT', '/api/admin/connectors/mywic', { enabled: true, token: TOKEN })).json();
    assert.deepEqual([saved.configured, saved.enabled, saved.tokenHint], [true, true, '…3456']);
    assert.ok(!JSON.stringify(db.prepare("SELECT value FROM settings WHERE key = 'connector.mywic'").get()).includes(TOKEN));
    assert.ok(!(await call('GET', '/api/admin/connectors')).body.includes(TOKEN));
    const log = JSON.stringify(db.prepare("SELECT * FROM events WHERE action LIKE 'connector.mywic.%'").all());
    assert.ok(log.includes('nuovo token') && log.includes('3 operatori leggibili') && !log.includes(TOKEN));

    await call('PUT', '/api/admin/connectors/mywic', { enabled: true });
    assert.equal((await call('POST', '/api/admin/connectors/mywic/test', {})).json().ok, true, 'saved token kept and used');
    const bad = (await call('POST', '/api/admin/connectors/mywic/test', { token: 'sbagliato' })).json();
    assert.deepEqual([bad.ok, bad.error, bad.status], [false, 'mywic_auth_failed', 401]);

    await call('POST', '/api/admin/users', { username: 'tecnico', password: 'Installer-Pass-123' });
    const T = await login('tecnico', 'Installer-Pass-123');
    assert.equal((await call('POST', '/api/admin/connectors/mywic/test', {}, T)).statusCode, 403);
    assert.equal((await call('DELETE', '/api/admin/connectors/mywic')).json().configured, false);
    await app.close();
  });
});
