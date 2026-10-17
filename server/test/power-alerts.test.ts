import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openDatabase } from '../src/db.ts';
import { createProactiveAlerts, POWER_CALM_MS, POWER_STABLE_MS, powerStep, type PopAlertState } from '../src/services/proactive-alerts.ts';

const MIN = 60_000;
const T0 = Date.parse('2026-10-16T16:00:00Z');
const LIMITS = { lowHours: 2, criticalSoc: 20 };

type Check = [minute: number, soc: number, batteryState: string | null, offGrid?: boolean];

/** The checks of one POP, every few minutes as the service does them: what is said at each one. */
function run(checks: Check[], start?: PopAlertState) {
  let s = start;
  const says = checks.map(([m, soc, batteryState, offGrid = false]) => {
    const r = powerStep(s, { soc, batteryState, offGrid }, T0 + m * MIN, LIMITS);
    s = r.next;
    return r.say;
  });
  return { says, state: s };
}

describe('Avvisi delle batterie dei POP', () => {
  it('a normal night on battery says nothing; a critical battery is said once', () => {
    assert.equal(POWER_STABLE_MS, 15 * MIN);
    assert.equal(POWER_CALM_MS, 120 * MIN);
    const night = run(Array.from({ length: 13 }, (_, i): Check => [i * 5, 90 - i * 0.5, 'discharging']));
    assert.deepEqual(night.says, Array(13).fill(null));

    // 2% every 5 minutes from 30%: under 2 hours of autonomy at the fifth check
    const outage = run([
      [0, 30, 'discharging'],
      [5, 28, 'discharging'],
      [10, 26, 'discharging'],
      [15, 24, 'discharging'],
      [20, 22, 'discharging'],
      [25, 20, 'discharging'],
      [30, 18, 'discharging'],
    ]);
    assert.deepEqual(outage.says, [null, null, null, null, 'critical', null, null]);
    assert.equal(outage.state?.critical, true);

    // under the critical charge even before the autonomy can be estimated
    assert.deepEqual(run([[0, 19, 'discharging']]).says, ['critical']);
  });

  it('the power is back once the charge has lasted a quarter of an hour; then 2 hours of calm', () => {
    const { state: critical } = run([[0, 19, 'discharging']]);
    const r = run(
      [
        [5, 19, 'charging'],
        [10, 19, 'discharging'],
        [15, 19, 'charging'],
        [20, 20, 'charging'],
        [25, 20, 'charging'],
        [30, 21, 'charging'],
        [35, 18, 'discharging'],
        [100, 17, 'discharging'],
        [155, 16, 'discharging'],
      ],
      critical,
    );
    // a swing at sunrise is not the power back; 15 minutes of charge are; no new alert for 2 hours
    assert.deepEqual(r.says, [null, null, null, null, null, 'back', null, null, 'critical']);
  });

  it('an off-grid POP discharging every night is not news', () => {
    const r = run(Array.from({ length: 13 }, (_, i): Check => [i * 5, 30 - i, 'discharging', true]));
    assert.deepEqual(r.says, Array(13).fill(null));
  });

  it('keeps what was said in the database: an update of the server does not repeat it', async () => {
    const db = openDatabase(':memory:');
    const said: string[] = [];
    type Pop = { status: string; soc: number | null; batteryState: string | null; offGrid: boolean };
    let pops = new Map<string, Pop>();
    const ctx = {
      db,
      cfg: { proactive: { apBusyPct: 80, popLowHours: 2, popCriticalSoc: 20 } },
      victronSync: { byPop: () => pops },
      uisp: { sites: async () => [{ id: 'pop1', name: 'Demo Monte' }, { id: 'pop2', name: 'Demo Valle' }] },
      notify: { proactive: (title: string) => void said.push(title) },
    } as never;
    const stored = () => {
      const r = db.prepare("SELECT value FROM settings WHERE key = 'alerts.power'").get() as { value: string } | undefined;
      return r ? (JSON.parse(r.value) as Record<string, PopAlertState>) : {};
    };
    const real = Date.now;
    let now = T0;
    Date.now = () => now;
    try {
      let alerts = createProactiveAlerts(ctx);
      const check = async (minutes: number, soc: number, batteryState: string) => {
        now += minutes * MIN;
        pops = new Map([['pop1', { status: 'warn', soc, batteryState, offGrid: false }]]);
        await alerts.power();
      };
      await check(0, 19, 'discharging');
      assert.deepEqual(said, ['⚠️ POP Demo Monte: batteria critica']);
      assert.equal(stored().pop1?.critical, true);

      // the server is updated while the battery is still critical: a new process, the same database
      alerts = createProactiveAlerts(ctx);
      for (const soc of [18, 17, 16]) await check(5, soc, 'discharging');
      assert.equal(said.length, 1, 'nothing again after the restart');

      for (let i = 0; i < 3; i++) await check(5, 16, 'charging');
      assert.equal(said.length, 1, 'charging for 10 minutes is not the power back yet');
      // another update while charging: the quarter of an hour counts from before it
      alerts = createProactiveAlerts(ctx);
      await check(5, 17, 'charging');
      assert.deepEqual(said, ['⚠️ POP Demo Monte: batteria critica', '✅ POP Demo Monte: di nuovo in carica']);

      // and the 2 hours of calm survive an update too
      alerts = createProactiveAlerts(ctx);
      await check(30, 15, 'discharging');
      assert.equal(said.length, 2, 'no new alert within 2 hours of the recovery');

      // a POP without a battery system linked any more is forgotten
      pops = new Map([
        ['pop1', { status: 'ok', soc: 57, batteryState: 'charging', offGrid: false }],
        ['pop2', { status: 'ok', soc: 80, batteryState: 'idle', offGrid: false }],
      ]);
      await alerts.power();
      assert.deepEqual(Object.keys(stored()).sort(), ['pop1', 'pop2']);
      pops = new Map([['pop2', { status: 'ok', soc: 80, batteryState: 'idle', offGrid: false }]]);
      await alerts.power();
      assert.deepEqual(Object.keys(stored()), ['pop2']);

      // a broken saved value starts over instead of stopping the alerts
      db.prepare("UPDATE settings SET value = '{not json' WHERE key = 'alerts.power'").run();
      await alerts.power();
      assert.deepEqual(Object.keys(stored()), ['pop2']);
    } finally {
      Date.now = real;
      db.close();
    }
  });
});
