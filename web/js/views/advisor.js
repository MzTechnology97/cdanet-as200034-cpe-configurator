import { api } from '../api.js';
import { toast } from '../dom.js';
import { Fragment, html, reactView, useEffect, useMemo, useRef, useState } from '../react.js';
import { Badge, BusyButton, Card, Field, fmtDate, Notice, PageHead, Segmented } from '../ui.js';

const SEV = {
  critico: { label: 'Critico', plural: 'Critici', cls: 'bad', rank: 0 },
  attenzione: { label: 'Da guardare', plural: 'Da guardare', cls: 'warn', rank: 1 },
  info: { label: 'Suggerimento', plural: 'Suggerimenti', cls: 'info', rank: 2 },
};
const KINDS = {
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
};
/** Severity filters of the toolbar: "Problemi" (critical and to check) by default. */
const FILTERS = [
  ['problemi', 'Problemi', (f) => f.severity !== 'info'],
  ['critico', 'Critici', (f) => f.severity === 'critico'],
  ['attenzione', 'Da guardare', (f) => f.severity === 'attenzione'],
  ['info', 'Suggerimenti', (f) => f.severity === 'info'],
  ['tutti', 'Tutti', () => true],
];
const GROUP_BY = [
  ['ap', 'Per AP'],
  ['kind', 'Per problema'],
];

/** Findings of an AP that a channel change can fix: the automatic optimisation can start from them. */
const OPTIMIZABLE = new Set(['channel', 'width', 'cochannel', 'noise', 'mcs']);
const OUTCOME = {
  migliorato: ['Canale migliore tenuto', 'good'],
  ripristinato: ['Nessun miglioramento, ripristinato', ''],
  cpe_mancanti: ['CPE non riagganciate, ripristinato', 'warn'],
  ripristino_incompleto: ['CPE mancanti dopo il ripristino', 'bad'],
  annullato: ['Annullata', ''],
  interrotto: ['Interrotta dal riavvio, ripristinato', 'warn'],
  errore: ['Non riuscita', 'bad'],
};
const VERDICT = { migliore: 'migliore', peggiore: 'peggiore', uguale: 'nessuna differenza', cpe_mancanti: 'CPE mancanti' };
const OPTIMIZE_TEXT = (ap) =>
  `L’IA-AP cambierà il canale di ${ap} tramite UISP. A ogni prova le CPE si sganciano per circa un minuto; dopo ogni cambio aspetta che tornino tutte, misura per qualche minuto e confronta con prima. Tiene un canale solo se la capacità sale di almeno il 5% senza peggiorare SNR e cliente più debole; altrimenti, o se una CPE non torna entro 5 minuti, rimette il canale iniziale e avvisa gli admin. Circa 10 minuti per prova.`;
const ch = (c) => (c ? `${c.centre}/${c.width} MHz` : '—');
const pct = (r) => (r === null || r === undefined ? '—' : `${r >= 1 ? '+' : ''}${Math.round((r - 1) * 100)}%`);
const PARAM = { frequenza: ['Frequenza', (v) => `${v} MHz`], ampiezza: ['Ampiezza', (v) => `${v} MHz`] };

const bySeverity = (a, b) => SEV[a.severity].rank - SEV[b.severity].rank;
const counts = (fs) => ({ critico: fs.filter((f) => f.severity === 'critico').length, attenzione: fs.filter((f) => f.severity === 'attenzione').length, info: fs.filter((f) => f.severity === 'info').length });
const live = (r) => r.state === 'in_corso' || r.state === 'programmato';
const runState = (r) => (r.outcome ? OUTCOME[r.outcome] : [r.state === 'in_corso' ? 'In corso' : `Programmata ${fmtDate(r.startAt)}`, 'warn']);

/** Coloured counters of a group (only the non-zero ones). */
const Pills = ({ c }) => html`
  <span class="ia-pills">
    ${['critico', 'attenzione', 'info'].filter((s) => c[s]).map((s) => html`<span key=${s} class=${`ia-pill ${SEV[s].cls}`} title=${SEV[s].plural}>${c[s]}</span>`)}
  </span>
`;
const SevTag = ({ s }) => html`<span class=${`ia-sev ${SEV[s].cls}`}>${SEV[s].label}</span>`;

