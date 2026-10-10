import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { apCapacityFactor, capacityAt, capacityCurve, eveningPeak, loadLevel, summarizeLoad, type CapacitySample } from '../src/domain/ap-load.ts';
import { rankCoverage } from '../src/domain/coverage-model.ts';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { fakeUisp } from './fake-uisp.ts';
import { ADMIN, testConfig } from './helpers.ts';

/** Hourly series over [days] days from a UTC midnight, value from (local Rome hour) → number. */
const series = (days: number, value: (romeHour: number, day: number) => number, start = Date.UTC(2026, 6, 1)) =>
  Array.from({ length: days * 24 }, (_, i) => {
    const x = start + i * 3_600_000;
    const romeHour = Number(new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', hourCycle: 'h23' }).format(new Date(x)));
    return { x, y: value(romeHour, Math.floor(i / 24)) };
  });

describe('Carico degli AP', () => {
  it('evening peak: the highest value between 20 and 23 (Rome time), averaged over the days', () => {
    // busy 20–22 local, with a higher peak on day 2; a midday spike must not count
    const s = series(3, (h, d) => (h === 21 ? (d === 1 ? 0.8 : 0.5) : h === 12 ? 0.99 : 0.1));
    assert.ok(Math.abs(eveningPeak(s)! - 0.6) < 1e-9, String(eveningPeak(s)));
    assert.equal(eveningPeak([]), null);
    assert.equal(eveningPeak(series(1, () => 0.3).filter((p) => new Date(p.x).getUTCHours() < 12)), null, 'no evening samples');
  });

  it('summarises the AP: evening airtime and traffic, CPE airtime, noise and SNR', () => {
    const stats = {
      airTime: { avg: series(2, (h) => (h >= 20 && h < 23 ? 0.75 : 0.2)) },
      downlinkUtilization: { avg: series(2, (h) => (h >= 20 && h < 23 ? 0.5 : 0.1)) },
      frequency: { channelWidth: 40 },
      interfaces: [
        { name: 'eth0', transmit: { avg: series(2, () => 9e6) } },
        { name: '5GHz', transmit: { avg: series(2, (h) => (h === 21 ? 60e6 : 5e6)) } },
      ],
    };
    const stations = [
      { connected: true, rxSignal: -55, noiseFloor: -90, statistics: { airTime: 0.02 } },
      { connected: true, rxSignal: -65, noiseFloor: -90, statistics: { airTime: 0.06 } },
      { connected: true, rxSignal: -60, noiseFloor: -90, statistics: { airTime: 0.04 } },
      { connected: false, rxSignal: -80, noiseFloor: -90, statistics: { airTime: 0.5 } },
    ];
    const l = summarizeLoad(stats, stations, { dlCapacityMbps: 180, stations: 4 });
    assert.equal(l.stations, 3);
    assert.equal(l.eveningAirtimePct, 75);
    assert.equal(l.eveningUtilizationPct, 50);
    assert.equal(l.eveningPeakMbps, 60, 'the radio interface, not the cable');
    assert.equal(l.cpeAirtimePct, 4);
    assert.equal(l.snrDb, 30);
    assert.equal(l.noiseDbm, -90);
    assert.equal(l.channelWidthMhz, 40);
    assert.equal(l.level, 'carico');
    assert.equal(loadLevel(45, 10), 'medio');
    assert.equal(loadLevel(10, 10), 'libero');
    assert.equal(loadLevel(null, null), null);
    const none = summarizeLoad(null, null, { dlCapacityMbps: null, stations: 7 });
    assert.equal(none.stations, 7);
    assert.equal(none.level, null);
  });

  it('capacity curve from the real CPEs: monotonic, per MHz, and the AP factor', () => {
    // 20 MHz channels: capacity grows with the signal, saturating at −50 dBm
    const s: CapacitySample[] = [];
    for (let sig = -85; sig <= -45; sig += 1) for (let k = 0; k < 2; k++) s.push({ signal: sig, capMbps: Math.min(150, Math.max(10, (sig + 90) * 4)) + (k ? 2 : -2), widthMhz: 20 });
    const c = capacityCurve(s)!;
    assert.ok(c);
    for (let i = 1; i < c.perMhz.length; i++) assert.ok(c.perMhz[i]! >= c.perMhz[i - 1]!, 'never decreasing');
    const at60 = capacityAt(c, -60, 20);
    assert.ok(Math.abs(at60 - 120) <= 6, String(at60));
    assert.ok(Math.abs(capacityAt(c, -60, 40) - 2 * at60) <= 1);
    assert.ok(capacityAt(c, -40, 20) <= 152 && capacityAt(c, -95, 20) >= 0);
    // an AP whose CPEs get half of the network curve
    const half = s.slice(0, 20).map((x) => ({ ...x, capMbps: x.capMbps / 2 }));
    assert.ok(Math.abs(apCapacityFactor(c, half) - 0.5) < 0.1);
    assert.equal(apCapacityFactor(c, half.slice(0, 2)), 1, 'few CPEs: the network curve');
    assert.equal(capacityCurve(s.slice(0, 10)), null, 'too few samples');
  });

  it('a busy AP is never the advice, and comes after a free one with the same rating', () => {
    const est = (signalDbm: number) => ({ signalDbm, low: signalDbm - 4, high: signalDbm + 4, inSector: true as const });
    const r = rankCoverage(
      [
        { id: 'busy', distanceM: 1000, status: 'active', estimate: est(-55), load: { level: 'carico' as const } },
        { id: 'medium', distanceM: 1000, status: 'active', estimate: est(-58), load: { level: 'medio' as const } },
        { id: 'free', distanceM: 1000, status: 'active', estimate: est(-60), load: { level: 'libero' as const } },
      ],
      -75,
    );
    assert.deepEqual(r.map((a) => `${a.id}:${a.rating}`), ['free:buono', 'medium:buono', 'busy:possibile']);
  });

  it('Copertura: capacity of the new link and the load of the AP (installers: the verdict only)', async () => {
    const uisp = fakeUisp();
    const { app, ctx } = await buildApp(testConfig(), 'test', { db: openDatabase(':memory:'), logger: false, uisp: uisp.uisp, fetchImpl: uisp.fetchImpl });
    const s: CapacitySample[] = [];
    for (let sig = -85; sig <= -45; sig++) s.push({ signal: sig, capMbps: Math.min(150, Math.max(10, (sig + 90) * 4)), widthMhz: 20 }, { signal: sig, capMbps: Math.min(150, Math.max(10, (sig + 90) * 4)), widthMhz: 20 });
    const load = summarizeLoad({ airTime: { avg: series(2, (h) => (h === 21 ? 0.9 : 0.1)) } }, [], { dlCapacityMbps: 200, stations: 12 });
    ctx.apLoad._set({ curve: capacityCurve(s), loads: { 'ap-n2': load }, factors: {}, widths: {} });
    const H = { authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: ADMIN })).json().token}` };
    const r = (await app.inject({ method: 'GET', url: '/api/coverage?lat=37.6&lon=14.1&limit=10', headers: H })).json();
    const n2 = r.aps.find((a: { id: string }) => a.id === 'ap-n2');
    assert.equal(n2.load.level, 'carico');
    assert.equal(n2.load.eveningAirtimePct, 90);
    assert.notEqual(n2.rating, 'buono');
    assert.ok(typeof n2.estimate.capacityMbps === 'number' && n2.estimate.capacityMbps > 0, JSON.stringify(n2.estimate));
    await app.inject({ method: 'POST', url: '/api/admin/users', headers: H, payload: { username: 'tecnico', password: 'Installer-Pass-123' } });
    const T = { authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'tecnico', password: 'Installer-Pass-123' } })).json().token}` };
    const people = (await app.inject({ method: 'GET', url: '/api/admin/assignments', headers: H })).json().users;
    const tid = people.find((p: { username: string }) => p.username === 'tecnico').id;
    await app.inject({ method: 'PUT', url: `/api/admin/assignments/${tid}`, headers: H, payload: { items: [{ key: 'ap:ap-n2', name: 'N2' }] } });
    const t = (await app.inject({ method: 'GET', url: '/api/coverage?lat=37.6&lon=14.1', headers: T })).json();
    const tn2 = t.aps.find((a: { id: string }) => a.id === 'ap-n2');
    if (tn2) assert.deepEqual(Object.keys(tn2.load), ['level'], 'installers: no numbers of the AP');
    const sim = (await app.inject({ method: 'GET', url: '/api/admin/coverage/simulation?apId=ap-n2', headers: H })).json();
    assert.equal(sim.capacity, true);
    assert.ok(sim.cells.some((c: { cap?: number }) => typeof c.cap === 'number'));
  });
});
