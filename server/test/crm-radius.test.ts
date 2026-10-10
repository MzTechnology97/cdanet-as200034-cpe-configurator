import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { profileSpeed } from '../src/services/crm-sync.ts';
import { fakeUisp } from './fake-uisp.ts';
import { ADMIN, testConfig } from './helpers.ts';

const API_ID = 'cdanet-noc';
const API_KEY = 'K3y-Segreta-IspBilling-0123456789';

/**
 * ISP Billing with four accounts: ROSSI online on the CPE "aa-bb-cc-dd-ee-ff" of the fake UISP,
 * BIANCHI offline although its CPE is online, VERDI suspended (unpaid service), NERI terminated.
 */
function fakeCrm() {
  const accounts = [
    { account_id: '1', customer_id: '10', address_id: '101', username: 'rossi@cda', status: 'Attivo', profile_name: 'ISP37@CDA-NET-HOME-30-6-NEW', static_ip: '', cpe_type: 'ubiquiti' },
    { account_id: '2', customer_id: '20', address_id: '201', username: 'bianchi@cda', status: 'Attivo', profile_name: 'ISP37@CDA-NET-HOME-100-20', static_ip: '', cpe_type: 'ubiquiti' },
    { account_id: '3', customer_id: '30', address_id: '301', username: 'verdi@cda', status: 'Attivo', profile_name: 'ISP37@CDA-NET-HOME-FTTH', static_ip: '', cpe_type: 'generic' },
    { account_id: '4', customer_id: '40', username: 'neri@cda', status: 'Terminato', profile_name: 'x', static_ip: '', cpe_type: 'generic' },
  ];
  const customers = [
    { customer_id: '10', customer_name: 'ROSSI MARIO', status: 'active', group_name: 'Abbonamento', phone_number: '3330000001', address_line1: 'Via Sede Legale 1', city: 'Enna' },
    { customer_id: '20', customer_name: 'BIANCHI LUCA', status: 'active', group_name: 'Abbonamento' },
    { customer_id: '30', customer_name: 'VERDI ANNA', status: 'active', group_name: 'Ricaricabile' },
    { customer_id: '40', customer_name: 'NERI PIO', status: 'active', group_name: 'Abbonamento' },
  ];
  const instances = [
    { service_instance_id: '1', customer_id: '10', status: 'active' },
    { service_instance_id: '2', customer_id: '30', status: 'suspended' },
  ];
  const sessions: Record<string, object> = {
    '1': { connection_status: 'online', mac_address: 'AA:BB:CC:DD:EE:FF', client_ip: '100.64.0.10', session_duration: 3600 },
    '2': { connection_status: 'offline', mac_address: '22:33:44:55:66:77', client_ip: null, session_duration: 0 },
    '3': { connection_status: 'offline', mac_address: null, client_ip: null, session_duration: 0 },
  };
  // installation sites: ROSSI's has coordinates, VERDI's has none
  const addresses: Record<string, object[]> = {
    '10': [{ address_id: 100, description: 'Indirizzo principale', address_line1: 'Via Sede Legale 1', city: 'Enna', lat: '', lng: '', is_main: true }, { address_id: 101, description: 'Installazione', address_line1: 'Contrada Monte 5', city: 'Enna', postal_code: '94100', lat: '37.5701', lng: '14.2702', is_main: false }],
    '20': [{ address_id: 201, description: 'Indirizzo principale', address_line1: 'Via Valle 2', city: 'Enna', lat: '37.6', lng: '14.1', is_main: true }],
    '30': [{ address_id: 301, description: 'Indirizzo principale', address_line1: 'Via Senza Punto 3', city: 'Enna', lat: null, lng: null, is_main: true }],
  };
  const calls: string[] = [];
  const page = (data: object[]) => Response.json({ status: 'OK', message: null, data: { data, max_items: 30, total: String(data.length), prev: null, next: null, pages: 1 } });
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host !== 'crm.test') return new Response('not found', { status: 404 });
    if (new Headers(init?.headers).get('authorization') !== `Bearer ${API_ID}:${API_KEY}`) return Response.json({ status: 'ERROR' }, { status: 401 });
    calls.push(url.pathname);
    if (url.pathname === '/api/modules/ispradius2/accounts') return page(accounts);
    if (url.pathname === '/api/modules/crm/customers') return page(customers);
    if (url.pathname === '/api/modules/subscription-services/service-instances') return page(instances);
    const ad = /^\/api\/modules\/crm\/customers\/(\d+)\/additional-addresses$/.exec(url.pathname);
    if (ad) return Response.json({ status: 'OK', data: addresses[ad[1]!] ?? [] });
    const st = /^\/api\/modules\/ispradius2\/accounts\/(\d+)\/status$/.exec(url.pathname);
    if (st) return Response.json({ status: 'OK', data: sessions[st[1]!] ?? { connection_status: 'offline' } });
    return Response.json({ status: 'ERROR', message: 'Permesso mancante' }, { status: 403 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('Stato RADIUS dal CRM per il NOC', () => {
  it('reads the plan speed from the profile name', () => {
    assert.deepEqual(profileSpeed('ISP37@CDA-NET-HOME-30-6-NEW'), { down: 30, up: 6 });
    assert.deepEqual(profileSpeed('ISP37@CDA-NET-HOME-300-50-NEW'), { down: 300, up: 50 });
    assert.deepEqual(profileSpeed('ISP37@CDA-NET-B2B-30-30'), { down: 30, up: 30 });
    assert.equal(profileSpeed('ISP37@CDA-NET-HOME-FTTH'), null);
  });

  it('syncs accounts and sessions, matches the CPEs by MAC and shows it only to admins', async () => {
    const crm = fakeCrm();
    const uisp = fakeUisp();
    const { app, ctx } = await buildApp(testConfig(), 'test', { db: openDatabase(':memory:'), logger: false, uisp: uisp.uisp, fetchImpl: crm.fetchImpl });
    const login = async (u: string, p: string) => ({ authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: p } })).json().token}` });
    const A = await login(ADMIN.username, ADMIN.password);
    const call = (method: 'GET' | 'PUT' | 'POST', url: string, payload?: object, headers = A) => app.inject({ method, url, headers, payload });
    await call('PUT', '/api/admin/modules', { cpe_health: true, network_status: true });

    // not configured: nothing to sync, the NOC pages stay as before
    assert.equal((await call('POST', '/api/admin/crm/radius/sync')).json().error, 'crm_not_configured');
    assert.equal((await call('GET', '/api/admin/crm/radius/status')).json().configured, false);
    assert.ok(!('radius' in (await call('GET', '/api/cpe-health')).json().cpes[0]));

    await call('PUT', '/api/admin/connectors/crm', { enabled: true, url: 'https://crm.test', apiId: API_ID, apiKey: API_KEY });
    const s = await ctx.crmSync.sync();
    assert.deepEqual([s.error, s.accounts, s.online, s.offline, s.suspended], [null, 4, 1, 1, 1]);
    assert.ok(!crm.calls.includes('/api/modules/ispradius2/accounts/4/status'), 'terminated accounts are not polled');
    assert.equal((await call('GET', '/api/admin/crm/radius/status')).json().accounts, 4);

    // Salute CPE: ROSSI online on its CPE, BIANCHI's CPE online but PPPoE down
    const h = (await call('GET', '/api/cpe-health')).json();
    const rossi = h.cpes.find((c: { mac: string }) => c.mac === 'AA:BB:CC:DD:EE:FF');
    const bianchi = h.cpes.find((c: { mac: string }) => c.mac === '22:33:44:55:66:77');
    assert.deepEqual([rossi.radius.username, rossi.radius.online, rossi.radius.speed], ['rossi@cda', true, { down: 30, up: 6 }]);
    assert.ok(!rossi.issues.includes('pppoe_offline'));
    assert.ok(bianchi.issues.includes('pppoe_offline'));
    assert.equal(h.totals.pppoe_offline, 1);

    // the account list for the NOC: filters, CPE matched by MAC, terminated accounts out
    const all = (await call('GET', '/api/admin/crm/radius')).json();
    assert.equal(all.total, 3);
    assert.equal(all.rows.find((r: { username: string }) => r.username === 'rossi@cda').cpe.name, 'ROSSI MARIO');
    assert.deepEqual((await call('GET', '/api/admin/crm/radius?filter=offline')).json().rows.map((r: { username: string }) => r.username), ['bianchi@cda']);
    const susp = (await call('GET', '/api/admin/crm/radius?filter=suspended')).json().rows;
    assert.deepEqual([susp.length, susp[0].username, susp[0].servicesSuspended], [1, 'verdi@cda', true]);
    assert.deepEqual((await call('GET', '/api/admin/crm/radius?filter=unmatched')).json().rows.map((r: { username: string }) => r.username), ['verdi@cda']);

    // Stato rete: PPPoE of the CPEs of AP N2
    const net = (await call('GET', '/api/network/status')).json();
    const ap = net.pops.flatMap((p: { aps: object[] }) => p.aps).find((a: { id: string }) => a.id === 'ap-n2');
    assert.deepEqual(ap.pppoe, { online: 1, offline: 1, suspended: 0 });

    // Clienti: records with their installation sites, PPPoE and CPE
    const list = (await call('GET', '/api/admin/crm/customers')).json();
    assert.equal(list.total, 3, 'customers with a live account (NERI is terminated)');
    const rc = list.rows.find((c: { name: string }) => c.name === 'ROSSI MARIO');
    assert.deepEqual([rc.phone, rc.mainAddress, rc.sites.length], ['3330000001', 'Via Sede Legale 1, Enna', 1]);
    const site = rc.sites[0];
    assert.deepEqual([site.address, site.position, site.account.username, site.cpe.name], ['Contrada Monte 5, 94100 Enna', { lat: 37.5701, lon: 14.2702 }, 'rossi@cda', 'ROSSI MARIO']);
    assert.deepEqual((await call('GET', '/api/admin/crm/customers?filter=nocoords')).json().rows.map((c: { name: string }) => c.name), ['VERDI ANNA']);
    assert.deepEqual((await call('GET', '/api/admin/crm/customers?filter=all')).json().total, 4);
    assert.deepEqual((await call('GET', '/api/admin/crm/customers?q=contrada')).json().rows.map((c: { name: string }) => c.name), ['ROSSI MARIO']);
    const one = (await call('GET', '/api/admin/crm/customers/30')).json();
    assert.deepEqual([one.name, one.sites[0].position, one.sites[0].approximate], ['VERDI ANNA', null, false], 'no geocoder answer: no position');
    assert.equal((await call('GET', '/api/admin/crm/customers/999')).statusCode, 404);

    // installers: no RADIUS anywhere
    await call('POST', '/api/admin/users', { username: 'tecnico', password: 'Installer-Pass-123' });
    const T = await login('tecnico', 'Installer-Pass-123');
    assert.equal((await call('GET', '/api/admin/crm/radius', undefined, T)).statusCode, 403);
    assert.equal((await call('GET', '/api/admin/crm/customers', undefined, T)).statusCode, 403);
    const mine = (await call('GET', '/api/cpe-health', undefined, T)).json();
    assert.ok(!JSON.stringify(mine).includes('rossi@cda') && !JSON.stringify(mine).includes('pppoe_offline'));
  });
});
