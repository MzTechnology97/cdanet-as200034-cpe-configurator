import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { hashPassword } from '../src/crypto.ts';
import { migrate } from '../src/db.ts';
import { syncFromGithub } from '../src/services/releases.ts';
import { SAMPLE_TEMPLATE, testApp, testConfig } from './helpers.ts';

const REQUEST = {
  model: 'LiteBeam 5AC',
  mac: 'aabbccddeeff', // typed without separators, stored as AA:BB:CC:DD:EE:FF
  serial: 'SN123',
  ssid: 'CDA-NET-N2-D01',
  pppoeUser: 'rossi.mario@cda-net.it',
  pppoePassword: 'pppoe-transient',
};
const ANDROID = { 'x-cda-client': 'android/1.0.0' };

describe('API', () => {
  let t: Awaited<ReturnType<typeof testApp>>;
  let adminToken: string;
  let installerToken: string;

  before(async () => {
    t = await testApp();
    adminToken = await t.login();
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/admin/users',
      headers: t.auth(adminToken),
      payload: { username: 'tecnico1', password: 'Installer-Password-1' },
    });
    assert.equal(r.statusCode, 201);
    installerToken = await t.login('tecnico1', 'Installer-Password-1');
  });
  after(() => t.app.close());

  it('reports health and security headers', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(r.statusCode, 200);
    assert.equal(r.json().version, '1.0.0-test');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
    assert.equal(r.headers['cache-control'], 'no-store');
  });

  it('rejects bad credentials and rate-limits', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'nobody', password: 'wrong-password' } });
      assert.equal(r.statusCode, 401);
    }
    const r = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'nobody', password: 'wrong-password' } });
    assert.equal(r.statusCode, 429);
  });

  it('enforces roles', async () => {
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/admin/users' })).statusCode, 401);
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/admin/users', headers: t.auth(installerToken) })).statusCode, 403);
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/meta', headers: t.auth(installerToken) })).statusCode, 200);
  });

  it('plan reports missing configuration without leaking secrets', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/api/provisioning/plan', headers: t.auth(installerToken), payload: REQUEST });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.deepEqual(body.readiness.missing, ['ssid_secret_not_configured', 'provision_profile_missing']);
    assert.ok(!r.body.includes('pppoe-transient'));
    const job = await t.app.inject({ method: 'POST', url: '/api/provisioning/jobs', headers: t.auth(installerToken, ANDROID), payload: REQUEST });
    assert.equal(job.statusCode, 409);
  });

  it('admin configures WPA2 and a profile (VLAN profile rejected)', async () => {
    const w = await t.app.inject({
      method: 'PUT',
      url: '/api/admin/wireless-networks/CDA-NET-N2-D01',
      headers: t.auth(adminToken),
      payload: { wpa2Password: 'node2-district1-psk' },
    });
    assert.equal(w.statusCode, 200);

    const vlan = await t.app.inject({
      method: 'PUT',
      url: '/api/admin/profiles/LiteBeam%205AC',
      headers: t.auth(adminToken),
      payload: { template: `${SAMPLE_TEMPLATE}vlan.1.id=87\n`, boardMatch: 'board.name=LiteBeam 5AC' },
    });
    assert.equal(vlan.statusCode, 400);
    assert.equal(vlan.json().error, 'profile_contains_vlan');

    const badRx = await t.app.inject({
      method: 'PUT',
      url: '/api/admin/profiles/LiteBeam%205AC',
      headers: t.auth(adminToken),
      payload: { template: SAMPLE_TEMPLATE, boardMatch: '(unclosed' },
    });
    assert.equal(badRx.json().error, 'board_match_invalid_regex');

    const ok = await t.app.inject({
      method: 'PUT',
      url: '/api/admin/profiles/LiteBeam%205AC',
      headers: t.auth(adminToken),
      payload: { template: SAMPLE_TEMPLATE, boardMatch: 'board\\.name=LiteBeam 5AC' },
    });
    assert.equal(ok.statusCode, 200, ok.body);

    const list = (await t.app.inject({ method: 'GET', url: '/api/admin/profiles', headers: t.auth(adminToken) })).json();
    assert.equal(list.length, 5);
    assert.ok(list.find((p: { model: string; profile: unknown }) => p.model === 'LiteBeam 5AC').profile);
    assert.ok(!JSON.stringify(list).includes('wireless.1.ssid'));
  });

  it('job creation requires the Android client header and a current version', async () => {
    const noClient = await t.app.inject({ method: 'POST', url: '/api/provisioning/jobs', headers: t.auth(installerToken), payload: REQUEST });
    assert.equal(noClient.statusCode, 403);
    const old = await t.app.inject({
      method: 'POST',
      url: '/api/provisioning/jobs',
      headers: t.auth(installerToken, { 'x-cda-client': 'android/0.9.0' }),
      payload: REQUEST,
    });
    assert.equal(old.statusCode, 426);
  });

  let jobId = '';
  it('creates a job with a fully rendered system.cfg', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/api/provisioning/jobs', headers: t.auth(installerToken, ANDROID), payload: REQUEST });
    assert.equal(r.statusCode, 201, r.body);
    const p = r.json();
    jobId = p.jobId;
    assert.equal(p.target.host, '192.168.172.1');
    assert.equal(p.checks.firmware, '8.7.4');
    assert.equal(p.checks.mac, 'AA:BB:CC:DD:EE:FF');
    assert.equal(p.credentials.password, 'Cpe-Admin-Secret-1');
    const text: string = p.config.text;
    assert.equal(createHash('sha256').update(text).digest('hex'), p.config.sha256);
    assert.match(text, /^wpasupplicant\.profile\.1\.network\.1\.psk=node2-district1-psk$/m);
    assert.match(text, /^ppp\.1\.password=pppoe-transient$/m);
    assert.match(text, /^users\.1\.password=\$1\$[^$]{8}\$/m);
    assert.match(text, /^snmp\.location=ROSSI MARIO$/m);
    assert.match(text, /^pwdog\.host=8\.8\.8\.8$/m);
    assert.match(text, /^system\.eirp\.status=disabled$/m);
    assert.match(text, /^radio\.1\.atpc\.sta\.status=enabled$/m);
    assert.match(text, /^resolv\.host\.1\.name=ROSSI MARIO$/m);
    assert.match(text, /^httpd\.https\.port=20443$/m);
    assert.equal(r.headers['cache-control'], 'no-store');
  });

  it('records results idempotently and keeps the history redacted', async () => {
    const payload = { result: 'success', stages: ['SSH', 'cfgmtd'], detected: { firmware: 'XC.qca956x.v8.7.4', mac: 'AA:BB:CC:DD:EE:FF' } };
    const r1 = await t.app.inject({ method: 'POST', url: `/api/provisioning/jobs/${jobId}/result`, headers: t.auth(installerToken), payload });
    assert.deepEqual(r1.json(), { ok: true, duplicate: false });
    const r2 = await t.app.inject({ method: 'POST', url: `/api/provisioning/jobs/${jobId}/result`, headers: t.auth(installerToken), payload });
    assert.deepEqual(r2.json(), { ok: true, duplicate: true });
    const conflict = await t.app.inject({
      method: 'POST',
      url: `/api/provisioning/jobs/${jobId}/result`,
      headers: t.auth(installerToken),
      payload: { ...payload, result: 'failed' },
    });
    assert.equal(conflict.statusCode, 409);

    const list = await t.app.inject({ method: 'GET', url: '/api/provisioning/jobs', headers: t.auth(adminToken) });
    const jobs = list.json();
    const byCompactMac = (await t.app.inject({ method: 'GET', url: '/api/provisioning/jobs?q=AABBCCDD', headers: t.auth(adminToken) })).json();
    assert.ok(byCompactMac.some((j: { mac: string }) => j.mac === 'AA:BB:CC:DD:EE:FF'));
    assert.equal(jobs[0].status, 'success');
    assert.equal(jobs[0].installer, 'tecnico1');
    for (const secret of ['pppoe-transient', 'node2-district1-psk', 'Cpe-Admin-Secret-1']) assert.ok(!list.body.includes(secret));
  });

  it('sanitizes client error text', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/api/provisioning/jobs', headers: t.auth(installerToken, ANDROID), payload: REQUEST });
    const id = r.json().jobId;
    await t.app.inject({
      method: 'POST',
      url: `/api/provisioning/jobs/${id}/result`,
      headers: t.auth(installerToken),
      payload: { result: 'failed', error: 'auth failed password=hunter2\nline2' },
    });
    const jobs = (await t.app.inject({ method: 'GET', url: '/api/provisioning/jobs?status=failed', headers: t.auth(installerToken) })).json();
    assert.equal(jobs[0].error, 'auth failed password=*** line2');
  });

  it('disabling an installer revokes the session immediately', async () => {
    const users = (await t.app.inject({ method: 'GET', url: '/api/admin/users', headers: t.auth(adminToken) })).json();
    const id = users.find((u: { username: string }) => u.username === 'tecnico1').id;
    const r = await t.app.inject({ method: 'PATCH', url: `/api/admin/users/${id}`, headers: t.auth(adminToken), payload: { active: false } });
    assert.equal(r.statusCode, 200);
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: t.auth(installerToken) })).statusCode, 401);
    const self = users.find((u: { username: string }) => u.username === 'admintest').id;
    const last = await t.app.inject({ method: 'PATCH', url: `/api/admin/users/${self}`, headers: t.auth(adminToken), payload: { active: false } });
    assert.equal(last.statusCode, 409);
  });

  it('serves the Android release channel', async () => {
    const dir = t.cfg.releases.dir;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'CDA-Net-CPE-1.0.1.apk'), 'fake-apk');
    const sha = createHash('sha256').update('fake-apk').digest('hex');
    writeFileSync(join(dir, 'latest.json'), JSON.stringify({ versionCode: 10001, versionName: '1.0.1', sha256: sha, fileName: 'CDA-Net-CPE-1.0.1.apk' }));
    const meta = (await t.app.inject({ method: 'GET', url: '/api/mobile/update' })).json();
    assert.equal(meta.available, true);
    assert.equal(meta.versionCode, 10001);
    const apk = await t.app.inject({ method: 'GET', url: '/api/mobile/apk' });
    assert.equal(apk.body, 'fake-apk');
    assert.equal(apk.headers['x-content-sha256'], sha);
  });
});

