import { api } from '../api.js';
import { badge, busy, card, field, fmtDate, h, mount, pageHead, table, toast } from '../dom.js';
import { createMap, drawFresnelLink, fit, legend, pointPicker, popup, simulationOverlay, towards, MAP_COLORS as C } from '../map.js';
import { openLink3d } from '../map3d.js';
import { estimateCell, loadCell, orientArrows, osmLink, RATING } from './coverage.js';

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
/** Capacity scale of the simulation (downlink of the radio link), Mbit/s. */
const CAP_SCALE = [
  [150, '#15803d', 'oltre 150 Mbit/s'],
  [100, '#22c55e', '100–150'],
  [50, '#a3e635', '50–100'],
  [25, '#facc15', '25–50'],
  [10, '#f97316', '10–25'],
  [-1, '#dc2626', 'sotto 10'],
];
const capColor = (mbps) => CAP_SCALE.find(([min]) => mbps >= min)[1];
/** Tallest mast worth suggesting for a CPE (same limit as the app). */
const MAX_MAST_M = 12;
const dec = (n) => String(Math.round(n * 10) / 10).replace('.', ',');

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

const ALT_FROM = { sito: 'altezza del sito in UISP', gps: 'altitudine GPS di UISP (il sito non ha l’altezza)', uisp: 'altezza dal suolo scritta in UISP', terreno: 'altezza predefinita (Impostazioni server), UISP non la indica' };

/** First Fresnel zone radius at [d] of a [D] m link, m. */
const fresnelR = (d, D, freqMhz) => Math.sqrt(((299.79 / (freqMhz || 5600)) * d * Math.max(0, D - d)) / D);

/**
 * Elevation profile of the link, as in UISP Design: ground (with the earth bulge) and the obstacles
 * on it, the two antennas on their masts, the line of sight, the whole first Fresnel zone (ellipse)
 * and its 60% limit, distances along the bottom and the critical point.
 */
export function profileChart(p) {
  const W = 980;
  const H = 300;
  const pad = { l: 52, r: 16, t: 18, b: 34 };
  const pts = p.chart.map((q) => ({ ...q, r: fresnelR(q.d, p.distanceM, p.frequencyMhz) }));
  const D = pts[pts.length - 1].d || 1;
  const ys = pts.flatMap((q) => [q.ground, q.top ?? q.ground, q.los + q.r, q.los - q.r]);
  const lo = Math.floor(Math.min(...ys) - 8);
  const hi = Math.ceil(Math.max(...ys) + 8);
  const x = (d) => pad.l + ((W - pad.l - pad.r) * d) / D;
  const y = (v) => pad.t + ((H - pad.t - pad.b) * (hi - v)) / (hi - lo || 1);
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'los-chart link-chart', role: 'img', 'aria-label': 'Profilo del collegamento' });
  // grid and axes
  const stepM = [100, 250, 500, 1000, 2000, 5000].find((st) => D / st <= 10) ?? 5000;
  for (let d = 0; d <= D; d += stepM) {
    svg.append(s('line', { x1: x(d), x2: x(d), y1: pad.t, y2: H - pad.b, class: 'link-grid' }));
    const t = s('text', { x: x(d), y: H - 12, class: 'los-axis', 'text-anchor': d === 0 ? 'start' : 'middle' });
    t.textContent = km(Math.round(d));
    svg.append(t);
  }
  for (const v of [lo, Math.round((lo + hi) / 2), hi]) {
    svg.append(s('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: 'link-grid' }));
    const t = s('text', { x: pad.l - 6, y: y(v) + 4, class: 'los-axis', 'text-anchor': 'end' });
    t.textContent = `${v} m`;
    svg.append(t);
  }
  // Fresnel ellipse (whole first zone), then terrain and obstacles over it
  const upper = pts.map((q) => `${x(q.d)},${y(q.los + q.r)}`);
  const lower = pts.map((q) => `${x(q.d)},${y(q.los - q.r)}`).reverse();
  svg.append(s('path', { d: `M${upper.join(' L')} L${lower.join(' L')} Z`, class: 'link-fresnel' }));
  svg.append(s('path', { d: 'M' + pts.map((q) => `${x(q.d)},${y(q.los - 0.6 * q.r)}`).join(' L'), class: 'los-fresnel' }));
  const step = pts.length > 1 ? Math.max(1.5, (x(pts[1].d) - x(pts[0].d)) * 0.95) : 2;
  for (const q of pts) if (q.obstacle && q.top > q.ground) svg.append(s('rect', { x: x(q.d) - step / 2, y: y(q.top), width: step, height: Math.max(1, y(q.ground) - y(q.top)), class: q.obstacle === 'edificio' ? 'los-building' : 'los-tree' }));
  svg.append(s('path', { d: `M${x(0)},${y(lo)} ` + pts.map((q) => `L${x(q.d)},${y(q.ground)}`).join(' ') + ` L${x(D)},${y(lo)} Z`, class: 'los-ground' }));
  // line of sight, coloured where it is obstructed
  svg.append(s('path', { d: 'M' + pts.map((q) => `${x(q.d)},${y(q.los)}`).join(' L'), class: 'los-line' }));
  // the antennas on their masts
  const first = pts[0];
  const last = pts[pts.length - 1];
  for (const [q, label, anchor, dx] of [[first, `CPE ${dec(first.los - first.ground)} m`, 'start', 6], [last, `AP ${dec(last.los - last.ground)} m`, 'end', -6]]) {
    svg.append(s('line', { x1: x(q.d), x2: x(q.d), y1: y(q.ground), y2: y(q.los), class: 'link-mast' }));
    svg.append(s('circle', { cx: x(q.d), cy: y(q.los), r: 5, class: 'link-antenna' }));
    const t = s('text', { x: x(q.d) + dx, y: y(q.los) - 9, class: 'link-label', 'text-anchor': anchor });
    t.textContent = label;
    svg.append(t);
  }
  if (p.worst) {
    const q = pts.reduce((a, b) => (Math.abs(b.d - p.worst.d) < Math.abs(a.d - p.worst.d) ? b : a));
    svg.append(s('line', { x1: x(q.d), x2: x(q.d), y1: y(Math.max(q.ground, q.top ?? q.ground)), y2: y(q.los), class: 'link-critical' }));
    svg.append(s('circle', { cx: x(q.d), cy: y(Math.max(q.ground, q.top ?? q.ground)), r: 5, class: 'los-worst' }));
  }
  return h('div', { class: 'link-chart-wrap' }, svg);
}

/** Bearing from [a] to [b], degrees from north. */
const bearing = (a, b) => {
  const f1 = (a[0] * Math.PI) / 180;
  const f2 = (b[0] * Math.PI) / 180;
  const dl = ((b[1] - a[1]) * Math.PI) / 180;
  return ((Math.atan2(Math.sin(dl) * Math.cos(f2), Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl)) * 180) / Math.PI + 360) % 360;
};
const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
const dir = (deg) => `${Math.round(deg)}° ${DIRS[Math.round(deg / 45) % 8]}`;

