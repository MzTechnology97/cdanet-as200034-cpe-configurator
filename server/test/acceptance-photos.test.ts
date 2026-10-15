import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SAMPLE_TEMPLATE, testApp } from './helpers.ts';

const ANDROID = { 'x-cda-client': 'android/9.0.0' };

/** A JPEG header padded to the size the photo route wants; [n] makes each picture different. */
const jpeg = (n: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]), Buffer.alloc(2048, n), Buffer.from([0xff, 0xd9])]);

describe('Foto del collaudo: tipo, doppioni e foto obbligatorie', () => {
  it('a new installation needs antenna, bracket, cabling and router; re-pointings and replacements none', async () => {
    const t = await testApp();
    const A = t.auth(await t.login());
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, headers: Record<string, string> = A) => t.app.inject({ method, url, headers, payload });
    await call('POST', '/api/admin/users', { username: 'tecnico', password: 'Installer-Pass-123' });
    await call('POST', '/api/admin/profiles/LiteBeam%205AC/templates', { name: 'Standard', template: SAMPLE_TEMPLATE, boardMatch: 'board\\.name=LiteBeam 5AC' });
    await call('PUT', '/api/admin/wireless-networks/CDA-NET-N2-D01', { wpa2Password: 'test-psk-12345' });
    const T = t.auth(await t.login('tecnico', 'Installer-Pass-123'));
    const install = async (mac: string, user: string) => {
      const job = (await call('POST', '/api/provisioning/jobs', { model: 'LiteBeam 5AC', mac, serial: `S${mac.slice(-2)}`, ssid: 'CDA-NET-N2-D01', pppoeUser: user, pppoePassword: 'Segreta-PPPoE-1' }, { ...T, ...ANDROID })).json().jobId as string;
      await call('POST', `/api/provisioning/jobs/${job}/result`, { result: 'success', stages: [] }, T);
      return job;
    };
    const test = (job: string, kind: 'install' | 'repoint' = 'install') =>
      call('PUT', `/api/provisioning/jobs/${job}/acceptance`, {
        kind, verdict: 'ok', measuredAt: new Date().toISOString(), samples: 10,
        cpe: { model: 'LiteBeam 5AC Gen2', firmware: 'WA.v8.7.4', apName: 'N2-D01' }, radio: { signal: -58, cinrRx: 30, chains: [-58, -59] },
        internet: { tested: false }, checks: [{ title: 'Segnale ricevuto', verdict: 'ok', detail: 'ottimo' }], notes: '',
      }, T);
    const photo = (job: string, n: number, type?: string) =>
      t.app.inject({ method: 'POST', url: `/api/provisioning/jobs/${job}/photos${type ? `?type=${type}` : ''}`, headers: { ...T, 'content-type': 'image/jpeg' }, payload: jpeg(n) });
    const missing = async (job: string) => (await call('GET', `/api/provisioning/jobs/${job}/acceptance`, undefined, T)).json().photosMissing;

    const job = await install('AA:BB:CC:00:00:01', 'rossi@cda-net.it');
    assert.deepEqual(await missing(job), [], 'no test yet');
    assert.equal((await test(job)).statusCode, 200, 'never refused for the photos (the queue sends them later)');
    assert.deepEqual(await missing(job), ['antenna', 'bracket', 'cabling', 'router']);
    assert.equal((await photo(job, 1, 'antenna')).statusCode, 201);
    assert.equal((await photo(job, 2)).statusCode, 201, 'old apps send no type: «other»');
    assert.equal((await photo(job, 3, 'satellite')).statusCode, 400);
    const again = await photo(job, 1, 'bracket');
    assert.equal(again.statusCode, 409, 'the same picture twice');
    assert.equal(again.json().error, 'photo_duplicate');
    assert.ok(again.json().id, 'with the id of the one already there');
    assert.deepEqual(await missing(job), ['bracket', 'cabling', 'router']);
    const types = (await call('GET', `/api/provisioning/jobs/${job}/acceptance`, undefined, T)).json().photos.map((p: { type: string }) => p.type);
    assert.deepEqual(types, ['antenna', 'other']);
    const pdf = await call('GET', `/api/admin/provisioning/jobs/${job}/acceptance.pdf`);
    assert.equal(pdf.statusCode, 200);
    for (const [n, type] of [[4, 'bracket'], [5, 'cabling'], [6, 'router']] as const) assert.equal((await photo(job, n, type)).statusCode, 201);
    assert.deepEqual(await missing(job), []);

    // a re-pointing: the earlier photos go into the history, none is required now
    assert.equal((await test(job, 'repoint')).statusCode, 200);
    assert.deepEqual(await missing(job), []);
    assert.equal((await photo(job, 1, 'antenna')).statusCode, 201, 'a photo of the earlier test is not a duplicate of the new one');

    // the replacement of a CPE: no required photos either
    const other = await install('AA:BB:CC:00:00:02', 'verdi@cda-net.it');
    t.db.prepare('UPDATE provisioning_jobs SET replaces_job_id = ? WHERE id = ?').run(job, other);
    await test(other);
    assert.deepEqual(await missing(other), []);
    await t.app.close();
  });
});
