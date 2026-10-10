import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { todayRome } from '../src/routes/work-orders.ts';
import { SAMPLE_TEMPLATE, testApp } from './helpers.ts';

const ANDROID = { 'x-cda-client': 'android/9.0.0' };

describe('Agenda interventi', () => {
  it('local day in Italy', () => {
    assert.equal(todayRome(new Date('2026-10-09T22:30:00Z')), '2026-10-10', 'past midnight in Rome');
    assert.equal(todayRome(new Date('2026-10-09T10:00:00Z')), '2026-10-09');
  });

  it('office plans, installer starts from the order without typing the PPPoE password, success closes it', async () => {
    const t = await testApp();
    const admin = await t.login();
    const A = t.auth(admin);
    const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object, headers = A) => t.app.inject({ method, url, headers, payload });
    await call('POST', '/api/admin/users', { username: 'tecnico', password: 'Installer-Pass-123' });
    await call('POST', '/api/admin/users', { username: 'altro', password: 'Installer-Pass-456' });
    await call('POST', '/api/admin/profiles/LiteBeam%205AC/templates', { name: 'Standard', template: SAMPLE_TEMPLATE, boardMatch: 'board\\.name=LiteBeam 5AC' });
    await call('PUT', '/api/admin/wireless-networks/CDA-NET-N2-D01', { wpa2Password: 'test-psk-12345' });
    const users = (await call('GET', '/api/admin/users')).json() as Array<{ id: number; username: string }>;
    const tid = users.find((u) => u.username === 'tecnico')!.id;
    const T = t.auth(await t.login('tecnico', 'Installer-Pass-123'));
    const O = t.auth(await t.login('altro', 'Installer-Pass-456'));
    const today = todayRome();

    // the office creates the order with the customer's PPPoE credentials
    const created = await call('POST', '/api/admin/work-orders', {
      assignedTo: tid, day: today, slot: '09:00-11:00', kind: 'new', customer: 'Rossi Mario', address: 'Via Roma 1, Enna',
      lat: 37.57, lon: 14.28, contact: '333 0000000', pppoeUser: 'rossi.mario@cda-net.it', pppoePassword: 'Segreta-PPPoE-1', model: 'LiteBeam 5AC', notes: 'Cancello verde',
    });
    assert.equal(created.statusCode, 201, created.body);
    const order = created.json().item;
    assert.equal(order.hasPassword, true);
    assert.ok(!created.body.includes('Segreta-PPPoE-1') && !('ciphertext' in order), 'the password never leaves the server');
    assert.equal((await call('POST', '/api/admin/work-orders', { assignedTo: tid, day: today, customer: 'X', lat: 37 })).statusCode, 400, 'lat without lon');
    assert.equal((await call('POST', '/api/admin/work-orders', { assignedTo: 9999, day: today, customer: 'Nessuno' })).statusCode, 400);

    // the installer sees it in "Oggi", the other installer does not
    const mine = (await call('GET', '/api/work-orders', undefined, T)).json();
    assert.deepEqual(mine.items.map((x: { customer: string }) => x.customer), ['Rossi Mario']);
    assert.equal(mine.items[0].kindLabel, 'Nuova installazione');
    assert.equal((await call('GET', '/api/work-orders', undefined, O)).json().items.length, 0);
    assert.equal((await call('GET', '/api/admin/work-orders', undefined, T)).statusCode, 403);
    assert.equal((await call('POST', `/api/work-orders/${order.id}/status`, { status: 'started' }, O)).statusCode, 404, 'not theirs');

    // provisioning from the order: no password in the request, the rendered config has it
    const req = { model: 'LiteBeam 5AC', mac: 'AA:BB:CC:00:00:01', serial: 'S1', ssid: 'CDA-NET-N2-D01', pppoeUser: 'rossi.mario@cda-net.it', workOrderId: order.id };
    assert.equal((await call('POST', '/api/provisioning/jobs', { ...req, workOrderId: undefined }, { ...T, ...ANDROID })).statusCode, 400, 'password required without an order');
    assert.equal((await call('POST', '/api/provisioning/jobs', req, { ...O, ...ANDROID })).statusCode, 404, 'order of another installer');
    const plan = await call('POST', '/api/provisioning/plan', req, T);
    assert.equal(plan.statusCode, 200, plan.body);
    const job = await call('POST', '/api/provisioning/jobs', req, { ...T, ...ANDROID });
    assert.equal(job.statusCode, 201, job.body);
    assert.match(job.json().config.text, /ppp\.1\.password=Segreta-PPPoE-1/);
    assert.equal((await call('GET', '/api/work-orders', undefined, T)).json().items[0].status, 'started');

    // a successful write closes the order and links the job
    const jobId = job.json().jobId;
    await call('POST', `/api/provisioning/jobs/${jobId}/result`, { result: 'success', stages: [], detected: {} }, T);
    const done = (await call('GET', '/api/admin/work-orders')).json().items[0];
    assert.deepEqual([done.status, done.jobId], ['done', jobId]);
    assert.equal((await call('POST', '/api/provisioning/jobs', req, { ...T, ...ANDROID })).json().error, 'work_order_closed');

    // the acceptance test of an order is refused far from the order's position (also from the offline queue)
    const test = { verdict: 'ok', measuredAt: new Date().toISOString(), samples: 1, cpe: {}, radio: {}, internet: { tested: false }, checks: [] };
    const far = await call('PUT', `/api/provisioning/jobs/${jobId}/acceptance`, { ...test, position: { lat: 37.7, lon: 14.28, accuracyM: 5 } }, T);
    assert.equal(far.statusCode, 422, far.body);
    assert.equal(far.json().error, 'acceptance_position_mismatch');
    const near = await call('PUT', `/api/provisioning/jobs/${jobId}/acceptance`, { ...test, position: { lat: 37.5715, lon: 14.2805, accuracyM: 5 } }, T);
    assert.equal(near.statusCode, 200, near.body);
    assert.equal((await call('GET', `/api/provisioning/jobs/${jobId}/acceptance`, undefined, T)).json().acceptance.position, undefined, 'the position is not stored in the report');
    assert.equal((await call('PUT', `/api/provisioning/jobs/${jobId}/acceptance`, test, T)).statusCode, 200, 'older apps send no position');

    // postpone / edit / delete
    const o2 = (await call('POST', '/api/admin/work-orders', { assignedTo: tid, day: '2026-01-01', customer: 'Bianchi', kind: 'repair' })).json().item;
    assert.equal(o2.overdue, true, 'open order of a past day');
    assert.ok((await call('GET', '/api/work-orders', undefined, T)).json().items.some((x: { id: number }) => x.id === o2.id), 'overdue orders stay in Oggi');
    const post = (await call('POST', `/api/work-orders/${o2.id}/status`, { status: 'postponed', note: 'Cliente assente' }, T)).json().item;
    assert.deepEqual([post.status, post.statusNote], ['postponed', 'Cliente assente']);
    const edited = (await call('PUT', `/api/admin/work-orders/${o2.id}`, { day: today, pppoePassword: 'Nuova-1', status: 'open' })).json().item;
    assert.deepEqual([edited.day, edited.hasPassword, edited.status], [today, true, 'open']);
    assert.equal((await call('PUT', `/api/admin/work-orders/${o2.id}`, { pppoePassword: '' })).json().item.hasPassword, false);
    assert.equal((await call('DELETE', `/api/admin/work-orders/${o2.id}`)).statusCode, 200);
    assert.equal((await call('PUT', `/api/admin/work-orders/${o2.id}`, { notes: 'x' })).statusCode, 404, 'deleted: never used');
    await call('DELETE', `/api/admin/work-orders/${order.id}`);
    assert.equal((await call('GET', '/api/admin/work-orders')).json().items[0].status, 'cancelled', 'kept with its installation');

    // module off: hidden everywhere
    await call('PUT', '/api/admin/modules', { work_orders: false });
    assert.equal((await call('GET', '/api/work-orders', undefined, T)).statusCode, 404);
    await t.app.close();
  });
});
