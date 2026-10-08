import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { createSealer, hashPassword, md5Crypt, verifyPassword } from '../src/crypto.ts';
import { customerNameFromRadius, parseClientHeader, parseMac, ssidFor, versionAtLeast, SSID_RX } from '../src/domain/policy.ts';
import { parseKeyValues, readonlyCommand, redactRouterOs, summarize } from '../src/domain/routeros.ts';
import { inspectTemplate, renderSystemCfg, setKey } from '../src/domain/systemcfg.ts';
import { parseScanCidr, isPrivateIPv4 } from '../src/net/ip.ts';
import { buildGetRequest, decodeOid, encodeOid, parseResponse, tlv } from '../src/net/snmp.ts';
import { SAMPLE_TEMPLATE } from './helpers.ts';

describe('crypto', () => {
  it('md5Crypt matches openssl passwd -1', () => {
    assert.equal(md5Crypt('password', 'saltsalt'), '$1$saltsalt$qjXMvbEw8oaL.CzflDtaK/');
    assert.equal(md5Crypt('CdaNet-Pass!2026', 'Ab3/.x'), '$1$Ab3/.x$6uAY/EY0ltzmf9klk.mNn0');
    assert.equal(md5Crypt('', 'abcdefgh'), '$1$abcdefgh$M55TzYaaccxVGbptZWaxX/');
    assert.match(md5Crypt('x'), /^\$1\$[./0-9A-Za-z]{8}\$[./0-9A-Za-z]{22}$/);
  });

  it('seals and opens secrets, rejecting tampering', () => {
    const s = createSealer(randomBytes(32));
    const sealed = s.seal('wpa2-secret');
    assert.equal(s.open(sealed), 'wpa2-secret');
    const [iv, tag, ct] = sealed.split('.');
    const tampered = `${iv}.${tag}.${Buffer.from('x' + ct).toString('base64')}`;
    assert.throws(() => s.open(tampered));
  });

  it('verifies v0.5.x scrypt hashes', () => {
    const h = hashPassword('Installer-Password-1');
    assert.ok(verifyPassword('Installer-Password-1', h));
    assert.ok(!verifyPassword('wrong', h));
    assert.ok(!verifyPassword('x', 'garbage'));
  });
});

describe('policy', () => {
  it('derives COGNOME NOME from the RADIUS username', () => {
    assert.equal(customerNameFromRadius('rossi.mario@cda-net.it'), 'ROSSI MARIO');
    assert.equal(customerNameFromRadius('De_Luca-Anna@CDA-NET.IT'), 'DE LUCA ANNA');
  });
  it('accepts MAC addresses with or without separators', () => {
    for (const v of ['24A43C112233', '24a43c112233', '24:a4:3c:11:22:33', '24-A4-3C-11-22-33', '24a4.3c11.2233', ' 24 A4 3C 11 22 33 ']) {
      assert.equal(parseMac(v), '24:A4:3C:11:22:33', v);
    }
    for (const v of ['24A43C11223', '24A43C1122334', '24A43C11223G', '', 'not-a-mac']) assert.equal(parseMac(v), null, v);
  });
  it('builds and validates SSIDs', () => {
    assert.equal(ssidFor(2, 1), 'CDA-NET-N2-D01');
    assert.ok(SSID_RX.test(ssidFor(99, 99)));
    assert.ok(!SSID_RX.test('CDA-NET-N1-D01'));
    assert.ok(!SSID_RX.test('CDA-NET-N2-D00'));
  });
  it('compares versions and parses the client header', () => {
    assert.ok(versionAtLeast('1.0.0', '1.0.0'));
    assert.ok(versionAtLeast('1.10.0', '1.9.9'));
    assert.ok(!versionAtLeast('0.5.1', '1.0.0'));
    assert.deepEqual(parseClientHeader('android/1.2.3'), { platform: 'android', version: '1.2.3' });
    assert.equal(parseClientHeader('android-native-v0.5.1'), null);
  });
});

