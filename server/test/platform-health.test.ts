import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openDatabase } from '../src/db.ts';
import { createPlatformHealth, openBackup, sealBackup, sourceState } from '../src/services/platform-health.ts';
import { testApp } from './helpers.ts';

const ago = (min: number, now: number) => new Date(now - min * 60_000).toISOString();

describe('Salute piattaforma e backup', () => {
  it('tells a source that works from one that is late, failing or not configured', () => {
    const now = Date.parse('2026-10-15T20:00:00Z');
    assert.equal(sourceState(null, 10, now), 'off');
    assert.equal(sourceState({ at: ago(5, now), error: null }, 10, now), 'ok');
    assert.equal(sourceState({ at: ago(29, now), error: null }, 5, now), 'ok', 'never late before 30 minutes');
    assert.equal(sourceState({ at: ago(31, now), error: null }, 10, now), 'warn', 'three readings missed');
    assert.equal(sourceState({ at: ago(1, now), error: 'crm_auth_failed' }, 10, now), 'bad');
    assert.equal(sourceState({ at: null, error: null }, 10, now), 'warn', 'never read');
  });

  it('seals the database with the password, and only that password opens it', () => {
    const data = Buffer.from('SQLite format 3\u0000 finto');
    const key = Buffer.alloc(32, 7);
    const file = sealBackup(data, 'Password-Lunga-123', { format: 'cdanet-backup', version: '9.9.9' }, key);
    assert.ok(!file.includes(data), 'nothing readable without the password');
    assert.ok(!file.includes(key));
    const b = openBackup(file, 'Password-Lunga-123');
    assert.deepEqual(b.database, data);
    assert.deepEqual(b.masterKey, key);
    assert.equal(b.meta.includesKey, true);
    assert.throws(() => openBackup(file, 'Password-Sbagliata'), /backup_wrong_password/);
    assert.throws(() => openBackup(Buffer.from('altro file'), 'x'), /backup_invalid/);
    assert.equal(openBackup(sealBackup(data, 'Password-Lunga-123', {}, null), 'Password-Lunga-123').masterKey, null);
  });

  it('alerts the NOC once when a source stops and once when it comes back', () => {
    const db = openDatabase(':memory:');
    const now = Date.parse('2026-10-15T20:00:00Z');
    let crm: { at: string | null; error: string | null } | null = { at: ago(1, now), error: null };
    const alerts: string[] = [];
    const h = createPlatformHealth(db, { dbPath: ':memory:', version: 't', alert: (ok, title) => alerts.push(`${ok ? 'ok' : 'ko'} ${title}`), probes: () => [{ id: 'crm', label: 'ISP Billing', everyMin: 10, read: () => crm }] });
    h.check(now); // learns the states
    crm = { at: ago(1, now), error: 'crm_auth_failed' };
    h.check(now);
    h.check(now + 5 * 60_000);
    crm = { at: new Date(now + 10 * 60_000).toISOString(), error: null };
    h.check(now + 10 * 60_000);
    crm = null; // switched off: no alert
    h.check(now + 15 * 60_000);
    assert.deepEqual(alerts, ['ko ISP Billing: non funziona', 'ok ISP Billing: di nuovo regolare']);
  });

  it('admins see the health and download an encrypted backup that the check opens again', async () => {
    const t = await testApp();
    const A = t.auth(await t.login());
    const health = await t.app.inject({ method: 'GET', url: '/api/admin/platform/health', headers: A });
    assert.equal(health.statusCode, 200, health.body);
    const hj = health.json();
    assert.ok(hj.sources.some((s: { id: string; state: string }) => s.id === 'crm' && s.state === 'off'), 'not configured: off');
    assert.equal(typeof hj.server.dbBytes, 'number');

    assert.equal((await t.app.inject({ method: 'POST', url: '/api/admin/platform/backup', headers: A, payload: { password: 'corta' } })).statusCode, 400, 'at least 12 characters');
    const bk = await t.app.inject({ method: 'POST', url: '/api/admin/platform/backup', headers: A, payload: { password: 'Backup-Password-2026', includeKey: true } });
    assert.equal(bk.statusCode, 200, bk.body);
    assert.match(String(bk.headers['content-disposition']), /attachment; filename="cdanet-backup-.*\.cdanet"/);
    const file = bk.rawPayload;
    assert.ok(file.subarray(0, 9).toString() === 'CDANETBK1');
    assert.ok(!file.includes(Buffer.from('SQLite format 3')), 'the database is not readable in the file');

    const verify = (password: string) => t.app.inject({ method: 'POST', url: '/api/admin/platform/backup/verify', headers: { ...A, 'content-type': 'application/x-cdanet-backup', 'x-backup-password': password }, payload: file });
    const v = await verify('Backup-Password-2026');
    assert.equal(v.statusCode, 200, v.body);
    assert.equal(v.json().ok, true);
    assert.equal(v.json().integrity, 'ok');
    assert.equal(v.json().includesKey, true);
    assert.ok(v.json().counts.users >= 1);
    assert.equal((await verify('Password-Sbagliata-1')).json().error, 'backup_wrong_password');
    assert.ok((await t.app.inject({ method: 'GET', url: '/api/admin/platform/health', headers: A })).json().server.lastDownload, 'the last download is remembered');

    await t.app.inject({ method: 'POST', url: '/api/admin/users', headers: A, payload: { username: 'tecnico', password: 'Installer-Pass-123' } });
    const T = t.auth(await t.login('tecnico', 'Installer-Pass-123'));
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/admin/platform/health', headers: T })).statusCode, 403);
    assert.equal((await t.app.inject({ method: 'POST', url: '/api/admin/platform/backup', headers: T, payload: { password: 'Backup-Password-2026' } })).statusCode, 403);
    const ev = t.db.prepare("SELECT action FROM events WHERE action LIKE 'platform.%'").all() as Array<{ action: string }>;
    assert.deepEqual(ev.map((e) => e.action).sort(), ['platform.backup', 'platform.backup_verify'], 'the download and the check that opened it');
    await t.app.close();
  });
});
