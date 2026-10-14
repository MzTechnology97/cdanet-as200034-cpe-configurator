import './styles/app.css';
import { add3dButton, createMap, type CoverageAp, drawCoverage, drawFresnelLink, drawOutages, fit, type FresnelProfile, type Layer, leaflet, type LMap, MAP_COLORS as C, type OutageMap, type PointPicker, pointPicker, popup, type Simulation, simulationOverlay, towards } from './map/leaflet';
import type { Area3dExtras, LegendItem, Profile3d } from './map/map3d';

/**
 * Map page embedded in the Android app (/map-embed.html: Trova l'AP, Copertura, Guasti). It has
 * no session: the app passes the data it already received with window.cdaShow(...) and the phone
 * heading with window.cdaHeading(deg). Installers' data carry only approximate AP areas (no real
 * positions). The app listens through window.CdaApp (an Android bridge, only on this page).
 */

interface Bridge {
  CdaApp?: { onMapClick?: (lat: number, lon: number) => void; onSimulate?: (id: string) => void };
  // the functions the app calls on this page
  [fn: `cda${string}`]: unknown;
}
const page = window as unknown as Bridge;

const el = document.getElementById('map')!;
let layer: Layer = null;
let arrow: HTMLElement | null = null;

/**
 * Problems of the embedded map reach the server log (the page runs inside the Android app,
 * where no console is visible) and, for errors, the page itself.
 */
function report(kind: string, message: unknown) {
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
function showError(text: string) {
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
console.error = (...args: unknown[]) => {
  if (logged++ < 5) report('console', args.map((a) => (a as Error)?.stack || (a as Error)?.message || String(a)).join(' '));
  consoleError(...args);
};
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason as Error | undefined;
  report('rejection', r?.stack || r?.message || r);
  showError(r?.message || String(r));
});

const ready: Promise<LMap | null> = createMap(el, { zoom: 12, imagery: false, onStatus: (kind, msg) => report(kind, msg) }).then((map) => {
  if (map) {
    map.scrollWheelZoom.enable();
    layer = leaflet().layerGroup().addTo(map);
  }
  return map;
});

const km = (m: number) => (m < 1000 ? `${m} m` : `${(m / 1000).toFixed(2)} km`);

interface FindAp {
  name: string;
  ssid?: string | null;
  status: string;
  distanceM: number;
  bearing: number;
  tiltDeg?: number | null;
  altitude?: number | null;
  lat?: number;
  lon?: number;
  approx?: { lat: number; lon: number; radiusM: number } | null;
}

/** Trova l'AP: the phone's position (an arrow turned with the heading) and the APs around. */
page.cdaShow = async (d: { from?: { lat: number; lon: number }; aps?: FindAp[] }) => {
  const map = await ready;
  if (!map || !d?.from) return;
  const L = leaflet();
  layer.clearLayers();
  const me = L.marker([d.from.lat, d.from.lon], { icon: L.divIcon({ className: 'me-icon', html: '<div class="me-arrow"></div>', iconSize: [24, 24], iconAnchor: [12, 12] }) }).addTo(layer);
  arrow = me.getElement()?.querySelector('.me-arrow') ?? null;
  const layers: Layer[] = [me];
  for (const a of d.aps ?? []) {
    const color = a.status === 'active' ? C.ap : C.impacted;
    const info = [a.ssid, `${km(a.distanceM)} · azimut ${a.bearing}°${a.tiltDeg != null ? ` · tilt ${a.tiltDeg}°` : ''}`, a.altitude != null ? `${Math.round(a.altitude)} m s.l.m.` : null];
    if (a.approx) {
      layers.push(
        L.circle([a.approx.lat, a.approx.lon], { radius: a.approx.radiusM, color, weight: 1, fillOpacity: 0.1 })
          .bindPopup(popup(a.name, ...info, 'posizione approssimativa'))
          .addTo(layer),
      );
      L.polyline([[d.from.lat, d.from.lon], towards(d.from.lat, d.from.lon, a.bearing, Math.min(a.distanceM, 600))], { color, weight: 3 }).addTo(layer);
    } else {
      layers.push(
        L.circleMarker([a.lat, a.lon], { radius: 7, color, weight: 2, fillOpacity: 0.85 })
          .bindPopup(popup(a.name, ...info))
          .addTo(layer),
      );
      L.polyline(
        [
          [d.from.lat, d.from.lon],
          [a.lat, a.lon],
        ],
        { color, weight: 2, dashArray: '6 6' },
      ).addTo(layer);
    }
  }
  fit(map, layers);
};

/** Guasti Enel map (data of /api/outages/map, already scoped by the server for the user). */
const outageMarkers = new Map<string, Layer>();
page.cdaOutages = async (d: OutageMap) => {
  const map = await ready;
  if (!map || !d) return;
  layer.clearLayers();
  arrow = null;
  outageMarkers.clear();
  fit(
    map,
    drawOutages(layer, d, (o, marker) => outageMarkers.set(String(o.id), marker)),
  );
};

