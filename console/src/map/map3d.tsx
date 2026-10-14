import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, session } from '../lib/api';
import type { LMap, Simulation } from './leaflet';

/**
 * 3D view of a link (admins), as in UISP Design: the coverage terrain (TINITALY where imported,
 * else SRTM) from our server, the aerial imagery of Connettori on it, the line of sight and 60%
 * of the first Fresnel zone as a tube (red where the ground, a building or the trees enter it),
 * the masts of the CPE and of the AP and the other APs around. MapLibre GL (a vendor file of the
 * server), loaded on demand; the bar, the legend and the controls around it are React.
 */

// MapLibre comes from the server's vendor files, without types
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GL = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GLMap = any;
type LatLon = [number, number];
type Feature = { type: 'Feature'; properties: Record<string, unknown>; geometry: { type: 'Polygon'; coordinates: number[][][] } };

interface AppBridge {
  CdaApp?: { on3d?: (open: boolean) => void };
  maplibregl?: GL;
}
const bridge = () => window as unknown as AppBridge;

let vendor: Promise<GL> | null = null;
/** An imagery request with no picture (204): MapLibre then draws the photo of the zoom below. */
const NO_PHOTO = 'no-photo';

function loadMapLibre(): Promise<GL> {
  vendor ??= new Promise((res, rej) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/vendor/maplibre-gl/maplibre-gl.css';
    document.head.append(css);
    const s = document.createElement('script');
    s.src = '/vendor/maplibre-gl/maplibre-gl.js';
    s.onload = () => {
      const gl = bridge().maplibregl;
      // tiles of our server need the session: cda://api/... is fetched with it
      gl.addProtocol('cda', async (params: { url: string }, ctrl: AbortController) => {
        const token = session.get()?.token;
        const r = await fetch(params.url.replace('cda://', '/'), { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: ctrl.signal });
        // no photo there (the public service often answers blank): an error, so the map keeps
        // the photo of the zoom below, enlarged, instead of a hole
        if (r.status === 204 && params.url.includes('/imagery/')) throw new Error(NO_PHOTO);
        if (!r.ok || r.status === 204) throw new Error(`HTTP ${r.status}`);
        return { data: await r.arrayBuffer() };
      });
      res(gl);
    };
    s.onerror = () => {
      vendor = null;
      rej(new Error('Vista 3D non disponibile'));
    };
    document.head.append(s);
  });
  return vendor;
}

const R = Math.PI / 180;
/** Initial bearing from a to b ([lat, lon]), degrees. */
const bearingOf = (a: LatLon, b: LatLon) => {
  const y = Math.sin((b[1] - a[1]) * R) * Math.cos(b[0] * R);
  const x = Math.cos(a[0] * R) * Math.sin(b[0] * R) - Math.sin(a[0] * R) * Math.cos(b[0] * R) * Math.cos((b[1] - a[1]) * R);
  return (Math.atan2(y, x) / R + 360) % 360;
};

export interface ChartPoint {
  d: number;
  los: number;
  ground: number;
  top?: number | null;
  fresnel60: number;
  obstacle?: string | null;
}
export interface Profile3d {
  ap: { id?: string; lat?: number | null; lon?: number | null; name?: string };
  chart: ChartPoint[];
  mountedM?: number;
  cpeHeightM?: number;
  apAntenna?: { aboveGroundM: number } | null;
}

/**
 * The link as boxes for fill-extrusion layers, heights above the ground drawn by the terrain.
 * The chart carries the ground with the earth bulge: on the flat 3D terrain the line drops by
 * the same bulge, so "above the ground" is simply line − chart ground.
 */
