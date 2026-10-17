import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inflateSync } from 'node:zlib';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { pdfFileName } from '../src/routes/feasibility.ts';
import { fakeUisp } from './fake-uisp.ts';
import { ADMIN, testConfig } from './helpers.ts';

/** The text drawn on the pages of a PDF (its compressed content streams, inflated). */
function pdfText(pdf: Buffer): string {
  const out: string[] = [];
  let at = 0;
  const open = '/Filter /FlateDecode >>\nstream\n';
  for (;;) {
    const head = pdf.indexOf(open, at, 'latin1');
    if (head < 0) break;
    const start = head + open.length;
    const end = pdf.indexOf('\nendstream', start, 'latin1');
    try {
      out.push(inflateSync(pdf.subarray(start, end)).toString('latin1'));
    } catch {
      /* an image stream */
    }
    at = end;
  }
  return out.join('\n');
}

describe('Verifiche salvate', () => {
  it('the PDF of a saved check is named after it', () => {
    assert.equal(pdfFileName('ROSSI MARIO', '2026-10-17T15:00:00Z'), 'fattibilita-rossi-mario-2026-10-17.pdf');
    assert.equal(pdfFileName("D'Angelo & Figli S.r.l. – Città", '2026-10-17T15:00:00Z'), 'fattibilita-d-angelo-figli-s-r-l-citta-2026-10-17.pdf');
    assert.equal(pdfFileName('***', '2026-10-17'), 'fattibilita-punto-2026-10-17.pdf');
  });

  it('coverage and feasibility saved with a name or a customer of ISP Billing, renamed, each user its own', async () => {
    const fake = fakeUisp();
    const db = openDatabase(':memory:');
    const { app } = await buildApp(testConfig(), 'test', { db, logger: false, uisp: fake.uisp, fetchImpl: fake.fetchImpl });
    await app.ready();
    const login = async (username: string, password: string) => (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } })).json().token as string;
    const A = { authorization: `Bearer ${await login(ADMIN.username, ADMIN.password)}` };
    const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object, headers: Record<string, string> = A) => app.inject({ method, url, headers, payload });

    // the copy of ISP Billing: Rossi has a site 40 m from the point, Demo is far away
    db.prepare("INSERT INTO crm_customers(customer_id, name, internal_code, status, address_line1, city, postal_code, state_code) VALUES('c1', 'Rossi Mario', 'CL001', 'active', 'Via Roma 1', 'Enna', '94100', 'EN')").run();
    db.prepare("INSERT INTO crm_customers(customer_id, name, internal_code, status, address_line1, city) VALUES('c2', 'Demo Srl', 'CL002', 'active', 'Zona Industriale', 'Dittaino')").run();
    db.prepare("INSERT INTO crm_addresses(address_id, customer_id, address_line1, city, postal_code, state_code, lat, lng) VALUES('a1', 'c1', 'Contrada Demo 5', 'Enna', '94100', 'EN', 37.5803, 14.1203)").run();
    db.prepare("INSERT INTO crm_addresses(address_id, customer_id, address_line1, city, lat, lng) VALUES('a2', 'c2', 'Zona Industriale', 'Dittaino', 37.5, 14.5)").run();
    db.prepare("INSERT INTO crm_radius(account_id, customer_id, username, account_status, customer_formal) VALUES('r1', 'c1', 'rossi.mario@cda-net.it', 'Attivo', 'ROSSI MARIO')").run();

    // the customers for the name: those near the point, then those matching what is written
    const near = (await call('GET', '/api/admin/saved-checks/customers?lat=37.58&lon=14.12')).json();
    assert.deepEqual(near.near.map((c: { customerId: string; name: string }) => [c.customerId, c.name]), [['c1', 'ROSSI MARIO']], 'the name of the contract');
    assert.ok(near.near[0].distanceM < 60 && near.near[0].address.includes('Contrada Demo 5'), JSON.stringify(near.near[0]));
    assert.deepEqual(near.found, []);
    const typed = (await call('GET', '/api/admin/saved-checks/customers?q=demo&lat=37.58&lon=14.12')).json();
    assert.deepEqual(typed.found.map((c: { customerId: string }) => c.customerId), ['c2'], 'Rossi already among the near ones');

    // a coverage check: saved with the answer the server gives for the same point and options
    const options = { limit: 50, km: 20, height: 6 };
    const live = (await call('GET', '/api/coverage?lat=37.58&lon=14.12&limit=50&km=20&height=6&cpe=auto')).json();
    const saved = await call('POST', '/api/saved-checks', { kind: 'coverage', name: '  Sopralluogo   Rossi ', lat: 37.58, lon: 14.12, label: 'Via Roma 1, 94100 Enna', params: options });
    assert.equal(saved.statusCode, 200, saved.body);
    const s = saved.json();
    assert.equal(s.name, 'Sopralluogo Rossi');
    assert.equal(s.kind, 'coverage');
    assert.deepEqual(s.params, options);
    assert.equal(s.mine, true);
    assert.equal(s.by, ADMIN.username);
    assert.equal(s.summary.aps, live.aps.length);
    assert.equal(s.summary.best?.name ?? null, live.aps[0]?.name ?? null);
    assert.equal(s.point.label, 'Via Roma 1, 94100 Enna');
    assert.ok(!('result' in s), 'the answer only when the check is opened');
    const full = (await call('GET', `/api/saved-checks/${s.id}`)).json();
    assert.equal(full.result.aps.length, live.aps.length, 'the whole answer, as it was');
    // the other operators of the point kept with it (not configured here: said, not an error)
    assert.equal(full.result.operators, null);
    assert.equal(full.result.operatorsError, 'operators_not_configured');
    assert.equal(s.summary.others, null);

    // the customer of ISP Billing: its name when none is written; then renamed, the customer stays
    const linked = (await call('PATCH', `/api/saved-checks/${s.id}`, { customerId: 'c1' })).json();
    assert.equal(linked.name, 'ROSSI MARIO');
    assert.deepEqual(linked.customer, { id: 'c1', name: 'ROSSI MARIO', code: 'CL001' });
    const renamed = (await call('PATCH', `/api/saved-checks/${s.id}`, { name: 'Rossi – casa al mare' })).json();
    assert.equal(renamed.name, 'Rossi – casa al mare');
    assert.equal(renamed.customer.id, 'c1');
    assert.equal((await call('PATCH', `/api/saved-checks/${s.id}`, { customerId: 'nope' })).statusCode, 404);
    const unlinked = (await call('PATCH', `/api/saved-checks/${s.id}`, { customerId: null })).json();
    assert.equal(unlinked.customer, null);
    assert.equal(unlinked.name, 'Rossi – casa al mare', 'the name written stays');

    // saved straight with a customer: its name
    const second = await call('POST', '/api/saved-checks', { kind: 'coverage', name: '', customerId: 'c2', lat: 37.5, lon: 14.5 });
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().name, 'Demo Srl');
    assert.equal(second.json().customer.code, 'CL002');
    assert.equal((await call('POST', '/api/saved-checks', { kind: 'coverage', lat: 200, lon: 14 })).statusCode, 400);
    assert.equal((await call('POST', '/api/saved-checks', { kind: 'coverage', customerId: 'nope', lat: 37.5, lon: 14.5 })).statusCode, 404);

    // the list: the newest first, without the answers, searchable by name, address and customer
    const list = (await call('GET', '/api/saved-checks?kind=coverage')).json();
    assert.equal(list.total, 2);
    assert.deepEqual(list.items.map((i: { name: string }) => i.name), ['Demo Srl', 'Rossi – casa al mare']);
    assert.ok(list.items.every((i: object) => !('result' in i)));
    assert.equal((await call('GET', '/api/saved-checks?kind=coverage&q=CL002')).json().total, 1);
    assert.equal((await call('GET', '/api/saved-checks?kind=coverage&q=roma')).json().total, 1, 'by the address');
    assert.equal((await call('GET', '/api/saved-checks?kind=feasibility')).json().total, 0);

    // an installer: only their own; no customers of ISP Billing, no feasibility
    await call('POST', '/api/admin/users', { username: 'tecnico', password: 'Installer-Pass-123' });
    const T = { authorization: `Bearer ${await login('tecnico', 'Installer-Pass-123')}` };
    assert.equal((await call('GET', '/api/saved-checks?kind=coverage', undefined, T)).json().total, 0);
    assert.equal((await call('GET', `/api/saved-checks/${s.id}`, undefined, T)).statusCode, 404);
    assert.equal((await call('PATCH', `/api/saved-checks/${s.id}`, { name: 'x' }, T)).statusCode, 404);
    assert.equal((await call('DELETE', `/api/saved-checks/${s.id}`, undefined, T)).statusCode, 404);
    assert.equal((await call('GET', '/api/admin/saved-checks/customers?q=rossi', undefined, T)).statusCode, 403);
    assert.equal((await call('POST', '/api/saved-checks', { kind: 'coverage', customerId: 'c1', lat: 37.58, lon: 14.12 }, T)).statusCode, 403, 'installers write the name');
    assert.equal((await call('POST', '/api/saved-checks', { kind: 'feasibility', name: 'x', lat: 37.58, lon: 14.12 }, T)).statusCode, 403);
    assert.equal((await call('GET', '/api/saved-checks?kind=feasibility', undefined, T)).statusCode, 403);
    const theirs = await call('POST', '/api/saved-checks', { kind: 'coverage', name: 'Bianchi', lat: 37.58, lon: 14.12 }, T);
    assert.equal(theirs.statusCode, 200, theirs.body);
    assert.equal(theirs.json().summary.verdict, 'none', 'no AP assigned to the installer');
    const theirsFull = (await call('GET', `/api/saved-checks/${theirs.json().id}`, undefined, T)).json();
    assert.equal(theirsFull.result.operatorsError, 'operators_not_configured', 'the installer’s view of the other operators');
    assert.equal((await call('PATCH', `/api/saved-checks/${theirs.json().id}`, { name: 'Bianchi Luca' }, T)).json().name, 'Bianchi Luca');

    // admins see everyone's, or only their own
    const all = (await call('GET', '/api/saved-checks?kind=coverage')).json();
    assert.equal(all.total, 3);
    const other = all.items.find((i: { name: string }) => i.name === 'Bianchi Luca');
    assert.equal(other.by, 'tecnico');
    assert.equal(other.mine, false);
    assert.equal((await call('GET', '/api/saved-checks?kind=coverage&mine=1')).json().total, 2);

    // feasibility: saved with the customer, its PDF with the name on top (the answer kept)
    const f = await call('POST', '/api/saved-checks', { kind: 'feasibility', customerId: 'c1', lat: 37.58, lon: 14.12, label: 'Via Roma 1, Enna' });
    assert.equal(f.statusCode, 200, f.body);
    const fj = f.json();
    assert.equal(fj.name, 'ROSSI MARIO');
    assert.ok(['yes', 'maybe', 'no'].includes(fj.summary.verdict), JSON.stringify(fj.summary));
    assert.equal(fj.summary.others, null, 'the other operators not configured');
    assert.deepEqual(fj.params, {}, 'no options for feasibility');
    const pdf = await call('GET', `/api/saved-checks/${fj.id}/pdf`);
    assert.equal(pdf.statusCode, 200, pdf.body.slice(0, 200));
    assert.equal(pdf.headers['content-type'], 'application/pdf');
    assert.match(String(pdf.headers['content-disposition']), /fattibilita-rossi-mario-\d{4}-\d{2}-\d{2}\.pdf/);
    const text = pdfText(pdf.rawPayload);
    assert.ok(text.includes('ROSSI MARIO') && text.includes('CL001') && text.includes('Via Roma 1, Enna'), text.slice(0, 600));
    assert.equal((await call('GET', `/api/saved-checks/${s.id}/pdf`)).statusCode, 400, 'a coverage check has no PDF');
    assert.equal((await call('GET', `/api/saved-checks/${fj.id}`, undefined, T)).statusCode, 404);

    // deleted: gone from the list, in the activity log
    assert.equal((await call('DELETE', `/api/saved-checks/${second.json().id}`)).json().ok, true);
    assert.equal((await call('GET', '/api/saved-checks?kind=coverage&mine=1')).json().total, 1);
    const log = db.prepare("SELECT action FROM events WHERE action LIKE 'saved_check.%'").all() as Array<{ action: string }>;
    assert.ok(['saved_check.create', 'saved_check.rename', 'saved_check.delete'].every((a) => log.some((e) => e.action === a)), JSON.stringify(log));
    await app.close();
  });
});
