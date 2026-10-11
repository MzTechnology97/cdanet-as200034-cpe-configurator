import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { testApp } from './helpers.ts';

/** A tiny web folder: the console page, its code, a vendor file and the wiki. */
function webDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cdanet-web-'));
  for (const d of ['js/views', 'css', 'vendor/lib', 'wiki', 'server']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<link rel="stylesheet" href="css/app.css" /><script type="module" src="js/main.js"></script><img src="assets/logo.svg" />');
  writeFileSync(join(dir, 'map-embed.html'), '<script type="module" src="/js/map-embed.js"></script>');
  writeFileSync(join(dir, 'js/main.js'), 'import("./views/a.js");');
  writeFileSync(join(dir, 'js/views/a.js'), 'export const a = 1;');
  writeFileSync(join(dir, 'css/app.css'), 'body{}');
  writeFileSync(join(dir, 'vendor/lib/lib.js'), 'export default 1;');
  writeFileSync(join(dir, 'wiki/index.html'), '<title>Guida</title>');
  writeFileSync(join(dir, 'server/secret.txt'), 'no');
  return dir;
}

describe('Console web: file con la versione nell’indirizzo', () => {
  it('pages revalidate, the code of this release is kept a year, the rest revalidates', async () => {
    const t = await testApp({ STATIC_DIR: webDir() });
    const page = await t.app.inject({ method: 'GET', url: '/' });
    assert.equal(page.statusCode, 200);
    assert.equal(page.headers['cache-control'], 'no-cache');
    const main = /src="(\/v\/1\.0\.0-test-[a-z0-9]+\/js\/main\.js)"/.exec(page.body)?.[1];
    assert.ok(main, page.body);
    assert.match(page.body, /href="\/v\/1\.0\.0-test-[a-z0-9]+\/css\/app\.css"/);
    assert.match(page.body, /src="\/assets\/logo\.svg"/, 'images from the root, whatever the address');
    const code = await t.app.inject({ method: 'GET', url: main });
    assert.equal(code.statusCode, 200);
    assert.equal(code.headers['cache-control'], 'public, max-age=31536000, immutable');
    const tag = main.split('/')[2];
    assert.equal((await t.app.inject({ method: 'GET', url: `/v/${tag}/js/views/a.js` })).headers['cache-control'], 'public, max-age=31536000, immutable', 'a page loaded later');
    assert.equal((await t.app.inject({ method: 'GET', url: `/v/${tag}/vendor/lib/lib.js` })).statusCode, 200, 'a vendor module imported by a relative path');
    // an older release still answers, but is not kept
    const old = await t.app.inject({ method: 'GET', url: '/v/0.9.0-old/js/main.js' });
    assert.equal(old.statusCode, 200);
    assert.equal(old.headers['cache-control'], 'no-cache');
    // only the console's folders under /v/
    assert.equal((await t.app.inject({ method: 'GET', url: `/v/${tag}/server/secret.txt` })).statusCode, 404);
    assert.notEqual((await t.app.inject({ method: 'GET', url: `/v/${tag}/js/../server/secret.txt` })).body, 'no');
    // everything else as before: revalidated
    assert.equal((await t.app.inject({ method: 'GET', url: '/vendor/lib/lib.js' })).headers['cache-control'], 'no-cache');
    const wiki = await t.app.inject({ method: 'GET', url: '/wiki/' });
    assert.equal(wiki.statusCode, 200);
    assert.match(wiki.body, /Guida/);
    // a deep address and the Android map page get the console page with the same addresses
    assert.match((await t.app.inject({ method: 'GET', url: '/qualcosa/profondo' })).body, /src="\/v\/1\.0\.0-test-[a-z0-9]+\/js\/main\.js"/);
    assert.match((await t.app.inject({ method: 'GET', url: '/map-embed.html' })).body, /src="\/v\/1\.0\.0-test-[a-z0-9]+\/js\/map-embed\.js"/);
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/nulla' })).statusCode, 404);
  });

  it('with the Vite build (web/app) its pages are served, its hashed files kept a year', async () => {
    const dir = webDir();
    mkdirSync(join(dir, 'app/assets'), { recursive: true });
    writeFileSync(join(dir, 'app/index.html'), '<script type="module" src="/app/assets/main-AbC123.js"></script>');
    writeFileSync(join(dir, 'app/map-embed.html'), '<script type="module" src="/app/assets/embed-XyZ789.js"></script>');
    writeFileSync(join(dir, 'app/assets/main-AbC123.js'), 'console.log(1);');
    const t = await testApp({ STATIC_DIR: dir });
    for (const url of ['/', '/index.html', '/qualcosa/profondo']) {
      const r = await t.app.inject({ method: 'GET', url });
      assert.match(r.body, /\/app\/assets\/main-AbC123\.js/, url);
      assert.equal(r.headers['cache-control'], 'no-cache', url);
    }
    assert.match((await t.app.inject({ method: 'GET', url: '/map-embed.html' })).body, /embed-XyZ789/);
    const code = await t.app.inject({ method: 'GET', url: '/app/assets/main-AbC123.js' });
    assert.equal(code.statusCode, 200);
    assert.equal(code.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal((await t.app.inject({ method: 'GET', url: '/vendor/lib/lib.js' })).headers['cache-control'], 'no-cache', 'vendor as before');
    assert.equal((await t.app.inject({ method: 'GET', url: '/wiki/' })).statusCode, 200, 'wiki as before');
  });
});
