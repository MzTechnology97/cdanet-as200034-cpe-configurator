import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { beamwidth, msiGain, parseAnt, parseRfeCsv } from '../src/services/antennas.ts';
import { buildApModel, estimateAt, patternAt } from '../src/domain/coverage-model.ts';
import { needsExternalAntenna, suggestedAzimuth } from '../src/routes/antennas.ts';

/** A sector of [width]° with 20 dB at the back, electrical downtilt [tilt]°: as a .ant file. */
function antFile(width: number, tilt: number): string {
  const h = Array.from({ length: 360 }, (_, i) => {
    const a = i > 180 ? 360 - i : i;
    return -Math.min(20, 12 * (a / width) ** 2);
  });
  const v = Array.from({ length: 360 }, (_, i) => {
    // index 90 = horizon, 91… below; peak at 90 + tilt
    const off = Math.abs(i - (90 + tilt));
    return -Math.min(25, 12 * (off / 8) ** 2);
  });
  return [...h, ...v].map((x) => x.toFixed(1)).join('\n');
}

describe('antenna patterns', () => {
  it('reads a Ubiquiti .ant: horizontal from the boresight, vertical below the horizon', () => {
    const p = parseAnt(antFile(90, 2))!;
    assert.equal(p.az[0], 0);
    assert.ok(Math.abs(p.az[45]! - 3) < 0.2, 'edge of a 90° sector: −3 dB');
    assert.equal(p.az[180], 20);
    assert.equal(p.el[2], 0, 'electrical downtilt of 2°: the peak 2° below the horizon');
    assert.ok(p.el[0]! > 0 && p.el[358]! > p.el[0]!);
    assert.ok(Math.abs(beamwidth(p.az) - 90) <= 2);
    assert.equal(parseAnt('1 2 3'), null);
    assert.equal(msiGain('NAME X\nGAIN 21 dBi\n'), 21);
    assert.equal(msiGain('GAIN 15.85 dBd'), 18);
  });

  it('reads an RF elements CSV (Google Network Planner)', () => {
    const rows = Array.from({ length: 360 }, (_, k) => {
      const a = k - 179;
      const g = 14.3 - Math.min(40, 12 * (Math.abs(a) / 50) ** 2);
      return `${a},${g},${g},,,`;
    });
    const csv = ['----Metadata----,,', 'Import schema version,1', '----SpecMetadata----,,', 'Manufacturer,Model Name,Acquisition Frequency (MHz),Frequency Start (MHz),Frequency End (MHz),Nominal Gain (dBi),Beamwidth (Degrees)', 'RF elements s.r.o.,HG3-TP-S50,5500,5180,6400,14.3,50', '----PatternData----,,', 'Angle (Degrees),Azimuth Gain (dBi),Elevation Gain (dBi)', ...rows].join('\n');
    const p = parseRfeCsv(csv)!;
    assert.equal(p.name, 'HG3-TP-S50');
    assert.equal(p.gainDbi, 14.3);
    assert.equal(p.az[0], 0);
    assert.ok(Math.abs(beamwidth(p.az) - 50) <= 2);
    assert.ok(Math.abs(beamwidth(p.el) - 50) <= 2);
  });

  it('the pattern turns with the azimuth and the mechanical tilt', () => {
    const p = parseAnt(antFile(60, 0))!;
    const s = { ...p, azimuth: 120, tilt: 3 };
    assert.equal(patternAt({ ...s, tilt: null }, 120, null), 0);
    assert.ok(patternAt({ ...s, tilt: null }, 150, null) > 2.5, 'edge of the 60° beam');
    // a customer 3° below the AP is on the boresight of an antenna tilted 3° down
    assert.equal(patternAt(s, 120, -3), 0);
    assert.ok(patternAt(s, 120, 2) > patternAt(s, 120, -3), 'above the beam');
  });

  it('with the real antenna, a point behind it gets less than one in front', () => {
    const p = parseAnt(antFile(90, 0))!;
    const ap = { lat: 37.5, lon: 14.2 };
    const clients = [0.01, 0.02, 0.03].map((k) => ({ lat: 37.5 + k, lon: 14.2 + k / 3, signal: -62 }));
    const m = buildApModel(ap, clients, null, 5600, { eirpDbm: 38, cpeGainDbi: 23 }, 0, { az: p.az, el: p.el, azimuth: 15, tilt: null });
    const front = estimateAt(m, 3000, 15, 5600, { eirpDbm: 38, cpeGainDbi: 23 });
    const back = estimateAt(m, 3000, 195, 5600, { eirpDbm: 38, cpeGainDbi: 23 });
    assert.ok(front.signalDbm! - back.signalDbm! >= 15, `${front.signalDbm} vs ${back.signalDbm}`);
    assert.equal(back.inSector, false);
  });

  it('suggested azimuth from the customers; radios without an antenna', () => {
    const ap = { lat: 37.5, lon: 14.2 };
    const s = suggestedAzimuth(ap, [0.01, 0.02, 0.015].map((k, i) => ({ lat: 37.5 + k, lon: 14.2 + (i - 1) * 0.005 })))!;
    assert.ok(s.azimuth < 20 || s.azimuth > 340, String(s.azimuth));
    assert.equal(suggestedAzimuth(ap, [{ lat: 37.51, lon: 14.2 }]), null);
    assert.ok(needsExternalAntenna('Rocket Prism 5AC Gen2'));
    assert.ok(needsExternalAntenna('RP-5AC-Gen2'));
    assert.ok(!needsExternalAntenna('LAP-GPS'));
    assert.ok(!needsExternalAntenna('LiteAP AC'));
  });
});
