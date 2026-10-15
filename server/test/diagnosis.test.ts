import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { todayRome } from '../src/routes/work-orders.ts';
import { diagnose, type Facts } from '../src/services/diagnosis.ts';
import { testApp } from './helpers.ts';

const T = { signalMin: -75, signalDropDb: 6, ethMinMbps: 100 };
/** A healthy line; each case changes only what it needs. */
const base = (): Facts => ({
  cpe: { found: true, online: true, signal: -60, ethMbps: 1000, ethHalfDuplex: false, lastSeen: '2026-10-15T10:00:00Z', outagesWeek: 0, offlineMinWeek: 0 },
  signal: { acceptance: -59, monthAvg: -60, trend: 0 },
  pppoe: { status: 'Attivo', suspended: false, servicesSuspended: false, online: true },
  ap: { name: 'N2-D01', online: true, cpeTotal: 10, cpeOffline: 0 },
  power: { nearAp: null, nearCustomer: null, popBattery: null },
  speed: { downMbps: 28, upMbps: 6, passed: true, at: '2026-10-14T10:00:00Z' },
});
const codes = (f: Facts) => diagnose(f, T).map((x) => x.code);

describe('Diagnosi a distanza', () => {
  it('finds the probable cause of a fault, worst first', () => {
    assert.deepEqual(codes(base()), ['network_ok'], 'all fine: the customer’s Wi-Fi or devices');

    const suspended = base();
    suspended.pppoe!.servicesSuspended = true;
    assert.equal(codes(suspended)[0], 'suspended');

    const apDown = base();
    apDown.ap!.online = false;
    apDown.cpe!.online = false;
    assert.deepEqual(codes(apDown), ['ap_down'], 'the CPE is off because of the AP: not a visit to the customer');

    const sector = base();
    sector.ap!.cpeOffline = 4;
    assert.equal(codes(sector)[0], 'sector_down');

    const off = base();
    off.cpe!.online = false;
    assert.equal(codes(off)[0], 'cpe_off');
    off.power.nearCustomer = { place: 'CONTRADA DEMO', distanceM: 400 };
    assert.equal(codes(off)[0], 'power_customer', 'an Enel outage near the customer explains it');

    const powerAp = base();
    powerAp.power.nearAp = { place: 'BORGO DEMO', kind: 'guasto_mt' };
    powerAp.power.popBattery = { soc: 27, batteryState: 'discharging', status: 'warn' };
    const p = diagnose(powerAp, T).find((x) => x.code === 'power_ap')!;
    assert.equal(p.level, 'info', 'AP and CPE working: only to keep an eye on');
    assert.match(p.detail, /27%, in scarica/);
    powerAp.cpe!.online = false;
    assert.equal(diagnose(powerAp, T).find((x) => x.code === 'power_ap')!.level, 'warn');
    powerAp.ap!.online = false;
    assert.equal(diagnose(powerAp, T)[0]!.code, 'ap_down');
    assert.equal(diagnose(powerAp, T).find((x) => x.code === 'power_ap')!.level, 'bad', 'the network is down: that is the cause');

    const cable = base();
    cable.cpe!.ethMbps = 10;
    assert.ok(codes(cable).includes('lan_cable'));

    const ppp = base();
    ppp.pppoe!.online = false;
    assert.ok(codes(ppp).includes('pppoe_down'));

    const low = base();
    low.cpe!.signal = -80;
    assert.equal(codes(low)[0], 'signal_low');

    const drop = base();
    drop.cpe!.signal = -67;
    const d = diagnose(drop, T).find((x) => x.code === 'signal_drop')!;
    assert.match(d.detail, /8 dB in meno rispetto al collaudo \(-59 → -67 dBm\)/);
    const trend = base();
    trend.signal.trend = -7;
    assert.ok(codes(trend).includes('signal_drop'), 'or a month going down');

    const flapping = base();
    flapping.cpe!.outagesWeek = 6;
    flapping.cpe!.offlineMinWeek = 95;
    assert.ok(codes(flapping).includes('flapping'));

    const slow = base();
    slow.speed!.passed = false;
    assert.deepEqual(codes(slow), ['speed_low', 'network_ok'], 'a slow speedtest alone is not a fault of the network');

    assert.deepEqual(codes({ ...base(), cpe: null }), ['cpe_unknown', 'network_ok']);
    for (const f of [base(), off, powerAp, suspended]) for (const x of diagnose(f, T)) assert.ok(!/UISP|ISP ?Billing|Victron|e-distribuzione|RADIUS/i.test(`${x.title} ${x.detail} ${x.action}`), 'never a data source: installers read it');
  });

  it('the NOC diagnoses any line, an installer only the work orders assigned to them', async () => {
    const t = await testApp();
    const A = t.auth(await t.login());
    const get = (url: string, headers = A) => t.app.inject({ method: 'GET', url, headers });
    await t.app.inject({ method: 'POST', url: '/api/admin/users', headers: A, payload: { username: 'tecnico', password: 'Installer-Pass-123' } });
    await t.app.inject({ method: 'POST', url: '/api/admin/users', headers: A, payload: { username: 'altro', password: 'Installer-Pass-456' } });
    const users = (await get('/api/admin/users')).json() as Array<{ id: number; username: string }>;
    const tid = users.find((u) => u.username === 'tecnico')!.id;
    const o = (await t.app.inject({ method: 'POST', url: '/api/admin/work-orders', headers: A, payload: { assignedTo: tid, day: todayRome(), kind: 'repair', customer: 'Rossi Mario', pppoeUser: 'rossi@cda-net.it' } })).json().item;

    assert.equal((await get('/api/admin/diagnosis')).statusCode, 400);
    assert.equal((await get('/api/admin/diagnosis?workOrderId=99999')).statusCode, 404);
    const r = await get(`/api/admin/diagnosis?workOrderId=${o.id}`);
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().subject.customer, 'Rossi Mario');
    assert.ok(r.json().findings.length >= 1);
    assert.equal(r.json().verdict, r.json().findings[0].title);

    const mine = await get(`/api/field/diagnosis?workOrderId=${o.id}`, t.auth(await t.login('tecnico', 'Installer-Pass-123')));
    assert.equal(mine.statusCode, 200, mine.body);
    assert.ok(!('facts' in mine.json()) && !('subject' in mine.json()), 'the essentials only');
    assert.equal((await get(`/api/field/diagnosis?workOrderId=${o.id}`, t.auth(await t.login('altro', 'Installer-Pass-456')))).statusCode, 403);
    assert.equal((await get(`/api/admin/diagnosis?workOrderId=${o.id}`, t.auth(await t.login('tecnico', 'Installer-Pass-123')))).statusCode, 403);
    await t.app.close();
  });
});
