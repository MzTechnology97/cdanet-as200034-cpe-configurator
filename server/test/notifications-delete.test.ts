import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RETENTION_DAYS } from '../src/services/inbox.ts';
import { testApp } from './helpers.ts';

describe('Notifiche: cancellazione e pulizia automatica', () => {
  it('each user deletes their own (some, the read ones, all); after 14 days they go by themselves', async () => {
    const t = await testApp();
    const A = t.auth(await t.login());
    await t.app.inject({ method: 'POST', url: '/api/admin/users', headers: A, payload: { username: 'tecnico', password: 'Installer-Pass-123' } });
    const T = t.auth(await t.login('tecnico', 'Installer-Pass-123'));
    const users = (await t.app.inject({ method: 'GET', url: '/api/admin/users', headers: A })).json() as Array<{ id: number; username: string }>;
    const tid = users.find((u) => u.username === 'tecnico')!.id;
    const aid = users.find((u) => u.username !== 'tecnico')!.id;
    const add = (userId: number, title: string, daysAgo = 0) =>
      t.ctx.db.prepare("INSERT INTO notifications(created_at, user_id, kind, title, body) VALUES(?, ?, 'job', ?, '')").run(new Date(Date.now() - daysAgo * 86400_000).toISOString(), userId, title);
    for (const n of ['uno', 'due', 'tre', 'quattro']) add(tid, n);
    add(aid, 'dell admin');
    const list = async (H: Record<string, string>) => ((await t.app.inject({ method: 'GET', url: '/api/notifications', headers: H })).json().items as Array<{ id: number; title: string }>);
    const mine = await list(T);
    const del = (H: Record<string, string>, payload: object) => t.app.inject({ method: 'POST', url: '/api/notifications/delete', headers: H, payload });

    const one = mine.find((n) => n.title === 'uno')!.id;
    assert.equal((await del(A, { ids: [one] })).json().deleted, 0, 'nobody deletes another user\'s');
    assert.equal((await del(T, { ids: [one] })).json().deleted, 1);
    await t.app.inject({ method: 'POST', url: '/api/notifications/read', headers: T, payload: { ids: [mine.find((n) => n.title === 'due')!.id] } });
    assert.equal((await del(T, { read: true })).json().deleted, 1, 'only the read one');
    assert.deepEqual((await list(T)).map((n) => n.title).sort(), ['quattro', 'tre']);
    const all = (await del(T, { all: true })).json();
    assert.deepEqual([all.deleted, all.unread], [2, 0]);
    assert.equal((await list(A)).length, 1, 'the admin keeps theirs');
    assert.equal((await del(T, {})).statusCode, 400);

    // automatic: older than 14 days
    add(tid, 'vecchia', RETENTION_DAYS + 1);
    add(tid, 'recente', RETENTION_DAYS - 1);
    t.ctx.notify.inbox.sweep();
    assert.deepEqual((await list(T)).map((n) => n.title), ['recente']);
    await t.app.close();
  });
});
