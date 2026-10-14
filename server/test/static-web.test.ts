import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { testApp } from './helpers.ts';

/** A tiny web folder: the notice of a missing build, a vendor file and the wiki. */
function webDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cdanet-web-'));
  for (const d of ['vendor/lib', 'wiki']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<h1>Console non compilata</h1>');
  writeFileSync(join(dir, 'vendor/lib/lib.js'), 'export default 1;');
  writeFileSync(join(dir, 'wiki/index.html'), '<title>Guida</title>');
  return dir;
}

describe('Console web', () => {
  it('without the build every page says how to build it; vendor and wiki as files', async () => {
    const t = await testApp({ STATIC_DIR: webDir() });
    for (const url of ['/', '/qualcosa/profondo', '/map-embed.html']) {
      const r = await t.app.inject({ method: 'GET', url });
      assert.equal(r.statusCode, 200, url);
      assert.equal(r.headers['cache-control'], 'no-cache', url);
      assert.match(r.body, /Console non compilata/, url);
    }
    assert.equal((await t.app.inject({ method: 'GET', url: '/vendor/lib/lib.js' })).headers['cache-control'], 'no-cache');
    const wiki = await t.app.inject({ method: 'GET', url: '/wiki/' });
    assert.equal(wiki.statusCode, 200);
    assert.match(wiki.body, /Guida/);
    assert.equal((await t.app.inject({ method: 'GET', url: '/api/nulla' })).statusCode, 404);
    // the old addresses of the code with the release in them are gone
    assert.equal((await t.app.inject({ method: 'GET', url: '/v/1.0.0-old/js/main.js' })).statusCode, 404);
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
    // a script of an older build: 404 (the console reloads), never the page served as a script
    const gone = await t.app.inject({ method: 'GET', url: '/app/assets/health-Old123.js' });
    assert.equal(gone.statusCode, 404);
    assert.doesNotMatch(gone.headers['content-type'] ?? '', /html/);
    assert.equal((await t.app.inject({ method: 'GET', url: '/qualcosa/senza-estensione' })).statusCode, 200, 'a deep address still opens the console');
  });
});