export function linkGeometry(from: LatLon, to: LatLon, chart: ChartPoint[]) {
  const D = chart[chart.length - 1]!.d || 1;
  const mLat = 111320;
  const mLon = 111320 * Math.cos(((from[0] + to[0]) / 2) * R);
  const east = (to[1] - from[1]) * mLon;
  const north = (to[0] - from[0]) * mLat;
  const len = Math.hypot(east, north) || 1;
  // unit vector across the link, in degrees per metre
  const across = [east / len / mLat, -north / len / mLon] as const;
  const at = (d: number): LatLon => [from[0] + ((to[0] - from[0]) * d) / D, from[1] + ((to[1] - from[1]) * d) / D];
  const polygon = (ring: number[][], props: Record<string, unknown>): Feature => ({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]!]] } });
  const quad = (d0: number, d1: number, w: number, props: Record<string, unknown>) => {
    const a = at(d0);
    const b = at(d1);
    return polygon(
      [
        [a[1] + across[1] * w, a[0] + across[0] * w],
        [b[1] + across[1] * w, b[0] + across[0] * w],
        [b[1] - across[1] * w, b[0] - across[0] * w],
        [a[1] - across[1] * w, a[0] - across[0] * w],
      ],
      props,
    );
  };
  const box = (c: LatLon, side: number, props: Record<string, unknown>) => {
    const s = side / 2;
    return polygon(
      [
        [c[1] - s / mLon, c[0] - s / mLat],
        [c[1] + s / mLon, c[0] - s / mLat],
        [c[1] + s / mLon, c[0] + s / mLat],
        [c[1] - s / mLon, c[0] + s / mLat],
      ],
      props,
    );
  };
  // widths only (heights are real): a few metres would vanish on a link of kilometres, so the
  // line, the tube and the masts are widened with the length, as on the 2D map
  const wLine = Math.max(0.7, len / 1500);
  const wTube = len / 500;
  const wMast = Math.max(2, len / 700);
  const line: Feature[] = [];
  const fresnel: Feature[] = [];
  const obstacles: Feature[] = [];
  for (let i = 0; i < chart.length - 1; i++) {
    const p = chart[i]!;
    const q = chart[i + 1]!;
    const c = (p.los - p.ground + q.los - q.ground) / 2;
    const r = Math.max(0.5, (p.los - p.fresnel60 + q.los - q.fresnel60) / 2);
    // the zone is invaded where the ground or what stands on it is above its lower edge
    const hit = [p, q].some((x) => x.d > 0 && x.d < D && Math.max(x.ground, x.top ?? -Infinity) > x.fresnel60);
    line.push(quad(p.d, q.d, wLine, { base: Math.max(0, c - 0.7), top: Math.max(0.2, c + 0.7) }));
    fresnel.push(quad(p.d, q.d, Math.max(r, wTube), { base: Math.max(0, c - r), top: Math.max(0.2, c + r), hit }));
    if (p.obstacle && p.top != null) obstacles.push(quad(p.d, q.d, 9, { base: 0, top: Math.max(1, p.top - p.ground), kind: p.obstacle }));
  }
  const first = chart[0]!;
  const last = chart[chart.length - 1]!;
  const masts = [box(from, wMast * 0.8, { base: 0, top: Math.max(1, first.los - first.ground), kind: 'cpe' }), box(to, wMast, { base: 0, top: Math.max(1, last.los - last.ground), kind: 'ap' })];
  const fc = (features: Feature[]) => ({ type: 'FeatureCollection' as const, features });
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

/** [class, text, colour] of the legend under the scene (the colour for a step of a scale). */
export type LegendItem = [cls: string, text: string, color?: string];

/** What a scene offers to the view that opens it, once the terrain is loaded. */
interface SceneTools {
  map: GLMap;
  gl: GL;
  /** A label standing on the ground at a point. */
  tag: (lat: number, lon: number, text: string, cls: string) => void;
  /** Camera on a box of [lat, lon] points, from [bearing] degrees and [pitch]. */
  fit: (pts: LatLon[], bearing: number, pitch: number, zoomUp?: number) => void;
  /** A button of the bar that moves the camera. */
  preset: (name: string, go: () => void) => void;
  /** A slider of the bar (0–100). */
  range: (label: string, value: number, onInput: (v: number) => void) => void;
}

interface SceneOptions {
  title: string;
  ariaLabel: string;
  legendItems: LegendItem[];
  center: LatLon;
  bearing: number;
  onLoad: (t: SceneTools) => void;
}

