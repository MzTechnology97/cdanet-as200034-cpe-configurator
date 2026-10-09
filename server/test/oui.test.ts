import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { RANDOM_MAC, createOui, parseOuiCsv } from '../src/services/oui.ts';
import { ADMIN, testConfig } from './helpers.ts';

const MAL = 'Registry,Assignment,Organization Name,Organization Address\nMA-L,245A4C,"Ubiquiti Inc",Address\nMA-L,4C5E0C,Routerboard.com,Riga\nMA-L,001122,"CIMSYS, ""Inc""",Addr\n';
const MAM = 'Registry,Assignment,Organization Name,Organization Address\nMA-M,245A4C1,Small Vendor Srl,Somewhere\n';
const MAS = 'Registry,Assignment,Organization Name,Organization Address\n';

function fakeIeee() {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const body = url.endsWith('/oui.csv') ? MAL : url.endsWith('/mam.csv') ? MAM : url.endsWith('/oui36.csv') ? MAS : null;
    return body ? new Response(body) : new Response('not found', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('MAC vendors (IEEE OUI)', () => {
  it('parses the IEEE CSV (quoted names) and prefers the longest prefix', async () => {
    const m = parseOuiCsv(MAL);
    assert.equal(m.get('001122'), 'CIMSYS, "Inc"');
    const ieee = fakeIeee();
    const dir = mkdtempSync(join(tmpdir(), 'oui-'));
    const oui = createOui(dir, { fetchImpl: ieee.fetchImpl });
    const r = await oui.lookup(['24:5A:4C:00:11:22', '24:5A:4C:12:34:56', '4c5e0c112233', 'DA:A1:19:00:00:01', '00-00-00-00-00-01', 'bad']);
    assert.equal(r['24:5A:4C:00:11:22'], 'Ubiquiti Inc');
    assert.equal(r['24:5A:4C:12:34:56'], 'Small Vendor Srl', 'MA-M wins over MA-L');
    assert.equal(r['4c5e0c112233'], 'Routerboard.com');
    assert.equal(r['DA:A1:19:00:00:01'], RANDOM_MAC);
    assert.equal(r['00-00-00-00-00-01'], null);
    assert.equal(r.bad, null);
    // cached on disk: a second instance does not download again
    const again = fakeIeee();
    await createOui(dir, { fetchImpl: again.fetchImpl }).lookup(['24:5A:4C:00:11:22']);
    assert.equal(again.calls.length, 0);
  });

  it('keeps working with a stale copy when IEEE is unreachable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oui-'));
    writeFileSync(join(dir, 'oui.csv'), MAL);
    const old = new Date(Date.now() - 90 * 86400_000);
    (await import('node:fs')).utimesSync(join(dir, 'oui.csv'), old, old);
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const r = await createOui(dir, { fetchImpl: down }).lookup(['4C:5E:0C:11:22:33']);
    assert.equal(r['4C:5E:0C:11:22:33'], 'Routerboard.com');
  });

  it('batch endpoint for the IP scanner', async () => {
    const ieee = fakeIeee();
    const { app } = await buildApp(testConfig(), 'test', { db: openDatabase(':memory:'), logger: false, fetchImpl: ieee.fetchImpl });
    const tok = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: ADMIN.username, password: ADMIN.password } })).json().token;
    const r = await app.inject({ method: 'POST', url: '/api/tools/mac-vendors', headers: { authorization: `Bearer ${tok}` }, payload: { macs: ['24:5A:4C:00:11:22', '4C:5E:0C:11:22:33'] } });
    assert.deepEqual(r.json(), { '24:5A:4C:00:11:22': 'Ubiquiti Inc', '4C:5E:0C:11:22:33': 'Routerboard.com' });
    const one = await app.inject({ method: 'POST', url: '/api/tools/mac-vendor', headers: { authorization: `Bearer ${tok}` }, payload: { mac: '24:5A:4C:00:11:22' } });
    assert.equal(one.json().vendor, 'Ubiquiti Inc');
    await app.close();
  });
});
