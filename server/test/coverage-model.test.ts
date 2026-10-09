import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApModel, estimateSignal, servedArc } from '../src/domain/coverage-model.ts';

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