describe('system.cfg rendering', () => {
  const values = {
    SSID: 'CDA-NET-N2-D01',
    WPA2_PSK: 'psk${SSID}value',
    PPPOE_USER: 'rossi.mario@cda-net.it',
    PPPOE_PASSWORD: 'pppoe-pass',
    PPPOE_MTU: '1450',
    CPE_USERNAME: 'ubnt',
    CPE_PASSWORD_HASH: '$1$abc$def',
    HTTP_PORT: '20080',
    HTTPS_PORT: '20443',
    LAN_IP: '192.168.1.254',
  };

  it('substitutes placeholders once and enforces policy keys', () => {
    const out = renderSystemCfg(SAMPLE_TEMPLATE, {
      values,
      enforced: [
        ['snmp.location', 'ROSSI MARIO'],
        ['pwdog.host', '8.8.8.8'],
        ['radio.1.atpc.sta.status', 'enabled'],
      ],
    });
    assert.match(out, /^wireless\.1\.ssid=CDA-NET-N2-D01$/m);
    // a value containing ${...} must not be re-expanded
    assert.match(out, /^wpasupplicant\.profile\.1\.network\.1\.psk=psk\$\{SSID\}value$/m);
    assert.match(out, /^snmp\.location=ROSSI MARIO$/m);
    assert.match(out, /^pwdog\.host=8\.8\.8\.8$/m);
    assert.match(out, /^radio\.1\.atpc\.sta\.status=enabled$/m);
    assert.ok(out.endsWith('\n'));
    assert.ok(!out.includes('old-location'));
  });

  it('rejects missing values, multiline values and VLAN profiles', () => {
    assert.throws(() => renderSystemCfg(SAMPLE_TEMPLATE, { values: { ...values, LAN_IP: '' }, enforced: [] }), /missing_value_LAN_IP/);
    assert.throws(() => renderSystemCfg(SAMPLE_TEMPLATE, { values: { ...values, PPPOE_PASSWORD: 'a\nvlan.1.id=87' }, enforced: [] }), /invalid_value/);
    const vlan = `${SAMPLE_TEMPLATE}vlan.1.id=87\n`;
    assert.equal(inspectTemplate(vlan).ok, false);
    assert.ok(inspectTemplate(vlan).errors.includes('profile_contains_vlan'));
    assert.ok(inspectTemplate(`${SAMPLE_TEMPLATE}ppp.1.devname=ath0.87\n`).errors.includes('profile_contains_vlan'));
  });

  it('flags unknown placeholders and plaintext admin passwords', () => {
    const r = inspectTemplate(`${SAMPLE_TEMPLATE}foo=\${NOT_A_PLACEHOLDER}\n`);
    assert.deepEqual(r.unknownPlaceholders, ['NOT_A_PLACEHOLDER']);
    const p = inspectTemplate(SAMPLE_TEMPLATE.replace('${CPE_PASSWORD_HASH}', '${CPE_PASSWORD}'));
    assert.ok(p.errors.includes('users_password_requires_hash_placeholder'));
    assert.ok(inspectTemplate(SAMPLE_TEMPLATE).ok);
    assert.ok(inspectTemplate(SAMPLE_TEMPLATE.replace(/\n/g, '\r\n')).ok);
  });

  it('setKey replaces in place or appends', () => {
    assert.equal(setKey('a=1\nb=2\n', 'b', '3'), 'a=1\nb=3\n');
    assert.equal(setKey('a=1\n\n', 'c', '9'), 'a=1\nc=9\n');
  });
});

describe('routeros', () => {
  it('allows read-only commands and blocks modifications', () => {
    assert.equal(readonlyCommand(' /interface print detail '), '/interface print detail');
    assert.throws(() => readonlyCommand('/ip address add address=1.2.3.4/24'), /sola lettura/);
    assert.throws(() => readonlyCommand('/system reboot'), /sola lettura/);
    assert.throws(() => readonlyCommand('/interface print; /system reboot'), /Caratteri/);
    assert.throws(() => readonlyCommand('/system identity'), /lettura/);
    assert.throws(() => readonlyCommand('interface print'), /iniziare/);
  });

  it('redacts credentials (regression: v0.5.1 Web Bridge regex never matched)', () => {
    const out = redactRouterOs('name="ppp1" password=SuperSecret user=x\n wpa2-pre-shared-key="abc def" secret: s3cr3t');
    assert.ok(!out.includes('SuperSecret'));
    assert.ok(!out.includes('abc def'));
    assert.ok(!out.includes('s3cr3t'));
    assert.match(out, /password=\*\*\*REDACTED\*\*\*/);
  });

  it('parses resource output into a summary', () => {
    const s = summarize('  name: CDA-Core', '   uptime: 1w2d\n  version: 7.15.3 (stable)\n  board-name: CCR2004', 'model: CCR2004-1G\ncurrent-firmware: 7.15.3');
    assert.equal(s.identity, 'CDA-Core');
    assert.equal(s.version, '7.15.3 (stable)');
    assert.equal(s.boardName, 'CCR2004');
    assert.equal(s.currentFirmware, '7.15.3');
    assert.equal(parseKeyValues('a: 1\r\nb-c: two')['b-c'], 'two');
  });
});

describe('net', () => {
  it('classifies private ranges and bounds scans', () => {
    assert.ok(isPrivateIPv4('100.64.1.1'));
    assert.ok(isPrivateIPv4('172.31.0.29'));
    assert.ok(!isPrivateIPv4('8.8.8.8'));
    assert.deepEqual(parseScanCidr('192.168.1.77/24'), { prefix: 24, network: '192.168.1.0', first: ipInt('192.168.1.1'), last: ipInt('192.168.1.254') });
    assert.throws(() => parseScanCidr('10.0.0.0/16'), /troppo_ampio/);
    assert.throws(() => parseScanCidr('8.8.8.0/24'), /non_privata/);
  });

  it('round-trips SNMP OIDs and parses a GetResponse', () => {
    const oid = '1.3.6.1.2.1.1.5.0';
    assert.equal(decodeOid(encodeOid(oid)), oid);
    assert.equal(decodeOid(encodeOid('1.3.6.1.4.1.41112.1.4.5.1')), '1.3.6.1.4.1.41112.1.4.5.1');
    const req = buildGetRequest('public', [oid], 4242);
    assert.equal(req[0], 0x30);
    const vb = tlv(0x30, Buffer.concat([tlv(0x06, encodeOid(oid)), tlv(0x04, Buffer.from('cpe-rossi'))]));
    const pdu = tlv(0xa2, Buffer.concat([tlv(0x02, Buffer.from([0x10, 0x92])), tlv(0x02, Buffer.from([0])), tlv(0x02, Buffer.from([0])), tlv(0x30, vb)]));
    const msg = tlv(0x30, Buffer.concat([tlv(0x02, Buffer.from([1])), tlv(0x04, Buffer.from('public')), pdu]));
    const r = parseResponse(msg);
    assert.equal(r.requestId, 4242);
    assert.equal(r.values[oid], 'cpe-rossi');
  });
});

function ipInt(ip: string) {
  return ip.split('.').reduce((n, x) => ((n << 8) | Number(x)) >>> 0, 0);
}
