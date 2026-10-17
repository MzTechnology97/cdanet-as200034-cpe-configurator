import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { autonomyHours, busyAps, signalDrops } from '../src/services/proactive-alerts.ts';
import { SAMPLE_TEMPLATE, testApp } from './helpers.ts';

const ANDROID = { 'x-cda-client': 'android/9.0.0' };
const HOUR = 3_600_000;

describe('Avvisi proattivi', () => {
  it('finds signal drops, busy APs and the hours of battery left', () => {
    const t = { signalDropDb: 6, signalMin: -75 };
    assert.deepEqual(
      signalDrops(
        [
          { mac: 'A', name: 'Rossi', acceptance: -58, now: -60 },
          { mac: 'B', name: 'Verdi', acceptance: -58, now: -66 },
          { mac: 'C', name: 'Bianchi', acceptance: -74, now: -77 },
        ],
        t,
      ).map((d) => [d.mac, d.drop]),
      [
        ['B', 8],
        ['C', 3],
      ],
      '2 dB is noise; 8 dB is a drop; under the minimum always',
    );
    const load = (air: number | null, util: number | null) => ({ at: '', stations: 30, cpeAirtimePct: null, eveningAirtimePct: air, eveningUtilizationPct: util, eveningPeakMbps: null, capacityMbps: null, noiseDbm: null, snrDb: null }) as never;
    assert.deepEqual(
      busyAps([{ apId: '1', name: 'N2-D01', load: load(85, 40) }, { apId: '2', name: 'N2-D02', load: load(50, 90) }, { apId: '3', name: 'N5-D01', load: load(60, 70) }], 80).map((b) => b.name),
      ['N2-D02', 'N2-D01'],
    );
    const t0 = Date.parse('2026-10-15T20:00:00Z');
    assert.equal(autonomyHours([{ t: t0, soc: 80 }, { t: t0 + 10 * 60_000, soc: 79 }]), null, 'not enough time yet');
    assert.equal(autonomyHours([{ t: t0, soc: 80 }, { t: t0 + HOUR / 2, soc: 75 }]), 7.5, '10%/h from 75%');
    assert.equal(autonomyHours([{ t: t0, soc: 80 }, { t: t0 + HOUR, soc: 80 }]), null, 'not dropping');
  });

  it('tells the NOC once, after a drop seen twice; the POPs only when critical, and back on charge after that', async () => {
    const t = await testApp();
    const A = t.auth(await t.login());
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, headers: Record<string, string> = A) => t.app.inject({ method, url, headers, payload });
    await call('POST', '/api/admin/users', { username: 'tecnico', password: 'Installer-Pass-123' });
    await call('POST', '/api/admin/profiles/LiteBeam%205AC/templates', { name: 'Standard', template: SAMPLE_TEMPLATE, boardMatch: 'board\\.name=LiteBeam 5AC' });
    await call('PUT', '/api/admin/wireless-networks/CDA-NET-N2-D01', { wpa2Password: 'test-psk-12345' });
    const T = t.auth(await t.login('tecnico', 'Installer-Pass-123'));
    const job = (await call('POST', '/api/provisioning/jobs', { model: 'LiteBeam 5AC', mac: 'AA:BB:CC:00:00:01', serial: 'S1', ssid: 'CDA-NET-N2-D01', pppoeUser: 'rossi@cda-net.it', pppoePassword: 'Segreta-PPPoE-1' }, { ...T, ...ANDROID })).json().jobId;
    await call('POST', `/api/provisioning/jobs/${job}/result`, { result: 'success', stages: [] }, T);
    await call('PUT', `/api/provisioning/jobs/${job}/acceptance`, { verdict: 'ok', measuredAt: new Date().toISOString(), samples: 10, cpe: { model: 'LiteBeam 5AC', firmware: 'WA.v8.7.4', apName: 'N2-D01' }, radio: { signal: -58 }, internet: { tested: false }, checks: [], notes: '' }, T);

    const said: Array<{ title: string; power: boolean }> = [];
    t.ctx.notify.proactive = (title: string, _lines: string[], power = false) => void said.push({ title, power });
    let signal = -67;
    const cpe = { id: 'd1', mac: 'AA:BB:CC:00:00:01', name: 'Rossi', status: 'active', role: 'station', wirelessMode: 'sta-ptmp', get signal() { return signal; } };
    (t.ctx as { uisp: unknown }).uisp = { allDevices: async () => [cpe], sites: async () => [{ id: 'pop1', name: 'Demo Monte' }] };
    await t.ctx.proactive.hourly();
    assert.equal(said.length, 0, 'once is not enough: a passing dip');
    await t.ctx.proactive.hourly();
    assert.deepEqual(said.map((s) => s.title), ['📉 Segnale in calo su 1 CPE']);
    await t.ctx.proactive.hourly();
    assert.equal(said.length, 1, 'not again within the week');
    signal = -59;

    // a solar POP: on battery every night, back on charge in the morning, never critical: silence
    const real = Date.now;
    let now = Date.parse('2026-10-15T20:00:00Z');
    Date.now = () => now;
    try {
      let pop = { status: 'warn', soc: 90, batteryState: 'discharging', offGrid: false };
      (t.ctx.victronSync as { byPop: () => Map<string, unknown> }).byPop = () => new Map([['pop1', pop]]);
      for (const soc of [90, 88, 86, 84]) {
        pop = { ...pop, soc };
        await t.ctx.proactive.power();
        now += 60 * 60_000;
      }
      pop = { ...pop, batteryState: 'charging' };
      await t.ctx.proactive.power();
      assert.equal(said.length, 1, 'a normal night on battery says nothing, nor the morning charge');

      // a real outage: 60% → 55% in half an hour (≈5.5 h), then down to 18% (≈1.8 h): critical, once
      pop = { ...pop, soc: 60, batteryState: 'discharging' };
      now += 60 * 60_000;
      await t.ctx.proactive.power();
      now += 30 * 60_000;
      pop = { ...pop, soc: 55 };
      await t.ctx.proactive.power();
      assert.equal(said.length, 1, 'on battery but plenty left: nothing');
      for (const soc of [40, 30, 22, 18, 15]) {
        now += 30 * 60_000;
        pop = { ...pop, soc };
        await t.ctx.proactive.power();
      }
      assert.deepEqual(said.slice(1).map((s) => s.title), ['⚠️ POP Demo Monte: batteria critica'], 'one critical alert');
      assert.equal(said.at(-1)!.power, true, 'also to the group, with the Enel outages');
      pop = { ...pop, soc: 20, batteryState: 'charging' };
      now += 5 * 60_000;
      await t.ctx.proactive.power();
      assert.equal(said.at(-1)!.title, '✅ POP Demo Monte: di nuovo in carica');
      // swinging around the threshold right after: no new alert within 2 hours
      pop = { ...pop, soc: 18, batteryState: 'discharging' };
      now += 10 * 60_000;
      await t.ctx.proactive.power();
      assert.equal(said.length, 3);
    } finally {
      Date.now = real;
    }
    await t.app.close();
  });
});
