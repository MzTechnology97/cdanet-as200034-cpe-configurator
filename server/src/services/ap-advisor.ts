import type { AppContext } from '../context.ts';
import { nowIso } from '../db.ts';
import { analyzeNetwork, type AdvisorInput, type Finding } from '../domain/advisor.ts';
import { buildApModel, estimateAt, MAX_LINK_M, rateCoverage } from '../domain/coverage-model.ts';
import { bearingDeg, distanceM } from '../domain/geo.ts';
import { isPtp } from './uisp.ts';
import { obstacles, pointingConfig, terrainBetween, terrainSampler } from './terrain.ts';

/**
 * Assistente rete (admins): runs after every hourly refresh of the AP load, on the data already
 * read from UISP. Keeps the findings, the time each one was first seen, the ones the admins
 * dismissed, and tells the NOC (every admin) when new critical ones appear.
 */

const KEY = 'advisor.findings';
const DISMISSED = 'advisor.dismissed';

interface Stored {
  at: string | null;
  findings: Finding[];
  /** First time each finding (id) was seen. */
  since: Record<string, string>;
}

export function createAdvisor(ctx: AppContext, log?: (m: string) => void) {
  const read = <T>(key: string, fallback: T): T => {
    try {
      const r = ctx.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
      return r ? (JSON.parse(r.value) as T) : fallback;
    } catch {
      return fallback;
    }
  };
  const write = (key: string, value: unknown) =>
    ctx.db
      .prepare(
        `INSERT INTO settings(key, value, updated_at, updated_by) VALUES(?, ?, ?, NULL)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(value), nowIso());
  let running = false;
  /** Inputs of the last analysis (memory only): the optimiser ranks its channels on them. */
  let last: AdvisorInput[] = [];

  /** Licensed band of the network for the channel suggestions (Impostazioni server). */
  const range = () => {
    const m = /^\s*(\d{4})\s*-\s*(\d{4})\s*$/.exec(ctx.cfg.advisorFreqRange);
    return m ? { from: Number(m[1]), to: Number(m[2]) } : { from: 5120, to: 5800 };
  };

  /**
   * Expected signal of every CPE from the coverage model without the CPE itself, and for the CPEs
   * of busy APs a freer AP that would serve them well (model + terrain).
   */
  async function modelChecks(inputs: AdvisorInput[]) {
    const expected = new Map<string, number>();
    const cpeSignal = new Map<string, number | null>();
    const rebalance = new Map<string, { apName: string; signalDbm: number; level: string | null }>();
    if (!ctx.uisp) return { expected, cpeSignal, rebalance };
    const radio = { eirpDbm: ctx.cfg.coverageEirpDbm, cpeGainDbi: ctx.cfg.coverageCpeGainDbi };
    const { aps, prior } = await ctx.uisp.modelInputs(radio);
    const h = pointingConfig(ctx.db);
    const obs = obstacles(ctx);
    const busy = new Set(inputs.filter((i) => i.load?.level === 'carico').map((i) => i.apId));
    for (const a of aps) {
      if (isPtp(a.device)) continue;
      const withSignal = a.clients.filter((c) => c.signal !== null);
      for (const c of withSignal) {
        cpeSignal.set(c.device.id, c.signal);
        const d = distanceM(a.location, c);
        if (d < 50 || d > MAX_LINK_M || withSignal.length < 3) continue;
        const m = buildApModel(a.location, a.clients.filter((x) => x !== c), a.heading, a.device.frequency, radio, prior);
        const e = estimateAt(m, d, bearingDeg(a.location, c), a.device.frequency, radio, null);
        // only where the model is confident enough to accuse the CPE
        if (e.signalDbm !== null && e.confidence !== 'bassa') expected.set(c.device.id, e.signalDbm);
      }
      if (!busy.has(a.device.id)) continue;
      // CPEs of a busy AP: is there a freer AP within reach that would serve them well?
      const others = aps.filter((x) => x.device.id !== a.device.id && !isPtp(x.device) && !busy.has(x.device.id));
      for (const c of a.clients) {
        let best: { apName: string; signalDbm: number; level: string | null } | null = null;
        for (const o of others) {
          const d = distanceM(o.location, c);
          if (d > MAX_LINK_M) continue;
          const at = await terrainSampler(ctx.terrain, [o.location, c], 500);
          const target = { lat: o.location.lat, lon: o.location.lon, gpsAltitude: o.device.altitude, siteHeight: o.siteHeight, frequency: o.device.frequency };
          const t = at ? terrainBetween(at, c, h.cpeHeightM, target, h.apHeightM, obs) : null;
          const e = estimateAt(buildApModel(o.location, o.clients, o.heading, o.device.frequency, radio, prior), d, bearingDeg(o.location, c), o.device.frequency, radio, t);
          const level = ctx.apLoad.load(o.device.id)?.level ?? null;
          if (e.signalDbm === null || rateCoverage(o.device.status === 'active' ? 'active' : o.device.status, e, ctx.cfg.thresholds.signalMin, level) !== 'buono') continue;
          if (!best || e.signalDbm > best.signalDbm) best = { apName: o.device.name, signalDbm: e.signalDbm, level };
        }
        if (best) rebalance.set(c.device.id, best);
      }
    }
    return { expected, cpeSignal, rebalance };
  }

  async function run(inputs: AdvisorInput[]): Promise<void> {
    if (running) return;
    running = true;
    last = inputs;
    try {
      const checks = await modelChecks(inputs).catch(() => ({ expected: undefined, cpeSignal: undefined, rebalance: undefined }));
      const findings = analyzeNetwork(inputs, { range: range(), minDbm: ctx.cfg.thresholds.signalMin, ...checks });
      const prev = read<Stored>(KEY, { at: null, findings: [], since: {} });
      const now = nowIso();
      const since: Record<string, string> = {};
      for (const f of findings) since[f.id] = prev.since[f.id] ?? now;
      write(KEY, { at: now, findings, since } satisfies Stored);
      // the NOC hears about the new critical findings (not about the ones it already knows or dismissed)
      const dismissed = read<Record<string, string>>(DISMISSED, {});
      // an AP under automatic optimisation is on a test channel: no alarms for it
      const testing = ctx.optimizer?.activeAp() ?? null;
      const fresh = findings.filter((f) => f.severity === 'critico' && f.apId !== testing && !prev.since[f.id] && !(dismissed[f.id] && dismissed[f.id]! > now));
      if (fresh.length && prev.at) {
        ctx.notify.inbox.push('noc', {
          kind: 'network_advice',
          title: `🛠️ Assistente rete: ${fresh.length} ${fresh.length === 1 ? 'nuovo problema critico' : 'nuovi problemi critici'}`,
          lines: fresh.slice(0, 6).map((f) => `${f.apName}${f.cpe ? ` · ${f.cpe.name}` : ''}: ${f.title}`).concat(fresh.length > 6 ? [`…e altri ${fresh.length - 6}: vedi Assistente rete nella console.`] : []),
        });
      }
    } catch (err) {
      log?.(`advisor: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  }

  return {
    run,
    /** Inputs of the last analysis (empty until the first hourly refresh after a restart). */
    inputs: () => last,
    /** The range of the channel suggestions, MHz. */
    range,
    /** A stored finding by id. */
    finding(id: string): Finding | null {
      return read<Stored>(KEY, { at: null, findings: [], since: {} }).findings.find((f) => f.id === id) ?? null;
    },
    /** Findings with "since" and the dismissed ones marked (until when). */
    view() {
      const s = read<Stored>(KEY, { at: null, findings: [], since: {} });
      const dismissed = read<Record<string, string>>(DISMISSED, {});
      const now = nowIso();
      return {
        at: s.at,
        range: range(),
        findings: s.findings.map((f) => ({ ...f, since: s.since[f.id] ?? s.at, dismissedUntil: dismissed[f.id] && dismissed[f.id]! > now ? dismissed[f.id]! : null })),
      };
    },
    /** Hides a finding for [days] (0 = show it again). */
    dismiss(id: string, days: number) {
      const d = read<Record<string, string>>(DISMISSED, {});
      const now = Date.now();
      for (const [k, until] of Object.entries(d)) if (Date.parse(until) < now) delete d[k];
      if (days > 0) d[id] = new Date(now + days * 86_400_000).toISOString();
      else delete d[id];
      write(DISMISSED, d);
    },
  };
}
export type Advisor = ReturnType<typeof createAdvisor>;
