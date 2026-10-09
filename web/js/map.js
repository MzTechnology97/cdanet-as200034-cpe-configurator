import { api } from './api.js';
import { h } from './dom.js';

/**
 * Console maps: Leaflet + Protomaps basemap served by our server (OpenStreetMap data, no external
 * service). Until the basemap is installed the public OpenStreetMap tiles are used instead.
 */

const COLORS = { guasto_mt: '#dc2626', guasto_bt: '#f59e0b', lavoro: '#94a3b8', altro: '#f59e0b', pop: '#0ea5e9', ap: '#14b8a6', impacted: '#dc2626', zone: '#6366f1', personal: '#3b82f6', point: '#f97316' };
export const MAP_COLORS = COLORS;

let vendor = null;

/**
 * Reads of the local basemap (single tiles from the server). The vector-tile reader swallows its
 * own errors and still draws (empty) tiles, so only the reads tell whether the map really works.
 */
const reads = { ok: 0, fail: 0, error: '', other: new Set() };
if (!window.__cdaFetch) {
  window.__cdaFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = String(input?.url ?? input);
    const isMap = url.includes('/map/tiles/') || url.includes('/map/basemap');
    try {
      const r = await window.__cdaFetch(input, init);
      if (isMap) r.ok ? reads.ok++ : (reads.fail++, (reads.error = `HTTP ${r.status}`));
      return r;
    } catch (e) {
      if (isMap) (reads.fail++, (reads.error = e.message));
      // other failed requests (diagnostics): address without query
      else if (reads.other.size < 5) reads.other.add(url.split('?')[0].slice(0, 120));
      throw e;
    }
  };
}

const script = (src) =>
  new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error('Mappa non disponibile'));
    document.head.append(s);
  });

function loadVendor() {
  vendor ??= (async () => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/vendor/leaflet/leaflet.css';
    document.head.append(css);
    await script('/vendor/leaflet/leaflet.js');
    await script('/vendor/protomaps-leaflet/protomaps-leaflet.js');
  })();
  return vendor;
}

/** Waits until [el] is in the page (views are built before being mounted). */
const attached = (el) =>
  new Promise((res) => {
    const tick = (n) => (el.isConnected || n > 200 ? res() : requestAnimationFrame(() => tick(n + 1)));
    tick(0);
  });

/**
 * Leaflet map in [el] with the basemap; resolves to the map (null if the page went away).
 * If the local basemap draws nothing within a few seconds (old browser engine, broken file) the
 * public OpenStreetMap tiles are added instead; [onStatus] receives what happened (diagnostics).
 */
export async function createMap(el, { center = [37.57, 14.27], zoom = 9, onStatus = null } = {}) {
  await Promise.all([loadVendor(), attached(el)]);
  if (!el.isConnected) return null;
  // read every time: the basemap may have been installed meanwhile
  const config = await api('/api/map/config');
  const L = window.L;
  const map = L.map(el, { center, zoom, scrollWheelZoom: false });
  // OpenStreetMap's tile policy requires a Referer (the console sends none by default)
  const publicTiles = () => L.tileLayer(config.fallback.url, { maxZoom: 19, attribution: config.fallback.attribution, referrerPolicy: 'strict-origin-when-cross-origin' }).addTo(map);
  if (config.basemap && window.protomapsL) {
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    const pm = window.protomapsL.leafletLayer({ url: config.basemap.tiles ?? config.basemap.url, flavor: dark ? 'dark' : 'light', lang: 'it', maxDataZoom: config.basemap.maxZoom }).addTo(map);
    const start = reads.ok;
    setTimeout(() => {
      if (!el.isConnected) return;
      const size = map.getSize();
      // no tile read: unreadable here, or outside the downloaded area
      const working = reads.ok - start > (config.basemap.tiles ? 0 : 3);
      const other = reads.other.size ? `, altre richieste fallite: ${[...reads.other].join(' ')}` : '';
      onStatus?.(working ? 'basemap_ok' : 'basemap_fallback', `letture ${reads.ok - start} ok, ${reads.fail} fallite${reads.error ? ` (${reads.error})` : ''}, mappa ${size.x}×${size.y}, zoom ${map.getZoom()}${other}`);
      if (!working) {
        map.removeLayer(pm);
        publicTiles();
      }
    }, 8000);
  } else {
    publicTiles();
  }
  // the container may get its real size after the map was created (embedded views, tabs)
  if (window.ResizeObserver) new ResizeObserver(() => map.invalidateSize()).observe(el);
  map.on('focus', () => map.scrollWheelZoom.enable());
  map.on('blur', () => map.scrollWheelZoom.disable());
  return map;
}

/** Popup content as DOM (never HTML strings: names come from external systems). */
export const popup = (title, ...lines) => h('div', { class: 'map-popup' }, h('b', {}, title), ...lines.filter(Boolean).map((l) => h('div', { class: 'small' }, l)));

const localTime = (s) => (s ? s.replace('T', ' ').replace(/^(\d{4})-(\d{2})-(\d{2})/, '$3/$2/$1') : '');

/**
 * Draws the Guasti Enel map data (/api/outages/map) on [target] (map or layer group): zones,
 * POPs/APs (real point or approximate area) and outages; returns the layers to fit.
 */
