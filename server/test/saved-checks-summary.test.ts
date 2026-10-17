import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkName, coverageQuery, coverageSummary, feasibilitySummary, NAME_MAX, summaryOf } from '../src/domain/saved-checks.ts';

describe('Verifiche salvate: riepilogo e nome', () => {
  it('a coverage check in a line: the best AP decides', () => {
    const r = {
      aps: [
        { id: 'ap-1', name: 'N20-D06', rating: 'buono', distanceM: 2400, estimate: { signalDbm: -61, eveningMbps: 48 } },
        { id: 'ap-2', name: 'N20-D07', rating: 'possibile', distanceM: 3100, estimate: { signalDbm: -70 } },
      ],
    };
    assert.deepEqual(coverageSummary(r), {
      kind: 'coverage',
      verdict: 'buono',
      title: 'Copertura probabile',
      best: { name: 'N20-D06', rating: 'buono', distanceM: 2400, signalDbm: -61, eveningMbps: 48 },
      aps: 2,
      others: null,
    });
    assert.equal(coverageSummary({ ...r, operators: { best: 'F' } }).others, 'F', 'the other operators kept with the check');
    assert.equal(coverageSummary({ aps: [{ id: 'x', rating: 'senza stima', estimate: null }] }).verdict, 'possibile', 'no estimate: to verify');
    assert.equal(coverageSummary({ aps: [{ id: 'x', name: '', rating: 'improbabile' }] }).best?.name, 'x', 'the id when the AP has no name');
    assert.deepEqual(coverageSummary({ aps: [] }), { kind: 'coverage', verdict: 'none', title: 'Nessun AP utile', best: null, aps: 0, others: null });
    assert.equal(coverageSummary(null).verdict, 'none', 'an answer without APs');
  });

  it('a feasibility check in a line: ours and the best of the others', () => {
    const r = { ours: { verdict: 'maybe', title: 'Da verificare con un sopralluogo', eveningMbps: 35, sticker: 'FWA' }, operators: { best: 'F' } };
    assert.deepEqual(feasibilitySummary(r), { kind: 'feasibility', verdict: 'maybe', title: 'Da verificare con un sopralluogo', eveningMbps: 35, sticker: 'FWA', others: 'F' });
    assert.deepEqual(feasibilitySummary({ ours: { verdict: 'boh' }, operators: null }), { kind: 'feasibility', verdict: 'no', title: 'Non coperto dalla rete CDA Net', eveningMbps: null, sticker: null, others: null });
    assert.equal(summaryOf('feasibility', r).kind, 'feasibility');
    assert.equal(summaryOf('coverage', { aps: [] }).kind, 'coverage');
  });

  it('the name: written, else the customer, else the address, else the coordinates', () => {
    assert.equal(checkName({ name: '  Rossi   Mario  ', customerName: 'ROSSI MARIO', label: 'Via Roma 1', lat: 37.5, lon: 14.2 }), 'Rossi Mario');
    assert.equal(checkName({ name: ' ', customerName: 'ROSSI MARIO', label: 'Via Roma 1', lat: 37.5, lon: 14.2 }), 'ROSSI MARIO');
    assert.equal(checkName({ label: 'Via Roma 1, Enna', lat: 37.5, lon: 14.2 }), 'Via Roma 1, Enna');
    assert.equal(checkName({ lat: 37.566812, lon: 14.27921 }), '37.56681, 14.27921');
    assert.equal(checkName({ name: 'x'.repeat(300), lat: 1, lon: 1 }).length, NAME_MAX);
  });

  it('a saved coverage check runs again the same way', () => {
    assert.equal(coverageQuery(37.5, 14.2, {}), 'lat=37.5&lon=14.2&cpe=auto');
    assert.equal(coverageQuery(37.5, 14.2, { cpe: 'lbe5ac', height: 6, km: 20, limit: 50 }), 'lat=37.5&lon=14.2&limit=50&km=20&height=6&cpe=lbe5ac');
  });
});
