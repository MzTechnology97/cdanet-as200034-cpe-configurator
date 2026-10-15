import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ourVerdict } from '../src/routes/feasibility.ts';
import { testApp } from './helpers.ts';

describe('Fattibilità per il commerciale', () => {
  it('the best AP decides whether we can serve the address', () => {
    assert.equal(ourVerdict([{ rating: 'improbabile' }, { rating: 'buono' }]), 'yes');
    assert.equal(ourVerdict([{ rating: 'possibile' }, { rating: 'improbabile' }]), 'maybe');
    assert.equal(ourVerdict([{ rating: 'senza stima' }]), 'maybe', 'no estimate: a survey says');
    assert.equal(ourVerdict([{ rating: 'non attivo' }, { rating: 'improbabile' }]), 'no');
    assert.equal(ourVerdict([]), 'no');
  });

  it('admins only; our answer and the other operators together', async () => {
    const t = await testApp();
    const A = t.auth(await t.login());
    const get = (url: string, headers = A) => t.app.inject({ method: 'GET', url, headers });
    assert.equal((await get('/api/admin/feasibility?lat=200&lon=14')).statusCode, 400);
    const r = await get('/api/admin/feasibility?lat=37.5668&lon=14.2808&label=Via%20Demo%201');
    if (r.statusCode === 200) {
      const j = r.json();
      assert.ok(['yes', 'maybe', 'no'].includes(j.ours.verdict));
      assert.equal(j.address, 'Via Demo 1', 'without the other operators: the label given');
      assert.equal(j.operatorsError, 'operators_not_configured');
    } else assert.ok([502, 503].includes(r.statusCode), r.body);
    await t.app.inject({ method: 'POST', url: '/api/admin/users', headers: A, payload: { username: 'tecnico', password: 'Installer-Pass-123' } });
    assert.equal((await get('/api/admin/feasibility?lat=37.5668&lon=14.2808', t.auth(await t.login('tecnico', 'Installer-Pass-123')))).statusCode, 403);
    await t.app.close();
  });
});
