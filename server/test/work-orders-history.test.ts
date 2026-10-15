import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { todayRome } from '../src/routes/work-orders.ts';
import { testApp } from './helpers.ts';

const shift = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe('Interventi: storico, filtri e tracciamento', () => {
  it('filters a period without the backlog, counts the whole selection, pages and exports', async () => {
    const t = await testApp();
    const A = t.auth(await t.login());
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => t.app.inject({ method, url, headers: A, payload });
    await call('POST', '/api/admin/users', { username: 'tecnico', password: 'Installer-Pass-123' });
    await call('POST', '/api/admin/users', { username: 'altro', password: 'Installer-Pass-456' });
    const users = (await call('GET', '/api/admin/users')).json() as Array<{ id: number; username: string }>;
    const tid = users.find((u) => u.username === 'tecnico')!.id;
    const oid = users.find((u) => u.username === 'altro')!.id;
    const today = todayRome();
    const old = shift(today, -40);
    const add = async (o: object) => (await call('POST', '/api/admin/work-orders', o)).json().item as { id: number };

    const a = await add({ assignedTo: tid, day: old, kind: 'new', customer: 'Bianchi Anna', address: 'Via Dante 3, Enna', pppoeUser: 'bianchi@cda-net.it', pppoePassword: 'Segreta-PPPoE-2' });
    await add({ assignedTo: oid, day: old, kind: 'repair', customer: 'Verdi Luca', address: 'Corso Sicilia 9' });
    await add({ day: today, kind: 'repoint', customer: 'Neri Sara' });
    const c = await add({ assignedTo: tid, day: shift(today, 1), kind: 'new', customer: 'Gialli 100%_x' });

    // today, as before: the open orders of past days stay on the board
    const board = (await call('GET', `/api/admin/work-orders?from=${today}&to=${today}`)).json();
    assert.equal(board.total, 3, 'today + the two left open 40 days ago');
    assert.equal(board.summary.overdue, 2);
    assert.equal(board.summary.unassigned, 1);

    // a month of history: only that period, newest first
    const month = (await call('GET', `/api/admin/work-orders?from=${shift(old, -1)}&to=${shift(old, 1)}&backlog=0&order=desc`)).json();
    assert.equal(month.total, 2);
    assert.deepEqual(month.summary.byKind, { new: 1, repoint: 0, repair: 1, survey: 0 });
    const range = `from=${shift(today, -60)}&to=${shift(today, 5)}&backlog=0`;
    assert.equal((await call('GET', `/api/admin/work-orders?${range}&user=${tid}`)).json().total, 2, 'by installer');
    assert.equal((await call('GET', `/api/admin/work-orders?${range}&user=none`)).json().items[0].customer, 'Neri Sara', 'not assigned');
    assert.equal((await call('GET', `/api/admin/work-orders?${range}&kind=repair`)).json().total, 1);
    assert.equal((await call('GET', `/api/admin/work-orders?${range}&q=dante`)).json().items[0].id, a.id, 'by address');
    assert.equal((await call('GET', `/api/admin/work-orders?${range}&q=%23${c.id}`)).json().items[0].id, c.id, 'by #number');
    assert.equal((await call('GET', `/api/admin/work-orders?${range}&q=100%25_`)).json().total, 1, '% and _ are letters');
    assert.equal((await call('GET', `/api/admin/work-orders?${range}&q=1%25`)).json().total, 0);
    const page = (await call('GET', `/api/admin/work-orders?${range}&limit=2&offset=2`)).json();
    assert.equal(page.total, 4);
    assert.equal(page.items.length, 2);
    await call('POST', '/api/admin/work-orders', { day: today, customer: 'Annullato Test' }).then((r) => call('PUT', `/api/admin/work-orders/${r.json().item.id}`, { status: 'cancelled' }));
    assert.equal((await call('GET', `/api/admin/work-orders?${range}&status=open,postponed`)).json().total, 4, 'several statuses');

    const csv = await call('GET', `/api/admin/work-orders.csv?${range}`);
    assert.equal(csv.statusCode, 200, csv.body);
    assert.match(String(csv.headers['content-type']), /text\/csv/);
    assert.ok(csv.body.includes('Bianchi Anna') && csv.body.includes('bianchi@cda-net.it'));
    assert.ok(!csv.body.includes('Segreta-PPPoE-2'), 'never the PPPoE password');
    await t.app.close();
  });

  it('keeps the history of an order: every change old → new and the installer’s steps', async () => {
    const t = await testApp();
    const A = t.auth(await t.login());
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, headers = A) => t.app.inject({ method, url, headers, payload });
    await call('POST', '/api/admin/users', { username: 'tecnico', password: 'Installer-Pass-123' });
    await call('POST', '/api/admin/users', { username: 'altro', password: 'Installer-Pass-456' });
    const users = (await call('GET', '/api/admin/users')).json() as Array<{ id: number; username: string }>;
    const tid = users.find((u) => u.username === 'tecnico')!.id;
    const oid = users.find((u) => u.username === 'altro')!.id;
    const today = todayRome();
    // an order deleted before: its number comes back, its history must not
    const gone = (await call('POST', '/api/admin/work-orders', { day: today, customer: 'Prova Cancellata' })).json().item;
    await t.app.inject({ method: 'DELETE', url: `/api/admin/work-orders/${gone.id}`, headers: A });
    t.db.prepare("UPDATE events SET created_at = '2026-01-01T00:00:00.000Z' WHERE target = ?").run(`#${gone.id}`);
    const o = (await call('POST', '/api/admin/work-orders', { assignedTo: tid, day: today, slot: '09-11', customer: 'Rossi Mario', pppoePassword: 'Segreta-PPPoE-3' })).json().item;
    assert.equal(o.id, gone.id, 'SQLite gives the number again');
    await call('PUT', `/api/admin/work-orders/${o.id}`, { day: shift(today, 1), assignedTo: oid, pppoePassword: 'Nuova-PPPoE-4' });
    await call('PUT', `/api/admin/work-orders/${o.id}`, { notes: 'Cancello verde' });
    const T = t.auth(await t.login('altro', 'Installer-Pass-456'));
    await call('POST', `/api/work-orders/${o.id}/status`, { status: 'postponed', note: 'cliente assente' }, T);

    const h = (await call('GET', `/api/admin/work-orders/${o.id}/history`)).json();
    assert.deepEqual(
      h.items.map((i: { kind: string }) => i.kind),
      ['create', 'update', 'update', 'status'],
    );
    assert.equal(h.items[1].detail, `giorno ${today} → ${shift(today, 1)} · installatore tecnico → altro · password cambiata`);
    assert.equal(h.items[2].detail, 'note cambiate');
    assert.equal(h.items[3].user, 'altro');
    assert.match(h.items[3].detail, /postponed · cliente assente/);
    assert.ok(!JSON.stringify(h).includes('Segreta') && !JSON.stringify(h).includes('Nuova-PPPoE'), 'never a password');
    assert.equal((await call('GET', `/api/admin/work-orders/${o.id}/history`, undefined, T)).statusCode, 403, 'admins only');
    assert.equal((await call('GET', '/api/admin/work-orders/99999/history')).statusCode, 404);
    await t.app.close();
  });
});
