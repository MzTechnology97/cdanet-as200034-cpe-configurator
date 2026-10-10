import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { SAMPLE_TEMPLATE, testApp } from './helpers.ts';

const ANDROID = { 'x-cda-client': 'android/1.2.0' };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4096, 7), Buffer.from([0xff, 0xd9])]);

const ACCEPTANCE = {
  verdict: 'ok',
  measuredAt: new Date().toISOString(),
  samples: 10,
  cpe: { hostname: 'ROSSI MARIO', model: 'LiteBeam 5AC', firmware: 'XC.qca956x.v8.7.4', apName: 'AP-N2-Monte', essid: 'CDA-NET-N2-D01', distanceM: 2300 },
  radio: { signal: -58, signalMin: -60, signalMax: -57, noise: -95, chains: [-58, -59], remoteSignal: -60, expectedSignal: -61, cinrRx: 32, dlCapacityMbps: 280, ulCapacityMbps: 250 },
  lan: { plugged: true, speedMbps: 1000, fullDuplex: true, cableLenM: 12 },
  pppoe: { enabled: true, ip: '93.41.10.20' },
  internet: { tested: true, pingMs: 18, jitterMs: 2, downloadMbps: 95.2, uploadMbps: 19.8 },
  checks: [{ title: 'Segnale ricevuto', verdict: 'ok', detail: '-58 dBm: ottimo' }],
  notes: 'Staffa a muro, cavo in canalina',
  cpeHeightM: 7.5,
};

describe('Collaudo (acceptance test) with photos', () => {
  it('stores the acceptance and photos of a completed job, visible in the history', async () => {
    const t = await testApp();
    const admin = await t.login();
    await t.app.inject({ method: 'POST', url: '/api/admin/users', headers: t.auth(admin), payload: { username: 'tecnico', password: 'Installer-Pass-123' } });
    await t.app.inject({ method: 'POST', url: '/api/admin/users', headers: t.auth(admin), payload: { username: 'altro', password: 'Installer-Pass-456' } });
    await t.app.inject({ method: 'POST', url: '/api/admin/profiles/LiteBeam%205AC/templates', headers: t.auth(admin), payload: { name: 'Standard', template: SAMPLE_TEMPLATE, boardMatch: 'board\\.name=LiteBeam 5AC' } });
    await t.app.inject({ method: 'PUT', url: '/api/admin/wireless-networks/CDA-NET-N2-D01', headers: t.auth(admin), payload: { wpa2Password: 'test-psk-12345' } });
    const tec = await t.login('tecnico', 'Installer-Pass-123');
    const other = await t.login('altro', 'Installer-Pass-456');
    const job = (
      await t.app.inject({
        method: 'POST',
        url: '/api/provisioning/jobs',
        headers: t.auth(tec, ANDROID),
        payload: { model: 'LiteBeam 5AC', mac: 'AABBCCDDEEFF', serial: 'S1', ssid: 'CDA-NET-N2-D01', pppoeUser: 'rossi.mario@cda-net.it', pppoePassword: 'x' },
      })
    ).json();
    const base = `/api/provisioning/jobs/${job.jobId}`;

    // not before the provisioning succeeded
    assert.equal((await t.app.inject({ method: 'PUT', url: `${base}/acceptance`, headers: t.auth(tec), payload: ACCEPTANCE })).json().error, 'job_not_completed');
    await t.app.inject({ method: 'POST', url: `${base}/result`, headers: t.auth(tec), payload: { result: 'success', stages: ['ok'], detected: {} } });

    const put = await t.app.inject({ method: 'PUT', url: `${base}/acceptance`, headers: t.auth(tec), payload: ACCEPTANCE });
    assert.equal(put.statusCode, 200, put.body);
    assert.equal((await t.app.inject({ method: 'PUT', url: `${base}/acceptance`, headers: t.auth(tec), payload: { ...ACCEPTANCE, password: 'x' } })).statusCode, 400);
    assert.equal((await t.app.inject({ method: 'PUT', url: `${base}/acceptance`, headers: t.auth(other), payload: ACCEPTANCE })).statusCode, 403);
    // the CPE height goes in the report; an implausible one is refused
    assert.equal((await t.app.inject({ method: 'GET', url: `${base}/acceptance`, headers: t.auth(tec) })).json().acceptance.cpeHeightM, 7.5);
    assert.equal((await t.app.inject({ method: 'PUT', url: `${base}/acceptance`, headers: t.auth(tec), payload: { ...ACCEPTANCE, cpeHeightM: 500 } })).statusCode, 400);

    // photos: JPEG only, owner or admin
    const up = (headers: Record<string, string>, body: Buffer, caption = 'Antenna') =>
      t.app.inject({ method: 'POST', url: `${base}/photos?caption=${encodeURIComponent(caption)}`, headers: { ...headers, 'content-type': 'image/jpeg' }, payload: body });
    const p1 = await up(t.auth(tec), JPEG);
    assert.equal(p1.statusCode, 201, p1.body);
    const photoId = p1.json().id;
    assert.equal((await up(t.auth(tec), Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(2048)]))).statusCode, 415);
    assert.equal((await up(t.auth(other), JPEG)).statusCode, 403);
    assert.ok(existsSync(join(t.cfg.photosDir, job.jobId, `${photoId}.jpg`)));

    const got = (await t.app.inject({ method: 'GET', url: `${base}/acceptance`, headers: t.auth(admin) })).json();
    assert.equal(got.acceptance.verdict, 'ok');
    assert.equal(got.acceptance.by, 'tecnico');
    assert.equal(got.acceptance.radio.signal, -58);
    assert.equal(got.photos.length, 1);
    assert.equal(got.photos[0].caption, 'Antenna');
    const img = await t.app.inject({ method: 'GET', url: `${base}/photos/${photoId}`, headers: t.auth(admin) });
    assert.equal(img.headers['content-type'], 'image/jpeg');
    assert.equal(img.rawPayload.length, JPEG.length);

    const hist = (await t.app.inject({ method: 'GET', url: '/api/provisioning/jobs', headers: t.auth(tec) })).json();
    assert.equal(hist[0].acceptance, 'ok');
    assert.equal(hist[0].photos, 1);

    assert.equal((await t.app.inject({ method: 'DELETE', url: `${base}/photos/${photoId}`, headers: t.auth(tec) })).statusCode, 200);
    assert.ok(!existsSync(join(t.cfg.photosDir, job.jobId, `${photoId}.jpg`)));
    const events = (await t.app.inject({ method: 'GET', url: '/api/admin/events', headers: t.auth(admin) })).json().map((e: { action: string }) => e.action);
    assert.ok(events.includes('job.acceptance') && events.includes('job.photo') && events.includes('job.photo_delete'));
    await t.app.close();
  });
});
