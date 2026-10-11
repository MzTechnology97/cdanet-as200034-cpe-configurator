import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { isMapboxToken, mapboxTileUrl } from '../src/services/mapbox.ts';
import { ADMIN, testConfig } from './helpers.ts';

const TOKEN = 'pk.eyJ1IjoiZGVtbyIsImEiOiJ0ZXN0In0.c2VncmV0b2RpcHJvdmE';

describe('Mappe admin: satellite Mapbox', () => {
  it('tile URLs and token format', () => {
    assert.match(mapboxTileUrl('satellite', 12, 2200, 1600, TOKEN), /^https:\/\/api\.mapbox\.com\/v4\/mapbox\.satellite\/12\/2200\/1600@2x\.jpg90\?access_token=pk\./);
    assert.match(mapboxTileUrl('hybrid', 12, 2200, 1600, TOKEN), /styles\/v1\/mapbox\/satellite-streets-v12\/tiles\/256\/12\/2200\/1600@2x/);
    assert.ok(isMapboxToken(TOKEN));
    assert.ok(!isMapboxToken('abc'));
  });

  it('admins get the imagery through the server; the token never leaves it; installers get nothing', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith('https://api.mapbox.com/')) {
        calls.push(url);
        if (url.includes('access_token=pk.bad')) return new Response('{"message":"Not Authorized"}', { status: 401 });
        return new Response(new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    const { app } = await buildApp(testConfig(), 'test', { db: openDatabase(':memory:'), logger: false, fetchImpl });
    await app.ready();
    const login = async (username: string, password: string) => ({ authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } })).json().token}` });
    const H = await login(ADMIN.username, ADMIN.password);
    await app.inject({ method: 'POST', url: '/api/admin/users', headers: H, payload: { username: 'tecnico', password: 'Installer-Pass-123' } });
    const T = await login('tecnico', 'Installer-Pass-123');

    // not configured yet
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/map/satellite', headers: H })).json().available, false);
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/map/satellite/satellite/10/551/405', headers: H })).statusCode, 503);

    // a wrong token: refused by the test, with the reason
    const bad = (await app.inject({ method: 'POST', url: '/api/admin/connectors/mapbox/test', headers: H, payload: { token: 'pk.bad.token' } })).json();
    assert.deepEqual(bad, { ok: false, error: 'mapbox_token_rejected' });
    assert.equal((await app.inject({ method: 'PUT', url: '/api/admin/connectors/mapbox', headers: H, payload: { enabled: true, token: 'not-a-token' } })).statusCode, 400);

    const saved = await app.inject({ method: 'PUT', url: '/api/admin/connectors/mapbox', headers: H, payload: { enabled: true, token: TOKEN } });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.ok(!saved.body.includes(TOKEN), 'the token is never sent back');
    assert.equal(saved.json().tokenHint, `…${TOKEN.slice(-4)}`);
    const connectors = await app.inject({ method: 'GET', url: '/api/admin/connectors', headers: H });
    assert.ok(!connectors.body.includes(TOKEN));
    assert.equal(connectors.json().mapbox.enabled, true);

    const info = (await app.inject({ method: 'GET', url: '/api/admin/map/satellite', headers: H })).json();
    assert.equal(info.available, true);
    assert.match(info.attribution, /Mapbox/);
    const tile = await app.inject({ method: 'GET', url: '/api/admin/map/satellite/hybrid/10/551/405', headers: H });
    assert.equal(tile.statusCode, 200);
    assert.equal(tile.headers['content-type'], 'image/jpeg');
    assert.match(String(tile.headers['cache-control']), /private/);
    assert.ok(!JSON.stringify(tile.headers).includes(TOKEN));
    assert.ok(calls.at(-1)!.includes('satellite-streets-v12'));
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/map/satellite/satellite/3/9/1', headers: H })).statusCode, 400, 'tile outside the zoom level');

    // installers: no imagery, no settings
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/map/satellite', headers: T })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/map/satellite/satellite/10/551/405', headers: T })).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/map/satellite/satellite/10/551/405' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/admin/connectors/mapbox', headers: T, payload: { enabled: false } })).statusCode, 403);

    // switched off: no imagery
    await app.inject({ method: 'PUT', url: '/api/admin/connectors/mapbox', headers: H, payload: { enabled: false } });
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/map/satellite', headers: H })).json().available, false);
    await app.close();
  });
});
