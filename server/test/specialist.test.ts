import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { parseKeys } from '../src/domain/airos-form.ts';
import { fakeUisp } from './fake-uisp.ts';
import { ADMIN, SAMPLE_TEMPLATE, testConfig } from './helpers.ts';

const SPEC = { username: 'carmelo.specialist', password: 'Specialist-Password-123' };
const SPEC2 = { username: 'altro.specialist', password: 'Specialist-Password-456' };
const INST = { username: 'alfio', password: 'Installer-Password-123' };
const APP = { 'x-cda-client': 'android/9.9.9' };
const WIFI = 'Chiave-WiFi-Azienda-X';
const PPPOE_PASSWORD = 'Pppoe-Segreta-1';
const CPE_PASSWORD = 'Cpe-Azienda-X-1';

async function setup() {
  const fake = fakeUisp();
  const db = openDatabase(':memory:');
  const { app } = await buildApp(testConfig(), 'test', { db, logger: false, uisp: fake.uisp, fetchImpl: fake.fetchImpl });
  await app.ready();
  const login = async (u: { username: string; password: string }) => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: u });
    assert.equal(r.statusCode, 200, r.body);
    return r.json() as { token: string; user: { id: number; role: string } };
  };
  const A = { authorization: `Bearer ${(await login(ADMIN)).token}` };
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, headers: Record<string, string>, payload?: object) => app.inject({ method, url, headers, payload });
  for (const [u, role] of [[SPEC, 'specialist'], [SPEC2, 'specialist'], [INST, 'installer']] as const) {
    const r = await call('POST', '/api/admin/users', A, { ...u, role });
    assert.equal(r.statusCode, 201, r.body);
  }
  const spec = await login(SPEC);
  const S = { authorization: `Bearer ${spec.token}` };
  const S2 = { authorization: `Bearer ${(await login(SPEC2)).token}` };
  const I = { authorization: `Bearer ${(await login(INST)).token}` };
  return { app, db, fake, call, A, S, S2, I, spec };
}

