import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SAMPLE_TEMPLATE, testApp } from './helpers.ts';

const ANDROID = { 'x-cda-client': 'android/1.28.0' };

describe('Installazione guidata: cambio AP e CPE già installate', () => {
  it('gives the WPA2 key of the new AP only to the app, finds the CPE job by MAC, accepts re-tests of assigned CPEs', async () => {
    const t = await testApp();
    const admin = await t.login();
    const H = t.auth(admin);
    await t.app.inject({ method: 'POST', url: '/api/admin/users', headers: H, payload: { username: 'tecnico', password: 'Installer-Pass-123' } });
    await t.app.inject({ method: 'POST', url: '/api/admin/users', headers: H, payload: { username: 'altro', password: 'Installer-Pass-456' } });
    await t.app.inject({ method: 'POST', url: '/api/admin/profiles/LiteBeam%205AC/templates', headers: H, payload: { name: 'Standard', template: SAMPLE_TEMPLATE, boardMatch: 'board\\.name=LiteBeam 5AC' } });
    await t.app.inject({ method: 'PUT', url: '/api/admin/wireless-networks/CDA-NET-N2-D01', headers: H, payload: { wpa2Password: 'test-psk-12345' } });
    await t.app.inject({ method: 'PUT', url: '/api/admin/wireless-networks/CDA-NET-N3-D02', headers: H, payload: { wpa2Password: 'altra-chiave-678' } });
    const tec = await t.login('tecnico', 'Installer-Pass-123');
    const other = await t.login('altro', 'Installer-Pass-456');

    // relink: Android app only, CDA Net SSIDs with a configured key, audited without the key
    const relink = (tok: string, payload: object, headers: Record<string, string> = ANDROID) =>
      t.app.inject({ method: 'POST', url: '/api/field/relink', headers: t.auth(tok, headers), payload });
    assert.equal((await relink(tec, { ssid: 'CDA-NET-N3-D02' }, {})).statusCode, 403);
    assert.equal((await relink(tec, { ssid: 'Rete-Qualsiasi' })).statusCode, 400);
    assert.equal((await relink(tec, { ssid: 'CDA-NET-N9-D09' })).json().error, 'ssid_secret_not_configured');
    const r = await relink(tec, { ssid: 'CDA-NET-N3-D02', mac: 'aa-bb-cc-dd-ee-ff', from: 'CDA-NET-N2-D01' });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().psk, 'altra-chiave-678');
    assert.equal(typeof r.json().sshPort, 'number');
    assert.equal(r.headers['cache-control'], 'no-store');
    const log = JSON.stringify((await t.app.inject({ method: 'GET', url: '/api/admin/events', headers: H })).json());
    assert.ok(log.includes('field.relink') && log.includes('CDA-NET-N2-D01 → CDA-NET-N3-D02') && !log.includes('altra-chiave-678'));

    // the CPE found on the roof: its installation job, by any of its MACs
    const job = (
      await t.app.inject({
        method: 'POST',
        url: '/api/provisioning/jobs',
        headers: t.auth(tec, ANDROID),
        payload: { model: 'LiteBeam 5AC', mac: 'AABBCCDDEEFF', serial: 'S1', ssid: 'CDA-NET-N2-D01', pppoeUser: 'rossi.mario@cda-net.it', pppoePassword: 'x' },
      })
    ).json();
    const lookup = (tok: string, macs: string) => t.app.inject({ method: 'GET', url: `/api/field/cpe?macs=${encodeURIComponent(macs)}`, headers: t.auth(tok) });
    assert.equal((await lookup(tec, 'AA:BB:CC:DD:EE:FF')).json().job, null, 'not until the provisioning succeeded');
    await t.app.inject({ method: 'POST', url: `/api/provisioning/jobs/${job.jobId}/result`, headers: t.auth(tec), payload: { result: 'success', stages: ['ok'], detected: {} } });
    const found = (await lookup(tec, '11:22:33:44:55:66,aabb.ccdd.eeff')).json().job;
    assert.equal(found.id, job.jobId);
    assert.equal(found.deviceName, 'ROSSI MARIO');
    assert.equal((await lookup(other, 'AABBCCDDEEFF')).json().job, null, 'other installers do not see it');
    assert.equal((await lookup(admin, 'AABBCCDDEEFF')).json().job.id, job.jobId);
    assert.equal((await lookup(tec, 'nonunmac')).statusCode, 400);

    // assigned to another installer: lookup and new acceptance test allowed
    // (same row the Salute CPE assignment writes)
    const otherId = (t.db.prepare("SELECT id FROM users WHERE username = 'altro'").get() as { id: number }).id;
    t.db.prepare("INSERT INTO cpe_assignments(mac, user_id, name, assigned_at) VALUES('AA:BB:CC:DD:EE:FF', ?, '', '2026-10-09T00:00:00Z')").run(otherId);
    assert.equal((await lookup(other, 'AABBCCDDEEFF')).json().job.id, job.jobId);
    const acc = {
      verdict: 'ok',
      measuredAt: new Date().toISOString(),
      samples: 10,
      cpe: { essid: 'CDA-NET-N3-D02' },
      radio: { signal: -60 },
      internet: { tested: false, note: 'Non misurato' },
      checks: [],
    };
    const put = await t.app.inject({ method: 'PUT', url: `/api/provisioning/jobs/${job.jobId}/acceptance`, headers: t.auth(other), payload: acc });
    assert.equal(put.statusCode, 200, put.body);
    await t.app.close();
  });
});
