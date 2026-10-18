import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { NOT_PUBLIC } from '../src/net/public-address.ts';
import { publicFetch } from '../src/net/public-fetch.ts';

/**
 * The real fetch of the specialist's connectors (issue #275): the server itself, as an address, as a
 * name or as an IPv4-mapped address, is refused when the connection is made, before any request.
 */
test('the fetch of the connectors never reaches the server itself', async () => {
  let hits = 0;
  const srv = createServer((_req, res) => {
    hits++;
    res.end('ok');
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
  const { port } = srv.address() as AddressInfo;
  try {
    for (const ignoreTls of [false, true]) {
      const f = publicFetch(ignoreTls);
      for (const url of [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`, `http://[::ffff:127.0.0.1]:${port}/`]) {
        await assert.rejects(f(url), (e: Error) => e.message === NOT_PUBLIC, url);
      }
    }
    assert.equal(hits, 0, 'nothing reached it');
    // the server is there: a plain fetch gets its answer
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'ok');
    assert.equal(hits, 1);
  } finally {
    srv.close();
  }
});