/** The optimisation of an AP, running or scheduled, as a tag in the list. */
const OptTag = ({ runs, apId }) => {
  const r = runs.find((x) => x.apId === apId && live(x));
  if (!r) return null;
  return html`<span class=${`ia-opt-tag ${r.state === 'in_corso' ? 'running' : ''}`}>${r.state === 'in_corso' ? 'Ottimizzazione in corso' : `Ottimizzazione programmata ${fmtDate(r.startAt)}`}</span>`;
};

/** One menu instead of three buttons: ignore for 7, 30 or 90 days (or show again). */
function IgnoreControl({ f, onDismiss }) {
  const [busy, setBusy] = useState(false);
  if (f.dismissedUntil) return html`<${BusyButton} className="small-btn" onClick=${() => onDismiss(f, 0)}>Mostra di nuovo<//>`;
  const change = async (e) => {
    const days = Number(e.target.value);
    if (!days) return;
    setBusy(true);
    try {
      await onDismiss(f, days);
    } catch (err) {
      toast(err.message || String(err), 'bad');
    } finally {
      setBusy(false);
    }
  };
  return html`
    <select class="ia-ignore" aria-label="Ignora" value="" disabled=${busy} onChange=${change}>
      <option value="">Ignora…</option>
      ${[7, 30, 90].map((d) => html`<option key=${d} value=${d}>${d} giorni</option>`)}
    </select>
  `;
}

/** A running or scheduled optimisation, with the button to stop it. */
const LiveRun = ({ r, onCancel }) => html`
  <div class="ia-run">
    <div class="ia-run-head">
      <${Badge} kind=${runState(r)[1]}>${runState(r)[0]}<//>
      <b>${r.apName}</b>
      <span class="small muted">${`${r.mode === 'suggested' ? 'canale consigliato' : 'ricerca del canale migliore'} · ${r.original ? `${ch(r.original)} → ` : 'prova '}${r.candidates.map(ch).join(', ')} · da ${r.by}`}</span>
    </div>
    <div class="small">${r.step}</div>
    ${r.missing.length ? html`<div class="notice bad small">CPE non riagganciate: ${r.missing.join(', ')}</div>` : null}
    <div><${BusyButton} className="small-btn" onClick=${() => onCancel(r)}>${r.state === 'in_corso' ? 'Annulla e ripristina' : 'Annulla'}<//></div>
  </div>
`;

const HistoryTable = ({ runs }) => html`
  <table class="ia-table">
    <thead><tr>${['Quando', 'AP', 'Esito', 'Canale', 'Prove', 'Da'].map((t) => html`<th key=${t}>${t}</th>`)}</tr></thead>
    <tbody>
      ${runs.map(
        (r) => html`
          <tr key=${r.id}>
            <td class="nowrap">${fmtDate(r.endedAt ?? r.requestedAt)}</td>
            <td>${r.apName}</td>
            <td><${Badge} kind=${runState(r)[1]}>${runState(r)[0]}<//>${r.error ? html`<div class="small muted">${r.error}</div>` : null}</td>
            <td class="nowrap">${`${ch(r.original)}${r.kept ? ` → ${ch(r.kept)}` : ''}`}</td>
            <td class="small">${r.results.length ? r.results.map((t) => `${ch(t)}: ${VERDICT[t.verdict] ?? t.verdict}, capacità ${pct(t.capacityRatio)}`).join(' · ') : '—'}</td>
            <td>${r.by}</td>
          </tr>
        `,
      )}
    </tbody>
  </table>
`;

