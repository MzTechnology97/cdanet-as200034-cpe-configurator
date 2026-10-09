import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildApp } from '../src/app.ts';
import { openDatabase } from '../src/db.ts';
import { ADMIN, SAMPLE_TEMPLATE, testConfig } from './helpers.ts';

const TOKEN = '123456789:AAbbCCddEEffGGhhIIjjKKllMMnnOOppQQr';
const ANDROID = { 'x-cda-client': 'android/1.33.0' };
const acceptance = (signal: number, verdict: 'ok' | 'warn' | 'bad', checks: Array<{ title: string; verdict: string; detail: string }> = []) => ({
  verdict,
  measuredAt: new Date().toISOString(),
  samples: 5,
  cpe: { essid: 'CDA-NET-N2-D01' },
  radio: { signal, chains: [] },
  internet: { tested: false },
  checks,
  notes: '',
});

async function setup() {
  const sent: Array<{ chat: string; text: string }> = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body ?? '{}')) as { chat_id?: string; text?: string };
    if (url.pathname.endsWith('/getMe')) return Response.json({ ok: true, result: { username: 'cdanet_bot' } });
    if (url.pathname.endsWith('/sendMessage')) {
      sent.push({ chat: String(body.chat_id), text: String(body.text) });
      return Response.json({ ok: true, result: {} });
    }
    return Response.json({ ok: false }, { status: 404 });
  }) as typeof fetch;
  const db = openDatabase(':memory:');
  const { app, ctx } = await buildApp(testConfig(), 'test', { db, logger: false, uisp: null, fetchImpl, telegramIntervalMs: 0 });
  const login = async (u: string, p: string) => ({ authorization: `Bearer ${(await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: u, password: p } })).json().token}` });
  const A = await login(ADMIN.username, ADMIN.password);
  const call = (method: 'GET' | 'PUT' | 'POST', url: string, payload?: object, headers: Record<string, string> = A) => app.inject({ method, url, headers, payload });
  await call('POST', '/api/admin/users', { username: 'tecnico', password: 'Installer-Pass-123' });
  await call('POST', '/api/admin/users', { username: 'altro', password: 'Installer-Pass-456' });
  await call('POST', '/api/admin/profiles/LiteBeam%205AC/templates', { name: 'Standard', template: SAMPLE_TEMPLATE, boardMatch: 'board\\.name=LiteBeam 5AC' });
  await call('PUT', '/api/admin/wireless-networks/CDA-NET-N2-D01', { wpa2Password: 'test-psk-12345' });
  const T = await login('tecnico', 'Installer-Pass-123');
  const O = await login('altro', 'Installer-Pass-456');
  const newJob = async (mac: string) =>
    (
      await call(
        'POST',
        '/api/provisioning/jobs',
        { model: 'LiteBeam 5AC', mac, serial: 'S1', ssid: 'CDA-NET-N2-D01', pppoeUser: `cliente.${mac.slice(-2)}@cda-net.it`, pppoePassword: 'x' },
        { ...T, ...ANDROID },
      )
    ).json().jobId as string;
  return { app, db, ctx, sent, call, A, T, O, newJob };
}

