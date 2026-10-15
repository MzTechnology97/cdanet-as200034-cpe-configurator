import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { forInstaller, groupOps, opsAddress, opsRow, stickerOf } from '../src/services/coverage-operators.ts';
import { ADMIN, testConfig } from './helpers.ts';

const TOKEN = '42|Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0UvWxYz123456';
const RULES = { fwaMinMbps: 30, vhcnTechs: [] as string[] };

/** A row as the service gives it (shape of a real answer, fictitious values). */
const row = (carrier: string, value: string, sticker: string, family: string, covered: boolean, status: string, data: Record<string, unknown> | [] = []) => ({
  carrier: { name: carrier.toUpperCase(), value: carrier, description: carrier === 'tim' ? 'TIM' : carrier === 'eolo' ? 'Eolo' : carrier, logo_url: 'x' },
  agcom_sticker_url: 'x',
  technology: { name: value, value, description: value === 'FTTH' ? 'FTTHome' : value, sticker, family: { name: family, value: family, description: '', order: 1 } },
  family,
  covered,
  status,
  pops: [],
  data,
});
const ANSWER = {
  coverage: [
    row('tim', 'FTTH', 'f', 'FTTX', true, 'ATTIVO', { max_speed: 10000, edr: 'CENTRALE-X', edr_info: { id: 1 } }),
    row('tim', 'FTTC', 'fr', 'FTTX', true, 'ATTIVO', { max_speed: 200, velocita_down: 134.11, velocita_up: 31.16, distanza: 153.6 }),
    row('eolo', 'WIRELESS', 'w', 'FWA', true, 'ATTIVO', { max_speed: 30 }),
    row('eolo', 'WIRELESS_28', 'fw', 'FWA', true, 'ATTIVO', { max_speed: 300 }),
    row('fastweb', 'LTE', 'w', 'MOBILE', true, 'ATTIVO', { max_speed: 60 }),
    row('openfiber', 'FTTH', 'f', 'FTTX', false, 'NON ATTIVO', { max_speed: 2500 }),
    row('fibreconnect', 'FTTH', 'f', 'FTTX', false, 'STUDIO DI FATTIBILITÀ', { max_speed: 2500 }),
    row('wic', 'WIRELESS', 'w', 'FWA', false, 'NON ATTIVO', { max_speed: 0 }),
  ],
  geodata: { id: '380100000000001', name_utf8: 'Enna', zip: '94100', street_type: 'VIA', street: 'DEMO', number: '1', abbreviation: 'EN', lat: 37.5668, lng: 14.2808 },
};

