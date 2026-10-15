import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { markOffGrid } from '../src/services/outages.ts';
import { offGridHint, popPower, powerStatus, pvFromDiagnostics, vrmSite, type VrmSite } from '../src/services/victron-sync.ts';
import { fakeUisp } from './fake-uisp.ts';
import { ADMIN, testConfig } from './helpers.ts';

const TOKEN = 'f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4a5968778695a4b3c2d1e0f';
const NOW = Math.floor(Date.now() / 1000);
const ext = (code: string, rawValue: unknown) => ({ code, rawValue });

/** Three systems: one by the POP «Monte» (GPS), one named like «Valle» and discharging, one silent. */
const RECORDS = [
  { idSite: 11, name: 'Impianto Monte', last_timestamp: NOW - 300, alarm: false, num_alarms: 0, phonenumber: '+39 000', extended: [ext('lt', 37.6003), ext('lg', 14.1002), ext('bs', 87.4), ext('bv', 52.1), ext('bc', 6.2), ext('bst', 1), ext('ASoc', 0), ext('si1', 1)] },
  { idSite: 12, name: 'Valle batterie', last_timestamp: NOW - 120, alarm: false, num_alarms: 0, extended: [ext('bs', 24.2), ext('bv', 48.3), ext('bc', -9.5), ext('bst', 2), ext('ASoc', 1), ext('si1', 0)] },
  { idSite: 13, name: 'Ripetitore', last_timestamp: NOW - 3 * 3600, alarm: false, num_alarms: 0, extended: [ext('lt', 0), ext('lg', 0)] },
];

function fakeVrm() {
  const paths: string[] = [];
  const handle = (url: URL, init?: RequestInit) => {
    paths.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (new Headers(init?.headers).get('x-authorization') !== `Token ${TOKEN}`) return Response.json({ success: false, errors: 'Invalid token' }, { status: 401 });
    if (url.pathname === '/v2/users/me') return Response.json({ success: true, user: { id: 7, name: 'NOC' } });
    if (url.pathname === '/v2/users/7/installations') return Response.json({ success: true, records: RECORDS });
    const diag = url.pathname.match(/^\/v2\/installations\/(\d+)\/diagnostics$/);
    if (diag) return Response.json({ success: true, records: diag[1] === '11' ? [{ code: 'Pdc', rawValue: 412.6 }, { code: 'bs', rawValue: 87.4 }] : [] });
    return Response.json({ success: false }, { status: 404 });
  };
  return { paths, handle };
}

