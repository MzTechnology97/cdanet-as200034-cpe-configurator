import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ChangeEvent, Fragment, useMemo, useRef, useState } from 'react';
import { toast } from '../lib/toast';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { AsyncButton, Badge, Button, Card, Field, Icon, Notice, PageHeader, Segmented } from '../ui';

/**
 * IA-AP (admins): what to fix on APs and CPEs, from UISP (stations, a week of statistics, the
 * spectrum measured by APs and CPEs) and the coverage model, refreshed every hour and on the
 * server's events. Two panes on wide screens: the APs (or the kinds of problem) on the left, the
 * selected one on the right. The automatic optimisation of a channel acts on a real AP: it starts
 * only from the confirmation panel of a finding, and can be cancelled.
 */

type Sev = 'critico' | 'attenzione' | 'info';
type Tone = 'good' | 'warn' | 'bad' | 'neutral';
const SEV: Record<Sev, { label: string; plural: string; cls: string; rank: number }> = {
  critico: { label: 'Critico', plural: 'Critici', cls: 'bad', rank: 0 },
  attenzione: { label: 'Da guardare', plural: 'Da guardare', cls: 'warn', rank: 1 },
  info: { label: 'Suggerimento', plural: 'Suggerimenti', cls: 'info', rank: 2 },
};
const KINDS: Record<string, string> = {
  busy: 'Carico serale',
  mcs: 'Modulazione',
  snr: 'SNR basso',
  airtime: 'CPE lenta che occupa airtime',
  trend: 'Segnale in calo',
  expected: 'Sotto il segnale atteso',
  chains: 'Polarizzazioni',
  cpenoise: 'Interferenza dal cliente',
  noise: 'Rumore all’AP',
  cochannel: 'Canale sovrapposto',
  channel: 'Canale più libero',
  width: 'Ampiezza del canale',
  rebalance: 'Spostamento su altro AP',
  antenna: 'Antenna dell’AP',
};
type Filter = 'problemi' | 'critico' | 'attenzione' | 'info' | 'tutti';
/** Severity filters of the toolbar: "Problemi" (critical and to check) by default. */
const FILTERS: Array<[Filter, string, (f: Finding) => boolean]> = [
  ['problemi', 'Problemi', (f) => f.severity !== 'info'],
  ['critico', 'Critici', (f) => f.severity === 'critico'],
  ['attenzione', 'Da guardare', (f) => f.severity === 'attenzione'],
  ['info', 'Suggerimenti', (f) => f.severity === 'info'],
  ['tutti', 'Tutti', () => true],
];
type By = 'ap' | 'kind';

/** Findings of an AP that a channel change can fix: the automatic optimisation can start from them. */
const OPTIMIZABLE = new Set(['channel', 'width', 'cochannel', 'noise', 'mcs']);
const OUTCOME: Record<string, [string, Tone]> = {
  migliorato: ['Canale migliore tenuto', 'good'],
  ripristinato: ['Nessun miglioramento, ripristinato', 'neutral'],
  cpe_mancanti: ['CPE non riagganciate, ripristinato', 'warn'],
  ripristino_incompleto: ['CPE mancanti dopo il ripristino', 'bad'],
  annullato: ['Annullata', 'neutral'],
  interrotto: ['Interrotta dal riavvio, ripristinato', 'warn'],
  errore: ['Non riuscita', 'bad'],
};
const VERDICT: Record<string, string> = { migliore: 'migliore', peggiore: 'peggiore', uguale: 'nessuna differenza', cpe_mancanti: 'CPE mancanti' };
const OPTIMIZE_TEXT = (ap: string) =>
  `L’IA-AP cambierà il canale di ${ap} tramite UISP. A ogni prova le CPE si sganciano per circa un minuto; dopo ogni cambio aspetta che tornino tutte, misura per qualche minuto e confronta con prima. Tiene un canale solo se la capacità sale di almeno il 5% senza peggiorare SNR e cliente più debole; altrimenti, o se una CPE non torna entro 5 minuti, rimette il canale iniziale e avvisa gli admin. Circa 10 minuti per prova.`;
