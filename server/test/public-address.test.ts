import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isNotPublicError, isPublicAddress, NOT_PUBLIC, publicLookup, publicUrlProblem } from '../src/net/public-address.ts';

/** The specialist's connectors reach the public Internet only (issue #275): never CDA Net's network. */

test('the addresses that are not the public Internet', () => {
  for (const ip of ['10.0.0.1', '100.64.1.1', '100.127.255.255', '127.0.0.1', '169.254.1.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '192.0.2.10', '198.18.0.1']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ['::', '::1', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1', '64:ff9b::10.0.0.1', '2001:db8::1', '2002:0a00:0001::1', 'fe80::1%eth0', 'not-an-ip']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '100.63.255.255', '100.128.0.1', '172.32.0.1', '93.184.216.34', '2a00:1450:4002:80a::200e', '2001:4860:4860::8888', '::ffff:8.8.8.8', '64:ff9b::8.8.8.8', '2002:0808:0808::1']) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
});

test('the URL of a connector: http(s), nothing to steer the path, no private address', () => {
  for (const u of ['https://uisp.azienda.it', 'https://uisp.azienda.it:8443/nms', 'https://93.184.216.34']) assert.equal(publicUrlProblem(u), null, u);
  for (const u of ['http://10.0.0.1:8080', 'https://127.0.0.1', 'https://[::1]', 'https://[fd00::1]:443', 'http://localhost:3000', 'http://x.localhost']) assert.equal(publicUrlProblem(u), NOT_PUBLIC, u);
  for (const u of ['http://example.com/status?', 'https://example.com/#x', 'https://user:pw@example.com', 'https://a@example.com', 'ftp://example.com', 'nonsense']) {
    assert.equal(publicUrlProblem(u), 'connector_url_invalid', u);
  }
});

test('a name is refused when it resolves to a private address, also inside the error of fetch', async () => {
  for (const all of [true, false]) {
    const err = await new Promise<unknown>((resolve) => publicLookup('localhost', { all }, (e) => resolve(e)));
    assert.ok(isNotPublicError(err), String(err));
  }
  assert.ok(isNotPublicError(Object.assign(new TypeError('fetch failed'), { cause: new Error(NOT_PUBLIC) })));
  assert.ok(!isNotPublicError(new TypeError('fetch failed')));
});
