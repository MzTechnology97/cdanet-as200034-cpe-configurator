import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { base32Encode, codeAt, currentStep, verifyCode } from '../src/domain/totp.ts';
import { ADMIN, testApp } from './helpers.ts';

describe('Two-step verification (TOTP)', () => {
  it('matches the RFC 6238 vectors and refuses replays', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    assert.equal(codeAt(secret, Math.floor(59 / 30)), '287082');
    assert.equal(codeAt(secret, Math.floor(1111111109 / 30)), '081804');
    assert.equal(codeAt(secret, Math.floor(2000000000 / 30)), '279037');
    const now = Date.now();
    const step = currentStep(now);
    const code = codeAt(secret, step);
    assert.equal(verifyCode(secret, code, { nowMs: now }), step);
    assert.equal(verifyCode(secret, code, { nowMs: now, lastStep: step }), null, 'replay refused');
    assert.equal(verifyCode(secret, codeAt(secret, step - 1), { nowMs: now }), step - 1, 'one step of clock drift');
    assert.equal(verifyCode(secret, codeAt(secret, step - 3), { nowMs: now }), null);
    assert.equal(verifyCode(secret, 'abc123', { nowMs: now }), null);
  });

  it('enrolment, login in two steps, recovery codes, admin policy and reset', async () => {
    const t = await testApp();
    const pw = async (u: string, p: string) => (await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: p } })).json();
    const totpLogin = (mfaToken: string, code: string) => t.app.inject({ method: 'POST', url: '/api/auth/login/totp', payload: { mfaToken, code } });
    const admin = (await pw(ADMIN.username, ADMIN.password)).token as string;
    await t.app.inject({ method: 'POST', url: '/api/admin/users', headers: t.auth(admin), payload: { username: 'tecnico', password: 'Installer-Pass-123' } });
    const tec = (await pw('tecnico', 'Installer-Pass-123')).token as string;
    const as = (tok: string) => t.auth(tok);

    // enrolment needs the password, then a valid code
    assert.equal((await t.app.inject({ method: 'POST', url: '/api/auth/totp/setup', headers: as(tec), payload: { password: 'wrong' } })).statusCode, 403);
    const setup = (await t.app.inject({ method: 'POST', url: '/api/auth/totp/setup', headers: as(tec), payload: { password: 'Installer-Pass-123' } })).json();
    assert.match(setup.otpauthUrl, /^otpauth:\/\/totp\/CDA%20Net%20CPE:tecnico\?secret=[A-Z2-7]{32}&issuer=CDA%20Net%20CPE/);
    assert.equal((await t.app.inject({ method: 'POST', url: '/api/auth/totp/enable', headers: as(tec), payload: { code: '000000' } })).json().error, 'invalid_code');
    const en = (await t.app.inject({ method: 'POST', url: '/api/auth/totp/enable', headers: as(tec), payload: { code: codeAt(setup.secret, currentStep()) } })).json();
    assert.equal(en.recoveryCodes.length, 8);
    assert.match(en.recoveryCodes[0], /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const acc = (await t.app.inject({ method: 'GET', url: '/api/auth/account', headers: as(tec) })).json();
    assert.equal(acc.totpEnabled, true);
    assert.equal(acc.recoveryCodesLeft, 8);

    // login: password -> mfa token (not a session) -> code
    const step1 = await pw('tecnico', 'Installer-Pass-123');
    assert.equal(step1.mfaRequired, true);
    assert.equal(step1.token, undefined);
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: as(step1.mfaToken) })).statusCode, 401, 'mfa token is not a session');
    assert.equal((await totpLogin(step1.mfaToken, '123456')).json().error, 'invalid_code');
    // the code used at enrolment cannot be replayed; the next step works (simulate with step+1 within drift window)
    const ok = await totpLogin(step1.mfaToken, codeAt(setup.secret, currentStep() + 1));
    assert.equal(ok.statusCode, 200, ok.body);
    assert.ok(ok.json().token);
    // recovery code: one time only
    const s2 = await pw('tecnico', 'Installer-Pass-123');
    assert.equal((await totpLogin(s2.mfaToken, en.recoveryCodes[0].toLowerCase())).statusCode, 200);
    const s3 = await pw('tecnico', 'Installer-Pass-123');
    assert.equal((await totpLogin(s3.mfaToken, en.recoveryCodes[0])).statusCode, 401);
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/auth/account', headers: as(ok.json().token) })).json().recoveryCodesLeft, 7);

    // admin policy: cannot be required by an admin without 2FA; once required, admin pages need it
    assert.equal((await t.app.inject({ method: 'PUT', url: '/api/admin/security', headers: as(admin), payload: { totpRequiredForAdmins: true } })).json().error, 'enable_totp_first');
    const aset = (await t.app.inject({ method: 'POST', url: '/api/auth/totp/setup', headers: as(admin), payload: { password: ADMIN.password } })).json();
    await t.app.inject({ method: 'POST', url: '/api/auth/totp/enable', headers: as(admin), payload: { code: codeAt(aset.secret, currentStep()) } });
    assert.equal((await t.app.inject({ method: 'PUT', url: '/api/admin/security', headers: as(admin), payload: { totpRequiredForAdmins: true } })).statusCode, 200);
    // a second admin without 2FA: logs in but admin APIs answer mfa_setup_required, own account still works
    await t.app.inject({ method: 'POST', url: '/api/admin/users', headers: as(admin), payload: { username: 'admin2', password: 'Admin-Two-Password-1', role: 'admin' } });
    const a2 = await pw('admin2', 'Admin-Two-Password-1');
    assert.equal(a2.mfaSetupRequired, true);
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/admin/users', headers: as(a2.token) })).json().error, 'mfa_setup_required');
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/auth/account', headers: as(a2.token) })).json().totpRequired, true);
    // admins cannot switch it off while required
    assert.equal((await t.app.inject({ method: 'POST', url: '/api/auth/totp/disable', headers: as(admin), payload: { password: ADMIN.password, code: codeAt(aset.secret, currentStep() + 1) } })).json().error, 'totp_required_by_policy');

    // reset by an admin: sessions revoked, password-only login again
    const users = (await t.app.inject({ method: 'GET', url: '/api/admin/users', headers: as(admin) })).json();
    const tecRow = users.find((u: { username: string }) => u.username === 'tecnico');
    assert.equal(tecRow.totpEnabled, true);
    await t.app.inject({ method: 'PATCH', url: `/api/admin/users/${tecRow.id}`, headers: as(admin), payload: { resetTotp: true } });
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: as(ok.json().token) })).statusCode, 401);
    assert.ok((await pw('tecnico', 'Installer-Pass-123')).token);

    const events = (await t.app.inject({ method: 'GET', url: '/api/admin/events', headers: as(admin) })).json().map((e: { action: string }) => e.action);
    assert.ok(events.includes('account.totp_enable') && events.includes('account.recovery_code') && events.includes('security.policy'));
    await t.app.close();
  });
});
