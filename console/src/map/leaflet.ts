import { api } from '../lib/api';
import { isAdminUser } from '../lib/terms';

/**
 * Console maps: Leaflet + Protomaps basemap served by our server (OpenStreetMap data, no external
 * service). Until the basemap is installed the public OpenStreetMap tiles are used instead.
 * Leaflet and Protomaps are the vendor files of the server (web/vendor), loaded with the first map.
 */

// Leaflet and its plugins come from the server's vendor files, without types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Leaflet = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LMap = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Layer = any;
type LatLon = [number, number];

interface MapWindow {
  L: Leaflet;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protomapsL?: any;
  __cdaFetch?: typeof fetch;
}
const win = () => window as unknown as MapWindow;
export const leaflet = (): Leaflet => win().L;

const COLORS = { guasto_mt: '#dc2626', guasto_bt: '#f59e0b', lavoro: '#94a3b8', altro: '#f59e0b', pop: '#0ea5e9', ap: '#14b8a6', impacted: '#dc2626', zone: '#6366f1', personal: '#3b82f6', point: '#f97316' };
export const MAP_COLORS = COLORS;
const kindColor = (kind: string) => (COLORS as Record<string, string | undefined>)[kind];

interface MapConfig {
  basemap?: { tiles?: string; url?: string; minZoom?: number; maxZoom?: number } | null;
  fallback: { url: string; attribution: string };
}

let vendor: Promise<void> | null = null;

/**
 * Reads of the local basemap (single tiles from the server). The vector-tile reader swallows its
 * own errors and still draws (empty) tiles, so only the reads tell whether the map really works.
 */
const reads = { ok: 0, fail: 0, error: '', other: new Set<string>() };
if (!win().__cdaFetch) {
  const original = window.fetch.bind(window);
  win().__cdaFetch = original;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String((input as Request)?.url ?? input);
    const isMap = url.includes('/map/tiles/') || url.includes('/map/basemap');
    try {
      const r = await original(input, init);
      if (isMap) {
        if (r.ok) reads.ok++;
        else {
          reads.fail++;
          reads.error = `HTTP ${r.status}`;
        }
      }
      return r;
    } catch (e) {
      if (isMap) {
        reads.fail++;
        reads.error = (e as Error).message;
      }
      // other failed requests (diagnostics): address without query
      else if (reads.other.size < 5) reads.other.add(url.split('?')[0]!.slice(0, 120));
      throw e;
    }
  };
}

