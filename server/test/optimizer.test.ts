import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import type { AppContext } from '../src/context.ts';
import { channelCandidates, type AdvisorInput, type Finding } from '../src/domain/advisor.ts';
import { channelOf, compareLinks, configWithChannel, configWithOriginal, cpeFollows, ieeeModeFor, linkSamples } from '../src/domain/optimizer.ts';
import { createOptimizer, nextNightWindow, type Run } from '../src/services/ap-optimizer.ts';

const SECRET = 'chiave-segreta-di-prova';
/** airMAX wireless configuration of a fake AP on [centre]/[width] (shape read from UISP 3.1.65). */
const apConfig = (centre: number, width: number) => ({
  mode: 'ap-ptmp-airmax-mixed',
  boardInfo: { radio1: { channelWidthList: [10, 20, 30, 40, 50, 60, 80] } },
  regulatoryDomainChannels: [20, 40].flatMap((w) => Array.from({ length: 160 }, (_, i) => ({ controlFrequency: 5100 + i * 5 - (w === 40 ? 10 : 0), centerFrequency: 5100 + i * 5, channelWidth: w, isDFS: false }))),
  securityConfig: { presharedKey: SECRET },
  countryCode: 511,
  allowedFrequencies: [],
  channelWidth: width,
  ieeeModeString: `11acvht${width}`,
  centerFrequency: centre,
  controlFrequency: centre,
  isAutoChannelWidthEnabled: false,
});
const station = (i: number, cap: number, signal = -60) => ({ connected: true, mac: `AA:BB:CC:00:00:0${i}`, rxSignal: signal, noiseFloor: -92, downlinkCapacity: cap * 1e6, rxMcsIndex: 8, txMcsIndex: 8, deviceIdentification: { id: `cpe-${i}`, name: `Cliente ${i}` } });

/**
 * A fake UISP: the AP keeps the channel written to it; [world] says which stations it has on each
 * channel. Every write is recorded.
 */
function fakeUisp(world: (centre: number, width: number) => unknown[], cpeAllowed: number[] = []) {
  let cfg: Record<string, unknown> = apConfig(5500, 40);
  const writes: Array<{ centre: number; width: number; key: unknown; control: unknown; mode: unknown }> = [];
  return {
    writes,
    uisp: {
      async airmaxWireless(id: string) {
        return id === 'ap-1' ? structuredClone(cfg) : { allowedFrequencies: cpeAllowed, securityConfig: { presharedKey: SECRET } };
      },
      async setAirmaxWireless(_id: string, body: Record<string, unknown>) {
        cfg = structuredClone(body);
        writes.push({ centre: body.centerFrequency as number, width: body.channelWidth as number, key: (body.securityConfig as { presharedKey: string }).presharedKey, control: body.controlFrequency, mode: body.ieeeModeString });
      },
      async apStations() {
        return world(cfg.centerFrequency as number, cfg.channelWidth as number);
      },
    },
  };
}

const finding = (params: Record<string, number>): Finding => ({ id: 'channel:ap-1', severity: 'info', kind: 'channel', apId: 'ap-1', apName: 'N1-D01', title: 'Canale più libero', detail: '', action: '', params });

function setup(world: (c: number, w: number) => unknown[], o: { params?: Record<string, number>; enabled?: boolean; inputs?: AdvisorInput[]; cpeAllowed?: number[]; onSleep?: () => void } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT, updated_by INTEGER)');
  const fake = fakeUisp(world, o.cpeAllowed);
  const sent: Array<{ kind: string; title: string; lines: string[] }> = [];
  const ctx = {
    db,
    uisp: fake.uisp,
    cfg: { advisorAutoOptimize: o.enabled ?? true, thresholds: { signalMin: -75 } },
    notify: { inbox: { push: (_a: string, m: { kind: string; title: string; lines: string[] }) => sent.push(m) } },
    advisor: { finding: () => finding(o.params ?? { frequenza: 5300, ampiezza: 40 }), inputs: () => o.inputs ?? [], range: () => ({ from: 5120, to: 5800 }) },
  } as unknown as AppContext;
  const opt = createOptimizer(ctx, { timing: { pollMs: 1, reassocMs: 5, settleMs: 1, samples: 2, sampleGapMs: 1 }, sleep: async () => o.onSleep?.() });
  const runOf = (id: string) => opt.view().runs.find((r) => r.id === id)!;
  return { opt, fake, sent, db, runOf };
}
const three = (cap: number) => [station(1, cap), station(2, cap), station(3, cap, -70)];

