import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SAMPLE_TEMPLATE, testApp } from './helpers.ts';

const ANDROID = { 'x-cda-client': 'android/9.0.0' };

describe('Cancellazione dei tentativi di installazione (NOC)', () => {
  it('the NOC deletes attempts that never installed a CPE, never an installed one', async () => {
    const t = await testApp();
    const A = t.auth(await t.login());
    const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object, headers = A) => t.app.inject({ method, url, headers, payload });
    await call('POST', '/api/admin/users', { username: 'tecnico', password: 'Installer-Pass-123' });
    await call('POST', '/api/admin/profiles/LiteBeam%205AC/templates', { name: 'Standard', template: SAMPLE_TEMPLATE, boardMatch: 'board\\.name=LiteBeam 5AC' });
    await call('PUT', '/api/admin/wireless-networks/CDA-NET-N2-D01', { wpa2Password: 'test-psk-12345' });
    const T = { ...t.auth(await t.login('tecnico', 'Installer-Pass-123')), ...ANDROID };
    const req = (mac: string) => ({ model: 'LiteBeam 5AC', mac, serial: 'S1', ssid: 'CDA-NET-N2-D01', pppoeUser: 'rossi.mario@cda-net.it', pppoePassword: 'x' });
    const failed = (await call('POST', '/api/provisioning/jobs', req('AA:BB:CC:00:00:01'), T)).json().jobId;
    await call('POST', `/api/provisioning/jobs/${failed}/result`, { result: 'failed', stages: [], error: 'prova' }, T);
    // "Modifica e riprova": the new one supersedes the failed one
    const redo = (await call('POST', '/api/provisioning/jobs', { ...req('AA:BB:CC:00:00:02'), supersedes: failed }, T)).json().jobId;
    const installed = (await call('POST', '/api/provisioning/jobs', req('AA:BB:CC:00:00:03'), T)).json().jobId;
    await call('POST', `/api/provisioning/jobs/${installed}/result`, { result: 'success', stages: [] }, T);

    assert.equal((await call('DELETE', `/api/admin/provisioning/jobs/${failed}`, undefined, T)).statusCode, 403, 'installers cannot');
    assert.equal((await call('DELETE', `/api/admin/provisioning/jobs/${installed}`)).json().error, 'job_installed');
    assert.equal((await call('DELETE', `/api/admin/provisioning/jobs/${failed}`)).statusCode, 200);
    assert.equal((await call('DELETE', `/api/admin/provisioning/jobs/${failed}`)).statusCode, 404);
    const left = (await call('GET', '/api/provisioning/jobs?limit=10')).json() as Array<{ id: string }>;
    assert.deepEqual(left.map((j) => j.id).sort(), [redo, installed].sort());
    // the prepared one (never written) goes too; the log keeps who deleted what
    assert.equal((await call('DELETE', `/api/admin/provisioning/jobs/${redo}`)).statusCode, 200);
    const events = (await call('GET', '/api/admin/events?limit=20')).json();
    const list = (Array.isArray(events) ? events : events.items) as Array<{ action: string }>;
    assert.equal(list.filter((e) => e.action === 'job.delete').length, 2);
    await t.app.close();
  });
});
