import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inflateSync } from 'node:zlib';
import { jpegInfo, textWidth, wrap } from '../src/services/pdf.ts';
import { SAMPLE_TEMPLATE, testApp } from './helpers.ts';

const ANDROID = { 'x-cda-client': 'android/9.0.0' };

/** The text drawn on the pages of a PDF (its compressed content streams, inflated). */
function pdfText(pdf: Buffer): string {
  const out: string[] = [];
  let at = 0;
  const open = '/Filter /FlateDecode >>\nstream\n';
  for (;;) {
    const head = pdf.indexOf(open, at, 'latin1');
    if (head < 0) break;
    const start = head + open.length;
    const end = pdf.indexOf('\nendstream', start, 'latin1');
    try {
      out.push(inflateSync(pdf.subarray(start, end)).toString('latin1'));
    } catch {
      /* an image stream */
    }
    at = end;
  }
  return out.join('\n');
}

/** The header of a JPEG (SOI + SOF0 640×480, 3 components), padded to the size the photo route wants. */
function fakeJpeg(): Buffer {
  const sof = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  return Buffer.concat([sof, Buffer.alloc(2048, 0), Buffer.from([0xff, 0xd9])]);
}

describe('Rapporto di collaudo in PDF', () => {
  it('measures and wraps Helvetica text, reads JPEG sizes', () => {
    assert.equal(textWidth('CDA', 10), 21.11, 'C 722 + D 722 + A 667');
    assert.equal(Math.round(textWidth('è', 10) * 100), Math.round(textWidth('e', 10) * 100), 'accents as their letter');
    assert.deepEqual(wrap('uno due tre quattro', 10, 40), ['uno due', 'tre', 'quattro']);
    assert.deepEqual(jpegInfo(fakeJpeg()), { width: 640, height: 480, components: 3 });
    assert.equal(jpegInfo(Buffer.from('not a jpeg')), null);
  });

  it('the NOC downloads the report of an installation, with its photos; the installer their own', async () => {
    const t = await testApp();
    const A = t.auth(await t.login());
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object | Buffer, headers: Record<string, string> = A) => t.app.inject({ method, url, headers, payload });
    await call('POST', '/api/admin/users', { username: 'tecnico', password: 'Installer-Pass-123' });
    await call('POST', '/api/admin/profiles/LiteBeam%205AC/templates', { name: 'Standard', template: SAMPLE_TEMPLATE, boardMatch: 'board\\.name=LiteBeam 5AC' });
    await call('PUT', '/api/admin/wireless-networks/CDA-NET-N2-D01', { wpa2Password: 'test-psk-12345' });
    const T = t.auth(await t.login('tecnico', 'Installer-Pass-123'));
    const job = (await call('POST', '/api/provisioning/jobs', { model: 'LiteBeam 5AC', mac: 'AA:BB:CC:00:00:01', serial: 'S1', ssid: 'CDA-NET-N2-D01', pppoeUser: 'rossi.mario@cda-net.it', pppoePassword: 'Segreta-PPPoE-9' }, { ...T, ...ANDROID })).json().jobId;
    await call('POST', `/api/provisioning/jobs/${job}/result`, { result: 'success', stages: [] }, T);
    const url = `/api/admin/provisioning/jobs/${job}/acceptance.pdf`;
    assert.equal((await call('GET', url)).json().error, 'acceptance_not_found', 'no report before the acceptance test');

    await call('PUT', `/api/provisioning/jobs/${job}/acceptance`, {
      verdict: 'ok', measuredAt: new Date().toISOString(), samples: 10,
      cpe: { model: 'LiteBeam 5AC Gen2', firmware: 'WA.v8.7.4', apName: 'N2-D01' }, radio: { signal: -60, cinrRx: 28, chains: [-61, -62] },
      internet: { tested: true, pingMs: 12, downloadMbps: 25.1, uploadMbps: 5 }, checks: [{ title: 'Segnale ricevuto', verdict: 'ok', detail: 'ottimo, è come atteso' }],
      notes: 'Cliente presente.',
    }, T);
    const photo = await t.app.inject({ method: 'POST', url: `/api/provisioning/jobs/${job}/photos?caption=CPE%20montata`, headers: { ...T, 'content-type': 'image/jpeg' }, payload: fakeJpeg() });
    assert.equal(photo.statusCode, 201, photo.body);

    assert.equal((await call('GET', url, undefined, T)).statusCode, 403, 'installers do not');
    const r = await call('GET', url);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.headers['content-type'], 'application/pdf');
    assert.match(String(r.headers['content-disposition']), /attachment; filename="collaudo-rossi-mario-\d{4}-\d{2}-\d{2}\.pdf"/);
    const pdf = r.rawPayload;
    assert.equal(pdf.subarray(0, 8).toString('latin1'), '%PDF-1.4');
    assert.match(pdf.subarray(-6).toString('latin1'), /%%EOF/);
    const text = pdf.toString('latin1');
    assert.match(text, /\/Subtype \/Image \/Width 640 \/Height 480/, 'the photo is in it');
    assert.ok(!text.includes('Segreta-PPPoE-9'), 'never the PPPoE password');
    assert.ok(pdfText(pdf).includes('Sito UISP'), 'the NOC sees the site of UISP');

    // the installer of the job: the same report from their own route, without the data source
    const mine = `/api/provisioning/jobs/${job}/acceptance.pdf`;
    const own = await call('GET', mine, undefined, T);
    assert.equal(own.statusCode, 200, own.body);
    const ownText = pdfText(own.rawPayload);
    assert.ok(!ownText.includes('UISP'), 'never the name of the data source to installers');
    assert.ok(ownText.includes('In rete'));
    // the speed test on a cable to the router (USB-C Ethernet adapter): the report says so
    const viaCable = await call('PUT', `/api/provisioning/jobs/${job}/acceptance`, {
      verdict: 'ok', measuredAt: new Date().toISOString(), samples: 10,
      cpe: { model: 'LiteBeam 5AC Gen2', firmware: 'WA.v8.7.4', apName: 'N2-D01' }, radio: { signal: -60, cinrRx: 28, chains: [-61, -62] },
      internet: { tested: true, pingMs: 12, downloadMbps: 25.1, uploadMbps: 5 }, checks: [], wifi: { cable: true },
    }, T);
    assert.equal(viaCable.statusCode, 200, viaCable.body);
    const cableText = pdfText((await call('GET', mine, undefined, T)).rawPayload);
    assert.ok(cableText.includes('cavo Ethernet'), `measured on the cable: ${cableText.slice(cableText.indexOf('Rete'), cableText.indexOf('Rete') + 200)}`);
    assert.ok(!ownText.includes('Segreta-PPPoE-9') && !own.rawPayload.toString('latin1').includes('Segreta-PPPoE-9'));
    // ?view=1: opened in the browser instead of downloaded
    assert.match(String((await call('GET', `${mine}?view=1`, undefined, T)).headers['content-disposition']), /^inline; filename=/);
    // another installer: not theirs
    await call('POST', '/api/admin/users', { username: 'altro', password: 'Installer-Pass-456' });
    const O = t.auth(await t.login('altro', 'Installer-Pass-456'));
    assert.equal((await call('GET', mine, undefined, O)).statusCode, 403, 'not the job of another installer');
    const events = (await call('GET', '/api/admin/events?limit=20')).json();
    assert.ok((Array.isArray(events) ? events : events.items).some((e: { action: string }) => e.action === 'job.acceptance_pdf'));
    await t.app.close();
  });

  it('the NOC marks a failed test as passed, with the reason; it counts as passed everywhere', async () => {
    const t = await testApp();
    const A = t.auth(await t.login());
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object | Buffer, headers: Record<string, string> = A) => t.app.inject({ method, url, headers, payload });
    await call('POST', '/api/admin/users', { username: 'tecnico', password: 'Installer-Pass-123' });
    await call('POST', '/api/admin/profiles/LiteBeam%205AC/templates', { name: 'Standard', template: SAMPLE_TEMPLATE, boardMatch: 'board\.name=LiteBeam 5AC' });
    await call('PUT', '/api/admin/wireless-networks/CDA-NET-N2-D01', { wpa2Password: 'test-psk-12345' });
    const T = t.auth(await t.login('tecnico', 'Installer-Pass-123'));
    const job = (await call('POST', '/api/provisioning/jobs', { model: 'LiteBeam 5AC', mac: 'AA:BB:CC:00:00:02', serial: 'S2', ssid: 'CDA-NET-N2-D01', pppoeUser: 'bianchi@cda-net.it', pppoePassword: 'Segreta-PPPoE-8' }, { ...T, ...ANDROID })).json().jobId;
    await call('POST', `/api/provisioning/jobs/${job}/result`, { result: 'success', stages: [] }, T);
    const pass = `/api/admin/provisioning/jobs/${job}/acceptance/pass`;
    assert.equal((await call('POST', pass, { note: 'prova' })).json().error, 'acceptance_not_found', 'nothing to mark before the test');
    await call('PUT', `/api/provisioning/jobs/${job}/acceptance`, {
      verdict: 'bad', measuredAt: new Date().toISOString(), samples: 10,
      cpe: { model: 'LiteBeam 5AC Gen2', firmware: 'WA.v8.7.4', apName: 'N2-D01' }, radio: { signal: -82, cinrRx: 8, chains: [-82, -84] },
      internet: { tested: false }, checks: [{ title: 'Segnale ricevuto', verdict: 'bad', detail: 'pessimo' }], notes: '',
    }, T);
    assert.equal((await call('POST', pass, { note: 'prova' }, T)).statusCode, 403, 'installers may not');
    assert.equal((await call('POST', pass, {})).statusCode, 400, 'the reason is required');
    const r = await call('POST', pass, { note: 'Cliente lontano, segnale accettato dal titolare' });
    assert.equal(r.statusCode, 200, r.body);
    const a = (await call('GET', `/api/provisioning/jobs/${job}/acceptance`)).json().acceptance;
    assert.equal(a.verdict, 'ok');
    assert.equal(a.override.from, 'bad');
    assert.equal(a.override.note, 'Cliente lontano, segnale accettato dal titolare');
    assert.equal(a.review.state, 'approved');
    assert.equal((await call('POST', pass, { note: 'di nuovo' })).json().error, 'acceptance_already_passed');
    const events = (await call('GET', '/api/admin/events?limit=20')).json();
    assert.ok((Array.isArray(events) ? events : events.items).some((e: { action: string }) => e.action === 'job.acceptance_pass'));
    const pdf = await call('GET', `/api/admin/provisioning/jobs/${job}/acceptance.pdf`);
    assert.ok(pdfText(pdf.rawPayload).includes('SUPERATO PER DECISIONE DEL NOC'));
    await t.app.close();
  });
});
