import { api } from '../api.js';
import { badge, busy, card, field, fmtDate, h, mount, pageHead, stat, toast } from '../dom.js';

/** Severity → badge colour; kind → label of the filter. */
const SEVERITY = { critico: ['critico', 'bad'], attenzione: ['attenzione', 'warn'], info: ['info', ''] };
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

/** Findings of an AP that a channel change can fix: the automatic optimisation can start from them. */
const OPTIMIZABLE = new Set(['channel', 'width', 'cochannel', 'noise', 'mcs']);
const OUTCOME = {
  migliorato: ['canale migliore tenuto', 'good'],
  ripristinato: ['nessun miglioramento, ripristinato', ''],
  cpe_mancanti: ['CPE non riagganciate, ripristinato', 'warn'],
  ripristino_incompleto: ['CPE ancora mancanti dopo il ripristino', 'bad'],
  annullato: ['annullato', ''],
  interrotto: ['interrotto dal riavvio, ripristinato', 'warn'],
  errore: ['non riuscito', 'bad'],
};
const VERDICT = { migliore: 'migliore', peggiore: 'peggiore', uguale: 'nessuna differenza', cpe_mancanti: 'CPE mancanti' };
/** What the admin accepts before an optimisation starts. */
const OPTIMIZE_TEXT = (ap) =>
  `L’IA-AP cambierà il canale di ${ap} tramite UISP. A ogni prova le CPE si sganciano per circa un minuto; dopo ogni cambio aspetta che tornino tutte, misura per qualche minuto e confronta con prima. Tiene un canale solo se la capacità sale di almeno il 5% senza peggiorare SNR e cliente più debole; altrimenti, o se una CPE non torna entro 5 minuti, rimette il canale iniziale e avvisa gli admin. Circa 10 minuti per prova.`;
const ch = (c) => (c ? `${c.centre}/${c.width} MHz` : '—');
const pct = (r) => (r === null || r === undefined ? '' : ` · capacità ${r >= 1 ? '+' : ''}${Math.round((r - 1) * 100)}%`);

/**
 * IA-AP (admins): what to fix on APs and CPEs, from UISP (stations, a week of statistics, the
 * spectrum measured by APs and CPEs) and the coverage model. Refreshed every hour; the NOC gets a
 * notification when new critical problems appear.
 */
