import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { testApp } from './helpers.ts';

describe('Infrastruttura dal web (richieste all’agente di aggiornamento)', () => {
  it('queues validated requests for the updater and shows its outcome', async () => {
    const { app, cfg, db, login, auth } = await testApp();
    const H = auth(await login());
    const call = (method: 'GET' | 'PUT', payload?: object, headers = H) => app.inject({ method, url: '/api/admin/infra', headers, payload });

    // no agent yet (old compose / updater not running)
    assert.equal((await call('GET')).json().agent, false);
    assert.equal((await call('PUT', { values: { AUTOUPDATE: false } })).json().error, 'infra_agent_missing');

    // the updater publishes the current values
    mkdirSync(cfg.infraDir, { recursive: true });
    writeFileSync(join(cfg.infraDir, 'current.env'), 'APP_LISTEN=:80\nHTTPS_SITES=https://10.0.0.1\nMAP_MODE=local\nMAP_REGION=sicilia\nAGENT=1\n');
    const v = (await call('GET')).json();
    assert.equal(v.agent, true);
    assert.equal(v.values.HTTPS_SITES, 'https://10.0.0.1');
    assert.equal(v.pending, false);

    // validation: unknown keys, bad values, injection attempts never reach the request file
    assert.equal((await call('PUT', { values: { JWT_SECRET: 'x' } })).json().error, 'unknown_setting');
    assert.equal((await call('PUT', { values: { UPDATE_INTERVAL: 10 } })).json().error, 'invalid_value');
    assert.equal((await call('PUT', { values: { HTTPS_SITES: 'https://a.b\nJWT_SECRET=x' } })).json().error, 'invalid_value');
    assert.equal((await call('PUT', { values: { MAP_BBOX: '15,38,11,35' } })).json().error, 'invalid_value');
    assert.equal((await call('PUT', { values: {} })).json().error, 'nothing_to_apply');

    // admins only
    await app.inject({ method: 'POST', url: '/api/admin/users', headers: H, payload: { username: 'tecnico', password: 'Installer-Pass-123' } });
    assert.equal((await call('GET', undefined, auth(await login('tecnico', 'Installer-Pass-123')))).statusCode, 403);

    const r = await call('PUT', { values: { MAP_BBOX: '12.1,37.5,13.2,38.3', MAP_REGION: 'custom', AUTOUPDATE: false, UPDATE_WINDOW: '02-05', HTTPS_SITES: 'https://10.0.0.1  https://cpe.lan' }, action: 'map_update' });
    assert.equal(r.statusCode, 202, r.body);
    assert.equal(r.json().pending, true);
    assert.equal(
      readFileSync(join(cfg.infraDir, 'request.env'), 'utf8'),
      'MAP_REGION=custom\nAUTOUPDATE=0\nUPDATE_WINDOW=02-05\nHTTPS_SITES=https://10.0.0.1 https://cpe.lan\nMAP_BBOX=12.1,37.5,13.2,38.3\nACTION=map_update\n',
    );
    assert.equal((await call('PUT', { values: { AUTOUPDATE: true } })).json().error, 'infra_request_pending');
    assert.match(JSON.stringify(db.prepare("SELECT * FROM events WHERE action = 'server.infra'").all()), /AUTOUPDATE=0/);

    // the agent picks it up and reports
    renameSync(join(cfg.infraDir, 'request.env'), join(cfg.infraDir, 'taken.env'));
    writeFileSync(join(cfg.infraDir, 'status.env'), 'AT=2026-10-09T08:01:00Z\nRESULT=ok\nMESSAGE=applicato: MAP_REGION AUTOUPDATE · mappa aggiornata\n');
    const after = (await call('GET')).json();
    assert.equal(after.pending, false);
    assert.deepEqual(after.status, { at: '2026-10-09T08:01:00Z', result: 'ok', message: 'applicato: MAP_REGION AUTOUPDATE · mappa aggiornata' });
    await app.close();
  });
});
