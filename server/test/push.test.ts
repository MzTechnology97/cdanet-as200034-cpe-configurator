import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { createSealer } from '../src/crypto.ts';
import { openDatabase } from '../src/db.ts';
import { createPush } from '../src/services/push.ts';
import { testApp } from './helpers.ts';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const SERVICE_ACCOUNT = JSON.stringify({ type: 'service_account', project_id: 'cda-demo', client_email: 'push@cda-demo.iam.gserviceaccount.com', private_key: privateKey });
const GOOGLE_SERVICES = JSON.stringify({
  project_info: { project_id: 'cda-demo', project_number: '123456789' },
  client: [
    { client_info: { mobilesdk_app_id: '1:123456789:android:aaa', android_client_info: { package_name: 'it.cdanet.cpeconfigurator' } }, api_key: [{ current_key: 'demo-api-key' }] },
    { client_info: { mobilesdk_app_id: '1:123456789:android:bbb', android_client_info: { package_name: 'it.cdanet.cpeconfigurator.debug' } }, api_key: [{ current_key: 'demo-api-key' }] },
  ],
});

describe('Notifiche push (Firebase)', () => {
  it('keeps the private key sealed and gives each app its own options', () => {
    const db = openDatabase(':memory:');
    const push = createPush(db, createSealer(randomBytes(32)));
    assert.equal(push.client('it.cdanet.cpeconfigurator'), null, 'not configured: the app stays connected itself');
    const v = push.save({ enabled: true, serviceAccount: SERVICE_ACCOUNT, googleServices: GOOGLE_SERVICES }, 1);
    assert.deepEqual(v.apps, ['it.cdanet.cpeconfigurator', 'it.cdanet.cpeconfigurator.debug']);
    assert.equal(JSON.stringify(v).includes('PRIVATE KEY'), false);
    const stored = (db.prepare("SELECT value FROM settings WHERE key = 'connector.firebase'").get() as { value: string }).value;
    assert.equal(stored.includes('PRIVATE KEY'), false, 'sealed in the database');
    assert.deepEqual(push.client('it.cdanet.cpeconfigurator.debug'), { projectId: 'cda-demo', senderId: '123456789', appId: '1:123456789:android:bbb', apiKey: 'demo-api-key' });
    assert.equal(push.client('com.other.app'), null);
    assert.throws(() => push.save({ enabled: true, serviceAccount: '{"type":"user"}' }, 1), /firebase_service_account_invalid/);
  });

  it('sends to every phone of the user and forgets the tokens FCM no longer knows', async () => {
    const db = openDatabase(':memory:');
    db.prepare("INSERT INTO users(id, username, password_hash, role, created_at) VALUES(7, 'tecnico', 'x', 'installer', '2026-01-01')").run();
    const calls: string[] = [];
    const fake = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push(u);
      if (u.startsWith('https://oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'ya29.demo', expires_in: 3600 }), { status: 200 });
      const body = JSON.parse(String(init?.body)) as { message: { token: string; notification: { title: string } } };
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer ya29.demo');
      assert.equal(body.message.notification.title, 'Intervento assegnato');
      return body.message.token.startsWith('gone') ? new Response('{"error":{"status":"NOT_FOUND"}}', { status: 404 }) : new Response('{}', { status: 200 });
    }) as typeof fetch;
    const push = createPush(db, createSealer(randomBytes(32)), { fetchImpl: fake });
    push.save({ enabled: true, serviceAccount: SERVICE_ACCOUNT, googleServices: GOOGLE_SERVICES }, 1);
    push.register(7, 'live-token-0123456789abcdef');
    push.register(7, 'gone-token-0123456789abcdef');
    assert.equal(await push.send([7], { title: 'Intervento assegnato', body: 'Rossi · 9:00', kind: 'work_order_assigned' }), 1);
    assert.equal(calls.filter((c) => c.includes('oauth2')).length, 1);
    assert.deepEqual((db.prepare('SELECT token FROM push_tokens').all() as Array<{ token: string }>).map((r) => r.token), ['live-token-0123456789abcdef']);
    // the access token is reused within the hour
    await push.send([7], { title: 'Intervento assegnato', body: '', kind: 'work_order_assigned' });
    assert.equal(calls.filter((c) => c.includes('oauth2')).length, 1);
  });

  it('the phone registers with its background token and the stream accepts it', async () => {
    const t = await testApp();
    const admin = await t.login();
    const cfg = await t.app.inject({ method: 'GET', url: '/api/mobile/push-config?package=it.cdanet.cpeconfigurator', headers: t.auth(admin) });
    assert.deepEqual(cfg.json(), { firebase: null });
    const feed = (await t.app.inject({ method: 'POST', url: '/api/notifications/device-token', headers: t.auth(admin) })).json().token as string;
    const reg = await t.app.inject({ method: 'POST', url: '/api/notifications/push-token', headers: t.auth(feed), payload: { token: 'fcm-token-0123456789abcdef' } });
    assert.equal(reg.statusCode, 200);
    assert.equal((t.db.prepare('SELECT count(*) n FROM push_tokens').get() as { n: number }).n, 1);
    assert.equal((await t.app.inject({ method: 'POST', url: '/api/notifications/push-token', payload: { token: 'fcm-token-0123456789abcdef' } })).statusCode, 401);
    const base = await t.app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const r = await fetch(`${base}/api/events`, { headers: { authorization: `Bearer ${feed}` } });
      assert.equal(r.status, 200, 'the background service of the app opens the same stream');
      await r.body?.cancel();
    } finally {
      await t.app.close();
    }
  });
});
