import { api } from '../api.js';
import { badge, card, fmtDate, h, mount, pageHead, stat, toast } from '../dom.js';
import { createMap, fit, popup, towards } from '../map.js';
import { nms } from '../terms.js';

const STATE = { ok: ['in funzione', 'good'], degraded: ['molte CPE offline', 'warn'], down: ['non raggiungibile', 'bad'] };
const OFFLINE = { none: null, some: 'alcune CPE offline', many: 'molte CPE offline' };
const STATE_COLOR = { ok: '#14b8a6', degraded: '#f59e0b', down: '#dc2626' };
const km = (m) => (m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`);

const ORDER = { down: 0, degraded: 1, ok: 2 };
const byState = (a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name, 'it', { numeric: true });

/**
 * Filters shared by the map and the list: which AP states to show and a text search. The element
 * stays on the page across the refreshes (the list is rebuilt every minute, the filters are not).
 */
function netFilters(onChange) {
  const shown = new Set(['ok', 'degraded', 'down']);
  const counts = { ok: 0, degraded: 0, down: 0 };
  const search = h('input', { type: 'search', class: 'grow', placeholder: 'Cerca POP, AP o SSID' });
  const chips = h('div', { class: 'state-chips' });
  const drawChips = () =>
    mount(
      chips,
      Object.keys(STATE).map((k) => {
        const dot = h('i', { class: 'dot' });
        dot.style.background = STATE_COLOR[k];
        return h(
          'button',
          {
            type: 'button',
            class: `state-chip${shown.has(k) ? ' on' : ''}`,
            'aria-pressed': shown.has(k) ? 'true' : 'false',
            title: shown.has(k) ? 'Nascondi questi AP' : 'Mostra questi AP',
            onclick: () => {
              shown.has(k) ? shown.delete(k) : shown.add(k);
              drawChips();
              onChange();
            },
          },
          dot,
          STATE[k][0],
          h('span', { class: 'count' }, String(counts[k])),
        );
      }),
    );
  search.addEventListener('input', () => onChange());
  drawChips();
  return {
    search,
    chips,
    shown,
    show: (k) => (shown.add(k), drawChips()),
    query: () => search.value.trim().toLowerCase(),
    setCounts(d) {
      for (const k of Object.keys(counts)) counts[k] = 0;
      for (const a of [...d.pops.flatMap((p) => p.aps), ...d.apsWithoutPop]) counts[a.state]++;
      drawChips();
    },
  };
}

const apText = (a, popName) => `${a.name} ${a.ssid ?? ''} ${popName ?? ''}`.toLowerCase();

/**
 * Admins: every POP and AP on the map, coloured by state. One click on an AP shows its details,
 * a double click opens (or closes) the sector already served by its customers; several sectors
 * can stay open together. Built once; each refresh redraws without moving the view.
 */
function networkMap(filters, onSectors) {
  const el = h('div', { class: 'map map-tall' });
  const note = h('p', { class: 'small muted' });
  const open = new Set();
  const reset = h('button', { type: 'button', disabled: true, onclick: () => (open.clear(), render()) }, 'Chiudi tutti i fasci');
  const byId = new Map();
  let map = null;
  let markerLayer = null;
  let wedgeLayer = null;
  let fitted = false;
  let data = null;
  let popupId = null;
  let clickTimer = null;
  let lastOpen = '';

  const box = card(
    h('h2', {}, 'Mappa della rete'),
    h('div', { class: 'map-tools' }, filters.search, filters.chips, reset),
    el,
    h('p', { class: 'small muted' }, 'Clic su un AP: informazioni. Doppio clic: apre o chiude il fascio dei clienti già serviti (puoi aprirne più di uno).'),
    note,
  );

  const apPopup = (a, popName) =>
    popup(
      a.name,
      a.ssid && a.ssid !== a.name ? a.ssid : null,
      popName ? `POP ${popName}` : 'AP senza POP',
      STATE[a.state][0],
      a.cpe ? `CPE ${a.cpe.total - a.cpe.offline}/${a.cpe.total} online` : null,
      pppoeText(a),
      a.model,
      a.served?.servedM ? `settore ${a.served.width}° verso ${a.served.center}°, clienti fino a ${km(a.served.servedM)}` : 'nessun fascio: mancano clienti con posizione',
      a.locationFrom === 'pop' ? 'posizione del POP (l’AP non ne ha una sua)' : null,
      a.powerOutage ? 'guasto Enel vicino' : null,
    );

  function showPopup(id) {
    const hit = byId.get(id);
    if (!hit || !map) return;
    popupId = id;
    window.L.popup({ autoPan: true }).setLatLng(hit.latlng).setContent(hit.content()).openOn(map);
  }

  function toggle(id) {
    const hit = byId.get(id);
    if (!hit?.served) return void toast('Questo AP non ha ancora un fascio: mancano clienti con posizione.');
    open.has(id) ? open.delete(id) : open.add(id);
    render();
  }

  /** Redraws markers and open sectors from the last data, with the current filters. */
  function render() {
    if (!map || !data) return;
    const L = window.L;
    markerLayer.clearLayers();
    wedgeLayer.clearLayers();
    byId.clear();
    const pts = [];
    let missing = 0;
    let hidden = 0;
    const q = filters.query();
    const ap = (a, popName) => {
      if (a.lat == null || a.lon == null) return void missing++;
      if (!filters.shown.has(a.state) || (q && !apText(a, popName).includes(q))) return void hidden++;
      const color = STATE_COLOR[a.state];
      const id = `ap:${a.id}`;
      if (open.has(id) && a.served?.servedM) {
        const wedge = [[a.lat, a.lon]];
        for (let i = 0; i <= 24; i++) wedge.push(towards(a.lat, a.lon, a.served.center - a.served.width / 2 + (a.served.width * i) / 24, a.served.servedM));
        L.polygon(wedge, { color, weight: 1.5, fillOpacity: 0.14, dashArray: '4 5', interactive: false }).addTo(wedgeLayer);
      }
      const m = L.circleMarker([a.lat, a.lon], { radius: open.has(id) ? 8 : 6, color, weight: open.has(id) ? 3 : 2, fillOpacity: 0.9, bubblingMouseEvents: false })
        .bindTooltip(a.name)
        .addTo(markerLayer);
      // one click: details (after a short wait, so that a double click does not open them too)
      m.on('click', () => {
        clearTimeout(clickTimer);
        clickTimer = setTimeout(() => showPopup(id), 260);
      });
      m.on('dblclick', (e) => {
        L.DomEvent.stop(e);
        clearTimeout(clickTimer);
        toggle(id);
      });
      byId.set(id, { latlng: m.getLatLng(), served: !!a.served?.servedM, content: () => apPopup(a, popName), state: a.state });
      pts.push(m);
    };
    for (const p of data.pops) {
      if (p.lat != null && p.lon != null && (!q || `pop ${p.name}`.toLowerCase().includes(q) || p.aps.some((a) => apText(a, p.name).includes(q)))) {
        const id = `pop:${p.id}`;
        const m = L.circleMarker([p.lat, p.lon], { radius: 10, color: STATE_COLOR[p.state], weight: 3, fillColor: '#ffffff', fillOpacity: 1, bubblingMouseEvents: false })
          .bindTooltip(`POP ${p.name}`)
          .on('click', () => showPopup(id))
          .on('dblclick', (e) => L.DomEvent.stop(e))
          .addTo(markerLayer);
        byId.set(id, { latlng: m.getLatLng(), content: () => popup(`POP ${p.name}`, `${p.aps.length} AP`, STATE[p.state][0], p.powerOutage ? 'guasto Enel vicino' : null) });
        pts.push(m);
      }
      for (const a of p.aps) ap(a, p.name);
    }
    for (const a of data.apsWithoutPop) ap(a, null);
    // sectors of APs no longer on the map (removed in UISP) are forgotten
    for (const id of open) if (!data.pops.some((p) => p.aps.some((a) => `ap:${a.id}` === id)) && !data.apsWithoutPop.some((a) => `ap:${a.id}` === id)) open.delete(id);
    reset.disabled = open.size === 0;
    reset.textContent = open.size ? `Chiudi tutti i fasci (${open.size})` : 'Chiudi tutti i fasci';
    if (String([...open]) !== lastOpen) ((lastOpen = String([...open])), onSectors());
    note.textContent = [
      `${pts.length} punti sulla mappa`,
      hidden ? `${hidden} AP nascosti dai filtri` : null,
      missing ? `${missing} AP senza posizione (correggila nel gestionale)` : null,
    ]
      .filter(Boolean)
      .join(' · ')
      .concat('. Cerchio bianco: POP; punti: AP.');
    if (!fitted && pts.length) (fit(map, pts), (fitted = true));
    // the details of a point the filters just hid make no sense any more
    if (popupId && !byId.has(popupId)) map.closePopup();
  }

  async function draw(d) {
    data = d;
    if (!map) {
      // the view is put on the page after its first load: Leaflet needs a laid out container
      for (let i = 0; i < 60 && !el.isConnected; i++) await new Promise((r) => setTimeout(r, 50));
      map = await createMap(el, { zoom: 10 });
      if (!map) return;
      // Leaflet is loaded by createMap: read it only now
      wedgeLayer = window.L.layerGroup().addTo(map);
      markerLayer = window.L.layerGroup().addTo(map);
      map.on('popupclose', () => (popupId = null));
      // the container got its final width after the map was created: no grey band on the right
      setTimeout(() => map.invalidateSize(), 200);
    }
    render();
  }

  /** From the list: centre the AP, show its details and, if asked, open its sector. */
  function focus(id, sector = false) {
    if (!map) return;
    const hit = byId.get(id);
    if (!hit) return void toast('L’AP è nascosto dai filtri o non ha una posizione.');
    if (sector && hit.served && !open.has(id)) (open.add(id), render());
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    map.setView(hit.latlng, Math.max(map.getZoom(), 13));
    showPopup(id);
  }

  function jump() {
    const q = filters.query();
    if (!q || !map) return;
    const all = [...byId.entries()];
    const hit = all.find(([id]) => id.startsWith('ap:')) ?? all[0];
    if (hit) (map.setView(hit[1].latlng, 14), showPopup(hit[0]));
  }

  return { box, draw, render, focus, jump, isOpen: (id) => open.has(id), toggle };
}

/** CPE online over total, as a small bar (green, amber below 70%, red below 40%). */
function cpeBar(a) {
  if (!a.cpe) return OFFLINE[a.cpeOffline] ? h('span', { class: 'small' }, OFFLINE[a.cpeOffline]) : h('span', { class: 'muted' }, '—');
  const online = a.cpe.total - a.cpe.offline;
  const ratio = a.cpe.total ? online / a.cpe.total : 1;
  const bar = h('i');
  bar.style.width = `${Math.round(ratio * 100)}%`;
  bar.style.background = ratio >= 0.7 ? STATE_COLOR.ok : ratio >= 0.4 ? STATE_COLOR.degraded : STATE_COLOR.down;
  const pppoe = pppoeText(a);
  return h(
    'span',
    { class: 'cpe-cell' },
    h('span', { class: 'cpe-bar' }, bar),
    h('span', { class: 'small' }, `${online}/${a.cpe.total}`),
    // admins with the CRM: PPPoE sessions of the CPEs of the AP
    pppoe ? h('span', { class: `small ${a.pppoe.offline ? 'bad-text' : 'muted'}`, title: 'Sessioni PPPoE dal RADIUS' }, ` · ${pppoe}`) : null,
  );
}

/** "PPPoE 12 online · 2 offline · 1 sospeso" (admins, CRM connected), null otherwise. */
function pppoeText(a) {
  const p = a.pppoe;
  if (!p || !(p.online + p.offline + p.suspended)) return null;
  const parts = [`${p.online} online`];
  if (p.offline) parts.push(`${p.offline} offline`);
  if (p.suspended) parts.push(`${p.suspended} ${p.suspended === 1 ? 'sospeso' : 'sospesi'}`);
  return `PPPoE ${parts.join(' · ')}`;
}

/** "Stato rete": POPs and APs (installers: the assigned ones), refreshed every minute. No notifications. */
export async function networkView({ user }) {
  const admin = user.role === 'admin';
  const out = h('div', {}, h('p', { class: 'muted' }, 'Caricamento…'));
  const summaryBox = h('div', {});
  const listBox = h('div', {});
  let data = null;
  const filters = netFilters(() => {
    netMap?.render();
    if (data) drawList(data);
  });
  // the list follows the sectors opened or closed on the map
  const netMap = admin ? networkMap(filters, () => data && drawList(data)) : null;
  filters.search.addEventListener('keydown', (e) => e.key === 'Enter' && netMap?.jump());
  // installers have no map: the filters go above their list
  const listTools = admin ? null : h('div', { class: 'map-tools' }, filters.search, filters.chips);
  let timer = null;

  function drawList(d) {
    const q = filters.query();
    const groups = [...d.pops, ...(d.apsWithoutPop.length ? [{ id: null, name: 'AP senza POP', state: null, powerOutage: false, aps: d.apsWithoutPop }] : [])]
      .map((p) => {
        const popHit = q && `pop ${p.name}`.toLowerCase().includes(q);
        const aps = p.aps.filter((a) => filters.shown.has(a.state) && (!q || popHit || apText(a, p.name).includes(q))).sort(byState);
        return { p, aps, popHit };
      })
      .filter(({ p, aps, popHit }) => aps.length || (!p.aps.length && (!q || popHit)));
    const total = groups.reduce((n, g) => n + g.aps.length, 0);
    const rows = [];
    for (const { p, aps } of groups) {
      const down = p.aps.filter((a) => a.state === 'down').length;
      const degraded = p.aps.filter((a) => a.state === 'degraded').length;
      rows.push(
        h(
          'tr',
          { class: 'pop-row' },
          h(
            'td',
            { colspan: 6 },
            h(
              'div',
              { class: 'pop-head' },
              h('b', {}, p.id == null ? p.name : `POP ${p.name}`),
              p.state ? badge(STATE[p.state][0], STATE[p.state][1]) : null,
              h('span', { class: 'small muted' }, [`${p.aps.length} AP`, down ? `${down} non raggiungibili` : null, degraded ? `${degraded} con molte CPE offline` : null].filter(Boolean).join(' · ')),
              p.powerOutage ? badge('guasto Enel vicino', 'bad') : null,
            ),
          ),
        ),
      );
      for (const a of aps) {
        const id = `ap:${a.id}`;
        rows.push(
          h(
            'tr',
            { class: `ap-row state-${a.state}` },
            h('td', { 'data-label': 'Stato' }, badge(STATE[a.state][0], STATE[a.state][1])),
            h('td', { 'data-label': 'AP' }, h('div', { class: 'ap-name' }, h('b', {}, a.name), a.ssid && a.ssid !== a.name ? h('span', { class: 'small muted' }, a.ssid) : null)),
            h('td', { 'data-label': 'CPE online' }, cpeBar(a)),
            h('td', { 'data-label': 'Ultimo contatto' }, a.lastSeen ? h('span', { class: 'small' }, fmtDate(a.lastSeen)) : h('span', { class: 'muted' }, '—')),
            h('td', { 'data-label': 'Note' }, a.powerOutage ? badge('guasto Enel vicino', 'bad') : a.model ? h('span', { class: 'small muted' }, a.model) : h('span', { class: 'muted' }, '—')),
            netMap
              ? h(
                  'td',
                  { class: 'ap-actions' },
                  a.lat != null && a.lon != null
                    ? h(
                        'div',
                        { class: 'btns' },
                        h('button', { type: 'button', class: 'small-btn', onclick: () => netMap.focus(id) }, 'Mappa'),
                        a.served?.servedM
                          ? h('button', { type: 'button', class: `small-btn${netMap.isOpen(id) ? ' on' : ''}`, onclick: () => (netMap.isOpen(id) ? netMap.toggle(id) : netMap.focus(id, true)) }, netMap.isOpen(id) ? 'Chiudi fascio' : 'Fascio')
                          : null,
                      )
                    : h('span', { class: 'small muted' }, 'senza posizione'),
                )
              : h('td', {}),
          ),
        );
      }
    }
    mount(
      listBox,
      d.restricted && !d.assignedCount
        ? h('div', { class: 'notice warn' }, 'Nessun POP/AP assegnato al tuo account: chiedi all’amministratore.')
        : card(
            h('h2', {}, d.restricted ? 'I tuoi POP e AP' : 'POP e AP'),
            listTools,
            rows.length
              ? h(
                  'div',
                  { class: 'table-wrap' },
                  h(
                    'table',
                    { class: 'net-table' },
                    h('thead', {}, h('tr', {}, ['Stato', 'AP', 'CPE online', 'Ultimo contatto', 'Note', ''].map((t) => h('th', {}, t)))),
                    h('tbody', {}, rows),
                  ),
                )
              : h('p', { class: 'small muted' }, d.pops.length || d.apsWithoutPop.length ? 'Nessun AP con questi filtri.' : 'Nessun POP o AP.'),
            h(
              'p',
              { class: 'small muted' },
              `${total} AP mostrati. "Molte CPE offline": almeno il 30% delle CPE dell’AP non è raggiungibile (probabile problema di settore, non del singolo cliente).`,
            ),
          ),
    );
  }

  async function load() {
    let d;
    try {
      d = await api('/api/network/status');
    } catch (e) {
      mount(out, h('div', { class: 'notice bad' }, e.message));
      return;
    }
    if (!document.body.contains(out) && timer) {
      clearInterval(timer);
      return;
    }
    data = d;
    const s = d.summary;
    filters.setCounts(d);
    if (!out.contains(summaryBox)) mount(out, summaryBox, netMap ? netMap.box : null, listBox);
    void netMap?.draw(d);
    mount(
      summaryBox,
      card(
        h('div', { class: 'grid' }, stat('AP', s.aps), stat('Non raggiungibili', s.down), stat('Con molte CPE offline', s.degraded), stat('Con guasto Enel vicino', s.powerOutage)),
        h('p', { class: 'small muted' }, `Aggiornato ${fmtDate(d.generatedAt)} · si aggiorna ogni minuto${nms(' · dati da UISP', '')}.`),
      ),
    );
    drawList(d);
  }

  await load();
  timer = setInterval(load, 60_000);
  return h('div', {}, pageHead('Stato rete', admin ? 'Stato di POP e AP: raggiungibilità, CPE offline e guasti Enel vicini.' : 'Stato dei POP e degli AP che ti sono assegnati.'), out);
}
