import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { firmwareIs, networkHealth } from '../src/domain/health.ts';
import { ethSpeed, normalizeDevice } from '../src/services/uisp.ts';
import { fakeUisp } from './fake-uisp.ts';
import { ADMIN, testConfig } from './helpers.ts';

const T = { signalGood: -65, signalMin: -75, ethMinMbps: 100, capacityMinMbps: 100, targetFirmware: '8.7.4' };
const sta = (id: string, overview: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  normalizeDevice({
    identification: { id, name: `CPE ${id}`, mac: '24:A4:3C:00:00:' + id.padStart(2, '0'), role: 'station', firmwareVersion: 'XC.qca956x.v8.7.4', authorized: true, ...extra },
    overview: { status: 'active', ...overview },
    attributes: { ssid: 'CDA-NET-N2-D01', apDevice: { id: 'ap1', name: 'AP N2' } },
  });

describe('Network health (NOC)', () => {
  it('parses LAN speed and firmware', () => {
    assert.deepEqual(ethSpeed({ availableSpeed: '1000-full' }), { ethMbps: 1000, ethHalfDuplex: false });
    assert.deepEqual(ethSpeed({ availableSpeed: '10-half' }), { ethMbps: 10, ethHalfDuplex: true });
    assert.deepEqual(ethSpeed(undefined), { ethMbps: null, ethHalfDuplex: false });
    assert.ok(firmwareIs('XC.qca956x.v8.7.4.45112.210415.1103', '8.7.4'));
    assert.ok(!firmwareIs('XC.qca956x.v8.7.11', '8.7.4'));
    assert.ok(firmwareIs('8.7.4', '8.7.4'));
  });

  it('classifies CPEs and summarises each AP sector', () => {
    const ap = normalizeDevice({ identification: { id: 'ap1', name: 'AP N2', role: 'ap', authorized: true }, overview: { status: 'active', stationsCount: 5 }, attributes: { ssid: 'CDA-NET-N2-D01' } });
    const devs = [
      ap,
      sta('1', { signal: -60, mainInterfaceSpeed: { availableSpeed: '1000-full' }, downlinkCapacity: 300e6 }),
      sta('2', { signal: -79 }),
      sta('3', { status: 'disconnected', signal: -90, lastSeen: '2026-10-08T10:00:00Z' }),
      sta('4', { signal: -62, mainInterfaceSpeed: { availableSpeed: '100-half' } }),
      sta('5', { signal: -61 }, { firmwareVersion: 'XC.v8.7.11', authorized: false }),
    ];
    const h = networkHealth(devs, T);
    assert.equal(h.totals.cpes, 5);
    assert.equal(h.totals.ok, 1);
    assert.equal(h.totals.offline, 1);
    assert.equal(h.totals.weak_signal, 1, 'offline CPEs are not also counted as weak');
    assert.equal(h.totals.ethernet, 1);
    assert.equal(h.totals.pending, 1);
    assert.equal(h.totals.firmware, 1);
    assert.equal(h.cpes[0]!.id, '3', 'offline first');
    assert.deepEqual(h.cpes.find((c) => c.id === '5')!.issues.sort(), ['firmware', 'pending']);
    assert.equal(h.aps[0]!.stations, 5);
    assert.equal(h.aps[0]!.offline, 1);
    assert.equal(h.aps[0]!.weak, 1);
    assert.equal(h.aps[0]!.avgSignal, -65); // (-60 -79 -62 -61) / 4 = -65.5
  });

  it('serves the page data and the CSV to admins only', async () => {
    const fake = fakeUisp();
    const { app } = await buildApp(testConfig(), 'test', { db: openDatabase(':memory:'), logger: false, uisp: fake.uisp });
    const tok = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: ADMIN.username, password: ADMIN.password } })).json().token;
    const H = { authorization: `Bearer ${tok}` };
    const h = (await app.inject({ method: 'GET', url: '/api/admin/network/health', headers: H })).json();
    assert.equal(h.totals.cpes, 1);
    assert.deepEqual(h.cpes[0].issues.sort(), ['ethernet', 'pending']); // fake station: 10-half, not yet accepted
    assert.equal(h.cpes[0].dlCapacityMbps, 250);
    assert.ok(h.aps.length >= 2);
    const csv = await app.inject({ method: 'GET', url: '/api/admin/network/health.csv', headers: H });
    assert.match(csv.body, /^﻿CPE;MAC;Modello/);
    assert.match(csv.body, /ROSSI MARIO;AA:BB:CC:DD:EE:FF;.*10 half.*porta LAN/);
    await app.inject({ method: 'POST', url: '/api/admin/users', headers: H, payload: { username: 'tecnico', password: 'Installer-Pass-123' } });
    const it2 = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'tecnico', password: 'Installer-Pass-123' } })).json().token;
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/network/health', headers: { authorization: `Bearer ${it2}` } })).statusCode, 403);
    await app.close();
  });
});
