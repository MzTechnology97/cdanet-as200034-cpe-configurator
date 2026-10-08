import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { csvCell, toCsv } from '../src/domain/csv.ts';
import { SAMPLE_TEMPLATE, testApp } from './helpers.ts';

describe('CSV export of the provisioning history', () => {
  it('escapes cells and blocks spreadsheet formulas', () => {
    assert.equal(csvCell('a;b'), '"a;b"');
    assert.equal(csvCell('di "Mario"'), '"di ""Mario"""');
    assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
    assert.equal(csvCell('+39 333'), "'+39 333");
    assert.equal(csvCell(-58), '-58');
    assert.equal(csvCell(null), '');
    assert.equal(toCsv([['a', 1], ['b', 2]]), 'a;1\r\nb;2\r\n');
  });

  it('exports the filtered history; installers only their own jobs', async () => {
    const t = await testApp();
    const admin = await t.login();
    await t.app.inject({ method: 'POST', url: '/api/admin/users', headers: t.auth(admin), payload: { username: 'tecnico', password: 'Installer-Pass-123' } });
    await t.app.inject({ method: 'POST', url: '/api/admin/profiles/LiteBeam%205AC/templates', headers: t.auth(admin), payload: { name: 'Standard', template: SAMPLE_TEMPLATE, boardMatch: 'board\\.name=LiteBeam 5AC' } });
    await t.app.inject({ method: 'PUT', url: '/api/admin/wireless-networks/CDA-NET-N2-D01', headers: t.auth(admin), payload: { wpa2Password: 'test-psk-12345' } });
    const tec = await t.login('tecnico', 'Installer-Pass-123');
    const mk = async (tok: string, mac: string, user: string) =>
      (
        await t.app.inject({
          method: 'POST', url: '/api/provisioning/jobs', headers: t.auth(tok, { 'x-cda-client': 'android/1.7.0' }),
          payload: { model: 'LiteBeam 5AC', mac, serial: 'S1', ssid: 'CDA-NET-N2-D01', pppoeUser: user, pppoePassword: 'Secret-Pppoe' },
        })
      ).json().jobId;
    const j1 = await mk(tec, 'AA:BB:CC:00:00:01', 'rossi.mario@cda-net.it');
    await t.app.inject({ method: 'POST', url: `/api/provisioning/jobs/${j1}/result`, headers: t.auth(tec), payload: { result: 'success', stages: [], detected: {} } });
    await mk(admin, 'AA:BB:CC:00:00:02', 'verdi.luca@cda-net.it');

    const r = await t.app.inject({ method: 'GET', url: '/api/provisioning/jobs.csv', headers: t.auth(admin) });
    assert.equal(r.statusCode, 200);
    assert.match(String(r.headers['content-type']), /text\/csv/);
    assert.match(String(r.headers['content-disposition']), /storico-provisioning-\d{4}-\d{2}-\d{2}\.csv/);
    assert.ok(r.body.startsWith('﻿Data;Esito;Cliente'));
    const lines = r.body.trim().split('\r\n');
    assert.equal(lines.length, 3);
    assert.ok(!r.body.includes('Secret-Pppoe'));

    const ok = await t.app.inject({ method: 'GET', url: '/api/provisioning/jobs.csv?status=success', headers: t.auth(admin) });
    assert.equal(ok.body.trim().split('\r\n').length, 2);
    assert.match(ok.body, /completato;ROSSI MARIO;rossi\.mario@cda-net\.it;LiteBeam 5AC;Standard;AA:BB:CC:00:00:01;S1;CDA-NET-N2-D01;tecnico/);

    const mine = await t.app.inject({ method: 'GET', url: '/api/provisioning/jobs.csv', headers: t.auth(tec) });
    assert.equal(mine.body.trim().split('\r\n').length, 2, 'installer sees only own jobs');

    const future = await t.app.inject({ method: 'GET', url: '/api/provisioning/jobs.csv?from=2099-01-01', headers: t.auth(admin) });
    assert.equal(future.body.trim().split('\r\n').length, 1);
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/provisioning/jobs.csv?from=ieri', headers: t.auth(admin) })).statusCode, 400);
    const today = new Date().toISOString().slice(0, 10);
    const todayOnly = await t.app.inject({ method: 'GET', url: `/api/provisioning/jobs.csv?from=${today}&to=${today}`, headers: t.auth(admin) });
    assert.equal(todayOnly.body.trim().split('\r\n').length, 3);
    await t.app.close();
  });
});
