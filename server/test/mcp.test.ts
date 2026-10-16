import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { codeAt, currentStep } from '../src/domain/totp.ts';
import { clientName, redirectAllowed, returnPlace } from '../src/routes/mcp.ts';
import { sanitize } from '../src/services/mcp-tools.ts';
import { ADMIN, testApp } from './helpers.ts';

const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const form = (o: Record<string, string>) => ({ payload: new URLSearchParams(o).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });

describe('Connetti il tuo Claude (MCP, sola lettura)', () => {
  it('OAuth with PKCE and the second step, read-only tools, cleaned answers, revocable', async () => {
    const t = await testApp();
    const admin = await t.login();
    const H = t.auth(admin);
    // the admin's second step
    const setup = (await t.app.inject({ method: 'POST', url: '/api/auth/totp/setup', headers: H, payload: { password: ADMIN.password } })).json();
    const step = currentStep();
    const en = (await t.app.inject({ method: 'POST', url: '/api/auth/totp/enable', headers: H, payload: { code: codeAt(setup.secret, step) } })).json();
    // later consents: the one-time recovery codes (the next TOTP steps are not valid yet)
    const rc = en.recoveryCodes as string[];
    await t.app.inject({ method: 'POST', url: '/api/admin/users', headers: H, payload: { username: 'tecnico', password: 'Installer-Pass-123' } });

    // discovery, and /mcp asks for a login
    const pr = (await t.app.inject({ method: 'GET', url: '/.well-known/oauth-protected-resource' })).json();
    assert.match(pr.resource, /\/mcp$/);
    const as = (await t.app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' })).json();
    assert.deepEqual([as.code_challenge_methods_supported, as.token_endpoint_auth_methods_supported], [['S256'], ['none']]);
    const anon = await t.app.inject({ method: 'POST', url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} } });
    assert.equal(anon.statusCode, 401);
    assert.match(String(anon.headers['www-authenticate']), /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource"/);

    // registration: https (or back to this computer) only
    assert.equal((await t.app.inject({ method: 'POST', url: '/oauth/register', payload: { redirect_uris: ['http://evil.example/cb'] } })).json().error, 'invalid_redirect_uri');
    // a stranger's https site: a consent on our page must never reach it
    assert.equal((await t.app.inject({ method: 'POST', url: '/oauth/register', payload: { redirect_uris: ['https://evil.example/cb'], client_name: 'Claude' } })).json().error, 'invalid_redirect_uri');
    const reg = await t.app.inject({ method: 'POST', url: '/oauth/register', payload: { redirect_uris: [CALLBACK], client_name: 'CDA Net ufficiale', token_endpoint_auth_method: 'none' } });
    assert.equal(reg.statusCode, 201, reg.body);
    assert.equal(reg.json().client_name, 'Claude (claude.ai)', 'the name is the server\'s, not the client\'s');
    const clientId = reg.json().client_id as string;

    // consent page: PKCE S256 and the registered redirect only
    const verifier = randomBytes(40).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const q = { response_type: 'code', client_id: clientId, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz' };
    assert.equal((await t.app.inject({ method: 'GET', url: `/oauth/authorize?${new URLSearchParams({ ...q, code_challenge_method: 'plain' })}` })).statusCode, 400);
    assert.equal((await t.app.inject({ method: 'GET', url: `/oauth/authorize?${new URLSearchParams({ ...q, redirect_uri: 'https://evil.example/cb' })}` })).statusCode, 400);
    const pg = await t.app.inject({ method: 'GET', url: `/oauth/authorize?${new URLSearchParams(q)}` });
    assert.equal(pg.statusCode, 200);
    assert.match(pg.body, /Connetti il tuo Claude/);
    assert.match(pg.body, /tornerai a: <b>claude\.ai<\/b>/);
    assert.ok(!pg.body.includes('CDA Net ufficiale'));
    assert.match(String(pg.headers['content-security-policy']), /frame-ancestors 'none'/);

    // wrong password, an installer, no second step: refused; the admin with the code: a one-time code
    const post = (o: Record<string, string>) => t.app.inject({ method: 'POST', url: '/oauth/authorize', ...form({ ...q, decision: 'allow', ...o }) });
    assert.equal((await post({ username: ADMIN.username, password: 'sbagliata', code: '000000' })).statusCode, 401);
    assert.equal((await post({ username: 'tecnico', password: 'Installer-Pass-123', code: '000000' })).statusCode, 403);
    assert.equal((await post({ username: ADMIN.username, password: ADMIN.password, code: '000000' })).statusCode, 401);
    const denied = await t.app.inject({ method: 'POST', url: '/oauth/authorize', ...form({ ...q, decision: 'deny' }) });
    assert.match(String(denied.headers.location), /error=access_denied/);
    const okA = await post({ username: ADMIN.username, password: ADMIN.password, code: codeAt(setup.secret, step + 1) });
    assert.equal(okA.statusCode, 302, okA.body);
    const loc = new URL(String(okA.headers.location));
    assert.equal(`${loc.origin}${loc.pathname}`, CALLBACK);
    assert.equal(loc.searchParams.get('state'), 'xyz');
    const code = loc.searchParams.get('code')!;

    // the code: PKCE checked, once only
    const token = (o: Record<string, string>) => t.app.inject({ method: 'POST', url: '/oauth/token', ...form(o) });
    const tq = { grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: CALLBACK };
    assert.equal((await token({ ...tq, code_verifier: randomBytes(40).toString('base64url') })).json().error, 'invalid_grant');
    // a failed verifier burns the code: a fresh authorization is needed
    const okB = await post({ username: ADMIN.username, password: ADMIN.password, code: rc[0]! });
    const code2 = new URL(String(okB.headers.location)).searchParams.get('code')!;
    const tok = await token({ ...tq, code: code2, code_verifier: verifier });
    assert.equal(tok.statusCode, 200, tok.body);
    const { access_token: access, refresh_token: refresh } = tok.json();
    assert.equal((await token({ ...tq, code: code2, code_verifier: verifier })).json().error, 'invalid_grant', 'one time only');
    // stored as hashes only
    assert.equal((t.db.prepare('SELECT count(*) n FROM mcp_tokens WHERE access_hash = ? OR refresh_hash = ?').get(access, refresh) as { n: number }).n, 0);

    // MCP: initialize, the tools (all read-only), a call
    const B = { authorization: `Bearer ${access}` };
    const rpc = (method: string, params: object = {}, id: number | null = 1) => t.app.inject({ method: 'POST', url: '/mcp', headers: B, payload: { jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params } });
    const init = (await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })).json();
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal((await rpc('notifications/initialized', {}, null)).statusCode, 202);
    const tools = (await rpc('tools/list')).json().result.tools as Array<{ name: string; annotations: { readOnlyHint: boolean } }>;
    assert.ok(tools.length >= 10 && tools.every((x) => x.annotations.readOnlyHint), JSON.stringify(tools.map((x) => x.name)));

    // a work order with a phone and a PPPoE password: the customer's name goes out, the phone and the password never
    await t.app.inject({
      method: 'POST',
      url: '/api/admin/work-orders',
      headers: H,
      payload: { day: new Date().toISOString().slice(0, 10), kind: 'repair', customer: 'ROSSI MARIO', contact: '3331234567', pppoeUser: 'rossi.mario@cda-net.it', pppoePassword: 'segreta-123' },
    });
    const wo = (await rpc('tools/call', { name: 'interventi', arguments: {} })).json().result;
    assert.ok(!wo.isError, JSON.stringify(wo));
    const text = wo.content[0].text as string;
    assert.ok(text.includes('ROSSI MARIO'));
    assert.ok(!text.includes('3331234567') && !text.includes('segreta-123'), text);
    // every tool answers (an error is said, never thrown), none crashes without the external services
    for (const tool of tools) {
      const r = await rpc('tools/call', { name: tool.name, arguments: tool.name === 'diagnosi' ? { pppoeUser: 'rossi.mario@cda-net.it' } : {} });
      assert.equal(r.statusCode, 200, `${tool.name}: ${r.body}`);
      assert.equal(typeof r.json().result.content[0].text, 'string', tool.name);
    }
    assert.equal((await rpc('tools/call', { name: 'diagnosi', arguments: {} })).json().result.isError, true, 'needs a subject');
    assert.equal((await rpc('tools/call', { name: 'cancella_tutto', arguments: {} })).json().result.isError, true);
    assert.equal((await rpc('resources/list')).json().error.code, -32601);
    // in the activity log: the tool, not the data
    assert.ok((t.db.prepare("SELECT count(*) n FROM events WHERE action = 'mcp.call' AND target = 'interventi'").get() as { n: number }).n >= 1);
    // a browser page of another site cannot use it
    assert.equal((await t.app.inject({ method: 'POST', url: '/mcp', headers: { ...B, origin: 'https://evil.example' }, payload: { jsonrpc: '2.0', id: 1, method: 'ping' } })).statusCode, 403);

    // refresh rotates; the old refresh used again closes the connection
    const r1 = (await token({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId })).json();
    assert.ok(r1.access_token && r1.refresh_token !== refresh);
    assert.equal((await token({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId })).json().error, 'invalid_grant');
    assert.equal((await t.app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${r1.access_token}` }, payload: { jsonrpc: '2.0', id: 1, method: 'ping' } })).statusCode, 401);

    // the console sees the connections and revokes; a new password ends them too
    const okC = await post({ username: ADMIN.username, password: ADMIN.password, code: rc[1]! });
    const tok3 = (await token({ ...tq, code: new URL(String(okC.headers.location)).searchParams.get('code')!, code_verifier: verifier })).json();
    const list = (await t.app.inject({ method: 'GET', url: '/api/admin/mcp', headers: H })).json();
    assert.match(list.url, /\/mcp$/);
    const active = list.connections.filter((c: { active: boolean }) => c.active);
    assert.equal(active.length, 1);
    assert.equal((await t.app.inject({ method: 'DELETE', url: `/api/admin/mcp/connections/${active[0].id}`, headers: H })).statusCode, 200);
    assert.equal((await t.app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${tok3.access_token}` }, payload: { jsonrpc: '2.0', id: 1, method: 'ping' } })).statusCode, 401);
    const okD = await post({ username: ADMIN.username, password: ADMIN.password, code: rc[2]! });
    const tok4 = (await token({ ...tq, code: new URL(String(okD.headers.location)).searchParams.get('code')!, code_verifier: verifier })).json();
    t.db.prepare('UPDATE users SET token_version = token_version + 1 WHERE username = ?').run(ADMIN.username);
    assert.equal((await t.app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${tok4.access_token}` }, payload: { jsonrpc: '2.0', id: 1, method: 'ping' } })).statusCode, 401, 'password changed: connection over');
    await t.app.close();
  });

  it('only https redirects, or back to this computer; secrets and contact details never leave', () => {
    assert.ok(redirectAllowed('https://claude.ai/api/mcp/auth_callback'));
    assert.ok(redirectAllowed('https://claude.com/api/mcp/auth_callback'));
    assert.ok(redirectAllowed('http://localhost:6274/oauth/callback'));
    assert.ok(redirectAllowed('http://127.0.0.1:3334/oauth/callback'));
    assert.ok(!redirectAllowed('https://evil.example/cb'));
    assert.ok(!redirectAllowed('https://claude.ai.evil.example/cb'));
    assert.ok(!redirectAllowed('https://claude.ai:8443/cb'));
    assert.ok(!redirectAllowed('http://claude.ai/cb'));
    assert.equal(returnPlace('http://localhost:6274/cb'), 'questo computer (porta 6274)');
    assert.equal(clientName(['http://127.0.0.1:3334/cb']), 'Claude su questo computer');
    assert.ok(!redirectAllowed('https://claude.ai/cb#x'));
    assert.ok(!redirectAllowed('javascript:alert(1)'));
    const out = sanitize({ customer: 'ROSSI', contact: '333', phone: '333', pppoePassword: 'x', wpa2Psk: 'y', token: 'z', nested: [{ apName: 'N38-D02', email: 'a@b.it', footprint: 1 }] }) as Record<string, unknown>;
    assert.deepEqual(out, { customer: 'ROSSI', nested: [{ apName: 'N38-D02', footprint: 1 }] });
    const long = sanitize(Array.from({ length: 250 }, (_, i) => i)) as unknown[];
    assert.equal(long.length, 201);
  });

  it('«Consenti anche le modifiche»: the writes only for that connection, each one in the log', async () => {
    const t = await testApp();
    const admin = await t.login();
    const H = t.auth(admin);
    const setup = (await t.app.inject({ method: 'POST', url: '/api/auth/totp/setup', headers: H, payload: { password: ADMIN.password } })).json();
    const step = currentStep();
    const rc = (await t.app.inject({ method: 'POST', url: '/api/auth/totp/enable', headers: H, payload: { code: codeAt(setup.secret, step) } })).json().recoveryCodes as string[];
    const clientId = (await t.app.inject({ method: 'POST', url: '/oauth/register', payload: { redirect_uris: [CALLBACK] } })).json().client_id as string;
    const verifier = randomBytes(40).toString('base64url');
    const q = { response_type: 'code', client_id: clientId, redirect_uri: CALLBACK, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' };
    const connect = async (code: string, write: boolean) => {
      const ok = await t.app.inject({ method: 'POST', url: '/oauth/authorize', ...form({ ...q, decision: 'allow', username: ADMIN.username, password: ADMIN.password, code, ...(write ? { write: '1' } : {}) }) });
      const c = new URL(String(ok.headers.location)).searchParams.get('code')!;
      const tok = (await t.app.inject({ method: 'POST', url: '/oauth/token', ...form({ grant_type: 'authorization_code', code: c, client_id: clientId, redirect_uri: CALLBACK, code_verifier: verifier }) })).json();
      return (method: string, params: object = {}) => t.app.inject({ method: 'POST', url: '/mcp', headers: { authorization: `Bearer ${tok.access_token}` }, payload: { jsonrpc: '2.0', id: 1, method, params } });
    };
    // the consent page offers the choice
    assert.match((await t.app.inject({ method: 'GET', url: `/oauth/authorize?${new URLSearchParams(q)}` })).body, /Consenti anche le modifiche/);

    const ro = await connect(codeAt(setup.secret, step + 1), false);
    const roTools = (await ro('tools/list')).json().result.tools as Array<{ name: string }>;
    assert.ok(!roTools.some((x) => x.name === 'crea_intervento'), 'read-only: no write tools listed');
    const denied = (await ro('tools/call', { name: 'crea_intervento', arguments: { day: '2026-10-20', customer: 'ROSSI MARIO' } })).json().result;
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /sola lettura/);

    const rw = await connect(rc[0]!, true);
    const tools = (await rw('tools/list')).json().result.tools as Array<{ name: string; annotations: { readOnlyHint: boolean; destructiveHint?: boolean } }>;
    const create = tools.find((x) => x.name === 'crea_intervento')!;
    assert.equal(create.annotations.readOnlyHint, false);
    assert.equal(tools.find((x) => x.name === 'riavvia_cpe')!.annotations.destructiveHint, true);
    const made = (await rw('tools/call', { name: 'crea_intervento', arguments: { day: '2026-10-20', kind: 'repair', customer: 'ROSSI MARIO', notes: 'via Claude' } })).json().result;
    assert.ok(!made.isError, JSON.stringify(made));
    const wo = t.db.prepare("SELECT id, customer, status FROM work_orders WHERE customer = 'ROSSI MARIO'").get() as { id: number; customer: string; status: string };
    assert.ok(wo);
    const moved = (await rw('tools/call', { name: 'modifica_intervento', arguments: { id: wo.id, day: '2026-10-21', status: 'postponed' } })).json().result;
    assert.ok(!moved.isError, JSON.stringify(moved));
    assert.deepEqual({ ...(t.db.prepare('SELECT day, status FROM work_orders WHERE id = ?').get(wo.id) as object) }, { day: '2026-10-21', status: 'postponed' });
    // a missing argument is said, nothing happens
    assert.match((await rw('tools/call', { name: 'modifica_intervento', arguments: {} })).json().result.content[0].text, /non valido/);
    // the network without UISP: an error said plainly, never a crash
    assert.equal((await rw('tools/call', { name: 'riavvia_cpe', arguments: { deviceId: 'abc' } })).json().result.isError, true);
    const log = t.db.prepare("SELECT target, detail FROM events WHERE action = 'mcp.call' AND detail LIKE 'modifica via Claude%'").all() as Array<{ target: string }>;
    assert.ok(log.some((e) => e.target === 'crea_intervento') && log.some((e) => e.target === 'riavvia_cpe'), JSON.stringify(log));
    // the console sees which connections may write
    const conns = (await t.app.inject({ method: 'GET', url: '/api/admin/mcp', headers: H })).json().connections as Array<{ canWrite: boolean }>;
    assert.deepEqual(conns.map((c) => c.canWrite).sort(), [false, true]);
    await t.app.close();
  });
});
