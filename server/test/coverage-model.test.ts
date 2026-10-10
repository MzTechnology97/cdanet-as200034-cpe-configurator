import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApModel, estimateAt, MAX_LINK_M, patternLossDb, rankCoverage, servedArc, theoreticalSignal } from '../src/domain/coverage-model.ts';
import { diffractionLossDb, knifeEdgeLossDb, lineOfSight } from '../src/domain/los.ts';

const AP = { lat: 37.6, lon: 14.1 };
const R = { eirpDbm: 30, cpeGainDbi: 23 };
/** Point [d] metres east (bearing 90°) or west of the AP. */
const at = (d: number, west = false) => ({ lat: AP.lat, lon: AP.lon + ((west ? -1 : 1) * d) / (111320 * Math.cos((AP.lat * Math.PI) / 180)) });
/** Theory at 5.6 GHz: 30 + 23 − 4 − (20·log10(d km) + 107.4). */
const theory = (d: number) => 30 + 23 - 4 - (20 * Math.log10(d / 1000) + 20 * Math.log10(5600) + 32.44);

describe('Copertura: modello del segnale', () => {
  it('finds the arc already served', () => {
    assert.deepEqual(servedArc([350, 10, 20]), { center: 5, width: 30 });
    assert.equal(servedArc([42]), null);
  });

  it('theory alone: free space, antenna pattern only with the azimuth from UISP, low confidence', () => {
    // 1 km at 5.6 GHz: path loss ~107.4 dB → 30 + 23 − 107.4 − 4 ≈ −58 dBm; 4 times farther = 12 dB less
    const near = theoreticalSignal({ sector: { center: 90, width: 90 } }, 1000, 90, 5600, R);
    assert.equal(near.signalDbm, -58);
    assert.equal(theoreticalSignal({ sector: { center: 90, width: 90 } }, 4000, 90, 5600, R).signalDbm, -70);
    assert.equal(near.theoretical, true);
    assert.equal(near.confidence, 'bassa');
    const behind = theoreticalSignal({ sector: { center: 90, width: 90 } }, 1000, 270, 5600, R);
    assert.equal(behind.inSector, false);
    assert.equal(behind.signalDbm, -83, 'behind the antenna: 25 dB lower');
    assert.equal(patternLossDb(135, { center: 90, width: 90 }), 3, '3 dB at the edge of the beam');
    assert.equal(theoreticalSignal({ sector: null }, 1000, 270, null, R).inSector, null, 'no azimuth: direction unknown');
    // a strong theoretical estimate is only "possibile", never "buono"
    assert.equal(rankCoverage([{ distanceM: 1000, status: 'active', estimate: near }], -75)[0]!.rating, 'possibile');
  });

  it('many customers: learns offset and slope, and the customers near the point', () => {
    // customers 6 dB below the theory and falling with n = 2.5
    const clients = [400, 700, 1000, 1400, 1800, 2300, 2900].map((d, i) => ({ ...at(d), signal: Math.round(theory(1000) - 6 - 25 * Math.log10(d / 1000)) + (i % 2 ? 1 : -1) }));
    const m = buildApModel(AP, clients, null, 5600, R);
    assert.ok(m.fit && Math.abs(m.fit.n - 2.5) < 0.3, JSON.stringify(m.fit));
    assert.ok(m.servedM! > 2000);
    const e = estimateAt(m, 1500, 90, 5600, R, { verdict: 'clear', lossDb: 0 });
    const truth = theory(1000) - 6 - 25 * Math.log10(1.5);
    assert.ok(Math.abs(e.signalDbm! - truth) <= 2, `${e.signalDbm} vs ${truth}`);
    assert.equal(e.inSector, true);
    assert.equal(e.confidence, 'alta');
    assert.ok(e.nearby! >= 1);
    const behind = estimateAt(m, 1500, 270, 5600, R, { verdict: 'clear', lossDb: 0 });
    assert.equal(behind.inSector, false);
    assert.equal(behind.confidence, 'bassa');
    assert.ok(behind.signalDbm! <= e.signalDbm! - 8, 'outside the served arc: weaker and uncertain');
    assert.equal(estimateAt(m, 6000, 90, 5600, R).beyondServed, true);
  });

  it('one customer far away with a strong signal cannot make a whole area "good"', () => {
    // the case seen in the field: 1 customer at 6 km reporting −52 dBm (20 dB above the theory)
    const one = buildApModel(AP, [{ ...at(6000), signal: -52 }], null, 5600, R);
    const e = estimateAt(one, 5100, 200, 5600, R, { verdict: 'clear', lossDb: 0 });
    // theory at 5.1 km ≈ −72 dBm: one customer moves it by at most +4 dB (half of the +8 dB cap)
    assert.ok(e.signalDbm! <= Math.round(theory(5100)) + 4, `${e.signalDbm}`);
    assert.equal(e.confidence, 'bassa');
  });

  it('the terrain lowers the estimate: a ridge in the way makes the AP unlikely, not good', () => {
    const clients = [1000, 2000, 3000, 4000, 5000, 6000].map((d) => ({ ...at(d), signal: Math.round(theory(d)) }));
    const m = buildApModel(AP, clients, null, 5600, R);
    const clear = estimateAt(m, 5100, 90, 5600, R, { verdict: 'clear', lossDb: 0 });
    const ridge = estimateAt(m, 5100, 90, 5600, R, { verdict: 'blocked', lossDb: 26 });
    assert.equal(clear.signalDbm! - ridge.signalDbm!, 26);
    const r = rankCoverage(
      [
        { id: 'clear', distanceM: 5100, status: 'active', estimate: clear },
        { id: 'ridge', distanceM: 5100, status: 'active', estimate: ridge },
      ],
      -75,
    );
    assert.deepEqual(r.map((a) => `${a.id}:${a.rating}`), ['clear:buono', 'ridge:improbabile']);
    // blocked but still strong enough: only "possibile", to check on site
    const small = estimateAt(m, 1500, 90, 5600, R, { verdict: 'blocked', lossDb: 7 });
    assert.equal(rankCoverage([{ distanceM: 1500, status: 'active', estimate: small }], -75)[0]!.rating, 'possibile');
  });

  it('customers placed on the AP or beyond any real link are left out (sector and reach stay real)', () => {
    const m = buildApModel(AP, [
      { ...at(1200), signal: -60 },
      { ...at(1800), signal: -63 },
      { ...AP, signal: -55 }, // position of the AP itself
      { ...at(50_000, true), signal: -58 }, // 50 km away: wrong position in UISP
    ]);
    assert.equal(m.samples.length, 2);
    assert.equal(m.ignored, 2);
    assert.ok(m.servedM! < 2000, `served ${m.servedM}`);
    assert.ok(m.sector!.width <= 30, `no 50 km beam towards the misplaced customer: ${JSON.stringify(m.sector)}`);
  });

  it('beyond 20 km an AP is never proposed', () => {
    const e = theoreticalSignal({ sector: null }, MAX_LINK_M + 1000, 0, 5600, { eirpDbm: 50, cpeGainDbi: 30 });
    assert.equal(e.tooFar, true);
    assert.equal(rankCoverage([{ distanceM: MAX_LINK_M + 1000, status: 'active', estimate: e }], -75)[0]!.rating, 'improbabile');
  });
});