interface Pic {
  label: string;
  attribution?: string;
  minZoom?: number;
  maxNativeZoom?: number;
  parts: Array<[string, string]>;
}
interface Satellite {
  layers?: Pic[];
  terrain?: { minZoom: number; maxZoom: number; fine?: boolean };
}
interface MapConfig {
  basemap?: { tiles?: string; minZoom?: number; maxZoom?: number } | null;
}

/**
 * A full-screen 3D scene over the console: the coverage terrain from our server, the aerial
 * imagery of Connettori (one at a time, remembered), the buildings of the basemap in relief
 * (OpenStreetMap heights where mapped), sky and fog. [onLoad] adds what the scene is about.
 */
function openScene(options: SceneOptions) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    // after the event that asked for it: a root is not unmounted while it handles an event
    setTimeout(() => {
      root.unmount();
      host.remove();
    });
    // in the app: the map goes back to its size
    bridge().CdaApp?.on3d?.(false);
  };
  root.render(<Scene {...options} onClose={close} />);
  // in the app: the map takes the whole screen while the 3D view is open
  bridge().CdaApp?.on3d?.(true);
}

function Scene({ title, ariaLabel, legendItems, center, bearing, onLoad, onClose }: SceneOptions & { onClose: () => void }) {
  const stage = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState('Caricamento del terreno… La prima volta il server prepara il rilievo di questa zona: può volerci fino a un minuto, poi resta pronto.');
  const [pics, setPics] = useState<Pic[]>([]);
  const [shown, setShown] = useState(-1);
  const [presets, setPresets] = useState<Array<[string, () => void]>>([]);
  const [ranges, setRanges] = useState<Array<{ label: string; value: number; onInput: (v: number) => void }>>([]);
  const show = useRef<(i: number) => void>(() => {});

  // Esc, or another page of the console: the 3D view goes with the page it was opened from
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    window.addEventListener('hashchange', onClose);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('hashchange', onClose);
    };
  }, [onClose]);

  useEffect(() => {
    let gone = false;
    let map: GLMap = null;
    void (async () => {
      let gl: GL;
      let info: Satellite;
      let mapCfg: MapConfig | null;
      try {
        [gl, info, mapCfg] = await Promise.all([loadMapLibre(), api<Satellite>('/api/admin/map/satellite'), api<MapConfig>('/api/map/config').catch(() => null)]);
      } catch (e) {
        setStatus((e as Error).message);
        return;
      }
      if (gone || !stage.current) return;
      const t = info.terrain ?? { minZoom: 10, maxZoom: 14 };
      const dem = { type: 'raster-dem', tiles: ['cda://api/admin/map/terrain/{z}/{x}/{y}'], tileSize: 256, encoding: 'terrarium', minzoom: t.minZoom, maxzoom: t.maxZoom };
      const sources: Record<string, unknown> = { dem, shade: { ...dem } };
      const layers: Array<Record<string, unknown>> = [{ id: 'bg', type: 'background', paint: { 'background-color': '#d9dfd3' } }];
      const bm = mapCfg?.basemap;
      if (bm?.tiles) {
        sources.osm = { type: 'vector', tiles: [bm.tiles.startsWith('http') ? bm.tiles : `${location.origin}${bm.tiles}`], minzoom: bm.minZoom ?? 0, maxzoom: bm.maxZoom ?? 15, attribution: '© OpenStreetMap' };
        // the sea and the lakes under the photos: the coast tiles of the orthophotos are clear there
        layers.push({ id: 'water', type: 'fill', source: 'osm', 'source-layer': 'water', paint: { 'fill-color': '#8fb8de' } });
      }
      const all = info.layers ?? [];
      all.forEach((v, i) => {
        v.parts.forEach(([provider, part], k) => {
          sources[`img${i}_${k}`] = { type: 'raster', tiles: [`cda://api/admin/map/imagery/${provider}/${part}/{z}/{x}/{y}`], tileSize: 256, minzoom: v.minZoom ?? 0, maxzoom: v.maxNativeZoom ?? 19, ...(k === 0 ? { attribution: v.attribution } : {}) };
          layers.push({ id: `img${i}_${k}`, type: 'raster', source: `img${i}_${k}`, layout: { visibility: 'none' } });
        });
      });
      layers.push({ id: 'shade', type: 'hillshade', source: 'shade', paint: { 'hillshade-exaggeration': all.length ? 0.15 : 0.6, 'hillshade-shadow-color': '#3f3f46' } });
      // buildings of the basemap in relief: OpenStreetMap height where mapped, else 7 m (2 floors)
      if (bm?.tiles) {
        layers.push({ id: 'buildings3d', type: 'fill-extrusion', source: 'osm', 'source-layer': 'buildings', minzoom: 14, paint: { 'fill-extrusion-color': '#e7e5e4', 'fill-extrusion-height': ['coalesce', ['get', 'height'], 7], 'fill-extrusion-base': ['coalesce', ['get', 'min_height'], 0], 'fill-extrusion-opacity': 0.88 } });
      }
      setPics(all);
      const start = Math.max(0, all.findIndex((v) => v.label === remembered()));
      let current = -1;
      let ready = false;
      const about = `${info.terrain?.fine ? 'Terreno TINITALY 10 m' : 'Terreno SRTM 30 m'}${bm?.tiles ? ' · edifici OSM' : ''}${all.length ? '' : ' · nessuna foto aerea in Connettori'}`;
      // MapLibre zoom from which the chosen imagery draws (its tiles are 256 px: one level less)
      const photoZoom = () => (all[current]?.minZoom ?? 0) - 1;
      // far out the service draws nothing: the relief alone, and how to get the photo back
      const hint = () => ready && setStatus(`${about}${current >= 0 && map.getZoom() < photoZoom() ? ' · avvicinati per vedere la foto aerea' : ''}`);
      show.current = (i: number) => {
        current = i;
        setShown(i);
        hint();
        all.forEach((v, j) => v.parts.forEach((_, k) => map.setLayoutProperty(`img${j}_${k}`, 'visibility', i === j ? 'visible' : 'none')));
        // the shaded relief only without the photos (they show the relief already): one pass less on every tile
        map.setLayoutProperty('shade', 'visibility', i >= 0 ? 'none' : 'visible');
        try {
          localStorage.setItem(BASE_KEY, all[i]?.label ?? '');
        } catch {
          // private window: not remembered
        }
      };

      map = new gl.Map({
        container: stage.current,
        style: { version: 8, sources, layers, terrain: { source: 'dem', exaggeration: 1 }, sky: { 'sky-color': '#7fb2e5', 'horizon-color': '#dbe9f6', 'fog-color': '#e8eef4', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.85 } },
        center: [center[1], center[0]],
        zoom: 13,
        pitch: 60,
        bearing,
        // above 75° the horizon brings in hundreds of far tiles for a few pixels: the main cost of a tilted view
        maxPitch: 75,
        // sharp enough on high-density screens without drawing four times the pixels
        pixelRatio: Math.min(window.devicePixelRatio || 1, 1.5),
        fadeDuration: 0,
        renderWorldCopies: false,
        attributionControl: { compact: true },
      });
      map.addControl(new gl.NavigationControl({ visualizePitch: true }), 'top-right');
      map.on('error', (e: { error?: Error }) => e?.error?.message !== NO_PHOTO && console.warn('3D', e?.error?.message ?? e));
      const tag = (lat: number, lon: number, text: string, cls: string) => {
        const el = document.createElement('div');
        el.className = `map3d-tag ${cls}`;
        el.textContent = text;
        new gl.Marker({ element: el, anchor: 'bottom' }).setLngLat([lon, lat]).addTo(map);
      };
      const fit = (pts: LatLon[], b: number, pitch: number, zoomUp = 0.1) => {
        const lats = pts.map((x) => x[0]);
        const lons = pts.map((x) => x[1]);
        const cam = map.cameraForBounds(
          [
            [Math.min(...lons), Math.min(...lats)],
            [Math.max(...lons), Math.max(...lats)],
          ],
          { padding: 110, bearing: b },
        );
        map.easeTo({ center: cam?.center, zoom: (cam?.zoom ?? 13) + zoomUp, bearing: b, pitch, duration: 900 });
      };
      map.on('load', () => {
        ready = true;
        if (all.length) show.current(start);
        onLoad({
          map,
          gl,
          tag,
          fit,
          preset: (name, go) => setPresets((p) => [...p, [name, go]]),
          range: (label, value, onInput) => setRanges((r) => [...r, { label, value, onInput }]),
        });
        hint();
        map.on('zoomend', hint);
        // opened from far out (a wide simulation, a zoomed-out map): close enough for the photo
        const near = () => map.getZoom() < photoZoom() && map.easeTo({ zoom: photoZoom() + 0.2, duration: 700 });
        if (map.isMoving()) map.once('moveend', near);
        else near();
      });
    })();
    return () => {
      gone = true;
      map?.remove();
    };
    // the scene is made once: its options do not change while it is open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="map3d" role="dialog" aria-label={ariaLabel}>
      <div className="map3d-bar">
        <b>{title}</b>
        <div className="map3d-views">
          {presets.map(([name, go]) => (
            <button key={name} type="button" className="small-btn" onClick={go}>
              {name}
            </button>
          ))}
        </div>
        <div className="map3d-views">
          {ranges.map((r) => (
            <label key={r.label} className="small map3d-range">
              {r.label}{' '}
              <input type="range" min={0} max={100} defaultValue={r.value} aria-label={`Intensità: ${r.label}`} title={`Intensità: ${r.label}`} onInput={(e) => r.onInput(Number(e.currentTarget.value))} />
            </label>
          ))}
        </div>
        {pics.length > 0 && (
          <select aria-label="Immagini" value={shown} onChange={(e) => show.current(Number(e.target.value))}>
            {pics.map((v, i) => (
              <option key={v.label} value={i}>
                {v.label}
              </option>
            ))}
          </select>
        )}
        <span className="small muted">{status}</span>
        <button type="button" className="map3d-close" aria-label="Chiudi" onClick={onClose}>
          ×
        </button>
      </div>
      <div ref={stage} className="map3d-stage" />
      <div className="map3d-legend small">
        {legendItems.map(([cls, text, color]) => (
          <span key={`${cls}-${text}`}>
            <i className={`sw ${cls}`} style={color ? { background: color } : undefined} />
            {text}
          </span>
        ))}
      </div>
    </div>
  );
}