describe('Specialist', () => {
  it('sees everything like an admin, the management stays with the admins', async () => {
    const { app, call, A, S, I, spec, db } = await setup();
    assert.equal(spec.user.role, 'specialist');
    // what he sees and the tools he uses
    for (const url of ['/api/admin/status', '/api/admin/events', '/api/admin/profiles', '/api/admin/template-form', '/api/admin/stats', '/api/admin/work-orders', '/api/admin/uisp/status', '/api/admin/uisp/sites', '/api/admin/platform/health']) {
      const r = await call('GET', url, S);
      assert.equal(r.statusCode, 200, `${url}: ${r.body}`);
    }
    // the platform and CDA Net's decisions: admins only
    for (const [method, url, body] of [
      ['GET', '/api/admin/users', undefined],
      ['POST', '/api/admin/users', { username: 'nuovo.utente', password: 'Password-Lunga-123', role: 'installer' }],
      ['GET', '/api/admin/connectors', undefined],
      ['GET', '/api/admin/server-settings', undefined],
      ['GET', '/api/admin/wireless-networks', undefined],
      ['GET', '/api/admin/privacy', undefined],
      ['GET', '/api/admin/bans', undefined],
      ['GET', '/api/admin/mcp', undefined],
      ['GET', '/api/admin/modules', undefined],
      ['GET', '/api/admin/infra', undefined],
      ['POST', '/api/admin/work-orders', { day: '2026-10-20', customer: 'Prova' }],
      ['POST', '/api/admin/profiles/LiteBeam%205AC/templates', { name: 'X', template: SAMPLE_TEMPLATE, boardMatch: 'board\\.name=LiteBeam' }],
    ] as const) {
      const r = await call(method, url, S, body);
      assert.equal(r.statusCode, 403, `${method} ${url}: ${r.statusCode} ${r.body}`);
    }
    // his section: his own, nobody else's
    assert.equal((await call('GET', '/api/specialist/templates', S)).statusCode, 200);
    assert.equal((await call('GET', '/api/specialist/templates', A)).statusCode, 403);
    assert.equal((await call('GET', '/api/specialist/templates', I)).statusCode, 403);
    // an admin cannot make himself a specialist (he would lose the admin pages)
    const me = (db.prepare('SELECT id FROM users WHERE username = ?').get(ADMIN.username) as { id: number }).id;
    assert.equal((await call('PATCH', `/api/admin/users/${me}`, A, { role: 'specialist' })).json().error, 'cannot_demote_current_admin');
    const list = (await call('GET', '/api/admin/users', A)).json() as Array<{ username: string; role: string }>;
    assert.equal(list.find((u) => u.username === SPEC.username)?.role, 'specialist');
    await app.close();
  });

  it('his templates, his companies\' UISP, an installation written, tested and authorized', async () => {
    const { app, db, fake, call, A, S, S2 } = await setup();

    // ---- the form of the CPE's web interface, apart from CDA Net's
    const form = (await call('GET', '/api/specialist/template-form', S)).json();
    const fields = form.fields as Array<{ id: string; param?: boolean }>;
    assert.ok(fields.some((f) => f.id === 'watchdog'), 'the watchdog is a choice of his templates');
    assert.ok(!fields.some((f) => f.param), 'no value forced by the server');
    const draft = (await call('POST', '/api/specialist/form/LiteBeam%205AC/read', S, {})).json();
    assert.equal(draft.values.watchdogHost, '8.8.8.8');
    const edited = (await call('POST', '/api/specialist/form/LiteBeam%205AC/apply', S, { template: draft.template, changes: { lanIp: '192.168.10.1', watchdogHost: '9.9.9.9', watchdog: true } })).json();
    const keys = parseKeys(edited.template);
    assert.equal(keys.get('pwdog.host'), '9.9.9.9', 'in the text itself');
    assert.equal(edited.values.lanIp, '192.168.10.1');
    // a VLAN and a placeholder of his own: allowed in his templates
    const text = `${edited.template}vlan.1.id=\${VLAN_ID}\n`;
    const created = await call('POST', '/api/specialist/templates', S, { model: 'LiteBeam 5AC', name: 'Azienda X · LiteBeam', template: text, notes: 'Station PPPoE con VLAN' });
    assert.equal(created.statusCode, 201, created.body);
    const tpl = created.json();
    assert.deepEqual(tpl.own, ['VLAN_ID']);
    assert.equal(tpl.boardMatch, 'board\\.name=LiteBeam 5AC');
    assert.equal((await call('POST', '/api/specialist/templates', S, { model: 'LiteBeam 5AC', name: 'azienda x · litebeam', template: text })).json().error, 'template_name_exists');
    // the same template text refused by CDA Net's archive (VLAN): his archive is apart
    assert.equal((await call('POST', '/api/admin/profiles/LiteBeam%205AC/templates', A, { name: 'Con VLAN', template: text, boardMatch: 'board\\.name=LiteBeam' })).json().error, 'profile_contains_vlan');

    // a CDA Net template as a start: the copy is his, without CDA Net's secrets
    const cda = await call('POST', '/api/admin/profiles/LiteBeam%205AC/templates', A, { name: 'Standard', template: SAMPLE_TEMPLATE, boardMatch: 'board\\.name=LiteBeam', secrets: { snmpCommunity: 'community-cda-net' } });
    assert.equal(cda.statusCode, 201, cda.body);
    const copy = await call('POST', '/api/specialist/templates/copy', S, { fromId: cda.json().id, name: 'Da CDA Net' });
    assert.equal(copy.statusCode, 201, copy.body);
    assert.equal(copy.json().secretsSet.snmpCommunity, false);
    const copied = (await call('GET', `/api/specialist/templates/${copy.json().id}`, S)).json();
    assert.equal(parseKeys(copied.template).get('pwdog.status'), 'enabled', 'what CDA Net forces becomes the text');
    assert.ok(!JSON.stringify(copied).includes('community-cda-net'));
    assert.equal((await call('GET', `/api/admin/templates/${cda.json().id}`, A)).json().name, 'Standard', 'the original stays');

    // ---- the UISP of the company: token and key sealed, never returned
    const conn = await call('POST', '/api/specialist/connectors', S, {
      name: 'Azienda X',
      url: 'https://uisp.azienda-x.test/nms/api/v2.1',
      token: 'tok-secret',
      uispKey: 'wss://uisp.azienda-x.test:443+chiave-dispositivi+allowSelfSignedCertificate',
    });
    assert.equal(conn.statusCode, 201, conn.body);
    const c = conn.json();
    assert.equal(c.url, 'https://uisp.azienda-x.test');
    assert.deepEqual([c.tokenSet, c.tokenHint, c.uispKeySet], [true, '…cret', true]);
    assert.ok(!conn.body.includes('tok-secret') && !conn.body.includes('chiave-dispositivi'));
    const test = (await call('POST', `/api/specialist/connectors/${c.id}/test`, S)).json();
    assert.equal(test.ok, true, JSON.stringify(test));
    assert.equal((await call('GET', '/api/specialist/connectors', S)).json().items[0].lastTest.ok, true);
    assert.equal((await call('POST', '/api/specialist/connectors/test', S, { url: 'https://uisp.azienda-x.test', token: 'sbagliato' })).json().error, 'uisp_auth_failed');
    const sites = (await call('GET', `/api/specialist/connectors/${c.id}/sites`, S)).json() as Array<{ id: string; name: string }>;
    assert.ok(sites.some((x) => x.id === 'site-n2'));

    // ---- what is typed for this template (the key of the devices comes from the connector)
    const asked = (await call('GET', `/api/specialist/templates/${tpl.id}/values?connectorId=${c.id}`, S)).json();
    const names = (asked.asked as Array<{ name: string; secret: boolean }>).map((a) => a.name);
    for (const n of ['SSID', 'WPA2_PSK', 'PPPOE_USER', 'PPPOE_PASSWORD', 'DEVICE_NAME', 'VLAN_ID', 'SNMP_COMMUNITY']) assert.ok(names.includes(n), `${n} in ${names}`);
    for (const n of ['UISP_ENROLLMENT', 'CPE_PASSWORD_HASH', 'CPE_USERNAME', 'SNMP_LOCATION']) assert.ok(!names.includes(n), `${n} filled by the server`);
    assert.equal((asked.asked as Array<{ name: string; secret: boolean }>).find((a) => a.name === 'WPA2_PSK')?.secret, true);

    // ---- the installation: only the app asks for it, the values typed go into the file only
    const body = {
      templateId: tpl.id,
      connectorId: c.id,
      model: 'LiteBeam 5AC',
      mac: 'aa:bb:cc:dd:ee:ff',
      firmware: 'XC.qca956x.v8.7.4.45112.210415.1103',
      host: '192.168.1.20',
      cpe: { username: 'admin-x', password: CPE_PASSWORD },
      values: { SSID: 'AZIENDA-X-AP3', WPA2_PSK: WIFI, PPPOE_USER: 'rossi@azienda-x.it', PPPOE_PASSWORD, DEVICE_NAME: 'ROSSI MARIO', VLAN_ID: '87', SNMP_COMMUNITY: 'comm-x' },
      customer: 'Rossi Mario',
      location: { latitude: 37.5801, longitude: 14.1202, source: 'gps' },
    };
    assert.equal((await call('POST', '/api/specialist/jobs', S, body)).json().error, 'trusted_client_required');
    assert.equal((await call('POST', '/api/specialist/jobs', { ...S, ...APP }, { ...body, values: { ...body.values, WPA2_PSK: undefined } })).json().error, 'missing_value_WPA2_PSK');
    assert.equal((await call('POST', '/api/specialist/jobs', { ...S, ...APP }, { ...body, values: { ...body.values, WPA2_PSK: 'corta' } })).json().error, 'invalid_value_WPA2_PSK');
    assert.equal((await call('POST', '/api/specialist/jobs', { ...S, ...APP }, { ...body, model: 'NanoBeam 5AC' })).json().error, 'template_model_mismatch');
    assert.equal((await call('POST', '/api/specialist/jobs', { ...S, ...APP }, { ...body, host: '8.8.8.8' })).json().error, 'target_not_private');
    const prep = await call('POST', '/api/specialist/jobs', { ...S, ...APP }, body);
    assert.equal(prep.statusCode, 201, prep.body);
    const pkg = prep.json();
    const k = parseKeys(pkg.config.text);
    assert.equal(k.get('wpasupplicant.profile.1.network.1.psk'), WIFI);
    assert.equal(k.get('ppp.1.password'), PPPOE_PASSWORD);
    assert.equal(k.get('vlan.1.id'), '87');
    assert.equal(k.get('unms.uri'), 'wss://uisp.azienda-x.test:443+chiave-dispositivi+allowSelfSignedCertificate');
    assert.equal(k.get('users.1.name'), 'admin-x');
    assert.match(k.get('users.1.password') ?? '', /^\$1\$/);
    assert.equal(k.get('snmp.location'), 'ROSSI MARIO');
    assert.equal(k.get('system.latitude'), '37.580100');
    assert.equal(pkg.config.sha256, createHash('sha256').update(pkg.config.text).digest('hex'));
    assert.deepEqual(pkg.target, { host: '192.168.1.20', sshPort: 22 });
    assert.deepEqual(pkg.credentials, { username: 'admin-x', password: CPE_PASSWORD });
    assert.equal(pkg.checks.mac, 'AA:BB:CC:DD:EE:FF');
    assert.equal(pkg.checks.firmwareBypass, true);
    assert.equal(pkg.summary.deviceName, 'ROSSI MARIO');
    // nothing typed is kept: only the SHA-256 of the file
    const row = JSON.stringify(db.prepare('SELECT * FROM specialist_jobs WHERE id = ?').get(pkg.jobId));
    for (const secret of [WIFI, PPPOE_PASSWORD, CPE_PASSWORD, 'chiave-dispositivi', 'comm-x']) assert.ok(!row.includes(secret), `${secret} not stored`);
    assert.ok(row.includes(pkg.config.sha256));

    // the write, the acceptance test of his own, the history
    assert.equal((await call('POST', `/api/specialist/jobs/${pkg.jobId}/result`, S, { result: 'success', stages: ['Configurazione salvata in flash (cfgmtd)'], detected: { firmware: 'v8.7.4', mac: 'AA:BB:CC:DD:EE:FF' } })).json().ok, true);
    assert.equal((await call('POST', `/api/specialist/jobs/${pkg.jobId}/result`, S, { result: 'success' })).json().duplicate, true);
    const acc = await call('PUT', `/api/specialist/jobs/${pkg.jobId}/acceptance`, S, { verdict: 'ok', radio: { signal: -58, ccq: 98 }, speedtest: { downMbps: 95.5, upMbps: 20.1 }, notes: 'Allineata al primo colpo' });
    assert.equal(acc.statusCode, 200, acc.body);
    assert.equal(acc.json().acceptance.verdict, 'ok');
    const hist = (await call('GET', '/api/specialist/jobs?q=rossi', S)).json();
    assert.equal(hist.total, 1);
    assert.equal(hist.items[0].company, 'Azienda X');
    assert.equal((await call('GET', '/api/specialist/jobs?status=to_authorize', S)).json().total, 1);
    assert.deepEqual((await call('GET', '/api/specialist/summary', S)).json(), { templates: 2, connectors: 1, jobs30d: 1, success30d: 1, toAuthorize: 1, failed30d: 0 });

    // ---- the CPE in the company's UISP: found by MAC, authorized in the site of its AP
    const state = (await call('GET', `/api/specialist/jobs/${pkg.jobId}/uisp`, S)).json();
    assert.equal(state.device.id, 'cpe-1');
    assert.equal(state.device.authorized, false);
    assert.deepEqual(state.proposedSite, { id: 'site-n2', name: 'Nodo 2 - Monte' });
    const auth = await call('POST', `/api/specialist/jobs/${pkg.jobId}/uisp/authorize`, S, {});
    assert.equal(auth.statusCode, 200, auth.body);
    assert.equal(auth.json().site, 'Nodo 2 - Monte');
    assert.ok(fake.calls.some((x) => x.method === 'POST' && x.path === '/devices/cpe-1/authorize'));
    assert.ok(auth.json().job.uisp.authorizedAt);
    assert.equal((await call('POST', `/api/specialist/jobs/${pkg.jobId}/uisp/authorize`, S, {})).json().error, 'uisp_already_authorized');

    // the CSV for Excel, without secrets
    const csv = await call('GET', '/api/specialist/jobs.csv', S);
    assert.equal(csv.statusCode, 200);
    assert.ok(csv.body.includes('Azienda X') && csv.body.includes('ROSSI MARIO'));
    assert.ok(!csv.body.includes(WIFI));

    // apart from CDA Net's history, and from the other specialists
    const cdaJobs = (await call('GET', '/api/provisioning/jobs', A)).json() as Array<{ mac: string }>;
    assert.ok(!cdaJobs.some((j) => j.mac === 'AA:BB:CC:DD:EE:FF'));
    assert.deepEqual((await call('GET', '/api/specialist/templates', S2)).json(), []);
    assert.equal((await call('GET', `/api/specialist/jobs/${pkg.jobId}`, S2)).statusCode, 404);
    assert.equal((await call('GET', `/api/specialist/connectors/${c.id}/sites`, S2)).statusCode, 404);

    // a connector removed: the installation keeps the company's name
    assert.equal((await call('DELETE', `/api/specialist/connectors/${c.id}`, S)).json().ok, true);
    const after = (await call('GET', `/api/specialist/jobs/${pkg.jobId}`, S)).json();
    assert.equal(after.company, 'Azienda X');
    assert.equal(after.connector, null);
    // the activity log says what was done, never a value typed
    const events = JSON.stringify(db.prepare("SELECT action, target, detail FROM events WHERE action LIKE 'specialist.%'").all());
    assert.ok(events.includes('specialist.uisp_authorize'));
    for (const secret of [WIFI, PPPOE_PASSWORD, CPE_PASSWORD, 'tok-secret']) assert.ok(!events.includes(secret));
    await app.close();
  });

  // first the configuration, then the CPE (titolare, 17/10/2026): no management Wi-Fi to prepare it
  it('a configuration prepared before connecting to the CPE: MAC and serial come with the write', async () => {
    const { app, db, call, S } = await setup();
    const draft = (await call('POST', '/api/specialist/form/LiteBeam%205AC/read', S, {})).json();
    const created = await call('POST', '/api/specialist/templates', S, { model: 'LiteBeam 5AC', name: 'Prima la configurazione', template: draft.template });
    assert.equal(created.statusCode, 201, created.body);
    const tpl = created.json();
    const conn = await call('POST', '/api/specialist/connectors', S, { name: 'Azienda Y', url: 'https://uisp.azienda-x.test', token: 'tok-secret', uispKey: 'wss://uisp.azienda-x.test:443+chiave-y+allowSelfSignedCertificate' });
    assert.equal(conn.statusCode, 201, conn.body);
    const connectorId = conn.json().id as number;
    const asked = (await call('GET', `/api/specialist/templates/${tpl.id}/values?connectorId=${connectorId}`, S)).json().asked as Array<{ name: string }>;
    const values = Object.fromEntries(asked.map((a) => [a.name, a.name === 'WPA2_PSK' ? WIFI : a.name === 'SSID' ? 'AZIENDA-Y-AP1' : `${a.name.toLowerCase()}-1`]));
    const body = { templateId: tpl.id, connectorId, model: 'LiteBeam 5AC', cpe: { username: 'admin-y', password: CPE_PASSWORD }, values, customer: 'Bianchi Anna' };

    // no MAC, serial, firmware or address: the app reads them from the CPE at the write
    const prep = await call('POST', '/api/specialist/jobs', { ...S, ...APP }, body);
    assert.equal(prep.statusCode, 201, prep.body);
    const pkg = prep.json();
    assert.equal(pkg.checks.mac, '');
    assert.equal(pkg.summary.mac, '');
    assert.equal(pkg.target.sshPort, 22);
    const job = (id: string) => call('GET', `/api/specialist/jobs/${id}`, S).then((r) => r.json());
    const prepared = await job(pkg.jobId);
    assert.deepEqual([prepared.mac, prepared.cpeAtWrite, prepared.status], ['', true, 'prepared']);
    assert.equal((await call('GET', `/api/specialist/jobs/${pkg.jobId}/uisp`, S)).json().error, 'job_not_completed', 'no MAC yet to look for in UISP');

    // the outcome says which CPE was written: a failed write on one, then a success on another
    const url = `/api/specialist/jobs/${pkg.jobId}/result`;
    assert.equal((await call('POST', url, S, { result: 'success', stages: [] })).json().error, 'cpe_mac_required');
    assert.equal((await call('POST', url, S, { result: 'success', cpe: { mac: '81:78:00:00:00:01' } })).statusCode, 400, 'not a device MAC');
    const failed = await call('POST', url, S, { result: 'failed', error: 'Board non corrispondente', cpe: { mac: 'aabbcc000001', serial: 'SER-A' }, completedAt: '2026-10-17T18:00:00.000Z' });
    assert.equal(failed.statusCode, 200, failed.body);
    assert.equal((await job(pkg.jobId)).mac, 'AA:BB:CC:00:00:01');
    const ok = await call('POST', url, S, { result: 'success', stages: ['Configurazione salvata in flash (cfgmtd)'], cpe: { mac: 'AA:BB:CC:00:00:02', serial: 'SER-B' }, completedAt: '2026-10-17T18:05:00.000Z' });
    assert.equal(ok.statusCode, 200, ok.body);
    const written = await job(pkg.jobId);
    assert.deepEqual([written.mac, written.serial, written.status, written.attempts], ['AA:BB:CC:00:00:02', 'SER-B', 'success', 2]);
    assert.equal((await call('POST', url, S, { result: 'success', cpe: { mac: 'AA:BB:CC:00:00:03' } })).json().duplicate, true);
    assert.equal((await job(pkg.jobId)).mac, 'AA:BB:CC:00:00:02', 'a success is final');
    const row = JSON.stringify(db.prepare('SELECT * FROM specialist_jobs WHERE id = ?').get(pkg.jobId));
    for (const secret of [WIFI, CPE_PASSWORD, 'chiave-y']) assert.ok(!row.includes(secret), `${secret} not stored`);

    // a template with the serial of the CPE in it: the CPE is read first
    const text = draft.template.replace('resolv.host.1.name=${DEVICE_NAME}', 'resolv.host.1.name=CPE-${EXPECTED_SERIAL}');
    assert.notEqual(text, draft.template);
    const withSerial = await call('POST', '/api/specialist/templates', S, { model: 'LiteBeam 5AC', name: 'Nome dal seriale', template: text });
    assert.equal(withSerial.statusCode, 201, withSerial.body);
    const again = { ...body, templateId: withSerial.json().id };
    assert.equal((await call('POST', '/api/specialist/jobs', { ...S, ...APP }, again)).json().error, 'template_needs_cpe');
    const read = await call('POST', '/api/specialist/jobs', { ...S, ...APP }, { ...again, mac: 'AA:BB:CC:00:00:04', serial: 'SER-C', host: '192.168.1.20' });
    assert.equal(read.statusCode, 201, read.body);
    assert.match(read.json().config.text, /^resolv\.host\.1\.name=CPE-SER-C$/m);
    assert.equal((await job(read.json().jobId)).cpeAtWrite, false);
    // prepared with the CPE read: the outcome needs nothing more
    assert.equal((await call('POST', `/api/specialist/jobs/${read.json().jobId}/result`, S, { result: 'success' })).statusCode, 200);
    await app.close();
  });
});
