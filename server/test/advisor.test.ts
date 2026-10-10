import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { advisorInput, analyzeNetwork, bestChannel, channelOccupancy, frequencyShiftDb, linkSpectrum, signalTrend, type AdvisorInput, type StationInput } from '../src/domain/advisor.ts';

const flat = (v: number, extra: Record<number, number> = {}): Array<[number, number]> => Array.from({ length: 161 }, (_, i) => [5097 + i * 5, extra[5097 + i * 5] ?? v]);
const station = (o: Partial<StationInput> = {}): StationInput => ({
  deviceId: o.deviceId ?? 'cpe-1',
  name: 'CPE',
  mac: 'AA:BB:CC:00:00:01',
  rxSignal: -55,
  noise: -92,
  airtime: 0.01,
  rxMcs: 8,
  rxMcsIdeal: 8,
  txMcs: 8,
  txMcsIdeal: 8,
  capMbps: 200,
  capTheoMbps: 220,
  chains: [-55, -56],
  trendDb: 0,
  spectrum: [],
  ...o,
});
const ap = (o: Partial<AdvisorInput> = {}): AdvisorInput => ({
  apId: 'ap-1',
  apName: 'N1-D01',
  location: { lat: 37.5, lon: 14.2 },
  heading: null,
  beamWidth: 90,
  frequency: 5500,
  widthMhz: 40,
  spectrum: flat(10),
  stations: [station()],
  load: null,
  ...o,
});
const range = { from: 5150, to: 5925 };
const kinds = (f: Array<{ kind: string }>) => f.map((x) => x.kind).sort();