const LINK_LEGEND: LegendItem[] = [
  ['los', 'linea di vista'],
  ['ok', 'Fresnel 60% libera'],
  ['bad', 'Fresnel invasa'],
];

/** The layers of a link in a scene: obstacles, masts, line of sight and the Fresnel tube. */
function addLink(map: GLMap, geo: ReturnType<typeof linkGeometry>) {
  for (const [id, data] of Object.entries({ fresnel: geo.fresnel, line: geo.line, obstacles: geo.obstacles, masts: geo.masts })) map.addSource(id, { type: 'geojson', data });
  const extr = (id: string, color: unknown, opacity: number) =>
    map.addLayer({ id, type: 'fill-extrusion', source: id, paint: { 'fill-extrusion-color': color, 'fill-extrusion-base': ['get', 'base'], 'fill-extrusion-height': ['get', 'top'], 'fill-extrusion-opacity': opacity } });
  extr('obstacles', ['match', ['get', 'kind'], 'edificio', '#9ca3af', '#15803d'], 0.85);
  extr('masts', ['match', ['get', 'kind'], 'ap', '#2563eb', '#f97316'], 1);
  extr('line', '#1d4ed8', 0.95);
  extr('fresnel', ['case', ['get', 'hit'], '#ef4444', '#38bdf8'], 0.35);
}

