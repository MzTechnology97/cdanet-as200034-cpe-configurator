import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { firmwareIs, firmwareState, firmwareVersion, installedHealth, type InstalledJob } from '../src/domain/health.ts';
import { ethSpeed, normalizeDevice } from '../src/services/uisp.ts';
import { fakeUisp } from './fake-uisp.ts';
import { ADMIN, SAMPLE_TEMPLATE, testConfig } from './helpers.ts';

const T = { signalGood: -65, signalMin: -75, ethMinMbps: 100, capacityMinMbps: 100, targetFirmware: '8.7.4', signalDropDb: 6 };
const job = (mac: string, acceptanceSignal: number | null = null): InstalledJob => ({
  jobId: mac, createdAt: '2026-09-01T10:00:00Z', deviceName: 'CLIENTE', model: 'LiteBeam 5AC', mac, ssid: 'CDA-NET-N2-D01', installer: 'tecnico',
  acceptanceVerdict: acceptanceSignal === null ? null : 'ok', acceptanceSignal, acceptanceDownload: null,
});
const dev = (mac: string, overview: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  normalizeDevice({
    identification: { id: mac, name: 'x', mac, role: 'station', firmwareVersion: 'XC.qca956x.v8.7.4', authorized: true, ...extra },
    overview: { status: 'active', ...overview },
    attributes: { ssid: 'CDA-NET-N2-D01', apDevice: { id: 'ap1', name: 'AP N2' } },
  });

describe('Salute CPE installate', () => {
  it('parses LAN speed and firmware', () => {
    assert.deepEqual(ethSpeed({ availableSpeed: '1000-full' }), { ethMbps: 1000, ethHalfDuplex: false });
    assert.deepEqual(ethSpeed({ availableSpeed: '10-half' }), { ethMbps: 10, ethHalfDuplex: true });
    assert.deepEqual(ethSpeed(undefined), { ethMbps: null, ethHalfDuplex: false });
    assert.ok(firmwareIs('XC.qca956x.v8.7.4.45112.210415.1103', '8.7.4'));
    assert.ok(!firmwareIs('XC.qca956x.v8.7.11', '8.7.4'));
  });

  it('firmware: newer than the reference is fine, older is to update, the M series cannot be updated', () => {
    assert.equal(firmwareState('XC.qca956x.v8.7.4.45112.210415.1103', '8.7.4'), 'ok');
    assert.equal(firmwareState('XC.qca956x.v8.7.11.46972.220614.0420', '8.7.4'), 'ok');
    assert.equal(firmwareState('WA.ipq40xx.v8.7.18', '8.7.4'), 'ok');
    assert.equal(firmwareState('XC.qca956x.v8.6.2', '8.7.4'), 'old');
    assert.equal(firmwareState('WA.v8.5.12', '8.7.4'), 'old');
    assert.equal(firmwareState('XW.ar934x.v6.3.11.33396.230425.1742', '8.7.4'), 'legacy');
    assert.equal(firmwareState('XM.v6.1.7', '8.7.4'), 'legacy');
    assert.equal(firmwareState('qualcosa', '8.7.4'), 'unknown');
    assert.equal(firmwareState(null, '8.7.4'), 'unknown');
    assert.deepEqual(firmwareVersion('XC.qca956x.v8.7.11.46972'), [8, 7, 11]);
  });

  it('compares the current state with the acceptance test', () => {
    const devices = [
      dev('AA:00:00:00:00:01', { signal: -60, mainInterfaceSpeed: { availableSpeed: '1000-full' }, downlinkCapacity: 300e6 }),
      dev('AA:00:00:00:00:02', { signal: -68 }), // was -58 at acceptance: dropped 10 dB
      dev('AA:00:00:00:00:03', { status: 'disconnected', signal: -90 }),
      dev('AA:00:00:00:00:04', { signal: -62, mainInterfaceSpeed: { availableSpeed: '100-half' } }),
    ];
    const byMac = new Map(devices.map((d) => [d.mac!, d]));
    const h = installedHealth([job('AA:00:00:00:00:01', -61), job('AA:00:00:00:00:02', -58), job('AA:00:00:00:00:03'), job('AA:00:00:00:00:04'), job('AA:00:00:00:00:05')], byMac, T);
    assert.equal(h.totals.cpes, 5);
    assert.equal(h.totals.ok, 1);
    assert.equal(h.totals.signal_drop, 1);
    assert.equal(h.totals.not_in_uisp, 1);
    assert.equal(h.totals.offline, 1);
    assert.equal(h.totals.ethernet, 1);
    assert.equal(h.cpes[0]!.mac, 'AA:00:00:00:00:03', 'offline first');
    const dropped = h.cpes.find((c) => c.mac === 'AA:00:00:00:00:02')!;
    assert.equal(dropped.signalDelta, -10);
    assert.deepEqual(dropped.issues, ['signal_drop']);
    assert.equal(h.cpes.find((c) => c.mac === 'AA:00:00:00:00:01')!.signalDelta, 1);
  });

  it('module off by default; installers see only their CPEs, without PPPoE data', async () => {
    const fake = fakeUisp();
    const { app } = await buildApp(testConfig(), 'test', { db: openDatabase(':memory:'), logger: false, uisp: fake.uisp });
    const login = async (u: string, p: string) => (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: p } })).json().token as string;
    const admin = await login(ADMIN.username, ADMIN.password);
    const H = (t: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${t}`, ...extra });
    assert.equal((await app.inject({ method: 'GET', url: '/api/cpe-health', headers: H(admin) })).json().error, 'module_disabled');
    assert.equal((await app.inject({ method: 'GET', url: '/api/meta', headers: H(admin) })).json().modules.cpe_health, false);

    // enable the module (Funzionalità)
    const mods = (await app.inject({ method: 'PUT', url: '/api/admin/modules', headers: H(admin), payload: { cpe_health: true, nonexistent: true } })).json();
    assert.equal(mods.find((m: { key: string }) => m.key === 'cpe_health').enabled, true);

    await app.inject({ method: 'POST', url: '/api/admin/users', headers: H(admin), payload: { username: 'tecnico', password: 'Installer-Pass-123' } });
    await app.inject({ method: 'POST', url: '/api/admin/users', headers: H(admin), payload: { username: 'altro', password: 'Installer-Pass-456' } });
    await app.inject({ method: 'POST', url: '/api/admin/profiles/LiteBeam%205AC/templates', headers: H(admin), payload: { name: 'Standard', template: SAMPLE_TEMPLATE, boardMatch: 'board\\.name=LiteBeam 5AC' } });
    await app.inject({ method: 'PUT', url: '/api/admin/wireless-networks/CDA-NET-N2-D01', headers: H(admin), payload: { wpa2Password: 'test-psk-12345' } });
    const tec = await login('tecnico', 'Installer-Pass-123');
    const altro = await login('altro', 'Installer-Pass-456');
    const install = async (tok: string, mac: string) => {
      const id = (
        await app.inject({
          method: 'POST', url: '/api/provisioning/jobs', headers: H(tok, { 'x-cda-client': 'android/1.11.0' }),
          payload: { model: 'LiteBeam 5AC', mac, serial: 'S', ssid: 'CDA-NET-N2-D01', pppoeUser: 'rossi.mario@cda-net.it', pppoePassword: 'Secret-Pppoe' },
        })
      ).json().jobId;
      await app.inject({ method: 'POST', url: `/api/provisioning/jobs/${id}/result`, headers: H(tok), payload: { result: 'success', stages: [], detected: {} } });
      return id;
    };
    await install(tec, 'AA:BB:CC:DD:EE:FF'); // the fake UISP station
    await install(altro, '11:22:33:44:55:66');

    const mine = (await app.inject({ method: 'GET', url: '/api/cpe-health', headers: H(tec) })).json();
    assert.equal(mine.cpes.length, 1);
    assert.equal(mine.cpes[0].mac, 'AA:BB:CC:DD:EE:FF');
    assert.equal(mine.cpes[0].now.signal, -58);
    assert.deepEqual(mine.cpes[0].issues.sort(), ['ethernet', 'pending']);
    assert.ok(!JSON.stringify(mine).match(/rossi\.mario|Secret-Pppoe|pppoe/i), 'no PPPoE data');
    // admins: every customer CPE in UISP, also those not installed with the app
    const all = (await app.inject({ method: 'GET', url: '/api/cpe-health', headers: H(admin) })).json();
    assert.equal(all.cpes.length, 3);
    assert.equal(all.cpes.find((c: { mac: string }) => c.mac === '11:22:33:44:55:66').issues[0], 'not_in_uisp');
    const old = all.cpes.find((c: { mac: string }) => c.mac === '22:33:44:55:66:77');
    assert.equal(old.source, 'uisp');
    assert.equal(old.deviceName, 'BIANCHI LUCA');
    assert.equal(old.jobId, null);
    assert.ok(!all.cpes.some((c: { deviceName: string }) => /AP N|PtP/.test(c.deviceName)), 'APs and PtP links are not customer CPEs');
    assert.equal(all.totals.fromUisp, 1);
    assert.ok(all.installers.some((u: { username: string }) => u.username === 'tecnico'));
    assert.equal((await app.inject({ method: 'GET', url: '/api/cpe-health?scope=app', headers: H(admin) })).json().cpes.length, 2);
    assert.equal((await app.inject({ method: 'GET', url: '/api/cpe-health?installer=altro', headers: H(admin) })).json().cpes.length, 1);

    // assign the old customer to "tecnico": it appears among their CPEs
    const tid = all.installers.find((u: { username: string }) => u.username === 'tecnico').id;
    assert.equal((await app.inject({ method: 'PUT', url: '/api/admin/cpe-assignments', headers: H(admin), payload: { macs: ['22-33-44-55-66-77'], userId: tid } })).statusCode, 200);
    const mine2 = (await app.inject({ method: 'GET', url: '/api/cpe-health', headers: H(tec) })).json();
    assert.deepEqual(mine2.cpes.map((c: { mac: string }) => c.mac).sort(), ['22:33:44:55:66:77', 'AA:BB:CC:DD:EE:FF']);
    assert.equal(mine2.cpes.find((c: { mac: string }) => c.mac === '22:33:44:55:66:77').now.signal, -66);
    assert.equal(mine2.installers, undefined, 'installers list is for admins');
    assert.equal((await app.inject({ method: 'GET', url: '/api/cpe-health', headers: H(altro) })).json().cpes.length, 1, 'not visible to other installers');
    const byTec = (await app.inject({ method: 'GET', url: '/api/cpe-health?installer=tecnico', headers: H(admin) })).json();
    assert.equal(byTec.cpes.length, 2);
    assert.equal(byTec.cpes.find((c: { mac: string }) => c.mac === '22:33:44:55:66:77').assignedTo.username, 'tecnico');
    assert.equal((await app.inject({ method: 'PUT', url: '/api/admin/cpe-assignments', headers: H(tec), payload: { macs: ['22:33:44:55:66:77'], userId: tid } })).statusCode, 403);
    const csv = await app.inject({ method: 'GET', url: '/api/cpe-health.csv', headers: H(tec) });
    assert.match(csv.body, /^\uFEFFInstallata il;Origine;Cliente/);
    assert.equal(csv.body.trim().split('\r\n').length, 3);
    // remove the assignment
    await app.inject({ method: 'PUT', url: '/api/admin/cpe-assignments', headers: H(admin), payload: { macs: ['22:33:44:55:66:77'], userId: null } });
    assert.equal((await app.inject({ method: 'GET', url: '/api/cpe-health', headers: H(tec) })).json().cpes.length, 1);
    await app.close();
  });
});
