import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createGeocoder, isPublicNominatim } from '../src/services/geocode.ts';

const HIT = [{ display_name: 'Via Roma 1, 94100 Enna EN', lat: '37.58', lon: '14.12', type: 'house' }];

/** Local Nominatim (nominatim:8080) in a given state + public fallback. */
function fakeNominatim(local: 'ok' | 'importing' | 'down' | 'bad-request') {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = new URL(String(input));
    calls.push(`${url.host}${url.pathname}`);
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (url.host === 'nominatim:8080') {
      if (local === 'down') throw new TypeError('fetch failed');
      if (local === 'importing') return json({ status: 700, message: 'Database connection failed' }, 500);
      if (local === 'bad-request') return json({ error: 'bad' }, 400);
      if (url.pathname === '/status') return json({ status: 0, message: 'OK', data_updated: '2026-10-07T20:21:02+00:00', software_version: '5.3.2' });
      return json(HIT);
    }
    if (url.pathname === '/status') return json({ status: 0, message: 'OK' });
    return json(HIT);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const opts = (fetchImpl: typeof fetch) => ({ url: 'http://nominatim:8080', fallbackUrl: 'https://nominatim.openstreetmap.org', fetchImpl });

describe('Geocoder: local Nominatim with public fallback', () => {
  it('uses the local container when it is ready', async () => {
    const f = fakeNominatim('ok');
    const r = await createGeocoder(opts(f.fetchImpl)).search('Via Roma 1 Enna');
    assert.equal(r[0]?.lat, 37.58);
    assert.deepEqual(f.calls, ['nominatim:8080/search']);
  });

  for (const state of ['importing', 'down'] as const) {
    it(`falls back to the public service when the local one is ${state}`, async () => {
      const f = fakeNominatim(state);
      const r = await createGeocoder(opts(f.fetchImpl)).search('Via Roma 1 Enna');
      assert.equal(r.length, 1);
      assert.deepEqual(f.calls, ['nominatim:8080/search', 'nominatim.openstreetmap.org/search']);
    });
  }

  it('does not fall back on client errors, nor without a fallback', async () => {
    const f = fakeNominatim('bad-request');
    await assert.rejects(createGeocoder(opts(f.fetchImpl)).search('Via Roma 1 Enna'), { code: 'geocoder_error' });
    const g = fakeNominatim('down');
    await assert.rejects(createGeocoder({ url: 'http://nominatim:8080', fetchImpl: g.fetchImpl }).search('Via Roma'), { code: 'geocoder_unreachable' });
  });

  it('reports the status of both services', async () => {
    const ok = await createGeocoder(opts(fakeNominatim('ok').fetchImpl)).status();
    assert.equal(ok.primary.ok, true);
    assert.equal(ok.primary.local, true);
    assert.equal(ok.primary.version, '5.3.2');
    assert.equal(ok.fallback?.local, false);
    const importing = await createGeocoder(opts(fakeNominatim('importing').fetchImpl)).status();
    assert.equal(importing.primary.ok, false);
    assert.equal(importing.primary.message, 'Database connection failed');
    assert.equal(isPublicNominatim('https://nominatim.openstreetmap.org'), true);
    assert.equal(isPublicNominatim('http://nominatim:8080'), false);
  });
});
