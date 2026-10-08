import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { ADMIN, testConfig } from './helpers.ts';

describe('Il mio account', () => {
  it('changes the own password, revokes other sessions and keeps the current one', async () => {
    const { app } = await buildApp(testConfig(), 'test', { db: openDatabase(':memory:'), logger: false });
    const login = async (username: string, password: string) =>
      app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
    const as = (token: string) => ({ authorization: `Bearer ${token}` });

    const admin = (await login(ADMIN.username, ADMIN.password)).json().token as string;
    await app.inject({ method: 'POST', url: '/api/admin/users', headers: as(admin), payload: { username: 'tecnico', password: 'Installer-Pass-123' } });
    const phone = (await login('tecnico', 'Installer-Pass-123')).json().token as string;
    const pc = (await login('tecnico', 'Installer-Pass-123')).json().token as string;

    const acc = (await app.inject({ method: 'GET', url: '/api/auth/account', headers: as(pc) })).json();
    assert.equal(acc.username, 'tecnico');
    assert.equal(acc.role, 'installer');
    assert.ok(acc.lastLoginAt);

    const change = (payload: object, token = pc) => app.inject({ method: 'POST', url: '/api/auth/password', headers: as(token), payload });
    assert.equal((await change({ currentPassword: 'wrong', newPassword: 'Nuova-Password-2026' })).json().error, 'wrong_current_password');
    assert.equal((await change({ currentPassword: 'Installer-Pass-123', newPassword: 'corta' })).statusCode, 400);
    assert.equal((await change({ currentPassword: 'Installer-Pass-123', newPassword: 'Installer-Pass-123' })).json().error, 'password_unchanged');
    assert.equal((await change({ currentPassword: 'Installer-Pass-123', newPassword: 'mio-tecnico-2026!' })).json().error, 'password_contains_username');

    const ok = await change({ currentPassword: 'Installer-Pass-123', newPassword: 'Nuova-Password-2026' });
    assert.equal(ok.statusCode, 200, ok.body);
    const fresh = ok.json().token as string;
    assert.equal((await app.inject({ method: 'GET', url: '/api/auth/me', headers: as(fresh) })).statusCode, 200, 'current session continues');
    assert.equal((await app.inject({ method: 'GET', url: '/api/auth/me', headers: as(phone) })).statusCode, 401, 'other sessions revoked');
    assert.equal((await login('tecnico', 'Installer-Pass-123')).statusCode, 401);
    assert.equal((await login('tecnico', 'Nuova-Password-2026')).statusCode, 200);

    // logout everywhere, including this session
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/logout-all', headers: as(fresh) })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/auth/me', headers: as(fresh) })).statusCode, 401);

    const events = (await app.inject({ method: 'GET', url: '/api/admin/events', headers: as(admin) })).json().map((e: { action: string }) => e.action);
    assert.ok(events.includes('account.password') && events.includes('account.logout_all'));
    assert.ok(!JSON.stringify(events).includes('Nuova-Password'));
    await app.close();
  });

  it('rate-limits wrong current passwords', async () => {
    const { app } = await buildApp(testConfig(), 'test', { db: openDatabase(':memory:'), logger: false });
    const token = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: ADMIN.username, password: ADMIN.password } })).json().token;
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (await app.inject({ method: 'POST', url: '/api/auth/password', headers: { authorization: `Bearer ${token}` }, payload: { currentPassword: `bad-${i}`, newPassword: 'Nuova-Password-2026' } })).statusCode;
    }
    assert.equal(last, 429);
    await app.close();
  });
});
