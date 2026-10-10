import { api } from '../api.js';
import { badge, busy, card, field, h, mount, pageHead, table, toast } from '../dom.js';
import { createMap, fit, legend, popup, towards, MAP_COLORS as C } from '../map.js';
import { estimateCell, orientArrows, osmLink, RATING } from './coverage.js';

/**
 * Copertura for admins: every AP on the map, one search box (address, coordinates, AP name or a
 * click on the map), the APs ranked for the point and a radio simulation of each AP (estimated
 * signal around it, line of sight towards the point). Installers keep their restricted page.
 */
const STATE_COLOR = { ok: '#14b8a6', degraded: '#f59e0b', down: '#dc2626' };
const RATING_COLOR = { buono: '#16a34a', possibile: '#f59e0b', 'senza stima': '#64748b', improbabile: '#dc2626', 'non attivo': '#dc2626' };
const km = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1).replace('.', ',')} km`);
/** Signal scale of the simulation, from excellent to unusable. */
const SCALE = [
  [-60, '#15803d', 'oltre −60 dBm'],
  [-65, '#22c55e', '−60…−65'],
  [-70, '#a3e635', '−65…−70'],
  [-75, '#facc15', '−70…−75'],
  [-80, '#f97316', '−75…−80'],
  [-999, '#dc2626', 'sotto −80'],
];
const scaleColor = (dbm) => SCALE.find(([min]) => dbm >= min)[1];
/** Tallest mast worth suggesting for a CPE (same limit as the app). */
const MAX_MAST_M = 12;
const dec = (n) => String(n).replace('.', ',');

/** "37.56, 14.27", "37,56 14,27", "37.56;14.27" → [lat, lon]; null if it is not a pair of coordinates. */
export function parseCoords(text) {
  if (!/^[\s\d.,;+-]+$/.test(text)) return null;
  const nums = text.match(/-?\d+(?:[.,]\d+)?/g);
  if (!nums || nums.length !== 2) return null;
  const [la, lo] = nums.map((n) => Number(n.replace(',', '.')));
  return Math.abs(la) <= 90 && Math.abs(lo) <= 180 ? [la, lo] : null;
}

const SVG = 'http://www.w3.org/2000/svg';
const s = (tag, attrs = {}) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};

/** Terrain profile between the point and the AP: ground, line of sight and 60% of the first Fresnel zone. */
function profileChart(p) {
  const W = 760;
  const H = 220;
  const pad = { l: 46, r: 12, t: 12, b: 26 };
  const pts = p.chart;
  const D = pts[pts.length - 1].d || 1;
  const ys = pts.flatMap((q) => [q.ground, q.los, q.fresnel60]);
  const lo = Math.floor(Math.min(...ys) - 5);
  const hi = Math.ceil(Math.max(...ys) + 5);
  const x = (d) => pad.l + ((W - pad.l - pad.r) * d) / D;
  const y = (v) => pad.t + ((H - pad.t - pad.b) * (hi - v)) / (hi - lo || 1);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'los-chart', role: 'img', 'aria-label': 'Profilo del terreno' });
  const ground = `M${x(0)},${y(lo)} ` + pts.map((q) => `L${x(q.d)},${y(q.ground)}`).join(' ') + ` L${x(D)},${y(lo)} Z`;
  svg.append(
    s('path', { d: ground, class: 'los-ground' }),
    s('path', { d: 'M' + pts.map((q) => `${x(q.d)},${y(q.fresnel60)}`).join(' L'), class: 'los-fresnel' }),
    s('path', { d: 'M' + pts.map((q) => `${x(q.d)},${y(q.los)}`).join(' L'), class: 'los-line' }),
  );
  for (const v of [lo, Math.round((lo + hi) / 2), hi]) {
    const t = s('text', { x: pad.l - 6, y: y(v) + 4, class: 'los-axis', 'text-anchor': 'end' });
    t.textContent = `${v} m`;
    svg.append(t);
  }
  for (const [d, anchor, label] of [[0, 'start', 'Punto (CPE)'], [D, 'end', `AP · ${km(D)}`]]) {
    const t = s('text', { x: x(d), y: H - 6, class: 'los-axis', 'text-anchor': anchor });
    t.textContent = label;
    svg.append(t);
  }
  if (p.worst) svg.append(s('circle', { cx: x(p.worst.d), cy: y(pts.reduce((a, q) => (Math.abs(q.d - p.worst.d) < Math.abs(a.d - p.worst.d) ? q : a)).ground), r: 5, class: 'los-worst' }));
  return svg;
}

export async function adminCoverageView() {
  const search = h('input', { type: 'search', class: 'grow', placeholder: 'Indirizzo, coordinate (37.56, 14.27) o nome di un AP', autocomplete: 'off' });
  const searchBtn = h('button', { type: 'submit', class: 'primary' }, 'Cerca');
  const gps = h('button', { type: 'button' }, 'La mia posizione');
  // the farthest real link is 20 km (usually under 15): beyond that no AP is worth proposing
  const howFar = h('select', {}, ...[5, 10, 15, 20].map((n) => h('option', { value: n, selected: n === 20 }, `entro ${n} km`)));
  const height = h('input', { type: 'number', min: 0.5, max: 100, step: 0.5, value: 6, inputmode: 'decimal' });
  const choices = h('div', {});
  const el = h('div', { class: 'map map-tall' });
  const mapNote = h('p', { class: 'small muted' });
  const simBox = h('div', {});
  const out = h('div', {});
  const profileBox = h('div', {});

  let map = null;
  let base = null; // every AP
  let pointLayer = null; // the checked point and its APs
  let simLayer = null; // radio simulation of one AP
  let point = null;
  let allAps = [];

  // CPE height: starts from the default of Impostazioni server, changed for every check
  api('/api/admin/pointing/config')
    .then((c) => (height.value = c.cpeHeightM))
    .catch(() => {});

  async function ensureMap() {
    if (map) return map;
    for (let i = 0; i < 60 && !el.isConnected; i++) await new Promise((r) => setTimeout(r, 50));
    map = await createMap(el, { zoom: 9 });
    if (!map) return null;
    const L = window.L;
    simLayer = L.layerGroup().addTo(map);
    base = L.layerGroup().addTo(map);
    pointLayer = L.layerGroup().addTo(map);
    // a click on the map checks that point
    map.on('click', (e) => check(e.latlng.lat, e.latlng.lng, 'Punto scelto sulla mappa'));
    setTimeout(() => map.invalidateSize(), 200);
    return map;
  }

  async function loadAps() {
    const d = await api('/api/network/status');
    allAps = [...d.pops.flatMap((p) => p.aps.map((a) => ({ ...a, pop: p.name }))), ...d.apsWithoutPop.map((a) => ({ ...a, pop: null }))].filter((a) => a.lat != null && a.lon != null);
    const m = await ensureMap();
    if (!m) return;
    const L = window.L;
    base.clearLayers();
    const pts = allAps.map((a) => {
      const sim = h('button', { type: 'button', class: 'small-btn', onclick: () => (m.closePopup(), simulate(a.id)) }, 'Simula copertura');
      return L.circleMarker([a.lat, a.lon], { radius: 5, color: STATE_COLOR[a.state] ?? '#64748b', weight: 2, fillOpacity: 0.85, bubblingMouseEvents: false })
        .bindTooltip(a.name)
        .bindPopup(h('div', {}, popup(a.name, a.ssid && a.ssid !== a.name ? a.ssid : null, a.pop ? `POP ${a.pop}` : 'AP senza POP', a.model), h('div', { class: 'btns' }, sim)))
        .addTo(base);
    });
    mapNote.textContent = `${pts.length} AP sulla mappa. Clic su un punto qualsiasi per verificarlo; clic su un AP per simularne la copertura.`;
    if (pts.length && !point) fit(m, pts);
  }

  /** Nearest APs ranked for the point, drawn on the map with the lines towards them. */
  async function check(la, lo, label) {
    point = { la, lo, label };
    mount(out, card(h('p', { class: 'muted' }, 'Valutazione degli AP…')));
    mount(profileBox);
    let r;
    try {
      // every AP in range, already ranked by the server (50 is its maximum): nothing to choose by hand
      const hM = Number(String(height.value).replace(',', '.'));
      r = await api(`/api/coverage?lat=${la}&lon=${lo}&limit=50&km=${howFar.value}${hM >= 0.5 && hM <= 100 ? `&height=${hM}` : ''}`);
    } catch (e) {
      return mount(out, h('div', { class: 'notice bad' }, e.message));
    }
    // usable APs first; the unlikely and inactive ones stay folded below
    const useful = r.aps.filter((a) => a.rating !== 'improbabile' && a.rating !== 'non attivo');
    const others = r.aps.filter((a) => !useful.includes(a));
    const m = await ensureMap();
    if (m) {
      const L = window.L;
      pointLayer.clearLayers();
      const layers = [L.circleMarker([la, lo], { radius: 8, color: C.point, weight: 3, fillOpacity: 0.95 }).bindPopup(popup(label, `${la.toFixed(5)}, ${lo.toFixed(5)}`)).addTo(pointLayer)];
      for (const a of useful) {
        const color = RATING_COLOR[a.rating] ?? '#64748b';
        L.polyline([[la, lo], [a.lat, a.lon]], { color, weight: a === useful[0] ? 4 : 2, dashArray: a === useful[0] ? null : '6 6', interactive: false }).addTo(pointLayer);
        layers.push(L.circleMarker([a.lat, a.lon], { radius: 7, color, weight: 3, fillOpacity: 0.2, interactive: false }).addTo(pointLayer));
      }
      fit(m, layers);
    }
    const best = useful[0] ?? r.aps[0];
    const apTable = (list) =>
      table(
        [
          { label: 'Valutazione', render: (a) => (a.rating ? badge(...RATING[a.rating]) : '—') },
          { label: 'AP', render: (a) => h('div', {}, h('b', {}, a.name || a.id), h('div', { class: 'small muted' }, [a.ssid, a.siteName].filter(Boolean).join(' · '))) },
          { label: 'Distanza', render: (a) => km(a.distanceM) },
          { label: 'Puntamento', render: (a) => h('span', { class: 'bearing' }, h('span', { class: 'arrow', 'data-deg': a.bearing }, '↑'), ` ${a.bearing}° ${a.direction}`) },
          { label: 'Segnale stimato', render: (a) => estimateCell(a.estimate) },
          { label: 'Client', render: (a) => a.stations ?? '—' },
          { label: 'Frequenza', render: (a) => (a.frequency ? `${a.frequency} MHz` : '—') },
          {
            label: '',
            render: (a) =>
              h(
                'div',
                { class: 'btns ap-actions' },
                h('button', { type: 'button', class: 'small-btn', onclick: () => simulate(a.id) }, 'Simula'),
                h('button', { type: 'button', class: 'small-btn', onclick: (e) => profile(a, e.currentTarget) }, 'Visibilità'),
              ),
          },
        ],
        list,
      );
    mount(
      out,
      card(
        h('h2', {}, 'AP consigliati per il punto'),
        h('p', { class: 'small muted' }, `${label} · ${la.toFixed(5)}, ${lo.toFixed(5)} · `, h('a', { href: osmLink(la, lo), target: '_blank', rel: 'noopener' }, 'apri su OpenStreetMap')),
        r.aps.length
          ? [
              best
                ? h(
                    'div',
                    { class: `notice ${best.rating === 'buono' ? 'good' : best.rating === 'possibile' ? 'warn' : 'bad'}` },
                    h('b', {}, best.rating === 'buono' ? 'Copertura probabile: ' : best.rating === 'possibile' ? 'Copertura da verificare: ' : 'Copertura improbabile: '),
                    `il migliore è ${best.name}, a ${km(best.distanceM)}`,
                    best.estimate?.signalDbm != null ? `, segnale stimato ${best.estimate.signalDbm} dBm.` : ', senza stima del segnale.',
                  )
                : null,
              useful.length ? apTable(useful) : h('div', { class: 'notice warn' }, 'Nessun AP utilizzabile da qui: tutti quelli nel raggio sono improbabili o spenti.'),
              others.length ? h('details', { class: 'more-aps' }, h('summary', {}, `Altri ${others.length} AP nel raggio (segnale stimato insufficiente o non attivi)`), apTable(others)) : null,
            ]
          : h('div', { class: 'notice warn' }, `Nessun AP con posizione entro ${r.maxKm} km da questo punto.`),
        h(
          'p',
          { class: 'small muted' },
          `${r.inRange} AP valutati entro ${r.maxKm} km${r.inRange > r.aps.length ? ` (mostrati i ${r.aps.length} migliori)` : ''}, ordinati per segnale stimato (minimo per il collaudo ${r.minSignalDbm} dBm). La stima viene dalle CPE già collegate a ogni AP; la visibilità usa il terreno e l’altezza della CPE indicata sopra.`,
        ),
      ),
    );
    orientArrows(out);
  }

  /** Estimated signal of a new CPE all around one AP (from its customers), on the map. */
  async function simulate(apId) {
    const m = await ensureMap();
    if (!m) return;
    mount(simBox, h('p', { class: 'small muted' }, 'Simulazione in corso…'));
    let d;
    try {
      d = await api(`/api/admin/coverage/simulation?apId=${encodeURIComponent(apId)}`);
    } catch (e) {
      return mount(simBox, h('div', { class: 'notice bad' }, e.message));
    }
    const L = window.L;
    simLayer.clearLayers();
    if (!d.cells.length) {
      return mount(
        simBox,
        h('div', { class: 'notice warn' }, `${d.ap.name}: simulazione non possibile, ${d.customers ? 'troppo pochi clienti con segnale e posizione' : 'nessun cliente con posizione'} per stimare il segnale.`, ' ', clearBtn()),
      );
    }
    const half = d.cellM / 2;
    const mPerLat = 111320;
    const mPerLon = 111320 * Math.cos((d.ap.lat * Math.PI) / 180);
    for (const c of d.cells) {
      if (c.dbm < d.minDbm - 15) continue; // clearly no coverage: left blank, not a red disc
      L.rectangle(
        [
          [c.lat - half / mPerLat, c.lon - half / mPerLon],
          [c.lat + half / mPerLat, c.lon + half / mPerLon],
        ],
        { stroke: false, fillColor: scaleColor(c.dbm), fillOpacity: d.theoretical ? 0.3 : c.confidence === 'bassa' ? 0.18 : 0.38, interactive: false },
      ).addTo(simLayer);
    }
    // learned: the area already served; theory: the sector of the antenna (azimuth from UISP)
    if (d.sector && (d.servedM || d.theoretical)) {
      const reach = d.servedM || d.radiusM;
      const pts = [[d.ap.lat, d.ap.lon]];
      for (let i = 0; i <= 24; i++) pts.push(towards(d.ap.lat, d.ap.lon, d.sector.center - d.sector.width / 2 + (d.sector.width * i) / 24, reach));
      L.polygon(pts, { color: '#0f172a', weight: 1.5, fill: false, dashArray: '4 5', interactive: false }).addTo(simLayer);
    }
    L.circleMarker([d.ap.lat, d.ap.lon], { radius: 8, color: '#0f172a', weight: 3, fillColor: '#ffffff', fillOpacity: 1, interactive: false }).addTo(simLayer);
    if (!point) m.fitBounds(L.latLng(d.ap.lat, d.ap.lon).toBounds(d.radiusM * 2.1));
    const good = d.cells.filter((c) => c.dbm >= d.minDbm).length;
    mount(
      simBox,
      h(
        'div',
        { class: 'sim-info' },
        h('b', {}, `Simulazione ${d.theoretical ? 'teorica ' : ''}di ${d.ap.name}`),
        h(
          'span',
          { class: 'small muted' },
          ` · ${d.theoretical ? 'nessun cliente da cui calibrare' : `calibrata su ${d.customers} clienti`}${d.ignored ? ` (${d.ignored} con posizione non valida in UISP, esclusi)` : ''} · raggio ${km(d.radiusM)} · ${Math.round((100 * good) / d.cells.length)}% dell’area sopra ${d.minDbm} dBm`,
        ),
        ' ',
        clearBtn(),
        legend(SCALE.map(([, color, text]) => [color, text])),
        h(
          d.theoretical ? 'div' : 'p',
          { class: d.theoretical ? 'notice warn' : 'small muted' },
          `Segnale atteso per una CPE nuova: potenza irradiata dell’AP e guadagno della CPE (Impostazioni server → Simulazione radio), spazio libero${d.antenna ? ', diagramma dell’antenna (azimut da UISP)' : ''}${d.terrain ? ' e terreno tra ogni punto e l’AP (colline; edifici e alberi non sono nel modello)' : ' (terreno non disponibile: le colline non sono considerate)'}. `,
          d.theoretical
            ? 'Stima teorica, margine ±8 dB: l’AP non ha ancora clienti con segnale da cui calibrarla.'
            : 'I clienti già collegati correggono la teoria, con un peso che cresce con il loro numero: pochi clienti, stima vicina alla teoria.',
          ' Area vuota: nessuna copertura (sotto −90 dBm). Colori tenui: stima poco affidabile. Tratteggio: settore dell’antenna o area già servita. Per un punto preciso usa Visibilità.',
        ),
      ),
    );
  }

  function clearBtn() {
    return h('button', { type: 'button', class: 'small-btn', onclick: () => (simLayer?.clearLayers(), mount(simBox)) }, 'Togli simulazione');
  }

  /** Line of sight from the checked point (with the CPE height above) to one AP. */
  async function profile(a, btn) {
    if (!point) return;
    const hM = Number(String(height.value).replace(',', '.'));
    if (!(hM >= 0.5 && hM <= 100)) return toast('Altezza della CPE non valida (0,5–100 m)');
    await busy(btn, async () => {
      let p;
      try {
        p = await api(`/api/pointing/profile?lat=${point.la}&lon=${point.lo}&apId=${encodeURIComponent(a.id)}&height=${hM}`);
      } catch (e) {
        return mount(profileBox, card(h('h2', {}, `Visibilità verso ${a.name}`), h('div', { class: 'notice bad' }, e.message)));
      }
      const verdict = { clear: ['Visibilità libera', 'good'], fresnel: ['Linea libera ma zona di Fresnel invasa', 'warn'], blocked: ['Linea ostruita dal terreno', 'bad'] }[p.verdict];
      mount(
        profileBox,
        card(
          h('h2', {}, `Visibilità verso ${a.name}`),
          h(
            'p',
            {},
            badge(verdict[0], verdict[1]),
            ` ${km(p.distanceM)} · CPE a ${dec(p.cpeHeightM)} m dal suolo · ${p.frequencyMhz} MHz`,
            p.worst ? ` · punto critico a ${km(p.worst.d)}: margine ${dec(p.worst.clearanceM)} m (servono ${dec(p.worst.fresnel60M)} m)` : '',
            p.verdict === 'clear' || !(p.raiseCpeM > 0)
              ? ''
              : p.raiseCpeM <= MAX_MAST_M
                ? ` · alzando la CPE di ${dec(p.raiseCpeM)} m si libera`
                : ` · non basta un palo di ${MAX_MAST_M} m: scegli un altro AP`,
          ),
          profileChart(p),
          legend([
            ['#a8a29e', 'terreno (con la curvatura terrestre)'],
            ['#2563eb', 'linea di vista'],
            ['#f59e0b', '60% della prima zona di Fresnel'],
          ]),
          h('p', { class: 'small muted' }, 'Modello del terreno SRTM (circa 30 m): edifici e alberi non ci sono. Cambia l’altezza della CPE sopra e premi di nuovo Visibilità.'),
        ),
      );
    });
  }

  const form = h(
    'form',
    {
      class: 'row',
      onsubmit: (e) => {
        e.preventDefault();
        const q = search.value.trim();
        if (!q) return;
        busy(searchBtn, async () => {
          mount(choices);
          const coords = parseCoords(q);
          if (coords) return check(coords[0], coords[1], 'Coordinate inserite');
          // the name of an AP: show it and simulate it
          const ql = q.toLowerCase();
          const ap = allAps.find((a) => a.name.toLowerCase() === ql) ?? allAps.find((a) => `${a.name} ${a.ssid ?? ''}`.toLowerCase().includes(ql));
          if (ap) {
            const m = await ensureMap();
            m?.setView([ap.lat, ap.lon], 13);
            return simulate(ap.id);
          }
          const list = await api(`/api/geocode?q=${encodeURIComponent(q)}`);
          if (!list.length) return mount(choices, h('div', { class: 'notice warn' }, 'Né indirizzo né AP trovati: prova ad aggiungere comune o CAP, oppure scrivi le coordinate.'));
          if (list.length === 1) return check(list[0].lat, list[0].lon, list[0].label);
          mount(choices, h('div', { class: 'btns' }, list.map((r) => h('button', { type: 'button', onclick: () => (mount(choices), check(r.lat, r.lon, r.label)) }, r.label))));
        });
      },
    },
    search,
    searchBtn,
    gps,
  );

  gps.onclick = () => {
    if (!('geolocation' in navigator) || !window.isSecureContext) return toast('Il browser dà la posizione solo su HTTPS: usa l’indirizzo o le coordinate.');
    gps.disabled = true;
    navigator.geolocation.getCurrentPosition(
      (p) => ((gps.disabled = false), check(p.coords.latitude, p.coords.longitude, `Posizione del dispositivo (±${Math.round(p.coords.accuracy)} m)`)),
      (err) => ((gps.disabled = false), toast(`Posizione non disponibile: ${err.message}`)),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };
  // a different radius: check the same point again
  howFar.addEventListener('change', () => point && check(point.la, point.lo, point.label));

  loadAps().catch((e) => (mapNote.textContent = `AP non disponibili: ${e.message}`));

  return h(
    'div',
    {},
    pageHead('Copertura', 'Verifica un punto, confronta gli AP e simula il segnale. Solo amministratori: gli installatori hanno la loro verifica, con i limiti impostati.'),
    card(
      h('h2', {}, 'Verifica un punto'),
      form,
      choices,
      h('div', { class: 'row' }, field('Cerca gli AP entro', howFar), field('Altezza della CPE dal suolo (m)', height)),
      h('p', { class: 'small muted' }, 'Scrivi un indirizzo, delle coordinate o il nome di un AP, oppure clicca sulla mappa. L’altezza della CPE vale per la visibilità di questo punto.'),
    ),
    card(
      h('h2', {}, 'Mappa della rete'),
      el,
      legend([
        [STATE_COLOR.ok, 'AP in funzione'],
        [STATE_COLOR.degraded, 'molte CPE offline'],
        [STATE_COLOR.down, 'non raggiungibile'],
        [C.point, 'punto verificato'],
      ]),
      mapNote,
      simBox,
    ),
    out,
    profileBox,
  );
}
