import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { todayRome } from '../src/routes/work-orders.ts';
import { fakeUisp } from './fake-uisp.ts';
import { ADMIN, testConfig } from './helpers.ts';

/**
 * #275 (titolare, 17/10/2026): the specialist may be a person outside CDA Net. He sees his own
 * work and that of his work groups (templates, installations, calendar), never the others'; the
 * full view is a permission an admin gives him. The groups are the admins' to make.
 */
const APP = { 'x-cda-client': 'android/9.9.9' };
const WIFI = 'Chiave-WiFi-Gruppo-1';
const CPE_PASSWORD = 'Cpe-Gruppo-Password-1';

async function setup() {
  const fake = fakeUisp();
  const db = openDatabase(':memory:');
  const { app } = await buildApp(testConfig(), 'test', { db, logger: false, uisp: fake.uisp, fetchImpl: fake.fetchImpl });
  await app.ready();
  const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, headers: Record<string, string>, payload?: object) => app.inject({ method, url, headers, payload });
  const login = async (username: string, password: string) => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
    assert.equal(r.statusCode, 200, r.body);
    return { authorization: `Bearer ${r.json().token}` };
  };
  const A = await login(ADMIN.username, ADMIN.password);
  const ids: Record<string, number> = {};
  for (const [u, role] of [['spec.a', 'specialist'], ['spec.b', 'specialist'], ['spec.c', 'specialist'], ['tecnico', 'installer']] as const) {
    const r = await call('POST', '/api/admin/users', A, { username: u, password: `Password-${u}-12345`, role });
    assert.equal(r.statusCode, 201, r.body);
    ids[u] = r.json().id;
  }
  const H = {
    a: await login('spec.a', 'Password-spec.a-12345'),
    b: await login('spec.b', 'Password-spec.b-12345'),
    c: await login('spec.c', 'Password-spec.c-12345'),
    i: await login('tecnico', 'Password-tecnico-12345'),
  };
  return { app, db, call, A, H, ids };
}

