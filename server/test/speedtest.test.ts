import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { profileSpeed } from '../src/routes/speedtest.ts';
import { SAMPLE_TEMPLATE, testApp } from './helpers.ts';

const ANDROID = { 'x-cda-client': 'android/9.0.0' };

describe('Speedtest del collaudo e degli interventi', () => {
  it('reads the speed of a PPPoE profile', () => {
    assert.deepEqual(profileSpeed('CDA-NET-HOME-25-5'), { downMbps: 25, upMbps: 5 });
    assert.deepEqual(profileSpeed('ISP37@CDA-NET-B2B-100-100-NEW'), { downMbps: 100, upMbps: 100 });
    assert.deepEqual(profileSpeed('CDA NET HOME 30/6'), { downMbps: 30, upMbps: 6 });
    assert.equal(profileSpeed('DEDICATA COMUNE'), null);
  });

  it('gives the settings, compares a result with the profile and keeps every attempt', async () => {
    const t = await testApp();
    const A = t.auth(await t.login());
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, headers: Record<string, string> = A) => t.app.inject({ method, url, headers, payload });

    const cfg = (await call('GET', '/api/speedtest/config')).json();
    assert.deepEqual(cfg, { host: 'speedtest.cda-net.it', port: 8080, seconds: 10, streams: 4, minPct: 80, wifiWarnDbm: -65, wifiBlockDbm: -70 });
    // the admin changes the threshold from Impostazioni server
    assert.equal((await call('PUT', '/api/admin/server-settings', { values: { 'speedtest.minPct': 70 } })).statusCode, 200);
    assert.equal((await call('GET', '/api/speedtest/config')).json().minPct, 70);
    await call('PUT', '/api/admin/server-settings', { values: { 'speedtest.minPct': null } });
    // the app measures against the OoklaServer: this server is no longer a speedtest server
    for (const url of ['/api/tools/speed/ping', '/api/tools/speed/download?bytes=262144']) assert.equal((await call('GET', url)).statusCode, 404, url);
    assert.equal((await t.app.inject({ method: 'POST', url: '/api/tools/speed/upload', headers: { ...A, 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(1024) })).statusCode, 404);

    await call('POST', '/api/admin/users', { username: 'tecnico', password: 'Installer-Pass-123' });
    await call('POST', '/api/admin/users', { username: 'altro', password: 'Installer-Pass-456' });
    await call('POST', '/api/admin/profiles/LiteBeam%205AC/templates', { name: 'Standard', template: SAMPLE_TEMPLATE, boardMatch: 'board\\.name=LiteBeam 5AC' });
    await call('PUT', '/api/admin/wireless-networks/CDA-NET-N2-D01', { wpa2Password: 'test-psk-12345' });
    const T = t.auth(await t.login('tecnico', 'Installer-Pass-123'));
    const O = t.auth(await t.login('altro', 'Installer-Pass-456'));
    const job = (await call('POST', '/api/provisioning/jobs', { model: 'LiteBeam 5AC', mac: 'AA:BB:CC:00:00:09', serial: 'S9', ssid: 'CDA-NET-N2-D01', pppoeUser: 'verdi@cda-net.it', pppoePassword: 'Segreta-PPPoE-7' }, { ...T, ...ANDROID })).json().jobId;
    // the customer's profile, as the RADIUS sync of the CRM copies it
    t.db.prepare("INSERT INTO crm_radius(account_id, username, profile) VALUES('a1', 'verdi@cda-net.it', 'ISP37@CDA-NET-HOME-30-6')").run();

    const target = (await call('GET', `/api/speedtest/target?jobId=${job}`, undefined, T)).json().target;
    assert.deepEqual(target, { profile: 'CDA-NET-HOME-30-6', downMbps: 30, upMbps: 6, minPct: 80 });
    assert.equal((await call('GET', `/api/speedtest/target?jobId=${job}`, undefined, O)).statusCode, 403, 'not the job of another installer');
    // only the MAC (replacement, network tools), with no RADIUS session MAC: the customer of the last installation
    assert.deepEqual((await call('GET', '/api/speedtest/target?mac=aa-bb-cc-00-00-09', undefined, T)).json().target, target);

    const send = (down: number, up: number, attempt: number) =>
      call('POST', '/api/speedtests', { context: 'acceptance', jobId: job, downMbps: down, upMbps: up, pingMs: 12, jitterMs: 2, server: 'speedtest.cda-net.it:8080', wifi: { rssi: -58, band: '5', channel: 36, widthMhz: 80 }, attempt }, T);
    const low = await send(10, 5, 1);
    assert.equal(low.statusCode, 201, low.body);
    assert.equal(low.json().passed, false, '10 of 30 is under 80%');
    const ok = (await send(26, 5.2, 2)).json();
    assert.equal(ok.passed, true, '26/5.2 of 30/6 is over 80%');
    // the same result sent twice by the phone (offline queue): kept once
    const once = { context: 'acceptance', jobId: job, id: '2f6e3c7a-1b2c-4d5e-8f90-123456789abc', at: '2026-10-15T09:00:00.000Z', downMbps: 27, upMbps: 5.5 };
    const first = await call('POST', '/api/speedtests', once, T);
    const again = await call('POST', '/api/speedtests', once, T);
    assert.equal(first.statusCode, 201);
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().id, first.json().id);
    // the server compares, not the app: a result for a CPE of another installer is refused
    assert.equal((await call('POST', '/api/speedtests', { context: 'cpe', mac: 'AA:BB:CC:00:00:09', downMbps: 1, upMbps: 1 }, O)).statusCode, 403);
    // as a network tool, without a CPE: kept, no comparison
    assert.equal((await call('POST', '/api/speedtests', { context: 'tool', downMbps: 50, upMbps: 10 }, O)).json().passed, null);

    const list = (await call('GET', `/api/speedtests?jobId=${job}`)).json().items;
    assert.equal(list.length, 3);
    assert.equal(list.find((x: { at: string }) => x.at === '2026-10-15T09:00:00.000Z')?.downMbps, 27, 'the time of the measure');
    assert.equal(list[0].wifi.channel, 36);
    assert.equal((await call('GET', '/api/speedtests?mac=AA:BB:CC:00:00:09', undefined, T)).json().items.length, 3, 'by MAC too');
    await t.app.close();
  });
});
