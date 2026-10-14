import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { todayRome } from '../src/routes/work-orders.ts';
import { SAMPLE_TEMPLATE, testApp } from './helpers.ts';

const ANDROID = { 'x-cda-client': 'android/9.0.0' };

describe('Configurazione preparata prima del sopralluogo', () => {
  it('a work order is prepared without MAC and serial; they come with the result, scanned on site', async () => {
    const t = await testApp();
    const A = t.auth(await t.login());
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, headers = A) => t.app.inject({ method, url, headers, payload });
    await call('POST', '/api/admin/users', { username: 'tecnico', password: 'Installer-Pass-123' });
    await call('POST', '/api/admin/profiles/LiteBeam%205AC/templates', { name: 'Standard', template: SAMPLE_TEMPLATE, boardMatch: 'board\\.name=LiteBeam 5AC' });
    await call('PUT', '/api/admin/wireless-networks/CDA-NET-N2-D01', { wpa2Password: 'test-psk-12345' });
    const tid = ((await call('GET', '/api/admin/users')).json() as Array<{ id: number; username: string }>).find((u) => u.username === 'tecnico')!.id;
    const T = { ...t.auth(await t.login('tecnico', 'Installer-Pass-123')), ...ANDROID };
    const order = (await call('POST', '/api/admin/work-orders', {
      assignedTo: tid, day: todayRome(), kind: 'new', customer: 'Rossi Mario', lat: 37.57, lon: 14.28, pppoeUser: 'rossi.mario@cda-net.it', pppoePassword: 'Segreta-PPPoE-1', model: 'LiteBeam 5AC',
    })).json().item;

    const req = { model: 'LiteBeam 5AC', ssid: 'CDA-NET-N2-D01', pppoeUser: 'rossi.mario@cda-net.it', workOrderId: order.id };
    // without a work order the MAC is still required, and MAC and serial go together
    assert.equal((await call('POST', '/api/provisioning/jobs', { ...req, workOrderId: undefined, pppoePassword: 'x' }, T)).statusCode, 400);
    assert.equal((await call('POST', '/api/provisioning/jobs', { ...req, mac: 'AA:BB:CC:00:00:01' }, T)).statusCode, 400);

    const job = await call('POST', '/api/provisioning/jobs', req, T);
    assert.equal(job.statusCode, 201, job.body);
    const pkg = job.json();
    assert.equal(pkg.checks.mac, '', 'the app checks the CPE against the MAC scanned on site');
    assert.equal(pkg.summary.mac, '');
    assert.match(pkg.config.text, /ppp\.1\.password=Segreta-PPPoE-1/);

    // the result must bring the CPE scanned on site, then it is the job's
    const url = `/api/provisioning/jobs/${pkg.jobId}/result`;
    assert.equal((await call('POST', url, { result: 'success', stages: [], detected: {} }, T)).json().error, 'cpe_mac_required');
    assert.equal((await call('POST', url, { result: 'success', stages: [], detected: {}, cpe: { mac: '81:78:00:00:00:01', serial: 'S1' } }, T)).statusCode, 400, 'not a device MAC');
    const ok = await call('POST', url, { result: 'success', stages: [], detected: { mac: 'AA:BB:CC:00:00:01' }, cpe: { mac: 'aabbcc000001', serial: 'SER-1' } }, T);
    assert.equal(ok.statusCode, 200, ok.body);
    const row = (await call('GET', '/api/provisioning/jobs?limit=5', undefined, T)).json().find((j: { id: string }) => j.id === pkg.jobId);
    assert.deepEqual([row.mac, row.serial, row.status], ['AA:BB:CC:00:00:01', 'SER-1', 'success']);
    // the offline queue may send it again: same answer, nothing changes
    assert.equal((await call('POST', url, { result: 'success', stages: [], detected: {}, cpe: { mac: 'AA:BB:CC:00:00:02', serial: 'X' } }, T)).json().duplicate, true);
    assert.equal((await call('GET', '/api/provisioning/jobs?limit=5', undefined, T)).json().find((j: { id: string }) => j.id === pkg.jobId).mac, 'AA:BB:CC:00:00:01');
    await t.app.close();
  });

  it('a template that uses the expected MAC cannot be prepared without it', async () => {
    const t = await testApp();
    const A = t.auth(await t.login());
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, headers = A) => t.app.inject({ method, url, headers, payload });
    await call('POST', '/api/admin/profiles/LiteBeam%205AC/templates', { name: 'Con MAC', template: `${SAMPLE_TEMPLATE}\nsystem.mac.check=\${EXPECTED_MAC}\n`, boardMatch: 'board\\.name=LiteBeam 5AC' });
    await call('PUT', '/api/admin/wireless-networks/CDA-NET-N2-D01', { wpa2Password: 'test-psk-12345' });
    const me = (await call('GET', '/api/auth/me')).json();
    const order = (await call('POST', '/api/admin/work-orders', {
      assignedTo: me.id ?? me.user?.id, day: todayRome(), kind: 'new', customer: 'Rossi', pppoeUser: 'rossi.mario@cda-net.it', pppoePassword: 'p', model: 'LiteBeam 5AC',
    })).json().item;
    const r = await call('POST', '/api/provisioning/jobs', { model: 'LiteBeam 5AC', ssid: 'CDA-NET-N2-D01', pppoeUser: 'rossi.mario@cda-net.it', workOrderId: order.id }, { ...A, ...ANDROID });
    assert.equal(r.json().error, 'template_needs_mac', r.body);
    await t.app.close();
  });
});