describe('Copertura degli altri operatori', () => {
  it('computes the AGCOM sticker from technology and speed', () => {
    const s = (technology: string, family: string, maxMbps: number | null, sourceSticker = '', rules = RULES) => stickerOf({ technology, family, maxMbps, sourceSticker }, rules).sticker;
    assert.equal(s('FTTH', 'FTTX', 10000), 'F');
    assert.equal(s('FIBRA_P2P', 'P2P', 10000), 'F');
    assert.equal(s('FTTO', 'P2P', 1000), 'F');
    assert.equal(s('GPON_BUSINESS', 'FTTX', 1000), 'F');
    assert.equal(s('FTTC', 'FTTX', 200), 'FR', 'misto fibra-rame');
    assert.equal(stickerOf({ technology: 'FTTC', family: 'FTTX', maxMbps: 200, sourceSticker: 'fr' }, RULES).kind, 'fibra-rame');
    assert.equal(s('WIRELESS', 'FWA', 30), 'FR', 'FWA from 30 Mbit/s: misto fibra-radio');
    assert.equal(s('WIRELESS', 'FWA', 20), 'R', 'under 30: radio');
    assert.equal(s('WIRELESS_28', 'FWA', 300, 'fw', { fwaMinMbps: 30, vhcnTechs: ['WIRELESS_28'] }), 'FWA', 'blue only for the technologies the admin lists');
    assert.equal(s('LTE', 'MOBILE', 60), 'R');
    assert.equal(s('ADSL', 'XDSL', 20), 'R');
    assert.equal(s('NUOVA', 'ALTRO', null, 'f'), 'F', 'unknown technology: the source sticker');
  });

  it('keeps only what is needed from a row and groups them, best first', () => {
    const rows = ANSWER.coverage.map((r) => opsRow(r)!);
    assert.equal(rows[0]!.operator, 'TIM');
    assert.equal(rows[1]!.downMbps, 134.1);
    assert.ok(!JSON.stringify(rows).includes('CENTRALE-X'), 'never the technical details of the source');
    assert.deepEqual(
      rows.map((r) => r.state),
      ['available', 'available', 'available', 'available', 'available', 'none', 'planned', 'none'],
    );
    const g = groupOps(rows, RULES);
    assert.equal(g.best, 'F');
    assert.equal(g.available, 5);
    assert.deepEqual(
      g.groups.map((x) => [x.sticker, x.rows.length, x.available]),
      [
        ['F', 3, 1],
        ['FR', 3, 3],
        ['R', 2, 1],
      ],
    );
    assert.deepEqual(
      g.groups[0]!.rows.map((r) => r.state),
      ['available', 'planned', 'none'],
      'what can be activated first',
    );
    assert.equal(opsAddress(ANSWER.geodata)?.label, 'VIA DEMO 1, 94100 Enna (EN)');
  });

  it('admins check a point; the answer is reused, «Rileggi» reads it again', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.host !== 'coverage.mywic.it') return new Response('{}', { status: 404 });
      if (new Headers(init?.headers).get('authorization') !== `Bearer ${TOKEN}`) return Response.json({ message: 'Unauthenticated.' }, { status: 401 });
      calls.push(url.pathname + url.search);
      if (url.pathname === '/api/v1/coverage/check') return Response.json(ANSWER);
      return Response.json({ message: 'Not found' }, { status: 404 });
    }) as typeof fetch;
    const db = openDatabase(':memory:');
    const { app } = await buildApp(testConfig(), 'test', { db, logger: false, uisp: null, fetchImpl });
    const login = async (u: string, p: string) => ({ authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: p } })).json().token}` });
    const A = await login(ADMIN.username, ADMIN.password);
    const get = (url: string, headers = A) => app.inject({ method: 'GET', url, headers });
    const at = '/api/admin/coverage/operators?lat=37.56679&lon=14.28077';

    assert.equal((await get(at)).json().error, 'operators_not_configured');
    await app.inject({ method: 'PUT', url: '/api/admin/connectors/mywic', headers: A, payload: { enabled: true, token: TOKEN } });

    const r = (await get(at)).json();
    assert.equal(r.best, 'F');
    assert.equal(r.cached, false);
    assert.equal(r.address.label, 'VIA DEMO 1, 94100 Enna (EN)');
    assert.equal(r.groups[0].rows[0].operator, 'TIM');
    assert.match(calls[0]!, /^\/api\/v1\/coverage\/check\?lat=37\.566790&lng=14\.280770$/);
    assert.equal((await get(at)).json().cached, true, 'the same point: from the cache');
    assert.equal(calls.length, 1);
    assert.equal((await get(`${at}&refresh=1`)).json().cached, false);
    assert.equal(calls.length, 2);

    // the admin gives the blue sticker to 28 GHz: the saved answer is grouped again, no new call
    await app.inject({ method: 'PUT', url: '/api/admin/server-settings', headers: A, payload: { values: { 'coverageOps.vhcnTechs': 'WIRELESS_28' } } });
    const blue = (await get(at)).json();
    assert.deepEqual(blue.groups.map((g: { sticker: string }) => g.sticker), ['F', 'FWA', 'FR', 'R']);
    assert.equal(calls.length, 2);

    // installers: not for them (yet)
    await app.inject({ method: 'POST', url: '/api/admin/users', headers: A, payload: { username: 'tecnico', password: 'Installer-Pass-123' } });
    assert.equal((await get(at, await login('tecnico', 'Installer-Pass-123'))).statusCode, 403);

    // the activity log: the town, never the street
    const ev = db.prepare("SELECT target, detail FROM events WHERE action = 'coverage.operators'").all() as Array<{ target: string; detail: string }>;
    assert.equal(ev.length, 2, 'only the readings from the service');
    assert.equal(ev[0]!.target, 'Enna');
    assert.ok(!JSON.stringify(ev).includes('DEMO 1'));
    assert.equal((await get('/api/admin/coverage/operators?lat=200&lon=14')).statusCode, 400);
    await app.close();
  });

  it('finds the exact address step by step and shows installers no operator names', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      const url = new URL(String(input));
      calls.push(url.pathname + url.search);
      const p = url.searchParams;
      if (url.pathname === '/api/v1/geo/search') {
        if (!p.get('city')) return Response.json([{ istat: '086009', name: 'ENNA', name_utf8: 'Enna', prov_abbr: 'EN', zip: '94100' }]);
        if (!p.get('street')) return Response.json([{ city: 'ENNA', street: 'DEMO', street_type: 'VIA' }]);
        if (!p.get('number')) return Response.json(p.get('q') ? [{ city: 'ENNA', street: null, street_type: null, number: '1' }, { city: 'ENNA', street: null, street_type: null, number: '10' }] : []);
        return Response.json([{ city: 'ENNA', street: 'DEMO', street_type: 'VIA', number: p.get('number'), stair: null }]);
      }
      if (url.pathname === '/api/v1/geo/find') return p.get('number') === '99' ? Response.json({ message: 'No records found' }, { status: 404 }) : Response.json(ANSWER.geodata);
      if (url.pathname === '/api/v1/coverage/check') return Response.json(ANSWER);
      return Response.json({ message: 'Not found' }, { status: 404 });
    }) as typeof fetch;
    const db = openDatabase(':memory:');
    const { app } = await buildApp(testConfig(), 'test', { db, logger: false, uisp: null, fetchImpl });
    const login = async (u: string, p: string) => ({ authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: p } })).json().token}` });
    const A = await login(ADMIN.username, ADMIN.password);
    await app.inject({ method: 'PUT', url: '/api/admin/connectors/mywic', headers: A, payload: { enabled: true, token: TOKEN } });
    await app.inject({ method: 'POST', url: '/api/admin/users', headers: A, payload: { username: 'tecnico', password: 'Installer-Pass-123' } });
    const T = await login('tecnico', 'Installer-Pass-123');
    const get = (url: string, headers = A) => app.inject({ method: 'GET', url, headers });
    const places = '/api/admin/coverage/operators/places';

    assert.deepEqual((await get(`${places}?q=E`)).json(), { step: 'city', items: [] }, 'at least 2 letters');
    assert.deepEqual((await get(`${places}?q=En`)).json().items, [{ city: 'ENNA', label: 'Enna (EN)', zip: '94100' }]);
    assert.deepEqual((await get(`${places}?city=ENNA&q=de`)).json().items, [{ street: 'DEMO', streetType: 'VIA', label: 'VIA DEMO' }]);
    assert.equal((await get(`${places}?city=ENNA&street=DEMO&streetType=VIA&q=1`, T)).statusCode, 403, "the admin route is not for installers");
    assert.deepEqual((await get(`/api/field/coverage/operators/places?city=ENNA&street=DEMO&streetType=VIA&q=1`, T)).json().items, [{ number: '1' }, { number: '10' }], 'installers too');
    assert.deepEqual((await get(`${places}?city=ENNA&street=DEMO&streetType=VIA&number=1`)).json(), { step: 'stair', items: [{ stair: null }] });
    const before = calls.length;
    await get(`${places}?q=En`);
    assert.equal(calls.length, before, 'a step asked again: from memory');

    const at = '/api/admin/coverage/operators?city=ENNA&street=DEMO&streetType=VIA&number=1';
    const r = (await get(at)).json();
    assert.equal(r.address.geoid, '380100000000001');
    assert.ok(calls.some((c) => c === '/api/v1/geo/find?city=ENNA&street=DEMO&street_type=VIA&number=1'));
    assert.ok(calls.some((c) => c === '/api/v1/coverage/check?geoid=380100000000001'), 'by GeoID, not by coordinates');
    assert.equal((await get(at)).json().cached, true);
    assert.equal((await get('/api/admin/coverage/operators?city=ENNA&street=DEMO&streetType=VIA&number=99')).json().error, 'operators_address_not_found');
    assert.equal((await get('/api/admin/coverage/operators')).statusCode, 400);

    // installers: the same answer, without names, without the GeoID, never a forced reading
    const checks = calls.filter((c) => c.startsWith('/api/v1/coverage/check')).length;
    const f = await get('/api/field/coverage/operators?city=ENNA&street=DEMO&streetType=VIA&number=1&refresh=1', T);
    assert.equal(f.statusCode, 200, f.body);
    assert.equal(calls.filter((c) => c.startsWith('/api/v1/coverage/check')).length, checks, 'refresh ignored for installers');
    for (const n of ['TIM', 'Eolo', 'fastweb', 'openfiber', 'fibreconnect', 'wic', '380100000000001']) assert.ok(!f.body.includes(n), `never «${n}» to installers`);
    const fj = f.json();
    assert.equal(fj.best, 'F');
    assert.equal(fj.address.label, 'VIA DEMO 1, 94100 Enna (EN)');
    await app.close();
  });

  it('merges the rows installers see, so the operators cannot be counted', () => {
    const g = groupOps(['tim', 'fastweb'].map((c) => opsRow(row(c, 'FTTH', 'f', 'FTTX', true, 'ATTIVO', { max_speed: 2500 }))!), RULES);
    const shown = forInstaller({ address: null, ...g });
    assert.deepEqual(shown.groups[0]!.rows, [{ technology: 'FTTH', technologyLabel: 'FTTHome', family: 'FTTX', state: 'available', maxMbps: 2500, kind: 'fibra', count: 2 }]);
  });
});