export async function advisorView() {
  const severity = h('select', {}, h('option', { value: '' }, 'Tutte'), ...Object.entries(SEVERITY).map(([k, [l]]) => h('option', { value: k }, l)));
  const kind = h('select', {}, h('option', { value: '' }, 'Tutti'), ...Object.entries(KINDS).map(([k, l]) => h('option', { value: k }, l)));
  const q = h('input', { placeholder: 'Nome dell’AP o della CPE…' });
  const showDismissed = h('input', { type: 'checkbox' });
  const summary = h('div', {});
  const list = h('div', {});
  const optBox = h('div', {});
  let data = null;
  let opt = { enabled: false, active: null, runs: [] };
  let poll = null;
  const open = new Set();

  const load = async () => {
    [data, opt] = await Promise.all([api('/api/admin/advisor'), api('/api/admin/advisor/optimizer').catch(() => opt)]);
    render();
    // while an optimisation runs, its progress every 15 s (only while this page is open)
    clearTimeout(poll);
    const now = new Date().toISOString();
    if (opt.runs.some((r) => r.state === 'in_corso' || (r.state === 'programmato' && r.startAt <= now))) {
      poll = setTimeout(() => (optBox.isConnected ? load().catch(() => {}) : null), 15_000);
    }
  };

  const cancelRun = (r, btn) =>
    busy(btn, async () => {
      await api(`/api/admin/advisor/optimizer/${encodeURIComponent(r.id)}/cancel`, { method: 'POST', body: {} });
      toast(r.state === 'in_corso' ? 'Annullamento: l’AP torna al canale iniziale' : 'Annullata');
      await load();
    });

  const runRow = (r) => {
    const [label, kind] = r.outcome ? OUTCOME[r.outcome] : [r.state === 'in_corso' ? 'in corso' : `programmata ${fmtDate(r.startAt)}`, 'warn'];
    return h(
      'div',
      { class: 'advice' },
      h('div', { class: 'row' }, badge(label, kind), ' ', h('b', {}, r.apName), h('span', { class: 'small muted' }, ` · ${r.mode === 'suggested' ? 'canale consigliato' : 'ricerca del canale migliore'} · da ${r.by}`)),
      h('div', { class: 'small' }, `Canale iniziale ${ch(r.original)}; da provare: ${r.candidates.map(ch).join(', ')}${r.kept ? ` · tenuto ${ch(r.kept)}` : ''}`),
      r.state === 'in_corso' || r.state === 'programmato' ? h('div', { class: 'small' }, h('b', {}, 'Ora: '), r.step) : null,
      r.baseline ? h('div', { class: 'small muted' }, `Prima: ${r.baseline.stations} CPE, capacità ${r.baseline.capacityMbps} Mbit/s, SNR mediano ${r.baseline.medianSnrDb ?? '—'} dB, più debole ${r.baseline.weakestDbm ?? '—'} dBm`) : null,
      ...r.results.map((t) => h('div', { class: 'small' }, `${ch(t)}: ${VERDICT[t.verdict] ?? t.verdict}${pct(t.capacityRatio)}, SNR ${t.after.medianSnrDb ?? '—'} dB, più debole ${t.after.weakestDbm ?? '—'} dBm${t.missing.length ? ` · mancano: ${t.missing.join(', ')}` : ''}`)),
      r.missing.length ? h('div', { class: 'notice bad small' }, `CPE non riagganciate: ${r.missing.join(', ')}`) : null,
      r.error ? h('div', { class: 'small muted' }, r.error) : null,
      r.state === 'in_corso' || r.state === 'programmato'
        ? h('div', { class: 'btns' }, h('button', { type: 'button', class: 'small-btn', onclick: (e) => cancelRun(r, e.currentTarget) }, r.state === 'in_corso' ? 'Annulla e ripristina' : 'Annulla'))
        : h('div', { class: 'small muted' }, `${fmtDate(r.requestedAt)} → ${fmtDate(r.endedAt)}`),
    );
  };

  /** The confirmation of an optimisation: what, when, and what the customers will notice. */
  const optimizePanel = (f) => {
    const hasChannel = f.params?.frequenza !== undefined;
    const mode = h(
      'select',
      {},
      hasChannel ? h('option', { value: 'suggested' }, `Prova il canale consigliato (${f.params.frequenza}/${f.params.ampiezza} MHz)`) : null,
      h('option', { value: 'search' }, 'Cerca il canale migliore (fino a 3 prove)'),
    );
    const when = h('select', {}, h('option', { value: 'night' }, 'Stanotte alle 3:00 (consigliato)'), h('option', { value: 'now' }, 'Adesso'));
    const go = h('button', { type: 'button' }, 'Conferma e programma');
    go.onclick = () =>
      busy(go, async () => {
        await api('/api/admin/advisor/optimizer', { method: 'POST', body: { findingId: f.id, mode: mode.value, when: when.value, confirm: true } });
        toast(when.value === 'now' ? 'Ottimizzazione avviata' : 'Ottimizzazione programmata per stanotte');
        open.delete(f.id);
        await load();
      });
    return h(
      'div',
      { class: 'notice warn' },
      h('p', { class: 'small' }, OPTIMIZE_TEXT(f.apName)),
      h('div', { class: 'row' }, field('Cosa', mode), field('Quando', when)),
      h('div', { class: 'btns' }, go, h('button', { type: 'button', class: 'small-btn', onclick: () => { open.delete(f.id); render(); } }, 'Annulla')),
    );
  };

  const dismiss = (f, days, btn) =>
    busy(btn, async () => {
      await api('/api/admin/advisor/dismiss', { method: 'POST', body: { id: f.id, days } });
      toast(days ? `Ignorato per ${days} giorni` : 'Di nuovo visibile');
      await load();
    });

  const findingRow = (f) =>
    h(
      'div',
      { class: `advice${f.dismissedUntil ? ' muted' : ''}` },
      h('div', { class: 'row' }, badge(...SEVERITY[f.severity]), ' ', h('b', {}, f.title), f.cpe ? h('span', { class: 'small muted' }, ` · ${f.cpe.name}`) : null),
      h('div', { class: 'small' }, f.detail),
      h('div', { class: 'small' }, h('b', {}, 'Cosa fare: '), f.action),
      f.params ? h('div', { class: 'small mono' }, Object.entries(f.params).map(([k, v]) => `${k} ${v}`).join(' · ')) : null,
      h(
        'div',
        { class: 'btns' },
        h('span', { class: 'small muted' }, `dal ${fmtDate(f.since)}${f.dismissedUntil ? ` · ignorato fino al ${fmtDate(f.dismissedUntil)}` : ''}`),
        f.cpe?.id ? h('a', { class: 'button-link small-btn', href: `#/cpe?id=${encodeURIComponent(f.cpe.id)}` }, 'Gestisci CPE') : null,
        !f.cpe && OPTIMIZABLE.has(f.kind) && opt.enabled && !open.has(f.id)
          ? h('button', { type: 'button', class: 'small-btn', onclick: () => { open.add(f.id); render(); } }, 'Ottimizza…')
          : null,
        f.dismissedUntil
          ? h('button', { type: 'button', class: 'small-btn', onclick: (e) => dismiss(f, 0, e.currentTarget) }, 'Mostra di nuovo')
          : [
              h('button', { type: 'button', class: 'small-btn', onclick: (e) => dismiss(f, 7, e.currentTarget) }, 'Ignora 7 giorni'),
              h('button', { type: 'button', class: 'small-btn', onclick: (e) => dismiss(f, 90, e.currentTarget) }, 'Ignora 90 giorni'),
            ],
      ),
      open.has(f.id) ? optimizePanel(f) : null,
    );

  function render() {
    if (!data) return;
    const live = opt.runs.filter((r) => r.state === 'in_corso' || r.state === 'programmato');
    const past = opt.runs.filter((r) => !live.includes(r));
    mount(
      optBox,
      card(
        h('h2', {}, 'Ottimizzazione automatica'),
        opt.enabled
          ? h('p', { class: 'small muted' }, 'Dagli avvisi di un AP (canale, ampiezza, rumore, modulazione), Ottimizza… prova il canale tramite UISP e lo tiene solo se è davvero migliore. Un AP alla volta.')
          : h('p', { class: 'small muted' }, 'Spenta: l’assistente dà solo consigli. Si accende in Impostazioni server → Assistente rete.'),
        ...live.map(runRow),
        past.length ? h('details', {}, h('summary', { class: 'small' }, `Ultime ottimizzazioni (${past.length})`), ...past.map(runRow)) : null,
      ),
    );
    const needle = q.value.trim().toLowerCase();
    const visible = data.findings.filter(
      (f) =>
        (showDismissed.checked || !f.dismissedUntil) &&
        (!severity.value || f.severity === severity.value) &&
        (!kind.value || f.kind === kind.value) &&
        (!needle || f.apName.toLowerCase().includes(needle) || (f.cpe?.name ?? '').toLowerCase().includes(needle)),
    );
    const open = data.findings.filter((f) => !f.dismissedUntil);
    const n = (s) => open.filter((f) => f.severity === s).length;
    mount(
      summary,
      card(
        h('div', { class: 'grid' }, stat('Critici', String(n('critico'))), stat('Da guardare', String(n('attenzione'))), stat('Suggerimenti', String(n('info'))), stat('AP coinvolti', String(new Set(open.map((f) => f.apId)).size))),
      h('p', { class: 'small muted' }, data.at ? `Ultima analisi ${fmtDate(data.at)}${data.loadAt ? ` (dati UISP ${fmtDate(data.loadAt)})` : ''}. Canali proposti tra ${data.range.from} e ${data.range.to} MHz (Impostazioni server → Assistente rete).` : 'Nessuna analisi ancora: parte con il primo aggiornamento orario del carico degli AP, o con Aggiorna ora.'),
      ),
    );
    // grouped by AP: the AP's own findings first, then its CPEs
    const byAp = new Map();
    for (const f of visible) byAp.set(f.apId, [...(byAp.get(f.apId) ?? []), f]);
    mount(
      list,
      visible.length
        ? [...byAp.values()].map((fs) =>
            card(
              h('h2', {}, fs[0].apName, h('span', { class: 'small muted' }, ` · ${fs.length} ${fs.length === 1 ? 'avviso' : 'avvisi'}`)),
              ...fs.filter((f) => !f.cpe).map(findingRow),
              fs.some((f) => f.cpe) ? h('h3', {}, 'CPE') : null,
              ...fs.filter((f) => f.cpe).map(findingRow),
            ),
          )
        : card(h('p', { class: 'muted' }, data.findings.length ? 'Nessun avviso con questi filtri.' : 'Nessun problema trovato.')),
    );
  }

  for (const el of [severity, kind, showDismissed]) el.onchange = render;
  q.oninput = render;
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
    mount(list, h('div', { class: 'notice bad' }, e.message));
  }
  return h(
    'div',
    {},
    pageHead('IA-AP', 'Assistente della rete: AP e CPE da sistemare, dai dati di UISP (stazioni, statistiche della settimana, spettro misurato da AP e CPE) e dal modello di copertura. Si aggiorna ogni ora; il NOC riceve una notifica per i nuovi problemi critici.', refresh),
    summary,
    optBox,
    card(h('div', { class: 'row' }, field('Gravità', severity), field('Tipo', kind), field('Cerca', q)), h('label', { class: 'small' }, showDismissed, ' mostra anche gli avvisi ignorati')),
    list,
  );
}
