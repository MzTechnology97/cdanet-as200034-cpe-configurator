import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dueAlerts, inWords, orderStart, romeInstant, slotStart } from '../src/domain/work-order-time.ts';
import { todayRome } from '../src/routes/work-orders.ts';
import { testApp } from './helpers.ts';

const base = { slot: '09:00-11:00', status: 'open', assignedTo: 2, reminders: '', lateAt: null, missedAt: null };

describe('Avvisi degli interventi', () => {
  it('reads the start from the slot, in Italian time across DST', () => {
    assert.equal(slotStart('09:00-11:00'), '09:00');
    assert.equal(slotStart('mattina 9.30'), '09:30');
    assert.equal(slotStart('pomeriggio'), null);
    assert.equal(romeInstant('2026-07-10', '09:00').toISOString(), '2026-07-10T07:00:00.000Z', 'summer: UTC+2');
    assert.equal(romeInstant('2026-12-10', '09:00').toISOString(), '2026-12-10T08:00:00.000Z', 'winter: UTC+1');
    assert.equal(orderStart('2026-12-10', '').toISOString(), '2026-12-10T07:00:00.000Z', 'no time: 08:00');
  });

  it('one reminder at a time, the closest one when created late; late and missed once', () => {
    const o = { ...base, day: '2026-12-10' };
    const start = orderStart(o.day, o.slot).getTime();
    assert.deepEqual(dueAlerts(o, new Date(start - 30 * 3600_000), '2026-12-09'), [], 'too early');
    const r24 = dueAlerts(o, new Date(start - 23 * 3600_000), '2026-12-09');
    assert.deepEqual(r24, [{ type: 'reminder', offset: 1440, sent: [1440] }]);
    // created 90 minutes before: only the 2-hour one, the 24-hour one counts as sent
    assert.deepEqual(dueAlerts(o, new Date(start - 90 * 60_000), '2026-12-10'), [{ type: 'reminder', offset: 120, sent: [1440, 120] }]);
    assert.deepEqual(dueAlerts({ ...o, reminders: '1440,120' }, new Date(start - 25 * 60_000), '2026-12-10'), [{ type: 'reminder', offset: 30, sent: [1440, 120, 60, 30] }]);
    assert.deepEqual(dueAlerts({ ...o, reminders: '1440,120,60,30' }, new Date(start + 40 * 60_000), '2026-12-10'), [{ type: 'late' }]);
    assert.deepEqual(dueAlerts({ ...o, status: 'started' }, new Date(start + 40 * 60_000), '2026-12-10'), [], 'started: not late');
    assert.deepEqual(dueAlerts({ ...o, lateAt: 'x' }, new Date(start + 26 * 3600_000), '2026-12-11'), [{ type: 'missed' }]);
    assert.deepEqual(dueAlerts({ ...o, status: 'postponed' }, new Date(start + 26 * 3600_000), '2026-12-11'), [], 'postponed with a reason: not missed');
    assert.match(inWords(new Date(start), new Date(start - 90 * 60_000)), /^tra 1 h 30 min/);
    assert.match(inWords(new Date(start), new Date(start - 20 * 3600_000)), /^domani alle 09:00/);
  });

  it('assignment, reminder and late alerts reach the installer and the NOC once', async () => {
    const t = await testApp();
    const admin = await t.login();
    const A = t.auth(admin);
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, headers = A) => t.app.inject({ method, url, headers, payload });
    await call('POST', '/api/admin/users', { username: 'tecnico', password: 'Installer-Pass-123' });
    const tid = ((await call('GET', '/api/admin/users')).json() as Array<{ id: number; username: string }>).find((u) => u.username === 'tecnico')!.id;
    const T = t.auth(await t.login('tecnico', 'Installer-Pass-123'));
    // tomorrow at 10:00, seen from 90 minutes before (independent of when the test runs)
    const day = todayRome(new Date(Date.now() + 86400_000));
    const at = orderStart(day, '10:00');
    const now = new Date(at.getTime() - 90 * 60_000);
    const created = (await call('POST', '/api/admin/work-orders', { assignedTo: tid, day, slot: '10:00', kind: 'repair', customer: 'Cliente Demo 40' })).json().item;
    const mine = () => t.db.prepare('SELECT kind, title FROM notifications WHERE user_id = ? ORDER BY id').all(tid) as Array<{ kind: string; title: string }>;
    assert.deepEqual(mine().map((n) => n.kind), ['work_order_assigned']);

    t.ctx.notify.workOrderAlerts(now);
    t.ctx.notify.workOrderAlerts(now);
    assert.deepEqual(mine().map((n) => n.kind), ['work_order_assigned', 'work_order_reminder'], 'once');
    assert.match(mine()[1]!.title, /tra 1 h 30 min/);

    t.ctx.notify.workOrderAlerts(new Date(at.getTime() + 40 * 60_000));
    assert.equal(mine().at(-1)!.kind, 'work_order_late');
    const noc = t.db.prepare("SELECT title FROM notifications WHERE kind = 'work_order_noc'").all() as Array<{ title: string }>;
    assert.equal(noc.length, 1);
    assert.match(noc[0]!.title, /in ritardo: Cliente Demo 40/);

    // the phone's background feed: notifications and the next orders, with a read-only token
    const token = (await call('POST', '/api/notifications/device-token', {}, T)).json().token;
    const feed = await call('GET', '/api/notifications/feed?after=0', undefined, { authorization: `Bearer ${token}` });
    assert.equal(feed.statusCode, 200, feed.body);
    assert.ok(feed.json().items.length >= 3);
    assert.equal(feed.json().workOrders[0].id, created.id);
    assert.equal((await call('GET', '/api/work-orders', undefined, { authorization: `Bearer ${token}` })).statusCode, 401, 'not a session');
    // moving the order: the installer is told, the alerts start again
    await call('PUT', `/api/admin/work-orders/${created.id}`, { slot: '18:00' });
    assert.match(mine().at(-1)!.title, /Intervento modificato/);
    assert.equal((t.db.prepare('SELECT reminders, late_at l FROM work_orders WHERE id = ?').get(created.id) as { reminders: string; l: string | null }).l, null);
  });
});
