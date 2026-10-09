import { api } from '../api.js';
import { badge, card, fmtDate, h, mount, pageHead, stat, table } from '../dom.js';
import { createMap, fit, legend, popup, towards } from '../map.js';
import { nms } from '../terms.js';

const STATE = { ok: ['in funzione', 'good'], degraded: ['molte CPE offline', 'warn'], down: ['non raggiungibile', 'bad'] };
const OFFLINE = { none: null, some: 'alcune CPE offline', many: 'molte CPE offline' };
const STATE_COLOR = { ok: '#14b8a6', degraded: '#f59e0b', down: '#dc2626' };
const km = (m) => (m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`);

/**
 * Admins: every POP and AP on the map, coloured by state, with the sector already served by the
 * customers. Built once; each refresh redraws the markers without moving the view.
 */
function networkMap() {
  const el = h('div', { class: 'map map-tall' });
  const search = h('input', { type: 'search', class: 'grow', placeholder: 'Cerca POP, AP o SSID e premi Invio' });
  const note = h('p', { class: 'small muted' });
  const markers = [];
  let map = null;
  let layer = null;
  let fitted = false;
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !map) return;
    const q = search.value.trim().toLowerCase();
    const hit = q && markers.find((m) => m.text.includes(q));
    if (hit) (map.setView(hit.marker.getLatLng(), 14), hit.marker.openPopup());
  });
  const box = card(
    h('h2', {}, 'Mappa della rete'),
    h('div', { class: 'row' }, search),
    el,
    legend([
      [STATE_COLOR.ok, 'in funzione'],
      [STATE_COLOR.degraded, 'molte CPE offline'],
      [STATE_COLOR.down, 'non raggiungibile'],
    ]),
    note,
  );
  async function draw(d) {
    if (!map) {
      // the view is put on the page after its first load: Leaflet needs a laid out container
      for (let i = 0; i < 60 && !el.isConnected; i++) await new Promise((r) => setTimeout(r, 50));
      map = await createMap(el, { zoom: 10 });
      if (!map) return;
      layer = window.L.layerGroup().addTo(map);
      // the container got its final width after the map was created: no grey band on the right
      setTimeout(() => map.invalidateSize(), 200);
    }
    // Leaflet is loaded by createMap: read it only now
    const L = window.L;
    layer.clearLayers();
    markers.length = 0;
    const pts = [];
    let missing = 0;
    const ap = (a, popName) => {
      if (a.lat == null || a.lon == null) return void missing++;
      const color = STATE_COLOR[a.state];
      if (a.served?.servedM) {
        const wedge = [[a.lat, a.lon]];
        for (let i = 0; i <= 12; i++) wedge.push(towards(a.lat, a.lon, a.served.center - a.served.width / 2 + (a.served.width * i) / 12, a.served.servedM));
        L.polygon(wedge, { color, weight: 1, fillOpacity: 0.07, dashArray: '3 5', interactive: false }).addTo(layer);
      }
      const m = L.circleMarker([a.lat, a.lon], { radius: 6, color, weight: 2, fillOpacity: 0.9 })
        .bindTooltip(a.name)
        .bindPopup(
          popup(
            a.name,
            a.ssid && a.ssid !== a.name ? a.ssid : null,
            popName ? `POP ${popName}` : 'AP senza POP',
            STATE[a.state][0],
            a.cpe ? `CPE ${a.cpe.total - a.cpe.offline}/${a.cpe.total} online` : null,
            a.model,
            a.served?.servedM ? `settore ${a.served.width}° verso ${a.served.center}°, clienti fino a ${km(a.served.servedM)}` : null,
            a.locationFrom === 'pop' ? 'posizione del POP (l’AP non ne ha una sua)' : null,
            a.powerOutage ? 'guasto Enel vicino' : null,
          ),
        )
        .addTo(layer);
      markers.push({ marker: m, text: `${a.name} ${a.ssid ?? ''} ${popName ?? ''}`.toLowerCase() });
      pts.push(m);
    };
    for (const p of d.pops) {
      if (p.lat != null && p.lon != null) {
        const m = L.circleMarker([p.lat, p.lon], { radius: 10, color: STATE_COLOR[p.state], weight: 3, fillColor: '#ffffff', fillOpacity: 1 })
          .bindTooltip(`POP ${p.name}`)
          .bindPopup(popup(`POP ${p.name}`, `${p.aps.length} AP`, STATE[p.state][0], p.powerOutage ? 'guasto Enel vicino' : null))
          .addTo(layer);
        markers.push({ marker: m, text: `pop ${p.name}`.toLowerCase() });
        pts.push(m);
      }
      for (const a of p.aps) ap(a, p.name);
    }
    for (const a of d.apsWithoutPop) ap(a, null);
    note.textContent = `${markers.length} punti sulla mappa${missing ? ` · ${missing} AP senza posizione (correggila nel gestionale)` : ''}. Cerchio bianco: POP; punti: AP; ventaglio tratteggiato: area già servita dai clienti.`;
    if (!fitted && pts.length) (fit(map, pts), (fitted = true));
  }
  return { box, draw };
}

/** "Stato rete": POPs and APs (installers: the assigned ones), refreshed every minute. No notifications. */
export async function networkView({ user }) {
  const admin = user.role === 'admin';
  const out = h('div', {}, h('p', { class: 'muted' }, 'Caricamento…'));
  const summaryBox = h('div', {});
  const listBox = h('div', {});
  const netMap = admin ? networkMap() : null;
  let timer = null;

  const apLine = (a) =>
    h(
      'div',
      { class: 'net-ap' },
      badge(STATE[a.state][0], STATE[a.state][1]),
      ' ',
      h('b', {}, a.name),
      a.ssid && a.ssid !== a.name ? h('span', { class: 'small muted' }, ` ${a.ssid}`) : null,
      a.cpe ? h('span', { class: 'small' }, ` · CPE ${a.cpe.total - a.cpe.offline}/${a.cpe.total} online`) : OFFLINE[a.cpeOffline] ? h('span', { class: 'small' }, ` · ${OFFLINE[a.cpeOffline]}`) : null,
      a.lastSeen ? h('span', { class: 'small muted' }, ` · ultimo contatto ${fmtDate(a.lastSeen)}`) : null,
      a.powerOutage ? [' ', badge('guasto Enel vicino', 'bad')] : null,
    );

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
    const s = d.summary;
    if (!out.contains(summaryBox)) mount(out, summaryBox, netMap ? netMap.box : null, listBox);
    void netMap?.draw(d);
    mount(
      summaryBox,
      card(
        h('div', { class: 'grid' }, stat('AP', s.aps), stat('Non raggiungibili', s.down), stat('Con molte CPE offline', s.degraded), stat('Con guasto Enel vicino', s.powerOutage)),
        h('p', { class: 'small muted' }, `Aggiornato ${fmtDate(d.generatedAt)} · si aggiorna ogni minuto${nms(' · dati da UISP', '')}.`),
      ),
    );
    mount(
      listBox,
      d.restricted && !d.assignedCount
        ? h('div', { class: 'notice warn' }, 'Nessun POP/AP assegnato al tuo account: chiedi all’amministratore.')
        : card(
            h('h2', {}, d.restricted ? 'I tuoi POP e AP' : 'POP e AP'),
            d.pops.length || d.apsWithoutPop.length
              ? table(
                  [
                    { label: 'POP', render: (p) => h('div', {}, h('b', {}, p.name), h('div', {}, badge(STATE[p.state][0], STATE[p.state][1])), p.powerOutage ? badge('guasto Enel vicino', 'bad') : null) },
                    { label: 'AP', render: (p) => (p.aps.length ? h('div', {}, p.aps.map(apLine)) : h('span', { class: 'small muted' }, 'nessun AP')) },
                  ],
                  [...d.pops, ...(d.apsWithoutPop.length ? [{ name: 'AP senza POP', state: 'ok', powerOutage: false, aps: d.apsWithoutPop }] : [])],
                )
              : h('p', { class: 'small muted' }, 'Nessun POP o AP.'),
            h('p', { class: 'small muted' }, '"Molte CPE offline": almeno il 30% delle CPE dell’AP non è raggiungibile (probabile problema di settore, non del singolo cliente).'),
          ),
    );
  }

  await load();
  timer = setInterval(load, 60_000);
  return h('div', {}, pageHead('Stato rete', admin ? 'Stato di POP e AP: raggiungibilità, CPE offline e guasti Enel vicini.' : 'Stato dei POP e degli AP che ti sono assegnati.'), out);
}