const PARAM: Record<string, [string, (v: unknown) => string]> = { frequenza: ['Frequenza', (v) => `${v} MHz`], ampiezza: ['Ampiezza', (v) => `${v} MHz`], azimut: ['Azimut', (v) => `${v}°`] };

interface Finding {
  id: string;
  severity: Sev;
  kind: string;
  apId: string;
  apName: string;
  cpe?: { id?: string; name: string } | null;
  title: string;
  detail: string;
  action: string;
  params?: Record<string, unknown> | null;
  since: string;
  dismissedUntil?: string | null;
}
interface Channel {
  centre: number;
  width: number;
}
interface Run {
  id: string;
  apId: string;
  apName: string;
  state: 'in_corso' | 'programmato' | string;
  outcome?: string | null;
  startAt: string;
  requestedAt: string;
  endedAt?: string | null;
  mode: 'suggested' | 'search';
  original?: Channel | null;
  kept?: Channel | null;
  candidates: Channel[];
  results: Array<Channel & { verdict: string; capacityRatio: number | null }>;
  step: string;
  missing: string[];
  by: string;
  error?: string | null;
}
interface Data {
  at: string | null;
  loadAt?: string | null;
  range: { from: number; to: number };
  findings: Finding[];
}
interface Opt {
  enabled: boolean;
  runs: Run[];
}

const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const ch = (c?: Channel | null) => (c ? `${c.centre}/${c.width} MHz` : '—');
const pct = (r: number | null | undefined) => (r === null || r === undefined ? '—' : `${r >= 1 ? '+' : ''}${Math.round((r - 1) * 100)}%`);
const bySeverity = (a: Finding, b: Finding) => SEV[a.severity].rank - SEV[b.severity].rank;
const counts = (fs: Finding[]) => ({ critico: fs.filter((f) => f.severity === 'critico').length, attenzione: fs.filter((f) => f.severity === 'attenzione').length, info: fs.filter((f) => f.severity === 'info').length });
const live = (r: Run) => r.state === 'in_corso' || r.state === 'programmato';
const runState = (r: Run): [string, Tone] => (r.outcome ? (OUTCOME[r.outcome] ?? [r.outcome, 'neutral']) : [r.state === 'in_corso' ? 'In corso' : `Programmata ${date(r.startAt)}`, 'warn']);
const fail = (e: unknown) => toast((e as Error).message, 'bad');

/** Coloured counters of a group (only the non-zero ones). */
const Pills = ({ c }: { c: Record<Sev, number> }) => (
  <span className="ia-pills">
    {(['critico', 'attenzione', 'info'] as Sev[])
      .filter((s) => c[s])
      .map((s) => (
        <span key={s} className={`ia-pill ${SEV[s].cls}`} title={SEV[s].plural}>
          {c[s]}
        </span>
      ))}
  </span>
);
const SevTag = ({ s }: { s: Sev }) => <span className={`ia-sev ${SEV[s].cls}`}>{SEV[s].label}</span>;

/** The optimisation of an AP, running or scheduled, as a tag in the list. */
function OptTag({ runs, apId }: { runs: Run[]; apId: string }) {
  const r = runs.find((x) => x.apId === apId && live(x));
  if (!r) return null;
  return <span className={`ia-opt-tag ${r.state === 'in_corso' ? 'running' : ''}`}>{r.state === 'in_corso' ? 'Ottimizzazione in corso' : `Ottimizzazione programmata ${date(r.startAt)}`}</span>;
}

