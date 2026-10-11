import { api } from '../api.js';
import { badge, busy, card, field, fmtDate, h, mount, pageHead, toast } from '../dom.js';

const SEV = {
  critico: { label: 'Critico', plural: 'Critici', cls: 'bad', rank: 0 },
  attenzione: { label: 'Da guardare', plural: 'Da guardare', cls: 'warn', rank: 1 },
  info: { label: 'Suggerimento', plural: 'Suggerimenti', cls: 'info', rank: 2 },
};
const KINDS = {
  busy: 'Carico serale',
  mcs: 'Modulazione',
  snr: 'SNR basso',
  airtime: 'Airtime eccessivo',
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
/** Coloured counters of a group (only the non-zero ones). */
const pills = (c) =>
  h(
    'span',
    { class: 'ia-pills' },
    ['critico', 'attenzione', 'info'].filter((s) => c[s]).map((s) => h('span', { class: `ia-pill ${SEV[s].cls}`, title: SEV[s].plural }, String(c[s]))),
  );
const sevTag = (s) => h('span', { class: `ia-sev ${SEV[s].cls}` }, SEV[s].label);

/**
 * IA-AP (admins): what to fix on APs and CPEs, from UISP (stations, a week of statistics, the
 * spectrum measured by APs and CPEs) and the coverage model, refreshed every hour. Two panes on wide
 * screens: the APs (or the kinds of problem) on the left, the selected one on the right.
 */
export async function advisorView() {
  const state = { filter: 'problemi', kind: '', q: '', dismissed: false, by: 'ap', sel: null };
  const q = h('input', { type: 'search', placeholder: 'Cerca AP o CPE…', class: 'ia-search' });
  const kind = h('select', { 'aria-label': 'Tipo di problema' }, h('option', { value: '' }, 'Tutti i tipi'), ...Object.entries(KINDS).map(([k, l]) => h('option', { value: k }, l)));
  const dismissedBox = h('input', { type: 'checkbox' });
  const meta = h('p', { class: 'small muted ia-meta' });
  const kpis = h('div', { class: 'ia-kpis' });
  const optBox = h('div', {});
  const filters = h('div', { class: 'ia-seg', role: 'group', 'aria-label': 'Gravità' });
  const byBox = h('div', { class: 'ia-seg', role: 'group', 'aria-label': 'Raggruppa' });
  const listBox = h('nav', { class: 'ia-list', 'aria-label': 'Elenco' });
  const detail = h('section', { class: 'ia-detail' });
  const open = new Set();
  let data = null;
  let opt = { enabled: false, active: null, runs: [] };
  let poll = null;

  const load = async () => {
    [data, opt] = await Promise.all([api('/api/admin/advisor'), api('/api/admin/advisor/optimizer').catch(() => opt)]);
    render();
    // while an optimisation runs, its progress every 15 s (only while this page is open)
    clearTimeout(poll);
    const now = new Date().toISOString();
    if (opt.runs.some((r) => r.state === 'in_corso' || (r.state === 'programmato' && r.startAt <= now))) {
      poll = setTimeout(() => (detail.isConnected ? load().catch(() => {}) : null), 15_000);
    }
  };

  const dismiss = (f, days, el) =>
    busy(el, async () => {
      await api('/api/admin/advisor/dismiss', { method: 'POST', body: { id: f.id, days } });
      toast(days ? `Ignorato per ${days} giorni` : 'Di nuovo visibile');
      await load();
    });
  /** One menu instead of three buttons: ignore for 7, 30 or 90 days (or show again). */
  const ignoreControl = (f) => {
    if (f.dismissedUntil) return h('button', { type: 'button', class: 'small-btn', onclick: (e) => dismiss(f, 0, e.currentTarget) }, 'Mostra di nuovo');
    const s = h('select', { class: 'ia-ignore', 'aria-label': 'Ignora' }, h('option', { value: '' }, 'Ignora…'), ...[7, 30, 90].map((d) => h('option', { value: d }, `${d} giorni`)));
    s.onchange = () => s.value && dismiss(f, Number(s.value), s);
    return s;
  };
  const cancelRun = (r, btn) =>
    busy(btn, async () => {
      await api(`/api/admin/advisor/optimizer/${encodeURIComponent(r.id)}/cancel`, { method: 'POST', body: {} });
      toast(r.state === 'in_corso' ? 'Annullamento: l’AP torna al canale iniziale' : 'Annullata');
      await load();
    });

  // ---- optimisation -------------------------------------------------------------------------
  const runState = (r) => (r.outcome ? OUTCOME[r.outcome] : [r.state === 'in_corso' ? 'In corso' : `Programmata ${fmtDate(r.startAt)}`, 'warn']);
  const liveRun = (r) =>
    h(
      'div',
      { class: 'ia-run' },
      h('div', { class: 'ia-run-head' }, badge(...runState(r)), h('b', {}, r.apName), h('span', { class: 'small muted' }, `${r.mode === 'suggested' ? 'canale consigliato' : 'ricerca del canale migliore'} · ${r.original ? `${ch(r.original)} → ` : 'prova '}${r.candidates.map(ch).join(', ')} · da ${r.by}`)),
      h('div', { class: 'small' }, r.step),
      r.missing.length ? h('div', { class: 'notice bad small' }, `CPE non riagganciate: ${r.missing.join(', ')}`) : null,
      h('div', {}, h('button', { type: 'button', class: 'small-btn', onclick: (e) => cancelRun(r, e.currentTarget) }, r.state === 'in_corso' ? 'Annulla e ripristina' : 'Annulla')),
    );
  const historyTable = (runs) =>
    h(
      'table',
      { class: 'ia-table' },
      h('thead', {}, h('tr', {}, ...['Quando', 'AP', 'Esito', 'Canale', 'Prove', 'Da'].map((t) => h('th', {}, t)))),
      h(
        'tbody',
        {},
        runs.map((r) =>
          h(
            'tr',
            {},
            h('td', { class: 'nowrap' }, fmtDate(r.endedAt ?? r.requestedAt)),
            h('td', {}, r.apName),
            h('td', {}, badge(...runState(r)), r.error ? h('div', { class: 'small muted' }, r.error) : null),
            h('td', { class: 'nowrap' }, `${ch(r.original)}${r.kept ? ` → ${ch(r.kept)}` : ''}`),
            h('td', { class: 'small' }, r.results.length ? r.results.map((t) => `${ch(t)}: ${VERDICT[t.verdict] ?? t.verdict}, capacità ${pct(t.capacityRatio)}`).join(' · ') : '—'),
            h('td', {}, r.by),
          ),
        ),
      ),
    );
  function renderOptimizer() {
    const live = opt.runs.filter((r) => r.state === 'in_corso' || r.state === 'programmato');
    const past = opt.runs.filter((r) => !live.includes(r));
    if (!opt.enabled && !opt.runs.length) return mount(optBox);
    mount(
      optBox,
      card(
        h('div', { class: 'ia-card-head' }, h('h2', {}, 'Ottimizzazione automatica'), badge(opt.enabled ? 'attiva' : 'spenta', opt.enabled ? 'good' : '')),
        live.length ? live.map(liveRun) : h('p', { class: 'small muted' }, opt.enabled ? 'Nessuna in corso. Si avvia da un avviso di un AP con Ottimizza….' : 'Spenta in Impostazioni server → Assistente rete: l’assistente dà solo consigli.'),
        past.length ? h('details', { class: 'ia-history' }, h('summary', {}, `Storico (${past.length})`), historyTable(past)) : null,
      ),
    );
  }

  /** The confirmation of an optimisation: what, when, and what the customers will notice. */
  const optimizePanel = (f) => {
    const mode = h(
      'select',
      {},
      f.params?.frequenza !== undefined ? h('option', { value: 'suggested' }, `Prova il canale consigliato (${f.params.frequenza}/${f.params.ampiezza} MHz)`) : null,
      h('option', { value: 'search' }, 'Cerca il canale migliore (fino a 3 prove)'),
    );
    const when = h('select', {}, h('option', { value: 'night' }, 'Stanotte alle 3:00 (consigliato)'), h('option', { value: 'now' }, 'Adesso'));
    const go = h('button', { type: 'button', class: 'primary' }, 'Conferma');
    go.onclick = () =>
      busy(go, async () => {
        await api('/api/admin/advisor/optimizer', { method: 'POST', body: { findingId: f.id, mode: mode.value, when: when.value, confirm: true } });
        toast(when.value === 'now' ? 'Ottimizzazione avviata' : 'Ottimizzazione programmata per stanotte');
        open.delete(f.id);
        await load();
      });
    return h(
      'div',
      { class: 'ia-confirm' },
      h('p', { class: 'small' }, OPTIMIZE_TEXT(f.apName)),
      h('div', { class: 'row' }, field('Cosa', mode), field('Quando', when)),
      h('div', { class: 'btns' }, go, h('button', { type: 'button', onclick: () => (open.delete(f.id), render()) }, 'Annulla')),
    );
  };

  // ---- findings -----------------------------------------------------------------------------
  /** A finding of the AP itself: a card with what was measured, what to do and the actions. */
  const apCard = (f) =>
    h(
      'article',
      { class: `ia-card ${SEV[f.severity].cls}${f.dismissedUntil ? ' dismissed' : ''}` },
      h('div', { class: 'ia-card-head' }, sevTag(f.severity), h('h3', {}, f.title), h('span', { class: 'small muted ia-kind' }, KINDS[f.kind] ?? f.kind)),
      h('p', {}, f.detail),
      h('p', { class: 'ia-todo' }, h('b', {}, 'Cosa fare '), f.action),
      f.params ? h('div', { class: 'ia-params' }, Object.entries(f.params).map(([k, v]) => h('span', { class: 'ia-chip' }, `${PARAM[k]?.[0] ?? k} `, h('b', {}, PARAM[k] ? PARAM[k][1](v) : String(v))))) : null,
      h(
        'div',
        { class: 'ia-card-foot' },
        h('span', { class: 'small muted' }, `dal ${fmtDate(f.since)}${f.dismissedUntil ? ` · ignorato fino al ${fmtDate(f.dismissedUntil)}` : ''}`),
        h(
          'span',
          { class: 'ia-actions' },
          OPTIMIZABLE.has(f.kind) && opt.enabled && !open.has(f.id) && !f.dismissedUntil ? h('button', { type: 'button', class: 'small-btn', onclick: () => (open.add(f.id), render()) }, 'Ottimizza…') : null,
          ignoreControl(f),
        ),
      ),
      open.has(f.id) ? optimizePanel(f) : null,
    );

  /** CPE findings as a table; [withAp] adds the AP column (view by kind). */
  const cpeTable = (fs, withAp) =>
    h(
      'div',
      { class: 'ia-table-wrap' },
      h(
        'table',
        { class: 'ia-table' },
        h('thead', {}, h('tr', {}, ...['Gravità', ...(withAp ? ['AP'] : []), 'CPE', 'Problema', 'Dettaglio', 'Dal', ''].map((t) => h('th', {}, t)))),
        h(
          'tbody',
          {},
          fs.map((f) =>
            h(
              'tr',
              { class: f.dismissedUntil ? 'dismissed' : '' },
              h('td', {}, sevTag(f.severity)),
              withAp ? h('td', {}, h('button', { type: 'button', class: 'ia-link', onclick: () => select('ap', f.apId) }, f.apName)) : null,
              h('td', { class: 'ia-cpe' }, f.cpe ? (f.cpe.id ? h('a', { href: `#/cpe?id=${encodeURIComponent(f.cpe.id)}`, title: 'Gestisci CPE' }, f.cpe.name) : f.cpe.name) : h('span', { class: 'muted' }, 'AP')),
              h('td', { class: 'ia-problem' }, f.title),
              h('td', { class: 'small muted' }, f.detail),
              h('td', { class: 'small nowrap' }, fmtDate(f.since)),
              h('td', { class: 'nowrap' }, ignoreControl(f)),
            ),
          ),
        ),
      ),
    );
  /** "Cosa fare" once per kind (the same advice for every CPE with that problem). */
  const todoLegend = (fs) => {
    const kinds = [...new Map(fs.map((f) => [f.kind, f])).values()];
    return kinds.length ? h('dl', { class: 'ia-legend' }, kinds.flatMap((f) => [h('dt', {}, KINDS[f.kind] ?? f.kind), h('dd', {}, f.action)])) : null;
  };

  // ---- groups, list and detail --------------------------------------------------------------
  const visible = () => {
    const needle = state.q.trim().toLowerCase();
    const pass = FILTERS.find(([k]) => k === state.filter)[2];
    return data.findings.filter(
      (f) =>
        (state.dismissed || !f.dismissedUntil) &&
        pass(f) &&
        (!state.kind || f.kind === state.kind) &&
        (!needle || f.apName.toLowerCase().includes(needle) || (f.cpe?.name ?? '').toLowerCase().includes(needle)),
    );
  };
  const groupsOf = (fs) => {
    const key = state.by === 'ap' ? (f) => f.apId : (f) => f.kind;
    const m = new Map();
    for (const f of fs) m.set(key(f), [...(m.get(key(f)) ?? []), f]);
    return [...m.entries()]
      .map(([id, items]) => ({ id, items: items.sort(bySeverity), c: counts(items), name: state.by === 'ap' ? items[0].apName : (KINDS[id] ?? id) }))
      .sort((a, b) => b.c.critico - a.c.critico || b.c.attenzione - a.c.attenzione || b.items.length - a.items.length || a.name.localeCompare(b.name));
  };
  /** The optimisation of an AP, running or scheduled, as a tag in the list. */
  function optTag(apId) {
    const r = opt.runs.find((x) => x.apId === apId && (x.state === 'in_corso' || x.state === 'programmato'));
    if (!r) return null;
    return h('span', { class: `ia-opt-tag ${r.state === 'in_corso' ? 'running' : ''}` }, r.state === 'in_corso' ? 'Ottimizzazione in corso' : `Ottimizzazione programmata ${fmtDate(r.startAt)}`);
  }

  function select(by, id) {
    state.by = by;
    state.sel = id;
    render();
    // narrow screens: the detail is below the list
    if (matchMedia('(max-width: 1099px)').matches) detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderDetail(g) {
    if (!g) return mount(detail, h('div', { class: 'ia-empty' }, data.findings.length ? 'Nessun avviso con questi filtri.' : 'Nessun problema trovato: la rete è in ordine.'));
    const own = g.items.filter((f) => !f.cpe);
    const cpes = g.items.filter((f) => f.cpe);
    const runs = opt.runs.filter((r) => (r.state === 'in_corso' || r.state === 'programmato') && (state.by === 'ap' ? r.apId === g.id : false));
    mount(
      detail,
      h(
        'header',
        { class: 'ia-detail-head' },
        h('div', {}, h('h2', {}, g.name, ' ', state.by === 'ap' ? optTag(g.id) : null), h('p', { class: 'small muted' }, state.by === 'ap' ? `${g.items.length} ${g.items.length === 1 ? 'avviso' : 'avvisi'} · ${own.length} sull’AP, ${cpes.length} sulle CPE` : `${g.items.length} avvisi su ${new Set(g.items.map((f) => f.apId)).size} AP`)),
        pills(g.c),
      ),
      ...runs.map(liveRun),
      state.by === 'ap'
        ? [
            own.length ? h('div', { class: 'ia-section' }, h('h3', { class: 'ia-section-title' }, 'AP'), own.map(apCard)) : null,
            cpes.length ? h('div', { class: 'ia-section' }, h('h3', { class: 'ia-section-title' }, `CPE (${cpes.length})`), cpeTable(cpes, false), h('h4', { class: 'ia-legend-title' }, 'Cosa fare'), todoLegend(cpes)) : null,
          ]
        : [
            own.length ? h('div', { class: 'ia-section' }, h('h3', { class: 'ia-section-title' }, 'Sugli AP'), own.map(apCard)) : null,
            cpes.length ? h('div', { class: 'ia-section' }, h('h3', { class: 'ia-section-title' }, `Sulle CPE (${cpes.length})`), h('p', { class: 'ia-todo' }, h('b', {}, 'Cosa fare '), cpes[0].action), cpeTable(cpes, true)) : null,
          ],
    );
  }

  function render() {
    if (!data) return;
    const all = data.findings.filter((f) => !f.dismissedUntil);
    const c = counts(all);
    meta.textContent = data.at
      ? `Ultima analisi ${fmtDate(data.at)}${data.loadAt ? ` · dati UISP ${fmtDate(data.loadAt)}` : ''} · canali proposti tra ${data.range.from} e ${data.range.to} MHz`
      : 'Nessuna analisi ancora: parte con il primo aggiornamento orario dei dati di UISP, o con Aggiorna ora.';
    // the counters are also the quickest filter
    const kpi = (key, label, value, cls) =>
      h('button', { type: 'button', class: `ia-kpi ${cls}${state.filter === key ? ' on' : ''}`, onclick: () => ((state.filter = state.filter === key ? 'problemi' : key), (state.sel = null), render()) }, h('span', { class: 'ia-kpi-value' }, String(value)), h('span', { class: 'ia-kpi-label' }, label));
    mount(
      kpis,
      kpi('critico', 'Critici', c.critico, 'bad'),
      kpi('attenzione', 'Da guardare', c.attenzione, 'warn'),
      kpi('info', 'Suggerimenti', c.info, 'info'),
      h('div', { class: 'ia-kpi plain' }, h('span', { class: 'ia-kpi-value' }, String(new Set(all.map((f) => f.apId)).size)), h('span', { class: 'ia-kpi-label' }, `AP coinvolti su ${new Set(data.findings.map((f) => f.apId)).size}`)),
    );
    mount(filters, FILTERS.map(([k, l]) => h('button', { type: 'button', class: state.filter === k ? 'on' : '', 'aria-pressed': state.filter === k ? 'true' : 'false', onclick: () => ((state.filter = k), (state.sel = null), render()) }, l)));
    mount(byBox, [['ap', 'Per AP'], ['kind', 'Per problema']].map(([k, l]) => h('button', { type: 'button', class: state.by === k ? 'on' : '', 'aria-pressed': state.by === k ? 'true' : 'false', onclick: () => ((state.by = k), (state.sel = null), render()) }, l)));
    renderOptimizer();

    const groups = groupsOf(visible());
    const sel = groups.find((g) => g.id === state.sel) ?? groups[0];
    state.sel = sel?.id ?? null;
    mount(
      listBox,
      h('div', { class: 'ia-list-head small muted' }, `${groups.length} ${state.by === 'ap' ? (groups.length === 1 ? 'AP' : 'AP') : groups.length === 1 ? 'tipo' : 'tipi'}`),
      groups.map((g) =>
        h(
          'button',
          { type: 'button', class: `ia-item${g === sel ? ' on' : ''}`, 'aria-current': g === sel ? 'true' : 'false', onclick: () => select(state.by, g.id) },
          h('span', { class: 'ia-item-top' }, h('span', { class: 'ia-item-name' }, g.name), pills(g.c)),
          h('span', { class: 'ia-item-sub' }, state.by === 'ap' ? g.items[0].title : `${new Set(g.items.map((f) => f.apId)).size} AP · ${g.items.filter((f) => f.cpe).length} CPE`),
          state.by === 'ap' ? optTag(g.id) : null,
        ),
      ),
    );
    renderDetail(sel);
  }

  q.oninput = () => ((state.q = q.value), (state.sel = null), render());
  kind.onchange = () => ((state.kind = kind.value), (state.sel = null), render());
  dismissedBox.onchange = () => ((state.dismissed = dismissedBox.checked), render());
  const refresh = h('button', { type: 'button' }, 'Aggiorna ora');
  refresh.onclick = () =>
    busy(refresh, async () => {
      await api('/api/admin/advisor/refresh', { method: 'POST', body: {} });
      toast('Aggiornamento avviato: i dati di UISP arrivano in uno o due minuti.');
      setTimeout(() => load().catch(() => {}), 120_000);
    });

  try {
    await load();
  } catch (e) {
    mount(detail, h('div', { class: 'notice bad' }, e.message));
  }
  return h(
    'div',
    { class: 'ia-page' },
    pageHead('IA-AP', 'Problemi di AP e CPE trovati ogni ora da UISP (stazioni, statistiche della settimana, spettro di AP e CPE) e dal modello di copertura, con cosa fare.', refresh),
    meta,
    kpis,
    optBox,
    h('div', { class: 'ia-toolbar' }, q, filters, kind, byBox, h('label', { class: 'check small' }, dismissedBox, 'Ignorati')),
    h('div', { class: 'ia-layout' }, listBox, detail),
  );
}
