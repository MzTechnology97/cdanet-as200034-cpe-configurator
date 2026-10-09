import { createMap, fit, MAP_COLORS as C, popup, towards } from './map.js';

/**
 * Map page embedded in the Android app ("Trova l'AP"). It has no session: the app passes the data
 * it already received with window.cdaShow(...) and the phone heading with window.cdaHeading(deg).
 * Installers' data carry only approximate AP areas (no real positions).
 */
const el = document.getElementById('map');
let layer = null;
let arrow = null;
const ready = createMap(el, { zoom: 12 }).then((map) => {
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

/** Phone heading (degrees, true north): rotates the position arrow. */
window.cdaHeading = (deg) => {
  if (arrow) arrow.style.transform = `rotate(${Number(deg) || 0}deg)`;
};
