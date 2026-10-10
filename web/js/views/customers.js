import { api } from '../api.js';
import { badge, busy, card, field, fmtDate, h, mount, pageHead, table } from '../dom.js';
import { createMap, fit, legend, popup } from '../map.js';

const FILTERS = [
  ['with_accounts', 'Clienti con PPPoE'],
  ['offline', 'PPPoE offline'],
  ['suspended', 'Sospesi'],
  ['mismatch', 'Sede e CPE distanti oltre 100 m'],
  ['nocoords', 'Sede senza coordinate'],
  ['all', 'Tutte le anagrafiche'],
];
const TYPES = { private: 'privato', business: 'azienda', association: 'associazione', public_administration: 'pubblica amministrazione' };
const STATUS = { active: ['attivo', 'good'], suspended: ['sospeso', 'warn'], termination_in_progress: ['in cessazione', 'warn'], activation_in_progress: ['in attivazione', ''], waiting_confirmation: ['da confermare', ''], occasional: ['occasionale', ''] };
const SITE_COLOR = '#3b82f6';
const CPE_COLOR = '#f97316';

const dist = (m) => (m == null ? '—' : m < 1000 ? `${m} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`);

function pppoe(a) {
  const state = a.suspended ? badge('sospeso', 'warn') : a.online === true ? badge('online', 'good') : a.online === false ? badge('offline', 'bad') : badge('?', '');
  return h('div', {}, state, h('div', { class: 'small mono' }, a.username), a.speed ? h('div', { class: 'small muted' }, `${a.speed.down}/${a.speed.up} Mbit/s`) : null);
}

/** Distance between the site in the CRM and the CPE in UISP: warned over 100 m, "sospetta" when UISP has the AP/site position. */
function gap(x) {
  if (!x.position) return badge('senza coordinate', 'warn');
  if (!x.cpe) return h('span', { class: 'small muted' }, 'CPE non trovata in rete');
  if (!x.cpe.position) return h('span', { class: 'small muted' }, 'CPE senza posizione');
  return h(
    'div',
    {},
    x.distanceM > 100 ? badge(dist(x.distanceM), x.distanceM > 500 ? 'bad' : 'warn') : h('span', { class: 'small' }, dist(x.distanceM)),
    x.suspicious ? h('div', { class: 'small muted' }, 'posizione UISP = AP o sito') : null,
  );
}

/**
 * Clienti (admins, CRM connected): customer records and installation sites from ISP Billing with
 * the PPPoE session and the CPE in UISP. Read only: positions are compared, nothing is written.
 */
