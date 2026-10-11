import { api, session } from './api.js';
import { h } from './dom.js';

/**
 * 3D view of a link (admins), as in UISP Design: the coverage terrain (TINITALY where imported,
 * else SRTM) from our server, the aerial imagery of Connettori on it, the line of sight and 60%
 * of the first Fresnel zone as a tube (red where the ground, a building or the trees enter it),
 * the masts of the CPE and of the AP and the other APs around. MapLibre GL, loaded on demand.
 */

let vendor = null;
/** Transparent tile for an imagery request with no picture (204). */
const EMPTY = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='), (c) => c.charCodeAt(0));

function loadMapLibre() {
  vendor ??= new Promise((res, rej) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/vendor/maplibre-gl/maplibre-gl.css';
    document.head.append(css);
    const s = document.createElement('script');
    s.src = '/vendor/maplibre-gl/maplibre-gl.js';
    s.onload = () => {
      // tiles of our server need the session: cda://api/... is fetched with it
      window.maplibregl.addProtocol('cda', async (params, ctrl) => {
        const token = session.get()?.token;
        const r = await fetch(params.url.replace('cda://', '/'), { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: ctrl.signal });
        if (r.status === 204 && params.url.includes('/imagery/')) return { data: EMPTY.slice().buffer };
        if (!r.ok || r.status === 204) throw new Error(`HTTP ${r.status}`);
        return { data: await r.arrayBuffer() };
      });
      res(window.maplibregl);
    };
    s.onerror = () => ((vendor = null), rej(new Error('Vista 3D non disponibile')));
    document.head.append(s);
  });
  return vendor;
}

const R = Math.PI / 180;
/** Initial bearing from a to b ([lat, lon]), degrees. */
const bearingOf = (a, b) => {
  const y = Math.sin((b[1] - a[1]) * R) * Math.cos(b[0] * R);
  const x = Math.cos(a[0] * R) * Math.sin(b[0] * R) - Math.sin(a[0] * R) * Math.cos(b[0] * R) * Math.cos((b[1] - a[1]) * R);
  return (Math.atan2(y, x) / R + 360) % 360;
};

/**
 * The link as boxes for fill-extrusion layers, heights above the ground drawn by the terrain.
 * The chart carries the ground with the earth bulge: on the flat 3D terrain the line drops by
 * the same bulge, so "above the ground" is simply line − chart ground.
 */
export function linkGeometry(from, to, chart) {
  const D = chart[chart.length - 1].d || 1;
  const mLat = 111320;
  const mLon = 111320 * Math.cos(((from[0] + to[0]) / 2) * R);
  const east = (to[1] - from[1]) * mLon;
  const north = (to[0] - from[0]) * mLat;
  const len = Math.hypot(east, north) || 1;
  // unit vector across the link, in degrees per metre
  const across = [east / len / mLat, -north / len / mLon];
  const at = (d) => [from[0] + ((to[0] - from[0]) * d) / D, from[1] + ((to[1] - from[1]) * d) / D];
  const quad = (d0, d1, w, props) => {
    const a = at(d0);
    const b = at(d1);
    const ring = [
      [a[1] + across[1] * w, a[0] + across[0] * w],
      [b[1] + across[1] * w, b[0] + across[0] * w],
      [b[1] - across[1] * w, b[0] - across[0] * w],
      [a[1] - across[1] * w, a[0] - across[0] * w],
    ];
    ring.push(ring[0]);
    return { type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [ring] } };
  };
  const box = (c, side, props) => {
    const s = side / 2;
    const ring = [
      [c[1] - s / mLon, c[0] - s / mLat],
      [c[1] + s / mLon, c[0] - s / mLat],
      [c[1] + s / mLon, c[0] + s / mLat],
      [c[1] - s / mLon, c[0] + s / mLat],
    ];
    ring.push(ring[0]);
    return { type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [ring] } };
  };
  // widths only (heights are real): a few metres would vanish on a link of kilometres, so the
  // line, the tube and the masts are widened with the length, as on the 2D map
  const wLine = Math.max(0.7, len / 1500);
  const wTube = len / 500;
  const wMast = Math.max(2, len / 700);
  const line = [];
  const fresnel = [];
  const obstacles = [];
  for (let i = 0; i < chart.length - 1; i++) {
    const p = chart[i];
    const q = chart[i + 1];
    const c = (p.los - p.ground + q.los - q.ground) / 2;
    const r = Math.max(0.5, (p.los - p.fresnel60 + q.los - q.fresnel60) / 2);
    // the zone is invaded where the ground or what stands on it is above its lower edge
    const hit = [p, q].some((x) => x.d > 0 && x.d < D && Math.max(x.ground, x.top ?? -Infinity) > x.fresnel60);
    line.push(quad(p.d, q.d, wLine, { base: Math.max(0, c - 0.7), top: Math.max(0.2, c + 0.7) }));
    fresnel.push(quad(p.d, q.d, Math.max(r, wTube), { base: Math.max(0, c - r), top: Math.max(0.2, c + r), hit }));
    if (p.obstacle && p.top != null) obstacles.push(quad(p.d, q.d, 9, { base: 0, top: Math.max(1, p.top - p.ground), kind: p.obstacle }));
  }
  const first = chart[0];
  const last = chart[chart.length - 1];
  const masts = [
    box(from, wMast * 0.8, { base: 0, top: Math.max(1, first.los - first.ground), kind: 'cpe' }),
    box(to, wMast, { base: 0, top: Math.max(1, last.los - last.ground), kind: 'ap' }),
  ];
  const fc = (features) => ({ type: 'FeatureCollection', features });
  return { line: fc(line), fresnel: fc(fresnel), obstacles: fc(obstacles), masts: fc(masts), lengthM: len };
}

