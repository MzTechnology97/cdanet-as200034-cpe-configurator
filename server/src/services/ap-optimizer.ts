import type { AppContext } from '../context.ts';
import { nowIso } from '../db.ts';
import { channelCandidates } from '../domain/advisor.ts';
import {
  averageSamples,
  channelOf,
  compareLinks,
  configWithChannel,
  configWithOriginal,
  cpeFollows,
  linkSamples,
  regulatoryEntry,
  summarize,
  type Channel,
  type Comparison,
  type LinkSample,
  type LinkSummary,
} from '../domain/optimizer.ts';

/**
 * IA-AP automatic optimisation (admins, only when Impostazioni server allows it): on one AP at a
 * time, tries the suggested channel or the best ones of its spectrum through UISP, waits for every
 * CPE to come back, compares the links before and after and keeps a channel only when it is really
 * better. Otherwise, or when a CPE does not come back, the original channel is restored and the
 * admins are told. Only the channel (frequency, width, IEEE mode) is ever changed and restored: the
 * rest of the configuration is read from UISP each time and written back as it is. Keys and secrets
 * of the configuration are never stored or returned.
 */

const KEY = 'optimizer.runs';
const KEEP = 20;

export interface OptimizerTiming {
  /** Interval of the checks while waiting for the CPEs, ms. */
  pollMs: number;
  /** Longest wait for every CPE to associate again after a change, ms. */
  reassocMs: number;
  /** Wait after the CPEs are back, before measuring (rate adaptation), ms. */
  settleMs: number;
  /** Readings averaged for a measure, and the time between them, ms. */
  samples: number;
  sampleGapMs: number;
}
export const DEFAULT_TIMING: OptimizerTiming = { pollMs: 15_000, reassocMs: 5 * 60_000, settleMs: 4 * 60_000, samples: 3, sampleGapMs: 40_000 };

type State = 'programmato' | 'in_corso' | 'completato' | 'annullato' | 'errore';
export type Outcome = 'migliorato' | 'ripristinato' | 'cpe_mancanti' | 'ripristino_incompleto' | 'annullato' | 'interrotto' | 'errore';

export interface TryResult {
  centre: number;
  width: number;
  verdict: Comparison['verdict'];
  capacityRatio: number | null;
  missing: string[];
  before: LinkSummary;
  after: LinkSummary;
}

export interface Run {
  id: string;
  apId: string;
  apName: string;
  mode: 'suggested' | 'search';
  findingId: string | null;
  by: string;
  requestedAt: string;
  /** When it starts (now, or the night window). */
  startAt: string;
  /** Scheduled for the night: never started in daytime if the server missed the window. */
  night?: boolean;
  state: State;
  /** Human readable step, for the console and the app. */
  step: string;
  /** Channel before the optimisation (restored when nothing is better). */
  original: Channel | null;
  /** True while the AP is on a channel that is not the original. */
  changed: boolean;
  candidates: Array<{ centre: number; width: number }>;
  baseline: LinkSummary | null;
  results: TryResult[];
  outcome: Outcome | null;
  kept: { centre: number; width: number } | null;
  /** CPEs still missing at the end (names). */
  missing: string[];
  endedAt: string | null;
  error: string | null;
}

/** Next 03:00 in Italy (low traffic), as an ISO instant. */
export function nextNightWindow(now = new Date(), hour = 3): string {
  const rome = (d: Date) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', hourCycle: 'h23' }).format(d));
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  for (const add of [0, 1]) {
    const [y, m, d] = day.split('-').map(Number) as [number, number, number];
    for (const offset of [1, 2]) {
      const t = new Date(Date.UTC(y, m - 1, d + add, hour - offset));
      if (rome(t) === hour && t > now) return t.toISOString();
    }
  }
  return new Date(now.getTime() + 3_600_000).toISOString();
}

