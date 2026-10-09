import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { testApp } from './helpers.ts';

const WEB = new URL('../../web/', import.meta.url);
const ADMIN_GUIDE = new URL('../src/guide-admin/', import.meta.url);

describe('Guide', () => {
  it('serves the administrator guide only to admins', async () => {
    const t = await testApp();
    const admin = await t.login();
    await t.app.inject({ method: 'POST', url: '/api/admin/users', headers: t.auth(admin), payload: { username: 'tecnico', password: 'Installer-Pass-123' } });
    const tec = await t.login('tecnico', 'Installer-Pass-123');
    for (const url of ['/api/admin/guide', '/api/admin/guide/img/admin-users.jpg']) {
      assert.equal((await t.app.inject({ method: 'GET', url })).statusCode, 401, url);
      assert.equal((await t.app.inject({ method: 'GET', url, headers: t.auth(tec) })).statusCode, 403, url);
    }
    const page = await t.app.inject({ method: 'GET', url: '/api/admin/guide', headers: t.auth(admin) });
    assert.equal(page.statusCode, 200);
    assert.match(page.json().html, /Account e POP\/AP assegnati/);
    const img = await t.app.inject({ method: 'GET', url: '/api/admin/guide/img/admin-users.jpg', headers: t.auth(admin) });
    assert.equal(img.statusCode, 200);
    assert.equal(img.headers['content-type'], 'image/jpeg');
    assert.match(String(img.headers['cache-control']), /no-store/);
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/admin/guide/img/missing.jpg', headers: t.auth(admin) })).statusCode, 404);
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/admin/guide/img/..%2Findex.html', headers: t.auth(admin) })).statusCode, 400);
    await t.app.close();
  });

  it('keeps the administrator guide out of the public web directory', () => {
    assert.equal(existsSync(new URL('guide-admin', WEB)), false);
    assert.doesNotMatch(readFileSync(new URL('wiki/index.html', WEB), 'utf8'), /guide-admin|\/api\/admin\//);
  });

  it('references only images that exist', () => {
    const wiki = readFileSync(new URL('wiki/index.html', WEB), 'utf8');
    assert.match(wiki, /<script src="wiki\.js" defer><\/script>/, 'photo enlargement');
    assert.ok(existsSync(new URL('wiki/wiki.js', WEB)));
    const pub = [...wiki.matchAll(/<img src="([^"]+)"/g)].map((m) => m[1]!);
    assert.ok(pub.length > 30);
    for (const src of pub) assert.ok(existsSync(new URL(`wiki/${src}`, WEB)), src);
    const adm = [...readFileSync(new URL('index.html', ADMIN_GUIDE), 'utf8').matchAll(/data-guide="([^"]+)"/g)].map((m) => m[1]!);
    assert.ok(adm.length > 10);
    for (const name of adm) assert.ok(existsSync(new URL(`img/${name}`, ADMIN_GUIDE)), name);
  });
});
