import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { cpeModel, serialMac } from '../src/services/warehouse.ts';
import { ADMIN, SAMPLE_TEMPLATE, testConfig } from './helpers.ts';

const ANDROID = { 'x-cda-client': 'android/9.0.0' };

/** The stock of a fake ISP Billing, on two pages (cursor «next»). */
const PAGE1 = [
  { stock_id: 10, site_id: 97, site_name: 'Impiantistica Smart', article_name: 'LBE-5AC-GEN2-5-EU', code: '0817882022248', serial_number: '9C05D6946286', status: 'Nuovo', intended_use: 'Vendita', created_at: '2025-01-07' },
  { stock_id: 11, site_id: 97, site_name: 'Impiantistica Smart', article_name: 'EX 230v', code: '4897098684689', serial_number: '223C7B6001321', status: 'Nuovo', intended_use: '', created_at: '2025-07-14' },
];
const PAGE2 = [
  { stock_id: 12, site_id: 211, site_name: 'Magazzino Fisico', article_name: 'NanoStation Loco 5AC', code: 'LOCO5AC', serial_number: '24A43C112233', status: 'Nuovo', intended_use: 'Vendita', created_at: '2025-02-01' },
  { stock_id: 13, site_id: 211, site_name: 'Magazzino Fisico', article_name: 'LiteBeam 5AC Gen2', code: 'LBE', serial_number: 'AA:BB:CC:00:00:03', status: 'Nuovo', intended_use: 'Vendita', created_at: '2025-02-01' },
];

function fakeIspBilling() {
  const fetchImpl = (async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname === '/api/modules/warehouse/stocks') {
      const second = url.searchParams.get('cursor') === 'pagina-2';
      return Response.json({ status: 'OK', data: { data: second ? PAGE2 : PAGE1, max_items: 2, total: 4, prev: null, next: second ? null : 'pagina-2' } });
    }
    return Response.json({ status: 'OK', data: { data: [], total: 0, next: null } });
  }) as typeof fetch;
  return fetchImpl;
}

