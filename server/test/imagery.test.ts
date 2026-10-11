import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { KEY_FORMAT, keyTileUrl, tileBounds3857, wmsTileUrl, WMS_DEFAULT } from '../src/services/imagery.ts';
import { ADMIN, testConfig } from './helpers.ts';

const MAPBOX = 'pk.eyJ1IjoiZGVtbyIsImEiOiJ0ZXN0In0.c2VncmV0b2RpcHJvdmE';
const ESRI = 'AAPKdemo0123456789abcdefghijklmnopqrstuvwxyz';
const GOOGLE = 'AIzaSyDemo0123456789abcdefghijklmnopq';
const jpeg = () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]), { status: 200, headers: { 'content-type': 'image/jpeg' } });

describe('Mappe admin: immagini satellitari da più fonti', () => {
  it('tile URLs of each provider and key formats', () => {
    assert.match(keyTileUrl('mapbox', 'satellite', 12, 2200, 1600, MAPBOX), /^https:\/\/api\.mapbox\.com\/v4\/mapbox\.satellite\/12\/2200\/1600@2x\.jpg90\?access_token=pk\./);
    assert.match(keyTileUrl('mapbox', 'hybrid', 12, 2200, 1600, MAPBOX), /satellite-streets-v12\/tiles\/256\/12\/2200\/1600@2x/);
    assert.match(keyTileUrl('esri', 'satellite', 12, 2200, 1600, ESRI), /World_Imagery\/MapServer\/tile\/12\/1600\/2200\?token=AAPK/, 'Esri: z/y/x');
    assert.match(keyTileUrl('esri', 'labels', 12, 2200, 1600, ESRI), /Reference\/World_Boundaries_and_Places/);
    const [minx, miny, maxx, maxy] = tileBounds3857(1, 1, 0);
    assert.deepEqual([Math.round(minx), Math.round(miny), Math.round(maxx), Math.round(maxy)], [0, 0, 20037508, 20037508]);
    const w = wmsTileUrl(WMS_DEFAULT.url, WMS_DEFAULT.layers, 13, 4419, 3174);
    assert.ok(w.startsWith(`${WMS_DEFAULT.url}&SERVICE=WMS`), w);
    assert.match(w, /CRS=EPSG%3A3857/);
    assert.match(w, /LAYERS=OI\.ORTOIMMAGINI\.2012\.32%2COI\.ORTOIMMAGINI\.2012\.33/);
    assert.ok(KEY_FORMAT.mapbox.test(MAPBOX) && KEY_FORMAT.esri.test(ESRI) && KEY_FORMAT.google.test(GOOGLE));
    assert.ok(!KEY_FORMAT.google.test('abc'));
  });

  it('every provider switched on is offered to admins, through the server, keys never sent back', async () => {
    const calls: string[] = [];
    let sessions = 0;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith('https://tile.googleapis.com/v1/createSession')) {
        sessions++;
        const body = JSON.parse(String(init?.body));
        assert.equal(body.mapType, 'satellite');
        return Response.json({ session: `sess-${sessions}`, expiry: String(Math.floor(Date.now() / 1000) + 86_400) });
      }
      // the first tile of the first session is refused: a new session is asked, once
      if (url.startsWith('https://tile.googleapis.com/v1/2dtiles/')) return url.includes('session=sess-1') ? new Response('expired', { status: 400 }) : jpeg();
      if (url.includes('access_token=pk.bad')) return new Response('no', { status: 401 });
      if (url.startsWith('http://wms.example/err')) return new Response('<ServiceExceptionReport/>', { status: 200, headers: { 'content-type': 'text/xml' } });
      if (url.startsWith('https://api.mapbox.com/') || url.startsWith('https://ibasemaps-api.arcgis.com/') || url.startsWith('http://wms.pcn.minambiente.it/')) return jpeg();
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    const db = openDatabase(':memory:');
    const cfg = testConfig();
    const { app } = await buildApp(cfg, 'test', { db, logger: false, fetchImpl });
    await app.ready();
    const login = async (username: string, password: string) => ({ authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } })).json().token}` });
    const H = await login(ADMIN.username, ADMIN.password);
    await app.inject({ method: 'POST', url: '/api/admin/users', headers: H, payload: { username: 'tecnico', password: 'Installer-Pass-123' } });
    const T = await login('tecnico', 'Installer-Pass-123');
    const put = (p: string, payload: object) => app.inject({ method: 'PUT', url: `/api/admin/connectors/imagery/${p}`, headers: H, payload });
    const get = (url: string, headers = H) => app.inject({ method: 'GET', url, headers });

    let info = (await get('/api/admin/map/satellite')).json();
    assert.deepEqual(info, { available: false, layers: [], terrain: { minZoom: 10, maxZoom: 14, fine: false } }, 'nothing configured: the usual basemap (and the 3D terrain from SRTM)');
    assert.equal((await get('/api/admin/map/imagery/mapbox/satellite/13/4419/3174')).statusCode, 503);
    assert.equal((await put('mapbox', { enabled: true, key: MAPBOX })).statusCode, 200);
    info = (await get('/api/admin/map/satellite')).json();
    assert.deepEqual(info.layers.map((l: { label: string }) => l.label), ['Satellite · Mapbox', 'Ibrida · Mapbox']);

    // wrong keys
    assert.equal((await put('google', { enabled: true, key: 'nope' })).statusCode, 400);
    assert.deepEqual((await app.inject({ method: 'POST', url: '/api/admin/connectors/imagery/mapbox/test', headers: H, payload: { key: 'pk.bad.token' } })).json(), { ok: false, error: 'imagery_key_rejected' });

    for (const [p, key] of [['esri', ESRI], ['google', GOOGLE]]) assert.equal((await put(p!, { enabled: true, key })).statusCode, 200);
    assert.equal((await put('wms', { enabled: true })).statusCode, 200, 'WMS: the AGEA defaults');
    const view = await get('/api/admin/connectors');
    for (const k of [MAPBOX, ESRI, GOOGLE]) assert.ok(!view.body.includes(k), 'no key in the view');
    assert.equal(view.json().imagery.wms.layers, WMS_DEFAULT.layers);

    info = (await get('/api/admin/map/satellite')).json();
    assert.deepEqual(
      info.layers.map((l: { label: string }) => l.label),
      ['Satellite · Mapbox', 'Ibrida · Mapbox', 'Satellite · Esri', 'Ibrida · Esri', 'Satellite · Google', 'Ibrida · Google', WMS_DEFAULT.label],
    );
    assert.equal(info.layers.find((l: { id: string }) => l.id === 'esri-hybrid').parts.length, 3, 'Esri hybrid: imagery, roads, places');

    for (const path of ['mapbox/hybrid', 'esri/roads', 'google/satellite', 'wms/ortofoto']) {
      const t = await get(`/api/admin/map/imagery/${path}/13/4419/3174`);
      assert.equal(t.statusCode, 200, `${path}: ${t.body}`);
      assert.equal(t.headers['content-type'], 'image/jpeg');
      assert.match(String(t.headers['cache-control']), /private/);
    }
    assert.equal(sessions, 2, 'Google: refused session renewed once');
    assert.equal((await get('/api/admin/map/imagery/google/satellite/13/4420/3174')).statusCode, 200);
    assert.equal(sessions, 2, 'Google: the session is reused');
    assert.equal((await get('/api/admin/map/imagery/wms/ortofoto/5/17/12')).statusCode, 204, 'orthophotos only from zoom 9');
    assert.equal((await get('/api/admin/map/imagery/esri/hybrid/13/4419/3174')).statusCode, 400, 'unknown part');

    // a WMS that answers an XML error: an error, not a broken image
    assert.equal((await put('wms', { enabled: true, url: 'http://wms.example/err?map=x', layers: 'a' })).statusCode, 200);
    assert.equal((await get('/api/admin/map/imagery/wms/ortofoto/13/4419/3174')).statusCode, 502);

    // installers and visitors: nothing
    assert.equal((await get('/api/admin/map/satellite', T)).statusCode, 403);
    assert.equal((await get('/api/admin/map/imagery/esri/satellite/13/4419/3174', T)).statusCode, 403);
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/map/imagery/esri/satellite/13/4419/3174' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'PUT', url: '/api/admin/connectors/imagery/esri', headers: T, payload: { enabled: false } })).statusCode, 403);

    // one provider removed, the others stay
    await app.inject({ method: 'DELETE', url: '/api/admin/connectors/imagery/google', headers: H });
    info = (await get('/api/admin/map/satellite')).json();
    assert.ok(!info.layers.some((l: { id: string }) => l.id.startsWith('google')));
    assert.ok(info.layers.some((l: { id: string }) => l.id === 'mapbox-satellite'));
    assert.ok(calls.every((u) => !u.includes('pk.bad') || u.includes('mapbox')));
    await app.close();
  });
});
