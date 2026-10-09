import { api, download } from '../api.js';
import { isOn } from '../modules.js';
import { badge, busy, card, field, fmtDate, h, mount, pageHead, stat, table, toast } from '../dom.js';
import { nms } from '../terms.js';

const ISSUES = {
  offline: ['offline', 'bad'],
  not_in_uisp: ['non trovata in rete', 'bad'],
  weak_signal: ['segnale debole', 'bad'],
  signal_drop: ['segnale calato', 'warn'],
  ethernet: ['porta LAN', 'warn'],
  pending: ['da accettare', 'warn'],
  low_capacity: ['capacità bassa', 'warn'],
  firmware: ['firmware', ''],
};

/**
 * Salute CPE. Admins: every customer CPE in UISP (installed with the app or not), with the
 * assignment of CPEs to installers. Installers: the CPEs they installed with the app plus those
 * assigned to them. Current state vs the acceptance test; no PPPoE data, no configuration.
 */
export async function healthView({ user }) {
  const admin = user.role === 'admin';
  const out = h('div', {});
  const filter = h(
    'select',
    {},
    h('option', { value: 'issues' }, 'Solo con problemi'),
    h('option', { value: 'all' }, 'Tutte'),
    ...Object.entries(ISSUES).map(([k, [label]]) => h('option', { value: k }, `Solo: ${label}`)),
  );
  const origin = h(
    'select',
    {},
    h('option', { value: '' }, 'Tutte le CPE'),
    h('option', { value: 'app' }, 'Installate con l’app'),
    h('option', { value: 'uisp' }, nms('Solo in UISP (installate prima o senza app)', 'Assegnate a me')),
    ...(admin ? [h('option', { value: 'assigned' }, 'Assegnate a un installatore'), h('option', { value: 'unassigned' }, 'Non assegnate')] : []),
  );
  const q = h('input', { placeholder: 'Cliente, MAC, AP, installatore…' });
  const selected = new Set();
  let data = null;

  const visible = () => {
    const term = q.value.trim().toLowerCase();
    return data.cpes
      .filter((c) => (filter.value === 'all' ? true : filter.value === 'issues' ? c.issues.length > 0 : c.issues.includes(filter.value)))
      .filter((c) => (origin.value === 'app' ? c.source === 'app' : origin.value === 'uisp' ? c.source === 'uisp' : origin.value === 'assigned' ? !!c.assignedTo : origin.value === 'unassigned' ? !c.assignedTo : true))
      .filter((c) => !term || [c.deviceName, c.mac, c.now?.apName, c.installer, c.ssid, c.assignedTo?.username].some((x) => (x ?? '').toLowerCase().includes(term)));
  };

  /** Admin: assign the selected CPEs to an installer (or remove the assignment). */
  function assignBar(rows) {
    const who = h('select', {}, h('option', { value: '' }, '— scegli installatore —'), ...(data.installers ?? []).map((u) => h('option', { value: u.id }, u.username)));
    const count = h('span', { class: 'small' }, `${selected.size} selezionate`);
    const selAll = h('button', { type: 'button' }, `Seleziona tutte le filtrate (${rows.length})`);
    selAll.onclick = () => {
      for (const c of rows) selected.add(c.mac);
      render();
    };
    const none = h('button', { type: 'button' }, 'Deseleziona');
    none.onclick = () => {
      selected.clear();
      render();
    };
    const send = async (userId) => {
      if (!selected.size) throw new Error('Seleziona almeno una CPE');
      await api('/api/admin/cpe-assignments', { method: 'PUT', body: { macs: [...selected], userId } });
      toast(userId ? `${selected.size} CPE assegnate` : `Assegnazione rimossa da ${selected.size} CPE`);
      selected.clear();
      await load();
    };
    const go = h('button', { type: 'button', class: 'primary' }, 'Assegna');
    go.onclick = () =>
      busy(go, () => {
        if (!who.value) throw new Error('Scegli l’installatore');
        return send(Number(who.value));
      });
    const remove = h('button', { type: 'button' }, 'Rimuovi assegnazione');
    remove.onclick = () => busy(remove, () => send(null));
    return card(
      h('h2', {}, 'Assegna CPE agli installatori'),
      h('p', { class: 'small muted' }, 'Le CPE assegnate compaiono in "Le mie CPE" dell’installatore (sito e app), come quelle che ha installato con l’app. Suggerimento: filtra per AP o cliente e usa "Seleziona tutte le filtrate".'),
      h('div', { class: 'btns' }, selAll, none, count),
      h('div', { class: 'row' }, field('Installatore', who)),
      h('div', { class: 'btns' }, go, remove),
    );
  }

  function render() {
    const t = data.totals;
    const rows = visible();
    const check = (c) => {
      const i = h('input', { type: 'checkbox' });
      i.checked = selected.has(c.mac);
      i.onchange = () => {
        if (i.checked) selected.add(c.mac);
        else selected.delete(c.mac);
        render();
      };
      return i;
    };
    mount(
      out,
      card(
        h(
          'div',
          { class: 'grid' },
          stat(admin ? 'CPE clienti' : 'Le mie CPE', t.cpes),
          admin ? stat('Installate con l’app', t.fromApp) : null,
          admin ? stat(nms('Solo in UISP', 'Assegnate'), t.fromUisp) : t.fromUisp ? stat('Assegnate a me', t.fromUisp) : null,
          stat('Senza problemi', `${t.ok} (${t.cpes ? Math.round((t.ok / t.cpes) * 100) : 0}%)`),
          stat('Offline', t.offline),
          stat('Segnale debole', t.weak_signal),
          stat('Segnale calato dal collaudo', t.signal_drop),
          stat('Porta LAN lenta / half', t.ethernet),
          stat(nms('Non trovate in UISP', 'Non trovate in rete'), t.not_in_uisp),
        ),
        h('p', { class: 'small muted' }, `${nms('Stato UISP', 'Stato')} del ${fmtDate(data.generatedAt)}. "Segnale calato": almeno ${data.thresholds.signalDropDb} dB in meno rispetto al collaudo (solo CPE installate con l’app).`),
        data.uisp ? null : h('div', { class: 'notice warn' }, nms('UISP non raggiungibile: stato attuale non disponibile.', 'Stato attuale non disponibile, riprova più tardi.')),
      ),
      admin ? assignBar(rows) : null,
      card(
        h('h2', {}, `CPE (${rows.length})`),
        rows.length
          ? table(
              [
                ...(admin ? [{ label: '', render: check }] : []),
                { label: 'Cliente', render: (c) => h('div', {}, c.deviceName || '—', h('div', { class: 'small muted mono' }, c.mac)) },
                { label: 'Problemi', render: (c) => (c.issues.length ? h('div', { class: 'btns' }, c.issues.map((i) => badge(ISSUES[i]?.[0] ?? i, ISSUES[i]?.[1] ?? ''))) : badge('ok', 'good')) },
                { label: 'Segnale collaudo → ora', render: (c) => `${c.acceptanceSignal ?? '—'} → ${c.now?.signal ?? '—'} dBm${c.signalDelta != null ? ` (${c.signalDelta > 0 ? '+' : ''}${c.signalDelta})` : ''}` },
                { label: 'LAN', render: (c) => (c.now?.ethMbps ? `${c.now.ethMbps}${c.now.ethHalfDuplex ? ' half' : ''}` : '—') },
                { label: 'AP', render: (c) => c.now?.apName ?? c.ssid ?? '—' },
                {
                  label: 'Origine',
                  render: (c) =>
                    h(
                      'div',
                      {},
                      c.source === 'app' ? `app · ${fmtDate(c.createdAt)}` : nms('UISP', 'assegnata'),
                      admin && c.source === 'app' ? h('div', { class: 'small muted' }, `installata da ${c.installer}`) : null,
                      admin && c.assignedTo ? h('div', { class: 'small' }, `assegnata a ${c.assignedTo.username}`) : null,
                    ),
                },
                { label: '', render: (c) => (c.jobId ? h('a', { href: `#/jobs?q=${encodeURIComponent(c.mac)}` }, 'storico') : '') },
              ],
              rows.slice(0, 500),
            )
          : h('div', { class: 'notice good' }, 'Nessuna CPE per questo filtro.'),
        rows.length > 500 ? h('p', { class: 'small muted' }, `Mostrate le prime 500 di ${rows.length}: usa i filtri o la ricerca.`) : null,
      ),
    );
  }

  async function load() {
    data = await api('/api/cpe-health');
    render();
  }
  filter.onchange = render;
  origin.onchange = render;
  q.oninput = render;
  const reload = h('button', { type: 'button' }, 'Aggiorna');
  reload.onclick = () => busy(reload, load);
  const csv = isOn('csv_export') ? h('button', { type: 'button' }, 'Esporta CSV') : null;
  if (csv) csv.onclick = () => busy(csv, () => download('/api/cpe-health.csv', 'salute-cpe.csv'));

  try {
    await load();
  } catch (e) {
    mount(out, h('div', { class: 'notice bad' }, e.body?.error === 'uisp_not_configured' ? nms('UISP non configurato: impostalo in Connettori.', 'Servizio non disponibile: contatta l’amministratore.') : e.message));
  }
  return h(
    'div',
    {},
    pageHead(
      admin ? 'Salute CPE' : 'Le mie CPE',
      admin ? 'Tutte le CPE dei clienti presenti in UISP: stato attuale, confronto con il collaudo per quelle installate con l’app, assegnazione agli installatori.' : 'Le CPE che hai installato con l’app e quelle che ti sono state assegnate.',
      reload,
      csv,
    ),
    card(h('div', { class: 'row' }, field('Mostra', filter), field('Origine', origin), field('Cerca', q))),
    out,
  );
}