/** A simulation drawn on the terrain: the canvas itself (a data: URL would be fetched, which the page policy does not allow). */
function addSimulation(map: GLMap, image: HTMLCanvasElement, bounds: [LatLon, LatLon], range: SceneTools['range']) {
  const [[s, w], [n, e]] = bounds;
  map.addSource('sim', {
    type: 'canvas',
    canvas: image,
    animate: false,
    coordinates: [
      [w, n],
      [e, n],
      [e, s],
      [w, s],
    ],
  });
  // over the pictures, under the buildings
  map.addLayer({ id: 'sim', type: 'raster', source: 'sim', paint: { 'raster-opacity': 0.72, 'raster-resampling': 'linear', 'raster-fade-duration': 0 } }, map.getLayer('buildings3d') ? 'buildings3d' : undefined);
  range('Simulazione', 72, (v) => map.setPaintProperty('sim', 'raster-opacity', v / 100));
}

/**
 * Opens the 3D view of the link from [from] ([lat, lon], [label]) to the AP of the profile [p]
 * (admins: the profile carries the AP position). [others]: APs around ({ name, lat, lon }).
 */
export async function openLink3d({ from, label, p, apName, others = [] }: { from: LatLon; label?: string; p: Profile3d; apName: string; others?: Array<{ name: string; lat?: number | null; lon?: number | null }> }) {
  if (p.ap?.lat == null || p.ap.lon == null || !p.chart?.length) return;
  const to: LatLon = [p.ap.lat, p.ap.lon];
  const geo = linkGeometry(from, to, p.chart);
  const linkBearing = bearingOf(from, to);
  openScene({
    title: `3D · ${label ?? 'Punto'} → ${apName}`,
    ariaLabel: `Collegamento 3D con ${apName}`,
    legendItems: [...LINK_LEGEND, ['bld', 'edifici'], ['tree', 'alberi'], ['ap', 'AP'], ['cpe', 'CPE']],
    center: [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2],
    bearing: linkBearing - 90,
    onLoad: ({ map, tag, fit, preset }) => {
      addLink(map, geo);
      tag(from[0], from[1], `CPE ${Math.round(p.mountedM ?? p.cpeHeightM ?? 0)} m`, 'cpe');
      tag(to[0], to[1], `${apName}${p.apAntenna ? ` · ${p.apAntenna.aboveGroundM} m` : ''}`, 'ap');
      const span = Math.max(Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1])) * 1.5 + 0.02;
      const mid = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2] as const;
      others
        .filter((a): a is { name: string; lat: number; lon: number } => a.lat != null && a.lon != null && Math.abs(a.lat - to[0]) + Math.abs(a.lon - to[1]) > 2e-3 && Math.abs(a.lat - mid[0]) < span && Math.abs(a.lon - mid[1]) < span)
        .slice(0, 40)
        .forEach((a) => tag(a.lat, a.lon, a.name, 'other'));
      const towardsAp = (pt: LatLon, other: LatLon): LatLon[] => [pt, [pt[0] + (other[0] - pt[0]) * 0.35, pt[1] + (other[1] - pt[1]) * 0.35]];
      preset('Di lato', () => fit([from, to], linkBearing - 90, 62));
      preset('Dalla CPE', () => fit(towardsAp(from, to), linkBearing, 72, 0.3));
      preset('Dall’AP', () => fit(towardsAp(to, from), (linkBearing + 180) % 360, 72, 0.3));
      preset('Dall’alto', () => fit([from, to], linkBearing - 90, 0));
      fit([from, to], linkBearing - 90, 62);
    },
  });
}

