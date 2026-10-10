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
  let data = null;

  const load = async () => {
    data = await api('/api/admin/advisor');
    render();
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
        f.dismissedUntil
          ? h('button', { type: 'button', class: 'small-btn', onclick: (e) => dismiss(f, 0, e.currentTarget) }, 'Mostra di nuovo')
          : [
              h('button', { type: 'button', class: 'small-btn', onclick: (e) => dismiss(f, 7, e.currentTarget) }, 'Ignora 7 giorni'),
              h('button', { type: 'button', class: 'small-btn', onclick: (e) => dismiss(f, 90, e.currentTarget) }, 'Ignora 90 giorni'),
            ],
      ),
    );

  function render() {
    if (!data) return;
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
    card(h('div', { class: 'row' }, field('Gravità', severity), field('Tipo', kind), field('Cerca', q)), h('label', { class: 'small' }, showDismissed, ' mostra anche gli avvisi ignorati')),
    list,
  );
}