describe('IA-AP: lettura dei dati e regole', () => {
  it('signal trend over the week, and the input of an AP from UISP', () => {
    const start = Date.UTC(2026, 9, 1);
    const s = Array.from({ length: 168 }, (_, i) => ({ x: start + i * 3_600_000, y: i < 48 ? -55 : i >= 144 ? -63 : -58 }));
    assert.equal(signalTrend(s), -8);
    assert.equal(signalTrend(s.slice(0, 50)), null, 'not enough history');
    const input = advisorInput(
      { id: 'ap-1', name: 'N1', location: null, heading: null, frequency: 5500 },
      [{ connected: true, mac: 'AA:BB:CC:00:00:01', rxSignal: -60, noiseFloor: -90, rxMcsIndex: 5, rxMcsIndexIdeal: 8, downlinkCapacity: 150e6, rxChain: [-60, -70], statistics: { airTime: 0.02 }, deviceIdentification: { id: 'cpe-1', name: 'CLIENTE' } }, { connected: false }],
      { frequency: { frequencyCenter: 5330, channelWidth: 40, frequencyBands: [[5097, 10], [5102, 12]] }, stations: { 'aa:bb:cc:00:00:01': { signal: { avg: s }, stationFrequency: { frequencyBands: [[5097, 20]] } } } },
      null,
    );
    assert.equal(input.frequency, 5330);
    assert.equal(input.widthMhz, 40);
    assert.equal(input.stations.length, 1);
    const st = input.stations[0]!;
    assert.deepEqual([st.deviceId, st.name, st.rxMcs, st.rxMcsIdeal, st.capMbps, st.trendDb], ['cpe-1', 'CLIENTE', 5, 8, 150, -8]);
    assert.deepEqual(st.spectrum, [[5097, 20]]);
  });

  it('a healthy AP has nothing to say', () => {
    assert.deepEqual(analyzeNetwork([ap()], { range }), []);
  });

  it('CPEs to fix: SNR, modulation, airtime, trend, polarisations, below the expected signal', () => {
    const st = [
      station({ deviceId: 'snr', rxSignal: -82, noise: -92 }),
      station({ deviceId: 'mcs', rxMcs: 3, rxMcsIdeal: 8 }),
      station({ deviceId: 'air', airtime: 0.12 }),
      station({ deviceId: 'trend', trendDb: -11 }),
      station({ deviceId: 'chains', chains: [-55, -66] }),
      station({ deviceId: 'exp' }),
      station({ deviceId: 'ok' }),
    ];
    const f = analyzeNetwork([ap({ stations: st })], { range, expected: new Map([['exp', -55]]), cpeSignal: new Map([['exp', -70]]) });
    const by = (id: string) => f.filter((x) => x.cpe?.id === id).map((x) => `${x.kind}:${x.severity}`);
    assert.deepEqual(by('snr'), ['snr:critico']);
    assert.deepEqual(by('mcs'), ['mcs:info'], '5 levels below: worth knowing');
    assert.deepEqual(by('air'), ['airtime:critico']);
    assert.deepEqual(by('trend'), ['trend:critico']);
    assert.deepEqual(by('chains'), ['chains:attenzione']);
    assert.deepEqual(by('exp'), ['expected:attenzione']);
    assert.deepEqual(by('ok'), []);
    assert.equal(f[0]!.severity, 'critico', 'critical first');
  });

  it('APs: evening load, many CPEs below their modulation, noise, channel shared with a near AP', () => {
    const load = { at: '', stations: 30, cpeAirtimePct: 2, eveningAirtimePct: 78, eveningUtilizationPct: 40, eveningPeakMbps: 90, capacityMbps: 180, noiseDbm: -78, snrDb: 30, channelWidthMhz: 40, level: 'carico' as const };
    const bad = Array.from({ length: 6 }, (_, i) => station({ deviceId: `c${i}`, rxMcs: i < 4 ? 4 : 8, rxMcsIdeal: 8 }));
    const a = ap({ load, heading: 0, stations: bad, spectrum: flat(10, { 5497: 25, 5502: 25, 5507: 25, 5492: 25, 5487: 25 }) });
    const b = ap({ apId: 'ap-2', apName: 'N1-D02', location: { lat: 37.51, lon: 14.2 }, heading: 180, frequency: 5510, stations: [station({ deviceId: 'b1' })] });
    const f = analyzeNetwork([a, b], { range });
    const mine = f.filter((x) => x.apId === 'ap-1' && !x.cpe).map((x) => x.kind).sort();
    assert.deepEqual(mine, ['busy', 'channel', 'cochannel', 'mcs', 'noise', 'width'], 'busy with SNR margin: also a wider channel');
    const ch = f.find((x) => x.kind === 'channel' && x.apId === 'ap-1')!;
    assert.ok(Math.abs(Number(ch.params!.frequenza) - 5510) >= 40, 'the suggested channel avoids the near AP');
    assert.ok(f.some((x) => x.kind === 'cochannel' && x.apId === 'ap-2'), 'both APs are told');
    assert.ok(!f.some((x) => x.kind === 'channel' && x.apId === 'ap-2'), 'only one of the two is moved');
    assert.match(f.find((x) => x.kind === 'cochannel' && x.apId === 'ap-2')!.action, /basta spostare N1-D01/);
  });

  it('two near APs never get overlapping channel suggestions', () => {
    // both on a noisy channel; the same quiet slot is the best for both: the second AP gets the next one
    const quiet = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [5297 + i * 5, 2]));
    const a = ap({ heading: 90, spectrum: flat(20, quiet) });
    const second = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [5677 + i * 5, 8]));
    const b = ap({ apId: 'ap-2', apName: 'N1-D02', location: { lat: 37.5, lon: 14.25 }, heading: 270, frequency: 5600, spectrum: flat(20, { ...quiet, ...second }) });
    const ch = analyzeNetwork([a, b], { range }).filter((x) => x.kind === 'channel');
    assert.equal(ch.length, 2, JSON.stringify(ch.map((x) => x.params)));
    assert.ok(Math.abs(Number(ch[0]!.params!.frequenza) - Number(ch[1]!.params!.frequenza)) >= 40, JSON.stringify(ch.map((x) => x.params)));
  });

  it('channels: occupancy, quietest channel avoiding our APs, the CPE side counts too', () => {
    const sp = flat(10, { 5597: 3, 5602: 3, 5607: 3, 5612: 3, 5617: 3 });
    assert.equal(channelOccupancy(sp, 5607, 20), 3);
    const quiet = bestChannel(sp, 20, range, [])!;
    assert.ok(Math.abs(quiet.centre - 5607) <= 5 && quiet.occupancy === 3, JSON.stringify(quiet));
    assert.ok(Math.abs(bestChannel(sp, 20, range, [{ f: 5607, w: 20 }])!.centre - 5607) >= 20, 'never on a near AP');
    assert.equal(bestChannel(sp, 20, { from: 5150, to: 5400 }, [])!.occupancy, 10, 'only inside the allowed band');
    // the AP sees a quiet channel the customers see busy: the link spectrum averages both sides
    const link = linkSpectrum(sp, [flat(10, { 5607: 30 }), flat(10, { 5607: 30 })]);
    assert.equal(link.find(([f]) => f === 5607)![1], 16.5);
    assert.deepEqual(linkSpectrum(sp, []), sp);
  });

  it('interference at the customer, narrower channel for weak links, wider one for a busy AP with margin', () => {
    const noisyCpe = station({ deviceId: 'n1', spectrum: flat(10, { 5487: 30, 5492: 30, 5497: 30, 5502: 30, 5507: 30, 5512: 30, 5517: 30 }) });
    const f1 = analyzeNetwork([ap({ stations: [noisyCpe] })], { range });
    assert.ok(f1.some((x) => x.kind === 'cpenoise' && x.cpe?.id === 'n1'));
    const weak = Array.from({ length: 5 }, (_, i) => station({ deviceId: `w${i}`, rxSignal: -76, noise: -92 }));
    assert.ok(analyzeNetwork([ap({ stations: weak })], { range }).some((x) => x.id === 'narrow:ap-1' && x.params!.ampiezza === 20));
    const load = { at: '', stations: 20, cpeAirtimePct: 3, eveningAirtimePct: 60, eveningUtilizationPct: 30, eveningPeakMbps: 80, capacityMbps: 150, noiseDbm: -95, snrDb: 40, channelWidthMhz: 40, level: 'medio' as const };
    const strong = Array.from({ length: 5 }, (_, i) => station({ deviceId: `s${i}`, rxSignal: -50, noise: -95 }));
    assert.ok(analyzeNetwork([ap({ stations: strong, load })], { range }).some((x) => x.id === 'wide:ap-1' && x.params!.ampiezza === 80));
    assert.deepEqual(kinds(analyzeNetwork([ap({ stations: strong })], { range })), []);
  });

  it('frequency response: a weak customer is not pushed below the minimum by a channel far from the band centre', () => {
    // 5500 → 5750 MHz: about −0,4 dB of path loss and about −1,5 dB of the two antennas
    assert.ok(frequencyShiftDb(5500, 5750) < -1.5 && frequencyShiftDb(5500, 5750) > -2.5, String(frequencyShiftDb(5500, 5750)));
    assert.ok(Math.abs(frequencyShiftDb(5500, 5500)) < 0.01);
    assert.ok(frequencyShiftDb(5800, 5500) > 0, 'back to the centre: better');
    // the only quiet channel is high in the band: fine for strong links, not for a customer at −74 dBm
    const sp = flat(20, Object.fromEntries(Array.from({ length: 9 }, (_, i) => [5737 + i * 5, 2])));
    const strong = bestChannel(sp, 40, { from: 5120, to: 5800 }, [], { from: 5500, signals: [-55], minDbm: -75 });
    assert.ok(strong && strong.centre > 5700, JSON.stringify(strong));
    const weak = bestChannel(sp, 40, { from: 5120, to: 5800 }, [], { from: 5500, signals: [-74], minDbm: -75 });
    assert.ok(!weak || weak.centre < 5700, `the weak customer keeps a channel near the band centre: ${JSON.stringify(weak)}`);
    assert.ok(!weak || (weak.weakestDbm ?? -99) >= -75);
    // whole channel inside the band: 40 MHz never centred above 5780
    assert.ok(strong!.centre + 20 <= 5800);
  });
});
