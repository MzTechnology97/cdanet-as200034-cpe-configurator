import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { ADMIN, testConfig } from './helpers.ts';

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9';
const NOW = Math.floor(Date.now() / 1000);

/** VRM fake: one user with three POP systems (one in alarm, one silent for two hours). */
function fakeVrm() {
  const calls: Array<{ url: string; auth: string | null; method: string }> = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get('x-authorization');
    calls.push({ url: url.toString(), auth, method: init?.method ?? 'GET' });
    if (url.host !== 'vrmapi.victronenergy.com') return new Response('{}', { status: 404 });
    if (auth !== `Token ${TOKEN}`) return Response.json({ success: false, errors: 'Invalid token', error_code: 'invalid_token' }, { status: 401 });
    if (url.pathname === '/v2/users/me') return Response.json({ success: true, user: { id: 4242, name: 'NOC CDA Net', email: 'noc@example.test', country: 'IT', accessLevel: 1 } });
    if (url.pathname === '/v2/users/4242/installations') {
      assert.equal(url.searchParams.get('extended'), '1');
      return Response.json({
        success: true,
        records: [
          { idSite: 101, name: 'POP Demo Monte', identifier: 'c0619ab00001', last_timestamp: NOW - 120, alarm: false, num_alarms: 0, phonenumber: '+39 000 0000000' },
          { idSite: 102, name: 'POP Demo Valle', identifier: 'c0619ab00002', last_timestamp: NOW - 60, alarm: true, num_alarms: 2 },
          { idSite: 103, name: 'POP Demo Colle', identifier: 'c0619ab00003', last_timestamp: NOW - 7200, alarm: false, num_alarms: 0 },
        ],
      });
    }
    return Response.json({ success: false, errors: 'Not found' }, { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('Connettore Victron VRM', () => {
  it('keeps the token sealed, tests with counts only and never writes to VRM', async () => {
    const fake = fakeVrm();
    const db = openDatabase(':memory:');
    const { app } = await buildApp(testConfig(), 'test', { db, logger: false, uisp: null, fetchImpl: fake.fetchImpl });
    const login = async (u: string, p: string) => ({ authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: p } })).json().token}` });
    const A = await login(ADMIN.username, ADMIN.password);
    const call = (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: object, headers = A) => app.inject({ method, url, headers, payload });

    // not configured
    const empty = (await call('GET', '/api/admin/connectors')).json().victron;
    assert.deepEqual([empty.configured, empty.enabled, empty.tokenSet], [false, false, false]);
    assert.equal((await call('PUT', '/api/admin/connectors/victron', { enabled: true })).json().error, 'vrm_incomplete');
    assert.equal((await call('POST', '/api/admin/connectors/victron/test', {})).json().error, 'vrm_incomplete');

    // test before saving: the token in the form, counts of the installations
    const t = (await call('POST', '/api/admin/connectors/victron/test', { token: TOKEN })).json();
    assert.deepEqual([t.ok, t.user, t.installations, t.withAlarms, t.silent], [true, 'NOC CDA Net', 3, 1, 1]);
    assert.ok(!JSON.stringify(t).includes('POP Demo') && !JSON.stringify(t).includes('noc@example.test'), 'no installation or e-mail in the test answer');
    assert.ok(fake.calls.every((c) => c.method === 'GET'), 'read only');
    assert.ok(fake.calls.every((c) => c.auth === `Token ${TOKEN}`), 'access token header');

    // saved: the token is sealed in the DB, never returned, never in the activity log
    const saved = (await call('PUT', '/api/admin/connectors/victron', { enabled: true, token: TOKEN })).json();
    assert.deepEqual([saved.configured, saved.enabled, saved.tokenHint], [true, true, '…e8f9']);
    assert.ok(!JSON.stringify(db.prepare("SELECT value FROM settings WHERE key = 'connector.victron'").get()).includes(TOKEN));
    assert.ok(!(await call('GET', '/api/admin/connectors')).body.includes(TOKEN));
    const log = JSON.stringify(db.prepare("SELECT * FROM events WHERE action LIKE 'connector.victron.%'").all());
    assert.ok(log.includes('nuovo token') && log.includes('3 impianti · 1 con allarmi · 1 senza dati') && !log.includes(TOKEN));

    // saving again without the token keeps it; the test uses the saved one
    await call('PUT', '/api/admin/connectors/victron', { enabled: true });
    assert.equal((await call('POST', '/api/admin/connectors/victron/test', {})).json().ok, true);

    // a wrong token
    const bad = (await call('POST', '/api/admin/connectors/victron/test', { token: 'sbagliato' })).json();
    assert.deepEqual([bad.ok, bad.error, bad.status], [false, 'vrm_auth_failed', 401]);

    // admins only
    await call('POST', '/api/admin/users', { username: 'tecnico', password: 'Installer-Pass-123' });
    const T = await login('tecnico', 'Installer-Pass-123');
    assert.equal((await call('POST', '/api/admin/connectors/victron/test', {}, T)).statusCode, 403);
    assert.equal((await call('PUT', '/api/admin/connectors/victron', { enabled: false }, T)).statusCode, 403);

    // removed
    assert.equal((await call('DELETE', '/api/admin/connectors/victron')).json().configured, false);
    await app.close();
  });
});
