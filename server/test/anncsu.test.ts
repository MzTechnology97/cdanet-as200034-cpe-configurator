import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAnncsu, normStreet, parseAddress } from '../src/services/anncsu.ts';

describe('ANNCSU house numbers', () => {
  it('street names match whatever the spelling', () => {
    assert.equal(normStreet('VIA ROMA'), 'via roma');
    assert.equal(normStreet('V.le della Libertà'), 'viale della liberta');
    assert.equal(normStreet("C.da Sant'Anna"), 'contrada sant anna');
    assert.equal(normStreet('P.zza Garibaldi'), 'piazza garibaldi');
  });

  it('reads street, number and exponent of a search', () => {
    assert.deepEqual(parseAddress('Via Roma 12, 94100 Enna'), { street: 'via roma', number: 12, exp: '' });
    assert.deepEqual(parseAddress('via roma 12/b enna'), { street: 'via roma', number: 12, exp: 'b' });
    assert.equal(parseAddress('Enna'), null);
  });

  it('pins the geocoder result on the house, only near it and with the same number', () => {
    const a = createAnncsu({ dir: 'unused' });
    a._set({ region: 'SICI', file: 'x', at: '', civics: 3, streets: { 'via roma': [[12, '', 37.567, 14.279], [12, '', 38.1, 13.36], [14, '', 37.5672, 14.2791]] } });
    const street = { label: 'Via Roma, Enna', lat: 37.565, lon: 14.275, type: 'road' };
    const [r] = a.refine([street], 'Via Roma 12, Enna');
    assert.equal(r!.lat, 37.567);
    assert.equal(r!.type, 'anncsu');
    assert.match(r!.label, /civico ANNCSU/);
    // the same street in Palermo is far: not that one; no number: unchanged
    const [far] = a.refine([{ ...street, lat: 38.0, lon: 13.0 }], 'Via Roma 12, Enna');
    assert.equal(far!.type, 'road');
    assert.deepEqual(a.refine([street], 'Via Roma, Enna'), [street]);
    assert.deepEqual(a.refine([street], 'Via Roma 99, Enna'), [street]);
  });
});
