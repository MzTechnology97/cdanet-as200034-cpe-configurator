import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askedFor, inspectFreeTemplate, isSsid, isWpa2Key, renderFreeCfg } from '../src/domain/specialist-cfg.ts';

/** The specialist's templates (owner, 17/10/2026): what the app asks for each CPE, and the file written. */

const BASE = [
  'radio.1.mode=managed',
  'wireless.1.ssid=${SSID}',
  'netconf.1.devname=eth0',
  'users.1.name=${CPE_USERNAME}',
  'users.1.password=${CPE_PASSWORD_HASH}',
  'vlan.1.id=${VLAN_ID}',
];

test('the values typed for each CPE: CDA Net placeholders, his own, the SNMP location without a device name', () => {
  const withName = [...BASE, 'resolv.host.1.name=${DEVICE_NAME}', 'snmp.location=${SNMP_LOCATION}'].join('\n');
  const r = inspectFreeTemplate(withName);
  assert.ok(r.ok, r.errors.join());
  assert.deepEqual(r.own, ['VLAN_ID']);
  const names = askedFor(r.placeholders, { snmpCommunity: false, uispKey: false }).map((a) => a.name);
  assert.deepEqual(names.sort(), ['DEVICE_NAME', 'SSID', 'VLAN_ID']);

  // no ${DEVICE_NAME}: the SNMP location has nothing to come from, so it is asked
  const noName = [...BASE, 'snmp.location=${SNMP_LOCATION}'].join('\n');
  const asked = askedFor(inspectFreeTemplate(noName).placeholders, { snmpCommunity: false, uispKey: false });
  assert.ok(asked.some((a) => a.name === 'SNMP_LOCATION' && !a.own));
});

test('secrets are marked, a community or a UISP key on the server is not asked', () => {
  const text = [...BASE, 'wpasupplicant.profile.1.network.1.psk=${WPA2_PSK}', 'snmp.community=${SNMP_COMMUNITY}', 'unms.uri=${UISP_ENROLLMENT}', 'x.key=${RADIUS_KEY}'].join('\n');
  const p = inspectFreeTemplate(text).placeholders;
  const all = askedFor(p, { snmpCommunity: false, uispKey: false });
  assert.equal(all.find((a) => a.name === 'WPA2_PSK')?.secret, true);
  assert.equal(all.find((a) => a.name === 'RADIUS_KEY')?.secret, true, 'his own KEY is hidden too');
  const filled = askedFor(p, { snmpCommunity: true, uispKey: true }).map((a) => a.name);
  assert.ok(!filled.includes('SNMP_COMMUNITY') && !filled.includes('UISP_ENROLLMENT'));
});

test('the file: one pass, a missing value refused, the position added', () => {
  const text = [...BASE].join('\n');
  const values = { SSID: 'AP-${VLAN_ID}', CPE_USERNAME: 'admin', CPE_PASSWORD_HASH: '$1$x$y', VLAN_ID: '87' };
  const out = renderFreeCfg(text, values, [['system.latitude', '37.580100']]);
  assert.match(out, /^wireless\.1\.ssid=AP-\$\{VLAN_ID\}$/m, 'a value is never expanded again');
  assert.match(out, /^vlan\.1\.id=87$/m);
  assert.match(out, /^system\.latitude=37\.580100$/m);
  assert.throws(() => renderFreeCfg(text, { ...values, VLAN_ID: '' }), /missing_value_VLAN_ID/);
  assert.ok(isWpa2Key('12345678') && !isWpa2Key('corta') && isWpa2Key('a'.repeat(64).replace(/a/g, 'F')));
  assert.ok(isSsid('AZIENDA-X') && !isSsid('') && !isSsid('x'.repeat(33)));
});