describe('Specialist: i propri dati, i gruppi di lavoro, la visibilità piena (#275)', () => {
  it('without the full view: no office agenda, no work of the others, no CDA Net credentials', async () => {
    const { app, call, A, H, ids } = await setup();
    const day = todayRome();
    const order = async (assignedTo: number, customer: string) => {
      const r = await call('POST', '/api/admin/work-orders', A, { assignedTo, day, kind: 'new', customer, lat: 37.57, lon: 14.28 });
      assert.equal(r.statusCode, 201, r.body);
      return r.json().item.id as number;
    };
    const mine = await order(ids['spec.a']!, 'Cliente di A');
    await order(ids['tecnico']!, 'Cliente del tecnico');

    // the office's pages: refused on the server
    for (const url of ['/api/admin/work-orders', '/api/admin/work-orders.csv', `/api/admin/work-orders/${mine}/history`, '/api/admin/events', '/api/admin/stats', '/api/admin/profiles']) {
      assert.equal((await call('GET', url, H.a)).statusCode, 403, url);
    }
    // the calendar: his own orders only, and no list of the installers
    const cal = (await call('GET', `/api/work-orders/calendar?from=${day}&to=${day}`, H.a)).json();
    assert.deepEqual(cal.items.map((o: { customer: string }) => o.customer), ['Cliente di A']);
    assert.equal(cal.installers, undefined);
    assert.deepEqual((await call('GET', `/api/work-orders/calendar?from=${day}&to=${day}&user=${ids['tecnico']}`, H.a)).json().items.map((o: { customer: string }) => o.customer), ['Cliente di A']);
    // CDA Net's history and KO: his own only
    assert.deepEqual((await call('GET', '/api/provisioning/jobs', H.a)).json(), []);
    assert.equal((await call('GET', '/api/installs/ko', H.a)).statusCode, 200);
    // CDA Net's CPE credentials never reach him
    assert.equal((await call('POST', '/api/field/access', { ...H.a, ...APP }, {})).statusCode, 403);
    assert.equal((await call('POST', '/api/field/access', { ...H.i, ...APP }, {})).statusCode, 200, 'installers keep them');

    // the full view, given by an admin: the office's agenda like an admin
    assert.equal((await call('PATCH', `/api/admin/users/${ids['tecnico']}`, A, { fullView: true })).json().error, 'full_view_specialist_only');
    assert.equal((await call('PATCH', `/api/admin/users/${ids['spec.a']}`, A, { fullView: true })).statusCode, 200);
    const users = (await call('GET', '/api/admin/users', A)).json() as Array<{ username: string; fullView: boolean }>;
    assert.equal(users.find((u) => u.username === 'spec.a')?.fullView, true);
    assert.equal(users.find((u) => u.username === 'spec.b')?.fullView, false);
    const all = (await call('GET', `/api/work-orders/calendar?from=${day}&to=${day}`, H.a)).json();
    assert.equal(all.items.length, 2);
    assert.ok(Array.isArray(all.installers));
    assert.equal((await call('GET', '/api/admin/work-orders', H.a)).statusCode, 200);
    // another role: the permission goes, and must be given again
    assert.equal((await call('PATCH', `/api/admin/users/${ids['spec.a']}`, A, { role: 'installer' })).statusCode, 200);
    assert.equal((await call('PATCH', `/api/admin/users/${ids['spec.a']}`, A, { role: 'specialist' })).statusCode, 200);
    assert.equal(((await call('GET', '/api/admin/users', A)).json() as Array<{ username: string; fullView: boolean }>).find((u) => u.username === 'spec.a')?.fullView, false);
    await app.close();
  });

  it('a work group shares templates, installations and calendar; connectors and secrets stay personal', async () => {
    const { app, db, call, A, H, ids } = await setup();
    const day = todayRome();

    // the groups are the admins' to make
    assert.equal((await call('GET', '/api/admin/work-groups', H.a)).statusCode, 403);
    assert.equal((await call('POST', '/api/admin/work-groups', H.a, { name: 'Squadra Sud' })).statusCode, 403);
    const g = await call('POST', '/api/admin/work-groups', A, { name: 'Squadra Sud' });
    assert.equal(g.statusCode, 201, g.body);
    const gid = g.json().id as number;
    assert.equal((await call('POST', '/api/admin/work-groups', A, { name: 'squadra sud' })).json().error, 'work_group_exists');
    assert.equal((await call('PUT', `/api/admin/work-groups/${gid}/members`, A, { userIds: [ids['tecnico']!] })).json().error, 'work_group_member_not_specialist');
    assert.equal((await call('PUT', `/api/admin/work-groups/${gid}/members`, H.a, { userIds: [ids['spec.a']!, ids['spec.c']!] })).statusCode, 403);
    const members = await call('PUT', `/api/admin/work-groups/${gid}/members`, A, { userIds: [ids['spec.a']!, ids['spec.b']!] });
    assert.equal(members.statusCode, 200, members.body);
    assert.deepEqual(members.json().members.map((m: { username: string }) => m.username), ['spec.a', 'spec.b']);
    assert.deepEqual((await call('GET', '/api/specialist/groups', H.a)).json().items, [{ id: gid, name: 'Squadra Sud', members: ['spec.a', 'spec.b'] }]);
    assert.deepEqual((await call('GET', '/api/specialist/groups', H.c)).json().items, []);

    // B's template (with its community) and C's
    const draft = (await call('POST', '/api/specialist/form/LiteBeam%205AC/read', H.b, {})).json();
    const tb = await call('POST', '/api/specialist/templates', H.b, { model: 'LiteBeam 5AC', name: 'Di B', template: draft.template, snmpCommunity: 'community-di-b' });
    assert.equal(tb.statusCode, 201, tb.body);
    const tc = await call('POST', '/api/specialist/templates', H.c, { model: 'LiteBeam 5AC', name: 'Di C', template: draft.template });
    assert.equal(tc.statusCode, 201, tc.body);
    const conn = await call('POST', '/api/specialist/connectors', H.b, { name: 'Azienda di B', url: 'https://uisp.azienda-x.test', token: 'token-di-b', uispKey: 'wss://uisp.azienda-x.test:443+chiave-di-b+allowSelfSignedCertificate' });
    assert.equal(conn.statusCode, 201, conn.body);

    // A sees B's template (not C's), may use and change it, but never its secrets
    const listA = (await call('GET', '/api/specialist/templates', H.a)).json() as Array<{ id: number; name: string; author: string; mine: boolean; secretsSet: { snmpCommunity: boolean } }>;
    assert.deepEqual(listA.map((t) => t.name), ['Di B']);
    assert.deepEqual([listA[0]!.author, listA[0]!.mine, listA[0]!.secretsSet.snmpCommunity], ['spec.b', false, false]);
    assert.equal((await call('GET', `/api/specialist/templates/${tc.json().id}`, H.a)).statusCode, 404);
    assert.equal((await call('GET', `/api/specialist/templates/${tb.json().id}`, H.c)).statusCode, 404);
    assert.deepEqual((await call('GET', '/api/specialist/templates', H.c)).json().map((t: { name: string }) => t.name), ['Di C']);
    const renamed = await call('PATCH', `/api/specialist/templates/${tb.json().id}`, H.a, { notes: 'Rivisto da A' });
    assert.equal(renamed.statusCode, 200, renamed.body);
    assert.equal((await call('PATCH', `/api/specialist/templates/${tb.json().id}`, H.a, { snmpCommunity: 'altra' })).json().error, 'template_secrets_author_only');
    assert.equal((await call('DELETE', `/api/specialist/templates/${tb.json().id}`, H.a)).statusCode, 404, 'only its author removes it');
    assert.deepEqual((await call('GET', '/api/specialist/connectors', H.a)).json().items, [], "B's connectors stay B's");

    // A's installation with B's template: B's community is not his, he types it
    const asked = (await call('GET', `/api/specialist/templates/${tb.json().id}/values`, H.a)).json().asked as Array<{ name: string }>;
    assert.ok(asked.some((x) => x.name === 'SNMP_COMMUNITY'), 'asked to A');
    assert.ok(!(await call('GET', `/api/specialist/templates/${tb.json().id}/values`, H.b)).json().asked.some((x: { name: string }) => x.name === 'SNMP_COMMUNITY'), 'filled for B');
    const values = (names: Array<{ name: string }>) =>
      Object.fromEntries(names.map((x) => [x.name, x.name === 'WPA2_PSK' ? WIFI : x.name === 'SSID' ? 'GRUPPO-AP1' : x.name === 'SNMP_COMMUNITY' ? 'community-di-a' : `${x.name.toLowerCase()}-1`]));
    const job = (h: Record<string, string>, templateId: number, names: Array<{ name: string }>, customer: string) =>
      call('POST', '/api/specialist/jobs', { ...h, ...APP }, { templateId, model: 'LiteBeam 5AC', cpe: { username: 'admin-g', password: CPE_PASSWORD }, values: values(names), customer });
    const ja = await job(H.a, tb.json().id, asked, 'Cliente di A');
    assert.equal(ja.statusCode, 201, ja.body);
    assert.ok(!ja.json().config.text.includes('community-di-b'), "B's secret never reaches A");
    assert.match(ja.json().config.text, /^snmp\.community=community-di-a$/m);
    const askedB = (await call('GET', `/api/specialist/templates/${tb.json().id}/values`, H.b)).json().asked as Array<{ name: string }>;
    const jb = await job(H.b, tb.json().id, askedB, 'Cliente di B');
    assert.equal(jb.statusCode, 201, jb.body);
    assert.match(jb.json().config.text, /^snmp\.community=community-di-b$/m);
    const askedC = (await call('GET', `/api/specialist/templates/${tc.json().id}/values`, H.c)).json().asked as Array<{ name: string }>;
    const jc = await job(H.c, tc.json().id, askedC, 'Cliente di C');
    assert.equal(jc.statusCode, 201, jc.body);
    assert.equal((await job(H.c, tb.json().id, askedC, 'X')).statusCode, 404, "C cannot use B's template");

    // the history: A and B see each other's (list, detail, search, CSV), C only his own
    const customers = async (h: Record<string, string>, q = '') => ((await call('GET', `/api/specialist/jobs${q}`, h)).json().items as Array<{ customer: string }>).map((j) => j.customer).sort();
    assert.deepEqual(await customers(H.a), ['Cliente di A', 'Cliente di B']);
    assert.deepEqual(await customers(H.b), ['Cliente di A', 'Cliente di B']);
    assert.deepEqual(await customers(H.c), ['Cliente di C']);
    assert.deepEqual(await customers(H.a, '?q=Cliente'), ['Cliente di A', 'Cliente di B']);
    assert.deepEqual(await customers(H.c, '?q=Cliente'), ['Cliente di C']);
    const detail = await call('GET', `/api/specialist/jobs/${jb.json().jobId}`, H.a);
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().author, 'spec.b');
    assert.equal((await call('GET', `/api/specialist/jobs/${jb.json().jobId}`, H.c)).statusCode, 404);
    assert.equal((await call('GET', `/api/specialist/jobs/${jc.json().jobId}`, H.a)).statusCode, 404);
    const csvA = (await call('GET', '/api/specialist/jobs.csv', H.a)).body;
    assert.ok(csvA.includes('Cliente di B') && !csvA.includes('Cliente di C'));
    assert.ok(!(await call('GET', '/api/specialist/jobs.csv', H.c)).body.includes('Cliente di B'));
    // reading only: the outcome, the acceptance, the UISP and the deletion stay B's
    assert.equal((await call('POST', `/api/specialist/jobs/${jb.json().jobId}/result`, H.a, { result: 'success' })).statusCode, 404);
    assert.equal((await call('DELETE', `/api/specialist/jobs/${jb.json().jobId}`, H.a)).statusCode, 404);
    assert.equal((await call('GET', `/api/specialist/jobs/${jb.json().jobId}/uisp`, H.a)).statusCode, 404);

    // the calendar: the orders of the group's members, not those of the others
    for (const [u, customer] of [['spec.a', 'Ordine di A'], ['spec.b', 'Ordine di B'], ['spec.c', 'Ordine di C'], ['tecnico', 'Ordine del tecnico']] as const) {
      assert.equal((await call('POST', '/api/admin/work-orders', A, { assignedTo: ids[u], day, kind: 'new', customer, lat: 37.57, lon: 14.28 })).statusCode, 201);
    }
    const cal = async (h: Record<string, string>) => ((await call('GET', `/api/work-orders/calendar?from=${day}&to=${day}`, h)).json().items as Array<{ customer: string }>).map((o) => o.customer).sort();
    assert.deepEqual(await cal(H.a), ['Ordine di A', 'Ordine di B']);
    assert.deepEqual(await cal(H.c), ['Ordine di C']);

    // the activity log: author and group of what the group shares
    const ev = JSON.stringify(db.prepare("SELECT user_id, action, target, detail FROM events WHERE action IN ('specialist.template_update', 'specialist.job')").all());
    assert.ok(ev.includes('gruppo Squadra Sud'), ev);
    assert.ok(ev.includes('template di spec.b'), ev);
    for (const secret of [WIFI, CPE_PASSWORD, 'community-di-b', 'community-di-a', 'token-di-b', 'chiave-di-b']) assert.ok(!ev.includes(secret), secret);

    // B leaves the group: at once A no longer sees B's work, nor B A's
    assert.equal((await call('PUT', `/api/admin/work-groups/${gid}/members`, A, { userIds: [ids['spec.a']!] })).statusCode, 200);
    assert.deepEqual(await customers(H.a), ['Cliente di A']);
    assert.deepEqual(await customers(H.b), ['Cliente di B']);
    assert.equal((await call('GET', `/api/specialist/templates/${tb.json().id}`, H.a)).statusCode, 404);
    assert.deepEqual(await cal(H.a), ['Ordine di A']);
    // the data stay their author's
    assert.equal((await call('GET', `/api/specialist/jobs/${ja.json().jobId}`, H.a)).json().author, 'spec.a');
    assert.equal((await call('DELETE', `/api/admin/work-groups/${gid}`, A)).statusCode, 200);
    assert.deepEqual((await call('GET', '/api/admin/work-groups', A)).json().items, []);
    await app.close();
  });
});
