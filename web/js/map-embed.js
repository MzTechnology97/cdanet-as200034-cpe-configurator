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