/** The figures of the link, as in the side panel of UISP Design. */
export function linkFacts(p, from, estimate) {
  const first = p.chart[0];
  const last = p.chart[p.chart.length - 1];
  const tilt = (Math.atan2(last.los - first.los, p.distanceM) * 180) / Math.PI;
  const az = p.ap.lat != null ? bearing(from, [p.ap.lat, p.ap.lon]) : null;
  const clearPct = p.worst ? Math.round((100 * p.worst.clearanceM) / (p.worst.fresnel60M / 0.6 || 1)) : null;
  const fact = (label, value, sub) => h('div', { class: 'link-fact' }, h('small', {}, label), h('strong', {}, value), sub ? h('span', { class: 'small muted' }, sub) : null);
  return h(
    'div',
    { class: 'link-facts' },
    fact('Distanza', km(p.distanceM)),
    fact('Frequenza', `${p.frequencyMhz} MHz`),
    az !== null ? fact('Puntamento CPE → AP', dir(az), `inclinazione ${tilt >= 0 ? '+' : ''}${dec(tilt)}°`) : null,
    az !== null ? fact('Puntamento AP → CPE', dir((az + 180) % 360), `inclinazione ${-tilt >= 0 ? '+' : ''}${dec(-tilt)}°`) : null,
    fact('Antenna CPE', `${dec(first.los - first.ground)} m dal suolo`, `${Math.round(first.los)} m s.l.m.`),
    fact('Antenna AP', `${dec(last.los - last.ground)} m dal suolo`, `${Math.round(last.los)} m s.l.m.`),
    estimate?.signalDbm != null ? fact('Segnale stimato', `${estimate.signalDbm} dBm`, estimate.low != null ? `${estimate.low}…${estimate.high} dBm` : null) : null,
    clearPct !== null ? fact('Fresnel libera', `${Math.max(0, clearPct)}%`, `nel punto critico, a ${km(p.worst.d)}`) : fact('Fresnel libera', '100%', 'su tutto il collegamento'),
  );
}

/** The CPE of a row: the model used for the estimate, proposed or chosen. */
function cpeCell(c, goodDbm) {
  if (!c) return '—';
  return h(
    'div',
    {},
    h('b', {}, c.name),
    h('div', { class: 'small muted' }, `${c.gainDbi} dBi${c.auto ? (c.proposed ? ' · consigliata' : ` · nessuna arriva a ${goodDbm} dBm: di riferimento`) : ' · scelta'}`),
  );
}

/**
 * Indicative airMAX ac receive sensitivity at 40 MHz (dBm) for MCS 0…9, with the airOS rate
 * multiplier: where the expected signal falls on the modulation scale, as in UISP Design.
 */
const MCS_SCALE = [
  [-91, '1x'],
  [-89, '2x'],
  [-86, '3x'],
  [-83, '4x'],
  [-79, '6x'],
  [-75, '8x'],
  [-73, '9x'],
  [-71, '10x'],
  [-66, '12x'],
  [-64, '13x'],
];
/** Magnetic declination in central Sicily (2026, east), to point with a compass. */
export const DECLINATION_DEG = 4;

/** Expected signal on the modulation scale: the bar fills up to the signal, the reached MCS lit. */
export function signalBar(dbm) {
  const lo = -95;
  const hi = -50;
  const pct = dbm == null ? 0 : Math.max(0, Math.min(100, ((dbm - lo) / (hi - lo)) * 100));
  const bar = h('div', { class: 'mcs-bar' }, h('span', { class: 'mcs-fill' }));
  bar.firstChild.style.width = `${pct}%`;
  const reached = dbm == null ? -1 : MCS_SCALE.filter(([min]) => dbm >= min).length - 1;
  return h(
    'div',
    { class: 'mcs' },
    h('div', { class: 'mcs-head' }, h('span', {}, 'Segnale atteso'), h('b', {}, dbm == null ? '—' : `${dbm} dBm`)),
    bar,
    h('div', { class: 'mcs-steps' }, MCS_SCALE.map(([, label], k) => h('span', { class: k <= reached ? 'on' : '' }, label))),
  );
}