describe('IA-AP ottimizzazione: configurazione e confronto', () => {
  it('changes only the channel of the configuration, from the radio table', () => {
    const c = configWithChannel(apConfig(5500, 20), 5300, 40);
    assert.deepEqual([c.centerFrequency, c.controlFrequency, c.channelWidth, c.ieeeModeString], [5300, 5290, 40, '11acvht40']);
    assert.equal((c.securityConfig as { presharedKey: string }).presharedKey, SECRET, 'the rest is written back as read');
    assert.throws(() => configWithChannel(apConfig(5500, 20), 5300, 25), /non supportata/);
    assert.throws(() => configWithChannel(apConfig(5500, 20), 6100, 20), /non presente/);
    const orig = channelOf(apConfig(5500, 20))!;
    assert.deepEqual(orig, { centre: 5500, width: 20, control: 5500, ieeeMode: '11acvht20' });
    assert.equal(configWithOriginal(c, orig).ieeeModeString, '11acvht20');
    assert.equal(ieeeModeFor('11acvht20', 80), '11acvht80');
    assert.equal(ieeeModeFor('11na', 40), '11na');
  });

  it('CPEs with a frequency list only follow channels in it', () => {
    assert.ok(cpeFollows({ allowedFrequencies: [] }, 5300, 40));
    assert.ok(cpeFollows({ allowedFrequencies: [5290, 5310] }, 5300, 40));
    assert.ok(!cpeFollows({ allowedFrequencies: [5500] }, 5300, 40));
  });

  it('before/after: missing CPEs, better, worse, same', () => {
    const before = linkSamples(three(100));
    assert.equal(compareLinks(before, linkSamples(three(100).slice(0, 2))).verdict, 'cpe_mancanti');
    assert.equal(compareLinks(before, linkSamples(three(120))).verdict, 'migliore');
    assert.equal(compareLinks(before, linkSamples(three(90))).verdict, 'peggiore');
    assert.equal(compareLinks(before, linkSamples(three(102))).verdict, 'uguale');
    // more capacity but the weakest customer 6 dB down: not better
    const weaker = [station(1, 140), station(2, 140), station(3, 140, -76)];
    assert.equal(compareLinks(before, linkSamples(weaker)).verdict, 'peggiore');
  });

  it('the night window is 03:00 in Italy', () => {
    const t = nextNightWindow(new Date('2026-10-10T20:00:00Z'));
    assert.equal(t, '2026-10-11T01:00:00.000Z', 'CEST: UTC+2');
    assert.equal(nextNightWindow(new Date('2026-12-10T10:00:00Z')), '2026-12-11T02:00:00.000Z', 'CET: UTC+1');
  });
});

