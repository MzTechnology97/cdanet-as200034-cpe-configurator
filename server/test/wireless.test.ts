import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parseCsv, parseWirelessCsv } from '../src/domain/wireless-csv.ts';
import { testApp } from './helpers.ts';

describe('wireless CSV parsing', () => {
  it('reads ; and , separators, quotes, BOM and CRLF', () => {
    assert.deepEqual(parseCsv('﻿a;b\r\n"x;y";"q""z"\r\n'), [['a', 'b'], ['x;y', 'q"z']]);
    assert.deepEqual(parseCsv('a,b\n1,2'), [['a', 'b'], ['1', '2']]);
  });

  it('derives the SSID from nodo/distretto and validates every row', () => {
    const r = parseWirelessCsv('nodo;distretto;wpa2\n2;01;ChiaveNodo2D01\n12;5;"chiave;con;separatori"\n\n');
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.rows.map((x) => [x.ssid, x.wpa2]), [
      ['CDA-NET-N2-D01', 'ChiaveNodo2D01'],
      ['CDA-NET-N12-D05', 'chiave;con;separatori'],
    ]);
  });

  it('accepts an ssid column and reports precise errors', () => {
    const ok = parseWirelessCsv('SSID,WPA2\ncda-net-n3-d07,abcdefgh');
    assert.equal(ok.rows[0]?.ssid, 'CDA-NET-N3-D07');
    const bad = parseWirelessCsv(
      'nodo;distretto;ssid;wpa2\n1;01;;abcdefgh\n2;00;;abcdefgh\n2;01;;short\n2;02;CDA-NET-N2-D03;abcdefgh\n2;04;;abcdefgh\n2;04;;abcdefgh',
    );
    assert.deepEqual(
      bad.errors.map((e) => e.line),
      [2, 3, 4, 5, 7],
    );
    assert.match(bad.errors[4]?.error ?? '', /riga 6/);
    assert.match(parseWirelessCsv('foo;bar\n1;2').errors[0]?.error ?? '', /Intestazione/);
  });

  it('the example file shipped with the console is valid', () => {
    const r = parseWirelessCsv(readFileSync(new URL('../../web/assets/esempio-reti-wifi.csv', import.meta.url), 'utf8'));
    assert.deepEqual(r.errors, []);
    assert.equal(r.rows.length, 1);
  });
});

describe('wireless bulk API', () => {
  it('previews, imports all-or-nothing, detects unchanged keys and bulk deletes', async () => {
    const t = await testApp();
    const token = await t.login();
    const post = (url: string, payload: unknown) => t.app.inject({ method: 'POST', url, headers: t.auth(token), payload: payload as object });
    const csv = 'nodo;distretto;wpa2\n2;01;Chiave-uno-01\n2;02;Chiave-due-02\n';

    const preview = (await post('/api/admin/wireless-networks/import', { csv })).json();
    assert.equal(preview.ok, true);
    assert.equal(preview.dryRun, true);
    assert.deepEqual(preview.created, ['CDA-NET-N2-D01', 'CDA-NET-N2-D02']);
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/admin/wireless-networks', headers: t.auth(token) })).json().length, 0);

    const done = (await post('/api/admin/wireless-networks/import', { csv, dryRun: false })).json();
    assert.equal(done.dryRun, false);
    const again = (await post('/api/admin/wireless-networks/import', { csv: 'nodo;distretto;wpa2\n2;01;Chiave-uno-01\n2;02;Nuova-chiave-02\n', dryRun: false })).json();
    assert.deepEqual(again.unchanged, ['CDA-NET-N2-D01']);
    assert.deepEqual(again.updated, ['CDA-NET-N2-D02']);

    // one bad row -> nothing written
    const bad = (await post('/api/admin/wireless-networks/import', { csv: 'nodo;distretto;wpa2\n3;01;valida-123\n3;02;corta\n', dryRun: false })).json();
    assert.equal(bad.ok, false);
    assert.equal(bad.errorCount, 1);
    const list = (await t.app.inject({ method: 'GET', url: '/api/admin/wireless-networks', headers: t.auth(token) })).json();
    assert.deepEqual(list.map((x: { ssid: string }) => x.ssid), ['CDA-NET-N2-D01', 'CDA-NET-N2-D02']);
    assert.ok(!JSON.stringify(again).includes('Nuova-chiave'));

    const del = (await post('/api/admin/wireless-networks/bulk-delete', { ssids: ['CDA-NET-N2-D01', 'CDA-NET-N2-D02', 'CDA-NET-N9-D09'] })).json();
    assert.equal(del.deleted, 2);
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/admin/wireless-networks', headers: t.auth(token) })).json().length, 0);
    await t.app.close();
  });
});
