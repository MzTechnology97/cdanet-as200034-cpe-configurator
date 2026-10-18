import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askedFor, inspectFreeTemplate, isSsid, isUispKey, isWpa2Key, renderFreeCfg, unusedPlaceholders } from '../src/domain/specialist-cfg.ts';

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

test('in bridge or with PPPoE off no PPPoE is asked, and its lines stay empty; the UISP key is optional (titolare, 18/10/2026)', () => {
  const ppp = ['ppp.status=enabled', 'ppp.1.status=enabled', 'ppp.1.name=${PPPOE_USER}', 'ppp.1.password=${PPPOE_PASSWORD}', 'unms.uri=${UISP_ENROLLMENT}', 'unms.status=enabled'];
  const router = [...BASE, 'netmode=router', ...ppp].join('\n');
  assert.deepEqual([...unusedPlaceholders(router)], []);
  const bridge = router.replace('netmode=router', 'netmode=bridge');
  assert.deepEqual([...unusedPlaceholders(bridge)].sort(), ['PPPOE_PASSWORD', 'PPPOE_USER']);
  assert.deepEqual([...unusedPlaceholders(router.replace('ppp.status=enabled', 'ppp.status=disabled'))].sort(), ['PPPOE_PASSWORD', 'PPPOE_USER'], 'a router without PPPoE');
  // used also outside PPPoE: still asked
  assert.deepEqual([...unusedPlaceholders(`${bridge}\nresolv.host.1.name=\${PPPOE_USER}`)], ['PPPOE_PASSWORD']);
  const p = inspectFreeTemplate(bridge).placeholders;
  const asked = askedFor(p, { snmpCommunity: false, uispKey: false }, unusedPlaceholders(bridge));
  assert.ok(!asked.some((a) => a.name.startsWith('PPPOE_')));
  assert.equal(asked.find((a) => a.name === 'UISP_ENROLLMENT')?.optional, true);
  assert.ok(!asked.find((a) => a.name === 'SSID')?.optional);
  const values = { SSID: 'AP-1', CPE_USERNAME: 'admin', CPE_PASSWORD_HASH: '$1$x$y', VLAN_ID: '87' };
  assert.throws(() => renderFreeCfg(bridge, values), /missing_value_PPPOE_PASSWORD|missing_value_PPPOE_USER|missing_value_UISP_ENROLLMENT/);
  const out = renderFreeCfg(bridge, values, [['unms.status', 'disabled']], new Set(['PPPOE_USER', 'PPPOE_PASSWORD', 'UISP_ENROLLMENT']));
  for (const line of ['ppp.1.name=', 'ppp.1.password=', 'unms.uri=', 'unms.status=disabled']) assert.ok(out.split('\n').includes(line), line);
  assert.ok(isUispKey('wss://uisp.example:443+token+allowUntrustedCertificate') && !isUispKey('token') && !isUispKey('wss://a b'));
});

test('a key written in clear in the text is pointed out: the colleagues of the group read the text', () => {
  const ok = [...BASE, 'wpasupplicant.profile.1.network.1.psk=${WPA2_PSK}', 'ppp.1.password=${PPPOE_PASSWORD}', 'unms.uri='].join('\n');
  assert.ok(!inspectFreeTemplate(ok).warnings.includes('literal_secrets'));
  for (const line of ['wpasupplicant.profile.1.network.1.psk=Chiave-In-Chiaro', 'aaa.1.wpa.psk=Chiave-In-Chiaro', 'ppp.1.password=segreta', 'snmp.community=comm', 'unms.uri=wss://uisp.x:443+k', 'users.1.password=$1$abc$def']) {
    assert.ok(inspectFreeTemplate([...BASE, line].join('\n')).warnings.includes('literal_secrets'), line);
  }
});
