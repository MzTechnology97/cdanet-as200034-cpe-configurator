import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { autoTemplate } from '../src/domain/autotemplate.ts';
import { BOARD_MATCH_SUGGESTIONS } from '../src/domain/policy.ts';
import { inspectTemplate, renderSystemCfg } from '../src/domain/systemcfg.ts';
import { testApp } from './helpers.ts';

// Shape of an airOS 8 backup (System -> Back Up Configuration) of a lab CPE in Station + Router/PPPoE.
const BACKUP = [
  'aaa.1.status=disabled',
  'dhcpd.1.devname=eth0',
  'dhcpd.1.end=192.168.1.50',
  'dhcpd.1.lease_time=600',
  'dhcpd.1.netmask=255.255.255.0',
  'dhcpd.1.start=192.168.1.10',
  'dhcpd.1.status=enabled',
  'httpd.https.port=20443',
  'httpd.port=20080',
  'netconf.1.devname=eth0',
  'netconf.1.ip=192.168.1.254',
  'netconf.1.netmask=255.255.255.0',
  'netconf.2.devname=ath0',
  'netconf.2.ip=0.0.0.0',
  'ntpclient.1.server=10.0.0.254',
  'ppp.1.devname=ath0',
  'ppp.1.mru=1450',
  'ppp.1.mtu=1450',
  'ppp.1.name=lab.test@cda-net.it',
  'ppp.1.password=LabPppoePass',
  'pwdog.host=8.8.8.8',
  'radio.1.mode=managed',
  'radio.1.countrycode=511',
  'resolv.host.1.name=LAB TEST',
  'snmp.community=public',
  'snmp.contact=172.31.0.7',
  'snmp.location=LAB TEST',
  'sshd.port=22',
  'unms.uri=wss://uisp.cda-net.it:443+AbCdEf0123456789+allowUntrustedCertificate',
  'users.1.name=cdaadmin',
  'users.1.password=$1$abcdefgh$M55TzYaaccxVGbptZWaxX/',
  'wireless.1.ssid=CDA-NET-N2-D01',
  'wpasupplicant.profile.1.network.1.psk=LabWpaKey123',
  'wpasupplicant.profile.1.network.1.ssid=CDA-NET-N2-D01',
  '',
].join('\r\n');

describe('autoTemplate', () => {
  it('replaces per-customer values and keeps the rest of the lab configuration', () => {
    const r = autoTemplate(BACKUP);
    const t = r.template;
    for (const line of [
      'wireless.1.ssid=${SSID}',
      'wpasupplicant.profile.1.network.1.ssid=${SSID}',
      'wpasupplicant.profile.1.network.1.psk=${WPA2_PSK}',
      'ppp.1.name=${PPPOE_USER}',
      'ppp.1.password=${PPPOE_PASSWORD}',
      'ppp.1.mtu=${PPPOE_MTU}',
      'users.1.name=${CPE_USERNAME}',
      'users.1.password=${CPE_PASSWORD_HASH}',
      'unms.uri=${UISP_ENROLLMENT}',
      'resolv.host.1.name=${DEVICE_NAME}',
      'netconf.1.ip=${LAN_IP}',
      'netconf.1.netmask=${LAN_NETMASK}',
      'httpd.https.port=${HTTPS_PORT}',
      'dhcpd.1.start=${DHCP_START}',
      'ntpclient.1.server=${NTP_SERVER}',
    ]) {
      assert.ok(t.split('\n').includes(line), line);
    }
    // untouched lab settings
    assert.ok(t.includes('radio.1.countrycode=511'));
    assert.ok(t.includes('netconf.2.ip=0.0.0.0'));
    assert.ok(!t.includes('\r'));
    assert.equal(r.lanInterface, 'eth0');
    assert.deepEqual(r.warnings, []);
    // secrets are never echoed in the preview
    const preview = JSON.stringify(r.replacements);
    for (const s of ['LabPppoePass', 'LabWpaKey123', 'AbCdEf0123456789', '$1$abcdefgh']) assert.ok(!preview.includes(s), s);
    assert.ok(!t.includes('LabPppoePass') && !t.includes('LabWpaKey123') && !t.includes('AbCdEf0123456789'));
  });

  it('produces a valid template that renders', () => {
    const { template } = autoTemplate(BACKUP);
    const report = inspectTemplate(template);
    assert.equal(report.ok, true, report.errors.join());
    const values = Object.fromEntries(report.placeholders.map((p) => [p, `v-${p}`]));
    const out = renderSystemCfg(template, { values, enforced: [] });
    assert.ok(out.includes('ppp.1.password=v-PPPOE_PASSWORD'));
  });

  it('is idempotent and reports what it could not find', () => {
    const once = autoTemplate(BACKUP).template;
    assert.equal(autoTemplate(once).template, once);
    const partial = autoTemplate('radio.1.mode=managed\nwireless.1.ssid=X\nnetconf.1.devname=eth0\n'.repeat(3));
    assert.ok(partial.warnings.some((w) => w.includes('PPPoE')));
    assert.ok(partial.warnings.some((w) => w.includes('LAN')));
  });

  it('board match suggestions distinguish NanoStation and Loco', () => {
    const loco = new RegExp(BOARD_MATCH_SUGGESTIONS['NanoStation Loco 5AC'], 'is');
    const ns = new RegExp(BOARD_MATCH_SUGGESTIONS['NanoStation 5AC'], 'is');
    assert.ok(loco.test('board.name=NanoStation 5AC loco'));
    assert.ok(!loco.test('board.name=NanoStation 5AC'));
    assert.ok(ns.test('board.name=NanoStation 5AC\nboard.shortname=NS'));
    assert.ok(!ns.test('board.name=NanoStation 5AC loco'));
  });
});

describe('POST /api/admin/profiles/:model/autotemplate', () => {
  it('returns template, masked preview, report and suggested board match', async () => {
    const t = await testApp();
    const token = await t.login();
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/admin/profiles/LiteBeam%205AC/autotemplate',
      headers: t.auth(token),
      payload: { backup: BACKUP },
    });
    assert.equal(r.statusCode, 200, r.body);
    const body = r.json();
    assert.equal(body.report.ok, true);
    assert.equal(body.suggestedBoardMatch, 'board\\.name=LiteBeam 5AC');
    assert.ok(body.replacements.length >= 15);
    assert.ok(!r.body.includes('LabWpaKey123'));
    // nothing stored until the admin confirms with PUT
    const list = (await t.app.inject({ method: 'GET', url: '/api/admin/profiles', headers: t.auth(token) })).json();
    assert.deepEqual(list.find((p: { model: string }) => p.model === 'LiteBeam 5AC').templates, []);
    await t.app.close();
  });
});
