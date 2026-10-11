import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeHorizon, rayDistances } from '../src/services/horizon.ts';
import type { TerrainSampler } from '../src/services/terrain-store.ts';

const P = { lat: 37.5, lon: 14.2 };
const mLat = 111_320;

describe('skyline for the augmented reality', () => {
  it('flat ground: the skyline is just below the horizontal (earth curvature)', () => {
    const at: TerrainSampler = { fine: true, ground: () => 300, cover: () => null };
    const h = computeHorizon(at, P, 6, { maxM: 5000 })!;
    assert.equal(h.el.length, 720);
    assert.equal(h.eye, 306);
    assert.ok(h.el.every((e) => e < 0 && e > -20), String(h.el[0]));
  });

  it('a ridge 2 km to the north rises over the north only, at the right angle and distance', () => {
    // a 200 m wall from 2000 to 2100 m north of the point
    const at: TerrainSampler = {
      fine: true,
      ground: (lat, lon) => {
        const north = (lat - P.lat) * mLat;
        const east = Math.abs(lon - P.lon) * mLat * Math.cos((P.lat * Math.PI) / 180);
        return north > 2000 && north < 2100 && east < 400 ? 500 : 300;
      },
      cover: () => null,
    };
    const h = computeHorizon(at, P, 6)!;
    const north = h.el[0]!;
    const expected = (Math.atan((500 - 306 - 2000 ** 2 / (2 * 6371000 * 4 / 3)) / 2000) * 180) / Math.PI;
    assert.ok(Math.abs(north - expected) < 0.3, `${north} ≈ ${expected}`);
    assert.ok(h.dist[0]! >= 2000 && h.dist[0]! < 2100);
    assert.ok(h.el[360]! < 0, 'south stays flat');
    assert.ok(h.el[90]! < 1, 'east (45°) misses the wall');
  });

  it('no ground at the point: no skyline', () => {
    assert.equal(computeHorizon({ fine: false, ground: () => null, cover: () => null }, P, 6), null);
  });

  it('rays are fine near the point and coarse far away', () => {
    const d = rayDistances(25000);
    assert.equal(d[0], 20);
    assert.ok(d[1]! - d[0]! === 15);
    assert.ok(d[d.length - 1]! - d[d.length - 2]! === 90);
    assert.ok(d.length < 450);
  });
});