describe('IA-AP ottimizzazione: prove sull’AP tramite UISP (simulato)', () => {
  it('keeps a channel that is really better', async () => {
    const { opt, fake, sent, runOf } = setup((c) => three(c === 5300 ? 130 : 100));
    const run = opt.schedule({ findingId: 'channel:ap-1', mode: 'suggested', when: 'now', by: 'admin' });
    await opt.execute(run.id);
    const r = runOf(run.id);
    assert.equal(r.outcome, 'migliorato', JSON.stringify(r));
    assert.deepEqual(r.kept, { centre: 5300, width: 40 });
    assert.deepEqual(fake.writes.map((w) => w.centre), [5300]);
    assert.ok(fake.writes.every((w) => w.key === SECRET), 'keys written back unchanged');
    assert.equal(sent[0]!.kind, 'network_optimizer');
    assert.match(sent[0]!.title, /migliorato, ora su 5300\/40/);
  });

  it('a CPE that does not come back: original channel restored and the admins told', async () => {
    const { opt, fake, sent, runOf } = setup((c) => (c === 5300 ? three(130).slice(0, 2) : three(100)));
    const run = opt.schedule({ findingId: 'channel:ap-1', mode: 'suggested', when: 'now', by: 'admin' });
    await opt.execute(run.id);
    const r = runOf(run.id);
    assert.equal(r.outcome, 'cpe_mancanti');
    assert.deepEqual(r.results[0]!.missing, ['Cliente 3']);
    assert.deepEqual(fake.writes.map((w) => `${w.centre}/${w.width}`), ['5300/40', '5500/40']);
    assert.equal(fake.writes[1]!.control, 5500, 'the original control frequency is restored');
    assert.match(sent[0]!.title, /CPE non riagganciate: ripristinato 5500\/40/);
  });

  it('nothing better: back to the original channel', async () => {
    const { opt, fake, runOf } = setup((c) => three(c === 5300 ? 101 : 100));
    const run = opt.schedule({ findingId: 'channel:ap-1', mode: 'suggested', when: 'now', by: 'admin' });
    await opt.execute(run.id);
    assert.equal(runOf(run.id).outcome, 'ripristinato');
    assert.deepEqual(fake.writes.map((w) => w.centre), [5300, 5500]);
  });

  it('several candidates: the best one is set again at the end', async () => {
    // spectrum of the AP: two quiet slots, the AP on a busy channel
    const quiet = { ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [5297 + i * 5, 2])), ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [5697 + i * 5, 4])) };
    const spectrum: Array<[number, number]> = Array.from({ length: 161 }, (_, i) => [5097 + i * 5, (quiet as Record<number, number>)[5097 + i * 5] ?? 20]);
    const input: AdvisorInput = { apId: 'ap-1', apName: 'N1-D01', location: { lat: 37.5, lon: 14.2 }, heading: 0, beamWidth: 90, frequency: 5500, widthMhz: 40, spectrum, stations: [], load: null };
    const cand = channelCandidates([input], 'ap-1', { range: { from: 5120, to: 5800 } }, [40], 2);
    assert.equal(cand.length, 2);
    const a = cand[0]!;
    const b = cand[1]!;
    const { opt, fake, runOf } = setup((c) => three(c === a.centre ? 125 : c === b.centre ? 110 : 100), { params: {}, inputs: [input] });
    const run = opt.schedule({ findingId: 'channel:ap-1', mode: 'search', when: 'now', by: 'admin' });
    assert.deepEqual(run.candidates.map((c) => c.centre).slice(0, 2), [a.centre, b.centre]);
    await opt.execute(run.id);
    const r = runOf(run.id);
    assert.equal(r.outcome, 'migliorato', JSON.stringify(r.results));
    assert.deepEqual(r.kept, { centre: a.centre, width: 40 });
    assert.equal(fake.writes.at(-1)!.centre, a.centre, 'the best one set again after trying the others');
  });

  it('cancel during a test: the AP goes back to its channel', async () => {
    let id = '';
    let n = 0;
    const s = setup((c) => three(c === 5300 ? 130 : 100), { onSleep: () => { if (++n === 4) s.opt.cancel(id); } });
    const run = s.opt.schedule({ findingId: 'channel:ap-1', mode: 'suggested', when: 'now', by: 'admin' });
    id = run.id;
    await s.opt.execute(run.id);
    assert.equal(s.runOf(run.id).outcome, 'annullato');
    assert.equal(s.fake.writes.at(-1)!.centre, 5500);
  });

  it('a run left half-way by a restart is restored at the next tick', async () => {
    const s = setup(() => three(100));
    const half: Partial<Run> = { id: 'opt-x', apId: 'ap-1', apName: 'N1-D01', state: 'in_corso', changed: true, original: { centre: 5500, width: 40, control: 5500, ieeeMode: '11acvht40' }, results: [], missing: [], candidates: [] };
    s.db.prepare("INSERT INTO settings(key, value, updated_at) VALUES('optimizer.runs', ?, '')").run(JSON.stringify([half]));
    await s.opt.tick();
    assert.equal(s.runOf('opt-x').outcome, 'interrotto');
    assert.equal(s.fake.writes.at(-1)!.centre, 5500);
    assert.match(s.sent[0]!.title, /interrotta dal riavvio/);
  });

  it('off in Impostazioni server, CPEs that cannot follow, nothing secret stored', async () => {
    assert.throws(() => setup(() => three(100), { enabled: false }).opt.schedule({ findingId: 'channel:ap-1', mode: 'suggested', when: 'now', by: 'admin' }), /optimizer_disabled/);
    const s = setup((c) => three(c === 5300 ? 130 : 100), { cpeAllowed: [5500] });
    const run = s.opt.schedule({ findingId: 'channel:ap-1', mode: 'suggested', when: 'now', by: 'admin' });
    await s.opt.execute(run.id);
    assert.equal(s.runOf(run.id).outcome, 'errore');
    assert.match(s.runOf(run.id).error!, /nessun canale candidato/);
    assert.equal(s.fake.writes.length, 0, 'the AP was never touched');
    const stored = (s.db.prepare("SELECT value FROM settings WHERE key = 'optimizer.runs'").get() as { value: string }).value;
    assert.ok(!stored.includes(SECRET));
    // the night window
    const night = setup(() => three(100)).opt.schedule({ findingId: 'channel:ap-1', mode: 'suggested', when: 'night', by: 'admin' });
    assert.equal(night.state, 'programmato');
    assert.ok(night.startAt > new Date().toISOString());
    // window missed by more than 2 hours: cancelled, never started in daytime
    const late = setup(() => three(100));
    const missed: Partial<Run> = { id: 'opt-late', apId: 'ap-1', apName: 'N1-D01', state: 'programmato', night: true, startAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), changed: false, original: null, results: [], missing: [], candidates: [{ centre: 5300, width: 40 }] };
    late.db.prepare("INSERT INTO settings(key, value, updated_at) VALUES('optimizer.runs', ?, '')").run(JSON.stringify([missed]));
    await late.opt.tick();
    assert.equal(late.runOf('opt-late').state, 'annullato');
    assert.equal(late.fake.writes.length, 0);
  });
});