export async function adminCoverageView() {
  const search = h('input', { type: 'search', class: 'grow', placeholder: 'Indirizzo, coordinate (37.56, 14.27) o nome di un AP', autocomplete: 'off' });
  const searchBtn = h('button', { type: 'submit', class: 'primary' }, 'Cerca');
  const gps = h('button', { type: 'button' }, 'La mia posizione');
  // the farthest real link is 20 km (usually under 15): beyond that no AP is worth proposing
  const howFar = h('select', {}, ...[5, 10, 15, 20].map((n) => h('option', { value: n, selected: n === 20 }, `entro ${n} km`)));
  const height = h('input', { type: 'number', min: 0.5, max: 100, step: 0.5, value: 6, inputmode: 'decimal' });
  // the CPE to install: proposed for each AP, or one model for all (the list comes with the answer)
  const cpe = h('select', {}, h('option', { value: 'auto' }, 'Consigliata per ogni AP'));
  const cpeOptions = (models) => {
    if (cpe.options.length > 1 || !models?.length) return;
    for (const m of models) cpe.append(h('option', { value: m.id }, `${m.name} · ${m.gainDbi} dBi`));
  };
  cpe.onchange = () => point && check(point.la, point.lo, point.label);
  const choices = h('div', {});
  const el = h('div', { class: 'map map-tall' });
  // the link of the selected AP docked on the map, as in UISP Design (AP | link | CPE)
  const dock = h('div', { class: 'link-dock', hidden: true });
  let selected = null; // the AP of the dock, reopened when the check is done again
  const mapNote = h('p', { class: 'small muted' });
  const simBox = h('div', {});
  const out = h('div', {});
  const profileBox = h('div', {});

  let map = null;
  let base = null; // every AP
  let pointLayer = null; // the checked point and its APs
  let linkLayer = null; // Visibilità: the link and its Fresnel zone
  let picker = null;
  let simLayer = null; // radio simulation of one AP
  let point = null;
  let allAps = [];

  // CPE height: starts from the default of Impostazioni server, changed for every check
  api('/api/admin/pointing/config')
    .then((c) => (height.value = c.cpeHeightM))
    .catch(() => {});

  // the model on the real customers (last Affidabilità della stima): where it gets it right
  let realLayer = null;
  let koLayer = null;
  const realToggle = h('input', { type: 'checkbox' });
  const koToggle = h('input', { type: 'checkbox' });
  let accuracyLast = null;
  const accuracyData = async () => (accuracyLast ??= (await api('/api/admin/coverage/accuracy')).last ?? {});
  const ERR_COLOR = (e) => (Math.abs(e) <= 6 ? '#16a34a' : Math.abs(e) <= 12 ? '#f59e0b' : '#dc2626');
  realToggle.onchange = async () => {
    const m = await ensureMap();
    if (!m) return;
    const L = window.L;
    realLayer ??= L.layerGroup();
    realLayer.clearLayers();
    if (!realToggle.checked) return m.removeLayer(realLayer);
    const pts = (await accuracyData()).points ?? [];
    if (!pts.length) toast('Nessuna misura: avvia «Affidabilità della stima» qui sotto');
    for (const p of pts) {
      const err = p.estimateDbm - p.realDbm;
      L.circleMarker([p.lat, p.lon], { radius: 4, color: ERR_COLOR(err), weight: 1, fillOpacity: 0.8, bubblingMouseEvents: false })
        .bindPopup(popup(p.device, `AP ${p.ap}`, `reale ${p.realDbm} dBm · stimato ${p.estimateDbm} dBm`, `${err > 0 ? 'stima ottimista' : err < 0 ? 'stima pessimista' : 'esatta'} di ${Math.abs(err)} dB`))
        .addTo(realLayer);
    }
    realLayer.addTo(m);
  };
  koToggle.onchange = async () => {
    const m = await ensureMap();
    if (!m) return;
    const L = window.L;
    koLayer ??= L.layerGroup();
    koLayer.clearLayers();
    if (!koToggle.checked) return m.removeLayer(koLayer);
    const KO = { no_signal: 'nessun segnale', no_link: 'non si aggancia', obstacles: 'ostacoli' };
    for (const f of (await accuracyData()).failurePoints ?? []) {
      L.marker([f.lat, f.lon], { icon: L.divIcon({ className: 'ko-pin', html: '✕', iconSize: [16, 16] }) })
        .bindPopup(popup('Installazione fallita', KO[f.reason] ?? f.reason, f.ap ? `verso ${f.ap}` : null, fmtDate(f.at)))
        .addTo(koLayer);
    }
    koLayer.addTo(m);
  };

  async function ensureMap() {
    if (map) return map;
    for (let i = 0; i < 60 && !el.isConnected; i++) await new Promise((r) => setTimeout(r, 50));
    map = await createMap(el, { zoom: 9 });
    if (!map) return null;
    const L = window.L;
    simLayer = L.layerGroup().addTo(map);
    base = L.layerGroup().addTo(map);
    pointLayer = L.layerGroup().addTo(map);
    linkLayer = L.layerGroup().addTo(map);
    // a click on the map checks that point
    // the first click places the point; then the map moves freely and the point is dragged
    picker = pointPicker(map, (la, lo) => check(la, lo, 'Punto scelto sulla mappa'));
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
    mapNote.textContent = `${pts.length} AP sulla mappa. Il primo clic sulla mappa sceglie il punto da verificare; poi la mappa si sposta liberamente e il punto si sposta trascinandolo (o con Nuovo punto sulla mappa). Clic su un AP per simularne la copertura.`;
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
      r = await api(`/api/coverage?lat=${la}&lon=${lo}&limit=50&km=${howFar.value}${hM >= 0.5 && hM <= 100 ? `&height=${hM}` : ''}&cpe=${encodeURIComponent(cpe.value)}`);
      cpeOptions(r.cpeModels);
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
      linkLayer.clearLayers();
      const layers = [picker.set(la, lo, pointLayer).bindPopup(popup(label, `${la.toFixed(5)}, ${lo.toFixed(5)}`, 'Trascina il punto per spostarlo'))];
      for (const a of useful) {
        const color = RATING_COLOR[a.rating] ?? '#64748b';
        L.polyline([[la, lo], [a.lat, a.lon]], { color, weight: a === useful[0] ? 4 : 2, dashArray: a === useful[0] ? null : '6 6', interactive: false }).addTo(pointLayer);
        layers.push(L.circleMarker([a.lat, a.lon], { radius: 7, color, weight: 3, fillOpacity: 0.2, interactive: false }).addTo(pointLayer));
      }
      fit(m, layers);
    }
    const best = useful[0] ?? r.aps[0];
    // the dock follows the check: the same AP again (another CPE or height), closed otherwise
    const again = selected ? r.aps.find((x) => x.id === selected) : null;
    if (again) setTimeout(() => profile(again), 0);
    else closeDock();
    const apTable = (list) =>
      table(
        [
          { label: 'Valutazione', render: (a) => (a.rating ? badge(...RATING[a.rating]) : '—') },
          { label: 'AP', render: (a) => h('div', {}, h('b', {}, a.name || a.id), h('div', { class: 'small muted' }, [a.ssid, a.siteName].filter(Boolean).join(' · '))) },
          { label: 'Distanza', render: (a) => km(a.distanceM) },
          { label: 'Puntamento', render: (a) => h('span', { class: 'bearing' }, h('span', { class: 'arrow', 'data-deg': a.bearing }, '↑'), ` ${a.bearing}° ${a.direction}`) },
          { label: 'CPE', render: (a) => cpeCell(a.cpe, r.goodSignalDbm) },
          { label: 'Segnale stimato', render: (a) => h('div', {}, estimateCell(a.estimate), a.failures ? h('div', { class: 'small' }, `${a.failures} ${a.failures === 1 ? 'installazione fallita' : 'installazioni fallite'} qui vicino verso questo AP`) : null) },
          { label: 'Carico (20–23)', render: (a) => loadCell(a.load) },
          { label: 'Client', render: (a) => a.stations ?? '—' },
          { label: 'Frequenza', render: (a) => (a.frequency ? `${a.frequency} MHz` : '—') },
          {
            label: '',
            render: (a) =>
              h(
                'div',
                { class: 'btns ap-actions' },
                h('button', { type: 'button', class: 'small-btn', onclick: (e) => (e.stopPropagation(), simulate(a.id)) }, 'Simula'),
                h('button', { type: 'button', class: 'small-btn', onclick: (e) => (e.stopPropagation(), profile(a, e.currentTarget)) }, 'Visibilità'),
              ),
          },
        ],
        list,
        // a row opens the link on the map, as clicking a link in UISP Design
        (a) => profile(a),
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
          : h('div', { class: 'notice warn' }, r.hiddenWeak ? `Nessun AP con segnale stimato migliore di ${r.hideBelowDbm} dBm: ${r.hiddenWeak} ${r.hiddenWeak === 1 ? 'AP più debole non mostrato' : 'AP più deboli non mostrati'} (soglia in Impostazioni server → Copertura per gli installatori, −100 = tutti).` : `Nessun AP con posizione entro ${r.maxKm} km da questo punto.`),
        h(
          'p',
          { class: 'small muted' },
          `${r.inRange} AP valutati entro ${r.maxKm} km${r.hiddenWeak ? `, ${r.hiddenWeak} non mostrati perché più deboli di ${r.hideBelowDbm} dBm (Impostazioni server)` : ''}${r.inRange - (r.hiddenWeak ?? 0) > r.aps.length ? ` (mostrati i ${r.aps.length} migliori)` : ''}, ordinati per segnale stimato (minimo per il collaudo ${r.minSignalDbm} dBm). La stima viene dalle CPE già collegate a ogni AP; la visibilità usa il terreno e l’altezza della CPE indicata sopra.`,
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
      d = await api(`/api/admin/coverage/simulation?apId=${encodeURIComponent(apId)}${cpe.value !== 'auto' ? `&cpe=${encodeURIComponent(cpe.value)}` : ''}`);
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
    // signal or capacity of a new link: same cells, two scales; one pixel per cell, drawn smooth
    const draw = (mode) => {
      simLayer.clearLayers();
      // clearly no coverage: left blank, not a red disc
      simulationOverlay(d, (c) => (c.dbm < d.minDbm - 15 ? null : mode === 'cap' ? (c.cap == null ? null : capColor(c.cap)) : scaleColor(c.dbm))).addTo(simLayer);
      // learned: the area already served; theory: the sector of the antenna (azimuth from UISP)
      if (d.sector && (d.servedM || d.theoretical)) {
        const reach = d.servedM || d.radiusM;
        const pts = [[d.ap.lat, d.ap.lon]];
        for (let i = 0; i <= 24; i++) pts.push(towards(d.ap.lat, d.ap.lon, d.sector.center - d.sector.width / 2 + (d.sector.width * i) / 24, reach));
        L.polygon(pts, { color: '#0f172a', weight: 1.5, fill: false, dashArray: '4 5', interactive: false }).addTo(simLayer);
      }
      L.circleMarker([d.ap.lat, d.ap.lon], { radius: 8, color: '#0f172a', weight: 3, fillColor: '#ffffff', fillOpacity: 1, interactive: false }).addTo(simLayer);
      mount(legendBox, legend((mode === 'cap' ? CAP_SCALE : SCALE).map(([, color, text]) => [color, text])));
    };
    const legendBox = h('div', {});
    const mode = h('select', {}, h('option', { value: 'dbm' }, 'Segnale'), d.capacity ? h('option', { value: 'cap' }, 'Capacità del collegamento') : null);
    mode.onchange = () => draw(mode.value);
    draw('dbm');
    if (!point) m.fitBounds(L.latLng(d.ap.lat, d.ap.lon).toBounds(d.radiusM * 2.1));
    const good = d.cells.filter((c) => c.dbm >= d.minDbm).length;
    const fast = d.cells.filter((c) => c.dbm >= d.minDbm && (c.cap ?? 0) >= 50).length;
    mount(
      simBox,
      h(
        'div',
        { class: 'sim-info' },
        h('b', {}, `Simulazione ${d.theoretical ? 'teorica ' : ''}di ${d.ap.name}${d.cpe ? ` con ${d.cpe.name}` : ''}`),
        h(
          'span',
          { class: 'small muted' },
          ` · ${d.theoretical ? 'nessun cliente da cui calibrare' : `calibrata su ${d.customers} ${d.customers === 1 ? 'cliente' : 'clienti'}`}${d.ignored ? ` (${d.ignored} sull’AP o oltre 20 km, esclusi dal calcolo)` : ''} · raggio ${km(d.radiusM)} · ${Math.round((100 * good) / d.cells.length)}% dell’area sopra ${d.minDbm} dBm${d.capacity ? `, ${Math.round((100 * fast) / d.cells.length)}% con almeno 50 Mbit/s` : ''}`,
        ),
        ' ',
        clearBtn(),
        h('div', { class: 'row' }, field('Mostra', mode)),
        legendBox,
        d.load ? h('div', { class: 'small' }, 'Carico serale dell’AP: ', loadCell(d.load)) : null,
        h(
          d.theoretical ? 'div' : 'p',
          { class: d.theoretical ? 'notice warn' : 'small muted' },
          `Segnale atteso per una CPE nuova: potenza irradiata dell’AP e guadagno della CPE (Impostazioni server → Simulazione radio), spazio libero${d.antenna ? ', diagramma dell’antenna (azimut da UISP)' : ''}${d.terrain ? ', terreno, edifici e alberi tra ogni punto e l’AP (dove scaricati in Terreno e ostacoli)' : ' (terreno non disponibile: le colline non sono considerate)'}. `,
          d.theoretical
            ? 'Stima teorica, margine ±8 dB: l’AP non ha ancora clienti con segnale da cui calibrarla.'
            : 'I clienti già collegati correggono la teoria, con un peso che cresce con il loro numero: pochi clienti, stima vicina alla teoria.',
          d.capacity ? ' Capacità: dal segnale stimato con la curva segnale → capacità delle CPE reali della rete (e di come va questo AP); è la velocità del collegamento radio, la sera condivisa con gli altri clienti dell’AP.' : '',
          ' Area vuota: nessuna copertura (sotto −90 dBm). Colori tenui: stima poco affidabile. Tratteggio: settore dell’antenna o area già servita. Per un punto preciso usa Visibilità.',
        ),
      ),
    );
  }

  function clearBtn() {
    return h('button', { type: 'button', class: 'small-btn', onclick: () => (simLayer?.clearLayers(), mount(simBox)) }, 'Togli simulazione');
  }

  /** The link of Visibilità on the map with its Fresnel zone (admins: the AP position is known). */
  function drawLink(p) {
    if (!linkLayer || p.ap.lat == null || !point) return;
    // the docked panel covers the bottom of the map: the link is framed above it
    const below = dock.hidden ? 0 : dock.offsetHeight + 24;
    drawFresnelLink(map, linkLayer, [point.la, point.lo], p, { paddingTopLeft: [20, 20], paddingBottomRight: [20, below] });
  }

  function closeDock() {
    selected = null;
    dock.hidden = true;
    mount(dock);
  }

  /** The dock: AP (what UISP says) | the link | the CPE to install (what can be changed). */
  function renderDock(p, a) {
    const first = p.chart[0];
    const last = p.chart[p.chart.length - 1];
    const tilt = (Math.atan2(last.los - first.los, p.distanceM) * 180) / Math.PI;
    const az = p.ap.lat != null ? bearing([point.la, point.lo], [p.ap.lat, p.ap.lon]) : a.bearing;
    const e = a.estimate ?? null;
    const noise = a.load?.noiseDbm ?? null;
    const fact = (label, value, sub) => h('div', { class: 'dock-fact' }, h('small', {}, label), h('b', {}, value), sub ? h('span', {}, sub) : null);
    const verdict = { clear: ['Linea libera', 'good'], fresnel: ['Fresnel invasa', 'warn'], blocked: [p.buildings ? 'Ostruita da edifici' : 'Ostruita dal terreno', 'bad'] }[p.verdict];
    // CPE side: model and height change the check (and reopen this dock)
    const model = h('select', {}, [...cpe.options].map((o) => h('option', { value: o.value, selected: o.value === cpe.value }, o.textContent)));
    model.onchange = () => ((cpe.value = model.value), cpe.onchange());
    const hM = Number(String(height.value).replace(',', '.')) || first.los - first.ground;
    const step = (d) => () => {
      height.value = String(Math.max(1, Math.min(60, Math.round(hM + d))));
      check(point.la, point.lo, point.label);
    };
    const cap = e?.capacityMbps ?? null;
    const capBar = h('div', { class: 'cap-bar' }, h('span'));
    capBar.firstChild.style.width = `${cap == null ? 0 : Math.min(100, (cap / 400) * 100)}%`;
    mount(
      dock,
      h(
        'div',
        { class: 'dock-grid' },
        h(
          'section',
          { class: 'dock-side' },
          h('div', { class: 'dock-title' }, h('span', { class: 'dock-tag ap' }, 'AP'), h('b', {}, a.name || a.id)),
          h('div', { class: 'small muted' }, [a.model, a.ssid].filter(Boolean).join(' · ')),
          h(
            'div',
            { class: 'dock-facts' },
            fact('Frequenza', a.frequency ? `${a.frequency} MHz` : '—'),
            fact('Clienti', a.stations ?? '—', a.load?.level ? `sera: ${a.load.level}` : null),
            fact('Antenna', p.apAntenna ? `${p.apAntenna.aboveGroundM} m` : '—', p.apAntenna ? `${p.apAntenna.altitude} m s.l.m.` : null),
            fact('Rumore', noise != null ? `${noise} dBm` : '—'),
          ),
        ),
        h(
          'section',
          { class: 'dock-mid' },
          h('div', { class: 'dock-title' }, badge(verdict[0], verdict[1]), h('span', { class: 'small muted' }, `${km(p.distanceM)} · Fresnel libera ${p.worst ? Math.max(0, Math.round((100 * p.worst.clearanceM) / (p.worst.fresnel60M / 0.6 || 1))) : 100}%`)),
          h('div', { class: 'dock-cap' }, h('span', {}, 'Capacità stimata'), h('b', {}, cap == null ? '—' : `${cap} Mbit/s`)),
          capBar,
          e?.signalDbm != null && noise != null ? h('div', { class: 'small muted' }, `SNR atteso ${e.signalDbm - noise} dB`) : null,
          h('div', { class: 'dock-chart' }, profileChart(p)),
          p.ap.lat != null ? h('button', { type: 'button', class: 'small-btn dock-3d', onclick: () => show3d(p, a) }, 'Vista 3D') : null,
        ),
        h(
          'section',
          { class: 'dock-side' },
          h('div', { class: 'dock-title' }, h('span', { class: 'dock-tag cpe' }, 'CPE'), h('b', {}, point.label?.split(',')[0] ?? 'Punto')),
          field('Modello', model),
          h(
            'div',
            { class: 'dock-facts' },
            h('div', { class: 'dock-fact' }, h('small', {}, 'Altezza'), h('div', { class: 'stepper' }, h('button', { type: 'button', onclick: step(-1), 'aria-label': 'Più bassa' }, '−'), h('b', {}, `${Math.round(hM)} m`), h('button', { type: 'button', onclick: step(1), 'aria-label': 'Più alta' }, '+'))),
            fact('Puntamento', `${Math.round(az)}°`, `magnetico ${Math.round((az - DECLINATION_DEG + 360) % 360)}°`),
            fact('Inclinazione', `${tilt >= 0 ? '+' : ''}${dec(tilt)}°`),
          ),
          p.roofM ? h('div', { class: 'small muted' }, `Sul tetto: edificio di ${p.roofM} m, antenna a ${dec(p.mountedM)} m dal suolo`) : p.mountedM > hM + 0.4 ? h('div', { class: 'small muted' }, `Sopra gli ostacoli vicini: antenna a ${dec(p.mountedM)} m dal suolo`) : null,
          signalBar(e?.signalDbm ?? null),
        ),
      ),
      h('button', { type: 'button', class: 'dock-close', 'aria-label': 'Chiudi', onclick: closeDock }, '×'),
    );
    dock.hidden = false;
  }

  /** Line of sight from the checked point (with the CPE height above) to one AP. */
  /** The link in 3D: terrain, imagery, line of sight and Fresnel tube, the APs around. */
  const show3d = (p, a) => openLink3d({ from: [point.la, point.lo], label: point.label?.split(',')[0], p, apName: a.name || a.id, others: allAps });

  async function profile(a, btn) {
    if (!point) return;
    const hM = Number(String(height.value).replace(',', '.'));
    if (!(hM >= 0.5 && hM <= 100)) return toast('Altezza della CPE non valida (0,5–100 m)');
    // from a row (no button) or from Visibilità
    await busy(btn ?? document.createElement('button'), async () => {
      let p;
      try {
        p = await api(`/api/pointing/profile?lat=${point.la}&lon=${point.lo}&apId=${encodeURIComponent(a.id)}&height=${hM}`);
      } catch (e) {
        return mount(profileBox, card(h('h2', {}, `Visibilità verso ${a.name}`), h('div', { class: 'notice bad' }, e.message)));
      }
      selected = a.id;
      renderDock(p, a);
      drawLink(p);
      const verdict = { clear: ['Visibilità libera', 'good'], fresnel: ['Linea libera ma zona di Fresnel invasa', 'warn'], blocked: [p.buildings ? 'Linea ostruita da edifici' : 'Linea ostruita dal terreno', 'bad'] }[p.verdict];
      mount(
        profileBox,
        card(
          h('div', { class: 'link-head' }, h('h2', {}, `Collegamento con ${a.name}`), badge(verdict[0], verdict[1]), p.ap.lat != null ? h('button', { type: 'button', class: 'small-btn', onclick: () => show3d(p, a) }, 'Vista 3D') : null),
          linkFacts(p, [point.la, point.lo], a.estimate),
          h(
            'p',
            { class: 'small' },
            p.worst ? `Punto critico a ${km(p.worst.d)}: margine ${dec(p.worst.clearanceM)} m sulla linea di vista (per il 60% della zona di Fresnel ne servono ${dec(p.worst.fresnel60M)}).` : 'Linea di vista e zona di Fresnel libere su tutto il collegamento.',
            p.verdict === 'clear' || !(p.raiseCpeM > 0)
              ? ''
              : p.raiseCpeM <= MAX_MAST_M
                ? ` Alzando la CPE di ${dec(p.raiseCpeM)} m si libera.`
                : ` Non basta un palo di ${MAX_MAST_M} m: scegli un altro AP.`,
          ),
          p.apAntenna
            ? h('p', { class: 'small' }, `Antenna dell’AP a ${p.apAntenna.altitude} m s.l.m., ${p.apAntenna.aboveGroundM} m sopra il suolo: ${ALT_FROM[p.apAntenna.from] ?? 'altezza predefinita'}${p.apAntenna.reported !== null ? ` (in UISP: ${p.apAntenna.reported} m)` : ''}. Se l’antenna è più alta, correggi l’altitudine in UISP.`)
            : null,
          p.ap.lat != null ? h('p', { class: 'small muted' }, 'Sulla mappa: il collegamento e la sua prima zona di Fresnel (allargata per essere visibile, la forma è quella reale), verde dove è libera, arancione dove terreno o ostacoli entrano nel 60% della zona, rosso dove coprono la linea di vista.') : null,
          profileChart(p),
          legend([
            ['#a8a29e', 'terreno (con la curvatura terrestre)'],
            ['#78716c', 'edifici'],
            ['#4d7c0f', 'alberi'],
            ['#2563eb', 'linea di vista'],
            ['#38bdf8', 'prima zona di Fresnel'],
            ['#f59e0b', 'limite del 60%'],
          ]),
          h('p', { class: 'small muted' }, p.terrainSource === 'tinitaly' ? 'Terreno TINITALY (10 m), edifici e alberi da ESA WorldCover con le altezze di Impostazioni server → Simulazione radio. Cambia l’altezza della CPE sopra e premi di nuovo Visibilità.' : 'Modello del terreno SRTM (circa 30 m): qui non sono scaricati terreno a 10 m, edifici e alberi. Cambia l’altezza della CPE sopra e premi di nuovo Visibilità.'),
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
      h('div', { class: 'row' }, field('Cerca gli AP entro', howFar), field('Altezza della CPE dal suolo (m)', height), field('CPE da installare', cpe)),
      h('p', { class: 'small muted' }, 'Scrivi un indirizzo, delle coordinate o il nome di un AP, oppure clicca sulla mappa. L’altezza della CPE vale per la visibilità di questo punto.'),
    ),
    card(
      h('div', { class: 'link-head' }, h('h2', {}, 'Mappa della rete'), h('label', { class: 'check small' }, realToggle, ' Clienti reali: segnale vero contro stima'), h('label', { class: 'check small' }, koToggle, ' Installazioni fallite')),
      h('div', { class: 'map-stage' }, el, dock),
      legend([
        [STATE_COLOR.ok, 'AP in funzione'],
        [STATE_COLOR.degraded, 'molte CPE offline'],
        [STATE_COLOR.down, 'non raggiungibile'],
        [C.point, 'punto verificato'],
        ['#16a34a', 'cliente: stima entro 6 dB'],
        ['#dc2626', 'cliente: stima sbagliata di oltre 12 dB'],
      ]),
      h('div', { class: 'map-tools' }, mapNote, h('button', { type: 'button', class: 'small-btn', onclick: () => (picker?.arm(), toast('Clicca sulla mappa nel nuovo punto')) }, 'Nuovo punto sulla mappa')),
      simBox,
    ),
    out,
    profileBox,
    accuracyCard({
      // a blocked customer: its position (UISP), its CPE height, then the profile towards its AP
      inspect: async (b, btn) => {
        height.value = b.cpeHeightM;
        await check(b.lat, b.lon, b.device);
        await profile({ id: b.apId, name: b.ap }, btn);
        profileBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
      },
    }),
    terrainCard(),
    antennasCard(),
  );
}

/**
 * Affidabilità della stima: the model measured on the real customers (each one estimated without
 * itself), the history to compare before/after, the APs and the customers it gets most wrong.
 */
function accuracyCard({ inspect }) {
  const box = h('div', {}, h('p', { class: 'muted' }, 'Caricamento…'));
  let timer = null;
  const TERRAIN = { tinitaly: 'terreno 10 m', srtm: 'terreno 30 m', nessuno: 'senza terreno' };
  const VERDICT = { clear: 'libero', fresnel: 'Fresnel', blocked: 'ostruito', 'n/d': 'n/d' };
  const sign = (v) => `${v > 0 ? '+' : ''}${v}`;
  const show = (v) => {
    const last = v.last;
    const go = h('button', { type: 'button', disabled: v.running }, v.running ? 'Misura in corso…' : 'Misura ora');
    go.onclick = () => busy(go, async () => (await api('/api/admin/coverage/accuracy', { method: 'POST', body: {} }), await load()));
    mount(
      box,
      h(
        'div',
        {},
        last
          ? h(
              'div',
              {},
              h('p', {}, h('b', {}, `Su ${last.customers} clienti collegati: errore tipico ${last.medianAbsDb} dB, ${last.within6Pct}% entro ±6 dB`), ` · tendenza ${sign(last.biasDb)} dB · 1 su 10 sbaglia più di ${last.p90AbsDb} dB · ${TERRAIN[last.terrain]}, edifici ${last.settings.buildingM} m, alberi ${last.settings.treeM} m, EIRP ${last.settings.eirpDbm} dBm (calibrazione ${sign(last.settings.calibrationDb)} dB) · ${fmtDate(last.at)}`),
              h('p', { class: 'small muted' }, `Per terreno: ${Object.entries(last.byTerrain).map(([k, s]) => `${VERDICT[k] ?? k} ${s.n} (errore ${s.medianAbsDb} dB, tendenza ${sign(s.biasDb)})`).join(' · ')}. Collegati ma dati per ostruiti: ${last.blockedButConnected}; giudicati improbabili: ${last.unlikelyButConnected}.${last.realHeights ? ` Con l’altezza reale della CPE dal collaudo: ${last.realHeights}.` : ''}`),
              last.failures?.n
                ? h('p', { class: 'small' }, `Installazioni fallite per segnale, aggancio o ostacoli: ${last.failures.n}. Il modello le avrebbe giudicate: ${Object.entries(last.failures.rated).map(([k, v]) => `${k} ${v}`).join(', ')}${last.failures.rated.buono ? ' — quelle "buono" sono gli errori da guardare.' : '.'}`)
                : h('p', { class: 'small muted' }, 'Nessuna installazione fallita per motivi radio da confrontare: quando l’app ne registra (Segnala KO), qui si vede se il modello le avrebbe evitate.'),
            )
          : h('p', { class: 'muted' }, 'Nessuna misura ancora: avviala per vedere quanto è affidabile la stima sulla tua rete.'),
        v.error ? h('div', { class: 'notice bad' }, v.error) : null,
        h('div', { class: 'row' }, go),
        v.history?.length > 1
          ? h('details', {}, h('summary', {}, `Storico (${v.history.length} misure)`), table(
              [
                { label: 'Quando', render: (s) => fmtDate(s.at) },
                { label: 'Dati', render: (s) => `${TERRAIN[s.terrain]} · edifici ${s.settings.buildingM} m · alberi ${s.settings.treeM} m · EIRP ${s.settings.eirpDbm}` },
                { label: 'Clienti', render: (s) => s.customers },
                { label: 'Errore tipico', render: (s) => `${s.medianAbsDb} dB` },
                { label: 'Entro ±6 dB', render: (s) => `${s.within6Pct}%` },
                { label: 'Tendenza', render: (s) => `${sign(s.biasDb)} dB` },
                { label: 'Ostruiti ma collegati', render: (s) => s.blockedButConnected },
              ],
              [...v.history].reverse(),
            ))
          : null,
        last?.aps?.length
          ? h('details', {}, h('summary', {}, 'AP dove la stima sbaglia di più (in media)'), table(
              [
                { label: 'AP', render: (a) => a.name },
                { label: 'Clienti', render: (a) => a.customers },
                { label: 'Tendenza', render: (a) => `${sign(a.biasDb)} dB` },
                { label: 'Errore tipico', render: (a) => `${a.medianAbsDb} dB` },
              ],
              last.aps,
            ), h('p', { class: 'small muted' }, 'Tendenza positiva: la stima è più ottimista del reale (antenna più bassa, potenza minore o ostacoli non visti); negativa: più pessimista (azimut, altezza dell’antenna, potenza maggiore). Controlla in UISP azimut e altezza di questi AP.'))
          : null,
        last?.blocked?.length
          ? h(
              'details',
              {},
              h('summary', {}, `Collegati ma dati per ostruiti: ${last.blocked.length} da verificare`),
              h('p', { class: 'small muted' }, 'Questi clienti funzionano, ma per il modello qualcosa copre la linea verso l’AP. Verifica apre il punto sulla mappa e il profilo del terreno con l’altezza della CPE: di solito l’antenna dell’AP è più alta di quanto dice UISP, la CPE è su un palo o un terrazzo più alto, oppure l’ostacolo (un edificio o un bosco) nella realtà non c’è.'),
              table(
                [
                  { label: 'CPE', render: (b) => h('div', {}, b.deviceId ? h('a', { href: `#/cpe?id=${encodeURIComponent(b.deviceId)}` }, b.device) : b.device, h('div', { class: 'small muted mono' }, b.mac ?? '')) },
                  { label: 'AP', render: (b) => h('div', {}, b.ap, h('div', { class: 'small muted' }, b.apAltitudeFrom ? ALT_FROM[b.apAltitudeFrom] ?? '' : '')) },
                  { label: 'Reale / stimato', render: (b) => `${b.realDbm} / ${b.estimateDbm} dBm` },
                  { label: 'Cosa copre', render: (b) => `${b.cause}, ${b.where}` },
                  { label: 'CPE più alta di', render: (b) => (b.raiseCpeM === null ? 'oltre 60 m' : `${b.raiseCpeM} m`) },
                  { label: 'Distanza', render: (b) => `${(b.distanceM / 1000).toFixed(2)} km` },
                  { label: '', render: (b) => h('button', { type: 'button', class: 'small-btn', onclick: (e) => inspect(b, e.currentTarget) }, 'Verifica') },
                ],
                last.blocked,
              ),
            )
          : null,
        last?.worst?.length
          ? h('details', {}, h('summary', {}, 'Clienti stimati peggio'), table(
              [
                { label: 'CPE', render: (c) => h('div', {}, c.device, h('div', { class: 'small muted mono' }, c.mac ?? '')) },
                { label: 'AP', render: (c) => c.ap },
                { label: 'Reale', render: (c) => `${c.realDbm} dBm` },
                { label: 'Stimato', render: (c) => `${c.estimateDbm} dBm` },
                { label: 'Errore', render: (c) => `${sign(c.errorDb)} dB` },
                { label: 'Terreno', render: (c) => VERDICT[c.terrain ?? 'n/d'] },
                { label: 'Distanza', render: (c) => `${(c.distanceM / 1000).toFixed(2)} km` },
              ],
              last.worst,
            ))
          : null,
        h('p', { class: 'small muted' }, 'Ogni cliente collegato viene stimato senza usare il suo segnale e confrontato con quello reale. La misura si ripete da sola dopo ogni scaricamento di terreno e ostacoli.'),
      ),
    );
    clearTimeout(timer);
    if (v.running) timer = setTimeout(() => load().catch(() => {}), 4000);
  };
  const load = async () => show(await api('/api/admin/coverage/accuracy'));
  load().catch((e) => mount(box, h('div', { class: 'notice bad' }, e.message)));
  return card(h('h2', {}, 'Affidabilità della stima'), box);
}

/**
 * Terreno e ostacoli: TINITALY (10 m) and ESA WorldCover (buildings, trees) for the area of the
 * network, downloaded and converted by the server when the admin asks. Polls while it runs.
 */
function terrainCard() {
  const box = h('div', {}, h('p', { class: 'muted' }, 'Caricamento…'));
  let timer = null;
  const show = (s) => {
    const imp = s.import ?? {};
    const area = s.area ? `${s.area.minLat.toFixed(2)}–${s.area.maxLat.toFixed(2)}° N, ${s.area.minLon.toFixed(2)}–${s.area.maxLon.toFixed(2)}° E` : 'nessun AP con posizione';
    const go = h('button', { type: 'button', disabled: imp.running || !s.area }, s.dtmTiles ? 'Aggiorna per l’area della rete' : 'Scarica terreno e ostacoli');
    const bld = h('button', { type: 'button', disabled: imp.running || !s.area }, s.buildingTiles ? 'Aggiorna gli edifici' : 'Edifici dalla mappa base');
    const trees = h('button', { type: 'button', disabled: imp.running || !s.area }, s.canopyTiles ? 'Completa le altezze degli alberi' : 'Altezze degli alberi');
    trees.onclick = () =>
      busy(trees, async () => {
        if (!confirm(`Il server legge da AWS Open Data la mappa delle altezze degli alberi di Meta e World Resources Institute (CHM v2, CC BY 4.0) per l’area della rete (${area}): solo i pezzi che servono, circa 4 MB ogni riquadro di 0,1° (per la rete intera circa 500 MB letti, 30–60 MB salvati). Procedo?`)) return;
        await api('/api/admin/terrain/canopy', { method: 'POST', body: {} });
        await load();
      });
    bld.onclick = () =>
      busy(bld, async () => {
        await api('/api/admin/terrain/buildings', { method: 'POST', body: {} });
        await load();
      });
    go.onclick = () =>
      busy(go, async () => {
        if (!confirm(`Il server scarica il modello del terreno TINITALY 1.1 (INGV, 10 m) e la mappa del suolo ESA WorldCover 2021 per l’area della rete (${area}): per la Sicilia circa 800 MB da INGV e 60 MB da ESA, convertiti e poi cancellati (restano circa 300–400 MB). Procedo?`)) return;
        await api('/api/admin/terrain/import', { method: 'POST', body: {} });
        await load();
      });
    mount(
      box,
      h(
        'div',
        {},
        h('p', {}, s.dtmTiles
          ? `Terreno a 10 m: ${s.dtmTiles} riquadri di 0,1° (${s.tinitaly} file TINITALY) · edifici e vegetazione: ${s.coverTiles} riquadri (${s.worldcover} file WorldCover) · aggiornato ${fmtDate(s.updatedAt)}.`
          : 'Non ancora scaricati: la copertura usa il modello SRTM (circa 30 m) e non vede edifici e alberi.'),
        imp.running
          ? h('div', { class: 'notice' }, `In corso: ${imp.phase} (${imp.done}/${imp.total})…`)
          : imp.error
            ? h('div', { class: 'notice bad' }, `Ultimo scaricamento interrotto (${imp.phase}): ${imp.error}. Riprova: riparte da dove si era fermato.`)
            : null,
        h('p', {}, s.buildingTiles
          ? `Edifici veri dalla mappa base: ${s.buildings.toLocaleString('it-IT')} sagome su ${s.buildingTiles} riquadri (${fmtDate(s.buildingsAt)}). Al posto della classe «edificato» di ESA (che copre anche strade e piazze) il calcolo usa le sagome di OpenStreetMap con la loro altezza dove è mappata, altrimenti quella media (3 m per i manufatti piccoli); la CPE si considera sul tetto, 2 m sopra.`
          : s.basemap
            ? 'Edifici: non ancora presi dalla mappa base. Con «Edifici dalla mappa base» il calcolo usa le sagome vere degli edifici di OpenStreetMap invece della classe «edificato» di ESA.'
            : 'Edifici: serve la mappa base installata sul server (sudo cdanet-cpe map update).'),
        h('p', {}, s.canopyTiles
          ? `Alberi veri: altezza di ogni albero dalla mappa Meta/WRI su ${s.canopyTiles} riquadri (${fmtDate(s.canopyAt)}), al posto della classe «alberi» di ESA con l’altezza media.`
          : 'Alberi: oggi la classe «alberi» di ESA con l’altezza media. Con «Altezze degli alberi» il calcolo usa l’altezza di ogni albero della mappa Meta/WRI (circa 1 m, letta a 4 m).'),
        h('div', { class: 'row' }, go, s.basemap ? bld : null, trees),
        h('p', { class: 'small muted' }, `Area della rete: ${area}, cioè gli AP più 20 km intorno. Le altezze medie di edifici e vegetazione si impostano in Impostazioni server → Simulazione radio. Fonti: TINITALY 1.1, Tarquini et al. (2023), INGV, doi:10.13127/tinitaly/1.1 (CC BY 4.0); ESA WorldCover 10 m 2021 v200, doi:10.5281/zenodo.7254221 (CC BY 4.0); edifici © OpenStreetMap contributors (ODbL) tramite Protomaps; alberi: Meta e World Resources Institute, Canopy Height Maps v2 (CC BY 4.0).`),
      ),
    );
    clearTimeout(timer);
    if (imp.running) timer = setTimeout(() => load().catch(() => {}), 3000);
  };
  const load = async () => show(await api('/api/admin/terrain'));
  load().catch((e) => mount(box, h('div', { class: 'notice bad' }, e.message)));
  return card(h('h2', {}, 'Terreno e ostacoli'), box);
}

/** Polar drawing of a horizontal cut (attenuation in dB: the edge is the peak, the centre 30 dB down). */
function polar(az, size = 64) {
  const c = size / 2;
  const r = (db) => Math.max(0, (1 - Math.min(30, db) / 30) * (c - 2));
  const pts = az.map((db, i) => {
    const a = ((i - 90) * Math.PI) / 180;
    return `${(c + r(db) * Math.cos(a)).toFixed(1)},${(c + r(db) * Math.sin(a)).toFixed(1)}`;
  });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('class', 'ant-polar');
  svg.innerHTML = `<circle cx="${c}" cy="${c}" r="${c - 2}" class="ring"/><circle cx="${c}" cy="${c}" r="${(c - 2) / 2}" class="ring"/><polygon points="${pts.join(' ')}" class="lobe"/>`;
  return svg;
}

/**
 * Antenne degli AP: the makers' radiation patterns (Ubiquiti, RF elements) and, for every AP, the
 * antenna, azimuth and tilt the coverage model uses. UISP rarely knows the azimuth and never which
 * horn is on a Rocket: the admin says it here (the customers suggest the azimuth).
 */
function antennasCard() {
  const box = h('div', {}, h('p', { class: 'muted' }, 'Caricamento…'));
  const onlyTodo = h('input', { type: 'checkbox', checked: true });
  let timer = null;
  let data = null;
  const patterns = new Map();
  const patternOf = (id) => {
    if (!patterns.has(id)) patterns.set(id, api(`/api/admin/antennas/pattern/${encodeURIComponent(id)}`));
    return patterns.get(id);
  };
  const show = () => {
    const s = data;
    const imp = s.import ?? {};
    const lib = s.library ?? [];
    const dl = h('button', { type: 'button', disabled: imp.running }, lib.length ? 'Aggiorna i diagrammi' : 'Scarica i diagrammi delle antenne');
    dl.onclick = () =>
      busy(dl, async () => {
        if (!confirm('Il server scarica i diagrammi di radiazione pubblicati dai costruttori: Ubiquiti airMAX (27 file da dl.ui.com, circa 0,7 MB) e RF elements (horn, settori e parabole: 1 file da rfelements.com, 135 KB). Restano sul server, non nel codice. Procedo?')) return;
        await api('/api/admin/antennas/import', { method: 'POST', body: {} });
        await load();
      });
    const todo = (a) => a.customers >= 3 && ((a.azimuth == null && a.uispAzimuth == null) || (a.external && !a.antennaId));
    const rows = (onlyTodo.checked ? s.aps.filter(todo) : s.aps).slice(0, 300);
    const groups = ['Ubiquiti', 'RF elements'].map((v) => h('optgroup', { label: v }, lib.filter((p) => p.vendor === v).map((p) => h('option', { value: p.id }, `${p.name} · ${p.gainDbi ?? '?'} dBi · ${p.hBeam}°×${p.vBeam}°`))));
    const row = (a) => {
      const ant = h('select', {}, h('option', { value: '' }, a.external ? '— da indicare —' : a.antennaFrom === 'modello' ? 'integrata (dal modello)' : '—'), ...groups.map((g) => g.cloneNode(true)));
      ant.value = a.antennaFrom === 'admin' ? a.antennaId : '';
      const az = h('input', { type: 'number', class: 'ant-num', min: 0, max: 359, step: 1, value: a.azimuth ?? '', placeholder: a.uispAzimuth != null ? `UISP ${a.uispAzimuth}°` : a.suggested ? `clienti ~${a.suggested.azimuth}°` : '°' });
      const tilt = h('input', { type: 'number', class: 'ant-num', min: -30, max: 30, step: 0.5, value: a.tilt ?? '', placeholder: '°' });
      const pv = h('span', { class: 'ant-pv' });
      const preview = async () => {
        const id = ant.value || (a.antennaFrom === 'modello' ? a.antennaId : null);
        mount(pv, id ? polar((await patternOf(id)).az) : '');
      };
      ant.onchange = () => preview().catch(() => {});
      preview().catch(() => {});
      const save = h('button', { type: 'button', class: 'small-btn' }, 'Salva');
      save.onclick = () =>
        busy(save, async () => {
          const num = (el) => (String(el.value).trim() === '' ? null : Number(el.value));
          await api(`/api/admin/antennas/ap/${encodeURIComponent(a.id)}`, { method: 'PUT', body: { antennaId: ant.value || null, azimuth: num(az), tilt: num(tilt) } });
          toast(`${a.name}: salvato`);
          Object.assign(a, { antennaId: ant.value || a.antennaId, antennaFrom: ant.value ? 'admin' : a.antennaFrom, azimuth: num(az), tilt: num(tilt) });
        });
      const use = a.suggested && a.azimuth == null ? h('button', { type: 'button', class: 'small-btn', onclick: () => (az.value = a.suggested.azimuth) }, `usa ${a.suggested.azimuth}°`) : null;
      return { a, ant, az, tilt, pv, save, use };
    };
    mount(
      box,
      h(
        'div',
        {},
        h('p', {}, lib.length
          ? `${lib.length} diagrammi: ${lib.filter((p) => p.vendor === 'Ubiquiti').length} Ubiquiti, ${lib.filter((p) => p.vendor === 'RF elements').length} RF elements (horn, settori, parabole).`
          : 'Diagrammi non ancora scaricati: la copertura usa un settore generico centrato sui clienti.'),
        imp.running ? h('div', { class: 'notice' }, `Scaricamento… (${imp.done}/${imp.total})`) : imp.error ? h('div', { class: 'notice bad' }, imp.error) : null,
        h('div', { class: 'row' }, dl, h('label', { class: 'check small' }, onlyTodo, ' Solo gli AP da completare')),
        rows.length
          ? table(
              [
                { label: 'AP', render: (r) => h('div', {}, r.a.name, h('div', { class: 'small muted' }, `${r.a.model ?? ''} · ${r.a.customers} clienti`)) },
                { label: 'Antenna', render: (r) => h('div', { class: 'ant-cell' }, r.pv, r.ant) },
                { label: 'Azimut', render: (r) => h('div', {}, r.az, r.use) },
                { label: 'Tilt (giù +)', render: (r) => r.tilt },
                { label: '', render: (r) => r.save },
              ],
              rows.map(row),
            )
          : h('p', { class: 'muted' }, onlyTodo.checked ? 'Tutti gli AP con clienti hanno azimut e antenna.' : 'Nessun AP.'),
        h('p', { class: 'small muted' }, 'Con antenna e azimut la copertura usa il diagramma vero (orizzontale; anche verticale se indichi il tilt meccanico: quello elettrico è già nel diagramma). L’azimut suggerito è il centro dell’arco dei clienti collegati: confermalo solo se torna con l’antenna reale. IA-AP segnala gli AP senza azimut e i Rocket senza antenna indicata.'),
      ),
    );
    clearTimeout(timer);
    if (imp.running) timer = setTimeout(() => load().catch(() => {}), 2000);
  };
  onlyTodo.onchange = () => data && show();
  const load = async () => {
    data = await api('/api/admin/antennas');
    show();
  };
  load().catch((e) => mount(box, h('div', { class: 'notice bad' }, e.message)));
  return card(h('h2', {}, 'Antenne degli AP'), box);
}

