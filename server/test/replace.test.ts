import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { cfgValue, pppoePasswordKey } from '../src/routes/replace.ts';
import { fakeUisp } from './fake-uisp.ts';
import { ADMIN, SAMPLE_TEMPLATE, testConfig } from './helpers.ts';

const ANDROID = { 'x-cda-client': 'android/1.2.0' };

async function setup(withUisp: boolean) {
  const fake = fakeUisp({ backupCfg: 'system.cfg.version=65547\nppp.1.name=rossi.mario@cda-net.it\nppp.1.password=Pppoe-From-Backup\n' });
  const { app } = await buildApp(testConfig(), 'test', { db: openDatabase(':memory:'), logger: false, ...(withUisp ? { uisp: fake.uisp } : {}) });
  const login = async (u: string, p: string) => (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: p } })).json().token as string;
  const admin = await login(ADMIN.username, ADMIN.password);
  const H = (tok: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${tok}`, ...extra });
  await app.inject({ method: 'POST', url: '/api/admin/users', headers: H(admin), payload: { username: 'tecnico', password: 'Installer-Pass-123' } });
  await app.inject({ method: 'POST', url: '/api/admin/profiles/LiteBeam%205AC/templates', headers: H(admin), payload: { name: 'Standard', template: SAMPLE_TEMPLATE, boardMatch: 'board\\.name=LiteBeam 5AC' } });
  await app.inject({ method: 'PUT', url: '/api/admin/wireless-networks/CDA-NET-N2-D01', headers: H(admin), payload: { wpa2Password: 'test-psk-12345' } });
  const tec = await login('tecnico', 'Installer-Pass-123');
  const old = (
    await app.inject({
      method: 'POST',
      url: '/api/provisioning/jobs',
      headers: H(tec, ANDROID),
      payload: {
        model: 'LiteBeam 5AC', mac: 'AA:BB:CC:DD:EE:FF', serial: 'OLD1', ssid: 'CDA-NET-N2-D01', pppoeUser: 'rossi.mario@cda-net.it', pppoePassword: 'Original-Pass',
        location: { latitude: 37.58, longitude: 14.12, accuracy: 5, source: 'gps' },
      },
    })
  ).json();
  return { app, admin, tec, old, H };
}

describe('Sostituzione CPE', () => {
  it('helpers find the PPPoE password key and value', () => {
    assert.equal(pppoePasswordKey(SAMPLE_TEMPLATE), 'ppp.1.password');
    assert.equal(pppoePasswordKey('a=b'), 'ppp.1.password');
    assert.equal(cfgValue('x=1\nppp.1.password=se=cret\n', 'ppp.1.password'), 'se=cret');
    assert.equal(cfgValue('x=1', 'ppp.1.password'), null);
  });

  it('creates a new job with the data of the old one; PPPoE password from the UISP backup', async () => {
    const { app, tec, admin, old, H } = await setup(true);
    const url = `/api/provisioning/jobs/${old.jobId}/replace`;
    const body = { mac: '11:22:33:44:55:66', serial: 'NEW1' };
    assert.equal((await app.inject({ method: 'POST', url, headers: H(tec), payload: body })).json().error, 'trusted_client_required');
    assert.equal((await app.inject({ method: 'POST', url, headers: H(tec, ANDROID), payload: body })).json().error, 'job_not_completed');
    await app.inject({ method: 'POST', url: `/api/provisioning/jobs/${old.jobId}/result`, headers: H(tec), payload: { result: 'success', stages: [], detected: {} } });
    assert.equal((await app.inject({ method: 'POST', url, headers: H(tec, ANDROID), payload: { mac: 'aabbccddeeff', serial: 'X' } })).json().error, 'replace_same_mac');

    const r = await app.inject({ method: 'POST', url, headers: H(tec, ANDROID), payload: body });
    assert.equal(r.statusCode, 201, r.body);
    const pkg = r.json();
    assert.equal(pkg.replacesJobId, old.jobId);
    assert.equal(pkg.summary.mac, '11:22:33:44:55:66');
    assert.equal(pkg.summary.pppoeUser, 'rossi.mario@cda-net.it');
    assert.equal(pkg.summary.ssid, 'CDA-NET-N2-D01');
    assert.equal(pkg.summary.template, 'Standard');
    assert.match(pkg.config.text, /^ppp\.1\.password=Pppoe-From-Backup$/m);
    assert.match(pkg.config.text, /^system\.latitude=37\.580000$/m);

    const hist = (await app.inject({ method: 'GET', url: '/api/provisioning/jobs', headers: H(admin) })).json();
    assert.equal(hist.find((j: { id: string }) => j.id === pkg.jobId).replacesJobId, old.jobId);
    const ev = (await app.inject({ method: 'GET', url: '/api/admin/events', headers: H(admin) })).json();
    const e = ev.find((x: { action: string }) => x.action === 'job.replace');
    assert.match(e.detail, /backup UISP/);
    assert.ok(!JSON.stringify(ev).includes('Pppoe-From-Backup'));

    // a password typed by the installer wins
    const typed = (await app.inject({ method: 'POST', url, headers: H(tec, ANDROID), payload: { mac: '11:22:33:44:55:77', serial: 'NEW2', pppoePassword: 'Typed-Pass' } })).json();
    assert.match(typed.config.text, /^ppp\.1\.password=Typed-Pass$/m);
    await app.close();
  });

  it('asks for the password when UISP cannot provide it', async () => {
    const { app, tec, old, H } = await setup(false);
    await app.inject({ method: 'POST', url: `/api/provisioning/jobs/${old.jobId}/result`, headers: H(tec), payload: { result: 'success', stages: [], detected: {} } });
    const r = await app.inject({ method: 'POST', url: `/api/provisioning/jobs/${old.jobId}/replace`, headers: H(tec, ANDROID), payload: { mac: '11:22:33:44:55:66', serial: 'NEW1' } });
    assert.equal(r.statusCode, 409);
    assert.equal(r.json().error, 'pppoe_password_required');
    await app.close();
  });
});
