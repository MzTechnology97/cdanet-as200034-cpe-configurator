import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { testApp } from './helpers.ts';

const ANDROID = { 'x-cda-client': 'android/1.32.15' };
const CONTROLLER = { name: 'Azienda Demo S.r.l.', address: 'Via Demo 1, 94100 Enna', vat: '00000000000', email: 'privacy@example.invalid', pec: '', dpo: '', retentionMonths: 24 };

describe('Informativa privacy', () => {
  it('asked once the admin completes it, accepted with an attestation, asked again when it changes', async () => {
    const t = await testApp();
    const A = t.auth(await t.login());
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object, headers = A) => t.app.inject({ method, url, headers, payload });
    await call('POST', '/api/admin/users', { username: 'tecnico', password: 'Installer-Pass-123' });
    const T = t.auth(await t.login('tecnico', 'Installer-Pass-123'), ANDROID);

    assert.equal((await call('GET', '/api/privacy', undefined, T)).json().required, false, 'not configured: nothing to accept');
    assert.equal((await call('PUT', '/api/admin/privacy', CONTROLLER, T)).statusCode, 403);
    assert.equal((await call('PUT', '/api/admin/privacy', CONTROLLER)).json().complete, true);

    const p = (await call('GET', '/api/privacy', undefined, T)).json();
    assert.equal(p.required, true);
    assert.match(JSON.stringify(p.notice), /Azienda Demo S\.r\.l\..*Garante/s);
    assert.equal((await call('POST', '/api/privacy/accept', { sha256: 'a'.repeat(64) }, T)).json().error, 'privacy_changed', 'only the text shown');
    const ok = await call('POST', '/api/privacy/accept', { sha256: p.sha256, device: 'Google Pixel 8' }, T);
    assert.equal(ok.statusCode, 201, ok.body);
    assert.equal((await call('GET', '/api/privacy', undefined, T)).json().required, false);

    const doc = await call('GET', `/api/privacy/acceptances/${ok.json().id}/document`, undefined, T);
    assert.match(doc.headers['content-type'] as string, /text\/html/);
    assert.ok(doc.body.includes('tecnico') && doc.body.includes(p.sha256) && doc.body.includes('Google Pixel 8') && doc.body.includes('1.32.15'));
    assert.equal((await call('GET', `/api/privacy/acceptances/${ok.json().id}/document`)).statusCode, 200, 'admins can print it');

    // new controller details = a new text: accepted again, the old attestation stays as it was
    await call('PUT', '/api/admin/privacy', { ...CONTROLLER, dpo: 'Mario Demo, dpo@example.invalid' });
    assert.equal((await call('GET', '/api/privacy', undefined, T)).json().required, true);
    const list = (await call('GET', '/api/admin/privacy')).json();
    assert.equal(list.acceptances.length, 1);
    assert.equal(list.acceptances[0].current, false);
    assert.equal(list.users.find((u: { username: string }) => u.username === 'tecnico').current, false);
    assert.ok(!(await call('GET', `/api/privacy/acceptances/${ok.json().id}/document`, undefined, T)).body.includes('Mario Demo'));
  });
});
