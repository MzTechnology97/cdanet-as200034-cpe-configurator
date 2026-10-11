import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CPE_MODELS, cpeModelById, cpeModelOf, recommendCpe } from '../src/domain/cpe-models.ts';

describe('Modelli di CPE Ubiquiti', () => {
  it('recognises the names UISP gives the CPEs of the network', () => {
    const g = (n: string) => cpeModelOf(n)?.gainDbi ?? null;
    assert.equal(g('LiteBeam 5AC'), 23);
    assert.equal(g('NanoStation 5AC loco'), 13, 'not taken for NanoStation 5AC');
    assert.equal(g('NanoStation 5AC'), 16);
    assert.equal(g('PowerBeam 5AC'), 25);
    assert.equal(g('PowerBeam 5AC 300'), 22);
    assert.equal(g('LiteBeam 5AC Long-Range'), 26);
    assert.equal(g('NanoBeam 5AC 16'), 16);
    assert.equal(g('PowerBeam M5 400'), 25);
    assert.equal(g('LBE-5AC-Gen2'), 23);
    assert.equal(g('airFiber 5XHD'), null, 'other radios are not CPEs of the catalogue');
    assert.equal(cpeModelById('lbe5ac')!.gainDbi, 23);
    assert.equal(new Set(CPE_MODELS.map((m) => m.id)).size, CPE_MODELS.length);
  });

  it('proposes the smallest current CPE that reaches a good signal at that distance', () => {
    // −55 dBm with the reference 23 dBi: a Loco (13 dBi) gives −65, enough at 1 km
    assert.equal(recommendCpe(-55, 23, 1000, -65)!.model.id, 'loco5ac');
    // the same signal at 6 km: beyond what a Loco is for
    assert.equal(recommendCpe(-55, 23, 6000, -65)!.model.id, 'nbe5ac');
    // −68 dBm: a LiteBeam is not enough, a PowerBeam (25 dBi) gives −66, the Long-Range −65
    assert.equal(recommendCpe(-68, 23, 4000, -65)!.model.id, 'lbe5aclr');
    assert.equal(recommendCpe(-90, 23, 4000, -65), null, 'nothing reaches it');
  });
});
