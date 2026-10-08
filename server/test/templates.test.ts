import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { createSealer } from '../src/crypto.ts';
import { migrate } from '../src/db.ts';
import { createTemplates } from '../src/services/templates.ts';
import { SAMPLE_TEMPLATE, testApp } from './helpers.ts';

const BM = 'board\\.name=LiteBeam 5AC';
const ANDROID = { 'x-cda-client': 'android/1.0.5' };

describe('named templates API', () => {
  it('creates, edits, renames, defaults, deletes and is used by jobs', async () => {
    const t = await testApp();
    const token = await t.login();
    const call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object, headers: Record<string, string> = {}) =>
      t.app.inject({ method, url, headers: t.auth(token, headers), payload });

    const a = await call('POST', '/api/admin/profiles/LiteBeam%205AC/templates', { name: 'Standard', template: SAMPLE_TEMPLATE, boardMatch: BM });
    assert.equal(a.statusCode, 201, a.body);
    const b = await call('POST', '/api/admin/profiles/LiteBeam%205AC/templates', {
      name: 'Palo alto',
      template: SAMPLE_TEMPLATE.replace('netconf.3.ip=${LAN_IP}', 'netconf.3.ip=${LAN_IP}\nradio.1.txpower=10'),
      boardMatch: BM,
    });
    assert.equal(b.statusCode, 201);
    assert.equal(a.json().isDefault, true);
    assert.equal(b.json().isDefault, false);

    // names are unique per model (case-insensitive)
    const dup = await call('POST', '/api/admin/profiles/LiteBeam%205AC/templates', { name: 'standard', template: SAMPLE_TEMPLATE, boardMatch: BM });
    assert.equal(dup.json().error, 'template_name_exists');
    // ...but may repeat on another model
    assert.equal((await call('POST', '/api/admin/profiles/NanoBeam%205AC/templates', { name: 'Standard', template: SAMPLE_TEMPLATE, boardMatch: 'board\\.name=NanoBeam 5AC' })).statusCode, 201);

    // edit text in the GUI: full template returned, invalid edits rejected, valid ones stored
    const full = (await call('GET', `/api/admin/templates/${b.json().id}`)).json();
    assert.ok(full.template.includes('radio.1.txpower=10'));
    const badEdit = await call('PATCH', `/api/admin/templates/${b.json().id}`, { template: `${full.template}vlan.1.id=87\n` });
    assert.equal(badEdit.json().error, 'profile_contains_vlan');
    const edited = await call('PATCH', `/api/admin/templates/${b.json().id}`, { template: full.template.replace('txpower=10', 'txpower=12'), name: 'Palo alto 12dBm' });
    assert.equal(edited.statusCode, 200, edited.body);
    assert.notEqual(edited.json().sha256, b.json().sha256);
    assert.equal(edited.json().name, 'Palo alto 12dBm');

    // field app sees names only
    const pub = (await call('GET', '/api/provisioning/templates')).json();
    assert.ok(pub.some((x: { name: string; model: string }) => x.name === 'Palo alto 12dBm' && x.model === 'LiteBeam 5AC'));
    assert.ok(!JSON.stringify(pub).includes('wireless.1.ssid'));

    // jobs: default template, or the chosen one (same model only)
    await call('PUT', '/api/admin/wireless-networks/CDA-NET-N2-D01', { wpa2Password: 'test-psk-12345' });
    const req = { model: 'LiteBeam 5AC', mac: '24A43C112233', serial: 'S1', ssid: 'CDA-NET-N2-D01', pppoeUser: 'a.b@cda-net.it', pppoePassword: 'x' };
    const j1 = (await call('POST', '/api/provisioning/jobs', req, ANDROID)).json();
    assert.equal(j1.summary.template, 'Standard');
    assert.ok(!j1.config.text.includes('txpower'));
    const j2 = (await call('POST', '/api/provisioning/jobs', { ...req, templateId: b.json().id }, ANDROID)).json();
    assert.equal(j2.summary.template, 'Palo alto 12dBm');
    assert.match(j2.config.text, /^radio\.1\.txpower=12$/m);
    const nanoId = (await call('GET', '/api/admin/profiles')).json().find((m: { model: string }) => m.model === 'NanoBeam 5AC').templates[0].id;
    assert.equal((await call('POST', '/api/provisioning/jobs', { ...req, templateId: nanoId }, ANDROID)).json().error, 'provision_profile_missing');
    const hist = (await call('GET', '/api/provisioning/jobs')).json();
    assert.deepEqual(hist.slice(0, 2).map((x: { template: string }) => x.template).sort(), ['Palo alto 12dBm', 'Standard']);

    // default switch, then deleting the default promotes the remaining one
    const sw = await call('PATCH', `/api/admin/templates/${b.json().id}`, { isDefault: true });
    assert.equal(sw.json().isDefault, true);
    const lite = () => (call('GET', '/api/admin/profiles') as Promise<{ json(): Array<{ model: string; templates: Array<{ id: number; isDefault: boolean }> }> }>)
      .then((r) => r.json().find((m) => m.model === 'LiteBeam 5AC')!.templates);
    assert.deepEqual((await lite()).filter((x) => x.isDefault).map((x) => x.id), [b.json().id]);
    assert.equal((await call('DELETE', `/api/admin/templates/${b.json().id}`)).statusCode, 200);
    const left = await lite();
    assert.equal(left.length, 1);
    assert.equal(left[0]!.isDefault, true);
    assert.equal((await call('GET', '/api/admin/templates/999')).statusCode, 404);
    await t.app.close();
  });
});

describe('migration of v1.0.x single profiles', () => {
  it('turns each provision_profiles row into a default "Standard" template', () => {
    const db = new DatabaseSync(':memory:');
    const sealer = createSealer(randomBytes(32));
    asVersion2(db);
    db.prepare("INSERT INTO provision_profiles(model, firmware, board_match, template_ciphertext, template_sha256, updated_at) VALUES('LiteBeam 5AC','8.7.4',?,?,?,?)").run(
      BM,
      sealer.seal(SAMPLE_TEMPLATE),
      'abc',
      new Date().toISOString(),
    );
    migrate(db);
    const list = createTemplates(db, sealer).list('LiteBeam 5AC');
    assert.equal(list.length, 1);
    assert.equal(list[0]!.name, 'Standard');
    assert.equal(list[0]!.isDefault, true);
    assert.ok(createTemplates(db, sealer).get(list[0]!.id).template.includes('wireless.1.ssid=${SSID}'));
  });
});

/** Builds a database in the v1.0.0-1.0.4 shape (schema version 2). */
function asVersion2(db: DatabaseSync) {
  migrate(db);
  db.exec('DROP TABLE profile_templates');
  db.exec('ALTER TABLE provisioning_jobs DROP COLUMN template_name');
  db.exec('PRAGMA user_version = 2');
}
