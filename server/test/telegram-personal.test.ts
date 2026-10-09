import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { ADMIN, testConfig } from './helpers.ts';

const TOKEN = '123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQr';

describe('Telegram personale per tutti gli account', () => {
  it('works with the bot token alone, for every user, and the admin can switch it off', async () => {
    const direct: Array<{ chat: string; text: string }> = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = JSON.parse(String(init?.body ?? '{}')) as { chat_id?: string; text?: string };
      if (url.pathname.endsWith('/getMe')) return Response.json({ ok: true, result: { username: 'cdanet_bot' } });
      if (url.pathname.endsWith('/sendMessage')) {
        direct.push({ chat: String(body.chat_id), text: String(body.text) });
        return Response.json({ ok: true, result: {} });
      }
      return Response.json({ ok: false, description: 'unexpected' }, { status: 404 });
    }) as typeof fetch;
    const { app } = await buildApp(testConfig(), 'test', { db: openDatabase(':memory:'), logger: false, uisp: null, fetchImpl, telegramIntervalMs: 0 });
    const login = async (u: string, p: string) => ({ authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: p } })).json().token}` });
    const A = await login(ADMIN.username, ADMIN.password);
    const call = (method: 'GET' | 'PUT' | 'POST', url: string, payload?: object, headers = A) => app.inject({ method, url, headers, payload });

    await call('POST', '/api/admin/users', { username: 'tecnico', password: 'Installer-Pass-123' });
    const T = await login('tecnico', 'Installer-Pass-123');

    // no bot yet: the admin is told to configure it, the installer to ask
    const none = (await call('GET', '/api/account/telegram', undefined, T)).json();
    assert.deepEqual([none.available, none.reason, none.canConfigure], [false, 'no_bot', false]);
    assert.equal((await call('GET', '/api/account/telegram')).json().canConfigure, true);

    // bot token only, no NOC group: personal notifications available to everyone
    const saved = await call('PUT', '/api/admin/connectors/telegram', { enabled: false, token: TOKEN, chatId: '', events: [], summaryHour: 19 });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().personal, true);
    // even without the Guasti Enel module (Telegram is part of the account)
    await call('PUT', '/api/admin/modules', { power_outages: false });
    const st = (await call('GET', '/api/account/telegram', undefined, T)).json();
    assert.deepEqual([st.available, st.reason, st.outages], [true, null, false]);
    const linked = (await call('PUT', '/api/account/telegram', { chatId: '424242' }, T)).json();
    assert.equal(linked.linked, true);
    assert.ok(direct.some((m) => m.chat === '424242' && m.text.includes('Telegram collegato')));
    assert.equal((await call('GET', '/api/admin/connectors')).json().telegram.personalLinked, 1);

    // switched off by the admin
    await call('PUT', '/api/admin/connectors/telegram', { enabled: false, token: '', chatId: '', events: [], summaryHour: 19, personal: false });
    const off = (await call('GET', '/api/account/telegram', undefined, T)).json();
    assert.deepEqual([off.available, off.reason], [false, 'personal_off']);
    assert.equal((await call('PUT', '/api/account/telegram', { chatId: '424242' }, T)).statusCode, 503);

    // the NOC group still needs its chat id
    assert.equal((await call('PUT', '/api/admin/connectors/telegram', { enabled: true, token: '', chatId: '', events: [], summaryHour: 19 })).json().error, 'connector_incomplete');
    await app.close();
  });
});
