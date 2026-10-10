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
    { account_id: '1', customer_id: '10', username: 'rossi@cda', status: 'Attivo', profile_name: 'ISP37@CDA-NET-HOME-30-6-NEW', static_ip: '', cpe_type: 'ubiquiti' },
    { account_id: '2', customer_id: '20', username: 'bianchi@cda', status: 'Attivo', profile_name: 'ISP37@CDA-NET-HOME-100-20', static_ip: '', cpe_type: 'ubiquiti' },
    { account_id: '3', customer_id: '30', username: 'verdi@cda', status: 'Attivo', profile_name: 'ISP37@CDA-NET-HOME-FTTH', static_ip: '', cpe_type: 'generic' },
    { account_id: '4', customer_id: '40', username: 'neri@cda', status: 'Terminato', profile_name: 'x', static_ip: '', cpe_type: 'generic' },
  ];
  const customers = [
    { customer_id: '10', customer_name: 'ROSSI MARIO', status: 'active', group_name: 'Abbonamento' },
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

    // installers: no RADIUS anywhere
    await call('POST', '/api/admin/users', { username: 'tecnico', password: 'Installer-Pass-123' });
    const T = await login('tecnico', 'Installer-Pass-123');
    assert.equal((await call('GET', '/api/admin/crm/radius', undefined, T)).statusCode, 403);
    const mine = (await call('GET', '/api/cpe-health', undefined, T)).json();
    assert.ok(!JSON.stringify(mine).includes('rossi@cda') && !JSON.stringify(mine).includes('pppoe_offline'));
  });
});
