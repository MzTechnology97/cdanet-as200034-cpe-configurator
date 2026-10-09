import { api } from './api.js';
import { h } from './dom.js';

/**
 * Console maps: Leaflet + Protomaps basemap served by our server (OpenStreetMap data, no external
 * service). Until the basemap is installed the public OpenStreetMap tiles are used instead.
 */

const COLORS = { guasto_mt: '#dc2626', guasto_bt: '#f59e0b', lavoro: '#94a3b8', altro: '#f59e0b', pop: '#0ea5e9', ap: '#14b8a6', impacted: '#dc2626', zone: '#6366f1', personal: '#3b82f6', point: '#f97316' };
export const MAP_COLORS = COLORS;

let vendor = null;

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

/** Leaflet map in [el] with the basemap; resolves to the map (null if the page went away). */
export async function createMap(el, { center = [37.57, 14.27], zoom = 9 } = {}) {
  await Promise.all([loadVendor(), attached(el)]);
  if (!el.isConnected) return null;
  // read every time: the basemap may have been installed meanwhile
  const config = await api('/api/map/config');
  const L = window.L;
  const map = L.map(el, { center, zoom, scrollWheelZoom: false });
  if (config.basemap && window.protomapsL) {
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    window.protomapsL.leafletLayer({ url: config.basemap.url, flavor: dark ? 'dark' : 'light', lang: 'it', maxDataZoom: config.basemap.maxZoom }).addTo(map);
  } else {
    // OpenStreetMap's tile policy requires a Referer (the console sends none by default)
    L.tileLayer(config.fallback.url, { maxZoom: 19, attribution: config.fallback.attribution, referrerPolicy: 'strict-origin-when-cross-origin' }).addTo(map);
  }
  map.on('focus', () => map.scrollWheelZoom.enable());
  map.on('blur', () => map.scrollWheelZoom.disable());
  return map;
}

/** Popup content as DOM (never HTML strings: names come from external systems). */
export const popup = (title, ...lines) => h('div', { class: 'map-popup' }, h('b', {}, title), ...lines.filter(Boolean).map((l) => h('div', { class: 'small' }, l)));

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