describe('Installazioni KO, rimandate, ritentativi e approvazione NOC', () => {
  it('lets a failed write be retried with the same package and records the attempts', async () => {
    const { app, call, T, newJob } = await setup();
    const id = await newJob('AA:BB:CC:00:00:01');
    const result = (r: 'success' | 'failed', completedAt: string) => call('POST', `/api/provisioning/jobs/${id}/result`, { result: r, stages: ['Connessione SSH'], completedAt, error: r === 'failed' ? 'SSH rifiutato' : undefined }, T);

    assert.equal((await result('failed', '2026-10-09T10:00:00.000Z')).json().duplicate, false);
    // the offline queue sends the same attempt again: ignored
    assert.equal((await result('failed', '2026-10-09T10:00:00.000Z')).json().duplicate, true);
    assert.equal((await result('failed', '2026-10-09T10:05:00.000Z')).json().retry, true);
    const ok = (await result('success', '2026-10-09T10:10:00.000Z')).json();
    assert.deepEqual([ok.duplicate, ok.retry], [false, true]);
    const job = (await call('GET', '/api/provisioning/jobs', undefined, T)).json()[0];
    assert.deepEqual([job.status, job.attempts], ['success', 3]);
    // a success stays: a later failure of the same package is refused
    assert.equal((await result('failed', '2026-10-09T10:20:00.000Z')).json().error, 'job_already_completed');
    // and the acceptance test is accepted after the retry
    assert.equal((await call('PUT', `/api/provisioning/jobs/${id}/acceptance`, acceptance(-60, 'ok'), T)).statusCode, 200);
    await app.close();
  });

  it('records postponed and definitive KO with their reason, never blocking a new attempt', async () => {
    const { app, db, sent, call, A, T, O, newJob } = await setup();
    await call('PUT', '/api/admin/connectors/telegram', { enabled: true, token: TOKEN, chatId: '-1001234567890', events: ['provisioning_failed'], summaryHour: 19 });
    const id = await newJob('AA:BB:CC:00:00:02');
    const ko = (body: object, headers = T) => call('POST', '/api/installs/ko', { mode: 'new', step: 'link', reason: 'no_signal', ...body }, headers);

    // the reason is always required
    assert.equal((await ko({ kind: 'definitive', jobId: id, note: '' })).statusCode, 400);
    assert.equal((await ko({ kind: 'postponed', jobId: id })).statusCode, 400);
    // not on the installation of another installer
    assert.equal((await ko({ kind: 'postponed', jobId: id, note: 'Pioggia forte, si riprova' }, O)).statusCode, 403);

    const p = await ko({ kind: 'postponed', jobId: id, reason: 'weather', step: 'aim', note: 'Pioggia forte, si riprova', retryOn: '2026-10-12', measures: { signal: -79 } });
    assert.equal(p.statusCode, 201);
    // the job is still usable: the write can go on, then a definitive KO on the same CPE
    await call('POST', `/api/provisioning/jobs/${id}/result`, { result: 'success', stages: ['ok'] }, T);
    await ko({ kind: 'definitive', jobId: id, note: 'Alberi davanti, nessun AP visibile' });
    // repointing of a CPE unknown to the app: only MAC and SSID
    await ko({ kind: 'definitive', mode: 'repoint', mac: 'aa-bb-cc-00-00-02', ssid: 'CDA-NET-N2-D01', note: 'CPE non si aggancia più', step: 'verify', reason: 'no_link' });

    const mine = (await call('GET', '/api/installs/ko', undefined, T)).json();
    assert.equal(mine.length, 3);
    assert.deepEqual([mine[2].kind, mine[2].reason, mine[2].retryOn, mine[2].signal, mine[2].attempts], ['postponed', 'weather', '2026-10-12', -79, 3]);
    assert.equal((await call('GET', '/api/installs/ko', undefined, O)).json().length, 0);
    const job = (await call('GET', '/api/provisioning/jobs?status=ko')).json();
    assert.deepEqual([job.length, job[0].ko.kind, job[0].koCount], [1, 'definitive', 2]);

    // the NOC is told: Telegram group and the notifications page of every admin
    assert.ok(sent.some((m) => m.chat === '-1001234567890' && m.text.includes('Installazione rimandata') && m.text.includes('12/10/2026') && m.text.includes('Pioggia forte')));
    assert.ok(sent.some((m) => m.text.includes('Installazione KO') && m.text.includes('tentativo 2')));
    const inbox = (await call('GET', '/api/notifications')).json();
    assert.equal(inbox.unread, 3);
    assert.ok(inbox.items.every((n: { kind: string }) => n.kind === 'install_ko'));
    assert.equal((await call('GET', '/api/notifications/count', undefined, T)).json().unread, 0);

    // a passed acceptance test closes the open reports of that CPE (also the one without job)
    const done = (await call('PUT', `/api/provisioning/jobs/${id}/acceptance`, acceptance(-60, 'ok'), T)).json();
    assert.deepEqual([done.review, done.resolvedKo], [null, 3]);
    assert.equal((await call('GET', '/api/installs/ko?open=1')).json().length, 0);

    // closed by hand by the NOC (admins only, with a note)
    await ko({ kind: 'postponed', jobId: id, note: 'Cliente assente', reason: 'no_access', step: 'final' });
    const open = (await call('GET', '/api/installs/ko?open=1')).json()[0];
    assert.equal((await call('POST', `/api/admin/installs/ko/${open.id}/resolve`, { note: 'ok' }, T)).statusCode, 403);
    assert.equal((await call('POST', `/api/admin/installs/ko/${open.id}/resolve`, { note: 'Fatto il 14/10' })).statusCode, 200);
    assert.equal((await call('POST', `/api/admin/installs/ko/${open.id}/resolve`, { note: 'di nuovo' })).statusCode, 404);
    const events = (db.prepare("SELECT action FROM events WHERE action LIKE 'install.%'").all() as Array<{ action: string }>).map((e) => e.action);
    assert.deepEqual(events.sort(), ['install.ko', 'install.ko', 'install.ko_resolved', 'install.postponed', 'install.postponed']);
    // stats count attempts by reason
    const stats = (await call('GET', '/api/admin/stats')).json();
    assert.ok(stats.koReasons.some((r: { reason: string; postponed: number }) => r.reason === 'weather' && r.postponed === 1));
    void A;
    await app.close();
  });

  it('asks the NOC to approve a poor-signal acceptance test and tells the installer the outcome', async () => {
    const { app, sent, call, T, newJob } = await setup();
    await call('PUT', '/api/admin/connectors/telegram', { enabled: true, token: TOKEN, chatId: '-1001234567890', events: ['provisioning_failed'], summaryHour: 19 });
    await call('PUT', '/api/account/telegram', { chatId: '424242' }, T);
    const id = await newJob('AA:BB:CC:00:00:03');
    await call('POST', `/api/provisioning/jobs/${id}/result`, { result: 'success', stages: ['ok'] }, T);

    // poor signal: waiting for the NOC
    const bad = (await call('PUT', `/api/provisioning/jobs/${id}/acceptance`, acceptance(-81, 'bad', [{ title: 'Segnale ricevuto', verdict: 'bad', detail: '-81 dBm' }]), T)).json();
    assert.equal(bad.review, 'pending');
    assert.match(bad.reviewReason, /-81 dBm \(minimo -75\)/);
    assert.ok(sent.some((m) => m.chat === '-1001234567890' && m.text.includes('Collaudo da approvare')));
    assert.deepEqual((await call('GET', '/api/provisioning/jobs?status=review')).json().map((j: { id: string }) => j.id), [id]);
    const adminInbox = (await call('GET', '/api/notifications')).json();
    assert.equal(adminInbox.items[0].kind, 'review_pending');

    // a cable problem alone does not need the NOC
    const id2 = await newJob('AA:BB:CC:00:00:04');
    await call('POST', `/api/provisioning/jobs/${id2}/result`, { result: 'success', stages: ['ok'] }, T);
    assert.equal((await call('PUT', `/api/provisioning/jobs/${id2}/acceptance`, acceptance(-60, 'bad', [{ title: 'Porta LAN (cavo)', verdict: 'bad', detail: '10 Mbit' }]), T)).json().review, null);

    // the decision is the NOC's; a refusal needs the reason
    assert.equal((await call('POST', `/api/admin/provisioning/jobs/${id}/review`, { decision: 'approved' }, T)).statusCode, 403);
    assert.equal((await call('POST', `/api/admin/provisioning/jobs/${id}/review`, { decision: 'rejected' })).statusCode, 400);
    assert.equal((await call('POST', `/api/admin/provisioning/jobs/${id}/review`, { decision: 'rejected', note: 'Ripunta verso N2-D02' })).statusCode, 200);
    const told = (await call('GET', '/api/notifications', undefined, T)).json();
    assert.equal(told.unread, 1);
    assert.match(told.items[0].title, /non accettata dal NOC/);
    assert.match(told.items[0].body, /Ripunta verso N2-D02/);
    // personal Telegram on by default for the installer's own outcomes
    assert.ok(sent.some((m) => m.chat === '424242' && m.text.includes('non accettata dal NOC')));
    const acc = (await call('GET', `/api/provisioning/jobs/${id}/acceptance`, undefined, T)).json().acceptance;
    assert.deepEqual([acc.review.state, acc.review.note], ['rejected', 'Ripunta verso N2-D02']);

    // a new test waits again, then it is approved
    assert.equal((await call('PUT', `/api/provisioning/jobs/${id}/acceptance`, acceptance(-77, 'warn'), T)).json().review, 'pending');
    await call('POST', `/api/admin/provisioning/jobs/${id}/review`, { decision: 'approved', note: 'Ok, cliente avvisato' });
    assert.match((await call('GET', '/api/notifications?unread=1', undefined, T)).json().items[0].title, /accettata dal NOC/);
    assert.equal((await call('POST', `/api/admin/provisioning/jobs/${id2}/review`, { decision: 'approved' })).json().error, 'review_not_required');

    // read state and Telegram choices
    assert.equal((await call('POST', '/api/notifications/read', { all: true }, T)).json().unread, 0);
    const prefs = (await call('GET', '/api/notifications/prefs', undefined, T)).json();
    assert.deepEqual(prefs.kinds.map((k: { kind: string }) => k.kind), ['review_decision', 'install_activated']);
    assert.deepEqual([prefs.telegram.available, prefs.telegram.linked], [true, true]);
    // an installer cannot subscribe to the NOC's kinds
    assert.deepEqual((await call('PUT', '/api/notifications/prefs', { telegram: ['install_ko', 'install_activated'] }, T)).json().telegram, ['install_activated']);
    const adminPrefs = (await call('GET', '/api/notifications/prefs')).json();
    assert.equal(adminPrefs.kinds.length, 5);
    assert.equal(adminPrefs.kinds.find((k: { kind: string }) => k.kind === 'install_ko').telegram, false);
    await app.close();
  });
});
