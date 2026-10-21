import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { applyForm, parseKeys, policyWarnings, readForm, skeletonFor } from '../src/domain/airos-form.ts';
import { DEFAULT_PARAMS as DEFAULT_FORM_PARAMS } from '../src/services/templates.ts';
import { buildApp } from '../src/app.ts';
import { createSealer, sha256Hex } from '../src/crypto.ts';
import { openDatabase } from '../src/db.ts';
import { renderSystemCfg } from '../src/domain/systemcfg.ts';
import { GOLDEN_ENV, GOLDEN_JOB } from './golden-env.ts';
import { ADMIN, testApp, testConfig } from './helpers.ts';

const LEGACY = readFileSync(new URL('./fixtures/legacy-template.cfg', import.meta.url), 'utf8');
// produced by v1.35.10 (server-wide values) from the same template and the same job
const GOLDEN = readFileSync(new URL('./fixtures/legacy-template.v1.35.10.out', import.meta.url), 'utf8');
const ANDROID = { 'x-cda-client': 'android/1.35.11' };

describe('Template airOS: conversione dei template salvati prima della v1.35.11', () => {
  it('gives each template the server values once, and the configuration stays the same byte for byte', async () => {
    const cfg = testConfig(GOLDEN_ENV);
    const db = openDatabase(':memory:');
    const sealer = createSealer(cfg.masterKey);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO profile_templates(model, firmware, name, board_match, template_ciphertext, template_sha256, is_default, created_at, updated_at)
       VALUES('NanoStation Loco 5AC', '8.7.4', 'Standard', 'board\\.name=NanoStation', ?, ?, 1, ?, ?)`,
    ).run(sealer.seal(LEGACY), sha256Hex(LEGACY), now, now);

    const { app, ctx } = await buildApp(cfg, 'test', { db, logger: false, uisp: null });
    const tpl = ctx.templates.resolve('NanoStation Loco 5AC', undefined, { id: 1, role: 'admin' })!;
    const text = sealer.open(tpl.ciphertext);
    assert.ok(!/\$\{(LAN_IP|DHCP_START|PPPOE_MTU|HTTP_PORT|SSH_PORT|SNMP_CONTACT|WATCHDOG_HOST|NTP_SERVER|DISCOVERY_PORT)\}/.test(text), 'no server-wide placeholder left');
    assert.ok(text.includes('board.info    0000600'), 'the line of the .tar import stays as it was (no silent clean-up)');
    assert.deepEqual(tpl.params, { watchdogHost: '9.9.9.9', snmpContact: 'noc-di-prova' });
    assert.equal(tpl.secrets.snmpCommunity, 'community-di-prova');

    // the job of v1.35.10 rendered now: the same bytes
    const { values, name } = ctx.provisioning.jobValues(GOLDEN_JOB, 'chiave-wpa-di-prova', tpl.secrets);
    values.CPE_PASSWORD_HASH = '$1$golden$hash';
    const now2 = renderSystemCfg(text, { values, enforced: ctx.provisioning.enforcedKeys(name, { latitude: 37.5668, longitude: 14.2808 }, tpl) });
    assert.equal(now2, GOLDEN);

    // in the activity log, once; a second start converts nothing
    const ev = db.prepare("SELECT action, target FROM events WHERE action LIKE 'template.convert%'").all() as Array<{ action: string; target: string }>;
    assert.deepEqual(ev.map((e) => ({ ...e })), [{ action: 'template.convert', target: 'NanoStation Loco 5AC · Standard' }]);
    await app.close();
    const again = await buildApp(testConfig(GOLDEN_ENV), 'test', { db, logger: false, uisp: null }).catch(() => null);
    assert.equal((db.prepare("SELECT count(*) n FROM events WHERE action LIKE 'template.convert%'").get() as { n: number }).n, 1);
    await again?.app.close();
  });
});

describe('Template airOS dal modulo', () => {
  it('reads and writes real keys; an unchanged form leaves the text as it is', () => {
    const base = skeletonFor('LiteBeam 5AC');
    const { values, missing } = readForm(base, DEFAULT_FORM_PARAMS, 'LiteBeam 5AC');
    // not in an export until set (scan list, remote syslog; gateway and DNS of a bridge): shown with their default
    assert.deepEqual(missing, ['scanFrom', 'scanTo', 'gateway', 'dns1', 'dns2', 'syslogHost']);
    assert.equal(values.wirelessMode, 'station');
    assert.equal(values.antennaGain, 23);
    assert.equal(values.lanIp, '192.168.1.254');
    assert.equal(values.dfs, false);
    assert.deepEqual(policyWarnings(values), []);

    // the same values again: not a byte changes
    assert.equal(applyForm(base, DEFAULT_FORM_PARAMS, 'LiteBeam 5AC', values).text, base);

    const out = applyForm(base, DEFAULT_FORM_PARAMS, 'LiteBeam 5AC', {
      wirelessMode: 'ap',
      ptp: 'ptp',
      frequency: 5500,
      lanIp: '10.10.10.1',
      dfs: true,
      countryCode: 380,
      watchdogHost: '1.1.1.1',
    });
    const k = parseKeys(out.text);
    assert.equal(k.get('radio.1.mode'), 'master');
    assert.equal(k.get('aaa.1.ssid'), '${SSID}');
    assert.equal(k.get('wpasupplicant.status'), 'disabled');
    assert.equal(k.get('radio.1.ptpmode'), '1');
    assert.equal(k.get('radio.1.freq'), '5500');
    assert.equal(k.get('netconf.2.ip'), '10.10.10.1');
    assert.equal(k.get('radio.countrycode'), '380');
    assert.equal(out.params.watchdogHost, '1.1.1.1');
    const after = readForm(out.text, out.params, 'LiteBeam 5AC').values;
    assert.deepEqual(policyWarnings(after).map((w) => w.field).sort(), ['countryCode', 'dfs']);

    assert.throws(() => applyForm(base, DEFAULT_FORM_PARAMS, 'LiteBeam 5AC', { lanIp: '999.1.1.1' }), /form_invalid_lanIp/);
    assert.throws(() => applyForm(base, DEFAULT_FORM_PARAMS, 'LiteBeam 5AC', { timezone: 'a\nvlan.1.id=87' }), /form_invalid_timezone/);
    assert.throws(() => applyForm(base, DEFAULT_FORM_PARAMS, 'LiteBeam 5AC', { ntpServer: '${UISP_ENROLLMENT}' }), /form_invalid_ntpServer/);
  });

  it('a template made from the form: its own values and secrets in the job, secrets never returned', async () => {
    const t = await testApp();
    const A = t.auth(await t.login(ADMIN.username, ADMIN.password));
    const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: object, headers: Record<string, string> = A) => t.app.inject({ method, url, headers, payload });

    const fields = (await call('GET', '/api/admin/template-form')).json().fields as Array<{ id: string; fallback: unknown }>;
    assert.deepEqual(fields.find((f) => f.id === 'antennaGain')!.fallback, { 'NanoStation Loco 5AC': 13, 'NanoStation 5AC': 16, 'NanoBeam 5AC': 19, 'LiteBeam 5AC': 23, 'PowerBeam 5AC': 25 });

    const draft = (await call('POST', '/api/admin/profiles/LiteBeam%205AC/form/read', {})).json();
    assert.equal(draft.report.ok, true, JSON.stringify(draft.report));
    const edited = (await call('POST', '/api/admin/profiles/LiteBeam%205AC/form/apply', { template: draft.template, params: draft.params, changes: { lanIp: '192.168.50.1', snmpContact: 'noc-lb' } })).json();
    assert.equal(edited.values.lanIp, '192.168.50.1');
    assert.equal((await call('POST', '/api/admin/profiles/LiteBeam%205AC/form/apply', { template: draft.template, changes: { sshPort: 0 } })).json().error, 'form_invalid_sshPort');

    // a server-wide placeholder of before is refused: the template has its own value now
    const old = await call('POST', '/api/admin/profiles/LiteBeam%205AC/templates', { name: 'Vecchio', template: `${draft.template}ntpclient.1.server=\${NTP_SERVER}\n`, boardMatch: 'board\\.name=LiteBeam' });
    assert.equal(old.json().error, 'retired_placeholders');

    const made = await call('POST', '/api/admin/profiles/LiteBeam%205AC/templates', {
      name: 'Standard',
      template: edited.template,
      params: edited.params,
      boardMatch: 'board\\.name=LiteBeam',
      secrets: { snmpCommunity: 'segreta-snmp-lb', uispKey: 'wss://uisp.example:443+chiave-lb+allowUntrustedCertificate' },
    });
    assert.equal(made.statusCode, 201, made.body);
    const id = made.json().id as number;
    const got = await call('GET', `/api/admin/templates/${id}`);
    const list = await call('GET', '/api/admin/profiles');
    for (const r of [made, got, list]) assert.ok(!r.body.includes('segreta-snmp-lb') && !r.body.includes('chiave-lb'), 'secrets never returned');
    assert.deepEqual(got.json().secretsSet, { snmpCommunity: true, uispKey: true });
    assert.equal(got.json().facts.lanIp, '192.168.50.1');
    assert.equal(got.json().params.snmpContact, 'noc-lb');

    // a copy keeps the secrets without the console ever seeing them
    const copy = await call('POST', '/api/admin/profiles/LiteBeam%205AC/templates', { name: 'Copia', template: edited.template, params: edited.params, boardMatch: 'board\\.name=LiteBeam', secretsFrom: id });
    assert.deepEqual(copy.json().secretsSet, { snmpCommunity: true, uispKey: true });
    // removing the UISP key, leaving the community as it is
    const patched = await call('PATCH', `/api/admin/templates/${copy.json().id}`, { secrets: { uispKey: null } });
    assert.deepEqual(patched.json().secretsSet, { snmpCommunity: true, uispKey: false });
    const log = JSON.stringify(t.db.prepare("SELECT * FROM events WHERE action LIKE 'template.%'").all());
    assert.ok(!log.includes('segreta-snmp-lb') && !log.includes('chiave-lb'), 'never in the activity log');

    // a job: the template's community, UISP key, contact and LAN address
    await call('PUT', '/api/admin/wireless-networks/CDA-NET-N2-D01', { wpa2Password: 'test-psk-12345' });
    await call('POST', '/api/admin/users', { username: 'tecnico', password: 'Installer-Pass-123' });
    const T = t.auth(await t.login('tecnico', 'Installer-Pass-123'), ANDROID);
    const job = await call(
      'POST',
      '/api/provisioning/jobs',
      { model: 'LiteBeam 5AC', mac: '24:A4:3C:11:22:33', serial: 'X1', ssid: 'CDA-NET-N2-D01', pppoeUser: 'rossi.mario@cda-net.it', pppoePassword: 'x', templateId: id },
      T,
    );
    assert.equal(job.statusCode, 201, job.body);
    const text = job.json().config.text as string;
    assert.match(text, /^snmp\.community=segreta-snmp-lb$/m);
    assert.match(text, /^snmp\.contact=noc-lb$/m);
    assert.match(text, /^unms\.uri=wss:\/\/uisp\.example:443\+chiave-lb\+allowUntrustedCertificate$/m);
    assert.match(text, /^netconf\.2\.ip=192\.168\.50\.1$/m);
    assert.equal(job.json().afterApply.lanIp, '192.168.50.1');
    await t.app.close();
  });
});

describe('Template airOS: gateway e DNS in bridge (Carmelo, 21/10/2026)', () => {
  it('a bridge with a fixed address gets its gateway and DNS, with the keys of airOS 8', async () => {
    const { inspectFreeTemplate, askedFor, renderFreeCfg } = await import('../src/domain/specialist-cfg.ts');
    const params = { ...DEFAULT_FORM_PARAMS };
    const base = skeletonFor('LiteBeam 5AC');
    // CDA Net's template: values written in the text, empty = no gateway
    const cda = applyForm(base, params, 'LiteBeam 5AC', { netMode: 'bridge', lanIp: '192.168.10.5', gateway: '192.168.10.1', dns1: '9.9.9.9', dns2: '' }).text;
    const k = parseKeys(cda);
    assert.deepEqual(
      ['route.status', 'route.1.status', 'route.1.devname', 'route.1.ip', 'route.1.netmask', 'route.1.gateway'].map((x) => k.get(x)),
      ['enabled', 'enabled', 'br0', '0.0.0.0', '0', '192.168.10.1'],
    );
    assert.deepEqual([k.get('resolv.nameserver.status'), k.get('resolv.nameserver.1.ip'), k.get('resolv.nameserver.2.status')], ['enabled', '9.9.9.9', 'disabled']);
    const read = readForm(cda, params, 'LiteBeam 5AC').values;
    assert.deepEqual([read.gateway, read.dns1, read.dns2], ['192.168.10.1', '9.9.9.9', '']);
    const none = parseKeys(applyForm(cda, params, 'LiteBeam 5AC', { gateway: '' }).text);
    assert.deepEqual([none.get('route.status'), none.get('route.1.status')], ['disabled', 'disabled']);
    assert.throws(() => applyForm(base, params, 'LiteBeam 5AC', { netMode: 'bridge', gateway: '192.168.10' }), /form_invalid_gateway/);

    // the specialist's template: empty = typed for each CPE in the flow (${GATEWAY})
    const free = applyForm(base, params, 'LiteBeam 5AC', { netMode: 'bridge', gateway: '' }, { free: true }).text;
    assert.equal(parseKeys(free).get('route.1.gateway'), '${GATEWAY}');
    assert.equal(readForm(free, params, 'LiteBeam 5AC', { free: true }).values.gateway, '');
    const report = inspectFreeTemplate(free);
    assert.ok(report.placeholders.includes('GATEWAY'), JSON.stringify(report.placeholders));
    const asked = askedFor(report.placeholders, { snmpCommunity: true, uispKey: true }).find((x) => x.name === 'GATEWAY');
    assert.deepEqual([asked?.label, asked?.secret], ['Gateway della CPE (IP)', false], 'asked for each CPE, with its name');
    const fixed = applyForm(free, params, 'LiteBeam 5AC', { gateway: '10.20.30.1' }, { free: true }).text;
    assert.equal(parseKeys(fixed).get('route.1.gateway'), '10.20.30.1');
    assert.ok(!inspectFreeTemplate(fixed).placeholders.includes('GATEWAY'), 'a fixed one is not asked');
    assert.ok(renderFreeCfg.length >= 2);
  });
});
