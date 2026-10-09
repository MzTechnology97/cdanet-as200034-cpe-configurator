import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { ADMIN, testConfig } from './helpers.ts';

const API_ID = 'cdanet-noc';
const API_KEY = 'K3y-Segreta-IspBilling-0123456789';

/** ISP Billing fake: the key reads customers and RADIUS, not the warehouse (no permission). */
function fakeIspBilling() {
  const calls: Array<{ url: string; auth: string | null }> = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get('authorization');
    calls.push({ url: url.toString(), auth });
    if (url.host !== 'crm.test') return new Response('{}', { status: 404 });
    if (auth !== `Bearer ${API_ID}:${API_KEY}`) return Response.json({ status: 'ERROR', message: 'Unauthorized' }, { status: 401 });
    const page = (total: number) => Response.json({ status: 'OK', message: null, data: { data: [], max_items: 30, total, prev: null, next: null, pages: 1 } });
    switch (url.pathname) {
      case '/api/modules/crm/customers':
        return page(1236);
      case '/api/modules/ispradius2/accounts':
        return page(1190);
      case '/api/modules/ispradius2/profiles':
        return page(12);
      case '/api/modules/subscription-services/services':
        return Response.json({ status: 'OK', data: [{ service_id: 1 }, { service_id: 2 }] });
      case '/api/modules/subscription-services/service-instances':
        return page(1301);
      case '/api/modules/activities/activities':
        return Response.json({ status: 'SUCCESS', data: { data: [{}, {}, {}] } });
      case '/api/modules/activities/teams':
        return Response.json({ status: 'SUCCESS', data: [{}, {}] });
      default:
        return Response.json({ status: 'ERROR', message: 'Permesso mancante' }, { status: 403 });
    }
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('Connettore CRM (ISP Billing)', () => {
  it('saves the key sealed, never returns it, and tests every module the integration uses', async () => {
    const fake = fakeIspBilling();
    const db = openDatabase(':memory:');
    const { app } = await buildApp(testConfig(), 'test', { db, logger: false, uisp: null, fetchImpl: fake.fetchImpl });
    const login = async (u: string, p: string) => ({ authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: p } })).json().token}` });
    const A = await login(ADMIN.username, ADMIN.password);
    const call = (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: object, headers = A) => app.inject({ method, url, headers, payload });

    // not configured: default address, nothing else
    const empty = (await call('GET', '/api/admin/connectors')).json().crm;
    assert.deepEqual([empty.configured, empty.url, empty.keySet], [false, 'https://ispbilling.it', false]);

    // incomplete, wrong address
    assert.equal((await call('PUT', '/api/admin/connectors/crm', { enabled: true, url: 'https://crm.test', apiId: API_ID })).json().error, 'crm_incomplete');
    assert.equal((await call('PUT', '/api/admin/connectors/crm', { enabled: false, url: 'http://crm.test', apiId: API_ID })).statusCode, 400);

    // test before saving: the key in the form, per-module result
    const t = (await call('POST', '/api/admin/connectors/crm/test', { url: 'https://crm.test/api/docs', apiId: API_ID, apiKey: API_KEY })).json();
    assert.equal(t.ok, true);
    const byKey = Object.fromEntries(t.modules.map((m: { key: string }) => [m.key, m]));
    assert.deepEqual([byKey.customers.count, byKey.radius_accounts.count, byKey.services.count, byKey.activities.count], [1236, 1190, 2, 3]);
    assert.deepEqual([byKey.warehouse.ok, byKey.warehouse.error], [false, 'crm_forbidden']);
    assert.ok(fake.calls.every((c) => c.url.startsWith('https://crm.test/api/modules/')), 'the docs URL is trimmed');

    // saved: the key is sealed in the DB and never comes back
    const saved = (await call('PUT', '/api/admin/connectors/crm', { enabled: true, url: 'https://crm.test', apiId: API_ID, apiKey: API_KEY })).json();
    assert.deepEqual([saved.configured, saved.enabled, saved.keyHint], [true, true, '…6789']);
    const raw = JSON.stringify(db.prepare("SELECT value FROM settings WHERE key = 'connector.crm'").get());
    assert.ok(!raw.includes(API_KEY));
    assert.ok(!(await call('GET', '/api/admin/connectors')).body.includes(API_KEY));
    // the activity log has the change, never the key
    const log = JSON.stringify(db.prepare("SELECT * FROM events WHERE action LIKE 'connector.crm.%'").all());
    assert.ok(log.includes('nuova chiave') && log.includes('7/8 moduli leggibili') && !log.includes(API_KEY));

    // saving again without the key keeps it; the test uses the saved one
    await call('PUT', '/api/admin/connectors/crm', { enabled: true, url: 'https://crm.test', apiId: API_ID });
    assert.equal((await call('POST', '/api/admin/connectors/crm/test', { url: 'https://crm.test', apiId: API_ID })).json().ok, true);

    // a wrong key: the test stops at the first answer
    const bad = (await call('POST', '/api/admin/connectors/crm/test', { url: 'https://crm.test', apiId: API_ID, apiKey: 'sbagliata' })).json();
    assert.deepEqual([bad.ok, bad.error, bad.status], [false, 'crm_auth_failed', 401]);
    const unreachable = (await call('POST', '/api/admin/connectors/crm/test', { url: 'https://altro.test', apiId: API_ID, apiKey: API_KEY })).json();
    assert.deepEqual([unreachable.ok, unreachable.error], [false, 'crm_error']);

    // admins only
    await call('POST', '/api/admin/users', { username: 'tecnico', password: 'Installer-Pass-123' });
    const T = await login('tecnico', 'Installer-Pass-123');
    assert.equal((await call('POST', '/api/admin/connectors/crm/test', { url: 'https://crm.test', apiId: API_ID }, T)).statusCode, 403);

    // removed
    assert.equal((await call('DELETE', '/api/admin/connectors/crm')).json().configured, false);
    await app.close();
  });
});
