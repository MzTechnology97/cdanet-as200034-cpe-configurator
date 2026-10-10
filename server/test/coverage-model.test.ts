import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApModel, estimateSignal, rankCoverage, servedArc } from '../src/domain/coverage-model.ts';

const AP = { lat: 37.6, lon: 14.1 };
/** Point [d] metres east (bearing 90°) or west of the AP. */
const at = (d: number, west = false) => ({ lat: AP.lat, lon: AP.lon + ((west ? -1 : 1) * d) / (111320 * Math.cos((AP.lat * Math.PI) / 180)) });
/** Customers following signal = 10 − 25·log10(d) (n = 2.5), with ±1 dB of noise. */
const clients = [400, 700, 1000, 1400, 1800, 2300, 2900].map((d, i) => ({ ...at(d), signal: Math.round(10 - 25 * Math.log10(d)) + (i % 2 ? 1 : -1) }));

describe('Copertura dai clienti installati', () => {
  it('finds the arc already served', () => {
    assert.deepEqual(servedArc([350, 10, 20]), { center: 5, width: 30 });
    assert.equal(servedArc([42]), null);
  });

  it('learns the AP and estimates a new CPE', () => {
    const m = buildApModel(AP, clients);
    assert.ok(m.fit && Math.abs(m.fit.n - 2.5) < 0.3, JSON.stringify(m.fit));
    assert.ok(m.servedM! > 2000);
    const e = estimateSignal(m, 1500, 90);
    assert.ok(Math.abs(e.signalDbm! - (10 - 25 * Math.log10(1500))) <= 2, JSON.stringify(e));
    assert.equal(e.inSector, true);
    assert.equal(e.confidence, 'alta');
    assert.ok(e.low! < e.signalDbm! && e.high! > e.signalDbm!);
    assert.ok(e.nearby >= 1);

    const behind = estimateSignal(m, 1500, 270);
    assert.equal(behind.inSector, false);
    assert.equal(behind.confidence, 'bassa');
    assert.ok(behind.signalDbm! <= e.signalDbm! - 8, 'outside the served arc: weaker and uncertain');
    assert.equal(estimateSignal(m, 6000, 90).beyondServed, true);
  });

  it('without customers there is no estimate', () => {
    const e = estimateSignal(buildApModel(AP, []), 1000, 90);
    assert.equal(e.signalDbm, null);
    assert.equal(e.confidence, 'bassa');
  });
});

it('coverage ranking: good APs first by signal, a farther good AP beats closer weak ones', () => {
  const est = (signalDbm: number | null, spread = 4, inSector: boolean | null = true) => ({
    signalDbm,
    low: signalDbm === null ? null : signalDbm - spread,
    high: signalDbm === null ? null : signalDbm + spread,
    inSector,
    beyondServed: false,
    confidence: 'media' as const,
    basis: 5,
    nearby: 1,
  });
  const aps = [
    { id: 'near-weak', distanceM: 800, status: 'active', estimate: est(-84) },
    { id: 'near-none', distanceM: 900, status: 'active', estimate: null },
    { id: 'down', distanceM: 500, status: 'disconnected', estimate: est(-55) },
    { id: 'far-good', distanceM: 6000, status: 'active', estimate: est(-62) },
    { id: 'mid-ok', distanceM: 3000, status: 'active', estimate: est(-70) },
    { id: 'edge', distanceM: 2000, status: 'active', estimate: est(-78, 6) },
    { id: 'outside', distanceM: 1500, status: 'active', estimate: est(-66, 10, false) },
  ];
  const r = rankCoverage(aps, -75);
  assert.deepEqual(
    r.map((a) => `${a.id}:${a.rating}`),
    ['far-good:buono', 'mid-ok:buono', 'outside:possibile', 'edge:possibile', 'near-none:senza stima', 'near-weak:improbabile', 'down:non attivo'],
  );
});
