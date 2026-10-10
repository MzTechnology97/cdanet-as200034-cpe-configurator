import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { fakeUisp } from './fake-uisp.ts';
import { ADMIN, testConfig } from './helpers.ts';

describe('Stato CPE (admins): one CPE as in the UISP app', () => {
  it('shows detail, radio, firmware and backups without keys; actions logged; admins and customer CPEs only', async () => {
    const uisp = fakeUisp();
    const db = openDatabase(':memory:');
    const { app } = await buildApp(testConfig(), 'test', { db, logger: false, uisp: uisp.uisp, fetchImpl: uisp.fetchImpl });
    const login = async (username: string, password: string) => ({ authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } })).json().token}` });
    const H = await login(ADMIN.username, ADMIN.password);
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, headers = H) => app.inject({ method, url, headers, payload });
    await call('PUT', '/api/admin/modules', { cpe_health: true });
    await call('POST', '/api/admin/users', { username: 'tecnico', password: 'Installer-Pass-123' });
    const T = await login('tecnico', 'Installer-Pass-123');

    const r = await call('GET', '/api/admin/cpe/cpe-old');
    assert.equal(r.statusCode, 200, r.body);
    const c = r.json().cpe;
    assert.equal(c.model, 'LBE-5AC-Gen2');
    assert.equal(c.online, true);
    assert.equal(c.firmware.current, '8.7.4');
    assert.equal(c.firmware.upgradeTo, '8.7.15');
    assert.equal(c.radio.security, 'wpa2AES');
    assert.equal(c.radio.txPower, 24);
    assert.equal(c.interfaces[0].speed, '1000-full');
    assert.equal(c.latestBackup.id, 'bk1');
    assert.ok(!r.body.includes('chiave-segreta-wpa') && !r.body.includes('segreto-radius'), 'keys and secrets never leave the server');
    assert.ok(Array.isArray(r.json().backups));

    // actions
    for (const a of ['refresh', 'restart', 'upgrade', 'backups']) assert.equal((await call('POST', `/api/admin/cpe/cpe-old/${a}`)).statusCode, 200, a);
    assert.ok(uisp.calls.some((x) => x.method === 'POST' && x.path === '/devices/cpe-old/upgrade-to-latest'));
    assert.ok(uisp.calls.some((x) => x.method === 'POST' && x.path === '/devices/cpe-old/restart'));
    assert.equal((await call('POST', '/api/admin/cpe/cpe-old/backups/bk1/apply')).statusCode, 200);
    assert.equal((await call('POST', '/api/admin/cpe/cpe-old/backups/nope/apply')).statusCode, 404);
    const meta = await call('PUT', '/api/admin/cpe/cpe-old/meta', { alias: 'Bianchi casa', maintenance: true });
    assert.equal(meta.statusCode, 200, meta.body);
    const put = uisp.calls.find((x) => x.method === 'PUT' && x.path === '/devices/cpe-old/system/unms')!;
    assert.deepEqual((put.body as { meta: object }).meta, { alias: 'Bianchi casa', note: null, maintenance: true, customIpAddress: null }, 'whole object back, only meta changed');
    assert.equal((put.body as { overrideGlobal: boolean }).overrideGlobal, false);
    const events = db.prepare("SELECT action FROM events WHERE action LIKE 'cpe.%'").all().map((e) => (e as { action: string }).action);
    assert.deepEqual(events.sort(), ['cpe.backup', 'cpe.backup_apply', 'cpe.meta', 'cpe.refresh', 'cpe.restart', 'cpe.upgrade'].sort());
    assert.equal(r.json().crm, undefined, 'no CRM connected: no customer block');

    // wireless parameters: read from the CPE, written back whole with only the changes (keys untouched)
    assert.equal(c.wireless.txPowerRange.max, 24);
    const w = await call('PUT', '/api/admin/cpe/cpe-old/wireless', { txPower: 18, ackAuto: false, ackDistanceM: 3000, ssid: 'CDA-NET-N2-D02' });
    assert.equal(w.statusCode, 200, w.body);
    const wput = uisp.calls.filter((x) => x.method === 'PUT' && x.path === '/devices/airmaxes/cpe-old/config/wireless').at(-1)!.body as Record<string, unknown>;
    assert.deepEqual([wput.txPower, wput.isACKAutoDistanceEnabled, wput.ackDistance, wput.ssid, wput.mode], [18, false, 3000, 'CDA-NET-N2-D02', 'sta-ptmp']);
    assert.equal((wput.securityConfig as { presharedKey: string }).presharedKey, 'chiave-segreta-wpa', 'the key goes back unchanged');
    const tooHot = await call('PUT', '/api/admin/cpe/cpe-old/wireless', { txPower: 30 });
    assert.equal(tooHot.json().error, 'wireless_value_out_of_range');
    assert.equal((await call('PUT', '/api/admin/cpe/cpe-old/wireless', { channelWidth: 30 })).statusCode, 400);
    assert.equal((await call('PUT', '/api/admin/cpe/cpe-old/wireless', { presharedKey: 'x' })).statusCode, 400, 'keys cannot be changed from here');
    assert.ok(!JSON.stringify((await call('GET', '/api/admin/cpe/cpe-old')).json()).includes('chiave-segreta-wpa'));

    // APs are not managed from here; installers have no access
    assert.equal((await call('GET', '/api/admin/cpe/ap-n2')).statusCode, 409);
    assert.equal((await call('GET', '/api/admin/cpe/nope')).statusCode, 404);
    assert.equal((await call('POST', '/api/admin/cpe/cpe-old/restart', undefined, T)).statusCode, 403);
  });
});