describe('Victron: batterie dei POP', () => {
  it('reads an installation and judges its state', () => {
    const s = vrmSite(RECORDS[0] as Record<string, unknown>) as VrmSite;
    assert.deepEqual([s.soc, s.voltage, s.batteryState, s.lowSoc, s.lat], [87.4, 52.1, 'charging', 'ok', 37.6003]);
    assert.ok(!('phonenumber' in s), 'nothing personal kept');
    assert.equal(vrmSite(RECORDS[2] as Record<string, unknown>)!.lat, null, '0,0 is no position');
    assert.equal(powerStatus(s, NOW), 'ok');
    assert.equal(powerStatus({ ...s, soc: 25 }, NOW), 'warn', 'below 30% even without the VRM alarm');
    assert.equal(powerStatus({ ...s, lowSoc: 'alarm' }, NOW), 'alarm');
    assert.equal(powerStatus({ ...s, alarms: 1 }, NOW), 'alarm');
    assert.equal(powerStatus({ ...s, lastTs: NOW - 7200 }, NOW), 'silent');
    // two systems on one POP: the worst state, the lowest battery, the PV summed
    const a = { ...s, pvW: 300 };
    const b = { ...(vrmSite(RECORDS[1] as Record<string, unknown>) as VrmSite), pvW: 100 };
    const p = popPower([a, b], NOW)!;
    assert.deepEqual([p.status, p.soc, p.batteryState, p.pvW, p.sites], ['warn', 24.2, 'discharging', 400, 2]);
    assert.equal(popPower([], NOW), null);
    assert.equal(pvFromDiagnostics([{ code: 'Pdc', rawValue: 100 }, { code: 'Pdc', rawValue: 50.5 }, { code: 'bs', rawValue: 90 }]), 150.5);
    assert.equal(pvFromDiagnostics([]), null);
    // off-grid: VRM only hints (no grid on the AC input), the admin decides
    assert.deepEqual([s.acInput, offGridHint(s), offGridHint(vrmSite(RECORDS[1] as Record<string, unknown>)!)], ['grid', false, true]);
    assert.equal(popPower([{ ...a, offGrid: true }, { ...b, offGrid: true }], NOW)!.offGrid, true);
    assert.equal(popPower([{ ...a, offGrid: true }, b], NOW)!.offGrid, false, 'one system on the grid: the POP is on the grid');
    // an Enel outage near an off-grid POP: only its customers are hit
    const imp = markOffGrid([{ type: 'pop' as const, id: 'p1', popId: 'p1' }, { type: 'ap' as const, id: 'a1', popId: 'p1' }, { type: 'ap' as const, id: 'a2', popId: 'p2' }], new Set(['p1']));
    assert.deepEqual(imp.map((i) => i.clientsOnly ?? false), [true, true, false]);
  });

  it('the admin links each system to its POP; Stato rete and Guasti Enel show the battery', async () => {
    const uisp = fakeUisp();
    const vrm = fakeVrm();
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      return url.host === 'vrmapi.victronenergy.com' ? vrm.handle(url, init) : uisp.fetchImpl(input, init);
    }) as typeof fetch;
    const { app, ctx } = await buildApp(testConfig(), 'test', { db: openDatabase(':memory:'), logger: false, uisp: uisp.uisp, fetchImpl });
    const login = async (u: string, p: string) => ({ authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: p } })).json().token}` });
    const A = await login(ADMIN.username, ADMIN.password);
    const call = (method: 'GET' | 'PUT' | 'POST', url: string, payload?: object, headers = A) => app.inject({ method, url, headers, payload });

    // nothing before the connector
    assert.equal((await call('POST', '/api/admin/victron/sync')).json().error, 'vrm_incomplete');
    assert.deepEqual((await call('GET', '/api/admin/victron')).json().sites, []);
    await call('PUT', '/api/admin/connectors/victron', { enabled: true, token: TOKEN });
    const sync = (await call('POST', '/api/admin/victron/sync')).json();
    assert.deepEqual([sync.sites, sync.error], [3, null]);
    assert.ok(!vrm.paths.some((p) => p.includes('diagnostics')), 'no diagnostics before a system powers a POP');

    // suggestions: the GPS of the GX near «Nodo 2 - Monte», the name «Valle» for «Nodo 7 - Valle»
    const list = (await call('GET', '/api/admin/victron')).json();
    const byId = Object.fromEntries(list.sites.map((s: { idSite: number }) => [s.idSite, s]));
    assert.equal(byId[11].suggestion.popId, 'site-n2');
    assert.ok(byId[11].suggestion.distanceM < 100);
    assert.deepEqual([byId[12].suggestion.popId, byId[12].suggestion.distanceM], ['site-n7', null]);
    assert.equal(byId[13].suggestion, null);
    assert.deepEqual([byId[11].status, byId[12].status, byId[13].status], ['ok', 'warn', 'silent']);
    assert.deepEqual([byId[11].offGridHint, byId[12].offGridHint], [false, true]);
    assert.ok(list.pops.some((p: { id: string }) => p.id === 'site-n2'));

    // linked by hand (a suggestion is never applied on its own)
    assert.equal((await call('PUT', '/api/admin/victron/11/link', { popId: 'nessuno' })).statusCode, 404);
    assert.equal((await call('PUT', '/api/admin/victron/99/link', { popId: 'site-n2' })).statusCode, 404);
    assert.equal((await call('PUT', '/api/admin/victron/11/link', { popId: 'site-n2' })).json().popName, 'Nodo 2 - Monte');
    assert.equal((await call('PUT', '/api/admin/victron/12/link', { popId: 'site-n7', offGrid: true })).json().offGrid, true);
    assert.equal((await call('PUT', '/api/admin/victron/13/link', { popId: 'site-n7', offGrid: true })).json().offGrid, true);
    // moving it keeps the off-grid choice
    assert.equal((await call('PUT', '/api/admin/victron/13/link', { popId: 'site-n7' })).json().offGrid, true);
    await ctx.victronSync.syncNow();
    assert.ok(vrm.paths.includes('GET /v2/installations/11/diagnostics'), 'PV read for the linked systems');

    // Stato rete, admins: the power of each POP
    await call('PUT', '/api/admin/modules', { network_status: true, power_outages: true });
    const net = (await call('GET', '/api/network/status')).json();
    const n2 = net.pops.find((p: { id: string }) => p.id === 'site-n2');
    const n7 = net.pops.find((p: { id: string }) => p.id === 'site-n7');
    assert.deepEqual([n2.power.status, n2.power.soc, n2.power.pvW, n2.power.batteryState], ['ok', 87.4, 413, 'charging']);
    assert.deepEqual([n7.power.status, n7.power.soc, n7.power.sites, n7.power.offGrid], ['silent', 24.2, 2, true], 'worst state, lowest battery');
    assert.equal(n2.power.offGrid, false);
    assert.deepEqual([...ctx.victronSync.offGridPops()], ['site-n7']);
    assert.equal(net.summary.powerAlarms, 1);

    // installers, on their POPs only: the state, the charge and whether it is discharging
    await call('POST', '/api/admin/users', { username: 'tecnico', password: 'Installer-Pass-123' });
    const T = await login('tecnico', 'Installer-Pass-123');
    const tid = (await call('GET', '/api/admin/assignments')).json().users.find((u: { username: string }) => u.username === 'tecnico').id;
    await call('PUT', `/api/admin/assignments/${tid}`, { items: [{ key: 'pop:site-n7', name: 'Nodo 7 - Valle' }] });
    const mine = await call('GET', '/api/network/status', undefined, T);
    assert.deepEqual(mine.json().pops.map((p: { id: string }) => p.id), ['site-n7']);
    assert.deepEqual(mine.json().pops[0].power, { status: 'silent', soc: 24, batteryState: 'discharging', offGrid: true });
    assert.ok(!/victron|vrm|voltage|pvW/i.test(mine.body), 'no source and no technical values');
    assert.equal('powerAlarms' in mine.json().summary, true);
    assert.equal((await call('GET', '/api/admin/victron', undefined, T)).statusCode, 403);
    assert.equal((await call('PUT', '/api/admin/victron/11/link', { popId: null }, T)).statusCode, 403);

    // Guasti Enel: the batteries of the POPs hit (none right now)
    assert.deepEqual((await call('GET', '/api/outages')).json().popPower, {});

    // unlinked
    assert.equal((await call('PUT', '/api/admin/victron/11/link', { popId: null })).json().popId, null);
    assert.equal((await call('GET', '/api/network/status')).json().pops.find((p: { id: string }) => p.id === 'site-n2').power, null);
    await app.close();
  });
});
