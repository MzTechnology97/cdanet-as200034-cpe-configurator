import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { codeAt, currentStep } from '../src/domain/totp.ts';
import { ADMIN, testApp } from './helpers.ts';

/**
 * Who signs in with the password and the code of the two-step verification stays signed in for
 * 30 days (titolare, 17/10/2026); the others keep the ordinary session. Revocation is the same,
 * and «Esci» now closes the session on the server too.
 */
describe('Sessione lunga con la verifica in due passaggi', () => {
  it('30 days with the code (or the days set), the ordinary session without it or with «Resta connesso» off', async () => {
    const t = await testApp();
    const pw = async (u: string, p: string) => (await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: p } })).json();
    const totp = (mfaToken: string, code: string, remember?: boolean) =>
      t.app.inject({ method: 'POST', url: '/api/auth/login/totp', payload: { mfaToken, code, ...(remember === undefined ? {} : { remember }) } });
    const days = (iso: string) => (Date.parse(iso) - Date.now()) / 86_400_000;
    const me = (token: string) => t.app.inject({ method: 'GET', url: '/api/auth/me', headers: t.auth(token) });

    // without the two-step verification: the ordinary session (8 hours by default), never kept
    const plain = await pw(ADMIN.username, ADMIN.password);
    assert.ok(days(plain.expiresAt) < 0.34 && days(plain.expiresAt) > 0.33, plain.expiresAt);
    assert.equal(plain.remember, undefined);
    assert.equal((await me(plain.token)).json().user.mfaSession, undefined);
    const admin = plain.token as string;

    // two codes of the app (this step and the next: both inside the window even if a step goes by
    // during the test), the recovery codes for the other logins
    const step = currentStep();
    const setup = (await t.app.inject({ method: 'POST', url: '/api/auth/totp/setup', headers: t.auth(admin), payload: { password: ADMIN.password } })).json();
    const en = (await t.app.inject({ method: 'POST', url: '/api/auth/totp/enable', headers: t.auth(admin), payload: { code: codeAt(setup.secret, step) } })).json();
    assert.equal(en.recoveryCodes.length, 8);
    const recovery = en.recoveryCodes as string[];

    // password and code: 30 days, to be kept by the console
    const a = await pw(ADMIN.username, ADMIN.password);
    const long = await totp(a.mfaToken, codeAt(setup.secret, step + 1));
    assert.equal(long.statusCode, 200, long.body);
    assert.equal(long.json().remember, true);
    assert.ok(days(long.json().expiresAt) > 29.9 && days(long.json().expiresAt) <= 30.01, long.json().expiresAt);
    assert.equal((await me(long.json().token)).json().user.mfaSession, true);

    // «Resta connesso» off (a shared computer): the ordinary session
    const b = await pw(ADMIN.username, ADMIN.password);
    const short = await totp(b.mfaToken, recovery[0]!, false);
    assert.equal(short.statusCode, 200, short.body);
    assert.equal(short.json().remember, undefined);
    assert.ok(days(short.json().expiresAt) < 0.34, short.json().expiresAt);
    assert.equal((await me(short.json().token)).json().user.mfaSession, undefined);

    // the log tells the long sessions
    const events = (await t.app.inject({ method: 'GET', url: '/api/admin/events', headers: t.auth(long.json().token) })).json() as Array<{ action: string; detail: string }>;
    assert.equal(events.filter((e) => e.action === 'account.session_long').length, 1);
    assert.match(events.find((e) => e.action === 'account.session_long')!.detail, /30 giorni/);

    // the days of Impostazioni server, for the next logins (no restart); a recovery code is a second factor too
    const set = await t.app.inject({ method: 'PUT', url: '/api/admin/server-settings', headers: t.auth(long.json().token), payload: { values: { jwtMfaTtlDays: 7 } } });
    assert.equal(set.statusCode, 200, set.body);
    assert.deepEqual(set.json().restartNeeded, []);
    const c = await pw(ADMIN.username, ADMIN.password);
    const week = await totp(c.mfaToken, recovery[1]!);
    assert.equal(week.statusCode, 200, week.body);
    assert.ok(days(week.json().expiresAt) > 6.9 && days(week.json().expiresAt) <= 7.01, week.json().expiresAt);
    assert.ok(days(long.json().expiresAt) > 29.9, 'the sessions already open keep their expiry');

    // «Esci»: that session ends on the server, the others go on
    const out = await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: t.auth(short.json().token), payload: {} });
    assert.equal(out.statusCode, 200, out.body);
    assert.equal((await me(short.json().token)).statusCode, 401, 'logged out on the server');
    assert.equal((await me(long.json().token)).statusCode, 200, 'the other sessions go on');
    assert.equal((await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: t.auth(short.json().token), payload: {} })).statusCode, 401);

    // a password change keeps the long session of the browser that made it, and closes the others
    const changed = await t.app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: t.auth(week.json().token),
      payload: { currentPassword: ADMIN.password, newPassword: 'Nuova-Password-Admin-2026' },
    });
    assert.equal(changed.statusCode, 200, changed.body);
    assert.equal(changed.json().remember, true);
    assert.ok(days(changed.json().expiresAt) > 6.9);
    assert.equal((await me(long.json().token)).statusCode, 401, 'the other long session is closed');
    assert.equal((await me(changed.json().token)).json().user.mfaSession, true);

    // Esci da tutti i dispositivi ends the long one at once, as any other
    await t.app.inject({ method: 'POST', url: '/api/auth/logout-all', headers: t.auth(changed.json().token), payload: {} });
    assert.equal((await me(changed.json().token)).statusCode, 401);
    await t.app.close();
  });

  it('a disabled account or an admin reset ends a long session at once', async () => {
    const t = await testApp();
    const admin = await t.login();
    await t.app.inject({ method: 'POST', url: '/api/admin/users', headers: t.auth(admin), payload: { username: 'tecnico', password: 'Installer-Pass-123' } });
    const tec = await t.login('tecnico', 'Installer-Pass-123');
    const step = currentStep();
    const setup = (await t.app.inject({ method: 'POST', url: '/api/auth/totp/setup', headers: t.auth(tec), payload: { password: 'Installer-Pass-123' } })).json();
    const recovery = (await t.app.inject({ method: 'POST', url: '/api/auth/totp/enable', headers: t.auth(tec), payload: { code: codeAt(setup.secret, step) } })).json()
      .recoveryCodes as string[];
    const longFor = async () => {
      const p = (await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'tecnico', password: 'Installer-Pass-123' } })).json();
      const r = await t.app.inject({ method: 'POST', url: '/api/auth/login/totp', payload: { mfaToken: p.mfaToken, code: recovery.shift() } });
      assert.equal(r.json().remember, true, r.body);
      return r.json().token as string;
    };
    const me = (token: string) => t.app.inject({ method: 'GET', url: '/api/auth/me', headers: t.auth(token) });
    const users = (await t.app.inject({ method: 'GET', url: '/api/admin/users', headers: t.auth(admin) })).json() as Array<{ id: number; username: string }>;
    const id = users.find((u) => u.username === 'tecnico')!.id;

    const patch = (payload: object) => t.app.inject({ method: 'PATCH', url: `/api/admin/users/${id}`, headers: t.auth(admin), payload });

    const first = await longFor();
    assert.equal((await me(first)).statusCode, 200);
    assert.equal((await patch({ active: false })).statusCode, 200);
    assert.equal((await me(first)).statusCode, 401, 'disabled: closed at once');
    assert.equal((await patch({ active: true })).statusCode, 200);

    const second = await longFor();
    assert.equal((await me(second)).statusCode, 200);
    assert.equal((await patch({ password: 'Reimpostata-Admin-2026' })).statusCode, 200);
    assert.equal((await me(second)).statusCode, 401, 'password reset by an admin: closed at once');
    await t.app.close();
  });
});
