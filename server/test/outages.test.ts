import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { parseReverse } from '../src/services/geocode.ts';
import { impactOf, mapFeature, parseEnelDate, zonesOf } from '../src/services/outages.ts';
import { fakeUisp } from './fake-uisp.ts';
import { ADMIN, testConfig } from './helpers.ts';

const feature = (id: number, code: string, cause: string, lat: number, lon: number, place: string) => ({
  attributes: {
    id_interruzione: id, causa_interruzione: code, causa_disalimentazione: cause, num_cli_disalim: 167,
    data_interruzione: '09/10/2026 08:00', data_prev_ripristino: '09/10/2026 15:50', dataultimoaggiornamento: '09/10/2026 10:32',
    descrizione_territoriale: place, provincia: 'Enna', regione: 'Isole', latitudine: lat, longitudine: lon,
  },
  geometry: { x: lon, y: lat },
});

describe('Guasti Enel (e-distribuzione)', () => {
  it('maps features and finds the zones', () => {
    assert.equal(parseEnelDate('09/10/2026 15:50'), '2026-10-09T15:50');
    assert.equal(parseEnelDate(''), null);
    const o = mapFeature(feature(1, 'GM', 'Guasto', 37.6, 14.1, 'ENNA'))!;
    assert.equal(o.kind, 'guasto_mt');
    assert.equal(o.customers, 167);
    const z = zonesOf(o, [
      { id: 'a', name: 'AP N2', lat: 37.601, lon: 14.101, radiusKm: 3, source: 'ap' },
      { id: 'b', name: 'Lontano', lat: 38.1, lon: 13.3, radiusKm: 5, source: 'manual' },
    ]);
    assert.equal(z.length, 1);
    assert.equal(z[0]!.zone.name, 'AP N2');
    assert.ok(z[0]!.distanceM < 200);
  });

  it('finds POPs and APs very close to an outage', () => {
    const infra = {
      pops: [{ id: 's1', name: 'POP Monte', lat: 37.6, lon: 14.1, stations: 40 }],
      aps: [
        { id: 'a1', name: 'AP N2', lat: 37.6005, lon: 14.1005, stations: 12, siteId: 's1' },
        { id: 'a2', name: 'AP lontano', lat: 37.7, lon: 14.3, stations: 3, siteId: null },
      ],
    };
    const imp = impactOf({ lat: 37.6048, lon: 14.1 }, infra, 1);
    assert.deepEqual(imp.map((i) => `${i.type}:${i.name}`), ['ap:AP N2', 'pop:POP Monte']);
    assert.equal(imp[1]!.stations, 40);
    assert.equal(impactOf({ lat: 37.62, lon: 14.1 }, infra, 1).length, 0);
  });

  it('turns a GPS position into an Italian address', () => {
    const r = parseReverse({
      display_name: 'Via Roma, 12, Enna, Libero consorzio comunale di Enna, Sicilia, 94100, Italia',
      address: { road: 'Via Roma', house_number: '12', town: 'Enna', county: 'Libero consorzio comunale di Enna', 'ISO3166-2-lvl6': 'IT-EN', postcode: '94100' },
    })!;
    assert.deepEqual({ ...r, label: '' }, { label: '', street: 'Via Roma', houseNumber: '12', city: 'Enna', province: 'Enna', postcode: '94100' });
    assert.equal(parseReverse({ error: 'Unable to geocode' }), null);
  });

  it('polls, stores outages in the zones, notifies new ones and restorations; app feed token', async () => {
    const uisp = fakeUisp();
    let features = [
      feature(10, 'GM', 'Guasto', 37.605, 14.105, 'ENNA ALTA'), // near AP N2 (37.6, 14.1)
      feature(11, 'LV', 'Lavoro Programmato', 37.58, 14.12, 'VIA ROMA'), // near the manual zone
      feature(12, 'GB', 'Guasto', 38.9, 16.5, 'FUORI ZONA'),
    ];
    const queries: string[] = [];
    const sent: string[] = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.host === 'dpa-portalgis.enel.com') {
        queries.push(url.search);
        return Response.json({ features, exceededTransferLimit: false });
      }
      if (url.host === 'nominatim.openstreetmap.org' && url.pathname === '/reverse') {
        return Response.json({ display_name: 'Via Roma 1, Enna', address: { road: 'Via Roma', house_number: '1', town: 'Enna', county: 'Enna', postcode: '94100' } });
      }
      if (url.host === 'api.telegram.org') {
        sent.push(JSON.parse(String(init?.body)).text);
        return Response.json({ ok: true, result: {} });
      }
      return uisp.fetchImpl(input, init);
    }) as typeof fetch;
    const { app, ctx } = await buildApp(testConfig(), 'test', { db: openDatabase(':memory:'), logger: false, uisp: uisp.uisp, fetchImpl, telegramIntervalMs: 0 });
    const tok = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: ADMIN.username, password: ADMIN.password } })).json().token;
    const H = { authorization: `Bearer ${tok}` };
    const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object, headers = H) => app.inject({ method, url, headers, payload });

    assert.equal((await call('GET', '/api/outages')).json().error, 'module_disabled');
    await call('PUT', '/api/admin/modules', { power_outages: true });
    await call('PUT', '/api/admin/connectors/telegram', { enabled: true, token: '123456789:AAHfake-token-for-tests-0123456789abcd', chatId: '-1001', events: ['power_outage'], summaryHour: 19 });

    // a manual zone + AP zones from UISP (3 km)
    assert.equal((await call('POST', '/api/admin/outages/zones', { name: 'Centro Enna', lat: 37.58, lon: 14.12, radiusKm: 1 })).statusCode, 201);
    const cfg = (await call('GET', '/api/admin/outages/config')).json();
    assert.ok(cfg.apZonesCount >= 1);

    const r1 = (await call('POST', '/api/admin/outages/refresh')).json();
    assert.equal(r1.ok, true, JSON.stringify(r1));
    assert.match(queries[0]!, /geometryType=esriGeometryEnvelope/);
    assert.deepEqual(r1.active.map((o: { id: number }) => o.id).sort(), [10, 11]);
    await ctx.telegram.idle();
    assert.equal(sent.length, 2);
    assert.ok(sent.some((t) => t.includes('Guasto media tensione') && t.includes('ENNA ALTA')));
    // ENNA ALTA is ~700 m from AP N2 D01 and its POP (Nodo 2 - Monte): flagged as potentially affected
    const mt = r1.active.find((o: { id: number }) => o.id === 10);
    assert.ok(mt.impact.some((i: { type: string; name: string }) => i.type === 'ap' && i.name === 'AP N2 D01'), JSON.stringify(mt.impact));
    assert.ok(mt.impact.some((i: { type: string }) => i.type === 'pop'));
    assert.equal(r1.active[0].id, 10, 'impacted outages first');
    assert.ok(sent.some((t) => t.startsWith('🚨') && t.includes('Potenzialmente impattati')));
    const rev = (await call('GET', '/api/geocode/reverse?lat=37.56&lon=14.28')).json();
    assert.equal(rev.street, 'Via Roma');
    assert.equal(rev.postcode, '94100');

    // second poll: same outages -> no new messages
    await call('POST', '/api/admin/outages/refresh');
    await ctx.telegram.idle();
    assert.equal(sent.length, 2);

    // planned works off; the fault ends -> restoration message
    await call('PUT', '/api/admin/outages/config', { includePlanned: false });
    features = [];
    await call('POST', '/api/admin/outages/refresh');
    await ctx.telegram.idle();
    assert.ok(sent.some((t) => t.includes('Ripristinato') && t.includes('ENNA ALTA')));
    const after = (await call('GET', '/api/outages?recent=1')).json();
    assert.equal(after.active.length, 0);
    assert.equal(after.recent.length, 2);

    // app background feed: scoped token works only on the feed, never as a session
    const device = (await call('POST', '/api/outages/device-token')).json().token;
    const feed = await app.inject({ method: 'GET', url: '/api/outages/feed', headers: { authorization: `Bearer ${device}` } });
    assert.equal(feed.statusCode, 200, feed.body);
    assert.deepEqual(feed.json().active, []);
    assert.equal((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${device}` } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/api/outages/feed', headers: H })).statusCode, 401, 'session token is not a feed token');
    await call('POST', '/api/auth/logout-all');
    assert.equal((await app.inject({ method: 'GET', url: '/api/outages/feed', headers: { authorization: `Bearer ${device}` } })).statusCode, 401, 'revoked with the sessions');
    await app.close();
  });
});