const BASE_KEY = 'cda.map3dBase';
const remembered = () => {
  try {
    return localStorage.getItem(BASE_KEY);
  } catch {
    return null;
  }
};

/**
 * Opens the 3D view of the link from [from] ([lat, lon], [label]) to the AP of the profile [p]
 * (admins: the profile carries the AP position). [others]: APs around ({ name, lat, lon }).
 */
export async function openLink3d({ from, label, p, apName, others = [] }) {
  if (p.ap?.lat == null || !p.chart?.length) return;
  const to = [p.ap.lat, p.ap.lon];
  const stage = h('div', { class: 'map3d-stage' });
  const status = h('span', { class: 'small muted' }, 'Caricamento del terreno…');
  const views = h('div', { class: 'map3d-views' });
  const imagery = h('select', { 'aria-label': 'Immagini' });
  let map = null;
  const close = () => {
    map?.remove();
    root.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => e.key === 'Escape' && close();
  const root = h(
    'div',
    { class: 'map3d', role: 'dialog', 'aria-label': `Collegamento 3D con ${apName}` },
    h(
      'div',
      { class: 'map3d-bar' },
      h('b', {}, `3D · ${label ?? 'Punto'} → ${apName}`),
      views,
      imagery,
      status,
      h('button', { type: 'button', class: 'map3d-close', 'aria-label': 'Chiudi', onclick: close }, '×'),
    ),
    stage,
    h(
      'div',
      { class: 'map3d-legend small' },
      h('span', {}, h('i', { class: 'sw los' }), 'linea di vista'),
      h('span', {}, h('i', { class: 'sw ok' }), 'Fresnel 60% libera'),
      h('span', {}, h('i', { class: 'sw bad' }), 'Fresnel invasa'),
      h('span', {}, h('i', { class: 'sw bld' }), 'edifici'),
      h('span', {}, h('i', { class: 'sw tree' }), 'alberi'),
      h('span', {}, h('i', { class: 'sw ap' }), 'AP'),
      h('span', {}, h('i', { class: 'sw cpe' }), 'CPE'),
    ),
  );
  document.body.append(root);
  document.addEventListener('keydown', onKey);

  let gl;
  let info;
  try {
    [gl, info] = await Promise.all([loadMapLibre(), api('/api/admin/map/satellite')]);
  } catch (e) {
    status.textContent = e.message;
    return;
  }
  if (!root.isConnected) return;
  const geo = linkGeometry(from, to, p.chart);
  const t = info.terrain ?? { minZoom: 10, maxZoom: 14 };
  const dem = { type: 'raster-dem', tiles: ['cda://api/admin/map/terrain/{z}/{x}/{y}'], tileSize: 256, encoding: 'terrarium', minzoom: t.minZoom, maxzoom: t.maxZoom };
  const sources = { dem, shade: { ...dem } };
  const layers = [{ id: 'bg', type: 'background', paint: { 'background-color': '#d9dfd3' } }];
  // aerial imagery of Connettori, one picture at a time (the one chosen last time first)
  const pics = info.layers ?? [];
  pics.forEach((v, i) => {
    v.parts.forEach(([provider, part], k) => {
      sources[`img${i}_${k}`] = { type: 'raster', tiles: [`cda://api/admin/map/imagery/${provider}/${part}/{z}/{x}/{y}`], tileSize: 256, minzoom: v.minZoom ?? 0, maxzoom: v.maxNativeZoom ?? 19, ...(k === 0 ? { attribution: v.attribution } : {}) };
      layers.push({ id: `img${i}_${k}`, type: 'raster', source: `img${i}_${k}`, layout: { visibility: 'none' } });
    });
  });
  // relief: on its own without imagery, faint on the pictures
  layers.push({ id: 'shade', type: 'hillshade', source: 'shade', paint: { 'hillshade-exaggeration': pics.length ? 0.15 : 0.6, 'hillshade-shadow-color': '#3f3f46' } });
  const show = (i) => {
    pics.forEach((v, j) => v.parts.forEach((_, k) => map.setLayoutProperty(`img${j}_${k}`, 'visibility', i === j ? 'visible' : 'none')));
    try {
      localStorage.setItem(BASE_KEY, pics[i]?.label ?? '');
    } catch {
      // private window: not remembered
    }
  };
  const start = Math.max(0, pics.findIndex((v) => v.label === remembered()));
  if (pics.length) {
    for (const [i, v] of pics.entries()) imagery.append(h('option', { value: i, selected: i === start }, v.label));
    imagery.onchange = () => show(Number(imagery.value));
  } else imagery.hidden = true;

  const linkBearing = bearingOf(from, to);
  map = new gl.Map({
    container: stage,
    style: { version: 8, sources, layers, terrain: { source: 'dem', exaggeration: 1 }, sky: { 'sky-color': '#7fb2e5', 'horizon-color': '#dbe9f6', 'fog-color': '#e8eef4', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.85 } },
    center: [(from[1] + to[1]) / 2, (from[0] + to[0]) / 2],
    zoom: 13,
    pitch: 60,
    bearing: linkBearing - 90,
    maxPitch: 85,
    attributionControl: { compact: true },
  });
  map.addControl(new gl.NavigationControl({ visualizePitch: true }), 'top-right');
  map.on('error', (e) => console.warn('3D', e?.error?.message ?? e));

  const fit = (bearing, pitch, focus = null) => {
    const pts = focus ? [focus, [focus[0] + (to[0] - from[0]) * 0.35, focus[1] + (to[1] - from[1]) * 0.35]] : [from, to];
    const lats = pts.map((x) => x[0]);
    const lons = pts.map((x) => x[1]);
    const cam = map.cameraForBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: 110, bearing });
    map.easeTo({ center: cam?.center, zoom: (cam?.zoom ?? 13) + (focus ? 0.3 : 0.1), bearing, pitch, duration: 900 });
  };
  const presets = [
    ['Di lato', () => fit(linkBearing - 90, 62)],
    ['Dalla CPE', () => fit(linkBearing, 72, from)],
    ['Dall’AP', () => fit((linkBearing + 180) % 360, 72, to)],
    ['Dall’alto', () => fit(linkBearing - 90, 0)],
  ];
  for (const [name, go] of presets) views.append(h('button', { type: 'button', class: 'small-btn', onclick: go }, name));

  map.on('load', () => {
    if (pics.length) show(start);
    map.addSource('fresnel', { type: 'geojson', data: geo.fresnel });
    map.addSource('line', { type: 'geojson', data: geo.line });
    map.addSource('obstacles', { type: 'geojson', data: geo.obstacles });
    map.addSource('masts', { type: 'geojson', data: geo.masts });
    const extr = (id, source, color, opacity) =>
      map.addLayer({ id, type: 'fill-extrusion', source, paint: { 'fill-extrusion-color': color, 'fill-extrusion-base': ['get', 'base'], 'fill-extrusion-height': ['get', 'top'], 'fill-extrusion-opacity': opacity } });
    extr('obstacles', 'obstacles', ['match', ['get', 'kind'], 'edificio', '#9ca3af', '#15803d'], 0.85);
    extr('masts', 'masts', ['match', ['get', 'kind'], 'ap', '#2563eb', '#f97316'], 1);
    extr('line', 'line', '#1d4ed8', 0.95);
    extr('fresnel', 'fresnel', ['case', ['get', 'hit'], '#ef4444', '#38bdf8'], 0.35);
    const tag = (lat, lon, text, cls) => new gl.Marker({ element: h('div', { class: `map3d-tag ${cls}` }, text), anchor: 'bottom' }).setLngLat([lon, lat]).addTo(map);
    tag(from[0], from[1], `CPE ${Math.round(p.cpeHeightM ?? 0)} m`, 'cpe');
    tag(to[0], to[1], `${apName}${p.apAntenna ? ` · ${p.apAntenna.aboveGroundM} m` : ''}`, 'ap');
    // the other APs within the view, as pins (no height or sector known for them here)
    const span = Math.max(Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1])) * 1.5 + 0.02;
    const mid = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
    others
      .filter((a) => a.lat != null && Math.abs(a.lat - to[0]) + Math.abs(a.lon - to[1]) > 2e-3 && Math.abs(a.lat - mid[0]) < span && Math.abs(a.lon - mid[1]) < span)
      .slice(0, 40)
      .forEach((a) => tag(a.lat, a.lon, a.name, 'other'));
    status.textContent = `${info.terrain?.fine ? 'Terreno TINITALY 10 m' : 'Terreno SRTM 30 m'}${pics.length ? '' : ' · nessuna foto aerea in Connettori'}`;
    fit(linkBearing - 90, 62);
  });
}
