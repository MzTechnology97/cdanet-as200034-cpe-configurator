import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createSealer } from '../src/crypto.ts';
import { openDatabase } from '../src/db.ts';
import { createImagery, PHOTO_MIN_ZOOM, tilesAround } from '../src/services/imagery.ts';
import { createImageryPrefetch } from '../src/services/imagery-prefetch.ts';

const photo = () => {
  const b = new Uint8Array(4000).fill(9);
  b.set([0xff, 0xd8, 0xff]);
  return new Response(b, { status: 200, headers: { 'content-type': 'image/jpeg' } });
};
const ENNA = { lat: 37.567, lon: 14.279 };

describe('Ortofoto: da zoom 12 e area della rete scaricata in anticipo', () => {
  it('far out nothing is asked to the public service, and the maps start the photos at zoom 12', async () => {
    let asked = 0;
    const fetchImpl = (async () => (asked++, photo())) as typeof fetch;
    const im = createImagery(openDatabase(':memory:'), createSealer(Buffer.alloc(32, 7)), { fetchImpl });
    im.save('wms', { enabled: true }, 1);
    assert.equal(PHOTO_MIN_ZOOM, 12);
    assert.equal(await im.tile('wms', 'ortofoto', 11, 1092, 793), null, 'zoom 11: the base map');
    assert.equal(asked, 0);
    assert.ok(await im.tile('wms', 'ortofoto', 12, 2210, 1586));
    assert.equal(asked, 1);
    assert.equal(im.layers().find((l) => l.id === 'wms')?.minZoom, 12);
  });

  it('the tiles around the APs: every zoom, each tile once, the far zooms first', () => {
    const near = { lat: ENNA.lat + 0.005, lon: ENNA.lon + 0.005 };
    const one = tilesAround([ENNA], 3, 12, 16);
    const two = tilesAround([ENNA, near], 3, 12, 16);
    assert.deepEqual([...new Set(one.map(([z]) => z))], [12, 13, 14, 15, 16]);
    assert.equal(new Set(two.map((t) => t.join('/'))).size, two.length, 'no tile twice');
    assert.ok(two.length < one.length * 2, 'two APs close together share most of their tiles');
    // 6 km at zoom 16 (about 480 m per tile here): around 13 × 13 tiles
    const z16 = one.filter(([z]) => z === 16).length;
    assert.ok(z16 >= 144 && z16 <= 225, `zoom 16: ${z16} tiles`);
  });

  it('the download asks only what is missing, never more than its share at once, and stops when asked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdanet-prefetch-'));
    let asked = 0;
    let now = 0;
    let peak = 0;
    const fetchImpl = (async () => {
      asked++;
      peak = Math.max(peak, ++now);
      await new Promise((r) => setTimeout(r, 2));
      now--;
      return photo();
    }) as typeof fetch;
    try {
      const im = createImagery(openDatabase(':memory:'), createSealer(Buffer.alloc(32, 7)), { fetchImpl, dir });
      const pf = createImageryPrefetch({ imagery: im, aps: async () => [ENNA] });
      assert.equal(await pf.run(), null, 'orthophotos off: nothing to do');
      im.save('wms', { enabled: true }, 1);
      const tiles = tilesAround([ENNA], 1, 12, 14);
      await im.tile('wms', 'ortofoto', ...tiles[0]!);
      asked = 0;
      const r = await im.prefetch(tiles, { parallel: 2 });
      assert.equal(r.skipped, 1, 'the tile already on disk');
      assert.equal(r.asked, tiles.length - 1);
      assert.equal(asked, tiles.length - 1);
      assert.ok(peak <= 2, `at most 2 at once (${peak})`);
      const again = await im.prefetch(tiles, { parallel: 2 });
      assert.equal(again.asked, 0, 'a second run costs nothing');
      const ctrl = new AbortController();
      ctrl.abort();
      assert.equal((await im.prefetch(tilesAround([{ lat: 38.1, lon: 13.36 }], 1, 12, 14), { signal: ctrl.signal })).asked, 0, 'stopped');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
