import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { codeAt, currentStep } from '../src/domain/totp.ts';
import { ADMIN, testConfig } from './helpers.ts';

const TOKEN = '42|Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0UvWxYz123456';
const CALLBACK = 'https://claude.ai/api/mcp/auth_callback';
const form = (o: Record<string, string>) => ({ payload: new URLSearchParams(o).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
const ANSWER = {
  coverage: [{ carrier: 'tim', technology: { value: 'FTTH', sticker: 'f', family: 'FTTX' }, covered: true, status: 'ATTIVO', data: { max_speed: 1000 } }],
  geodata: { id: '380100000000001', name_utf8: 'Enna', zip: '94100', street_type: 'VIA', street: 'DEMO', number: '1', abbreviation: 'EN', lat: 37.5668, lng: 14.2808 },
};

describe('Claude e gli altri operatori: il limite per connessione', () => {
  it('10 a minute that reach the service, in parallel too; the cache does not count', async () => {
    let calls = 0;
    const fetchImpl = (async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.host !== 'coverage.mywic.it') return new Response('{}', { status: 404 });
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return Response.json(ANSWER);
    }) as typeof fetch;
    const db = openDatabase(':memory:');
    const { app } = await buildApp(testConfig(), 'test', { db, logger: false, uisp: null, fetchImpl });
    const admin = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: ADMIN.username, password: ADMIN.password } })).json().token as string;
    const H = { authorization: `Bearer ${admin}` };
    await app.inject({ method: 'PUT', url: '/api/admin/connectors/mywic', headers: H, payload: { enabled: true, token: TOKEN } });
    // a Claude connection (read-only is enough: the coverage is a read)
    const setup = (await app.inject({ method: 'POST', url: '/api/auth/totp/setup', headers: H, payload: { password: ADMIN.password } })).json();
    const step = currentStep();
    await app.inject({ method: 'POST', url: '/api/auth/totp/enable', headers: H, payload: { code: codeAt(setup.secret, step) } });
    const clientId = (await app.inject({ method: 'POST', url: '/oauth/register', payload: { redirect_uris: [CALLBACK] } })).json().client_id as string;
    const verifier = randomBytes(40).toString('base64url');
    const q = { response_type: 'code', client_id: clientId, redirect_uri: CALLBACK, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' };
    const ok = await app.inject({ method: 'POST', url: '/oauth/authorize', ...form({ ...q, decision: 'allow', username: ADMIN.username, password: ADMIN.password, code: codeAt(setup.secret, step + 1) }) });
    const code = new URL(String(ok.headers.location)).searchParams.get('code')!;
    const tok = (await app.inject({ method: 'POST', url: '/oauth/token', ...form({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: CALLBACK, code_verifier: verifier }) })).json();
    const check = async (lat: number) => {
      const r = await app.inject({
        method: 'POST',
        url: '/mcp',
        headers: { authorization: `Bearer ${tok.access_token}` },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'copertura_altri_operatori', arguments: { lat, lon: 14.28 } } },
      });
      return r.json().result as { isError?: boolean; content: Array<{ text: string }> };
    };

    // one point three times: the service once, the cache twice (free)
    for (let i = 0; i < 3; i++) assert.ok(!(await check(37.5)).isError);
    assert.equal(calls, 1);
    // nine more points at once: they all go (10 in all)
    const nine = await Promise.all(Array.from({ length: 9 }, (_, i) => check(37.51 + i * 0.01)));
    assert.ok(nine.every((r) => !r.isError), JSON.stringify(nine.filter((r) => r.isError)));
    assert.equal(calls, 10);
    // the eleventh new point: refused before reaching the service
    const eleventh = await check(37.7);
    assert.equal(eleventh.isError, true);
    assert.match(eleventh.content[0]!.text, /Limite di 10 verifiche/);
    assert.equal(calls, 10);
    // in parallel past the limit: none slips through
    const burst = await Promise.all(Array.from({ length: 5 }, (_, i) => check(38 + i * 0.01)));
    assert.ok(burst.every((r) => r.isError));
    assert.equal(calls, 10);
    await app.close();
  });
});
