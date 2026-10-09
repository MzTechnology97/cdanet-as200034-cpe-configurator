import { api, download } from '../api.js';
import { isOn } from '../modules.js';
import { badge, busy, card, field, fmtDate, h, mount, pageHead, stat, table } from '../dom.js';

const ISSUES = {
  offline: ['offline', 'bad'],
  not_in_uisp: ['non trovata in UISP', 'bad'],
  weak_signal: ['segnale debole', 'bad'],
  signal_drop: ['segnale calato', 'warn'],
  ethernet: ['porta LAN', 'warn'],
  pending: ['da accettare', 'warn'],
  low_capacity: ['capacità bassa', 'warn'],
  firmware: ['firmware', ''],
};

/**
 * Salute CPE installate: only CPEs provisioned with the app (installers: their own), current
 * UISP state vs the acceptance test. No PPPoE data, no configuration.
 */
export async function healthView({ user }) {
  const out = h('div', {});
  const filter = h(
    'select',
    {},
    h('option', { value: 'issues' }, 'Solo con problemi'),
    h('option', { value: 'all' }, 'Tutte'),
    ...Object.entries(ISSUES).map(([k, [label]]) => h('option', { value: k }, `Solo: ${label}`)),
  );
  const q = h('input', { placeholder: 'Cliente, MAC, AP…' });
  let data = null;

  function render() {
    const t = data.totals;
    const term = q.value.trim().toLowerCase();
    const rows = data.cpes
      .filter((c) => (filter.value === 'all' ? true : filter.value === 'issues' ? c.issues.length > 0 : c.issues.includes(filter.value)))
      .filter((c) => !term || [c.deviceName, c.mac, c.now?.apName, c.installer, c.ssid].some((x) => (x ?? '').toLowerCase().includes(term)));
    mount(
      out,
      card(
        h(
          'div',
          { class: 'grid' },
          stat(user.role === 'admin' ? 'CPE installate' : 'Le mie CPE', t.cpes),
          stat('Senza problemi', `${t.ok} (${t.cpes ? Math.round((t.ok / t.cpes) * 100) : 0}%)`),
          stat('Offline', t.offline),
          stat('Segnale debole', t.weak_signal),
          stat('Segnale calato dal collaudo', t.signal_drop),
          stat('Porta LAN lenta / half', t.ethernet),
          stat('Non trovate in UISP', t.not_in_uisp),
        ),
        h('p', { class: 'small muted' }, `Stato UISP del ${fmtDate(data.generatedAt)}. "Segnale calato": almeno ${data.thresholds.signalDropDb} dB in meno rispetto al collaudo.`),
        data.uisp ? null : h('div', { class: 'notice warn' }, 'UISP non raggiungibile: stato attuale non disponibile.'),
      ),
      card(
        h('h2', {}, `CPE (${rows.length})`),
        rows.length
          ? table(
              [
                { label: 'Cliente', render: (c) => h('div', {}, c.deviceName || '—', h('div', { class: 'small muted mono' }, c.mac)) },
                { label: 'Problemi', render: (c) => (c.issues.length ? h('div', { class: 'btns' }, c.issues.map((i) => badge(ISSUES[i]?.[0] ?? i, ISSUES[i]?.[1] ?? ''))) : badge('ok', 'good')) },
                { label: 'Segnale collaudo → ora', render: (c) => `${c.acceptanceSignal ?? '—'} → ${c.now?.signal ?? '—'} dBm${c.signalDelta != null ? ` (${c.signalDelta > 0 ? '+' : ''}${c.signalDelta})` : ''}` },
                { label: 'LAN', render: (c) => (c.now?.ethMbps ? `${c.now.ethMbps}${c.now.ethHalfDuplex ? ' half' : ''}` : '—') },
                { label: 'AP', render: (c) => c.now?.apName ?? c.ssid },
                { label: 'Installata', render: (c) => h('div', {}, fmtDate(c.createdAt), user.role === 'admin' ? h('div', { class: 'small muted' }, c.installer) : null) },
                { label: '', render: (c) => h('a', { href: `#/jobs?q=${encodeURIComponent(c.mac)}` }, 'storico') },
              ],
              rows.slice(0, 500),
            )
          : h('div', { class: 'notice good' }, 'Nessuna CPE per questo filtro.'),
      ),
    );
  }

  async function load() {
    data = await api('/api/cpe-health');
    render();
  }
  filter.onchange = render;
  q.oninput = render;
  const reload = h('button', { type: 'button' }, 'Aggiorna');
  reload.onclick = () => busy(reload, load);
  const csv = isOn('csv_export') ? h('button', { type: 'button' }, 'Esporta CSV') : null;
  if (csv) csv.onclick = () => busy(csv, () => download('/api/cpe-health.csv', 'salute-cpe.csv'));

  try {
    await load();
  } catch (e) {
    mount(out, h('div', { class: 'notice bad' }, e.body?.error === 'uisp_not_configured' ? 'UISP non configurato: impostalo in Connettori.' : e.message));
  }
  return h(
    'div',
    {},
    pageHead(user.role === 'admin' ? 'Salute CPE installate' : 'Le mie CPE', 'Stato attuale delle CPE installate con l’app, confrontato con il collaudo.', reload, csv),
    card(h('div', { class: 'row' }, field('Mostra', filter), field('Cerca', q))),
    out,
  );
}
