import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SAMPLE_TEMPLATE, testApp } from './helpers.ts';

const ANDROID = { 'x-cda-client': 'android/1.0.6' };
const LB = '/api/admin/profiles/LiteBeam%205AC/templates';
const BM = 'board\\.name=LiteBeam 5AC';

describe('template visibility and personal templates', () => {
  it('limits installers to their templates in listing and jobs; admins see everything', async () => {
    const t = await testApp();
    const admin = await t.login();
    const as = (token: string) => (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: object, headers: Record<string, string> = {}) =>
      t.app.inject({ method, url, headers: t.auth(token, headers), payload });
    const A = as(admin);

    const mk = async (username: string) => {
      const r = await A('POST', '/api/admin/users', { username, password: 'Installer-Pass-123' });
      return { id: r.json().id as number, token: await t.login(username, 'Installer-Pass-123') };
    };
    const mario = await mk('mario');
    const luca = await mk('luca');
    await A('PUT', '/api/admin/wireless-networks/CDA-NET-N2-D01', { wpa2Password: 'test-psk-12345' });

    const pub = (await A('POST', LB, { name: 'Standard', template: SAMPLE_TEMPLATE, boardMatch: BM })).json();
    const personal = await A('POST', LB, {
      name: 'Mario personale',
      template: SAMPLE_TEMPLATE.replace('netconf.3.ip=${LAN_IP}', 'netconf.3.ip=${LAN_IP}\nradio.1.txpower=8'),
      boardMatch: BM,
      audience: 'users',
      userIds: [mario.id],
      defaultForAssigned: true,
    });
    assert.equal(personal.statusCode, 201, personal.body);
    assert.deepEqual(personal.json().users.map((u: { username: string }) => u.username), ['mario']);
    const team = (await A('POST', LB, { name: 'Squadra nord', template: SAMPLE_TEMPLATE, boardMatch: BM, audience: 'users', userIds: [mario.id, luca.id] })).json();

    // validation
    assert.equal((await A('POST', LB, { name: 'X', template: SAMPLE_TEMPLATE, boardMatch: BM, audience: 'users', userIds: [] })).json().error, 'template_audience_empty');
    assert.equal((await A('POST', LB, { name: 'Y', template: SAMPLE_TEMPLATE, boardMatch: BM, audience: 'users', userIds: [mario.id], isDefault: true })).json().error, 'default_must_be_public');
    assert.equal((await A('PATCH', `/api/admin/templates/${pub.id}`, { audience: 'users', userIds: [luca.id] })).json().error, 'default_must_be_public');
    assert.equal((await A('POST', LB, { name: 'Z', template: SAMPLE_TEMPLATE, boardMatch: BM, audience: 'users', userIds: [9999] })).json().error, 'template_user_not_found');

    // listings
    const names = async (token: string) =>
      ((await as(token)('GET', '/api/provisioning/templates')).json() as Array<{ name: string; isDefault: boolean; personal: boolean }>);
    const mList = await names(mario.token);
    assert.deepEqual(mList.map((x) => x.name).sort(), ['Mario personale', 'Squadra nord', 'Standard']);
    assert.equal(mList.find((x) => x.isDefault)?.name, 'Mario personale');
    const lList = await names(luca.token);
    assert.deepEqual(lList.map((x) => x.name).sort(), ['Squadra nord', 'Standard']);
    assert.equal(lList.find((x) => x.isDefault)?.name, 'Standard');
    assert.equal((await names(admin)).length, 3);

    // jobs
    const req = { model: 'LiteBeam 5AC', mac: '24A43C112233', serial: 'S1', ssid: 'CDA-NET-N2-D01', pppoeUser: 'a.b@cda-net.it', pppoePassword: 'x' };
    const job = async (token: string, extra: object = {}) => as(token)('POST', '/api/provisioning/jobs', { ...req, ...extra }, ANDROID);
    const mDefault = (await job(mario.token)).json();
    assert.equal(mDefault.summary.template, 'Mario personale');
    assert.match(mDefault.config.text, /^radio\.1\.txpower=8$/m);
    assert.equal((await job(luca.token)).json().summary.template, 'Standard');
    const forbidden = await job(luca.token, { templateId: personal.json().id });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(forbidden.json().error, 'template_not_allowed');
    assert.equal((await job(luca.token, { templateId: team.id })).json().summary.template, 'Squadra nord');
    assert.equal((await job(admin, { templateId: personal.json().id })).json().summary.template, 'Mario personale');
    const plan = (await as(luca.token)('POST', '/api/provisioning/plan', { ...req, templateId: personal.json().id })).json();
    assert.equal(plan.error, 'template_not_allowed');

    // making the personal template public again drops the per-user default
    const open = (await A('PATCH', `/api/admin/templates/${personal.json().id}`, { audience: 'all' })).json();
    assert.equal(open.audience, 'all');
    assert.equal(open.defaultForAssigned, false);
    assert.equal((await names(mario.token)).find((x) => x.isDefault)?.name, 'Standard');
    assert.equal((await names(luca.token)).length, 3);
    await t.app.close();
  });

  it('a model with only restricted templates has no global default', async () => {
    const t = await testApp();
    const admin = await t.login();
    const u = (await t.app.inject({ method: 'POST', url: '/api/admin/users', headers: t.auth(admin), payload: { username: 'solo', password: 'Installer-Pass-123' } })).json();
    const r = await t.app.inject({
      method: 'POST',
      url: LB,
      headers: t.auth(admin),
      payload: { name: 'Solo personale', template: SAMPLE_TEMPLATE, boardMatch: BM, audience: 'users', userIds: [u.id] },
    });
    assert.equal(r.json().isDefault, false);
    const other = await t.login('admintest', 'Admin-Test-Password-123');
    const list = (await t.app.inject({ method: 'GET', url: '/api/admin/profiles', headers: t.auth(other) })).json();
    assert.equal(list.find((m: { model: string }) => m.model === 'LiteBeam 5AC').templates[0].isDefault, false);
    await t.app.close();
  });
});
