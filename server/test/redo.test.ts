import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SAMPLE_TEMPLATE, testApp } from './helpers.ts';

const ANDROID = { 'x-cda-client': 'android/1.0.0' };
const REQUEST = { model: 'LiteBeam 5AC', mac: '24A43C000001', serial: 'SN1', ssid: 'CDA-NET-N2-D01', pppoeUser: 'rossi.mario@cda-net.it', pppoePassword: 'pppoe-transient' };

describe('Modifica e riprova', () => {
  it('a new installation closes the failed or never written one it redoes (only the installer\'s own)', async () => {
    const t = await testApp();
    const admin = await t.login();
    for (const u of ['tecnico1', 'tecnico2']) {
      await t.app.inject({ method: 'POST', url: '/api/admin/users', headers: t.auth(admin), payload: { username: u, password: 'Installer-Password-1' } });
    }
    await t.app.inject({ method: 'PUT', url: '/api/admin/wireless-networks/CDA-NET-N2-D01', headers: t.auth(admin), payload: { wpa2Password: 'node2-district1-psk' } });
    await t.app.inject({ method: 'POST', url: '/api/admin/profiles/LiteBeam%205AC/templates', headers: t.auth(admin), payload: { name: 'Standard', template: SAMPLE_TEMPLATE, boardMatch: 'board\\.name=LiteBeam 5AC' } });
    const tec = await t.login('tecnico1', 'Installer-Password-1');
    const other = await t.login('tecnico2', 'Installer-Password-1');
    const create = (token: string, body: object) => t.app.inject({ method: 'POST', url: '/api/provisioning/jobs', headers: t.auth(token, ANDROID), payload: body });
    const by = (id: string) => (t.db.prepare('SELECT superseded_by s FROM provisioning_jobs WHERE id = ?').get(id) as { s: string | null }).s;

    const first = (await create(tec, REQUEST)).json().jobId as string;
    // someone else cannot close it
    assert.equal((await create(other, { ...REQUEST, mac: '24A43C000002', supersedes: first })).statusCode, 201);
    assert.equal(by(first), null);
    // the installer redoes it with the right MAC: the old one leaves the open work
    const redo = await create(tec, { ...REQUEST, mac: '24A43C000003', supersedes: first });
    assert.equal(redo.statusCode, 201, redo.body);
    assert.equal(by(first), redo.json().jobId);
    await t.app.close();
  });
});