function Optimizer({ opt, onCancel }) {
  const running = opt.runs.filter(live);
  const past = opt.runs.filter((r) => !live(r));
  if (!opt.enabled && !opt.runs.length) return null;
  return html`
    <${Card}>
      <div class="ia-card-head"><h2>Ottimizzazione automatica</h2><${Badge} kind=${opt.enabled ? 'good' : ''}>${opt.enabled ? 'attiva' : 'spenta'}<//></div>
      ${running.length
        ? running.map((r) => html`<${LiveRun} key=${r.id} r=${r} onCancel=${onCancel} />`)
        : html`<p class="small muted">${opt.enabled ? 'Nessuna in corso. Si avvia da un avviso di un AP con Ottimizza….' : 'Spenta in Impostazioni server → Assistente rete: l’assistente dà solo consigli.'}</p>`}
      ${past.length ? html`<details class="ia-history"><summary>Storico (${past.length})</summary><${HistoryTable} runs=${past} /></details>` : null}
    <//>
  `;
}

/** The confirmation of an optimisation: what, when, and what the customers will notice. */
function OptimizePanel({ f, onDone, onClose }) {
  const suggested = f.params?.frequenza !== undefined;
  const [mode, setMode] = useState(suggested ? 'suggested' : 'search');
  const [when, setWhen] = useState('night');
  const confirm = async () => {
    await api('/api/admin/advisor/optimizer', { method: 'POST', body: { findingId: f.id, mode, when, confirm: true } });
    toast(when === 'now' ? 'Ottimizzazione avviata' : 'Ottimizzazione programmata per stanotte');
    await onDone();
  };
  return html`
    <div class="ia-confirm">
      <p class="small">${OPTIMIZE_TEXT(f.apName)}</p>
      <div class="row">
        <${Field} label="Cosa">
          <select value=${mode} onChange=${(e) => setMode(e.target.value)}>
            ${suggested ? html`<option value="suggested">Prova il canale consigliato (${f.params.frequenza}/${f.params.ampiezza} MHz)</option>` : null}
            <option value="search">Cerca il canale migliore (fino a 3 prove)</option>
          </select>
        <//>
        <${Field} label="Quando">
          <select value=${when} onChange=${(e) => setWhen(e.target.value)}>
            <option value="night">Stanotte alle 3:00 (consigliato)</option>
            <option value="now">Adesso</option>
          </select>
        <//>
      </div>
      <div class="btns"><${BusyButton} className="primary" onClick=${confirm}>Conferma<//><button type="button" onClick=${onClose}>Annulla</button></div>
    </div>
  `;
}

/** A finding of the AP itself: a card with what was measured, what to do and the actions. */
const ApCard = ({ f, canOptimize, isOpen, onOpen, onClose, onDone, onDismiss }) => html`
  <article class=${`ia-card ${SEV[f.severity].cls}${f.dismissedUntil ? ' dismissed' : ''}`}>
    <div class="ia-card-head"><${SevTag} s=${f.severity} /><h3>${f.title}</h3><span class="small muted ia-kind">${KINDS[f.kind] ?? f.kind}</span></div>
    <p>${f.detail}</p>
    <p class="ia-todo"><b>Cosa fare </b>${f.action}</p>
    ${f.params
      ? html`<div class="ia-params">${Object.entries(f.params).map(([k, v]) => html`<span key=${k} class="ia-chip">${PARAM[k]?.[0] ?? k} <b>${PARAM[k] ? PARAM[k][1](v) : String(v)}</b></span>`)}</div>`
      : null}
    <div class="ia-card-foot">
      <span class="small muted">dal ${fmtDate(f.since)}${f.dismissedUntil ? ` · ignorato fino al ${fmtDate(f.dismissedUntil)}` : ''}</span>
      <span class="ia-actions">
        ${canOptimize && !isOpen && !f.dismissedUntil ? html`<button type="button" class="small-btn" onClick=${onOpen}>Ottimizza…</button>` : null}
        <${IgnoreControl} f=${f} onDismiss=${onDismiss} />
      </span>
    </div>
    ${isOpen ? html`<${OptimizePanel} f=${f} onDone=${onDone} onClose=${onClose} />` : null}
  </article>
`;

