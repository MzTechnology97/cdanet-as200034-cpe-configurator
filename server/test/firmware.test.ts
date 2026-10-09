import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseAirosBuild, parseAirosImage } from '../src/domain/firmware.ts';
import { testApp } from './helpers.ts';

/** Fake airOS image: header + build string + padding (the real ones are ~10-15 MB). */
function image(build: string, fill = 0x55): Buffer {
  const b = Buffer.alloc(1024 * 1024 + 4096, fill);
  b.write('UBNT', 0, 'latin1');
  b.fill(0, 4, 4 + 256);
  b.write(build, 4, 'latin1');
  return b;
}

describe('Firmware airOS', () => {
  it('reads platform and version from the image and from /etc/version', () => {
    assert.deepEqual(parseAirosBuild('XC.qca956x.v8.7.4.45112.210415.1103'), { platform: 'XC', version: '8.7.4', build: 'XC.qca956x.v8.7.4.45112.210415.1103' });
    assert.equal(parseAirosBuild('WA.ar934x.v8.7.11.46972.220614.0420\n')?.platform, 'WA');
    assert.equal(parseAirosBuild('2XC.qca955x.v8.7.25.48000.240101.0000')?.platform, '2XC');
    assert.equal(parseAirosBuild('hello world'), null);
    assert.equal(parseAirosImage(image('XC.qca956x.v8.7.4.45112.210415.1103'))?.version, '8.7.4');
    assert.equal(parseAirosImage(Buffer.alloc(2 * 1024 * 1024)), null, 'no UBNT header');
    assert.equal(parseAirosImage(image('XC.qca956x.v8.7.4').subarray(0, 1000)), null, 'too small');
  });

  it('admin uploads, installer lists and downloads the target version, flashes are logged', async () => {
    const t = await testApp();
    const admin = await t.login();
    const A = t.auth(admin);
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/firmware', headers: A })).statusCode, 404, 'module off by default');
    await t.app.inject({ method: 'PUT', url: '/api/admin/modules', headers: A, payload: { firmware_upgrade: true } });
    const up = (body: Buffer, name: string) =>
      t.app.inject({ method: 'POST', url: `/api/admin/firmware?name=${encodeURIComponent(name)}`, headers: { ...A, 'content-type': 'application/x-airos-firmware' }, payload: body });

    const xc = image('XC.qca956x.v8.7.4.45112.210415.1103');
    const r1 = await up(xc, 'XC.v8.7.4.bin');
    assert.equal(r1.statusCode, 201, r1.body);
    assert.equal(r1.json().item.platform, 'XC');
    assert.equal(r1.json().item.target, true);
    assert.equal((await up(xc, 'copia.bin')).statusCode, 409, 'same file twice');
    assert.equal((await up(Buffer.alloc(2 * 1024 * 1024, 1), 'x.bin')).statusCode, 400, 'not a firmware');
    assert.equal((await up(image('WA.ar934x.v8.7.11.46972.220614.0420', 0x66), 'WA.v8.7.11.bin')).statusCode, 201);

    await t.app.inject({ method: 'POST', url: '/api/admin/users', headers: A, payload: { username: 'tecnico', password: 'Installer-Pass-123' } });
    const T = t.auth(await t.login('tecnico', 'Installer-Pass-123'));
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/admin/firmware', headers: T })).statusCode, 403);
    const list = (await t.app.inject({ method: 'GET', url: '/api/firmware', headers: T })).json();
    assert.equal(list.target, '8.7.4');
    assert.deepEqual(list.items.map((i: { platform: string }) => i.platform), ['XC'], 'only the target version');
    assert.ok(!('filename' in list.items[0]));
    const file = await t.app.inject({ method: 'GET', url: `/api/firmware/${list.items[0].id}/file`, headers: T });
    assert.equal(file.statusCode, 200);
    assert.equal(file.rawPayload.length, xc.length);
    assert.equal(file.headers['x-firmware-sha256'], list.items[0].sha256);

    const rep = await t.app.inject({ method: 'POST', url: '/api/firmware/report', headers: T, payload: { mac: '24:A4:3C:11:22:33', from: 'XC.qca956x.v8.7.11.46972.220614.0420', to: '8.7.4', ok: true } });
    assert.equal(rep.statusCode, 200);
    const all = (await t.app.inject({ method: 'GET', url: '/api/admin/firmware', headers: A })).json();
    assert.equal(all.items.length, 2);
    const del = await t.app.inject({ method: 'DELETE', url: `/api/admin/firmware/${list.items[0].id}`, headers: A });
    assert.equal(del.statusCode, 200);
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/firmware', headers: T })).json().items.length, 0);
  });
});