describe('Magazzino (ISP Billing)', () => {
  it('recognises the CPE models and the MAC in the serial', () => {
    assert.equal(cpeModel('LBE-5AC-GEN2-5-EU'), 'LiteBeam 5AC');
    assert.equal(cpeModel('NanoStation Loco 5AC'), 'NanoStation Loco 5AC');
    assert.equal(cpeModel('NBE-5AC-Gen2'), 'NanoBeam 5AC');
    assert.equal(cpeModel('EX 230v', '4897098684689'), '');
    assert.equal(serialMac('9C05D6946286'), '9C:05:D6:94:62:86');
    assert.equal(serialMac('223C7B6001321'), '', '13 characters: not a MAC');
    assert.equal(serialMac('81:78:82:02:72:50'), '', 'odd first byte: not a device MAC');
  });

  it('accounts linked to a warehouse install its CPEs; the bypass allows the others', async () => {
    const db = openDatabase(':memory:');
    const { app, ctx } = await buildApp(testConfig(), 'test', { db, logger: false, uisp: null, fetchImpl: fakeIspBilling() });
    const login = async (username: string, password: string) => ({ authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } })).json().token}` });
    const A = await login(ADMIN.username, ADMIN.password);
    const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: object, headers: Record<string, string> = A) => app.inject({ method, url, headers, payload });
    await call('PUT', '/api/admin/connectors/crm', { enabled: true, url: 'https://crm.test', apiId: 'cdanet-noc', apiKey: 'K3y-Segreta-IspBilling-0123456789' });
    await call('POST', '/api/admin/profiles/LiteBeam%205AC/templates', { name: 'Standard', template: SAMPLE_TEMPLATE, boardMatch: 'board\\.name=LiteBeam 5AC' });
    await call('PUT', '/api/admin/wireless-networks/CDA-NET-N2-D01', { wpa2Password: 'test-psk-12345' });

    // before the first read nobody is stopped, and a warehouse cannot be chosen
    assert.equal((await call('POST', '/api/admin/users', { username: 'partner', password: 'Partner-Pass-123', warehouseSiteId: 97 })).json().error, 'warehouse_not_found');
    const sync = (await call('POST', '/api/admin/warehouse/refresh')).json();
    assert.deepEqual([sync.ok, sync.items], [true, 4], 'both pages read');
    const sites = (await call('GET', '/api/admin/warehouse/sites')).json().sites;
    assert.deepEqual(sites.map((s: { name: string; cpe: number }) => [s.name, s.cpe]), [['Impiantistica Smart', 1], ['Magazzino Fisico', 2]]);

    assert.equal((await call('POST', '/api/admin/users', { username: 'partner', password: 'Partner-Pass-123', warehouseSiteId: 97 })).statusCode, 201);
    const users = (await call('GET', '/api/admin/users')).json() as Array<{ id: number; username: string; warehouseSite: string; stockBypass: boolean }>;
    const partner = users.find((u) => u.username === 'partner')!;
    assert.deepEqual([partner.warehouseSite, partner.stockBypass], ['Impiantistica Smart', false]);
    const P = await login('partner', 'Partner-Pass-123');

    const mine = (await call('GET', '/api/warehouse/mine', undefined, P)).json();
    assert.deepEqual(mine.items.map((x: { model: string; mac: string }) => [x.model, x.mac]), [['LiteBeam 5AC', '9C:05:D6:94:62:86']], 'only the CPEs');
    assert.equal(JSON.stringify(mine).includes('ISP'), false, 'installers never see the data source');
    assert.equal((await call('GET', '/api/warehouse/check?mac=9c05d6946286', undefined, P)).json().result, 'ok');
    assert.equal((await call('GET', '/api/warehouse/check?mac=AA:BB:CC:00:00:03', undefined, P)).json().result, 'other_warehouse');

    const job = (mac: string) => call('POST', '/api/provisioning/jobs', { model: 'LiteBeam 5AC', mac, serial: 'S1', ssid: 'CDA-NET-N2-D01', pppoeUser: 'rossi.mario@cda-net.it', pppoePassword: 'x' }, { ...P, ...ANDROID });
    assert.equal((await job('9C:05:D6:94:62:86')).statusCode, 201, 'from their warehouse');
    const refused = (await job('AA:BB:CC:00:00:03')).json();
    assert.deepEqual([refused.error, refused.result], ['cpe_not_in_stock', 'other_warehouse']);
    assert.equal((await job('AA:BB:CC:00:00:09')).json().result, 'not_in_stock');

    // the NOC enables the bypass on the existing account: now it may
    assert.equal((await call('PATCH', `/api/admin/users/${partner.id}`, { stockBypass: true })).statusCode, 200);
    assert.equal((await job('AA:BB:CC:00:00:09')).statusCode, 201);
    assert.equal((await call('GET', '/api/warehouse/mine', undefined, P)).json().bypass, true);
    // and an account without warehouse is never stopped
    await call('PATCH', `/api/admin/users/${partner.id}`, { warehouseSiteId: null, stockBypass: false });
    assert.equal((await job('AA:BB:CC:00:00:08')).statusCode, 201);

    // NOC: by model, the CPE already installed but still in stock, who is short of CPEs
    await call('PATCH', `/api/admin/users/${partner.id}`, { warehouseSiteId: 97 });
    const installed = (await job('9C:05:D6:94:62:86')).json().jobId;
    await call('POST', `/api/provisioning/jobs/${installed}/result`, { result: 'success', stages: [] }, P);
    const o = (await call('GET', '/api/admin/warehouse/overview')).json();
    assert.deepEqual(o.byModel.map((x: { site: string; model: string; n: number }) => `${x.site}·${x.model}·${x.n}`), ['Impiantistica Smart·LiteBeam 5AC·1', 'Magazzino Fisico·LiteBeam 5AC·1', 'Magazzino Fisico·NanoStation Loco 5AC·1']);
    assert.deepEqual(o.toUnload.map((x: { mac: string; site: string }) => [x.mac, x.site]), [['9C:05:D6:94:62:86', 'Impiantistica Smart']]);
    assert.deepEqual(o.lowStock.map((x: { username: string; cpe: number }) => [x.username, x.cpe]), [['partner', 1]]);
    assert.equal((await call('GET', '/api/admin/warehouse/overview', undefined, P)).statusCode, 403);

    // audit: the next read finds the installed CPE gone, one transferred: movements with their sites
    PAGE1.splice(0, 1);
    PAGE2[0]!.site_id = 97;
    PAGE2[0]!.site_name = 'Impiantistica Smart';
    await call('POST', '/api/admin/warehouse/refresh');
    const moves = (await call('GET', '/api/admin/warehouse/movements')).json().items as Array<{ kind: string; mac: string; fromSite: string; toSite: string }>;
    assert.deepEqual(
      moves.map((m) => `${m.kind} ${m.mac} ${m.fromSite}→${m.toSite}`).sort(),
      ['installata 9C:05:D6:94:62:86 Impiantistica Smart→', 'trasferimento 24:A4:3C:11:22:33 Magazzino Fisico→Impiantistica Smart', 'uscita 9C:05:D6:94:62:86 Impiantistica Smart→'].sort(),
    );
    assert.equal((await call('GET', '/api/admin/warehouse/movements?mac=9c05d6946286')).json().items.length, 2, "one CPE's history");
    void ctx;
    await app.close();
  });

  it('a CPE installed offline that the warehouse no longer holds: the result is kept and the NOC told', async () => {
    const db = openDatabase(':memory:');
    const { app } = await buildApp(testConfig(), 'test', { db, logger: false, uisp: null, fetchImpl: fakeIspBilling() });
    const login = async (username: string, password: string) => ({ authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } })).json().token}` });
    const A = await login(ADMIN.username, ADMIN.password);
    const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: object, headers: Record<string, string> = A) => app.inject({ method, url, headers, payload });
    await call('PUT', '/api/admin/connectors/crm', { enabled: true, url: 'https://crm.test', apiId: 'cdanet-noc', apiKey: 'K3y-Segreta-IspBilling-0123456789' });
    await call('POST', '/api/admin/profiles/LiteBeam%205AC/templates', { name: 'Standard', template: SAMPLE_TEMPLATE, boardMatch: 'board\.name=LiteBeam 5AC' });
    await call('PUT', '/api/admin/wireless-networks/CDA-NET-N2-D01', { wpa2Password: 'test-psk-12345' });
    await call('POST', '/api/admin/warehouse/refresh');
    assert.equal((await call('POST', '/api/admin/users', { username: 'tecnico', password: 'Installer-Pass-123', warehouseSiteId: 211 })).statusCode, 201);
    const tid = ((await call('GET', '/api/admin/users')).json() as Array<{ id: number; username: string }>).find((u) => u.username === 'tecnico')!.id;
    const T = { ...(await login('tecnico', 'Installer-Pass-123')), ...ANDROID };

    // prepared before the visit (no MAC), installed on a roof without network, sent later by the queue
    const offline = async (mac: string) => {
      const order = (await call('POST', '/api/admin/work-orders', { assignedTo: tid, day: '2026-10-15', kind: 'new', customer: 'Cliente Demo', lat: 37.57, lon: 14.28, pppoeUser: 'demo@cda-net.it', pppoePassword: 'p', model: 'LiteBeam 5AC' })).json().item;
      const pkg = (await call('POST', '/api/provisioning/jobs', { model: 'LiteBeam 5AC', ssid: 'CDA-NET-N2-D01', pppoeUser: 'demo@cda-net.it', workOrderId: order.id }, T)).json();
      return call('POST', `/api/provisioning/jobs/${pkg.jobId}/result`, { result: 'success', stages: [], cpe: { mac, serial: 'S1' } }, T);
    };
    const notices = async () => ((await call('GET', '/api/notifications')).json().items as Array<{ kind: string; title: string; body: string }>).filter((n) => n.kind === 'stock_mismatch');

    assert.equal((await offline('AA:BB:CC:00:00:03')).statusCode, 200, 'from their own warehouse');
    assert.equal((await notices()).length, 0);
    const gone = await offline('AA:BB:CC:00:00:09');
    assert.equal(gone.statusCode, 200, 'the CPE is on the roof: never refused');
    const n = await notices();
    assert.equal(n.length, 1);
    assert.match(n[0]!.body, /Non risulta in nessun magazzino/);
    // with the account's bypass it was allowed anyway: no notice
    await call('PATCH', `/api/admin/users/${tid}`, { stockBypass: true });
    assert.equal((await offline('AA:BB:CC:00:00:08')).statusCode, 200);
    assert.equal((await notices()).length, 1);
    await app.close();
  });
});
