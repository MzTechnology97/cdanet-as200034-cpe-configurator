import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { configDrift } from '../src/domain/drift.ts';
import { fakeUisp } from './fake-uisp.ts';
import { ADMIN, SAMPLE_TEMPLATE, testConfig } from './helpers.ts';

describe('Configuration drift (CPE vs CDA Net template)', () => {
  it('compares values, masks secrets, skips what cannot be compared', () => {
    const tpl = 'wireless.1.ssid=${SSID}\nwpasupplicant.profile.1.network.1.psk=${WPA2_PSK}\nppp.1.password=${PPPOE_PASSWORD}\nradio.1.txpower=12\nhttpd.port=${HTTP_PORT}\n';
    const actual = 'wireless.1.ssid=CDA-NET-N2-D01\nwpasupplicant.profile.1.network.1.psk=changed-psk\nppp.1.password=whatever\nradio.1.txpower=27\nsnmp.location=x\nextra.key=1\n';
    const r = configDrift(tpl, { SSID: 'CDA-NET-N2-D01', WPA2_PSK: 'right-psk', HTTP_PORT: '20080' }, [['snmp.location', 'ROSSI MARIO']], actual);
    assert.equal(r.skipped, 1); // PPPoE password is never kept by CDA Net
    assert.equal(r.extra, 1);
    const byKey = Object.fromEntries(r.items.map((i) => [i.key, i]));
    assert.deepEqual(byKey['radio.1.txpower'], { key: 'radio.1.txpower', kind: 'changed', expected: '12', actual: '27' });
    assert.deepEqual(byKey['wpasupplicant.profile.1.network.1.psk'], { key: 'wpasupplicant.profile.1.network.1.psk', kind: 'secret_changed' });
    assert.equal(byKey['httpd.port']!.kind, 'missing');
    assert.equal(byKey['snmp.location']!.actual, 'x');
    assert.ok(!JSON.stringify(r).includes('right-psk') && !JSON.stringify(r).includes('changed-psk'));
    assert.ok(!byKey['wireless.1.ssid']);
  });

  it('reads the latest UISP backup of the job CPE', async () => {
    const opts: { backupCfg?: string } = {};
    const fake = fakeUisp(opts);
    const { app } = await buildApp(testConfig(), 'test', { db: openDatabase(':memory:'), logger: false, uisp: fake.uisp });
    const tok = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: ADMIN.username, password: ADMIN.password } })).json().token;
    const H = { authorization: `Bearer ${tok}` };
    await app.inject({ method: 'POST', url: '/api/admin/profiles/LiteBeam%205AC/templates', headers: H, payload: { name: 'Standard', template: SAMPLE_TEMPLATE, boardMatch: 'board\\.name=LiteBeam 5AC' } });
    await app.inject({ method: 'PUT', url: '/api/admin/wireless-networks/CDA-NET-N2-D01', headers: H, payload: { wpa2Password: 'test-psk-12345' } });
    const job = (
      await app.inject({
        method: 'POST', url: '/api/provisioning/jobs', headers: { ...H, 'x-cda-client': 'android/1.4.0' },
        payload: { model: 'LiteBeam 5AC', mac: 'AA:BB:CC:DD:EE:FF', serial: 'S', ssid: 'CDA-NET-N2-D01', pppoeUser: 'rossi.mario@cda-net.it', pppoePassword: 'x' },
      })
    ).json();
    const url = `/api/admin/provisioning/jobs/${job.jobId}/uisp/drift`;
    assert.equal((await app.inject({ method: 'GET', url, headers: H })).json().error, 'job_not_completed');
    await app.inject({ method: 'POST', url: `/api/provisioning/jobs/${job.jobId}/result`, headers: H, payload: { result: 'success', stages: [], detected: {} } });

    // the backup is exactly what was applied: no drift
    opts.backupCfg = job.config.text;
    const same = (await app.inject({ method: 'GET', url, headers: H })).json();
    assert.equal(same.items.length, 0, JSON.stringify(same.items));
    assert.ok(same.compared > 10);
    assert.equal(same.backup.id, 'bk2');

    // someone changed the PPPoE user, the WPA2 key and switched SNMP off
    opts.backupCfg = job.config.text
      .replace('ppp.1.name=rossi.mario@cda-net.it', 'ppp.1.name=altro@cda-net.it')
      .replace('psk=test-psk-12345', 'psk=other-psk')
      .replace('snmp.status=enabled', 'snmp.status=disabled');
    const changed = (await app.inject({ method: 'GET', url, headers: H })).json();
    const keys = changed.items.map((i: { key: string; kind: string }) => `${i.key}:${i.kind}`).sort();
    assert.deepEqual(keys, ['ppp.1.name:changed', 'snmp.status:changed', 'wpasupplicant.profile.1.network.1.psk:secret_changed']);
    assert.ok(!JSON.stringify(changed).includes('test-psk-12345') && !JSON.stringify(changed).includes('other-psk'));
    await app.close();
  });
});
