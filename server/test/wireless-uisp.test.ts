import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { parseWirelessCsv } from '../src/domain/wireless-csv.ts';
import { fakeUisp } from './fake-uisp.ts';
import { ADMIN, testConfig } from './helpers.ts';

describe('Reti Wi-Fi da UISP con la chiave WPA2 comune', () => {
  it('lists only the UISP SSIDs not yet imported and applies the shared key to all, the chosen ones or every network', async () => {
    const db = openDatabase(':memory:');
    const { app, ctx } = await buildApp(testConfig(), 'test', { db, logger: false, uisp: fakeUisp().uisp });
    const login = async (u: string, p: string) => ({ authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: p } })).json().token}` });
    const H = await login(ADMIN.username, ADMIN.password);
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, headers = H) => app.inject({ method, url, headers, payload });
    const keyOf = (ssid: string) => ctx.sealer.open((db.prepare('SELECT wpa2_ciphertext c FROM wireless_secrets WHERE ssid = ?').get(ssid) as { c: string }).c);
    const pendingOf = async () => (await call('GET', '/api/admin/wireless-networks/uisp')).json();

    // the list comes from UISP: customer APs only (the PtP link is left out)
    const list = await pendingOf();
    assert.deepEqual(list.pending.map((s: { ssid: string }) => s.ssid), ['CDA-NET-N2-D01', 'CDA-NET-N7-D03', 'CDA-NET-N99-D01']);
    assert.deepEqual(list.pending[0].aps, ['AP N2 D01']);
    assert.equal(list.imported, 0);

    // an imported network leaves the list
    await call('PUT', '/api/admin/wireless-networks/CDA-NET-N2-D01', { wpa2Password: 'vecchia-chiave-1' });
    const after = await pendingOf();
    assert.deepEqual([after.pending.length, after.imported], [2, 1]);

    // preview: nothing written, the imported one is not even opened
    const dry = (await call('POST', '/api/admin/wireless-networks/uisp-import', { wpa2Password: 'Chiave-Comune-2026' })).json();
    assert.deepEqual([dry.dryRun, dry.pending, dry.created, dry.kept], [true, 2, ['CDA-NET-N7-D03', 'CDA-NET-N99-D01'], ['CDA-NET-N2-D01']]);
    assert.equal((db.prepare('SELECT count(*) n FROM wireless_secrets').get() as { n: number }).n, 1);

    // only the chosen ones
    const chosen = (await call('POST', '/api/admin/wireless-networks/uisp-import', { wpa2Password: 'Chiave-Comune-2026', ssids: ['CDA-NET-N7-D03'], dryRun: false })).json();
    assert.deepEqual(chosen.created, ['CDA-NET-N7-D03']);
    assert.equal(keyOf('CDA-NET-N7-D03'), 'Chiave-Comune-2026');
    assert.equal(keyOf('CDA-NET-N2-D01'), 'vecchia-chiave-1');
    assert.deepEqual((await pendingOf()).pending.map((s: { ssid: string }) => s.ssid), ['CDA-NET-N99-D01']);

    // all: the rest is created, the different key replaced, the same key left as is
    const all = (await call('POST', '/api/admin/wireless-networks/uisp-import', { wpa2Password: 'Chiave-Comune-2026', scope: 'all', dryRun: false })).json();
    assert.deepEqual([all.created, all.updated, all.unchanged], [['CDA-NET-N99-D01'], ['CDA-NET-N2-D01'], ['CDA-NET-N7-D03']]);
    assert.equal(keyOf('CDA-NET-N2-D01'), 'Chiave-Comune-2026');
    assert.equal((await pendingOf()).pending.length, 0);

    // key validation, admins only, the key never in the activity log
    assert.equal((await call('POST', '/api/admin/wireless-networks/uisp-import', { wpa2Password: 'corta' })).statusCode, 400);
    await call('POST', '/api/admin/users', { username: 'tecnico', password: 'Installer-Pass-123' });
    const T = await login('tecnico', 'Installer-Pass-123');
    assert.equal((await call('GET', '/api/admin/wireless-networks/uisp', undefined, T)).statusCode, 403);
    const log = JSON.stringify(db.prepare("SELECT * FROM events WHERE action = 'wireless.uisp_import'").all());
    assert.ok(log.includes('1 nuove') && !log.includes('Chiave-Comune-2026'));

    // export in clear: the admin's password again, admins only, read back as is by the import
    await call('PUT', '/api/admin/wireless-networks/CDA-NET-N5-D01-R1', { wpa2Password: '=formula;"virgolette"' });
    assert.equal((await call('POST', '/api/admin/wireless-networks/export', { password: 'sbagliata' })).json().error, 'wrong_current_password');
    assert.equal((await call('POST', '/api/admin/wireless-networks/export', { password: 'Installer-Pass-123' }, T)).statusCode, 403);
    const exp = await call('POST', '/api/admin/wireless-networks/export', { password: ADMIN.password });
    assert.equal(exp.statusCode, 200);
    assert.match(String(exp.headers['content-disposition']), /attachment; filename="reti-wifi-/);
    assert.equal(exp.headers['cache-control'], 'no-store');
    const back = parseWirelessCsv(exp.body);
    assert.deepEqual(back.errors, []);
    assert.deepEqual(
      back.rows.map((r) => [r.ssid, r.wpa2]),
      [
        ['CDA-NET-N2-D01', 'Chiave-Comune-2026'],
        ['CDA-NET-N5-D01-R1', '=formula;"virgolette"'],
        ['CDA-NET-N7-D03', 'Chiave-Comune-2026'],
        ['CDA-NET-N99-D01', 'Chiave-Comune-2026'],
      ],
    );
    assert.ok(exp.body.includes(`"'=formula;""virgolette"""`), 'no formula for a spreadsheet');
    const some = await call('POST', '/api/admin/wireless-networks/export', { password: ADMIN.password, ssids: ['CDA-NET-N7-D03'] });
    assert.deepEqual(parseWirelessCsv(some.body).rows.map((r) => r.ssid), ['CDA-NET-N7-D03']);
    const exported = JSON.stringify(db.prepare("SELECT * FROM events WHERE action = 'wireless.export'").all());
    assert.ok(exported.includes('4 reti') && !exported.includes('Chiave-Comune-2026'));
    await app.close();

    // without UISP
    const plain = await buildApp(testConfig(), 'test', { db: openDatabase(':memory:'), logger: false, uisp: null });
    const H2 = { authorization: `Bearer ${(await plain.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: ADMIN.username, password: ADMIN.password } })).json().token}` };
    assert.equal((await plain.app.inject({ method: 'GET', url: '/api/admin/wireless-networks/uisp', headers: H2 })).json().error, 'uisp_not_configured');
    await plain.app.close();
  });

  it('reads back keys that start with an apostrophe or a formula character', () => {
    const csv = "ssid;wpa2\r\nCDA-NET-N2-D01;''apostrofo-iniziale\r\nCDA-NET-N2-D02;'+piu-davanti\r\nCDA-NET-N2-D03;normale'con-apice\r\n";
    assert.deepEqual(
      parseWirelessCsv(csv).rows.map((r) => r.wpa2),
      ["'apostrofo-iniziale", '+piu-davanti', "normale'con-apice"],
    );
  });
});
