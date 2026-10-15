import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { todayRome } from '../src/routes/work-orders.ts';
import { monthLabel, monthlyDue, monthlyText, prevMonth } from '../src/services/monthly-report.ts';
import { SAMPLE_TEMPLATE, testApp } from './helpers.ts';

const ANDROID = { 'x-cda-client': 'android/9.0.0' };

describe('Report mensile', () => {
  it('knows its months and when it is due', () => {
    assert.equal(prevMonth('2026-01'), '2025-12');
    assert.equal(monthLabel('2026-10'), 'ottobre 2026');
    assert.equal(monthlyDue(new Date('2026-11-01T06:59:00Z')), null, '7:59 in Rome: not yet');
    assert.equal(monthlyDue(new Date('2026-11-01T07:00:00Z')), '2026-10', '8:00 in Rome on the 1st: the month just ended');
    assert.equal(monthlyDue(new Date('2026-11-02T09:00:00Z')), null);
  });

  it('counts installations, tests, work orders and installers of a month, as JSON, PDF and message', async () => {
    const t = await testApp();
    const A = t.auth(await t.login());
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, headers: Record<string, string> = A) => t.app.inject({ method, url, headers, payload });
    await call('POST', '/api/admin/users', { username: 'tecnico', password: 'Installer-Pass-123' });
    await call('POST', '/api/admin/profiles/LiteBeam%205AC/templates', { name: 'Standard', template: SAMPLE_TEMPLATE, boardMatch: 'board\\.name=LiteBeam 5AC' });
    await call('PUT', '/api/admin/wireless-networks/CDA-NET-N2-D01', { wpa2Password: 'test-psk-12345' });
    const T = t.auth(await t.login('tecnico', 'Installer-Pass-123'));
    const users = (await call('GET', '/api/admin/users')).json() as Array<{ id: number; username: string }>;
    const tid = users.find((u) => u.username === 'tecnico')!.id;
    for (const [mac, verdict, signal] of [['AA:BB:CC:00:00:01', 'ok', -58], ['AA:BB:CC:00:00:02', 'warn', -70]] as const) {
      const job = (await call('POST', '/api/provisioning/jobs', { model: 'LiteBeam 5AC', mac, serial: `S${mac.slice(-1)}`, ssid: 'CDA-NET-N2-D01', pppoeUser: `c${mac.slice(-1)}@cda-net.it`, pppoePassword: 'Segreta-PPPoE-1' }, { ...T, ...ANDROID })).json().jobId;
      await call('POST', `/api/provisioning/jobs/${job}/result`, { result: 'success', stages: [] }, T);
      await call('PUT', `/api/provisioning/jobs/${job}/acceptance`, { verdict, measuredAt: new Date().toISOString(), samples: 10, cpe: { model: 'LiteBeam 5AC', firmware: 'WA.v8.7.4', apName: 'N2-D01' }, radio: { signal }, internet: { tested: false }, checks: [], notes: '' }, T);
    }
    const o = (await call('POST', '/api/admin/work-orders', { assignedTo: tid, day: todayRome(), kind: 'repair', customer: 'Rossi' })).json().item;
    await call('POST', `/api/work-orders/${o.id}/status`, { status: 'postponed', note: 'assente' }, T);

    const month = new Date().toISOString().slice(0, 7);
    const r = (await call('GET', `/api/admin/reports/monthly?month=${month}`)).json();
    assert.equal(r.installs.success, 2);
    assert.deepEqual([r.installs.ok, r.installs.warn, r.installs.bad], [1, 1, 0]);
    assert.equal(r.installs.avgSignal, -64);
    assert.equal(r.workOrders.byKind.repair, todayRome().slice(0, 7) === month ? 1 : 0);
    assert.equal(r.installers[0].name, 'tecnico');
    assert.equal(r.installers[0].installs, 2);
    assert.equal(r.installers[0].okPct, 50);
    assert.equal((await call('GET', '/api/admin/reports/monthly?month=2026-13')).statusCode, 400);

    const text = monthlyText(r);
    assert.match(text, /Installazioni: <b>2<\/b>/);
    assert.match(text, /tecnico: 2 installazioni/);

    const pdf = await call('GET', `/api/admin/reports/monthly.pdf?month=${month}`);
    assert.equal(pdf.statusCode, 200);
    assert.equal(pdf.rawPayload.subarray(0, 8).toString('latin1'), '%PDF-1.4');
    assert.match(String(pdf.headers['content-disposition']), new RegExp(`report-cdanet-${month}\\.pdf`));
    assert.equal((await call('GET', `/api/admin/reports/monthly?month=${month}`, undefined, T)).statusCode, 403, 'admins only');
    await t.app.close();
  });
});
