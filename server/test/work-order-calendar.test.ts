import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { testApp } from './helpers.ts';

describe('Calendario degli interventi', () => {
  it('a range of days: the installer sees their own, the NOC everyone (or one), cancelled left out', async () => {
    const t = await testApp();
    const A = t.auth(await t.login());
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, headers = A) => t.app.inject({ method, url, headers, payload });
    await call('POST', '/api/admin/users', { username: 'tecnico', password: 'Installer-Pass-123' });
    await call('POST', '/api/admin/users', { username: 'altro', password: 'Installer-Pass-456' });
    const users = (await call('GET', '/api/admin/users')).json() as Array<{ id: number; username: string }>;
    const tid = users.find((u) => u.username === 'tecnico')!.id;
    const oid = users.find((u) => u.username === 'altro')!.id;
    const T = t.auth(await t.login('tecnico', 'Installer-Pass-123'));
    const add = async (assignedTo: number, day: string, customer: string, slot = '') =>
      (await call('POST', '/api/admin/work-orders', { assignedTo, day, slot, kind: 'new', customer, pppoePassword: 'Segreta-1' })).json().item;
    await add(tid, '2026-11-02', 'Rossi', '09:00-11:00');
    await add(tid, '2026-11-02', 'Bianchi', '08:00-09:00');
    await add(tid, '2026-11-20', 'Verdi');
    await add(oid, '2026-11-03', 'Neri');
    await add(tid, '2026-12-15', 'Fuori');
    const cancelled = await add(tid, '2026-11-05', 'Annullato');
    await call('PUT', `/api/admin/work-orders/${cancelled.id}`, { status: 'cancelled' });

    const mine = await call('GET', '/api/work-orders/calendar?from=2026-11-01&to=2026-11-30', undefined, T);
    assert.equal(mine.statusCode, 200, mine.body);
    assert.deepEqual(mine.json().items.map((o: { customer: string }) => o.customer), ['Bianchi', 'Rossi', 'Verdi'], 'by day and slot, only theirs');
    assert.equal(mine.json().installers, undefined, 'installers do not get the list of installers');
    assert.ok(!mine.body.includes('Segreta-1') && !mine.body.includes('ciphertext'), 'never the PPPoE password');
    // an installer cannot look at someone else's calendar
    assert.deepEqual((await call('GET', `/api/work-orders/calendar?from=2026-11-01&to=2026-11-30&user=${oid}`, undefined, T)).json().items.length, 3);

    const all = (await call('GET', '/api/work-orders/calendar?from=2026-11-01&to=2026-11-30')).json();
    assert.deepEqual(all.items.map((o: { customer: string }) => o.customer), ['Bianchi', 'Rossi', 'Neri', 'Verdi']);
    assert.deepEqual(all.installers.map((u: { username: string }) => u.username), ['altro', 'tecnico']);
    const one = (await call('GET', `/api/work-orders/calendar?from=2026-11-01&to=2026-11-30&user=${oid}`)).json();
    assert.deepEqual(one.items.map((o: { customer: string }) => o.customer), ['Neri']);

    assert.equal((await call('GET', '/api/work-orders/calendar?from=2026-11-01&to=2027-02-01')).statusCode, 400, 'at most 62 days');
    assert.equal((await call('GET', '/api/work-orders/calendar?from=2026-11-30&to=2026-11-01')).statusCode, 400);
    await t.app.close();
  });
});
