import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SAMPLE_TEMPLATE, testApp } from './helpers.ts';

describe('Installation statistics', () => {
  it('aggregates per month, installer and model', async () => {
    const t = await testApp();
    const admin = await t.login();
    await t.app.inject({ method: 'POST', url: '/api/admin/users', headers: t.auth(admin), payload: { username: 'tecnico', password: 'Installer-Pass-123' } });
    await t.app.inject({ method: 'POST', url: '/api/admin/profiles/LiteBeam%205AC/templates', headers: t.auth(admin), payload: { name: 'Standard', template: SAMPLE_TEMPLATE, boardMatch: 'board\.name=LiteBeam 5AC' } });
    await t.app.inject({ method: 'PUT', url: '/api/admin/wireless-networks/CDA-NET-N2-D01', headers: t.auth(admin), payload: { wpa2Password: 'test-psk-12345' } });
    const tec = await t.login('tecnico', 'Installer-Pass-123');
    const run = async (mac: string, result: 'success' | 'failed', signal?: number) => {
      const id = (
        await t.app.inject({
          method: 'POST', url: '/api/provisioning/jobs', headers: t.auth(tec, { 'x-cda-client': 'android/1.10.0' }),
          payload: { model: 'LiteBeam 5AC', mac, serial: 'S', ssid: 'CDA-NET-N2-D01', pppoeUser: 'rossi.mario@cda-net.it', pppoePassword: 'x' },
        })
      ).json().jobId;
      await t.app.inject({ method: 'POST', url: `/api/provisioning/jobs/${id}/result`, headers: t.auth(tec), payload: { result, stages: [], detected: {} } });
      if (signal !== undefined) {
        await t.app.inject({
          method: 'PUT', url: `/api/provisioning/jobs/${id}/acceptance`, headers: t.auth(tec),
          payload: { verdict: signal > -70 ? 'ok' : 'warn', measuredAt: new Date().toISOString(), cpe: {}, radio: { signal }, internet: { tested: true, downloadMbps: 90 }, checks: [] },
        });
      }
    };
    await run('AA:00:00:00:00:01', 'success', -60);
    await run('AA:00:00:00:00:02', 'success', -72);
    await run('AA:00:00:00:00:03', 'failed');
    const s = (await t.app.inject({ method: 'GET', url: '/api/admin/stats?months=3', headers: t.auth(admin) })).json();
    assert.equal(s.months.length, 3);
    const cur = s.months[2];
    assert.equal(cur.jobs, 3);
    assert.equal(cur.success, 2);
    assert.equal(cur.failed, 1);
    assert.equal(cur.acceptances, 2);
    assert.equal(cur.acceptOk, 1);
    assert.equal(cur.avgSignal, -66);
    assert.equal(cur.avgDownload, 90);
    assert.equal(s.months[0].jobs, 0);
    assert.equal(s.installers[0].installer, 'tecnico');
    assert.equal(s.installers[0].failed, 1);
    assert.equal(s.models[0].model, 'LiteBeam 5AC');
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/admin/stats', headers: t.auth(tec) })).statusCode, 403);
    await t.app.close();
  });
});