/** One outage of the app's list: its area in view (zones and POP/AP around it), details open. */
page.cdaFocusOutage = async (id: string | number) => {
  const map = await ready;
  const m = outageMarkers.get(String(id));
  if (!map || !m) return;
  map.setView(m.getLatLng(), Math.max(map.getZoom(), 13));
  m.openPopup();
};

/** Phone heading (degrees, true north): rotates the position arrow. */
page.cdaHeading = (deg: number) => {
  if (arrow) arrow.style.transform = `rotate(${Number(deg) || 0}deg)`;
};

/** Copertura (app): the checked point and the nearest APs, data of /api/coverage as is. */
const coverageAps = new Map<string, { marker: Layer; bounds: Layer }>();
page.cdaCoverage = async (d: { lat: number; lon: number; aps?: CoverageAp[] }) => {
  const map = await ready;
  if (!map || !d) return;
  layer.clearLayers();
  arrow = null;
  coverageAps.clear();
  const layers = drawCoverage(layer, d.lat, d.lon, d.aps ?? [], (a, marker, bounds) => coverageAps.set(a.id, { marker, bounds }));
  // in the coverage check the point is a pin that can be dragged (taps move the map only)
  picker?.set(d.lat, d.lon, layer);
  fit(map, layers);
};

/** Shows one AP of the coverage list: point and AP in view, AP details open. */
page.cdaFocus = async (id: string) => {
  const map = await ready;
  const f = coverageAps.get(id);
  if (!map || !f) return;
  map.fitBounds(f.bounds.pad(0.25), { maxZoom: 16 });
  f.marker.openPopup();
};

// ---- Verifica copertura (app) ----------------------------------------------------------------
// A tap on the map checks that point, "Simula copertura" on an AP runs its radio simulation.

/** Same scale as the console simulation, from excellent to unusable. */
const SIM_SCALE: Array<[number, string]> = [
  [-60, '#15803d'],
  [-65, '#22c55e'],
  [-70, '#a3e635'],
  [-75, '#facc15'],
  [-80, '#f97316'],
  [-999, '#dc2626'],
];
const simColor = (dbm: number) => SIM_SCALE.find(([min]) => dbm >= min)![1];
const STATE_COLOR: Record<string, string> = { ok: '#14b8a6', degraded: '#f59e0b', down: '#dc2626' };
let baseLayer: Layer = null;
let simLayer: Layer = null;
let picker: PointPicker | null = null;

/** What the 3D button shows: the APs, the simulation and the link drawn on the map. */
const view3d: Required<Area3dExtras> = { aps: [], sim: null, link: null };

/**
 * Turns on the point to check: the first tap places it (the app passes it back to itself); then
 * taps move the map only and the point is dragged, or placed again after window.cdaPickPoint().
 */
page.cdaCoverageMode = async () => {
  const map = await ready;
  if (!map || picker) return;
  picker = pointPicker(map, (lat, lon) => page.CdaApp?.onMapClick?.(lat, lon));
};

/** "Nuovo punto sulla mappa": the next tap places the point again. */
page.cdaPickPoint = async () => {
  await ready;
  picker?.arm();
};

interface NetAp {
  id: string;
  name: string;
  ssid?: string | null;
  model?: string | null;
  state?: string;
  lat?: number | null;
  lon?: number | null;
}

/** Admins: every AP with a position (data of /api/network/status), each one with "Simula copertura". */
page.cdaCoverageBase = async (d: { pops?: Array<{ name: string; aps?: NetAp[] }>; apsWithoutPop?: NetAp[] }) => {
  const map = await ready;
  if (!map || !d) return;
  const L = leaflet();
  baseLayer ??= L.layerGroup().addTo(map);
  baseLayer.clearLayers();
  const aps = [...(d.pops ?? []).flatMap((p) => (p.aps ?? []).map((a) => ({ ...a, pop: p.name as string | null }))), ...(d.apsWithoutPop ?? []).map((a) => ({ ...a, pop: null }))].filter((a) => a.lat != null && a.lon != null);
  view3d.aps = aps;
  for (const a of aps) {
    const sim = document.createElement('button');
    sim.type = 'button';
    sim.className = 'small-btn';
    sim.textContent = 'Simula copertura';
    sim.onclick = () => {
      map.closePopup();
      page.CdaApp?.onSimulate?.(a.id);
    };
    const box = popup(a.name, a.ssid && a.ssid !== a.name ? a.ssid : null, a.pop ? `POP ${a.pop}` : 'AP senza POP', a.model);
    box.append(sim);
    L.circleMarker([a.lat, a.lon], { radius: 5, color: STATE_COLOR[a.state ?? ''] ?? '#64748b', weight: 2, fillOpacity: 0.85, bubblingMouseEvents: false })
      .bindPopup(box)
      .addTo(baseLayer);
  }
};