const script = (src: string) =>
  new Promise<void>((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => res();
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

/** Waits until [el] is in the page. */
const attached = (el: HTMLElement) =>
  new Promise<void>((res) => {
    const tick = (n: number) => (el.isConnected || n > 200 ? res() : requestAnimationFrame(() => tick(n + 1)));
    tick(0);
  });

/**
 * Leaflet map in [el] with the basemap; resolves to the map (null if the page went away).
 * If the local basemap draws nothing within a few seconds (old browser engine, broken file) the
 * public OpenStreetMap tiles are added instead; [onStatus] receives what happened (diagnostics).
 */
export async function createMap(
  el: HTMLElement,
  { center = [37.57, 14.27] as LatLon, zoom = 9, onStatus = null as ((kind: string, message: string) => void) | null, imagery = true } = {},
): Promise<LMap | null> {
  await Promise.all([loadVendor(), attached(el)]);
  if (!el.isConnected) return null;
  // read every time: the basemap may have been installed meanwhile
  const config = await api<MapConfig>('/api/map/config');
  const L = leaflet();
  // markers, lines and areas drawn on one canvas instead of one SVG element each: hundreds of APs,
  // customers or outages stay smooth
  const map = L.map(el, { center, zoom, scrollWheelZoom: false, preferCanvas: true });
  // the basemap lives in a group: the layer switch of the admins shows/hides it as one, even when
  // the public tiles replace it
  const base = L.layerGroup().addTo(map);
  // OpenStreetMap's tile policy requires a Referer (the console sends none by default)
  const publicTiles = () => base.addLayer(L.tileLayer(config.fallback.url, { maxZoom: 19, attribution: config.fallback.attribution, referrerPolicy: 'strict-origin-when-cross-origin' }));
  if (imagery && isAdminUser()) void addViews(map, base, config);
  const pmL = win().protomapsL;
  if (config.basemap && pmL) {
    const bm = config.basemap;
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    const pm = pmL.leafletLayer({ url: bm.tiles ?? bm.url, flavor: dark ? 'dark' : 'light', lang: 'it', maxDataZoom: bm.maxZoom });
    base.addLayer(pm);
    const start = reads.ok;
    setTimeout(() => {
      // an admin looking at the satellite: the basemap was not drawn, nothing to judge
      if (!el.isConnected || !map.hasLayer(base)) return;
      const size = map.getSize();
      // no tile read: unreadable here, or outside the downloaded area
      const working = reads.ok - start > (bm.tiles ? 0 : 3);
      const other = reads.other.size ? `, altre richieste fallite: ${[...reads.other].join(' ')}` : '';
      onStatus?.(working ? 'basemap_ok' : 'basemap_fallback', `letture ${reads.ok - start} ok, ${reads.fail} fallite${reads.error ? ` (${reads.error})` : ''}, mappa ${size.x}×${size.y}, zoom ${map.getZoom()}${other}`);
      if (!working) {
        base.removeLayer(pm);
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

/** How many zooms below a missing photo are tried: its own photo, enlarged (6: a 64th of a tile). */
const FALLBACK_LEVELS = 6;
interface Coords {
  x: number;
  y: number;
  z: number;
}

/**
 * Tiles read with the session of the admin (the imagery goes through our server): fetched, then
 * shown from a blob. An empty answer (no imagery there) leaves the tile blank.
 */
function authTileLayer(url: string, options: Record<string, unknown>) {
  const L = leaflet();
  // the photos of the zooms below, shared by the tiles that use them (the last few dozen)
  const parents = new Map<string, Promise<ImageBitmap | null>>();
  const Layer = L.TileLayer.extend({
    /** A photo of this layer as a bitmap; null when the service has nothing there. */
    photo(coords: Coords) {
      const u: string = this.getTileUrl(coords);
      let p = parents.get(u);
      if (!p) {
        // shared by many tiles: not stopped when one of them leaves the view
        p = api<Response>(u, { raw: true })
          .then(async (r) => (r.ok && r.status !== 204 ? createImageBitmap(await r.blob()) : null))
          .catch(() => null);
        parents.set(u, p);
        if (parents.size > 48) parents.delete(parents.keys().next().value!);
      }
      return p;
    },
    /**
     * No photo for this tile (the public service often answers blank): the part of the nearest
     * zoom below that has one, enlarged, instead of an empty square. Null when none has it.
     */
    async fromBelow(coords: Coords, signal: AbortSignal): Promise<Blob | null> {
      const min: number = this.options.minNativeZoom ?? 0;
      for (let k = 1; k <= FALLBACK_LEVELS && coords.z - k >= min; k++) {
        const n = 2 ** k;
        const parent = { x: Math.floor(coords.x / n), y: Math.floor(coords.y / n), z: coords.z - k };
        const bmp: ImageBitmap | null = await this.photo(parent);
        if (signal.aborted) return null;
        if (!bmp) continue;
        const size = this.getTileSize();
        const canvas = document.createElement('canvas');
        canvas.width = size.x;
        canvas.height = size.y;
        const part = bmp.width / n;
        canvas.getContext('2d')!.drawImage(bmp, (coords.x % n) * part, (coords.y % n) * part, part, part, 0, 0, size.x, size.y);
        return new Promise((res) => canvas.toBlob((b) => res(b), 'image/jpeg', 0.85));
      }
      return null;
    },
    createTile(coords: Coords, done: (e: Error | null, tile: HTMLElement) => void) {
      const img = document.createElement('img') as HTMLImageElement & { _abort?: () => void };
      img.alt = '';
      // a tile that leaves the view (zoom, a quick pan) stops its request: the visible tiles do not
      // wait behind tens of useless ones (the public orthophotos are slow)
      const ctrl = new AbortController();
      img._abort = () => ctrl.abort();
      const show = (blob: Blob | null) => {
        if (!blob) return done(null, img);
        img.onload = () => (URL.revokeObjectURL(img.src), done(null, img));
        img.onerror = () => done(new Error('tile'), img);
        img.src = URL.createObjectURL(blob);
      };
      api<Response>(this.getTileUrl(coords), { raw: true, signal: ctrl.signal })
        .then(async (r) => {
          if (r.ok && r.status !== 204) return show(await r.blob());
          if (ctrl.signal.aborted) return null;
          return show(await this.fromBelow(coords, ctrl.signal));
        })
        .catch((e: Error) => (ctrl.signal.aborted ? null : done(e, img)));
      return img;
    },
  });
  // no new tiles during the zoom animation, few kept around the view: less work and fewer requests
  const layer = new Layer(url, { updateWhenZooming: false, updateWhenIdle: true, keepBuffer: 1, ...options });
  layer.on('tileunload', (e: { tile: { _abort?: () => void } }) => e.tile._abort?.());
  return layer;
}

const BASE_KEY = 'cda.mapBase';
const OVERLAY_KEY = 'cda.mapOverlays';
const stored = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const savedOverlays = (): string[] => {
  try {
    return JSON.parse(stored(OVERLAY_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
};
const remember = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode: not remembered */
  }
};

/**
 * Layers of the basemap that can be shown on their own, over any background (also the aerial
 * imagery): the rules of the theme for those data layers only, on a transparent canvas.
 */
const OVERLAYS: Array<[string, string[], string[]]> = [
  ['Strade e vie', ['roads'], ['roads']],
  ['Edifici', ['buildings'], []],
  ['Località e nomi', [], ['places', 'pois']],
  ['Acque', ['water'], ['water']],
  ['Confini', ['boundaries'], []],
];

interface Satellite {
  layers?: Array<{ label: string; attribution?: string; minZoom?: number; maxNativeZoom?: number; parts: Array<[string, string]> }>;
}

/**
 * Admins: views of the map. Backgrounds: the basemap in its themes (light, dark, grey) and the
 * aerial imagery of every provider switched on in Connettori → Immagini satellitari (through the
 * server), one entry each to compare them on the same place. Layers to add on top: roads and
 * streets, buildings, places, water, borders. The choices are remembered on this browser.
 */
async function addViews(map: LMap, base: Layer, config: MapConfig) {
  const s = await api<Satellite>('/api/admin/map/satellite').catch(() => null);
  if (!map.getContainer().isConnected) return;
  const L = leaflet();
  const pm = config.basemap && win().protomapsL ? win().protomapsL : null;
  const url = config.basemap ? (config.basemap.tiles ?? config.basemap.url) : null;
  const vector = (opts: Record<string, unknown>) => pm.leafletLayer({ url, lang: 'it', maxDataZoom: config.basemap!.maxZoom, ...opts });
  const bases: Record<string, Layer> = { Mappa: base };
  const overlays: Record<string, Layer> = {};
  if (pm) {
    bases['Mappa chiara'] = vector({ flavor: 'light' });
    bases['Mappa scura'] = vector({ flavor: 'dark' });
    bases['Mappa grigia'] = vector({ flavor: 'grayscale' });
    // the rules of the light theme, split by data layer (a layer not added only lends its rules)
    const theme = vector({ flavor: 'light' });
    for (const [name, paint, labels] of OVERLAYS) {
      const paintRules = theme.paintRules.filter((r: { dataLayer: string }) => paint.includes(r.dataLayer));
      const labelRules = theme.labelRules.filter((r: { dataLayer: string }) => labels.includes(r.dataLayer));
      if (paintRules.length || labelRules.length) overlays[name] = vector({ paintRules, labelRules, attribution: '' });
    }
  }
  const photos: Layer[] = [];
  for (const v of s?.layers ?? []) {
    // a service that starts at a zoom (the AGEA orthophotos from 12, see the server): further out
    // the basemap, never an empty map and no photo tiles scaled down (tens of slow requests for a
    // regional view). Where the photos are clear (the sea of the coast tiles) the map colour shows
    const min = v.minZoom ?? 0;
    const opts = { maxZoom: 20, maxNativeZoom: v.maxNativeZoom, minZoom: min, minNativeZoom: min, tileSize: 256 };
    const parts: Layer[] = v.parts.map(([provider, part], i) => authTileLayer(`/api/admin/map/imagery/${provider}/${part}/{z}/{x}/{y}`, { ...opts, ...(i === 0 ? { attribution: v.attribution } : {}) }));
    // the basemap under the photos at every zoom: far out it is the map, closer it shows wherever
    // the service has no photo (the public orthophotos come back blank for many tiles) instead of
    // an empty square, and the sea of the coast tiles (clear) shows the sea of the map
    if (min > 1) parts.unshift(pm ? vector({ flavor: 'light', attribution: '' }) : L.tileLayer(config.fallback.url, { maxZoom: 19, attribution: config.fallback.attribution, referrerPolicy: 'strict-origin-when-cross-origin' }));
    bases[v.label] = parts.length === 1 ? parts[0] : L.layerGroup(parts);
    photos.push(bases[v.label]);
  }
  if (Object.keys(bases).length === 1 && !Object.keys(overlays).length) return;
  const chosen = bases[stored(BASE_KEY) ?? ''];
  if (chosen && chosen !== base) {
    map.removeLayer(base);
    chosen.addTo(map);
  }
  const on = new Set(savedOverlays());
  for (const [name, layer] of Object.entries(overlays)) if (on.has(name)) layer.addTo(map);
  L.control.layers(bases, overlays, { position: 'topright' }).addTo(map);
  // admins: the same area in 3D (terrain, imagery, buildings), with what the page adds (map.cda3d)
  if (s) add3dButton(map, () => map.cda3d?.() ?? {});
  // with the photos on, the background of the map is the sea: the coast tiles are clear there
  const sea = () => map.getContainer().classList.toggle('photo-base', photos.some((l) => map.hasLayer(l)));
  sea();
  map.on('baselayerchange', (e: { name: string }) => (remember(BASE_KEY, e.name), sea()));
  const saveOverlays = () =>
    remember(
      OVERLAY_KEY,
      JSON.stringify(
        Object.entries(overlays)
          .filter(([, l]) => map.hasLayer(l))
          .map(([n]) => n),
      ),
    );
  map.on('overlayadd overlayremove', saveOverlays);
}

/** The "3D" button of the admin maps: the area in view in 3D, with what [extras] gives (APs, simulation, link). */
export function add3dButton(map: LMap, extras: () => object) {
  const L = leaflet();
  const Btn = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const b = L.DomUtil.create('button', 'map-3d-btn') as HTMLButtonElement;
      b.type = 'button';
      b.textContent = '3D';
      b.title = 'Vista 3D di questa zona';
      L.DomEvent.disableClickPropagation(b);
      b.onclick = () => void import('./map3d').then((m) => m.openArea3d({ map, extras: extras() }));
      return b;
    },
  });
  return new Btn().addTo(map);
}

/** Popup content as DOM (never HTML strings: names come from external systems). */
export function popup(title: string, ...lines: Array<string | null | undefined | false>): HTMLElement {
  const box = document.createElement('div');
  box.className = 'map-popup';
  const b = document.createElement('b');
  b.textContent = title;
  box.append(b);
  for (const l of lines) {
    if (!l) continue;
    const row = document.createElement('div');
    row.className = 'small';
    row.textContent = l;
    box.append(row);
  }
  return box;
}

const localTime = (s?: string | null) => (s ? s.replace('T', ' ').replace(/^(\d{4})-(\d{2})-(\d{2})/, '$3/$2/$1') : '');

export interface OutageMap {
  zones?: Array<{ lat: number; lon: number; radiusKm: number; personal?: boolean; name: string }>;
  infra?: Array<{ type: 'pop' | 'ap'; name: string; impacted?: boolean; stations?: number | null; lat?: number; lon?: number; approx?: { lat: number; lon: number; radiusM: number } | null }>;
  outages?: Array<{ id: string | number; lat: number; lon: number; kind: string; impacted?: boolean; label: string; place: string; province: string; customers: number; expectedRestore?: string | null }>;
}

/**
 * Draws the Guasti Enel map data (/api/outages/map) on [target] (map or layer group): zones,
 * POPs/APs (real point or approximate area) and outages; returns the layers to fit.
 */
export function drawOutages(target: Layer, d: OutageMap, onOutage: ((o: NonNullable<OutageMap['outages']>[number], marker: Layer) => void) | null = null): Layer[] {
  const L = leaflet();
  const layers: Layer[] = [];
  for (const z of d.zones ?? []) {
    layers.push(
      L.circle([z.lat, z.lon], { radius: z.radiusKm * 1000, color: z.personal ? COLORS.personal : COLORS.zone, weight: 1, dashArray: '4 4', fillOpacity: 0.04 })
        .bindPopup(popup(`Zona ${z.name}`, `raggio ${z.radiusKm} km`))
        .addTo(target),
    );
  }
  for (const i of d.infra ?? []) {
    const color = i.impacted ? COLORS.impacted : COLORS[i.type];
    const title = `${i.type === 'pop' ? 'POP' : 'AP'} ${i.name}`;
    const info = [i.stations != null ? `${i.stations} CPE` : null, i.impacted ? 'potenzialmente impattato da un guasto' : null];
    layers.push(
      i.approx
        ? L.circle([i.approx.lat, i.approx.lon], { radius: i.approx.radiusM, color, weight: 1, fillOpacity: 0.12 })
            .bindPopup(popup(title, ...info, 'posizione approssimativa'))
            .addTo(target)
        : L.circleMarker([i.lat, i.lon], { radius: i.type === 'pop' ? 8 : 5, color, weight: 2, fillOpacity: 0.85 })
            .bindPopup(popup(title, ...info))
            .addTo(target),
    );
  }
  for (const o of d.outages ?? []) {
    const marker = L.circleMarker([o.lat, o.lon], { radius: 7, color: o.impacted ? COLORS.impacted : kindColor(o.kind), fillColor: kindColor(o.kind), weight: o.impacted ? 3 : 1.5, fillOpacity: 0.9 })
      .bindPopup(popup(o.label, `${o.place} (${o.province})`, `${o.customers} clienti Enel`, o.expectedRestore ? `ripristino previsto ${localTime(o.expectedRestore)}` : null, o.impacted ? 'POP/AP potenzialmente impattati' : null))
      .addTo(target);
    layers.push(marker);
    onOutage?.(o, marker);
  }
  return layers;
}

/** Fits the map to the given layers, with a sensible max zoom. */
export function fit(map: LMap, layers: Layer[]) {
  const L = leaflet();
  const g = L.featureGroup(layers.filter(Boolean));
  if (g.getLayers().length) map.fitBounds(g.getBounds().pad(0.15), { maxZoom: 14 });
}

/** Point at [distanceM] from [lat, lon] towards [bearing] degrees (for short direction lines). */
export function towards(lat: number, lon: number, bearing: number, distanceM: number): LatLon {
  const R = 6371e3;
  const d = distanceM / R;
  const b = (bearing * Math.PI) / 180;
  const p1 = (lat * Math.PI) / 180;
  const l1 = (lon * Math.PI) / 180;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [(p2 * 180) / Math.PI, (l2 * 180) / Math.PI];
}

const km = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1).replace('.', ',')} km`);

export interface CoverageAp {
  id: string;
  name: string;
  ssid?: string | null;
  distanceM: number;
  bearing: number;
  direction: string;
  status: string;
  stations?: number | null;
  lat?: number;
  lon?: number;
  approx?: { lat: number; lon: number; radiusM: number } | null;
  served?: { servedM?: number; center: number; width: number } | null;
}

/**
 * Coverage check (console and app): the point and the nearest APs. Admins get the real position
 * and the area already served by the customers; installers an approximate area and the direction.
 * [onAp] receives each AP's layer and the bounds to show it (the app focuses an AP from its list).
 */
export function drawCoverage(target: Layer, la: number, lo: number, aps: CoverageAp[], onAp: ((a: CoverageAp, marker: Layer, bounds: Layer) => void) | null = null): Layer[] {
  const L = leaflet();
  const layers: Layer[] = [L.circleMarker([la, lo], { radius: 7, color: COLORS.point, weight: 2, fillOpacity: 0.9 }).bindPopup(popup('Punto verificato', `${la.toFixed(5)}, ${lo.toFixed(5)}`)).addTo(target)];
  for (const a of aps) {
    const info = [a.ssid, `${km(a.distanceM)} · ${a.bearing}° ${a.direction}`, a.stations != null ? `${a.stations} client` : null];
    const color = a.status === 'active' ? COLORS.ap : COLORS.impacted;
    let marker: Layer;
    if (a.approx) {
      marker = L.circle([a.approx.lat, a.approx.lon], { radius: a.approx.radiusM, color, weight: 1, fillOpacity: 0.1 })
        .bindPopup(popup(a.name, ...info, 'posizione approssimativa'))
        .addTo(target);
      L.polyline([[la, lo], towards(la, lo, a.bearing, Math.min(a.distanceM, 600))], { color, weight: 3 }).addTo(target);
    } else {
      marker = L.circleMarker([a.lat, a.lon], { radius: 6, color, weight: 2, fillOpacity: 0.85 })
        .bindPopup(popup(a.name, ...info))
        .addTo(target);
      L.polyline(
        [
          [la, lo],
          [a.lat, a.lon],
        ],
        { color, weight: 2, dashArray: '6 6' },
      ).addTo(target);
      // area already served (from the customers' positions): admins only
      if (a.served?.servedM && a.lat != null && a.lon != null) {
        const pts: LatLon[] = [[a.lat, a.lon]];
        for (let i = 0; i <= 12; i++) pts.push(towards(a.lat, a.lon, a.served.center - a.served.width / 2 + (a.served.width * i) / 12, a.served.servedM));
        L.polygon(pts, { color: COLORS.ap, weight: 1, fillOpacity: 0.08, dashArray: '3 5' })
          .bindPopup(popup(`${a.name}: area servita`, `settore ${a.served.width}° verso ${a.served.center}°`, `clienti fino a ${km(a.served.servedM)}`))
          .addTo(target);
      }
    }
    layers.push(marker);
    onAp?.(a, marker, L.featureGroup([layers[0], marker]).getBounds());
  }
  return layers;
}

export interface PointPicker {
  set(lat: number, lon: number, layer?: Layer): Layer;
  arm(): void;
  readonly armed: boolean;
}

/**
 * The point to check (the customer's CPE) on a map. A click or tap places it only when nothing is
 * placed yet or after [arm] ("Nuovo punto sulla mappa"); then clicks and taps just move the map and
 * the point is moved by dragging its pin. A click that ends a pan or zoom (touch screens, a map in a
 * scrolling page) never counts. [onPick] receives the new position.
 */
export function pointPicker(map: LMap, onPick: (lat: number, lon: number) => void): PointPicker {
  const L = leaflet();
  let armed = true;
  let pin: Layer = null;
  let movedAt = 0;
  const container: HTMLElement = map.getContainer();
  const mark = () => container.classList.toggle('picking', armed);
  map.on('movestart zoomstart moveend zoomend', () => (movedAt = Date.now()));
  map.on('click', (e: { latlng: { lat: number; lng: number } }) => {
    if (!armed || Date.now() - movedAt < 400) return;
    armed = false;
    mark();
    onPick(e.latlng.lat, e.latlng.lng);
  });
  mark();
  return {
    /** Shows the pin at the checked point; dragging it checks the new position. */
    set(lat, lon, layer = map) {
      pin?.remove();
      pin = L.marker([lat, lon], { draggable: true, autoPan: true, title: 'Trascina per spostare il punto', icon: L.divIcon({ className: 'cpe-pin', html: '<span></span>', iconSize: [22, 22], iconAnchor: [11, 11] }) }).addTo(layer);
      pin.on('dragend', () => {
        const p = pin.getLatLng();
        onPick(p.lat, p.lng);
      });
      armed = false;
      mark();
      return pin;
    },
    /** The next click (or tap) places a new point. */
    arm() {
      armed = true;
      mark();
    },
    get armed() {
      return armed;
    },
  };
}

export interface SimCell {
  lat?: number;
  lon?: number;
  i?: number;
  j?: number;
  dbm: number;
  blocked?: boolean;
  confidence?: string;
  cap?: number | null;
}
export interface Simulation {
  ap: { id?: string; name: string; lat: number; lon: number };
  n?: number;
  radiusM: number;
  cellM?: number;
  cells?: SimCell[];
  theoretical?: boolean;
  minDbm?: number;
  sector?: { center: number; width: number } | null;
  servedM?: number | null;
  eveningShare?: number | null;
}

/**
 * Radio simulation as one image over the map: one pixel per cell (grid [d.n] × [d.n] around the
 * AP), scaled smoothly by the browser instead of thousands of squares. [colorOf] gives the colour of
 * a cell (null: left blank). The overlay keeps its canvas and bounds for the 3D view.
 */
export function simulationOverlay(d: Simulation, colorOf: (c: SimCell) => string | null): Layer & { canvas: HTMLCanvasElement; cellBounds: [LatLon, LatLon] } {
  const L = leaflet();
  const n = d.n ?? Math.round((2 * d.radiusM) / d.cellM!);
  const cellM = d.cellM ?? (2 * d.radiusM) / n;
  const mPerLat = 111320;
  const mPerLon = 111320 * Math.cos((d.ap.lat * Math.PI) / 180);
  const canvas = document.createElement('canvas');
  canvas.width = n;
  canvas.height = n;
  const g = canvas.getContext('2d')!;
  const img = g.createImageData(n, n);
  for (const c of d.cells ?? []) {
    const color = colorOf(c);
    if (!color) continue;
    const i = c.i ?? Math.floor(((c.lon! - d.ap.lon) * mPerLon + d.radiusM) / cellM);
    const j = c.j ?? Math.floor(((c.lat! - d.ap.lat) * mPerLat + d.radiusM) / cellM);
    if (i < 0 || j < 0 || i >= n || j >= n) continue;
    const k = ((n - 1 - j) * n + i) * 4;
    img.data[k] = parseInt(color.slice(1, 3), 16);
    img.data[k + 1] = parseInt(color.slice(3, 5), 16);
    img.data[k + 2] = parseInt(color.slice(5, 7), 16);
    img.data[k + 3] = Math.round(255 * (c.blocked ? 0.22 : d.theoretical ? 0.42 : c.confidence === 'bassa' ? 0.28 : 0.55));
  }
  g.putImageData(img, 0, 0);
  const bounds: [LatLon, LatLon] = [
    [d.ap.lat - d.radiusM / mPerLat, d.ap.lon - d.radiusM / mPerLon],
    [d.ap.lat + d.radiusM / mPerLat, d.ap.lon + d.radiusM / mPerLon],
  ];
  const overlay = L.imageOverlay(canvas.toDataURL(), bounds, { interactive: false, className: 'sim-overlay' });
  // the same picture for the 3D view
  overlay.canvas = canvas;
  overlay.cellBounds = bounds;
  return overlay;
}

export interface FresnelProfile {
  distanceM: number;
  frequencyMhz?: number;
  ap: { lat: number; lon: number };
  chart: Array<{ d: number; los: number; ground: number; top?: number }>;
  worst?: { d: number } | null;
}

/**
 * A link of Visibilità on a map, in plan as UISP Design shows it: the line from [from] to the AP
 * (p.ap.lat/lon) and its first Fresnel zone (real shape, drawn wider in proportion to be seen at
 * the zoom of the link), each stretch coloured by what stands in it: green clear, orange inside
 * 60% of the zone, red over the line of sight. [p] is the answer of /api/pointing/profile.
 */
export function drawFresnelLink(map: LMap, layer: Layer, from: LatLon, p: FresnelProfile, fitOptions: Record<string, unknown> = {}) {
  const L = leaflet();
  layer.clearLayers();
  const D = p.distanceM;
  const lambda = 299.79 / (p.frequencyMhz || 5600);
  const [la, lo] = from;
  const brg = (Math.atan2((p.ap.lon - lo) * Math.cos((la * Math.PI) / 180), p.ap.lat - la) * 180) / Math.PI;
  const at = (d: number): LatLon => [la + ((p.ap.lat - la) * d) / D, lo + ((p.ap.lon - lo) * d) / D];
  const pts = p.chart.map((q) => {
    const r = Math.sqrt((lambda * q.d * Math.max(0, D - q.d)) / D);
    const top = Math.max(q.ground, q.top ?? q.ground);
    const clear = q.los - top;
    return { ...q, r, status: (clear < 0 ? 'bad' : clear < 0.6 * r ? 'warn' : 'good') as 'bad' | 'warn' | 'good' };
  });
  const bounds = L.latLngBounds([from, [p.ap.lat, p.ap.lon]]).pad(0.2);
  const zoom = Math.min(16, map.getBoundsZoom(bounds));
  const mpp = (40075016.686 * Math.cos((la * Math.PI) / 180)) / 2 ** (zoom + 8);
  const k = Math.max(1, (9 * mpp) / Math.max(...pts.map((q) => q.r), 0.1));
  const left = pts.map((q) => towards(...at(q.d), brg - 90, q.r * k));
  const right = pts.map((q) => towards(...at(q.d), brg + 90, q.r * k));
  L.polygon([...left, ...right.reverse()], { color: '#38bdf8', weight: 1, fillColor: '#38bdf8', fillOpacity: 0.12, interactive: false }).addTo(layer);
  const COLOR = { good: '#16a34a', warn: '#f59e0b', bad: '#dc2626' };
  let run = [pts[0]!];
  const flush = () =>
    run.length > 1 &&
    L.polyline(
      run.map((q) => at(q.d)),
      { color: COLOR[run[1]!.status], weight: 5, opacity: 0.9, interactive: false },
    ).addTo(layer);
  for (const q of pts.slice(1)) {
    run.push(q);
    if (q.status !== run[run.length - 2]!.status) {
      flush();
      run = [q];
    }
  }
  flush();
  if (p.worst)
    L.circleMarker(at(p.worst.d), { radius: 6, color: '#dc2626', weight: 2, fillColor: '#fff', fillOpacity: 1 })
      .bindTooltip(`Punto critico a ${km(p.worst.d)}`)
      .addTo(layer);
  L.circleMarker([p.ap.lat, p.ap.lon], { radius: 7, color: '#0f172a', weight: 3, fillColor: '#ffffff', fillOpacity: 1, interactive: false }).addTo(layer);
  map.fitBounds(bounds, { maxZoom: 16, ...fitOptions });
}
