import { createMap, drawCoverage, drawOutages, fit, MAP_COLORS as C, popup, towards } from './map.js';

/**
 * Map page embedded in the Android app ("Trova l'AP"). It has no session: the app passes the data
 * it already received with window.cdaShow(...) and the phone heading with window.cdaHeading(deg).
 * Installers' data carry only approximate AP areas (no real positions).
 */
const el = document.getElementById('map');
let layer = null;
let arrow = null;

/**
 * Problems of the embedded map reach the server log (the page runs inside the Android app,
 * where no console is visible) and, for errors, the page itself.
 */
function report(kind, message) {
  try {
    fetch('/api/map/client-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, message: String(message).slice(0, 500), ua: navigator.userAgent.slice(0, 300), size: `${innerWidth}x${innerHeight}` }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* diagnostics only */
  }
}
function showError(text) {
  let box = document.getElementById('map-error');
  if (!box) {
    box = document.createElement('div');
    box.id = 'map-error';
    box.className = 'map-error';
    document.body.append(box);
  }
  box.textContent = `Mappa: ${text}`;
}
window.addEventListener('error', (e) => {
  report('error', `${e.message} @${e.filename}:${e.lineno}:${e.colno}`);
  showError(e.message);
});
// the PMTiles reader logs its failures instead of throwing them
const consoleError = console.error.bind(console);
let logged = 0;
console.error = (...args) => {
  if (logged++ < 5) report('console', args.map((a) => a?.stack || a?.message || String(a)).join(' '));
  consoleError(...args);
};
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  report('rejection', r?.stack || r?.message || r);
  showError(r?.message || String(r));
});

const ready = createMap(el, { zoom: 12, onStatus: (kind, msg) => report(kind, msg) }).then((map) => {
  if (map) {
    map.scrollWheelZoom.enable();
    layer = window.L.layerGroup().addTo(map);
  }
  return map;
});

const km = (m) => (m < 1000 ? `${m} m` : `${(m / 1000).toFixed(2)} km`);

window.cdaShow = async (d) => {
  const map = await ready;
  if (!map || !d?.from) return;
  const L = window.L;
  layer.clearLayers();
  const me = L.marker([d.from.lat, d.from.lon], { icon: L.divIcon({ className: 'me-icon', html: '<div class="me-arrow"></div>', iconSize: [24, 24], iconAnchor: [12, 12] }) }).addTo(layer);
  arrow = me.getElement()?.querySelector('.me-arrow') ?? null;
  const layers = [me];
  for (const a of d.aps ?? []) {
    const color = a.status === 'active' ? C.ap : C.impacted;
    const info = [a.ssid, `${km(a.distanceM)} · azimut ${a.bearing}°${a.tiltDeg != null ? ` · tilt ${a.tiltDeg}°` : ''}`, a.altitude != null ? `${Math.round(a.altitude)} m s.l.m.` : null];
    if (a.approx) {
      layers.push(L.circle([a.approx.lat, a.approx.lon], { radius: a.approx.radiusM, color, weight: 1, fillOpacity: 0.1 }).bindPopup(popup(a.name, ...info, 'posizione approssimativa')).addTo(layer));
      L.polyline([[d.from.lat, d.from.lon], towards(d.from.lat, d.from.lon, a.bearing, Math.min(a.distanceM, 600))], { color, weight: 3 }).addTo(layer);
    } else {
      layers.push(L.circleMarker([a.lat, a.lon], { radius: 7, color, weight: 2, fillOpacity: 0.85 }).bindPopup(popup(a.name, ...info)).addTo(layer));
      L.polyline([[d.from.lat, d.from.lon], [a.lat, a.lon]], { color, weight: 2, dashArray: '6 6' }).addTo(layer);
    }
  }
  fit(map, layers);
};

/** Guasti Enel map (data of /api/outages/map, already scoped by the server for the user). */
const outageMarkers = new Map();
window.cdaOutages = async (d) => {
  const map = await ready;
  if (!map || !d) return;
  layer.clearLayers();
  arrow = null;
  outageMarkers.clear();
  fit(map, drawOutages(layer, d, (o, marker) => outageMarkers.set(String(o.id), marker)));
};

/** One outage of the app's list: its area in view (zones and POP/AP around it), details open. */
window.cdaFocusOutage = async (id) => {
  const map = await ready;
  const m = outageMarkers.get(String(id));
  if (!map || !m) return;
  map.setView(m.getLatLng(), Math.max(map.getZoom(), 13));
  m.openPopup();
};

/** Phone heading (degrees, true north): rotates the position arrow. */
window.cdaHeading = (deg) => {
  if (arrow) arrow.style.transform = `rotate(${Number(deg) || 0}deg)`;
};

/** Copertura (app): the checked point and the nearest APs, data of /api/coverage as is. */
const coverageAps = new Map();
window.cdaCoverage = async (d) => {
  const map = await ready;
  if (!map || !d) return;
  layer.clearLayers();
  arrow = null;
  coverageAps.clear();
  fit(map, drawCoverage(layer, d.lat, d.lon, d.aps ?? [], (a, marker, bounds) => coverageAps.set(a.id, { marker, bounds })));
};

/** Shows one AP of the coverage list: point and AP in view, AP details open. */
window.cdaFocus = async (id) => {
  const map = await ready;
  const f = coverageAps.get(id);
  if (!map || !f) return;
  map.fitBounds(f.bounds.pad(0.25), { maxZoom: 16 });
  f.marker.openPopup();
};


