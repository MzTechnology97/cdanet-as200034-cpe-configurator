import { api, download } from '../api.js';
import { badge, busy, card, field, fmtDate, h, mount, pageHead, stat, table } from '../dom.js';

const ISSUES = {
  offline: ['offline', 'bad'],
  weak_signal: ['segnale debole', 'bad'],
  ethernet: ['porta LAN', 'warn'],
  pending: ['da accettare', 'warn'],
  low_capacity: ['capacità bassa', 'warn'],
  firmware: ['firmware', ''],
};

/** NOC: CPEs needing attention and AP sectors, from UISP (no full map, no customer data beyond the device name). */
export async function healthView() {
  const out = h('div', {});
  const filter = h(
    'select',
    {},
    h('option', { value: 'issues' }, 'Solo CPE con problemi'),
    h('option', { value: 'all' }, 'Tutte le CPE'),
    ...Object.entries(ISSUES).map(([k, [label]]) => h('option', { value: k }, `Solo: ${label}`)),
  );
  const q = h('input', { placeholder: 'Nome CPE, MAC, AP, site…' });
  let data = null;

  function render() {
    const t = data.totals;
    const term = q.value.trim().toLowerCase();
    const rows = data.cpes
      .filter((c) => (filter.value === 'all' ? true : filter.value === 'issues' ? c.issues.length > 0 : c.issues.includes(filter.value)))
      .filter((c) => !term || [c.name, c.mac, c.apName, c.siteName, c.model].some((x) => (x ?? '').toLowerCase().includes(term)));
    mount(
      out,
      card(
        h(
          'div',
          { class: 'grid' },
          stat('CPE in UISP', t.cpes),
          stat('Senza problemi', `${t.ok} (${t.cpes ? Math.round((t.ok / t.cpes) * 100) : 0}%)`),
          stat('Offline', t.offline),
          stat('Segnale < ' + data.thresholds.signalMin + ' dBm', t.weak_signal),
          stat('Porta LAN lenta / half', t.ethernet),
          stat('Da accettare', t.pending),
          stat('Firmware ≠ ' + data.thresholds.targetFirmware, t.firmware),
          stat('AP offline', `${t.apsOffline} / ${t.aps}`),
        ),
        h('p', { class: 'small muted' }, `Dati UISP del ${fmtDate(data.generatedAt)} (cache di un minuto).`),
      ),
      card(
        h('h2', {}, `CPE (${rows.length})`),
        rows.length
          ? table(
              [
                { label: 'CPE', render: (c) => h('div', {}, c.name || '—', h('div', { class: 'small muted mono' }, c.mac ?? '')) },
                { label: 'Problemi', render: (c) => (c.issues.length ? h('div', { class: 'btns' }, c.issues.map((i) => badge(ISSUES[i]?.[0] ?? i, ISSUES[i]?.[1] ?? ''))) : badge('ok', 'good')) },
                { label: 'Segnale', render: (c) => (c.signal != null ? `${c.signal} dBm` : '—') },
                { label: 'LAN', render: (c) => (c.ethMbps ? `${c.ethMbps}${c.ethHalfDuplex ? ' half' : ''}` : '—') },
                { label: 'AP', render: (c) => h('div', {}, c.apName ?? '—', h('div', { class: 'small muted' }, c.siteName ?? '')) },
                { label: 'Firmware', render: (c) => h('span', { class: 'small' }, c.firmware || '—') },
                { label: 'Ultimo contatto', render: (c) => (c.issues.includes('offline') ? fmtDate(c.lastSeen) : '—') },
                { label: '', render: (c) => (c.mac ? h('a', { href: `#/jobs?q=${encodeURIComponent(c.mac)}` }, 'storico') : '') },
              ],
              rows.slice(0, 500),
            )
          : h('div', { class: 'notice good' }, 'Nessuna CPE per questo filtro.'),
        rows.length > 500 ? h('p', { class: 'small muted' }, 'Mostrate le prime 500: usa la ricerca o esporta il CSV.') : null,
      ),
      card(
        h('h2', {}, 'Settori (AP)'),
        table(
          [
            { label: 'AP', render: (a) => h('div', {}, a.name, h('div', { class: 'small muted' }, [a.ssid, a.siteName].filter(Boolean).join(' · '))) },
            { label: 'Stato', render: (a) => badge(a.status === 'active' ? 'online' : a.status, a.status === 'active' ? 'good' : 'bad') },
            { label: 'CPE', key: 'stations' },
            { label: 'Segnale medio', render: (a) => (a.avgSignal != null ? `${a.avgSignal} dBm` : '—') },
            { label: 'Deboli', render: (a) => (a.weak ? badge(String(a.weak), 'bad') : '0') },
            { label: 'Offline', render: (a) => (a.offline ? badge(String(a.offline), 'bad') : '0') },
          ],
          data.aps,
        ),
      ),
    );
  }

  async function load() {
    data = await api('/api/admin/network/health');
    render();
  }
  filter.onchange = render;
  q.oninput = render;
  const reload = h('button', { type: 'button' }, 'Aggiorna');
  reload.onclick = () => busy(reload, load);
  const csv = h('button', { type: 'button' }, 'Esporta CSV');
  csv.onclick = () => busy(csv, () => download('/api/admin/network/health.csv', 'salute-rete.csv'));

  try {
    await load();
  } catch (e) {
    mount(out, h('div', { class: 'notice bad' }, e.body?.error === 'uisp_not_configured' ? 'UISP non configurato: impostalo in Connettori.' : e.message));
  }
  return h(
    'div',
    {},
    pageHead('Salute rete', 'CPE da controllare e stato dei settori, dai dati UISP.', reload, csv),
    card(h('div', { class: 'row' }, field('Mostra', filter), field('Cerca', q))),
    out,
  );
}