/** Capacity scale (downlink of the radio link, Mbit/s), as in the console. */
const CAP_SCALE: Array<[number, string]> = [
  [150, '#15803d'],
  [100, '#22c55e'],
  [50, '#a3e635'],
  [25, '#facc15'],
  [10, '#f97316'],
  [-1, '#dc2626'],
];
const capColor = (v: number) => CAP_SCALE.find(([min]) => v >= min)![1];
const SIM_LEGEND: Array<[number, string, string]> = [
  [-60, '#15803d', 'oltre −60 dBm'],
  [-65, '#22c55e', '−60…−65'],
  [-70, '#a3e635', '−65…−70'],
  [-75, '#facc15', '−70…−75'],
  [-80, '#f97316', '−75…−80'],
];
const CAP_LEGEND: Array<[string, string]> = [
  ['#15803d', 'oltre 150 Mbit/s'],
  ['#22c55e', '100–150'],
  ['#a3e635', '50–100'],
  ['#facc15', '25–50'],
  ['#f97316', '10–25'],
  ['#dc2626', 'sotto 10'],
];
let lastSim: string | null | undefined = null;

/**
 * Radio simulation of one AP (data of /api/admin/coverage/simulation): estimated signal cells and
 * the sector. [mode]: "dbm" (signal, default), "cap" (capacity of the link) or "eve" (speed in the
 * evening). Keeps the view when only the mode changes.
 */
page.cdaSimulation = async (d: Simulation, mode: 'dbm' | 'cap' | 'eve' = 'dbm') => {
  const map = await ready;
  if (!map || !d?.ap) return;
  const L = leaflet();
  simLayer ??= L.layerGroup().addTo(map);
  simLayer.clearLayers();
  // only where a CPE would work (as in the console): under the minimum by more than 5 dB, or
  // behind a hill with a signal under the minimum, the map stays empty: the real shape, no disc
  const min = d.minDbm ?? -75;
  const usable = (c: { dbm: number; blocked?: boolean }) => c.dbm >= min - 5 && !(c.blocked && c.dbm < min);
  const share = d.eveningShare ?? 1;
  const overlay = simulationOverlay(d, (c) => (!usable(c) ? null : mode === 'cap' || mode === 'eve' ? (c.cap == null ? null : capColor(mode === 'eve' ? c.cap * share : c.cap)) : simColor(c.dbm))).addTo(simLayer);
  const legendItems: LegendItem[] = mode === 'dbm' ? SIM_LEGEND.filter(([min2]) => min2 >= min - 5).map(([, color, text]) => ['scale', text, color]) : CAP_LEGEND.map(([color, text]) => ['scale', text, color]);
  view3d.sim = { d, image: overlay.canvas, bounds: overlay.cellBounds, title: `simulazione di ${d.ap.name}`, legendItems };
  if (d.sector && (d.servedM || d.theoretical)) {
    const reach = d.servedM || d.radiusM;
    const pts: Array<[number, number]> = [[d.ap.lat, d.ap.lon]];
    for (let i = 0; i <= 24; i++) pts.push(towards(d.ap.lat, d.ap.lon, d.sector.center - d.sector.width / 2 + (d.sector.width * i) / 24, reach));
    L.polygon(pts, { color: '#0f172a', weight: 1.5, fill: false, dashArray: '4 5', interactive: false }).addTo(simLayer);
  }
  L.circleMarker([d.ap.lat, d.ap.lon], { radius: 8, color: '#0f172a', weight: 3, fillColor: '#ffffff', fillOpacity: 1, interactive: false }).addTo(simLayer);
  if (lastSim !== d.ap.id) map.fitBounds(L.latLng(d.ap.lat, d.ap.lon).toBounds(d.radiusM * 2.1));
  lastSim = d.ap.id;
};

page.cdaClearSimulation = async () => {
  lastSim = null;
  view3d.sim = null;
  simLayer?.clearLayers();
};

/**
 * Admins in the app: the session of the app for this page (the terrain and the imagery of the 3D
 * view are for admins only) and the "3D" button on the map, as in the console.
 */
let button3d: Layer = null;
page.cdaAdmin3d = async (token: string) => {
  try {
    sessionStorage.setItem('cdaSession', JSON.stringify({ token }));
  } catch {
    return;
  }
  const map = await ready;
  if (!map || button3d) return;
  button3d = add3dButton(map, () => ({ ...view3d }));
};

/** Visibilità (admins): the link from the checked point to the AP and its Fresnel zone. */
let linkLayer: Layer = null;
page.cdaLink = async (p: FresnelProfile & Profile3d & { ap: { lat: number; lon: number; id?: string; name?: string } }, lat: number, lon: number) => {
  const map = await ready;
  if (!map || !p?.ap || p.ap.lat == null) return;
  linkLayer ??= leaflet().layerGroup().addTo(map);
  drawFresnelLink(map, linkLayer, [lat, lon], p);
  view3d.link = { from: [lat, lon], label: 'Punto', p, apName: p.ap.name ?? p.ap.id ?? '' };
};
page.cdaClearLink = async () => {
  view3d.link = null;
  await ready;
  linkLayer?.clearLayers();
};