// ---- Verifica copertura (app) ----------------------------------------------------------------
// The app listens through window.CdaApp (an Android bridge, only on this page of our server):
// a tap on the map checks that point, "Simula copertura" on an AP runs its radio simulation.

/** Same scale as the console simulation, from excellent to unusable. */
const SIM_SCALE = [
  [-60, '#15803d'],
  [-65, '#22c55e'],
  [-70, '#a3e635'],
  [-75, '#facc15'],
  [-80, '#f97316'],
  [-999, '#dc2626'],
];
const simColor = (dbm) => SIM_SCALE.find(([min]) => dbm >= min)[1];
const STATE_COLOR = { ok: '#14b8a6', degraded: '#f59e0b', down: '#dc2626' };
let baseLayer = null;
let simLayer = null;
let tapToCheck = false;

/** Turns on "tap a point to check it" (the app passes the point back to itself). */
window.cdaCoverageMode = async () => {
  const map = await ready;
  if (!map || tapToCheck) return;
  tapToCheck = true;
  map.on('click', (e) => window.CdaApp?.onMapClick?.(e.latlng.lat, e.latlng.lng));
};

/** Admins: every AP with a position (data of /api/network/status), each one with "Simula copertura". */
window.cdaCoverageBase = async (d) => {
  const map = await ready;
  if (!map || !d) return;
  const L = window.L;
  baseLayer ??= L.layerGroup().addTo(map);
  baseLayer.clearLayers();
  const aps = [...(d.pops ?? []).flatMap((p) => (p.aps ?? []).map((a) => ({ ...a, pop: p.name }))), ...(d.apsWithoutPop ?? []).map((a) => ({ ...a, pop: null }))].filter((a) => a.lat != null && a.lon != null);
  for (const a of aps) {
    const sim = document.createElement('button');
    sim.type = 'button';
    sim.className = 'small-btn';
    sim.textContent = 'Simula copertura';
    sim.onclick = () => {
      map.closePopup();
      window.CdaApp?.onSimulate?.(a.id);
    };
    const box = popup(a.name, a.ssid && a.ssid !== a.name ? a.ssid : null, a.pop ? `POP ${a.pop}` : 'AP senza POP', a.model);
    box.append(sim);
    L.circleMarker([a.lat, a.lon], { radius: 5, color: STATE_COLOR[a.state] ?? '#64748b', weight: 2, fillOpacity: 0.85, bubblingMouseEvents: false }).bindPopup(box).addTo(baseLayer);
  }
};

/** Radio simulation of one AP (data of /api/admin/coverage/simulation): estimated signal cells and the sector. */
/** Capacity scale (downlink of the radio link, Mbit/s), as in the console. */
const CAP_SCALE = [
  [150, '#15803d'],
  [100, '#22c55e'],
  [50, '#a3e635'],
  [25, '#facc15'],
  [10, '#f97316'],
  [-1, '#dc2626'],
];
const capColor = (v) => CAP_SCALE.find(([min]) => v >= min)[1];

/** [mode]: "dbm" (signal, default) or "cap" (capacity of the link). Keeps the view when only the mode changes. */
window.cdaSimulation = async (d, mode = 'dbm') => {
  const map = await ready;
  if (!map || !d?.ap) return;
  const L = window.L;
  simLayer ??= L.layerGroup().addTo(map);
  simLayer.clearLayers();
  const half = d.cellM / 2;
  const mPerLat = 111320;
  const mPerLon = 111320 * Math.cos((d.ap.lat * Math.PI) / 180);
  for (const c of d.cells ?? []) {
    if (c.dbm < (d.minDbm ?? -75) - 15) continue; // clearly no coverage: left blank, not a red disc
    const color = mode === 'cap' ? (c.cap == null ? null : capColor(c.cap)) : simColor(c.dbm);
    if (!color) continue;
    L.rectangle(
      [
        [c.lat - half / mPerLat, c.lon - half / mPerLon],
        [c.lat + half / mPerLat, c.lon + half / mPerLon],
      ],
      { stroke: false, fillColor: color, fillOpacity: d.theoretical ? 0.3 : c.confidence === 'bassa' ? 0.18 : 0.38, interactive: false },
    ).addTo(simLayer);
  }
  if (d.sector && (d.servedM || d.theoretical)) {
    const reach = d.servedM || d.radiusM;
    const pts = [[d.ap.lat, d.ap.lon]];
    for (let i = 0; i <= 24; i++) pts.push(towards(d.ap.lat, d.ap.lon, d.sector.center - d.sector.width / 2 + (d.sector.width * i) / 24, reach));
    L.polygon(pts, { color: '#0f172a', weight: 1.5, fill: false, dashArray: '4 5', interactive: false }).addTo(simLayer);
  }
  L.circleMarker([d.ap.lat, d.ap.lon], { radius: 8, color: '#0f172a', weight: 3, fillColor: '#ffffff', fillOpacity: 1, interactive: false }).addTo(simLayer);
  if (lastSim !== d.ap.id) map.fitBounds(L.latLng(d.ap.lat, d.ap.lon).toBounds(d.radiusM * 2.1));
  lastSim = d.ap.id;
};
let lastSim = null;

window.cdaClearSimulation = async () => {
  lastSim = null;
  simLayer?.clearLayers();
};
