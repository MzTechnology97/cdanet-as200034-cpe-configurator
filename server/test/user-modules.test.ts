import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { testApp } from './helpers.ts';

describe('Modules per user', () => {
  it('overrides the global setting for single users, enforced by the server', async () => {
    const t = await testApp();
    const admin = await t.login();
    const mk = async (u: string) =>
      (await t.app.inject({ method: 'POST', url: '/api/admin/users', headers: t.auth(admin), payload: { username: u, password: 'Installer-Pass-123' } })).json().id as number;
    const anna = await mk('anna');
    const bruno = await mk('bruno');
    const tokA = await t.login('anna', 'Installer-Pass-123');
    const tokB = await t.login('bruno', 'Installer-Pass-123');
    const meta = async (tok: string) => (await t.app.inject({ method: 'GET', url: '/api/meta', headers: t.auth(tok) })).json().modules;

    // cpe_health is off globally: turn it on for Anna only; turn RouterOS off for Bruno only
    const put = (id: number, body: object) => t.app.inject({ method: 'PUT', url: `/api/admin/users/${id}/modules`, headers: t.auth(admin), payload: body });
    const r = (await put(anna, { cpe_health: true, telegram: false, bogus: true })).json();
    const health = r.find((m: { key: string }) => m.key === 'cpe_health');
    assert.deepEqual({ global: health.global, override: health.override, effective: health.effective }, { global: false, override: true, effective: true });
    assert.ok(!r.some((m: { key: string }) => m.key === 'telegram'), 'telegram is global only');
    await put(bruno, { routeros: false });

    assert.equal((await meta(tokA)).cpe_health, true);
    assert.equal((await meta(tokB)).cpe_health, false);
    assert.equal((await meta(tokB)).routeros, false);
    assert.equal((await meta(tokA)).routeros, true);
    // server enforcement
    assert.notEqual((await t.app.inject({ method: 'GET', url: '/api/cpe-health', headers: t.auth(tokA) })).json().error, 'module_disabled');
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/cpe-health', headers: t.auth(tokB) })).json().error, 'module_disabled');
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/routeros/catalog', headers: t.auth(tokB) })).json().error, 'module_disabled');
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/routeros/catalog', headers: t.auth(tokA) })).statusCode, 200);

    // the global page shows how many users have exceptions; null resets to default
    const list = (await t.app.inject({ method: 'GET', url: '/api/admin/modules', headers: t.auth(admin) })).json();
    assert.equal(list.find((m: { key: string }) => m.key === 'cpe_health').usersOn, 1);
    assert.equal(list.find((m: { key: string }) => m.key === 'routeros').usersOff, 1);
    await put(bruno, { routeros: null });
    assert.equal((await meta(tokB)).routeros, true);

    // the global switch still applies to users without an override
    await t.app.inject({ method: 'PUT', url: '/api/admin/modules', headers: t.auth(admin), payload: { coverage: false } });
    assert.equal((await meta(tokA)).coverage, false);
    await put(anna, { coverage: true });
    assert.equal((await meta(tokA)).coverage, true);

    const ev = (await t.app.inject({ method: 'GET', url: '/api/admin/events', headers: t.auth(admin) })).json().map((e: { action: string }) => e.action);
    assert.ok(ev.includes('modules.user'));
    assert.equal((await t.app.inject({ method: 'GET', url: `/api/admin/users/${anna}/modules`, headers: t.auth(tokA) })).statusCode, 403);
    await t.app.close();
  });
});