/** CPE findings as a table; [withAp] adds the AP column (view by kind). */
const CpeTable = ({ fs, withAp, onAp, onDismiss }) => html`
  <div class="ia-table-wrap">
    <table class="ia-table">
      <thead><tr>${['Gravità', ...(withAp ? ['AP'] : []), 'CPE', 'Problema', 'Dettaglio', 'Dal', ''].map((t, i) => html`<th key=${i}>${t}</th>`)}</tr></thead>
      <tbody>
        ${fs.map(
          (f) => html`
            <tr key=${f.id} class=${f.dismissedUntil ? 'dismissed' : ''}>
              <td><${SevTag} s=${f.severity} /></td>
              ${withAp ? html`<td><button type="button" class="ia-link" onClick=${() => onAp(f.apId)}>${f.apName}</button></td>` : null}
              <td class="ia-cpe">${f.cpe ? (f.cpe.id ? html`<a href=${`#/cpe?id=${encodeURIComponent(f.cpe.id)}`} title="Gestisci CPE">${f.cpe.name}</a>` : f.cpe.name) : html`<span class="muted">AP</span>`}</td>
              <td class="ia-problem">${f.title}</td>
              <td class="small muted">${f.detail}</td>
              <td class="small nowrap">${fmtDate(f.since)}</td>
              <td class="nowrap"><${IgnoreControl} f=${f} onDismiss=${onDismiss} /></td>
            </tr>
          `,
        )}
      </tbody>
    </table>
  </div>
`;

/** "Cosa fare" once per kind (the same advice for every CPE with that problem). */
const TodoLegend = ({ fs }) => {
  const kinds = [...new Map(fs.map((f) => [f.kind, f])).values()];
  return kinds.length ? html`<dl class="ia-legend">${kinds.map((f) => html`<${Fragment} key=${f.kind}><dt>${KINDS[f.kind] ?? f.kind}</dt><dd>${f.action}</dd><//>`)}</dl>` : null;
};

/**
 * IA-AP (admins): what to fix on APs and CPEs, from UISP (stations, a week of statistics, the
 * spectrum measured by APs and CPEs) and the coverage model, refreshed every hour. Two panes on wide
 * screens: the APs (or the kinds of problem) on the left, the selected one on the right.
 */
function AdvisorPage() {
  const [data, setData] = useState(null);
  const [opt, setOpt] = useState({ enabled: false, active: null, runs: [] });
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('problemi');
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const [showDismissed, setShowDismissed] = useState(false);
  const [by, setBy] = useState('ap');
  const [sel, setSel] = useState(null);
  const [open, setOpen] = useState(() => new Set());
  const detailRef = useRef(null);
  const timers = useRef([]);

  const load = async () => {
    const [d, o] = await Promise.all([api('/api/admin/advisor'), api('/api/admin/advisor/optimizer').catch(() => null)]);
    setData(d);
    if (o) setOpt(o);
    setError('');
  };
  useEffect(() => {
    load().catch((e) => setError(e.message));
    return () => timers.current.forEach(clearTimeout);
  }, []);
  // while an optimisation runs (or is due), its progress every 15 s, only while this page is open
  useEffect(() => {
    const now = new Date().toISOString();
    if (!opt.runs.some((r) => r.state === 'in_corso' || (r.state === 'programmato' && r.startAt <= now))) return undefined;
    const t = setTimeout(() => load().catch(() => {}), 15_000);
    return () => clearTimeout(t);
  }, [opt]);

  const dismiss = async (f, days) => {
    await api('/api/admin/advisor/dismiss', { method: 'POST', body: { id: f.id, days } });
    toast(days ? `Ignorato per ${days} giorni` : 'Di nuovo visibile');
    await load();
  };
  const cancelRun = async (r) => {
    await api(`/api/admin/advisor/optimizer/${encodeURIComponent(r.id)}/cancel`, { method: 'POST', body: {} });
    toast(r.state === 'in_corso' ? 'Annullamento: l’AP torna al canale iniziale' : 'Annullata');
    await load();
  };
  const refresh = async () => {
    await api('/api/admin/advisor/refresh', { method: 'POST', body: {} });
    toast('Aggiornamento avviato: i dati di UISP arrivano in uno o due minuti.');
    timers.current.push(setTimeout(() => load().catch(() => {}), 120_000));
  };
  const setOpenFor = (id, on) =>
    setOpen((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
  const select = (groupBy, id) => {
    setBy(groupBy);
    setSel(id);
    // narrow screens: the detail is below the list
    if (matchMedia('(max-width: 1099px)').matches) requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };
  // a new filter starts from the first group again
  const reset = (fn) => (v) => {
    fn(v);
    setSel(null);
  };

  const groups = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    const pass = FILTERS.find(([k]) => k === filter)[2];
    const visible = data.findings.filter(
      (f) => (showDismissed || !f.dismissedUntil) && pass(f) && (!kind || f.kind === kind) && (!needle || f.apName.toLowerCase().includes(needle) || (f.cpe?.name ?? '').toLowerCase().includes(needle)),
    );
    const key = by === 'ap' ? (f) => f.apId : (f) => f.kind;
    const m = new Map();
    for (const f of visible) m.set(key(f), [...(m.get(key(f)) ?? []), f]);
    return [...m.entries()]
      .map(([id, items]) => ({ id, items: items.sort(bySeverity), c: counts(items), name: by === 'ap' ? items[0].apName : (KINDS[id] ?? id) }))
      .sort((a, b) => b.c.critico - a.c.critico || b.c.attenzione - a.c.attenzione || b.items.length - a.items.length || a.name.localeCompare(b.name));
  }, [data, q, filter, kind, showDismissed, by]);
  const current = groups.find((g) => g.id === sel) ?? groups[0] ?? null;

  const all = data ? data.findings.filter((f) => !f.dismissedUntil) : [];
  const c = counts(all);
  const kpi = (key, label, value, cls) => html`
    <button key=${key} type="button" class=${`ia-kpi ${cls}${filter === key ? ' on' : ''}`} onClick=${() => reset(setFilter)(filter === key ? 'problemi' : key)}>
      <span class="ia-kpi-value">${value}</span><span class="ia-kpi-label">${label}</span>
    </button>
  `;

  const detail = () => {
    if (error) return html`<${Notice} kind="bad">${error}<//>`;
    if (!data) return html`<div class="ia-empty">Caricamento…</div>`;
    if (!current) return html`<div class="ia-empty">${data.findings.length ? 'Nessun avviso con questi filtri.' : 'Nessun problema trovato: la rete è in ordine.'}</div>`;
    const g = current;
    const own = g.items.filter((f) => !f.cpe);
    const cpes = g.items.filter((f) => f.cpe);
    const runs = by === 'ap' ? opt.runs.filter((r) => live(r) && r.apId === g.id) : [];
    const card = (f) => html`
      <${ApCard}
        key=${f.id}
        f=${f}
        canOptimize=${OPTIMIZABLE.has(f.kind) && opt.enabled}
        isOpen=${open.has(f.id)}
        onOpen=${() => setOpenFor(f.id, true)}
        onClose=${() => setOpenFor(f.id, false)}
        onDone=${async () => (setOpenFor(f.id, false), await load())}
        onDismiss=${dismiss}
      />
    `;
    return html`
      <header class="ia-detail-head">
        <div>
          <h2>${g.name} ${by === 'ap' ? html`<${OptTag} runs=${opt.runs} apId=${g.id} />` : null}</h2>
          <p class="small muted">
            ${by === 'ap'
              ? `${g.items.length} ${g.items.length === 1 ? 'avviso' : 'avvisi'} · ${own.length} sull’AP, ${cpes.length} sulle CPE`
              : `${g.items.length} avvisi su ${new Set(g.items.map((f) => f.apId)).size} AP`}
          </p>
        </div>
        <${Pills} c=${g.c} />
      </header>
      ${runs.map((r) => html`<${LiveRun} key=${r.id} r=${r} onCancel=${cancelRun} />`)}
      ${own.length ? html`<div class="ia-section"><h3 class="ia-section-title">${by === 'ap' ? 'AP' : 'Sugli AP'}</h3>${own.map(card)}</div>` : null}
      ${cpes.length
        ? by === 'ap'
          ? html`<div class="ia-section">
              <h3 class="ia-section-title">CPE (${cpes.length})</h3>
              <${CpeTable} fs=${cpes} withAp=${false} onDismiss=${dismiss} />
              <h4 class="ia-legend-title">Cosa fare</h4>
              <${TodoLegend} fs=${cpes} />
            </div>`
          : html`<div class="ia-section">
              <h3 class="ia-section-title">Sulle CPE (${cpes.length})</h3>
              <p class="ia-todo"><b>Cosa fare </b>${cpes[0].action}</p>
              <${CpeTable} fs=${cpes} withAp=${true} onAp=${(id) => select('ap', id)} onDismiss=${dismiss} />
            </div>`
        : null}
    `;
  };

  return html`
    <div class="ia-page">
      <${PageHead} title="IA-AP" subtitle="Problemi di AP e CPE trovati ogni ora da UISP (stazioni, statistiche della settimana, spettro di AP e CPE) e dal modello di copertura, con cosa fare.">
        <${BusyButton} onClick=${refresh}>Aggiorna ora<//>
      <//>
      <p class="small muted ia-meta">
        ${!data
          ? ''
          : data.at
            ? `Ultima analisi ${fmtDate(data.at)}${data.loadAt ? ` · dati UISP ${fmtDate(data.loadAt)}` : ''} · canali proposti tra ${data.range.from} e ${data.range.to} MHz`
            : 'Nessuna analisi ancora: parte con il primo aggiornamento orario dei dati di UISP, o con Aggiorna ora.'}
      </p>
      ${data
        ? html`<div class="ia-kpis">
            ${kpi('critico', 'Critici', c.critico, 'bad')} ${kpi('attenzione', 'Da guardare', c.attenzione, 'warn')} ${kpi('info', 'Suggerimenti', c.info, 'info')}
            <div class="ia-kpi plain">
              <span class="ia-kpi-value">${new Set(all.map((f) => f.apId)).size}</span>
              <span class="ia-kpi-label">AP coinvolti su ${new Set(data.findings.map((f) => f.apId)).size}</span>
            </div>
          </div>`
        : null}
      <${Optimizer} opt=${opt} onCancel=${cancelRun} />
      <div class="ia-toolbar">
        <input type="search" placeholder="Cerca AP o CPE…" class="ia-search" value=${q} onInput=${(e) => reset(setQ)(e.target.value)} />
        <${Segmented} label="Gravità" options=${FILTERS.map(([k, l]) => [k, l])} value=${filter} onChange=${reset(setFilter)} />
        <select aria-label="Tipo di problema" value=${kind} onChange=${(e) => reset(setKind)(e.target.value)}>
          <option value="">Tutti i tipi</option>
          ${Object.entries(KINDS).map(([k, l]) => html`<option key=${k} value=${k}>${l}</option>`)}
        </select>
        <${Segmented} label="Raggruppa" options=${GROUP_BY} value=${by} onChange=${reset(setBy)} />
        <label class="check small"><input type="checkbox" checked=${showDismissed} onChange=${(e) => setShowDismissed(e.target.checked)} />Ignorati</label>
      </div>
      <div class="ia-layout">
        <nav class="ia-list" aria-label="Elenco">
          <div class="ia-list-head small muted">${groups.length} ${by === 'ap' ? 'AP' : groups.length === 1 ? 'tipo' : 'tipi'}</div>
          ${groups.map(
            (g) => html`
              <button key=${g.id} type="button" class=${`ia-item${g === current ? ' on' : ''}`} aria-current=${g === current ? 'true' : 'false'} onClick=${() => select(by, g.id)}>
                <span class="ia-item-top"><span class="ia-item-name">${g.name}</span><${Pills} c=${g.c} /></span>
                <span class="ia-item-sub">${by === 'ap' ? g.items[0].title : `${new Set(g.items.map((f) => f.apId)).size} AP · ${g.items.filter((f) => f.cpe).length} CPE`}</span>
                ${by === 'ap' ? html`<${OptTag} runs=${opt.runs} apId=${g.id} />` : null}
              </button>
            `,
          )}
        </nav>
        <section class="ia-detail" ref=${detailRef}>${detail()}</section>
      </div>
    </div>
  `;
}

export const advisorView = () => reactView(AdvisorPage);