describe('legacy v0.5.x database', () => {
  it('migrates audits into provisioning jobs and keeps accounts', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,username TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN('admin','installer')),active INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL);
      CREATE TABLE audits(id INTEGER PRIMARY KEY,created_at TEXT NOT NULL,user_id INTEGER NOT NULL,ssid TEXT NOT NULL,pppoe_user TEXT NOT NULL,model TEXT NOT NULL,mac TEXT NOT NULL,serial TEXT NOT NULL,result TEXT NOT NULL);
      CREATE TABLE wireless_secrets(ssid TEXT PRIMARY KEY,wpa2_ciphertext TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE provision_profiles(model TEXT NOT NULL,firmware TEXT NOT NULL,board_match TEXT NOT NULL DEFAULT '',template_ciphertext TEXT NOT NULL,template_sha256 TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(model,firmware));`);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO users(username,password_hash,role,created_at) VALUES('oldadmin',?,'admin',?)").run(hashPassword('Old-Admin-Password-1'), now);
    db.prepare("INSERT INTO audits(created_at,user_id,ssid,pppoe_user,model,mac,serial,result) VALUES(?,1,'CDA-NET-N2-D01','a.b@cda-net.it','LiteBeam 5AC','AA:BB:CC:DD:EE:FF','S1','success')").run(now);
    migrate(db);
    const job = db.prepare("SELECT * FROM provisioning_jobs WHERE id = 'legacy-1'").get() as { status: string };
    assert.equal(job.status, 'success');
    migrate(db); // idempotent

    const { buildApp } = await import('../src/app.ts');
    const { app } = await buildApp(testConfig(), '1.0.0-test', { db, logger: false });
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'oldadmin', password: 'Old-Admin-Password-1' } });
    assert.equal(r.statusCode, 200);
    // the bootstrap admin is not created when an admin already exists
    assert.equal((db.prepare('SELECT count(*) n FROM users').get() as { n: number }).n, 1);
    await app.close();
  });
});

describe('GitHub release sync', () => {
  it('downloads, verifies and publishes the latest signed APK', async () => {
    const cfg = testConfig();
    const apk = Buffer.from('signed-apk-bytes');
    const sha = createHash('sha256').update(apk).digest('hex');
    const meta = { versionCode: 10002, versionName: '1.0.2', sha256: sha, fileName: 'CDA-Net-CPE-1.0.2.apk', mandatory: false };
    const fakeFetch = (async (url: string) => {
      if (url.endsWith('/releases/latest')) {
        return new Response(
          JSON.stringify({
            tag_name: 'v1.0.2',
            assets: [
              { name: 'latest.json', url: 'https://api.github.test/meta', size: 100 },
              { name: 'CDA-Net-CPE-1.0.2.apk', url: 'https://api.github.test/apk', size: apk.length },
            ],
          }),
        );
      }
      if (url.endsWith('/meta')) return new Response(JSON.stringify(meta));
      if (url.endsWith('/apk')) return new Response(apk);
      return new Response('', { status: 404 });
    }) as typeof fetch;
    const log = { info: () => {}, warn: () => {} };
    const opts = { dir: cfg.releases.dir, repo: 'o/r', log, fetchImpl: fakeFetch };
    assert.equal(await syncFromGithub(opts), 'updated');
    assert.equal(await syncFromGithub(opts), 'current');

    const bad = (async (url: string) =>
      url.endsWith('/apk') ? new Response(Buffer.from('tampered')) : fakeFetch(url)) as typeof fetch;
    const meta2 = { ...meta, versionCode: 10003 };
    const bad2 = (async (url: string) => (url.endsWith('/meta') ? new Response(JSON.stringify(meta2)) : bad(url))) as typeof fetch;
    await assert.rejects(syncFromGithub({ ...opts, fetchImpl: bad2 }), /sha256_mismatch/);
  });
});