it('coverage ranking: good APs first by signal, a farther good AP beats closer weak ones', () => {
  const est = (signalDbm: number | null, spread = 4, inSector: boolean | null = true) => ({
    signalDbm,
    low: signalDbm === null ? null : signalDbm - spread,
    high: signalDbm === null ? null : signalDbm + spread,
    inSector,
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
  assert.deepEqual(
    rankCoverage(aps, -75).map((a) => `${a.id}:${a.rating}`),
    ['far-good:buono', 'mid-ok:buono', 'outside:possibile', 'edge:possibile', 'near-none:senza stima', 'near-weak:improbabile', 'down:non attivo'],
  );
});

describe('Terreno: diffrazione (ITU-R P.526, Deygout)', () => {
  it('knife edge: 6 dB at grazing, nothing well below the line', () => {
    assert.ok(Math.abs(knifeEdgeLossDb(0) - 6) < 0.1, `${knifeEdgeLossDb(0)}`);
    assert.equal(knifeEdgeLossDb(-1), 0);
    assert.ok(knifeEdgeLossDb(2.4) > 19 && knifeEdgeLossDb(2.4) < 21);
  });

  it('flat ground: no loss; a hill entering the Fresnel zone: a few dB; a ridge: tens of dB', () => {
    const flat = Array.from({ length: 51 }, (_, i) => ({ d: i * 100, ground: 300 }));
    assert.equal(diffractionLossDb(flat, 320, 330), 0);
    const hill = (top: number) => flat.map((p) => ({ ...p, ground: p.d === 2500 ? top : 300 }));
    // line of sight at ~325 m in the middle, 60% Fresnel ≈ 5 m at 5.6 GHz over 5 km
    const fresnel = diffractionLossDb(hill(322), 320, 330);
    assert.ok(fresnel > 0 && fresnel < 6, `${fresnel}`);
    assert.equal(lineOfSight(hill(322), 320, 330).verdict, 'fresnel');
    const ridge = diffractionLossDb(hill(360), 320, 330);
    assert.ok(ridge > 20, `${ridge}`);
    assert.equal(lineOfSight(hill(360), 320, 330).verdict, 'blocked');
    // two ridges cost more than one
    const two = flat.map((p) => ({ ...p, ground: p.d === 1500 || p.d === 3500 ? 360 : 300 }));
    assert.ok(diffractionLossDb(two, 320, 330) > ridge);
  });
});

it('AP antenna altitude: a GPS value under the ground + 5 m is raised (never inside its own hill)', async () => {
  const { resolveApAltitude } = await import('../src/domain/los.ts');
  assert.deepEqual(resolveApAltitude(954, 940, 15), { altitude: 954, from: 'gps' });
  assert.deepEqual(resolveApAltitude(925, 940, 15), { altitude: 945, from: 'gps' }, 'GPS 15 m under the ground: ground + 5');
  assert.deepEqual(resolveApAltitude(6, 520, 15), { altitude: 526, from: 'uisp' });
  assert.deepEqual(resolveApAltitude(null, 520, 15), { altitude: 535, from: 'terreno' });
});