/**
 * Opens the radio simulation of an AP in 3D: the coloured cells ([image]: a canvas of the cells,
 * north up, over [bounds] = [[south, west], [north, east]]) draped on the terrain with the
 * buildings in relief and the AP. [legendItems]: [class, text, colour] of the scale shown.
 */
export async function openSimulation3d({ d, image, bounds, legendItems, title }: { d: Simulation; image: HTMLCanvasElement; bounds: [LatLon, LatLon]; legendItems: LegendItem[]; title: string }) {
  const [[s, w], [n, e]] = bounds;
  const ap: LatLon = [d.ap.lat, d.ap.lon];
  const main = d.sector ? d.sector.center : 0;
  const ahead: LatLon = [ap[0] + (Math.cos((main * Math.PI) / 180) * (n - s)) / 3, ap[1] + (Math.sin((main * Math.PI) / 180) * (e - w)) / 3];
  openScene({
    title,
    ariaLabel: title,
    legendItems,
    center: ap,
    bearing: main,
    onLoad: ({ map, tag, fit, preset, range }) => {
      addSimulation(map, image, bounds, range);
      tag(ap[0], ap[1], d.ap.name, 'ap');
      // the camera on the coloured cells (the computed radius goes farther than the coverage)
      const lit = (d.cells ?? []).filter((c): c is typeof c & { lat: number; lon: number } => c.lat != null && c.lon != null && c.dbm >= (d.minDbm ?? -80) - 15);
      const all: LatLon[] = lit.length
        ? [
            [Math.min(...lit.map((c) => c.lat)), Math.min(...lit.map((c) => c.lon))],
            [Math.max(...lit.map((c) => c.lat)), Math.max(...lit.map((c) => c.lon))],
          ]
        : [
            [s, w],
            [n, e],
          ];
      preset('Dall’AP', () => fit([ap, ahead], main, 70, 0.4));
      preset('Verso l’AP', () => fit(all, (main + 180) % 360, 62));
      preset('Dall’alto', () => fit(all, 0, 0));
      fit(all, (main + 180) % 360, 58);
    },
  });
}