export async function customersView() {
  const which = h('select', {}, FILTERS.map(([v, l]) => h('option', { value: v }, l)));
  const q = h('input', { placeholder: 'Nome, codice, telefono, indirizzo, utente PPPoE, MAC, AP…' });
  const info = h('p', { class: 'small muted' });
  const list = h('div', {});
  const detail = h('div', {});
  let timer = null;

  async function load() {
    const r = await api(`/api/admin/crm/customers?filter=${which.value}&q=${encodeURIComponent(q.value.trim())}&limit=300`);
    if (!r.at && !r.total) {
      info.textContent = '';
      return mount(list, h('div', { class: 'notice warn' }, 'Nessun dato dal CRM: collega ISP Billing in Connettori → CRM e attendi la prima sincronizzazione (circa un minuto).'));
    }
    info.textContent = `${r.total.toLocaleString('it-IT')} clienti · dati del CRM aggiornati ${r.at ? fmtDate(r.at) : 'mai'}${r.running ? ' · aggiornamento in corso…' : ''}`;
    mount(
      list,
      table(
        [
          {
            label: 'Cliente',
            render: (c) =>
              h(
                'div',
                {},
                h('b', {}, c.name || '—'),
                h('div', { class: 'small muted' }, [c.code, TYPES[c.type] ?? c.type, c.group].filter(Boolean).join(' · ')),
                c.status !== 'active' && STATUS[c.status] ? badge(STATUS[c.status][0], STATUS[c.status][1]) : null,
              ),
          },
          { label: 'Sede di installazione', render: (c) => (c.sites.length ? h('div', {}, c.sites.map((x) => h('div', { class: 'small' }, x.address || '—'))) : h('span', { class: 'small muted' }, c.mainAddress || '—')) },
          { label: 'PPPoE', render: (c) => h('div', {}, c.sites.map((x) => pppoe(x.account))) },
          { label: 'CPE in rete', render: (c) => h('div', {}, c.sites.map((x) => (x.cpe ? h('div', { class: 'small' }, x.cpe.name, h('span', { class: 'muted' }, ` · ${[x.cpe.apName, x.cpe.status].filter(Boolean).join(' · ')}`)) : h('div', { class: 'small muted' }, '—')))) },
          { label: 'Sede ↔ CPE', render: (c) => h('div', {}, c.sites.map((x) => gap(x))) },
        ],
        r.rows,
        (c) => void open(c.customerId),
      ),
      r.total > r.rows.length ? h('p', { class: 'small muted' }, `Mostrati i primi ${r.rows.length}: usa la ricerca o i filtri.`) : null,
    );
  }

  async function open(id) {
    mount(detail, card(h('p', { class: 'muted' }, 'Caricamento…')));
    const c = await api(`/api/admin/crm/customers/${encodeURIComponent(id)}`);
    const mapEl = h('div', { class: 'map' });
    const kv = (k, v) => (v ? h('div', { class: 'row kv' }, h('span', { class: 'muted' }, k), h('span', {}, v)) : null);
    mount(
      detail,
      card(
        h('div', { class: 'page-head' }, h('div', {}, h('h2', {}, c.name), h('p', { class: 'small muted' }, [c.code, TYPES[c.type] ?? c.type, c.group].filter(Boolean).join(' · '))), STATUS[c.status] ? badge(STATUS[c.status][0], STATUS[c.status][1]) : null),
        kv('Telefono', [c.phone, c.phone2].filter(Boolean).join(' · ')),
        kv('Email', c.email),
        kv('Indirizzo principale', c.mainAddress),
        ...c.sites.map((x, i) =>
          h(
            'div',
            { class: 'site' },
            h('h3', {}, `Sede di installazione${c.sites.length > 1 ? ` ${i + 1}` : ''}`),
            kv('Indirizzo', [x.address, x.description && x.description !== 'Indirizzo principale' ? `(${x.description})` : ''].filter(Boolean).join(' ')),
            kv('Posizione', x.position ? `${x.position.lat.toFixed(6)}, ${x.position.lon.toFixed(6)}${x.approximate ? ' · dall’indirizzo, approssimativa' : ''}` : 'non disponibile'),
            kv('PPPoE', [x.account.username, x.account.suspended ? 'sospeso' : x.account.online ? 'online' : x.account.online === false ? 'offline' : '', x.account.profile, x.account.clientIp].filter(Boolean).join(' · ')),
            kv('CPE in rete', x.cpe ? [x.cpe.name, x.cpe.model, x.cpe.mac, x.cpe.apName, x.cpe.signal != null ? `${x.cpe.signal} dBm` : '', x.cpe.status].filter(Boolean).join(' · ') : 'non trovata (PPPoE da un router o un ONT del cliente?)'),
            x.distanceM != null ? kv('Distanza sede ↔ CPE', `${dist(x.distanceM)}${x.suspicious ? ' · la posizione UISP è quella di un AP o di un sito: probabilmente non è della CPE' : ''}`) : null,
          ),
        ),
        mapEl,
        legend([
          [SITE_COLOR, 'sede di installazione (CRM)'],
          [CPE_COLOR, 'CPE (UISP)'],
        ]),
      ),
    );
    detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
    for (let i = 0; i < 60 && !mapEl.isConnected; i++) await new Promise((r) => setTimeout(r, 50));
    const map = await createMap(mapEl, { zoom: 14 });
    if (!map) return;
    const L = window.L;
    const layers = [];
    for (const x of c.sites) {
      if (x.position) layers.push(L.circleMarker([x.position.lat, x.position.lon], { radius: 9, color: SITE_COLOR, weight: 3, fillOpacity: 0.6 }).bindPopup(popup('Sede di installazione', x.address, x.approximate ? 'posizione dall’indirizzo, approssimativa' : null)).addTo(map));
      const p = x.cpe?.position;
      if (p) layers.push(L.circleMarker([p.lat, p.lon], { radius: 7, color: CPE_COLOR, weight: 3, fillOpacity: 0.9 }).bindPopup(popup(x.cpe.name, x.cpe.model, x.cpe.apName ? `AP ${x.cpe.apName}` : null, x.suspicious ? 'posizione di un AP o sito' : null)).addTo(map));
      if (x.position && p) L.polyline([[x.position.lat, x.position.lon], [p.lat, p.lon]], { color: '#64748b', weight: 2, dashArray: '6 6' }).addTo(map);
    }
    fit(map, layers);
    setTimeout(() => map.invalidateSize(), 200);
  }

  which.onchange = () => void load();
  q.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void load(), 300);
  };
  const reload = h('button', { type: 'button' }, 'Aggiorna');
  reload.onclick = () => busy(reload, load);

  try {
    await load();
  } catch (e) {
    mount(list, h('div', { class: 'notice bad' }, e.message));
  }
  return h(
    'div',
    {},
    pageHead('Clienti', 'Anagrafiche e sedi di installazione dal CRM, con la sessione PPPoE e la CPE in rete. Solo consultazione: le posizioni vengono confrontate, non modificate.', reload),
    card(h('div', { class: 'row' }, field('Mostra', which), field('Cerca', q)), info),
    list,
    detail,
  );
}
