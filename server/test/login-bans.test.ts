import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ADMIN, testApp } from './helpers.ts';

const DEVICE = '3f2a8c1e-7b4d-4e9a-9c21-5d6e7f8a9b0c';

describe('Accessi bloccati (stile fail2ban)', () => {
  it('5 failed logins ban the IP and the device; sessions behind the same IP keep working; the console unbans', async () => {
    const t = await testApp();
    const admin = await t.login();
    const H = t.auth(admin);
    await t.app.inject({ method: 'POST', url: '/api/admin/users', headers: H, payload: { username: 'tecnico', password: 'Installer-Pass-123' } });
    const login = (u: string, p: string, ip: string, headers: Record<string, string> = {}) =>
      t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: p }, remoteAddress: ip, headers });
    // a colleague logged in from the same public IP (mobile operator's CGNAT)
    const tec = (await login('tecnico', 'Installer-Pass-123', '203.0.113.5')).json().token as string;

    for (let i = 0; i < 4; i++) assert.equal((await login('mario', 'sbagliata', '203.0.113.5')).statusCode, 401);
    assert.equal((await login('mario', 'sbagliata', '203.0.113.5')).statusCode, 401, 'the fifth still answers: it bans');
    const banned = await login('tecnico', 'Installer-Pass-123', '203.0.113.5');
    assert.equal(banned.statusCode, 429);
    assert.equal(banned.json().error, 'banned');
    assert.ok(Number(banned.headers['retry-after']) > 25 * 60, String(banned.headers['retry-after']));
    // another IP: free; the session behind the banned IP: free; no session: stopped
    assert.equal((await login('tecnico', 'Installer-Pass-123', '198.51.100.20')).statusCode, 200);
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: t.auth(tec), remoteAddress: '203.0.113.5' })).statusCode, 200);
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/meta', remoteAddress: '203.0.113.5' })).statusCode, 429);

    // the console: the ban with the usernames tried, then unbanned
    const list = (await t.app.inject({ method: 'GET', url: '/api/admin/bans', headers: H })).json().items;
    const ipBan = list.find((b: { kind: string; value: string }) => b.kind === 'ip' && b.value === '203.0.113.5');
    assert.ok(ipBan && ipBan.active && ipBan.attempts === 5 && ipBan.lastAttemptAt, JSON.stringify(list));
    assert.deepEqual(ipBan.usernames, ['mario']);
    const log = (await t.app.inject({ method: 'GET', url: '/api/admin/login-attempts?failed=1', headers: H })).json().items;
    assert.ok(log.length >= 5 && log.every((a: { ok: boolean; channel: string }) => !a.ok && a.channel === 'web'));
    assert.ok(!JSON.stringify(log).includes('sbagliata'), 'never the password');
    assert.equal((await t.app.inject({ method: 'DELETE', url: `/api/admin/bans/${ipBan.id}`, headers: H })).statusCode, 200);
    assert.equal((await login('tecnico', 'Installer-Pass-123', '203.0.113.5')).statusCode, 200);
    // unbanned from the console: trusted, it starts again (30 minutes, not 24 hours)
    for (let i = 0; i < 5; i++) await login('mario', 'sbagliata', '203.0.113.5');
    const again = await login('tecnico', 'Installer-Pass-123', '203.0.113.5');
    assert.equal(again.statusCode, 429);
    assert.ok(Date.parse(again.json().until) - Date.now() < 31 * 60_000, again.json().until);
    // that ban runs out by itself (not lifted): banned again within the day, 24 hours
    t.db.prepare("UPDATE login_bans SET until = ? WHERE lifted_at IS NULL").run(new Date(Date.now() - 1000).toISOString());
    t.ctx.loginGuard.reload();
    for (let i = 0; i < 6; i++) await login('mario', 'sbagliata', '203.0.113.5');
    const third = await login('tecnico', 'Installer-Pass-123', '203.0.113.5');
    assert.equal(third.statusCode, 429);
    assert.ok(Date.parse(third.json().until) - Date.now() > 23 * 3_600_000, third.json().until);
    assert.equal((t.db.prepare("SELECT count(*) n FROM events WHERE action IN ('auth.ban','auth.unban')").get() as { n: number }).n, 4);

    // a device failing in a loop (from private addresses, never banned by IP): stopped everywhere
    const dev = { 'x-cda-device': DEVICE, 'x-cda-client': 'android/1.35.3' };
    const tecDev = (await login('tecnico', 'Installer-Pass-123', '10.1.1.1', dev)).json().token as string;
    for (let i = 0; i < 5; i++) await login('tecnico', 'sbagliata', `10.1.1.${i + 2}`, dev);
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { ...t.auth(tecDev), ...dev }, remoteAddress: '10.1.1.9' })).statusCode, 429, 'a banned device: even with a session');
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: t.auth(tecDev), remoteAddress: '10.1.1.9' })).statusCode, 200, 'the IP is private: not banned');
    // an id that is not a UUID is ignored
    assert.equal((t.db.prepare("SELECT count(*) n FROM login_attempts WHERE device = 'abc'").get() as { n: number }).n, 0);
    await login('x', 'y', '10.2.2.2', { 'x-cda-device': 'abc' });
    assert.equal((t.db.prepare('SELECT count(*) n FROM login_attempts WHERE device IS NULL AND ip = ?').get('10.2.2.2') as { n: number }).n, 1);

    // private addresses: never banned, the old limit per username stays
    for (let i = 0; i < 10; i++) await login(ADMIN.username, 'sbagliata', '192.168.30.7');
    assert.equal((await login(ADMIN.username, ADMIN.password, '192.168.30.7')).json().error, 'too_many_attempts');
    assert.equal((await login('tecnico', 'Installer-Pass-123', '192.168.30.7')).statusCode, 200, 'other users from the office go on');
    await t.app.close();
  });

  it('the address is the real client: X-Forwarded-For counts only when it comes from the proxy', async () => {
    const t = await testApp();
    const login = (remote: string, xff: string) =>
      t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'nessuno', password: 'x' }, remoteAddress: remote, headers: { 'x-forwarded-for': xff } });
    // a stranger forging the header: it is his own address that is logged (and banned)
    await login('198.51.100.7', '93.41.1.2');
    // through the proxy (Caddy, on the private network): the client it forwards
    await login('172.20.0.3', '203.0.113.77');
    const ips = (t.db.prepare('SELECT ip FROM login_attempts ORDER BY id').all() as Array<{ ip: string }>).map((r) => r.ip);
    assert.deepEqual(ips, ['198.51.100.7', '203.0.113.77']);
    await t.app.close();
  });

  it('LOGIN_BAN_IGNORE: those addresses are never banned', async () => {
    const t = await testApp({ LOGIN_BAN_IGNORE: '185.198.208.11, 87.31.62.0/24' });
    const login = (ip: string) => t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'nessuno', password: 'x' }, remoteAddress: ip });
    for (let i = 0; i < 6; i++) await login('87.31.62.21');
    assert.equal((await login('87.31.62.21')).statusCode, 401, 'still answered: not banned');
    assert.equal((t.db.prepare('SELECT count(*) n FROM login_bans').get() as { n: number }).n, 0);
    await t.app.close();
  });
});