export function drawOutages(target, d) {
  const L = window.L;
  const layers = [];
  for (const z of d.zones ?? []) {
    layers.push(L.circle([z.lat, z.lon], { radius: z.radiusKm * 1000, color: z.personal ? COLORS.personal : COLORS.zone, weight: 1, dashArray: '4 4', fillOpacity: 0.04 }).bindPopup(popup(`Zona ${z.name}`, `raggio ${z.radiusKm} km`)).addTo(target));
  }
  for (const i of d.infra ?? []) {
    const color = i.impacted ? COLORS.impacted : COLORS[i.type];
    const title = `${i.type === 'pop' ? 'POP' : 'AP'} ${i.name}`;
    const info = [i.stations != null ? `${i.stations} CPE` : null, i.impacted ? 'potenzialmente impattato da un guasto' : null];
    layers.push(
      i.approx
        ? L.circle([i.approx.lat, i.approx.lon], { radius: i.approx.radiusM, color, weight: 1, fillOpacity: 0.12 }).bindPopup(popup(title, ...info, 'posizione approssimativa')).addTo(target)
        : L.circleMarker([i.lat, i.lon], { radius: i.type === 'pop' ? 8 : 5, color, weight: 2, fillOpacity: 0.85 }).bindPopup(popup(title, ...info)).addTo(target),
    );
  }
  for (const o of d.outages ?? []) {
    layers.push(
      L.circleMarker([o.lat, o.lon], { radius: 7, color: o.impacted ? COLORS.impacted : COLORS[o.kind], fillColor: COLORS[o.kind], weight: o.impacted ? 3 : 1.5, fillOpacity: 0.9 })
        .bindPopup(popup(o.label, `${o.place} (${o.province})`, `${o.customers} clienti Enel`, o.expectedRestore ? `ripristino previsto ${localTime(o.expectedRestore)}` : null, o.impacted ? 'POP/AP potenzialmente impattati' : null))
        .addTo(target),
    );
  }
  return layers;
}

/** Fits the map to the given [lat, lon] points (and circles), with a sensible max zoom. */
export function fit(map, layers) {
  const L = window.L;
  const g = L.featureGroup(layers.filter(Boolean));
  if (g.getLayers().length) map.fitBounds(g.getBounds().pad(0.15), { maxZoom: 14 });
}

/** Point at [distanceM] from [lat, lon] towards [bearing] degrees (for short direction lines). */
export function towards(lat, lon, bearing, distanceM) {
  const R = 6371e3;
  const d = distanceM / R;
  const b = (bearing * Math.PI) / 180;
  const p1 = (lat * Math.PI) / 180;
  const l1 = (lon * Math.PI) / 180;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [(p2 * 180) / Math.PI, (l2 * 180) / Math.PI];
}

/** Legend under a map (dot colours via CSSOM: inline styles are blocked by the CSP). */
export function legend(items) {
  return h(
    'div',
    { class: 'map-legend small' },
    items.map(([color, text]) => {
      const dot = h('i', { class: 'dot' });
      dot.style.background = color;
      return h('span', {}, dot, text);
    }),
  );
}

const km = (m) => (m < 1000 ? `${m} m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`);

/**
 * Coverage check (console and app): the point and the nearest APs. Admins get the real position
 * and the area already served by the customers; installers an approximate area and the direction.
 * [onAp] receives each AP's layer and the bounds to show it (the app focuses an AP from its list).
 */
export function drawCoverage(target, la, lo, aps, onAp = null) {
  const L = window.L;
  const layers = [L.circleMarker([la, lo], { radius: 7, color: COLORS.point, weight: 2, fillOpacity: 0.9 }).bindPopup(popup('Punto verificato', `${la.toFixed(5)}, ${lo.toFixed(5)}`)).addTo(target)];
  for (const a of aps) {
    const info = [a.ssid, `${km(a.distanceM)} · ${a.bearing}° ${a.direction}`, a.stations != null ? `${a.stations} client` : null];
    const color = a.status === 'active' ? COLORS.ap : COLORS.impacted;
    let marker;
    if (a.approx) {
      marker = L.circle([a.approx.lat, a.approx.lon], { radius: a.approx.radiusM, color, weight: 1, fillOpacity: 0.1 }).bindPopup(popup(a.name, ...info, 'posizione approssimativa')).addTo(target);
      L.polyline([[la, lo], towards(la, lo, a.bearing, Math.min(a.distanceM, 600))], { color, weight: 3 }).addTo(target);
    } else {
      marker = L.circleMarker([a.lat, a.lon], { radius: 6, color, weight: 2, fillOpacity: 0.85 }).bindPopup(popup(a.name, ...info)).addTo(target);
      L.polyline([[la, lo], [a.lat, a.lon]], { color, weight: 2, dashArray: '6 6' }).addTo(target);
      // area already served (from the customers' positions): admins only
      if (a.served?.servedM) {
        const pts = [[a.lat, a.lon]];
        for (let i = 0; i <= 12; i++) pts.push(towards(a.lat, a.lon, a.served.center - a.served.width / 2 + (a.served.width * i) / 12, a.served.servedM));
        L.polygon(pts, { color: COLORS.ap, weight: 1, fillOpacity: 0.08, dashArray: '3 5' }).bindPopup(popup(`${a.name}: area servita`, `settore ${a.served.width}° verso ${a.served.center}°`, `clienti fino a ${km(a.served.servedM)}`)).addTo(target);
      }
    }
    layers.push(marker);
    onAp?.(a, marker, L.featureGroup([layers[0], marker]).getBounds());
  }
  return layers;
}