export interface Area3dExtras {
  aps?: Array<{ id?: string; name: string; lat?: number | null; lon?: number | null }>;
  sim?: { d: Simulation; image: HTMLCanvasElement; bounds: [LatLon, LatLon]; legendItems: LegendItem[]; title: string } | null;
  link?: { from: LatLon; label?: string; p: Profile3d; apName: string } | null;
}

/**
 * The area a 2D map shows, in 3D (the "3D" button of the admin maps): same centre and scale,
 * tilted; the APs of the view as tags and, when the page has them, the simulation drawn on the
 * map and the link being checked ([extras], given by the page: map.cda3d).
 */
export async function openArea3d({ map: m2d, extras = {} }: { map: LMap; extras?: Area3dExtras }) {
  const c = m2d.getCenter();
  const b = m2d.getBounds();
  const { aps = [], sim = null, link = null } = extras;
  const legend = sim?.legendItems ?? (link ? LINK_LEGEND : []);
  openScene({
    title: `3D · ${sim?.title ?? (link ? `${link.label ?? 'Punto'} → ${link.apName}` : 'zona della mappa')}`,
    ariaLabel: 'Vista 3D della mappa',
    legendItems: [...legend, ['ap', 'AP']],
    center: [c.lat, c.lng],
    bearing: 0,
    onLoad: ({ map, tag, fit, preset, range }) => {
      if (sim) addSimulation(map, sim.image, sim.bounds, range);
      if (link?.p?.ap?.lat != null && link.p.ap.lon != null && link.p.chart?.length) {
        addLink(map, linkGeometry(link.from, [link.p.ap.lat, link.p.ap.lon], link.p.chart));
        tag(link.from[0], link.from[1], `CPE ${Math.round(link.p.mountedM ?? link.p.cpeHeightM ?? 0)} m`, 'cpe');
      }
      // the APs inside the view (at most 80, the link's AP first)
      const inView = aps.filter((a): a is typeof a & { lat: number; lon: number } => a.lat != null && a.lon != null && b.contains([a.lat, a.lon])).slice(0, 80);
      for (const a of inView) tag(a.lat, a.lon, a.name, link && a.id === link.p?.ap?.id ? 'ap' : 'other');
      const all: LatLon[] = [
        [b.getSouth(), b.getWest()],
        [b.getNorth(), b.getEast()],
      ];
      preset('Da sud', () => fit(all, 0, 62));
      preset('Da nord', () => fit(all, 180, 62));
      preset('Dall’alto', () => fit(all, 0, 0));
      // the same scale as the 2D map (MapLibre counts 512 px tiles: one zoom level less), tilted
      map.jumpTo({ center: [c.lng, c.lat], zoom: Math.max(1, m2d.getZoom() - 1), pitch: 60, bearing: 0 });
    },
  });
}
