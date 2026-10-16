import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { SAMPLE_TEMPLATE, testApp } from './helpers.ts';

const ANDROID = { 'x-cda-client': 'android/1.33.89' };

function fakeJpeg(): Buffer {
  const sof = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  return Buffer.concat([sof, Buffer.alloc(2048, 0), Buffer.from([0xff, 0xd9])]);
}

const test = (signal: number, extra: object = {}) => ({
  verdict: 'ok',
  measuredAt: new Date().toISOString(),
  samples: 10,
  cpe: { essid: 'CDA-NET-N2-D01' },
  radio: { signal },
  internet: { tested: false },
  checks: [],
  ...extra,
});

describe('Ripuntamenti: ogni collaudo resta nello storico', () => {
  it('keeps the installation test, makes a done «Ripuntamento» order, lets another technician re-point and tells the NOC', async () => {
    const t = await testApp();
    const admin = await t.login();
    const H = t.auth(admin);
    await t.app.inject({ method: 'POST', url: '/api/admin/users', headers: H, payload: { username: 'tecnico', password: 'Installer-Pass-123' } });
    await t.app.inject({ method: 'POST', url: '/api/admin/users', headers: H, payload: { username: 'altro', password: 'Installer-Pass-456' } });
    await t.app.inject({ method: 'POST', url: '/api/admin/profiles/LiteBeam%205AC/templates', headers: H, payload: { name: 'Standard', template: SAMPLE_TEMPLATE, boardMatch: 'board\\.name=LiteBeam 5AC' } });
    await t.app.inject({ method: 'PUT', url: '/api/admin/wireless-networks/CDA-NET-N2-D01', headers: H, payload: { wpa2Password: 'test-psk-12345' } });
    const tec = await t.login('tecnico', 'Installer-Pass-123');
    const other = await t.login('altro', 'Installer-Pass-456');
    const T = t.auth(tec);
    const O = t.auth(other);
    const job = (
      await t.app.inject({
        method: 'POST',
        url: '/api/provisioning/jobs',
        headers: { ...T, ...ANDROID },
        payload: { model: 'LiteBeam 5AC', mac: 'AA:BB:CC:DD:EE:FF', serial: 'S1', ssid: 'CDA-NET-N2-D01', pppoeUser: 'rossi.mario@cda-net.it', pppoePassword: 'x' },
      })
    ).json().jobId as string;
    await t.app.inject({ method: 'POST', url: `/api/provisioning/jobs/${job}/result`, headers: T, payload: { result: 'success', stages: ['ok'], detected: {} } });
    const put = (h: Record<string, string>, body: object) => t.app.inject({ method: 'PUT', url: `/api/provisioning/jobs/${job}/acceptance`, headers: h, payload: body });
    const photo = (h: Record<string, string>, caption: string) =>
      t.app.inject({ method: 'POST', url: `/api/provisioning/jobs/${job}/photos?caption=${encodeURIComponent(caption)}`, headers: { ...h, 'content-type': 'image/jpeg' }, payload: fakeJpeg() });
    const orders = () => t.db.prepare("SELECT id, kind, status, job_id FROM work_orders WHERE kind = 'repoint'").all() as Array<{ id: number; kind: string; status: string; job_id: string }>;

    // the installation's own test, with its photo
    assert.equal((await put(T, test(-60))).statusCode, 200);
    assert.equal((await photo(T, 'Antenna')).statusCode, 201);

    // a re-pointing: a new test, the installation's one moved into the history with its photo
    const t1 = randomUUID();
    const r1 = await put(T, test(-55, { kind: 'repoint', testId: t1 }));
    assert.equal(r1.statusCode, 200, r1.body);
    const cur = (await t.app.inject({ method: 'GET', url: `/api/provisioning/jobs/${job}/acceptance`, headers: T })).json();
    assert.equal(cur.acceptance.radio.signal, -55);
    assert.deepEqual(cur.photos, [], 'the earlier photos belong to the earlier test');
    let hist = (await t.app.inject({ method: 'GET', url: `/api/provisioning/jobs/${job}/acceptance/history`, headers: T })).json().items;
    assert.equal(hist.length, 1);
    assert.deepEqual([hist[0].kind, hist[0].radio.signal, hist[0].photos.length, hist[0].photos[0].caption], ['install', -60, 1, 'Antenna']);
    // the work order of the re-pointing: made, done, on this installation
    assert.equal(orders().length, 1);
    assert.deepEqual([orders()[0]!.status, orders()[0]!.job_id], ['done', job]);

    // the same test sent again (offline queue): nothing new
    assert.equal((await put(T, test(-55, { kind: 'repoint', testId: t1 }))).statusCode, 200);
    hist = (await t.app.inject({ method: 'GET', url: `/api/provisioning/jobs/${job}/acceptance/history`, headers: T })).json().items;
    assert.equal(hist.length, 1, 'one test sent twice is one test');
    assert.equal(orders().length, 1);

    // another technician on a CPE that is not theirs: not found, then handed over for the re-pointing
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/field/cpe?macs=AA:BB:CC:DD:EE:FF', headers: O })).json().job, null);
    assert.equal((await put(O, test(-58, { kind: 'repoint', testId: randomUUID() }))).statusCode, 403);
    // the installation's position is known: only from the customer's
    t.db.prepare('UPDATE provisioning_jobs SET latitude = 37.5679, longitude = 14.2794 WHERE id = ?').run(job);
    const claimAt = (pos?: object) => t.app.inject({ method: 'POST', url: '/api/field/cpe/claim', headers: O, payload: { macs: ['AA:BB:CC:DE:EE:FF'], ...(pos ? { position: pos } : {}) } });
    assert.equal((await claimAt()).json().error, 'position_required');
    const far = await claimAt({ lat: 37.6, lon: 14.2794, accuracyM: 10 });
    assert.deepEqual([far.statusCode, far.json().error], [403, 'too_far']);
    const claim = await claimAt({ lat: 37.5681, lon: 14.2796, accuracyM: 15 });
    assert.equal(claim.json().job.id, job, 'found by its LAN MAC too');
    assert.equal('userId' in claim.json().job, false);
    // claimed again the same day: one notice
    assert.equal((await claimAt({ lat: 37.5681, lon: 14.2796 })).statusCode, 200);
    assert.equal((await put(O, test(-58, { kind: 'repoint', testId: randomUUID() }))).statusCode, 200);
    hist = (await t.app.inject({ method: 'GET', url: `/api/provisioning/jobs/${job}/acceptance/history`, headers: H })).json().items;
    assert.deepEqual(hist.map((h: { kind: string }) => h.kind), ['repoint', 'install'], 'newest first, nothing lost');
    assert.equal(orders().length, 2);
    // the NOC heard of both re-pointings without a planned order; the second one says whose CPE it was
    const noc = t.db.prepare("SELECT title, body FROM notifications WHERE kind = 'repoint_unplanned' ORDER BY id").all() as Array<{ title: string; body: string }>;
    // the first re-pointing, the claim (at once, with the distance), the second re-pointing
    assert.equal(noc.length, 3);
    assert.match(noc[1]!.title, /presa per un ripuntamento/);
    assert.match(noc[1]!.body, /Telefono a \d+ m dall'installazione/);
    assert.ok(noc[2]!.body.includes('Installata da tecnico'), noc[2]!.body);
    // the NOC sees the grant and ends it; after a day it ends by itself
    const oid = (t.db.prepare("SELECT id FROM users WHERE username = 'altro'").get() as { id: number }).id;
    const grants = (await t.app.inject({ method: 'GET', url: `/api/admin/provisioning/jobs/${job}/repoint-grants`, headers: H })).json();
    assert.deepEqual([grants.items.length, grants.items[0].username, grants.items[0].active], [1, 'altro', true]);
    assert.equal((await t.app.inject({ method: 'DELETE', url: `/api/admin/provisioning/jobs/${job}/repoint-grants/${oid}`, headers: H })).statusCode, 200);
    assert.equal((await put(O, test(-58, { kind: 'repoint', testId: randomUUID() }))).statusCode, 403, 'revoked');
    assert.equal((await claimAt({ lat: 37.5681, lon: 14.2796 })).statusCode, 200);
    t.db.prepare('UPDATE repoint_grants SET granted_at = ?').run(new Date(Date.now() - 25 * 3_600_000).toISOString());
    assert.equal((await put(O, test(-58, { kind: 'repoint', testId: randomUUID() }))).statusCode, 403, 'expired after a day');
    // the claim is in the activity log; a CPE nobody installed with the app: nothing to attach to
    assert.equal((t.db.prepare("SELECT count(*) n FROM events WHERE action = 'job.repoint_claim'").get() as { n: number }).n, 2);
    assert.equal((await t.app.inject({ method: 'POST', url: '/api/field/cpe/claim', headers: O, payload: { macs: ['11:22:33:44:55:66'] } })).json().job, null);
    await t.app.close();
  });

  it('a re-pointing from a planned work order closes that order and makes no other', async () => {
    const t = await testApp();
    const admin = await t.login();
    const H = t.auth(admin);
    await t.app.inject({ method: 'POST', url: '/api/admin/users', headers: H, payload: { username: 'tecnico', password: 'Installer-Pass-123' } });
    await t.app.inject({ method: 'POST', url: '/api/admin/profiles/LiteBeam%205AC/templates', headers: H, payload: { name: 'Standard', template: SAMPLE_TEMPLATE, boardMatch: 'board\\.name=LiteBeam 5AC' } });
    await t.app.inject({ method: 'PUT', url: '/api/admin/wireless-networks/CDA-NET-N2-D01', headers: H, payload: { wpa2Password: 'test-psk-12345' } });
    const tec = await t.login('tecnico', 'Installer-Pass-123');
    const T = t.auth(tec);
    const tid = (t.db.prepare("SELECT id FROM users WHERE username = 'tecnico'").get() as { id: number }).id;
    const job = (
      await t.app.inject({
        method: 'POST',
        url: '/api/provisioning/jobs',
        headers: { ...T, ...ANDROID },
        payload: { model: 'LiteBeam 5AC', mac: 'AA:BB:CC:DD:EE:01', serial: 'S1', ssid: 'CDA-NET-N2-D01', pppoeUser: 'bianchi.anna@cda-net.it', pppoePassword: 'x' },
      })
    ).json().jobId as string;
    await t.app.inject({ method: 'POST', url: `/api/provisioning/jobs/${job}/result`, headers: T, payload: { result: 'success', stages: ['ok'], detected: {} } });
    const order = (
      await t.app.inject({ method: 'POST', url: '/api/admin/work-orders', headers: H, payload: { day: new Date().toISOString().slice(0, 10), kind: 'repoint', customer: 'Bianchi Anna', assignedTo: tid } })
    ).json().item.id as number;
    await t.app.inject({ method: 'PUT', url: `/api/provisioning/jobs/${job}/acceptance`, headers: T, payload: test(-61) });
    const r = await t.app.inject({ method: 'PUT', url: `/api/provisioning/jobs/${job}/acceptance`, headers: T, payload: test(-57, { kind: 'repoint', testId: randomUUID(), workOrderId: order }) });
    assert.equal(r.statusCode, 200, r.body);
    const rows = t.db.prepare("SELECT id, status, job_id FROM work_orders WHERE kind = 'repoint'").all() as Array<{ id: number; status: string; job_id: string }>;
    assert.deepEqual(rows.map((r) => ({ ...r })), [{ id: order, status: 'done', job_id: job }], 'the planned order is the one closed');
    assert.equal((t.db.prepare("SELECT count(*) n FROM notifications WHERE kind = 'repoint_unplanned'").get() as { n: number }).n, 0, 'planned: nothing to tell the NOC');
    await t.app.close();
  });

  it('a CPE installed before the app is registered on site and gets the test of a new installation', async () => {
    const t = await testApp();
    const admin = await t.login();
    const H = t.auth(admin);
    await t.app.inject({ method: 'POST', url: '/api/admin/users', headers: H, payload: { username: 'tecnico', password: 'Installer-Pass-123' } });
    const T = t.auth(await t.login('tecnico', 'Installer-Pass-123'));
    const reg = (macs: string[]) =>
      t.app.inject({
        method: 'POST',
        url: '/api/field/cpe/register',
        headers: T,
        payload: { macs, model: 'NanoStation 5AC Loco', hostname: 'Verdi Luca', ssid: 'CDA-NET-N2-D01', position: { lat: 37.5679, lon: 14.2794, accuracyM: 8 } },
      });
    const r = await reg(['DE:AD:BE:EF:00:01', 'DE:AD:BE:F0:00:01']);
    assert.equal(r.statusCode, 200, r.body);
    const job = r.json().job;
    assert.deepEqual([job.status, job.mac, job.deviceName, job.pppoeUser], ['success', 'DE:AD:BE:EF:00:01', 'VERDI LUCA', '']);
    // the technician's own installation now: found again, its test is an installation's
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/field/cpe?macs=DE:AD:BE:EF:00:01', headers: T })).json().job.id, job.id);
    const put = await t.app.inject({ method: 'PUT', url: `/api/provisioning/jobs/${job.id}/acceptance`, headers: T, payload: test(-60) });
    assert.equal(put.statusCode, 200, put.body);
    assert.equal((t.db.prepare('SELECT kind FROM job_acceptance WHERE job_id = ?').get(job.id) as { kind: string }).kind, 'install');
    // never twice, not even by the LAN MAC: it is found (or handed over) instead
    assert.equal((await reg(['DE:AD:BE:F0:00:01'])).json().error, 'cpe_known');
    // the NOC knows, the activity log too
    const noc = t.db.prepare("SELECT title, body FROM notifications WHERE kind = 'repoint_unplanned'").all() as Array<{ title: string; body: string }>;
    assert.ok(noc.some((n) => /installata prima dell'app registrata: VERDI LUCA/.test(n.title)), JSON.stringify(noc));
    assert.equal((t.db.prepare("SELECT count(*) n FROM events WHERE action = 'job.adopted'").get() as { n: number }).n, 1);
    await t.app.close();
  });
});