export function createOptimizer(ctx: AppContext, opts: { timing?: Partial<OptimizerTiming>; sleep?: (ms: number) => Promise<void>; log?: (m: string) => void } = {}) {
  const T: OptimizerTiming = { ...DEFAULT_TIMING, ...opts.timing };
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const read = (): Run[] => {
    try {
      const r = ctx.db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as { value: string } | undefined;
      return r ? (JSON.parse(r.value) as Run[]) : [];
    } catch {
      return [];
    }
  };
  const write = (runs: Run[]) =>
    ctx.db
      .prepare(`INSERT INTO settings(key, value, updated_at, updated_by) VALUES(?, ?, ?, NULL) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(KEY, JSON.stringify(runs.slice(0, KEEP)), nowIso());
  const save = (run: Run) => {
    const runs = read();
    const i = runs.findIndex((r) => r.id === run.id);
    if (i >= 0) runs[i] = run;
    else runs.unshift(run);
    write(runs);
  };
  let active: string | null = null;
  let cancel = false;

  class Cancelled extends Error {}
  /** Waits [ms] in short steps, so a cancel is seen within a poll. */
  async function wait(ms: number) {
    for (let left = ms; left > 0; left -= T.pollMs) {
      if (cancel) throw new Cancelled();
      await sleep(Math.min(T.pollMs, left));
    }
    if (cancel) throw new Cancelled();
  }

  const uisp = () => {
    if (!ctx.uisp) throw new Error('UISP non configurato');
    return ctx.uisp;
  };
  const stations = async (apId: string) => linkSamples(await uisp().apStations(apId));
  async function measure(apId: string): Promise<Map<string, LinkSample>> {
    const readings: Array<Map<string, LinkSample>> = [];
    for (let i = 0; i < T.samples; i++) {
      if (i) await wait(T.sampleGapMs);
      readings.push(await stations(apId));
    }
    return averageSamples(readings);
  }
  /** Waits until every CPE of [expected] is connected again; returns the ones still missing. */
  async function waitForAll(apId: string, expected: Map<string, LinkSample>, ms: number, ignoreCancel = false): Promise<LinkSample[]> {
    let missing = [...expected.values()];
    for (let left = ms; left > 0; left -= T.pollMs) {
      if (cancel && !ignoreCancel) throw new Cancelled();
      await sleep(Math.min(T.pollMs, left));
      const now = await stations(apId).catch(() => new Map<string, LinkSample>());
      missing = [...expected.values()].filter((s) => !now.has(s.mac));
      if (!missing.length) return [];
    }
    return missing;
  }
  async function setChannel(apId: string, centre: number, width: number) {
    const config = await uisp().airmaxWireless(apId);
    if (!config) throw new Error('configurazione wireless dell’AP non leggibile (AP offline?)');
    await uisp().setAirmaxWireless(apId, configWithChannel(config, centre, width));
  }
  /** Back to the original channel, then waits for the CPEs (twice the usual time). */
  async function restore(run: Run, baseline: Map<string, LinkSample> | null): Promise<string[]> {
    if (!run.original) return [];
    run.step = `Ripristino del canale iniziale ${run.original.centre}/${run.original.width} MHz`;
    save(run);
    const config = await uisp().airmaxWireless(run.apId);
    if (!config) throw new Error('configurazione wireless dell’AP non leggibile per il ripristino');
    await uisp().setAirmaxWireless(run.apId, configWithOriginal(config, run.original));
    run.changed = false;
    save(run);
    if (!baseline) return [];
    return (await waitForAll(run.apId, baseline, T.reassocMs * 2, true)).map((s) => s.name);
  }

  function notify(run: Run) {
    const ch = (c: { centre: number; width: number } | null) => (c ? `${c.centre}/${c.width} MHz` : '—');
    const titles: Record<Outcome, string> = {
      migliorato: `✅ IA-AP: ${run.apName} migliorato, ora su ${ch(run.kept)}`,
      ripristinato: `↩️ IA-AP: ${run.apName}, nessun canale migliore, ripristinato ${ch(run.original)}`,
      cpe_mancanti: `⚠️ IA-AP: ${run.apName}, CPE non riagganciate: ripristinato ${ch(run.original)}`,
      ripristino_incompleto: `🚨 IA-AP: ${run.apName}, dopo il ripristino mancano ancora ${run.missing.length} CPE`,
      annullato: `IA-AP: ottimizzazione di ${run.apName} annullata, ripristinato ${ch(run.original)}`,
      interrotto: `⚠️ IA-AP: ottimizzazione di ${run.apName} interrotta dal riavvio del server, ripristinato ${ch(run.original)}`,
      errore: `⚠️ IA-AP: ottimizzazione di ${run.apName} non riuscita`,
    };
    const lines = [
      ...run.results.map((r) => `${r.centre}/${r.width} MHz: ${r.verdict.replace('_', ' ')}${r.capacityRatio !== null ? `, capacità ${r.capacityRatio >= 1 ? '+' : ''}${Math.round((r.capacityRatio - 1) * 100)}%` : ''}${r.missing.length ? `, mancano ${r.missing.length} CPE` : ''}`),
      ...(run.missing.length ? [`CPE non riagganciate: ${run.missing.slice(0, 8).join(', ')}${run.missing.length > 8 ? '…' : ''}`] : []),
      ...(run.error ? [run.error] : []),
    ];
    ctx.notify.inbox.push('noc', { kind: 'network_optimizer', title: titles[run.outcome ?? 'errore'], lines });
  }

  async function execute(run: Run) {
    active = run.id;
    cancel = false;
    let baseline: Map<string, LinkSample> | null = null;
    const finish = (outcome: Outcome, state: State = 'completato') => {
      run.outcome = outcome;
      run.state = state;
      run.step = 'Finito';
      run.endedAt = nowIso();
      save(run);
      notify(run);
    };
    try {
      run.state = 'in_corso';
      run.step = 'Lettura della configurazione e delle CPE collegate';
      save(run);
      const config = await uisp().airmaxWireless(run.apId);
      run.original = channelOf(config);
      if (!config || !run.original) throw new Error('configurazione wireless dell’AP non leggibile (AP offline?)');
      run.step = 'Misura dei collegamenti sul canale attuale';
      save(run);
      baseline = await measure(run.apId);
      if (!baseline.size) throw new Error('nessuna CPE collegata: niente da confrontare');
      run.baseline = summarize(baseline);
      // only channels the radio offers and every CPE scans
      run.step = 'Controllo dei canali che le CPE possono seguire';
      save(run);
      const cpeConfigs = await Promise.all([...baseline.values()].map((s) => (s.id ? uisp().airmaxWireless(s.id).catch(() => null) : Promise.resolve(null))));
      run.candidates = run.candidates.filter((c) => regulatoryEntry(config, c.centre, c.width) && cpeConfigs.every((cc) => !cc || cpeFollows(cc, c.centre, c.width)));
      if (!run.candidates.length) throw new Error('nessun canale candidato utilizzabile (tabella dei canali della radio o elenco frequenze delle CPE)');
      for (const c of run.candidates) {
        run.step = `Prova ${c.centre}/${c.width} MHz: cambio del canale`;
        save(run);
        await setChannel(run.apId, c.centre, c.width);
        run.changed = true;
        run.step = `Prova ${c.centre}/${c.width} MHz: attesa che tutte le ${baseline.size} CPE si riaggancino`;
        save(run);
        const missing = await waitForAll(run.apId, baseline, T.reassocMs);
        if (missing.length) {
          run.results.push({ centre: c.centre, width: c.width, verdict: 'cpe_mancanti', capacityRatio: null, missing: missing.map((s) => s.name), before: run.baseline!, after: summarize(await stations(run.apId).catch(() => new Map())) });
          run.missing = await restore(run, baseline);
          return finish(run.missing.length ? 'ripristino_incompleto' : 'cpe_mancanti');
        }
        run.step = `Prova ${c.centre}/${c.width} MHz: stabilizzazione e misura`;
        save(run);
        await wait(T.settleMs);
        const cmp = compareLinks(baseline, await measure(run.apId));
        run.results.push({ centre: c.centre, width: c.width, verdict: cmp.verdict, capacityRatio: cmp.capacityRatio, missing: cmp.missing.map((m) => m.name), before: cmp.before, after: cmp.after });
        save(run);
        if (cmp.verdict === 'cpe_mancanti') {
          run.missing = await restore(run, baseline);
          return finish(run.missing.length ? 'ripristino_incompleto' : 'cpe_mancanti');
        }
      }
      const best = run.results.filter((r) => r.verdict === 'migliore').sort((a, b) => (b.capacityRatio ?? 0) - (a.capacityRatio ?? 0))[0];
      if (!best) {
        run.missing = await restore(run, baseline);
        return finish(run.missing.length ? 'ripristino_incompleto' : 'ripristinato');
      }
      const lastTried = run.candidates.at(-1)!;
      if (lastTried.centre !== best.centre || lastTried.width !== best.width) {
        run.step = `Impostazione del canale migliore ${best.centre}/${best.width} MHz`;
        save(run);
        await setChannel(run.apId, best.centre, best.width);
        const missing = await waitForAll(run.apId, baseline, T.reassocMs);
        if (missing.length) {
          run.missing = await restore(run, baseline);
          return finish(run.missing.length ? 'ripristino_incompleto' : 'cpe_mancanti');
        }
      }
      run.kept = { centre: best.centre, width: best.width };
      run.changed = false;
      return finish('migliorato');
    } catch (e) {
      const cancelled = e instanceof Cancelled;
      run.error = cancelled ? null : (e as Error).message;
      cancel = false;
      if (run.changed) {
        try {
          run.missing = await restore(run, baseline);
        } catch (err) {
          run.error = `${run.error ? `${run.error}; ` : ''}ripristino non riuscito: ${(err as Error).message}`;
          run.missing = ['ripristino non riuscito: controlla l’AP in UISP'];
        }
      }
      return finish(run.missing.length ? 'ripristino_incompleto' : cancelled ? 'annullato' : 'errore', cancelled ? 'annullato' : 'errore');
    } finally {
      active = null;
      cancel = false;
    }
  }

  /** A run left half-way by a restart of the server: the AP goes back to its original channel. */
  async function recover() {
    for (const run of read().filter((r) => r.state === 'in_corso')) {
      run.error = 'server riavviato durante l’ottimizzazione';
      try {
        if (run.changed) run.missing = await restore(run, null);
      } catch (e) {
        run.error += `; ripristino non riuscito: ${(e as Error).message}`;
        run.missing = ['ripristino non riuscito: controlla l’AP in UISP'];
      }
      run.outcome = run.missing.length ? 'ripristino_incompleto' : 'interrotto';
      run.state = 'errore';
      run.endedAt = nowIso();
      save(run);
      notify(run);
    }
  }

  let recovered = false;
  let ticking = false;
  let timer: NodeJS.Timeout | null = null;
  /** Every minute: recovery after a restart, then the scheduled runs whose time has come. */
  async function tick() {
    if (!ctx.uisp || ticking) return;
    ticking = true;
    try {
      await tickOnce();
    } finally {
      ticking = false;
    }
  }
  async function tickOnce() {
    if (!recovered) {
      recovered = true;
      await recover().catch((e) => opts.log?.(`optimizer recover: ${(e as Error).message}`));
    }
    if (active || !ctx.cfg.advisorAutoOptimize) return;
    // a night run whose window passed by more than 2 hours (server down at 03:00): not in daytime
    for (const r of read().filter((x) => x.state === 'programmato' && x.night && Date.parse(x.startAt) < Date.now() - 2 * 3_600_000)) {
      r.state = 'annullato';
      r.outcome = 'annullato';
      r.step = 'Finestra notturna persa (server non attivo alle 3:00): riprogramma';
      r.endedAt = nowIso();
      save(r);
    }
    const due = read()
      .filter((r) => r.state === 'programmato' && r.startAt <= nowIso())
      .sort((a, b) => a.startAt.localeCompare(b.startAt))[0];
    if (due) await execute(due);
  }

  return {
    timing: T,
    tick,
    /** AP under test right now (its links are not normal: no alarms for it). */
    activeAp: () => (active ? (read().find((r) => r.id === active)?.apId ?? null) : null),
    start() {
      timer ??= setInterval(() => void tick().catch((e) => opts.log?.(`optimizer: ${(e as Error).message}`)), 60_000);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    /** Runs, newest first (the active one on top), without anything secret. */
    view() {
      return { enabled: ctx.cfg.advisorAutoOptimize, active, runs: read() };
    },
    /**
     * Schedules an optimisation of the AP of a stored finding: [mode] 'suggested' tries only the
     * channel of the finding, 'search' the best channels of the AP's spectrum (up to 3).
     */
    schedule(input: { findingId: string; mode: 'suggested' | 'search'; when: 'now' | 'night'; by: string }): Run {
      if (!ctx.cfg.advisorAutoOptimize) throw Object.assign(new Error('optimizer_disabled'), { status: 409 });
      if (!ctx.uisp) throw Object.assign(new Error('uisp_not_configured'), { status: 503 });
      const f = ctx.advisor.finding(input.findingId);
      if (!f || f.cpe || !['channel', 'width', 'cochannel', 'noise', 'mcs'].includes(f.kind)) throw Object.assign(new Error('finding_not_optimizable'), { status: 400 });
      const runs = read();
      if (runs.some((r) => r.apId === f.apId && (r.state === 'programmato' || r.state === 'in_corso'))) throw Object.assign(new Error('already_scheduled'), { status: 409 });
      const range = ctx.advisor.range();
      const inside = (c: { centre: number; width: number }) => c.centre - c.width / 2 >= range.from && c.centre + c.width / 2 <= range.to;
      let candidates: Array<{ centre: number; width: number }>;
      const fc = Number(f.params?.frequenza);
      const fw = Number(f.params?.ampiezza);
      const input0 = ctx.advisor.inputs().find((i) => i.apId === f.apId);
      if (input.mode === 'suggested') {
        if (!Number.isFinite(fc) || !Number.isFinite(fw)) throw Object.assign(new Error('finding_without_channel'), { status: 400 });
        candidates = [{ centre: fc, width: fw }];
      } else {
        if (!input0) throw Object.assign(new Error('advisor_data_missing'), { status: 409 });
        const widths = [...new Set([input0.widthMhz!, ...(Number.isFinite(fw) ? [fw] : [])])];
        candidates = channelCandidates(ctx.advisor.inputs(), f.apId, { range, minDbm: ctx.cfg.thresholds.signalMin }, widths, 3).map((c) => ({ centre: c.centre, width: c.width }));
        // the suggestion of the finding first, when it is not already among them
        if (Number.isFinite(fc) && Number.isFinite(fw) && !candidates.some((c) => c.centre === fc && c.width === fw)) candidates = [{ centre: fc, width: fw }, ...candidates].slice(0, 3);
      }
      candidates = candidates.filter(inside);
      if (!candidates.length) throw Object.assign(new Error('no_candidates'), { status: 409 });
      const run: Run = {
        id: `opt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        apId: f.apId,
        apName: f.apName,
        mode: input.mode,
        findingId: f.id,
        by: input.by,
        requestedAt: nowIso(),
        startAt: input.when === 'night' ? nextNightWindow() : nowIso(),
        night: input.when === 'night',
        state: 'programmato',
        step: input.when === 'night' ? 'Programmato per la notte' : 'In partenza',
        original: null,
        changed: false,
        candidates,
        baseline: null,
        results: [],
        outcome: null,
        kept: null,
        missing: [],
        endedAt: null,
        error: null,
      };
      save(run);
      return run;
    },
    /** Cancels a scheduled run, or stops the active one (the AP goes back to its channel). */
    cancel(id: string): boolean {
      const run = read().find((r) => r.id === id);
      if (!run) return false;
      if (run.state === 'programmato') {
        run.state = 'annullato';
        run.outcome = 'annullato';
        run.step = 'Annullato prima di partire';
        run.endedAt = nowIso();
        save(run);
        return true;
      }
      if (run.state === 'in_corso' && active === id) {
        cancel = true;
        return true;
      }
      return false;
    },
    /** Runs one scheduled optimisation now (tests and the minute timer). */
    execute: (id: string) => {
      const run = read().find((r) => r.id === id);
      return run ? execute(run) : Promise.resolve();
    },
  };
}
export type Optimizer = ReturnType<typeof createOptimizer>;
