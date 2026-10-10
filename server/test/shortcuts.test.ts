import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { ADMIN, testConfig } from './helpers.ts';

describe('Scorciatoie della home', () => {
  it('are kept with the account, not the phone, and each account has its own', async () => {
    const { app } = await buildApp(testConfig(), 'test', { db: openDatabase(':memory:'), logger: false });
    const login = async (username: string, password: string) => (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } })).json().token as string;
    const as = (token: string) => ({ authorization: `Bearer ${token}` });
    const admin = await login(ADMIN.username, ADMIN.password);
    await app.inject({ method: 'POST', url: '/api/admin/users', headers: as(admin), payload: { username: 'tecnico', password: 'Installer-Pass-123' } });
    const phoneA = await login('tecnico', 'Installer-Pass-123');
    const phoneB = await login('tecnico', 'Installer-Pass-123');
    const get = async (t: string) => (await app.inject({ method: 'GET', url: '/api/auth/shortcuts', headers: as(t) })).json().ids;
    const put = (t: string, ids: unknown) => app.inject({ method: 'PUT', url: '/api/auth/shortcuts', headers: as(t), payload: { ids } });

    assert.equal(await get(phoneA), null, 'never customised: the app shows its defaults');
    const saved = await put(phoneA, ['coverage', 'cpe', 'net_status', 'coverage']);
    assert.equal(saved.statusCode, 200, saved.body);
    assert.deepEqual(saved.json().ids, ['coverage', 'cpe', 'net_status'], 'duplicates dropped, order kept');
    assert.deepEqual(await get(phoneB), ['coverage', 'cpe', 'net_status'], 'the other phone of the same account sees them');
    assert.equal(await get(admin), null, 'other accounts keep their own');

    assert.deepEqual((await put(phoneB, [])).json().ids, [], 'an empty Home is a valid choice');
    assert.deepEqual(await get(phoneA), []);
    assert.equal((await put(phoneA, null)).statusCode, 200);
    assert.equal(await get(phoneA), null, 'reset to the defaults');

    assert.equal((await put(phoneA, ['Bad Id'])).statusCode, 400);
    assert.equal((await put(phoneA, Array.from({ length: 41 }, (_, i) => `s${i}`))).statusCode, 400);
    assert.equal((await app.inject({ method: 'GET', url: '/api/auth/shortcuts' })).statusCode, 401);
    await app.close();
  });
});
