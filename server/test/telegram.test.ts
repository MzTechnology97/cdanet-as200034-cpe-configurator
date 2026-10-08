import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { fakeUisp } from './fake-uisp.ts';
import { ADMIN, SAMPLE_TEMPLATE, testConfig } from './helpers.ts';

const TOKEN = '123456789:AAHfake-token-for-tests-0123456789abcd';

/** Telegram Bot API double + the UISP fake behind the same fetch. */
function fakes() {
  const uisp = fakeUisp();
  const sent: Array<{ chat_id: string; text: string }> = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host !== 'api.telegram.org') return uisp.fetchImpl(input, init);
    const [, bot, method] = url.pathname.split('/');
    if (bot !== `bot${TOKEN}`) return new Response(JSON.stringify({ ok: false, description: 'Unauthorized' }), { status: 401 });
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (method === 'getMe') return Response.json({ ok: true, result: { username: 'cdanet_noc_bot' } });
    if (method === 'getUpdates') return Response.json({ ok: true, result: [{ message: { chat: { id: -1001234567890, title: 'NOC CDA Net', type: 'supergroup' } } }] });
    if (method === 'sendMessage') {
      sent.push(body);
      return Response.json({ ok: true, result: {} });
    }
    return Response.json({ ok: false, description: 'unknown' }, { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, sent, uisp: uisp.uisp };
}

describe('Telegram notifications', () => {
  it('configures, tests and sends only the enabled, privacy-safe notifications', async () => {
    const f = fakes();
    const { app, ctx } = await buildApp(testConfig({ PUBLIC_URL: 'https://cpe.cda-net.it/' }), 'test', {
      db: openDatabase(':memory:'),
      logger: false,
      uisp: f.uisp,
      fetchImpl: f.fetchImpl,
      telegramIntervalMs: 0,
    });
    const login = (u: string, p: string, ip = '10.0.0.1') => app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: p }, remoteAddress: ip });
    const admin = (await login(ADMIN.username, ADMIN.password)).json().token;
    const H = { authorization: `Bearer ${admin}` };
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, extra: Record<string, string> = {}) =>
      app.inject({ method, url, headers: { ...H, ...extra }, payload });

    // find the chat, test, save
    assert.equal((await call('POST', '/api/admin/connectors/telegram/chats', { token: 'bad' })).statusCode, 400);
    const chats = (await call('POST', '/api/admin/connectors/telegram/chats', { token: TOKEN })).json();
    assert.equal(chats[0].id, '-1001234567890');
    const test = (await call('POST', '/api/admin/connectors/telegram/test', { token: TOKEN, chatId: '-1001234567890' })).json();
    assert.equal(test.bot, 'cdanet_noc_bot');
    const saved = (
      await call('PUT', '/api/admin/connectors/telegram', { enabled: true, token: TOKEN, chatId: '-1001234567890', events: ['provisioning_failed', 'uisp_pending', 'security'], summaryHour: 19 })
    ).json();
    assert.equal(saved.configured, true);
    assert.equal(saved.tokenHint, '123456789:…');
    const view = (await call('GET', '/api/admin/connectors')).json().telegram;
    assert.ok(!JSON.stringify(view).includes('AAHfake'));
    assert.equal(view.publicUrl, 'https://cpe.cda-net.it');
    f.sent.length = 0;

    // provisioning: failed -> message without customer data; success -> to accept in UISP
    await call('POST', '/api/admin/profiles/LiteBeam%205AC/templates', { name: 'Standard', template: SAMPLE_TEMPLATE, boardMatch: 'board\\.name=LiteBeam 5AC' });
    await call('PUT', '/api/admin/wireless-networks/CDA-NET-N2-D01', { wpa2Password: 'test-psk-12345' });
    const mk = async (mac: string) =>
      (
        await call(
          'POST',
          '/api/provisioning/jobs',
          { model: 'LiteBeam 5AC', mac, serial: 'S', ssid: 'CDA-NET-N2-D01', pppoeUser: 'rossi.mario@cda-net.it', pppoePassword: 'Secret-Pppoe' },
          { 'x-cda-client': 'android/1.6.0' },
        )
      ).json().jobId;
    const j1 = await mk('AA:BB:CC:DD:EE:01');
    await call('POST', `/api/provisioning/jobs/${j1}/result`, { result: 'failed', stages: ['Connessione SSH'], detected: {}, error: 'Timeout connessione SSH' });
    const j2 = await mk('AA:BB:CC:DD:EE:02');
    await call('POST', `/api/provisioning/jobs/${j2}/result`, { result: 'success', stages: [], detected: {} });
    await call('POST', `/api/provisioning/jobs/${j2}/result`, { result: 'success', stages: [], detected: {} }); // duplicate: no second message
    await ctx.telegram.idle();
    assert.equal(f.sent.length, 2, JSON.stringify(f.sent));
    assert.match(f.sent[0]!.text, /Provisioning fallito[\s\S]*AA:BB:CC:DD:EE:01[\s\S]*Timeout connessione SSH/);
    assert.match(f.sent[0]!.text, /href="https:\/\/cpe\.cda-net\.it\/#\/jobs\?q=AA%3ABB%3ACC%3ADD%3AEE%3A01"/);
    assert.match(f.sent[1]!.text, /pronta da accettare in UISP/);
    assert.ok(f.sent.every((m) => !/rossi|ROSSI|Secret-Pppoe/.test(m.text)), 'no customer data or secrets');
    f.sent.length = 0;

    // security: lockout and admin login from a new address
    for (let i = 0; i < 11; i++) await login('tecnico-inesistente', 'wrong', '10.9.9.9');
    await login(ADMIN.username, ADMIN.password, '10.0.0.1'); // known address
    await login(ADMIN.username, ADMIN.password, '93.41.1.2'); // new address
    await ctx.telegram.idle();
    assert.equal(f.sent.filter((m) => m.text.includes('Troppi tentativi')).length, 1);
    assert.equal(f.sent.filter((m) => m.text.includes('93.41.1.2')).length, 1);
    assert.equal(f.sent.filter((m) => m.text.includes('10.0.0.1')).length, 0);
    f.sent.length = 0;

    // summary: not enabled in this configuration, then enabled once per day
    const at19 = new Date('2026-10-09T17:05:00Z'); // 19:05 in Rome (CEST)
    assert.equal(ctx.notify.maybeSummary(at19), false);
    await call('PUT', '/api/admin/connectors/telegram', { enabled: true, token: '', chatId: '-1001234567890', events: ['daily_summary'], summaryHour: 19 });
    assert.equal(ctx.notify.maybeSummary(at19), true);
    assert.equal(ctx.notify.maybeSummary(new Date('2026-10-09T17:40:00Z')), false);
    await ctx.telegram.idle();
    assert.match(f.sent[0]!.text, /Riepilogo[\s\S]*Fallite: 1/);
    await app.close();
  });
});
