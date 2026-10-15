import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { testApp } from './helpers.ts';

describe('Screenshot nell’app', () => {
  it('off by default for installers, the NOC is told of an attempt; admins and enabled accounts may', async () => {
    const t = await testApp();
    const A = t.auth(await t.login());
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, headers = A) => t.app.inject({ method, url, headers, payload });
    await call('POST', '/api/admin/users', { username: 'tecnico', password: 'Installer-Pass-123' });
    const T = t.auth(await t.login('tecnico', 'Installer-Pass-123'));
    const tid = ((await call('GET', '/api/admin/users')).json() as Array<{ id: number; username: string }>).find((u) => u.username === 'tecnico')!.id;

    assert.equal((await call('GET', '/api/meta', undefined, T)).json().modules.screenshots, false, 'installers: off by default');
    const r = (await call('POST', '/api/security/screenshot-attempt', { screen: 'Installazione CPE' }, T)).json();
    assert.equal(r.notified, true);
    const noc = (await call('GET', '/api/notifications')).json().items as Array<{ kind: string; title: string; body: string }>;
    const n = noc.find((x) => x.kind === 'screenshot_attempt')!;
    assert.match(n.title, /tecnico/);
    assert.match(n.body, /Installazione CPE/);
    assert.equal((await call('POST', '/api/security/screenshot-attempt', {}, A)).json().notified, false, 'admins may');
    // a recording, sent later by the phone's queue: the notice says what and when
    assert.equal((await call('POST', '/api/security/screenshot-attempt', { screen: 'Oggi', kind: 'recording', at: '2026-10-15T07:30:00.000Z' }, T)).json().notified, true);
    const rec = ((await call('GET', '/api/notifications')).json().items as Array<{ kind: string; title: string; body: string }>).find((x) => /Registrazione/.test(x.title))!;
    assert.match(rec.body, /registrato lo schermo/);
    assert.match(rec.body, /15\/10\/26, 09:30/);

    // the NOC allows this account: no more notices
    await call('PUT', `/api/admin/users/${tid}/modules`, { screenshots: true });
    assert.equal((await call('GET', '/api/meta', undefined, T)).json().modules.screenshots, true);
    assert.equal((await call('POST', '/api/security/screenshot-attempt', {}, T)).json().notified, false);
    const events = (await call('GET', '/api/admin/events?limit=20')).json();
    assert.equal((Array.isArray(events) ? events : events.items).filter((e: { action: string }) => e.action === 'security.screenshot').length, 2);
    await t.app.close();
  });
});
