import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { subscriberTiming } from '../src/routes/uisp.ts';
import { planForProfile, subscriberName } from '../src/services/uisp-crm.ts';
import { fakeUisp } from './fake-uisp.ts';
import { ADMIN, SAMPLE_TEMPLATE, testConfig } from './helpers.ts';

describe('Nuovo subscriber in UISP all\'accettazione', () => {
  it('names the subscriber from the PPPoE user or the device name', () => {
    assert.deepEqual(subscriberName('rossi.mario@cda-net.it', ''), { lastName: 'Rossi', firstName: 'Mario' });
    assert.deepEqual(subscriberName('x@cda-net.it', 'BIANCHI LUCA'), { lastName: 'Bianchi', firstName: 'Luca' });
  });

  it('maps the ISPBilling PPPoE profile to the UISP plan', () => {
    assert.equal(planForProfile('ISP37@CDA-NET-HOME-25-5'), 'CDA NET HOME 25/5');
    assert.equal(planForProfile('CDA-NET-RICARICABILE-20-2-NEW'), 'CDA NET RICARICABILE 20/2');
    assert.equal(planForProfile('ISP37@cda-net-b2b-50-50'), 'CDA NET B2B 50/50');
    assert.equal(planForProfile('ISP37@CDA-NET-DEDICATA-COMUNE'), null);
    assert.equal(planForProfile(''), null);
  });

  it('creates client and service of the chosen plan in the CRM, then authorizes the CPE in their site', async () => {
    subscriberTiming.pollMs = 1;
    const fake = fakeUisp();
    const crm: Array<{ method: string; path: string; body: unknown; key: string | null }> = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (!url.pathname.startsWith('/crm/api/v1.0')) return fake.fetchImpl(input, init);
      const method = init?.method ?? 'GET';
      const path = url.pathname.replace('/crm/api/v1.0', '');
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      const key = new Headers(init?.headers).get('x-auth-app-key');
      crm.push({ method, path, body, key });
      if (key !== 'crm-key') return new Response('{}', { status: 401 });
      if (path === '/service-plans') {
        return new Response(JSON.stringify([
          { id: 3, name: 'CDA NET HOME 25/5', organizationId: 1, periods: [{ id: 30, period: 12, enabled: true }, { id: 31, period: 1, enabled: true }] },
          { id: 4, name: 'Vecchio', archived: true, periods: [{ id: 41, period: 1 }] },
          { id: 5, name: 'CDA NET HOME 25/5', organizationId: 2, periods: [{ id: 51, period: 1, enabled: true }] },
        ]));
      }
      if (path === '/organizations') return new Response(JSON.stringify([{ id: 1, selected: true }, { id: 2, selected: false }]));
      if (path === '/clients' && method === 'POST') return new Response(JSON.stringify({ id: 501 }), { status: 201 });
      if (path === '/clients/501/services' && method === 'POST') return new Response(JSON.stringify({ id: 701, unmsClientSiteId: null }), { status: 201 });
      if (path === '/clients/services/701') return new Response(JSON.stringify({ id: 701, unmsClientSiteId: 'site-sub-1' }));
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const cfg = testConfig();
    const db = openDatabase(':memory:');
    const { app } = await buildApp(cfg, 'test', { db, logger: false, uisp: null, fetchImpl });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: ADMIN.username, password: ADMIN.password } });
    const H = { authorization: `Bearer ${login.json().token}` };
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, extra: Record<string, string> = {}) => app.inject({ method, url, headers: { ...H, ...extra }, payload });

    const uisp = { enabled: true, url: 'https://uisp.test', token: 'tok-secret', ignoreTls: false, autoBackup: false, coverageMaxKm: 15, cacheSeconds: 60 };
    assert.equal((await call('PUT', '/api/admin/connectors/uisp', uisp)).statusCode, 200);
    assert.equal((await call('GET', '/api/admin/uisp/service-plans')).json().error, 'uisp_crm_not_configured');
    const saved = (await call('PUT', '/api/admin/connectors/uisp', { ...uisp, token: '', crmKey: 'crm-key' })).json();
    assert.equal(saved.crmKeySet, true);
    assert.equal(JSON.stringify(saved).includes('crm-key'), false, 'the key never goes back to the browser');
    // "Test connessione" checks the CRM key too (the plans it can read)
    const tested = (await call('POST', '/api/admin/connectors/uisp/test', { url: 'https://uisp.test' })).json();
    assert.equal(tested.ok, true);
    assert.deepEqual(tested.crm, { ok: true, plans: 1 });

    await call('POST', '/api/admin/profiles/LiteBeam%205AC/templates', { name: 'Standard', template: SAMPLE_TEMPLATE, boardMatch: 'board\\.name=LiteBeam 5AC' });
    await call('PUT', '/api/admin/wireless-networks/CDA-NET-N2-D01', { wpa2Password: 'test-psk-12345' });
    const job = (await call('POST', '/api/provisioning/jobs', {
      model: 'LiteBeam 5AC', mac: 'AABBCCDDEEFF', serial: 'S1', ssid: 'CDA-NET-N2-D01', pppoeUser: 'rossi.mario@cda-net.it', pppoePassword: 'x',
      location: { latitude: 37.58, longitude: 14.12, accuracy: 6, source: 'gps' },
    }, { 'x-cda-client': 'android/1.0.7' })).json();

    const plans = (await call('GET', '/api/admin/uisp/service-plans')).json();
    assert.deepEqual(plans, [{ id: 3, name: 'CDA NET HOME 25/5', periodId: 31 }], 'the monthly period; archived plans and other organizations left out');
    const url = `/api/admin/provisioning/jobs/${job.jobId}/uisp/subscriber`;
    // no ISPBilling profile for the PPPoE user: the NOC picks the plan
    assert.equal((await call('GET', url)).json().planPeriodId, null);
    db.prepare("INSERT INTO crm_radius(account_id, username, profile) VALUES('a1', 'ROSSI.MARIO@cda-net.it', 'ISP37@CDA-NET-HOME-25-5')").run();
    const draft = (await call('GET', url)).json();
    assert.deepEqual({ planPeriodId: draft.planPeriodId, planName: draft.planName, profile: draft.profile }, { planPeriodId: 31, planName: 'CDA NET HOME 25/5', profile: 'CDA-NET-HOME-25-5' });
    assert.equal(draft.lastName, 'Rossi');
    assert.equal(draft.firstName, 'Mario');
    assert.equal(draft.lat, 37.58);

    const r = await call('POST', `/api/admin/provisioning/jobs/${job.jobId}/uisp/subscriber`, { lastName: 'Rossi', firstName: 'Mario', street: 'Via Roma 1', servicePlanPeriodId: 31 });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual({ site: r.json().site, clientId: r.json().clientId, serviceId: r.json().serviceId }, { site: 'Rossi Mario', clientId: 501, serviceId: 701 });
    const client = crm.find((c) => c.path === '/clients' && c.method === 'POST')!.body as Record<string, unknown>;
    assert.equal(client.firstName, 'Mario');
    assert.equal(client.addressGpsLat, 37.58);
    const service = crm.find((c) => c.path === '/clients/501/services')!.body as Record<string, unknown>;
    assert.equal(service.servicePlanPeriodId, 31);
    assert.equal(service.addressGpsLat, 37.58);
    assert.equal('isAddressGpsCustom' in service, false, 'the CRM rejects it on a new service (422)');
    // the CRM made exactly one client and one service
    assert.equal(crm.filter((c) => c.path === '/clients' && c.method === 'POST').length, 1)
    assert.equal(crm.filter((c) => c.path.endsWith('/services') && c.method === 'POST').length, 1)
    const auth = fake.calls.find((c) => c.path === '/devices/cpe-1/authorize');
    assert.deepEqual(auth?.body, { siteId: 'site-sub-1' }, "the CPE goes into the subscriber's site, not the AP's");
    await app.close();
  });

  it('after "site pending" the retry reuses the service: never a second subscriber', async () => {
    subscriberTiming.pollMs = 1;
    const fake = fakeUisp();
    let siteReady = false;
    let clients = 0;
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (!url.pathname.startsWith('/crm/api/v1.0')) return fake.fetchImpl(input, init);
      const path = url.pathname.replace('/crm/api/v1.0', '');
      const method = init?.method ?? 'GET';
      if (path === '/clients' && method === 'POST') {
        clients++;
        return new Response(JSON.stringify({ id: 501 }), { status: 201 });
      }
      if (path === '/clients/501/services') return new Response(JSON.stringify({ id: 701 }), { status: 201 });
      if (path === '/clients/services/701') return new Response(JSON.stringify({ id: 701, unmsClientSiteId: siteReady ? 'site-sub-1' : null }));
      return new Response('[]');
    }) as typeof fetch;
    const { app } = await buildApp(testConfig(), 'test', { db: openDatabase(':memory:'), logger: false, uisp: null, fetchImpl });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: ADMIN.username, password: ADMIN.password } });
    const H = { authorization: `Bearer ${login.json().token}` };
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, extra: Record<string, string> = {}) => app.inject({ method, url, headers: { ...H, ...extra }, payload });
    await call('PUT', '/api/admin/connectors/uisp', { enabled: true, url: 'https://uisp.test', token: 'tok-secret', crmKey: 'crm-key', ignoreTls: false, autoBackup: false, coverageMaxKm: 15, cacheSeconds: 60 });
    await call('POST', '/api/admin/profiles/LiteBeam%205AC/templates', { name: 'Standard', template: SAMPLE_TEMPLATE, boardMatch: 'board\\.name=LiteBeam 5AC' });
    await call('PUT', '/api/admin/wireless-networks/CDA-NET-N2-D01', { wpa2Password: 'test-psk-12345' });
    const job = (await call('POST', '/api/provisioning/jobs', { model: 'LiteBeam 5AC', mac: 'AABBCCDDEEFF', serial: 'S1', ssid: 'CDA-NET-N2-D01', pppoeUser: 'rossi.mario@cda-net.it', pppoePassword: 'x' }, { 'x-cda-client': 'android/1.0.7' })).json();
    const url = `/api/admin/provisioning/jobs/${job.jobId}/uisp/subscriber`;
    const first = await call('POST', url, { lastName: 'Rossi', firstName: 'Mario', street: '', servicePlanPeriodId: 31 });
    assert.equal(first.json().error, 'uisp_subscriber_site_pending');
    assert.equal(first.json().serviceId, 701);
    siteReady = true;
    // the same form again (the console may resend it) or only the serviceId: one client in all
    assert.equal((await call('POST', url, { lastName: 'Rossi', firstName: 'Mario', street: '', servicePlanPeriodId: 31 })).statusCode, 200);
    assert.equal(clients, 1);
    await app.close();
  });

  it('a service refused by the CRM keeps its client: the retry adds only the service, nothing is deleted', async () => {
    subscriberTiming.pollMs = 1;
    const fake = fakeUisp();
    let clients = 0;
    let services = 0;
    const deletes: string[] = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (!url.pathname.startsWith('/crm/api/v1.0')) return fake.fetchImpl(input, init);
      const path = url.pathname.replace('/crm/api/v1.0', '');
      const method = init?.method ?? 'GET';
      if (method === 'DELETE') deletes.push(path);
      if (path === '/clients' && method === 'POST') {
        clients++;
        return new Response(JSON.stringify({ id: 502 }), { status: 201 });
      }
      if (path === '/clients/502/services' && method === 'POST') {
        services++;
        // field report, 15/10/2026: the first attempt is refused
        if (services === 1) return new Response(JSON.stringify({ code: 422, message: 'Validation failed.', errors: { isAddressGpsCustom: ['This field is not allowed.'] } }), { status: 422 });
        return new Response(JSON.stringify({ id: 702, unmsClientSiteId: 'site-sub-1' }), { status: 201 });
      }
      return new Response('[]');
    }) as typeof fetch;
    const db = openDatabase(':memory:');
    const { app } = await buildApp(testConfig(), 'test', { db, logger: false, uisp: null, fetchImpl });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: ADMIN.username, password: ADMIN.password } });
    const H = { authorization: `Bearer ${login.json().token}` };
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, extra: Record<string, string> = {}) => app.inject({ method, url, headers: { ...H, ...extra }, payload });
    await call('PUT', '/api/admin/connectors/uisp', { enabled: true, url: 'https://uisp.test', token: 'tok-secret', crmKey: 'crm-key', ignoreTls: false, autoBackup: false, coverageMaxKm: 15, cacheSeconds: 60 });
    await call('POST', '/api/admin/profiles/LiteBeam%205AC/templates', { name: 'Standard', template: SAMPLE_TEMPLATE, boardMatch: 'board\\.name=LiteBeam 5AC' });
    await call('PUT', '/api/admin/wireless-networks/CDA-NET-N2-D01', { wpa2Password: 'test-psk-12345' });
    const job = (await call('POST', '/api/provisioning/jobs', { model: 'LiteBeam 5AC', mac: 'AABBCCDDEEFF', serial: 'S1', ssid: 'CDA-NET-N2-D01', pppoeUser: 'rossi.mario@cda-net.it', pppoePassword: 'x' }, { 'x-cda-client': 'android/1.0.7' })).json();
    const url = `/api/admin/provisioning/jobs/${job.jobId}/uisp/subscriber`;
    const form = { lastName: 'Rossi', firstName: 'Mario', street: '', servicePlanPeriodId: 31 };
    const first = await call('POST', url, form);
    assert.notEqual(first.statusCode, 200);
    assert.equal((db.prepare('SELECT uisp_crm_client_id c FROM provisioning_jobs WHERE id = ?').get(job.jobId) as { c: number }).c, 502, 'the client made is kept on the job');
    assert.equal((await call('POST', url, form)).statusCode, 200);
    assert.deepEqual([clients, services, deletes], [1, 2, []], 'one client, the service tried again, nothing deleted in the CRM');
    await app.close();
  });
});
