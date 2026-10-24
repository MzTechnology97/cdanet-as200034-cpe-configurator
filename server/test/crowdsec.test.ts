import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { nowIso, openDatabase } from '../src/db.ts';
import { goDurationMs } from '../src/services/crowdsec.ts';
import { ADMIN, testConfig } from './helpers.ts';

const KEY = 'k-0123456789abcdef';

describe('CrowdSec (titolare, 23/10/2026)', () => {
  it('reads the Go durations of the local API', () => {
    assert.equal(goDurationMs('3h59m58.5s'), 3 * 3_600_000 + 59 * 60_000 + 58_500);
    assert.equal(goDurationMs('167h'), 167 * 3_600_000);
    assert.equal(goDurationMs('-2m'), -120_000);
    assert.equal(goDurationMs('domani'), null);
  });

  it('blocks what CrowdSec decides, never the trusted networks, past logins, exceptions and sessions', async () => {
    const cfg = testConfig();
    let pull = 0;
    let deleted: unknown[] = [];
    const seen: Array<{ url: string; key: string | null }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const key = new Headers(init?.headers).get('x-api-key');
      seen.push({ url: u, key });
      if (!u.startsWith('http://crowdsec:8080/v1/decisions/stream')) throw new Error(`unexpected ${u}`);
      if (key !== KEY) return new Response('{"message":"access forbidden"}', { status: 403 });
      pull++;
      const body = u.endsWith('startup=true')
        ? {
            new: [
              { id: 1, origin: 'crowdsec', scenario: 'crowdsecurity/http-probing', scope: 'Ip', value: '203.0.113.9', type: 'ban', duration: '3h59m12.5s' },
              { id: 2, origin: 'CAPI', scenario: 'crowdsecurity/ssh-bf', scope: 'Ip', value: '198.51.100.7', type: 'ban', duration: '167h' },
              { id: 3, origin: 'CAPI', scenario: 'crowdsecurity/http-cve', scope: 'Range', value: '192.0.2.0/24', type: 'ban', duration: '100h' },
              { id: 4, origin: 'CAPI', scenario: 'crowdsecurity/http-bf', scope: 'Ip', value: '203.0.113.50', type: 'ban', duration: '100h' },
              { id: 5, origin: 'crowdsec', scenario: 'crowdsecurity/http-probing', scope: 'Ip', value: '172.18.0.4', type: 'ban', duration: '4h' },
              { id: 6, origin: 'cscli', scenario: 'manual', scope: 'Ip', value: '203.0.113.77', type: 'captcha', duration: '4h' },
            ],
            deleted: [],
          }
        : { new: null, deleted };
      return Response.json(body);
    }) as typeof fetch;
    const db = openDatabase(':memory:');
    const { app, ctx } = await buildApp(cfg, 'test', { db, logger: false, fetchImpl });
    const get = (url: string, ip: string, headers: Record<string, string> = {}) => app.inject({ method: 'GET', url, remoteAddress: ip, headers });
    const tok = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: ADMIN, remoteAddress: '198.51.100.200' })).json().token as string;
    const A = { authorization: `Bearer ${tok}` };

    // off until the key is there (written by the updater when enabled from the console)
    await ctx.crowdsec.sync();
    assert.equal(seen.length, 0);
    assert.deepEqual([(await app.inject({ method: 'GET', url: '/api/admin/crowdsec', headers: A })).json().enabled], [false]);
    mkdirSync(cfg.infraDir, { recursive: true });
    writeFileSync(join(cfg.infraDir, 'crowdsec.key'), `${KEY}\n`);
    await ctx.crowdsec.sync();
    assert.equal(pull, 1);
    assert.ok(seen[0]!.url.endsWith('startup=true'));

    // a scanner seen here: nothing at all, pages or API
    const page = await get('/', '203.0.113.9');
    assert.equal(page.statusCode, 403);
    assert.match(page.body, /203\.0\.113\.9/);
    assert.match(String(page.headers['content-type']), /text\/html/);
    const api = await get('/api/meta', '203.0.113.9');
    assert.deepEqual([api.statusCode, api.json().error], [403, 'blocked_ip']);
    assert.equal((await get('/api/meta', '::ffff:203.0.113.9')).statusCode, 403, 'IPv4 through an IPv6 socket');
    // the community list, also as a network; a decision that is not a ban is ignored
    assert.equal((await get('/api/meta', '198.51.100.7')).statusCode, 403);
    assert.equal((await get('/api/meta', '192.0.2.44')).statusCode, 403);
    assert.notEqual((await get('/api/meta', '203.0.113.77')).statusCode, 403);
    // never the private networks (the containers, the LANs)
    assert.notEqual((await get('/api/meta', '172.18.0.4')).statusCode, 403);
    // an installer behind an address of the community list who logged in from it in the last 30 days
    db.prepare("INSERT INTO login_attempts(created_at, ip, device, username, channel, kind, ok, reason) VALUES(?, '203.0.113.50', NULL, 'tecnico', 'app', 'password', 1, '')").run(nowIso());
    assert.notEqual((await get('/api/meta', '203.0.113.50')).statusCode, 403);
    // whoever is logged in keeps working from a blocked address; a forged token does not
    assert.equal((await get('/api/auth/me', '198.51.100.7', A)).statusCode, 200);
    assert.equal((await get('/api/auth/me', '198.51.100.7', { authorization: 'Bearer abc.def.ghi' })).statusCode, 403);

    // the console: state, counts, what was blocked
    const st = (await app.inject({ method: 'GET', url: '/api/admin/crowdsec', headers: A })).json();
    assert.deepEqual([st.enabled, st.connected, st.error], [true, true, null]);
    assert.deepEqual(st.counts, { local: 2, community: 3, manual: 0, list: 0 });
    assert.deepEqual(
      st.local.map((d: { value: string }) => d.value),
      ['172.18.0.4', '203.0.113.9'],
    );
    const b9 = st.blocked.find((b: { ip: string }) => b.ip === '203.0.113.9');
    assert.ok(b9 && b9.count === 3 && b9.decision.origin === 'local' && b9.decision.scenario === 'crowdsecurity/http-probing', JSON.stringify(st.blocked));
    assert.ok(!st.blocked.some((b: { ip: string }) => b.ip === '203.0.113.50' || b.ip === '172.18.0.4'));

    // an exception chosen by the admin: free at once; taken away: blocked again
    const check = (ip: string) => app.inject({ method: 'GET', url: `/api/admin/crowdsec/check?ip=${ip}`, headers: A }).then((r) => r.json());
    assert.deepEqual(await check('192.0.2.44').then((c) => [c.blocked, c.decision.origin, c.exception]), [true, 'community', null]);
    assert.equal((await app.inject({ method: 'POST', url: '/api/admin/crowdsec/allow', headers: A, payload: { value: '999.1.1.1' } })).statusCode, 400);
    const add = await app.inject({ method: 'POST', url: '/api/admin/crowdsec/allow', headers: A, payload: { value: '192.0.2.0/28', note: 'ufficio Rossi', days: 7 } });
    assert.equal(add.statusCode, 201, add.body);
    assert.notEqual((await get('/api/meta', '192.0.2.4')).statusCode, 403);
    assert.equal((await get('/api/meta', '192.0.2.44')).statusCode, 403, 'outside the /28');
    assert.deepEqual(await check('192.0.2.4').then((c) => [c.blocked, c.exception]), [false, 'allowed']);
    const allow = (await app.inject({ method: 'GET', url: '/api/admin/crowdsec', headers: A })).json().allow;
    assert.deepEqual(
      allow.map((a: { value: string; note: string; by: string }) => [a.value, a.note, a.by]),
      [['192.0.2.0/28', 'ufficio Rossi', ADMIN.username]],
    );
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/admin/crowdsec/allow/${add.json().id}`, headers: A })).statusCode, 200);
    assert.equal((await get('/api/meta', '192.0.2.4')).statusCode, 403);
    assert.equal((db.prepare("SELECT count(*) n FROM events WHERE action LIKE 'security.crowdsec_allow%'").get() as { n: number }).n, 2);

    // a decision deleted in CrowdSec (expired, or «cscli decisions delete»): free at the next round
    deleted = [{ id: 1, origin: 'crowdsec', scenario: 'crowdsecurity/http-probing', scope: 'Ip', value: '203.0.113.9', type: 'ban', duration: '-1s' }];
    await ctx.crowdsec.sync();
    assert.ok(seen.at(-1)!.url.endsWith('startup=false'));
    assert.notEqual((await get('/api/meta', '203.0.113.9')).statusCode, 403);
    assert.equal((await get('/api/meta', '198.51.100.7')).statusCode, 403);

    // a key not accepted: said in the console, the decisions known stay in force
    writeFileSync(join(cfg.infraDir, 'crowdsec.key'), 'sbagliata');
    await ctx.crowdsec.sync();
    const bad = (await app.inject({ method: 'GET', url: '/api/admin/crowdsec', headers: A })).json();
    assert.deepEqual([bad.enabled, bad.connected], [true, false]);
    assert.match(bad.error, /chiave/);
    // CrowdSec turned off from the console: nothing blocked any more
    rmSync(join(cfg.infraDir, 'crowdsec.key'));
    await ctx.crowdsec.sync();
    assert.notEqual((await get('/api/meta', '198.51.100.7')).statusCode, 403);
    // admins only
    const inst = await app.inject({ method: 'POST', url: '/api/admin/users', headers: A, payload: { username: 'tecnico', password: 'Installer-Pass-123' } });
    assert.equal(inst.statusCode, 201, inst.body);
    const T = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'tecnico', password: 'Installer-Pass-123' } })).json().token as string;
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/crowdsec', headers: { authorization: `Bearer ${T}` } })).statusCode, 403);
    await app.close();
  });
});