/** One menu instead of three buttons: ignore for 7, 30 or 90 days (or show again). */
function IgnoreControl({ f, onDismiss }: { f: Finding; onDismiss: (f: Finding, days: number) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  if (f.dismissedUntil)
    return (
      <AsyncButton variant="ghost" className="ia-btn" onClick={() => onDismiss(f, 0)} onError={fail}>
        Mostra di nuovo
      </AsyncButton>
    );
  const change = async (e: ChangeEvent<HTMLSelectElement>) => {
    const days = Number(e.target.value);
    if (!days) return;
    setBusy(true);
    try {
      await onDismiss(f, days);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <select className="ia-ignore" aria-label="Ignora" value="" disabled={busy} onChange={(e) => void change(e)}>
      <option value="">Ignora…</option>
      {[7, 30, 90].map((d) => (
        <option key={d} value={d}>
          {d} giorni
        </option>
      ))}
    </select>
  );
}

/** A running or scheduled optimisation, with the button to stop it. */
function LiveRun({ r, onCancel }: { r: Run; onCancel: (r: Run) => Promise<void> }) {
  return (
    <div className="ia-run">
      <div className="ia-run-head">
        <Badge tone={runState(r)[1]}>{runState(r)[0]}</Badge>
        <strong>{r.apName}</strong>
        <span className="ui-muted ui-small">{`${r.mode === 'suggested' ? 'canale consigliato' : 'ricerca del canale migliore'} · ${r.original ? `${ch(r.original)} → ` : 'prova '}${r.candidates.map(ch).join(', ')} · da ${r.by}`}</span>
      </div>
      <div className="ui-small">{r.step}</div>
      {r.missing.length > 0 && <Notice tone="bad">CPE non riagganciate: {r.missing.join(', ')}</Notice>}
      <div>
        <AsyncButton onClick={() => onCancel(r)} onError={fail}>
          {r.state === 'in_corso' ? 'Annulla e ripristina' : 'Annulla'}
        </AsyncButton>
      </div>
    </div>
  );
}

function HistoryTable({ runs }: { runs: Run[] }) {
  return (
    <div className="ia-table-wrap">
      <table className="ia-table">
        <thead>
          <tr>
            {['Quando', 'AP', 'Esito', 'Canale', 'Prove', 'Da'].map((t) => (
              <th key={t}>{t}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td className="nowrap">{date(r.endedAt ?? r.requestedAt)}</td>
              <td>{r.apName}</td>
              <td>
                <Badge tone={runState(r)[1]}>{runState(r)[0]}</Badge>
                {r.error && <div className="ui-muted ui-small">{r.error}</div>}
              </td>
              <td className="nowrap">{`${ch(r.original)}${r.kept ? ` → ${ch(r.kept)}` : ''}`}</td>
              <td className="ui-small">{r.results.length ? r.results.map((t) => `${ch(t)}: ${VERDICT[t.verdict] ?? t.verdict}, capacità ${pct(t.capacityRatio)}`).join(' · ') : '—'}</td>
              <td>{r.by}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Optimizer({ opt, onCancel }: { opt: Opt; onCancel: (r: Run) => Promise<void> }) {
  const running = opt.runs.filter(live);
  const past = opt.runs.filter((r) => !live(r));
  if (!opt.enabled && !opt.runs.length) return null;
  return (
    <Card title="Ottimizzazione automatica" actions={<Badge tone={opt.enabled ? 'good' : 'neutral'}>{opt.enabled ? 'attiva' : 'spenta'}</Badge>}>
      {running.length ? (
        running.map((r) => <LiveRun key={r.id} r={r} onCancel={onCancel} />)
      ) : (
        <p className="ui-muted ui-small ia-p">{opt.enabled ? 'Nessuna in corso. Si avvia da un avviso di un AP con Ottimizza….' : 'Spenta in Impostazioni server → Assistente rete: l’assistente dà solo consigli.'}</p>
      )}
      {past.length > 0 && (
        <details className="ui-details ia-history">
          <summary>Storico ({past.length})</summary>
          <HistoryTable runs={past} />
        </details>
      )}
    </Card>
  );
}

/** The confirmation of an optimisation: what, when, and what the customers will notice. */
function OptimizePanel({ f, onDone, onClose }: { f: Finding; onDone: () => Promise<void>; onClose: () => void }) {
  const suggested = f.params?.frequenza !== undefined;
  const [mode, setMode] = useState(suggested ? 'suggested' : 'search');
  const [when, setWhen] = useState('night');
  const confirmRun = async () => {
    await api('/api/admin/advisor/optimizer', { method: 'POST', body: { findingId: f.id, mode, when, confirm: true } });
    toast(when === 'now' ? 'Ottimizzazione avviata' : 'Ottimizzazione programmata per stanotte');
    await onDone();
  };
  return (
    <div className="ia-confirm">
      <p className="ui-small ia-p">{OPTIMIZE_TEXT(f.apName)}</p>
      <div className="ui-grid-form">
        <Field label="Cosa">
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            {suggested && (
              <option value="suggested">
                Prova il canale consigliato ({String(f.params!.frequenza)}/{String(f.params!.ampiezza)} MHz)
              </option>
            )}
            <option value="search">Cerca il canale migliore (fino a 3 prove)</option>
          </select>
        </Field>
        <Field label="Quando">
          <select value={when} onChange={(e) => setWhen(e.target.value)}>
            <option value="night">Stanotte alle 3:00 (consigliato)</option>
            <option value="now">Adesso</option>
          </select>
        </Field>
      </div>
      <div className="ui-row">
        <AsyncButton variant="primary" onClick={confirmRun} onError={fail}>
          Conferma
        </AsyncButton>
        <Button variant="ghost" onClick={onClose}>
          Annulla
        </Button>
      </div>
    </div>
  );
}

/** A finding of the AP itself: a card with what was measured, what to do and the actions. */
function ApCard({ f, canOptimize, isOpen, onOpen, onClose, onDone, onDismiss }: { f: Finding; canOptimize: boolean; isOpen: boolean; onOpen: () => void; onClose: () => void; onDone: () => Promise<void>; onDismiss: (f: Finding, d: number) => Promise<void> }) {
  return (
    <article className={`ia-card ${SEV[f.severity].cls}${f.dismissedUntil ? ' dismissed' : ''}`}>
      <div className="ia-card-head">
        <SevTag s={f.severity} />
        <h3>{f.title}</h3>
        <span className="ui-muted ui-small ia-kind">{KINDS[f.kind] ?? f.kind}</span>
      </div>
      <p>{f.detail}</p>
      <p className="ia-todo">
        <b>Cosa fare </b>
        {f.action}
      </p>
      {f.params && (
        <div className="ia-params">
          {Object.entries(f.params).map(([k, v]) => (
            <span key={k} className="ia-chip">
              {PARAM[k]?.[0] ?? k} <b>{PARAM[k] ? PARAM[k]![1](v) : String(v)}</b>
            </span>
          ))}
        </div>
      )}
      <div className="ia-card-foot">
        <span className="ui-muted ui-small">
          dal {date(f.since)}
          {f.dismissedUntil ? ` · ignorato fino al ${date(f.dismissedUntil)}` : ''}
        </span>
        <span className="ia-actions">
          {canOptimize && !isOpen && !f.dismissedUntil && (
            <Button className="ia-btn" onClick={onOpen}>
              Ottimizza…
            </Button>
          )}
          <IgnoreControl f={f} onDismiss={onDismiss} />
        </span>
      </div>
      {isOpen && <OptimizePanel f={f} onDone={onDone} onClose={onClose} />}
    </article>
  );
}

/** CPE findings as a table; [withAp] adds the AP column (view by kind). */
function CpeTable({ fs, withAp, onAp, onDismiss }: { fs: Finding[]; withAp: boolean; onAp?: (id: string) => void; onDismiss: (f: Finding, d: number) => Promise<void> }) {
  return (
    <div className="ia-table-wrap">
      <table className="ia-table">
        <thead>
          <tr>
            {['Gravità', ...(withAp ? ['AP'] : []), 'CPE', 'Problema', 'Dettaglio', 'Dal', ''].map((t, i) => (
              <th key={i}>{t}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {fs.map((f) => (
            <tr key={f.id} className={f.dismissedUntil ? 'dismissed' : ''}>
              <td>
                <SevTag s={f.severity} />
              </td>
              {withAp && (
                <td>
                  <button type="button" className="ui-link" onClick={() => onAp?.(f.apId)}>
                    {f.apName}
                  </button>
                </td>
              )}
              <td className="ia-cpe">
                {f.cpe ? (
                  f.cpe.id ? (
                    <a href={`#/cpe?id=${encodeURIComponent(f.cpe.id)}`} title="Gestisci CPE">
                      {f.cpe.name}
                    </a>
                  ) : (
                    f.cpe.name
                  )
                ) : (
                  <span className="ui-muted">AP</span>
                )}
              </td>
              <td className="ia-problem">{f.title}</td>
              <td className="ui-muted ui-small">{f.detail}</td>
              <td className="ui-small nowrap">{date(f.since)}</td>
              <td className="nowrap">
                <IgnoreControl f={f} onDismiss={onDismiss} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** "Cosa fare" once per kind (the same advice for every CPE with that problem). */
function TodoLegend({ fs }: { fs: Finding[] }) {
  const kinds = [...new Map(fs.map((f) => [f.kind, f])).values()];
  if (!kinds.length) return null;
  return (
    <dl className="ia-legend">
      {kinds.map((f) => (
        <Fragment key={f.kind}>
          <dt>{KINDS[f.kind] ?? f.kind}</dt>
          <dd>{f.action}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

export function Advisor() {
  const qc = useQueryClient();
  const dataQ = useQuery({ queryKey: [...keys.advisor, 'findings'], queryFn: () => api<Data>('/api/admin/advisor') });
  // while an optimisation runs (or is due), its progress every 15 s, only while this page is open
  const optQ = useQuery({
    queryKey: [...keys.advisor, 'optimizer'],
    queryFn: () => api<Opt>('/api/admin/advisor/optimizer').catch((): Opt => ({ enabled: false, runs: [] })),
    refetchInterval: (q) => {
      const now = new Date().toISOString();
      return q.state.data?.runs.some((r) => r.state === 'in_corso' || (r.state === 'programmato' && r.startAt <= now)) ? 15_000 : false;
    },
  });
  const data = dataQ.data;
  const opt = optQ.data ?? { enabled: false, runs: [] };
  const [filter, setFilter] = useState<Filter>('problemi');
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const [showDismissed, setShowDismissed] = useState(false);
  const [by, setBy] = useState<By>('ap');
  const [sel, setSel] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const detailRef = useRef<HTMLElement>(null);

  const reload = () => qc.invalidateQueries({ queryKey: keys.advisor });
  const dismiss = async (f: Finding, days: number) => {
    await api('/api/admin/advisor/dismiss', { method: 'POST', body: { id: f.id, days } });
    toast(days ? `Ignorato per ${days} giorni` : 'Di nuovo visibile');
    await reload();
  };
  const cancelRun = async (r: Run) => {
    await api(`/api/admin/advisor/optimizer/${encodeURIComponent(r.id)}/cancel`, { method: 'POST', body: {} });
    toast(r.state === 'in_corso' ? 'Annullamento: l’AP torna al canale iniziale' : 'Annullata');
    await reload();
  };
  const refresh = async () => {
    await api('/api/admin/advisor/refresh', { method: 'POST', body: {} });
    // the new analysis arrives as a live event (and, without it, at the next reading)
    toast('Aggiornamento avviato: i dati di UISP arrivano in uno o due minuti.');
  };
  const setOpenFor = (id: string, on: boolean) =>
    setOpen((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  const select = (groupBy: By, id: string) => {
    setBy(groupBy);
    setSel(id);
    // narrow screens: the detail is below the list
    if (matchMedia('(max-width: 1099px)').matches) requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };
  // a new filter starts from the first group again
  const reset =
    <T,>(fn: (v: T) => void) =>
    (v: T) => {
      fn(v);
      setSel(null);
    };

  const groups = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    const pass = FILTERS.find(([k]) => k === filter)![2];
    const visible = data.findings.filter((f) => (showDismissed || !f.dismissedUntil) && pass(f) && (!kind || f.kind === kind) && (!needle || f.apName.toLowerCase().includes(needle) || (f.cpe?.name ?? '').toLowerCase().includes(needle)));
    const key = by === 'ap' ? (f: Finding) => f.apId : (f: Finding) => f.kind;
    const m = new Map<string, Finding[]>();
    for (const f of visible) m.set(key(f), [...(m.get(key(f)) ?? []), f]);
    return [...m.entries()]
      .map(([id, items]) => ({ id, items: items.sort(bySeverity), c: counts(items), name: by === 'ap' ? items[0]!.apName : (KINDS[id] ?? id) }))
      .sort((a, b) => b.c.critico - a.c.critico || b.c.attenzione - a.c.attenzione || b.items.length - a.items.length || a.name.localeCompare(b.name));
  }, [data, q, filter, kind, showDismissed, by]);
  const current = groups.find((g) => g.id === sel) ?? groups[0] ?? null;

  const all = data ? data.findings.filter((f) => !f.dismissedUntil) : [];
  const c = counts(all);
  const kpi = (key: Filter, label: string, value: number, cls: string) => (
    <button key={key} type="button" className={`ia-kpi ${cls}${filter === key ? ' on' : ''}`} onClick={() => reset(setFilter)(filter === key ? 'problemi' : key)}>
      <span className="ia-kpi-value">{value}</span>
      <span className="ia-kpi-label">{label}</span>
    </button>
  );

  const detail = () => {
    if (dataQ.error) return <Notice tone="bad">{(dataQ.error as Error).message}</Notice>;
    if (!data) return <div className="ia-empty">Caricamento…</div>;
    if (!current) return <div className="ia-empty">{data.findings.length ? 'Nessun avviso con questi filtri.' : 'Nessun problema trovato: la rete è in ordine.'}</div>;
    const g = current;
    const own = g.items.filter((f) => !f.cpe);
    const cpes = g.items.filter((f) => f.cpe);
    const runs = by === 'ap' ? opt.runs.filter((r) => live(r) && r.apId === g.id) : [];
    return (
      <>
        <header className="ia-detail-head">
          <div>
            <h2>
              {g.name} {by === 'ap' && <OptTag runs={opt.runs} apId={g.id} />}
            </h2>
            <p className="ui-muted ui-small ia-p">{by === 'ap' ? `${g.items.length} ${g.items.length === 1 ? 'avviso' : 'avvisi'} · ${own.length} sull’AP, ${cpes.length} sulle CPE` : `${g.items.length} avvisi su ${new Set(g.items.map((f) => f.apId)).size} AP`}</p>
          </div>
          <Pills c={g.c} />
        </header>
        {runs.map((r) => (
          <LiveRun key={r.id} r={r} onCancel={cancelRun} />
        ))}
        {own.length > 0 && (
          <div className="ia-section">
            <h3 className="ia-section-title">{by === 'ap' ? 'AP' : 'Sugli AP'}</h3>
            {own.map((f) => (
              <ApCard
                key={f.id}
                f={f}
                canOptimize={OPTIMIZABLE.has(f.kind) && opt.enabled}
                isOpen={open.has(f.id)}
                onOpen={() => setOpenFor(f.id, true)}
                onClose={() => setOpenFor(f.id, false)}
                onDone={async () => {
                  setOpenFor(f.id, false);
                  await reload();
                }}
                onDismiss={dismiss}
              />
            ))}
          </div>
        )}
        {cpes.length > 0 &&
          (by === 'ap' ? (
            <div className="ia-section">
              <h3 className="ia-section-title">CPE ({cpes.length})</h3>
              <CpeTable fs={cpes} withAp={false} onDismiss={dismiss} />
              <h4 className="ia-legend-title">Cosa fare</h4>
              <TodoLegend fs={cpes} />
            </div>
          ) : (
            <div className="ia-section">
              <h3 className="ia-section-title">Sulle CPE ({cpes.length})</h3>
              <p className="ia-todo">
                <b>Cosa fare </b>
                {cpes[0]!.action}
              </p>
              <CpeTable fs={cpes} withAp onAp={(id) => select('ap', id)} onDismiss={dismiss} />
            </div>
          ))}
      </>
    );
  };

  return (
    <div className="ui-page ia-page">
      <PageHeader
        icon="troubleshoot"
        title="IA-AP"
        subtitle="Problemi di AP e CPE trovati ogni ora da UISP (stazioni, statistiche della settimana, spettro di AP e CPE) e dal modello di copertura, con cosa fare."
        actions={
          <AsyncButton icon="refresh" onClick={refresh} onError={fail}>
            Aggiorna ora
          </AsyncButton>
        }
      />
      <p className="ui-muted ui-small ia-p">
        {!data ? '' : data.at ? `Ultima analisi ${date(data.at)}${data.loadAt ? ` · dati UISP ${date(data.loadAt)}` : ''} · canali proposti tra ${data.range.from} e ${data.range.to} MHz` : 'Nessuna analisi ancora: parte con il primo aggiornamento orario dei dati di UISP, o con Aggiorna ora.'}
      </p>
      {data && (
        <div className="ia-kpis">
          {kpi('critico', 'Critici', c.critico, 'bad')}
          {kpi('attenzione', 'Da guardare', c.attenzione, 'warn')}
          {kpi('info', 'Suggerimenti', c.info, 'info')}
          <div className="ia-kpi plain">
            <span className="ia-kpi-value">{new Set(all.map((f) => f.apId)).size}</span>
            <span className="ia-kpi-label">AP coinvolti su {new Set(data.findings.map((f) => f.apId)).size}</span>
          </div>
        </div>
      )}
      <Optimizer opt={opt} onCancel={cancelRun} />
      <div className="ia-toolbar">
        <label className="hl-search">
          <Icon name="search" />
          <input type="search" placeholder="Cerca AP o CPE…" value={q} onChange={(e) => reset(setQ)(e.target.value)} aria-label="Cerca" />
        </label>
        <Segmented label="Gravità" options={FILTERS.map(([value, label]) => ({ value, label }))} value={filter} onChange={reset(setFilter)} />
        <select className="wo-date" aria-label="Tipo di problema" value={kind} onChange={(e) => reset(setKind)(e.target.value)}>
          <option value="">Tutti i tipi</option>
          {Object.entries(KINDS).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
        <Segmented
          label="Raggruppa"
          options={[
            { value: 'ap', label: 'Per AP' },
            { value: 'kind', label: 'Per problema' },
          ]}
          value={by}
          onChange={reset(setBy)}
        />
        <label className="ui-check ui-small">
          <input type="checkbox" checked={showDismissed} onChange={(e) => setShowDismissed(e.target.checked)} />
          Ignorati
        </label>
      </div>
      <div className="ia-layout">
        <nav className="ia-list" aria-label="Elenco">
          <div className="ia-list-head ui-small ui-muted">
            {groups.length} {by === 'ap' ? 'AP' : groups.length === 1 ? 'tipo' : 'tipi'}
          </div>
          {groups.map((g) => (
            <button key={g.id} type="button" className={`ia-item${g === current ? ' on' : ''}`} aria-current={g === current ? 'true' : 'false'} onClick={() => select(by, g.id)}>
              <span className="ia-item-top">
                <span className="ia-item-name">{g.name}</span>
                <Pills c={g.c} />
              </span>
              <span className="ia-item-sub">{by === 'ap' ? g.items[0]!.title : `${new Set(g.items.map((f) => f.apId)).size} AP · ${g.items.filter((f) => f.cpe).length} CPE`}</span>
              {by === 'ap' && <OptTag runs={opt.runs} apId={g.id} />}
            </button>
          ))}
        </nav>
        <section className="ia-detail" ref={detailRef}>
          {detail()}
        </section>
      </div>
    </div>
  );
}
