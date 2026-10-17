import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { ADMIN, SAMPLE_TEMPLATE, testConfig } from './helpers.ts';

const A_ = { username: 'spec.a', password: 'Specialist-Password-A1' };
const B_ = { username: 'spec.b', password: 'Specialist-Password-B1' };
const C_ = { username: 'spec.c', password: 'Specialist-Password-C1' };
const I_ = { username: 'tecnico', password: 'Installer-Password-1' };

describe('Gruppi di lavoro degli Specialist (issue #275)', () => {
  it('the members share templates, installations and calendar; nobody else sees them, connectors stay personal', async () => {
    const db = openDatabase(':memory:');
    const { app } = await buildApp(testConfig(), 'test', { db, logger: false, uisp: null });
    const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, headers: Record<string, string>, payload?: object) => app.inject({ method, url, headers, payload });
    const login = async (u: { username: string; password: string }) => {
      const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: u });
      assert.equal(r.statusCode, 200, r.body);
      return { authorization: `Bearer ${r.json().token}` };
    };
    const ADM = await login(ADMIN);
    const ids: Record<string, number> = {};
    for (const [u, role] of [[A_, 'specialist'], [B_, 'specialist'], [C_, 'specialist'], [I_, 'installer']] as const) {
      const r = await call('POST', '/api/admin/users', ADM, { ...u, role });
      assert.equal(r.statusCode, 201, r.body);
      ids[u.username] = r.json().id;
    }
    const A = await login(A_);
    const B = await login(B_);
    const C = await login(C_);
    const a = ids['spec.a']!;
    const b = ids['spec.b']!;

    // only the admins make groups, only of specialists
    assert.equal((await call('POST', '/api/admin/work-groups', A, { name: 'Squadra Nord', members: [a, b] })).statusCode, 403);
    assert.equal((await call('POST', '/api/admin/work-groups', ADM, { name: 'Con installatore', members: [a, ids.tecnico!] })).json().error, 'work_group_specialists_only');
    const g = await call('POST', '/api/admin/work-groups', ADM, { name: 'Squadra Nord', members: [a, b] });
    assert.equal(g.statusCode, 201, g.body);
    assert.equal((await call('POST', '/api/admin/work-groups', ADM, { name: 'squadra nord' })).json().error, 'work_group_name_exists');
    assert.deepEqual(
      (await call('GET', '/api/specialist/work-groups', B)).json().items.map((x: { name: string; members: Array<{ username: string }> }) => [x.name, x.members.map((m) => m.username)]),
      [['Squadra Nord', ['spec.a', 'spec.b']]],
    );
    assert.deepEqual((await call('GET', '/api/specialist/work-groups', C)).json().items, []);

    // a template of A: B sees it, uses it and (choice of the review) changes it; only A deletes it; C nothing
    const t = await call('POST', '/api/specialist/templates', A, { model: 'LiteBeam 5AC', name: 'Azienda X', template: SAMPLE_TEMPLATE, snmpCommunity: 'community-di-a' });
    assert.equal(t.statusCode, 201, t.body);
    const tid = t.json().id as number;
    const listB = (await call('GET', '/api/specialist/templates', B)).json() as Array<{ id: number; author: string; authorId: number }>;
    assert.deepEqual(
      listB.map((x) => [x.id, x.author, x.authorId]),
      [[tid, 'spec.a', a]],
    );
    assert.equal((await call('GET', `/api/specialist/templates/${tid}`, B)).statusCode, 200);
    const edit = await call('PATCH', `/api/specialist/templates/${tid}`, B, { notes: 'rivisto da B' });
    assert.equal(edit.statusCode, 200, edit.body);
    assert.equal((await call('DELETE', `/api/specialist/templates/${tid}`, B)).statusCode, 404, 'only its author deletes it');
    assert.deepEqual((await call('GET', '/api/specialist/templates', C)).json(), []);
    assert.equal((await call('GET', `/api/specialist/templates/${tid}`, C)).statusCode, 404);
    assert.equal((await call('PATCH', `/api/specialist/templates/${tid}`, C, { notes: 'x' })).statusCode, 404);
    assert.ok(!JSON.stringify((await call('GET', `/api/specialist/templates/${tid}`, B)).json()).includes('community-di-a'), 'the community stays sealed');

    // a connector of A: never B's
    const conn = await call('POST', '/api/specialist/connectors', A, { name: 'UISP Azienda X', url: 'https://uisp.azienda-x.example', token: 'token-segreto-di-a-123456' });
    assert.equal(conn.statusCode, 201, conn.body);
    assert.deepEqual((await call('GET', '/api/specialist/connectors', B)).json().items, []);
    assert.equal((await call('GET', `/api/specialist/connectors/${conn.json().id}/sites`, B)).statusCode, 404);

    // an installation of A: B reads it (list, detail, CSV), cannot act on it; C nothing
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO specialist_jobs(id, user_id, username, created_at, expires_at, status, model, mac, customer, template_id, template_name) VALUES('7d3f2a10-1b2c-4d5e-8f90-a1b2c3d4e5f6', ?, 'spec.a', ?, ?, 'success', 'LiteBeam 5AC', 'AA:BB:CC:00:00:01', 'Rossi', ?, 'Azienda X')",
    ).run(a, now, now, tid);
    const jobsB = (await call('GET', '/api/specialist/jobs', B)).json();
    assert.deepEqual(
      jobsB.items.map((j: { id: string; author: string }) => [j.id, j.author]),
      [['7d3f2a10-1b2c-4d5e-8f90-a1b2c3d4e5f6', 'spec.a']],
    );
    assert.equal((await call('GET', '/api/specialist/jobs/7d3f2a10-1b2c-4d5e-8f90-a1b2c3d4e5f6', B)).statusCode, 200);
    assert.match((await call('GET', '/api/specialist/jobs.csv', B)).body, /spec\.a/);
    assert.equal((await call('DELETE', '/api/specialist/jobs/7d3f2a10-1b2c-4d5e-8f90-a1b2c3d4e5f6', B)).statusCode, 404, 'read only for the group');
    assert.equal((await call('PUT', '/api/specialist/jobs/7d3f2a10-1b2c-4d5e-8f90-a1b2c3d4e5f6/acceptance', B, { verdict: 'ok' })).statusCode, 404);
    assert.equal((await call('GET', '/api/specialist/jobs', C)).json().items.length, 0);
    assert.equal((await call('GET', '/api/specialist/jobs/7d3f2a10-1b2c-4d5e-8f90-a1b2c3d4e5f6', C)).statusCode, 404);
    assert.doesNotMatch((await call('GET', '/api/specialist/jobs.csv', C)).body, /spec\.a/);

    // the calendar: B sees A's orders, C does not, nobody sees CDA Net's installer
    const order = (who: number, customer: string) =>
      db.prepare("INSERT INTO work_orders(created_at, updated_at, day, kind, status, assigned_to, customer) VALUES(?,?,?,?,?,?,?)").run(now, now, '2026-10-21', 'new', 'open', who, customer);
    order(a, 'Lavoro di A');
    order(ids.tecnico!, 'Lavoro di CDA Net');
    const cal = async (h: Record<string, string>) =>
      (await call('GET', '/api/work-orders/calendar?from=2026-10-20&to=2026-10-26', h)).json() as { items: Array<{ customer: string }>; installers?: unknown };
    const calB = await cal(B);
    assert.deepEqual([calB.items.map((o) => o.customer), calB.installers], [['Lavoro di A'], undefined]);
    assert.deepEqual((await cal(C)).items, []);

    // B leaves the group: at once nothing of A
    const out = await call('PUT', `/api/admin/work-groups/${g.json().id}`, ADM, { members: [a] });
    assert.equal(out.statusCode, 200, out.body);
    assert.deepEqual((await call('GET', '/api/specialist/templates', B)).json(), []);
    assert.equal((await call('GET', '/api/specialist/jobs/7d3f2a10-1b2c-4d5e-8f90-a1b2c3d4e5f6', B)).statusCode, 404);
    assert.deepEqual((await cal(B)).items, []);
    // the work keeps its author
    assert.equal((await call('GET', '/api/specialist/templates', A)).json().length, 1);

    // the admin sees who is in which group; the log says it
    const users = (await call('GET', '/api/admin/users', ADM)).json() as Array<{ username: string; workGroups: Array<{ name: string }> }>;
    assert.deepEqual(users.find((u) => u.username === 'spec.a')?.workGroups.map((x) => x.name), ['Squadra Nord']);
    const ev = db.prepare("SELECT action, detail FROM events WHERE action LIKE 'work_group.%' ORDER BY id").all() as Array<{ action: string; detail: string }>;
    assert.deepEqual(
      ev.map((e) => e.action),
      ['work_group.create', 'work_group.update'],
    );
    assert.match(ev[1]!.detail, /usciti: spec\.b/);
    assert.equal((await call('DELETE', `/api/admin/work-groups/${g.json().id}`, ADM)).statusCode, 200);
    await app.close();
  });

  it('«visibilità piena» is personal: never passed on to the members, nor from one group to another', async () => {
    const db = openDatabase(':memory:');
    const { app } = await buildApp(testConfig(), 'test', { db, logger: false, uisp: null });
    const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, headers: Record<string, string>, payload?: object) => app.inject({ method, url, headers, payload });
    const login = async (u: { username: string; password: string }) => {
      const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: u });
      assert.equal(r.statusCode, 200, r.body);
      return { authorization: `Bearer ${r.json().token}` };
    };
    const ADM = await login(ADMIN);
    const ids: Record<string, number> = {};
    for (const u of [A_, B_, C_]) ids[u.username] = (await call('POST', '/api/admin/users', ADM, { ...u, role: 'specialist' })).json().id;
    const inst = (await call('POST', '/api/admin/users', ADM, { ...I_, role: 'installer' })).json().id as number;
    const a = ids['spec.a']!;
    const b = ids['spec.b']!;
    const c = ids['spec.c']!;
    // A: «visibilità piena», in two groups (with B, with C)
    assert.equal((await call('PATCH', `/api/admin/users/${a}`, ADM, { fullView: true })).statusCode, 200);
    assert.equal((await call('POST', '/api/admin/work-groups', ADM, { name: 'Gruppo AB', members: [a, b] })).statusCode, 201);
    assert.equal((await call('POST', '/api/admin/work-groups', ADM, { name: 'Gruppo AC', members: [a, c] })).statusCode, 201);
    const A = await login(A_);
    const B = await login(B_);
    const C = await login(C_);

    // B and C do not see CDA Net's data through A
    for (const h of [B, C]) {
      assert.equal((await call('GET', '/api/admin/status', h)).statusCode, 403);
      assert.equal((await call('GET', '/api/admin/work-orders', h)).statusCode, 403);
    }
    assert.equal((await call('GET', '/api/admin/status', A)).statusCode, 200);
    // a CDA Net order of an installer: A sees it, the members do not
    const now = new Date().toISOString();
    db.prepare("INSERT INTO work_orders(created_at, updated_at, day, kind, status, assigned_to, customer) VALUES(?,?,?,?,?,?,?)").run(now, now, '2026-10-21', 'new', 'open', inst, 'Cliente CDA Net');
    const cal = async (h: Record<string, string>) => (await call('GET', '/api/work-orders/calendar?from=2026-10-20&to=2026-10-26', h)).json().items as Array<{ customer: string }>;
    assert.equal((await cal(A)).length, 1);
    assert.deepEqual(await cal(B), []);

    // a CDA Net template kept for one installer: A (full view) copies it, the copy does not reach B
    const cda = await call('POST', '/api/admin/profiles/LiteBeam%205AC/templates', ADM, { name: 'Riservato', template: SAMPLE_TEMPLATE, boardMatch: 'board\.name=LiteBeam', audience: 'users', userIds: [inst] });
    assert.equal(cda.statusCode, 201, cda.body);
    assert.equal((await call('POST', '/api/specialist/templates/copy', B, { fromId: cda.json().id, name: 'Tentativo' })).statusCode, 404, 'B may not use it');
    const copy = await call('POST', '/api/specialist/templates/copy', A, { fromId: cda.json().id, name: 'Copia del riservato' });
    assert.equal(copy.statusCode, 201, copy.body);
    const own = await call('POST', '/api/specialist/templates', A, { model: 'LiteBeam 5AC', name: 'Suo di A', template: SAMPLE_TEMPLATE });
    assert.equal(own.statusCode, 201, own.body);
    const names = async (h: Record<string, string>) => ((await call('GET', '/api/specialist/templates', h)).json() as Array<{ name: string }>).map((t) => t.name).sort();
    assert.deepEqual(await names(A), ['Copia del riservato', 'Suo di A']);
    assert.deepEqual(await names(B), ['Suo di A'], 'the copy of a CDA Net template B may not use stays with A');
    assert.equal((await call('GET', `/api/specialist/templates/${copy.json().id}`, B)).statusCode, 404);
    assert.equal((await call('PATCH', `/api/specialist/templates/${copy.json().id}`, B, { notes: 'x' })).statusCode, 404);

    // two groups do not add up: B (with A) does not see C's work, C (with A) not B's
    const tc = await call('POST', '/api/specialist/templates', C, { model: 'LiteBeam 5AC', name: 'Suo di C', template: SAMPLE_TEMPLATE });
    assert.equal(tc.statusCode, 201, tc.body);
    const tb = await call('POST', '/api/specialist/templates', B, { model: 'LiteBeam 5AC', name: 'Suo di B', template: SAMPLE_TEMPLATE });
    assert.equal(tb.statusCode, 201, tb.body);
    assert.deepEqual(await names(B), ['Suo di A', 'Suo di B']);
    assert.deepEqual(await names(C), ['Suo di A', 'Suo di C']);
    assert.deepEqual(await names(A), ['Copia del riservato', 'Suo di A', 'Suo di B', 'Suo di C']);

    // A is the «direttore tecnico»: the work of every specialist, also outside his groups, and the groups
    const d = (await call('POST', '/api/admin/users', ADM, { username: 'spec.d', password: 'Specialist-Password-D1', role: 'specialist' })).json().id as number;
    const D = await login({ username: 'spec.d', password: 'Specialist-Password-D1' });
    assert.equal((await call('POST', '/api/specialist/templates', D, { model: 'LiteBeam 5AC', name: 'Suo di D', template: SAMPLE_TEMPLATE })).statusCode, 201);
    assert.ok((await names(A)).includes('Suo di D'), 'the director sees every specialist');
    assert.ok(!(await names(B)).includes('Suo di D'), 'not the members of his groups');
    const groups = await call('GET', '/api/admin/work-groups', A);
    assert.equal(groups.statusCode, 200);
    assert.deepEqual(groups.json().specialists.map((x: { username: string }) => x.username).sort(), ['spec.a', 'spec.b', 'spec.c', 'spec.d']);
    assert.equal((await call('POST', '/api/admin/work-groups', A, { name: 'Gruppo BD', members: [b, d] })).statusCode, 201);
    assert.ok((await names(B)).includes('Suo di D'), 'now in a group with D');
    assert.equal((await call('POST', '/api/admin/work-groups', B, { name: 'Da solo' })).statusCode, 403, 'a specialist without full view makes no groups');
    assert.equal((await call('PATCH', `/api/admin/users/${b}`, A, { fullView: true })).statusCode, 403, 'full view stays with the admins');
    assert.ok(b !== c);
    await app.close();
  });

  // the secrets of a template are its author's (titolare, 17/10/2026): only his installations use
  // them, another member types his own and changes neither; the NOC hears of every group change
  it('a shared template keeps its secrets with its author; the log and the NOC say who and which group', async () => {
    const TOKEN = '000000:token_finto_dei_test_non_un_segreto';
    const sent: Array<{ text: string }> = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.host !== 'api.telegram.org') return new Response('{}', { status: 404 });
      const method = url.pathname.split('/')[2];
      if (method === 'sendMessage') sent.push(JSON.parse(String(init?.body ?? '{}')));
      return Response.json({ ok: true, result: method === 'getMe' ? { username: 'noc_bot' } : method === 'getUpdates' ? [] : {} });
    }) as typeof fetch;
    const db = openDatabase(':memory:');
    const { app, ctx } = await buildApp(testConfig(), 'test', { db, logger: false, uisp: null, fetchImpl, telegramIntervalMs: 0 });
    const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, headers: Record<string, string>, payload?: object) => app.inject({ method, url, headers, payload });
    const login = async (u: { username: string; password: string }) => {
      const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: u });
      assert.equal(r.statusCode, 200, r.body);
      return { authorization: `Bearer ${r.json().token}` };
    };
    const ADM = await login(ADMIN);
    const tg = await call('PUT', '/api/admin/connectors/telegram', ADM, { enabled: true, token: TOKEN, chatId: '-1001234567890', events: ['security'], summaryHour: 19 });
    assert.equal(tg.statusCode, 200, tg.body);
    const ids: Record<string, number> = {};
    for (const u of [A_, B_]) ids[u.username] = (await call('POST', '/api/admin/users', ADM, { ...u, role: 'specialist' })).json().id;
    const a = ids['spec.a']!;
    const b = ids['spec.b']!;
    const g = await call('POST', '/api/admin/work-groups', ADM, { name: 'Squadra Est', members: [a, b] });
    assert.equal(g.statusCode, 201, g.body);
    const A = await login(A_);
    const B = await login(B_);
    const APP = { 'x-cda-client': 'android/9.9.9' };

    // A's template with his company's SNMP community and the Wi-Fi key of its AP, sealed
    const t = await call('POST', '/api/specialist/templates', A, { model: 'LiteBeam 5AC', name: 'Azienda X · SNMP', template: `${SAMPLE_TEMPLATE}snmp.community=\${SNMP_COMMUNITY}\n`, snmpCommunity: 'community-di-a', wpa2Psk: 'Chiave-WiFi-Di-A-1' });
    assert.equal(t.statusCode, 201, t.body);
    const tid = t.json().id as number;
    const view = (h: Record<string, string>) => call('GET', `/api/specialist/templates/${tid}`, h).then((r) => r.json() as { mine: boolean; secretsSet: { snmpCommunity: boolean } });
    assert.deepEqual([(await view(A)).mine, (await view(B)).mine], [true, false]);
    assert.deepEqual((await view(B)).secretsSet, { snmpCommunity: true, wpa2Psk: true }, 'B knows they are there, never their values');
    const asked = async (h: Record<string, string>) => (await call('GET', `/api/specialist/templates/${tid}/values`, h)).json().asked as Array<{ name: string; secret: boolean }>;
    assert.ok(!(await asked(A)).some((x) => x.name === 'SNMP_COMMUNITY' || x.name === 'WPA2_PSK'), 'the author: his own, sealed');
    assert.equal((await asked(B)).find((x) => x.name === 'SNMP_COMMUNITY')?.secret, true, 'a member types it, hidden');
    assert.equal((await asked(B)).find((x) => x.name === 'WPA2_PSK')?.secret, true, 'the Wi-Fi key too');

    // B installs with A's template: his own community, never A's
    const values = { SSID: 'AZIENDA-X-AP1', WPA2_PSK: 'Chiave-WiFi-Azienda-1', PPPOE_USER: 'rossi', PPPOE_PASSWORD: 'Pppoe-Segreta-1' };
    const job = (h: Record<string, string>, extra: Record<string, string> = {}) =>
      call('POST', '/api/specialist/jobs', { ...h, ...APP }, { templateId: tid, model: 'LiteBeam 5AC', cpe: { username: 'admin-x', password: 'Cpe-Password-X-1' }, values: { ...values, ...extra }, customer: 'Rossi' });
    assert.equal((await job(B)).json().error, 'missing_value_SNMP_COMMUNITY');
    const pkgB = await job(B, { SNMP_COMMUNITY: 'community-di-b' });
    assert.equal(pkgB.statusCode, 201, pkgB.body);
    assert.match(pkgB.json().config.text, /^snmp\.community=community-di-b$/m);
    assert.ok(!pkgB.body.includes('community-di-a'), "the author's community never reaches another member");
    assert.ok(!pkgB.body.includes('Chiave-WiFi-Di-A-1'), "nor the author's Wi-Fi key");
    // only the author sets or clears it; the rest of the template stays shared
    assert.equal((await call('PATCH', `/api/specialist/templates/${tid}`, B, { snmpCommunity: 'community-scelta-da-b' })).json().error, 'template_secrets_author_only');
    assert.equal((await call('PATCH', `/api/specialist/templates/${tid}`, B, { snmpCommunity: null })).json().error, 'template_secrets_author_only');
    assert.equal((await call('PATCH', `/api/specialist/templates/${tid}`, B, { wpa2Psk: 'Chiave-Scelta-Da-B-1' })).json().error, 'template_secrets_author_only');
    assert.equal((await call('PATCH', `/api/specialist/templates/${tid}`, B, { notes: 'rivisto da B' })).statusCode, 200);
    const pkgA = await job(A);
    assert.equal(pkgA.statusCode, 201, pkgA.body);
    assert.match(pkgA.json().config.text, /^snmp\.community=community-di-a$/m, "the author's installations keep his");
    // his key too, when not typed for this CPE
    const { WPA2_PSK: _typed, ...withoutKey } = values;
    const pkgA2 = await call('POST', '/api/specialist/jobs', { ...A, ...APP }, { templateId: tid, model: 'LiteBeam 5AC', cpe: { username: 'admin-x', password: 'Cpe-Password-X-1' }, values: withoutKey, customer: 'Rossi' });
    assert.equal(pkgA2.statusCode, 201, pkgA2.body);
    assert.match(pkgA2.json().config.text, /^wpasupplicant\.profile\.1\.network\.1\.psk=Chiave-WiFi-Di-A-1$/m);

    // the log: whose template and which group, never a secret
    const ev = db.prepare("SELECT u.username who, e.action, e.detail FROM events e JOIN users u ON u.id = e.user_id WHERE e.action LIKE 'specialist.%' ORDER BY e.id").all() as Array<{ who: string; action: string; detail: string }>;
    const byB = ev.filter((e) => e.who === 'spec.b');
    assert.match(byB.find((e) => e.action === 'specialist.template_update')!.detail, /template di spec\.a · gruppo Squadra Est/);
    assert.match(byB.find((e) => e.action === 'specialist.job')!.detail, /template di spec\.a.*gruppo Squadra Est/);
    assert.match(ev.find((e) => e.who === 'spec.a' && e.action === 'specialist.template_create')!.detail, /gruppo Squadra Est/);
    for (const secret of ['community-di-a', 'community-di-b', 'community-scelta-da-b', 'Chiave-WiFi-Di-A-1', 'Chiave-Scelta-Da-B-1', 'Chiave-WiFi-Azienda-1', 'Pppoe-Segreta-1', 'Cpe-Password-X-1']) {
      assert.ok(!JSON.stringify(ev).includes(secret), secret);
    }

    // the NOC: who enters, who leaves, who is no specialist anymore, the group deleted
    assert.equal((await call('PUT', `/api/admin/work-groups/${g.json().id}`, ADM, { members: [a] })).statusCode, 200);
    assert.equal((await call('PUT', `/api/admin/work-groups/${g.json().id}`, ADM, { members: [a, b] })).statusCode, 200);
    assert.equal((await call('PATCH', `/api/admin/users/${b}`, ADM, { role: 'installer' })).statusCode, 200);
    assert.deepEqual(db.prepare('SELECT user_id FROM work_group_members WHERE user_id = ?').all(b), [], 'out of the groups with the role');
    assert.equal((await call('PATCH', `/api/admin/users/${b}`, ADM, { role: 'specialist' })).statusCode, 200);
    const users = (await call('GET', '/api/admin/users', ADM)).json() as Array<{ username: string; workGroups: unknown[] }>;
    assert.deepEqual(users.find((u) => u.username === 'spec.b')?.workGroups, [], 'a specialist again: in no group until an admin decides');
    assert.equal((await call('DELETE', `/api/admin/work-groups/${g.json().id}`, ADM)).statusCode, 200);
    await ctx.telegram.idle();
    const noc = sent.map((m) => m.text).join('\n');
    for (const line of [/Squadra Est<\/b>: creato con spec\.a, spec\.b/, /Squadra Est<\/b>: usciti spec\.b/, /Squadra Est<\/b>: entrati spec\.b/, /spec\.b<\/b> non è più specialist: tolto dai gruppi di lavoro Squadra Est/, /Squadra Est<\/b>: eliminato \(1 membro\)/]) {
      assert.match(noc, line);
    }
    assert.ok(!/community-di|Chiave-WiFi|Chiave-Scelta|Pppoe-Segreta/.test(noc), 'no secret to the NOC');
    await app.close();
  });
});
