import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { fakeUisp } from './fake-uisp.ts';
import { ADMIN, SAMPLE_TEMPLATE, testConfig } from './helpers.ts';

const ANDROID = { 'x-cda-client': 'android/1.2.0' };

describe('Magazzino: CPE smontate (RMA) e minimo per installatore', () => {
  it('a replacement puts the old CPE to bring back; the installer says how it is, the NOC follows it', async () => {
    const fake = fakeUisp({ backupCfg: 'system.cfg.version=65547\nppp.1.name=rossi.mario@cda-net.it\nppp.1.password=Pppoe-From-Backup\n' });
    const db = openDatabase(':memory:');
    const { app } = await buildApp(testConfig(), 'test', { db, logger: false, uisp: fake.uisp });
    const login = async (u: string, p: string) => ({ authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: p } })).json().token}` });
    const A = await login(ADMIN.username, ADMIN.password);
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, headers: Record<string, string> = A) => app.inject({ method, url, headers, payload });
    await call('POST', '/api/admin/users', { username: 'tecnico', password: 'Installer-Pass-123' });
    await call('POST', '/api/admin/users', { username: 'altro', password: 'Installer-Pass-456' });
    await call('POST', '/api/admin/profiles/LiteBeam%205AC/templates', { name: 'Standard', template: SAMPLE_TEMPLATE, boardMatch: 'board\\.name=LiteBeam 5AC' });
    await call('PUT', '/api/admin/wireless-networks/CDA-NET-N2-D01', { wpa2Password: 'test-psk-12345' });
    const T = await login('tecnico', 'Installer-Pass-123');
    const O = await login('altro', 'Installer-Pass-456');
    const old = (await call('POST', '/api/provisioning/jobs', { model: 'LiteBeam 5AC', mac: 'AA:BB:CC:DD:EE:FF', serial: 'OLD1', ssid: 'CDA-NET-N2-D01', pppoeUser: 'rossi.mario@cda-net.it', pppoePassword: 'Original-Pass' }, { ...T, ...ANDROID })).json();
    await call('POST', `/api/provisioning/jobs/${old.jobId}/result`, { result: 'success', stages: [], detected: {} }, T);
    assert.equal((await call('GET', '/api/admin/rma?state=all')).json().items.length, 0, 'a new installation takes nothing off');

    const pkg = (await call('POST', `/api/provisioning/jobs/${old.jobId}/replace`, { mac: '12:22:33:44:55:66', serial: 'NEW1' }, { ...T, ...ANDROID })).json();
    assert.equal((await call('GET', '/api/admin/rma')).json().items.length, 0, 'not before the new CPE is written');
    await call('POST', `/api/provisioning/jobs/${pkg.jobId}/result`, { result: 'success', stages: [], detected: {} }, T);
    await call('POST', `/api/provisioning/jobs/${pkg.jobId}/result`, { result: 'success', stages: [], detected: {} }, T);
    const list = (await call('GET', '/api/admin/rma')).json();
    assert.equal(list.items.length, 1, 'once, even if the result is sent twice');
    const rma = list.items[0];
    assert.deepEqual([rma.mac, rma.state, rma.condition, rma.removedBy], ['AA:BB:CC:DD:EE:FF', 'to_return', 'unknown', 'tecnico']);

    // the installer: what they have to bring back, and how the CPE is
    assert.equal((await call('GET', '/api/field/rma', undefined, T)).json().items.length, 1);
    assert.equal((await call('POST', '/api/field/rma', { jobId: pkg.jobId, condition: 'broken', note: 'alimentatore bruciato' }, O)).statusCode, 403, 'not someone else');
    assert.equal((await call('POST', '/api/field/rma', { jobId: pkg.jobId, condition: 'broken', note: 'alimentatore bruciato' }, T)).statusCode, 200);
    // the NOC: back in the warehouse, then to repair
    const put = await call('PUT', `/api/admin/rma/${rma.id}`, { state: 'repair', note: 'inviata in assistenza' });
    assert.equal(put.statusCode, 200, put.body);
    assert.deepEqual([put.json().state, put.json().condition, put.json().note], ['repair', 'broken', 'inviata in assistenza']);
    assert.equal((await call('GET', '/api/field/rma', undefined, T)).json().items.length, 0, 'no longer to bring back');
    assert.equal((await call('GET', '/api/admin/rma')).json().items.length, 1, 'in repair is still open');
    await call('PUT', `/api/admin/rma/${rma.id}`, { state: 'reused' });
    assert.equal((await call('GET', '/api/admin/rma')).json().items.length, 0);
    assert.equal((await call('GET', '/api/admin/rma?state=all')).json().counts.reused, 1);
    assert.equal((await call('GET', '/api/admin/rma', undefined, T)).statusCode, 403);

    // an account's own minimum
    const users = (await call('GET', '/api/admin/users')).json() as Array<{ id: number; username: string }>;
    const tid = users.find((u) => u.username === 'tecnico')!.id;
    assert.equal((await call('PUT', `/api/admin/users/${tid}/min-stock`, { min: 5 })).json().min, 5);
    assert.equal((db.prepare('SELECT warehouse_min_stock m FROM users WHERE id = ?').get(tid) as { m: number }).m, 5);
    assert.equal((await call('PUT', `/api/admin/users/${tid}/min-stock`, { min: null })).json().defaultMin, 2);
    const ev = db.prepare("SELECT action FROM events WHERE action LIKE 'rma.%' OR action = 'warehouse.min_stock'").all() as Array<{ action: string }>;
    assert.deepEqual(ev.map((e) => e.action), ['rma.condition', 'rma.update', 'rma.update', 'warehouse.min_stock', 'warehouse.min_stock']);
    await app.close();
  });
});
