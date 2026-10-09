import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { apState } from '../src/routes/network.ts';
import { fakeUisp } from './fake-uisp.ts';
import { ADMIN, testConfig } from './helpers.ts';

describe('Stato rete', () => {
  it('derives the AP state', () => {
    assert.equal(apState('disconnected', undefined), 'down');
    assert.equal(apState('active', { total: 10, offline: 1 }), 'ok');
    assert.equal(apState('active', { total: 10, offline: 4 }), 'degraded');
    assert.equal(apState('active', { total: 2, offline: 2 }), 'ok', 'too few CPEs to call it a sector problem');
  });

  it('admins see every POP/AP, installers only the assigned ones without positions or sources', async () => {
    const uisp = fakeUisp();
    const { app } = await buildApp(testConfig(), 'test', { db: openDatabase(':memory:'), logger: false, uisp: uisp.uisp, fetchImpl: uisp.fetchImpl });
    const login = async (username: string, password: string) => ({ authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } })).json().token}` });
    const H = await login(ADMIN.username, ADMIN.password);
    const call = (method: 'GET' | 'PUT' | 'POST', url: string, payload?: object, headers = H) => app.inject({ method, url, headers, payload });

    assert.equal((await call('GET', '/api/network/status')).json().error, 'module_disabled', 'off by default');
    await call('POST', '/api/admin/users', { username: 'tecnico', password: 'Installer-Pass-123' });
    const T = await login('tecnico', 'Installer-Pass-123');
    const tid = (await call('GET', '/api/admin/assignments')).json().users.find((u: { username: string }) => u.username === 'tecnico').id;
    // enabled only for this installer (and not for the admin)
    assert.equal((await call('PUT', `/api/admin/users/${tid}/modules`, { network_status: true })).statusCode, 200);
    assert.equal((await call('GET', '/api/network/status')).statusCode, 404);
    const empty = (await call('GET', '/api/network/status', undefined, T)).json();
    assert.deepEqual(empty.pops, []);
    assert.equal(empty.assignedCount, 0);

    await call('PUT', `/api/admin/assignments/${tid}`, { items: [{ key: 'pop:site-n2', name: 'Nodo 2 - Monte' }] });
    const r = await call('GET', '/api/network/status', undefined, T);
    const mine = r.json();
    assert.deepEqual(mine.pops.map((p: { name: string }) => p.name), ['Nodo 2 - Monte']);
    const ap = mine.pops[0].aps[0];
    assert.equal(ap.name, 'AP N2 D01');
    assert.equal(ap.state, 'ok');
    assert.equal(ap.cpe, null, 'customer numbers hidden from installers');
    assert.equal(ap.cpeOffline, 'none');
    assert.ok(!/37\.6|14\.1|Contrada|uisp/i.test(r.body), 'no positions, addresses or data sources');

    await call('PUT', '/api/admin/modules', { network_status: true });
    const all = (await call('GET', '/api/network/status')).json();
    assert.ok(all.pops.length >= 2, 'admins: every POP');
    assert.deepEqual(all.pops.find((p: { id: string }) => p.id === 'site-n2').aps[0].cpe, { total: 1, offline: 0 });
    await app.close();
  });
});
