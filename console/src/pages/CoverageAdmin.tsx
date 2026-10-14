import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { toast } from '../../../web/js/dom.js';
import { drawFresnelLink, legend, pointPicker, simulationOverlay, towards, MAP_COLORS as C } from '../../../web/js/map.js';
import { openLink3d, openSimulation3d } from '../../../web/js/map3d.js';
import { ALT_FROM, bearing, DECLINATION_DEG, LinkFacts, MAX_MAST_M, parseCoords, ProfileChart, SignalBar } from '../coverage/link';
import { type Ap, dec, EstimateCell, km, LoadCell, RATING, type Tone } from '../coverage/parts';
import { AccuracyTab, AntennasTab, TerrainTab } from '../coverage/Tools';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { type Leaflet, type LMap, MapView, mapPopup } from '../map/MapView';
import { AsyncButton, Badge, Button, Card, Dom, Field, Icon, Notice, PageHeader, Segmented, Skeleton } from '../ui';

/**
 * Copertura for admins: every AP on the map, one search box (address, coordinates, AP name or a
 * click on the map), the APs ranked for the point, the link to one of them docked on the map (as in
 * UISP Design) and a radio simulation of each AP. The tools under the map (reliability of the
 * estimate, terrain and obstacles, antennas of the APs) are in coverage/Tools.tsx.
 */

const STATE_COLOR: Record<string, string> = { ok: '#14b8a6', degraded: '#f59e0b', down: '#dc2626' };
const RATING_COLOR: Record<string, string> = { buono: '#16a34a', possibile: '#f59e0b', 'senza stima': '#64748b', improbabile: '#dc2626', 'non attivo': '#dc2626' };
/** Signal scale of the simulation, from excellent to unusable. */
const SCALE: Array<[number, string, string]> = [
  [-60, '#15803d', 'oltre −60 dBm'],
  [-65, '#22c55e', '−60…−65'],
  [-70, '#a3e635', '−65…−70'],
  [-75, '#facc15', '−70…−75'],
  [-80, '#f97316', '−75…−80'],
  [-999, '#dc2626', 'sotto −80'],
];
const scaleColor = (dbm: number) => SCALE.find(([min]) => dbm >= min)![1];
/** Capacity scale of the simulation (downlink of the radio link), Mbit/s. */
const CAP_SCALE: Array<[number, string, string]> = [
  [150, '#15803d', 'oltre 150 Mbit/s'],
  [100, '#22c55e', '100–150'],
  [50, '#a3e635', '50–100'],
  [25, '#facc15', '25–50'],
  [10, '#f97316', '10–25'],
  [-1, '#dc2626', 'sotto 10'],
];
const capColor = (mbps: number) => CAP_SCALE.find(([min]) => mbps >= min)![1];
const ERR_COLOR = (e: number) => (Math.abs(e) <= 6 ? '#16a34a' : Math.abs(e) <= 12 ? '#f59e0b' : '#dc2626');
const KO: Record<string, string> = { no_signal: 'nessun segnale', no_link: 'non si aggancia', obstacles: 'ostacoli' };
const MODE_NAME: Record<string, string> = { dbm: 'segnale', cap: 'capacità del collegamento', eve: 'velocità la sera' };
const VERDICT: Record<string, [string, Tone]> = { buono: ['Copertura probabile', 'good'], possibile: ['Copertura da verificare', 'warn'] };
const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const fail = (e: unknown) => toast((e as Error).message, 'bad');

type Mode = 'dbm' | 'cap' | 'eve';
interface Cell {
  dbm: number;
  cap?: number | null;
  blocked?: boolean;
}
interface Sim {
  ap: { name: string; lat: number; lon: number };
  cells: Cell[];
  minDbm: number;
  radiusM: number;
  theoretical?: boolean;
  customers?: number;
  ignored?: number;
  capacity?: boolean;
  eveningShare?: number | null;
  cpe?: { name: string } | null;
  sector?: { center: number; width: number } | null;
  servedM?: number | null;
  antenna?: unknown;
  terrain?: boolean;
  load?: Parameters<typeof LoadCell>[0]['l'];
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Profile = any;
interface Point {
  la: number;
  lo: number;
  label: string;
}
interface AdminResult {
  aps: Ap[];
  cpeModels?: Array<{ id: string; name: string; gainDbi: number }>;
  hiddenWeak?: number;
  hideBelowDbm?: number;
  maxKm: number;
  inRange: number;
  minSignalDbm: number;
  goodSignalDbm?: number;
}
interface NetAp {
  id: string;
  name: string;
  ssid?: string | null;
  model?: string | null;
  state: string;
  lat?: number | null;
  lon?: number | null;
  pop: string | null;
}
interface Ctl {
  map: LMap;
  L: Leaflet;
  sim: Leaflet;
  base: Leaflet;
  point: Leaflet;
  link: Leaflet;
  real: Leaflet;
  ko: Leaflet;
  picker: { set: (la: number, lo: number, layer: unknown) => Leaflet; arm: () => void };
}

/** Usable cell of a simulation: below the minimum by more than 5 dB, or hidden by a hill under it, stays empty. */
const usable = (d: Sim) => (c: Cell) => c.dbm >= d.minDbm - 5 && !(c.blocked && c.dbm < d.minDbm);
const scaleFor = (d: Sim, mode: Mode) => (mode === 'dbm' ? SCALE.filter(([min]) => min >= d.minDbm - 5) : CAP_SCALE);
const freeFresnel = (p: Profile) => (p.worst ? Math.min(100, Math.max(0, Math.round((100 * p.worst.clearanceM) / (p.worst.fresnel60M / 0.6 || 1)))) : 100);
const linkVerdict = (p: Profile): [string, Tone] => (p.verdict === 'clear' ? ['Linea libera', 'good'] : p.verdict === 'fresnel' ? ['Fresnel invasa', 'warn'] : [p.buildings ? 'Ostruita da edifici' : 'Ostruita dal terreno', 'bad']);

const TABS = [
  { value: 'accuracy' as const, label: 'Affidabilità della stima' },
  { value: 'terrain' as const, label: 'Terreno e ostacoli' },
  { value: 'antennas' as const, label: 'Antenne degli AP' },
];

export function CoverageAdmin() {
  const dockRef = useRef<HTMLDivElement>(null);
  const linkCardRef = useRef<HTMLDivElement>(null);
  const [ctl, setCtl] = useState<Ctl | null>(null);
  const [query, setQuery] = useState('');
  const [choices, setChoices] = useState<Array<{ lat: number; lon: number; label: string }> | null>(null);
  const [radius, setRadius] = useState(20);
  const [height, setHeight] = useState<string>('6');
  const [cpe, setCpe] = useState('auto');
  const [cpeModels, setCpeModels] = useState<NonNullable<AdminResult['cpeModels']>>([]);
  const [point, setPoint] = useState<Point | null>(null);
  const [result, setResult] = useState<{ r?: AdminResult; loading?: boolean; error?: string } | null>(null);
  const [link, setLink] = useState<{ p: Profile; a: Ap } | null>(null);
  const [sim, setSim] = useState<{ d?: Sim; loading?: boolean; error?: string } | null>(null);
  const [simMode, setSimMode] = useState<Mode>('dbm');
  const [showReal, setShowReal] = useState(false);
  const [showKo, setShowKo] = useState(false);
  const [tab, setTab] = useState<'accuracy' | 'terrain' | 'antennas'>('accuracy');
  const [gpsBusy, setGpsBusy] = useState(false);
  // what the map and the 3D view read without waiting for a render
  const cur = useRef({ height, cpe, radius, point, link, aps: [] as NetAp[] });
  const view3d = useRef<{ sim: Record<string, unknown> | null; link: Record<string, unknown> | null }>({ sim: null, link: null });
  const accuracy = useRef<Promise<{ points?: Array<Record<string, number & string>>; failurePoints?: Array<Record<string, string & number>> }> | null>(null);
  const handlers = useRef({ onPick: (_la: number, _lo: number) => {}, view3d: () => ({}) });

  // CPE height: starts from the default of Impostazioni server, changed for every check
  useEffect(() => {
    api<{ cpeHeightM: number }>('/api/admin/pointing/config')
      .then((c) => setHeight(String(c.cpeHeightM)))
      .catch(() => {});
  }, []);

  // every AP of the network (the same data as Stato rete)
  const net = useQuery({ queryKey: keys.network, queryFn: () => api('/api/network/status'), refetchInterval: 60_000 });
  const aps: NetAp[] = net.data
    ? [...net.data.pops.flatMap((p: { name: string; aps: NetAp[] }) => p.aps.map((a) => ({ ...a, pop: p.name }))), ...net.data.apsWithoutPop.map((a: NetAp) => ({ ...a, pop: null }))].filter((a: NetAp) => a.lat != null && a.lon != null)
    : [];
  cur.current = { height, cpe, radius, point, link, aps };
  handlers.current = {
    onPick: (la, lo) => void check(la, lo, 'Punto scelto sulla mappa'),
    view3d: () => ({ aps: cur.current.aps, sim: view3d.current.sim, link: view3d.current.link }),
  };

  // every AP on the map, with "Simula copertura" in its popup
  const fittedAps = useRef(false);
  useEffect(() => {
    if (!ctl || !net.data) return;
    ctl.base.clearLayers();
    const pts = aps.map((a) => {
      const box = document.createElement('div');
      box.append(mapPopup(a.name, a.ssid && a.ssid !== a.name ? a.ssid : null, a.pop ? `POP ${a.pop}` : 'AP senza POP', a.model));
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ui-btn ui-btn-secondary cva-popup-btn';
      btn.textContent = 'Simula copertura';
      btn.onclick = () => {
        ctl.map.closePopup();
        void simulate(a.id);
      };
      box.append(btn);
      return ctl.L.circleMarker([a.lat, a.lon], { radius: 5, color: STATE_COLOR[a.state] ?? '#64748b', weight: 2, fillOpacity: 0.85, bubblingMouseEvents: false })
        .bindTooltip(a.name)
        .bindPopup(box)
        .addTo(ctl.base);
    });
    if (pts.length && !fittedAps.current && !cur.current.point) {
      ctl.map.fitBounds(ctl.L.featureGroup(pts).getBounds().pad(0.15), { maxZoom: 14 });
      fittedAps.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctl, net.data]);

  /** The map's own layers, the point picker and the 3D button, once the map is there. */
  const onReady = (map: LMap, L: Leaflet) => {
    const group = () => L.layerGroup().addTo(map);
    const c: Ctl = { map, L, sim: group(), base: group(), point: group(), link: group(), real: L.layerGroup(), ko: L.layerGroup(), picker: null as unknown as Ctl['picker'] };
    // the first click places the point; then the map moves freely and the point is dragged
    c.picker = pointPicker(map, (la: number, lo: number) => handlers.current.onPick(la, lo));
    // the 3D button of the map: the APs, the simulation and the link shown here
    map.cda3d = () => handlers.current.view3d();
    setCtl(c);
  };

  /** Nearest APs ranked for the point, drawn on the map with the lines towards them. */
  async function check(la: number, lo: number, label: string, over: Partial<typeof cur.current> = {}) {
    const o = { ...cur.current, ...over };
    const p = { la, lo, label };
    setPoint(p);
    setResult({ loading: true });
    let r: AdminResult;
    try {
      // every AP in range, already ranked by the server (50 is its maximum)
      const hM = Number(String(o.height).replace(',', '.'));
      r = await api<AdminResult>(`/api/coverage?lat=${la}&lon=${lo}&limit=50&km=${o.radius}${hM >= 0.5 && hM <= 100 ? `&height=${hM}` : ''}&cpe=${encodeURIComponent(o.cpe)}`);
    } catch (e) {
      setResult({ error: (e as Error).message });
      return;
    }
    if (r.cpeModels?.length) setCpeModels((m) => (m.length ? m : r.cpeModels!));
    setResult({ r });
    const useful = r.aps.filter((a) => a.rating !== 'improbabile' && a.rating !== 'non attivo');
    if (ctl) {
      ctl.point.clearLayers();
      ctl.link.clearLayers();
      const layers = [ctl.picker.set(la, lo, ctl.point).bindPopup(mapPopup(label, `${la.toFixed(5)}, ${lo.toFixed(5)}`, 'Trascina il punto per spostarlo'))];
      for (const a of useful) {
        const color = RATING_COLOR[a.rating ?? ''] ?? '#64748b';
        ctl.L.polyline([[la, lo], [a.lat, a.lon]], { color, weight: a === useful[0] ? 4 : 2, dashArray: a === useful[0] ? null : '6 6', interactive: false }).addTo(ctl.point);
        layers.push(ctl.L.circleMarker([a.lat, a.lon], { radius: 7, color, weight: 3, fillOpacity: 0.2, interactive: false }).addTo(ctl.point));
      }
      ctl.map.fitBounds(ctl.L.featureGroup(layers).getBounds().pad(0.15), { maxZoom: 14 });
    }
    // the dock follows the check: the same AP again (another CPE or height), closed otherwise
    const again = o.link ? r.aps.find((x) => x.id === o.link!.a.id) : null;
    if (again) await openLink(again, { point: p, height: o.height });
    else closeLink();
  }

  /** The link from the checked point to [a] (line of sight with the CPE height), docked on the map. */
  async function openLink(a: Ap, over: { point?: Point; height?: string } = {}) {
    const o = { ...cur.current, ...over };
    if (!o.point) return;
    const hM = Number(String(o.height).replace(',', '.'));
    if (!(hM >= 0.5 && hM <= 100)) return void toast('Altezza della CPE non valida (0,5–100 m)');
    try {
      const p = await api(`/api/pointing/profile?lat=${o.point.la}&lon=${o.point.lo}&apId=${encodeURIComponent(a.id)}&height=${hM}`);
      view3d.current.link = { from: [o.point.la, o.point.lo], label: o.point.label?.split(',')[0], p, apName: a.name || a.id };
      setLink({ p, a });
    } catch (e) {
      toast(`Collegamento con ${a.name}: ${(e as Error).message}`, 'bad');
    }
  }
  function closeLink() {
    view3d.current.link = null;
    setLink(null);
    ctl?.link.clearLayers();
  }
  // the link on the map with its Fresnel zone, framed above the dock
  useEffect(() => {
    if (!ctl || !link || !point || link.p.ap.lat == null) return;
    const below = (dockRef.current?.offsetHeight ?? 0) + 24;
    drawFresnelLink(ctl.map, ctl.link, [point.la, point.lo], link.p, { paddingTopLeft: [20, 20], paddingBottomRight: [20, below] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctl, link]);

  /** Estimated signal of a new CPE all around one AP (from its customers), on the map. */
  async function simulate(apId: string) {
    setSim({ loading: true });
    setSimMode('dbm');
    try {
      const o = cur.current;
      const d = await api<Sim>(`/api/admin/coverage/simulation?apId=${encodeURIComponent(apId)}${o.cpe !== 'auto' ? `&cpe=${encodeURIComponent(o.cpe)}` : ''}`);
      setSim({ d });
      if (ctl && d.cells.length && !o.point) ctl.map.fitBounds(ctl.L.latLng(d.ap.lat, d.ap.lon).toBounds(d.radiusM * 2.1));
    } catch (e) {
      setSim({ error: (e as Error).message });
    }
  }
  // the simulation on the map: one smooth image of the usable cells, the sector and the AP
  useEffect(() => {
    if (!ctl) return;
    ctl.sim.clearLayers();
    view3d.current.sim = null;
    const d = sim?.d;
    if (!d?.cells.length) return;
    const ok = usable(d);
    const share = d.eveningShare ?? 0;
    const overlay = simulationOverlay(d, (cell: Cell) => (!ok(cell) ? null : simMode === 'cap' ? (cell.cap == null ? null : capColor(cell.cap)) : simMode === 'eve' ? (cell.cap == null ? null : capColor(cell.cap * share)) : scaleColor(cell.dbm))).addTo(ctl.sim);
    view3d.current.sim = { d, image: overlay.canvas, bounds: overlay.cellBounds, legendItems: scaleFor(d, simMode).map(([, color, text]) => ['scale', text, color]), title: `simulazione di ${d.ap.name}` };
    // learned: the area already served; theory: the sector of the antenna (azimuth from UISP)
    if (d.sector && (d.servedM || d.theoretical)) {
      const reach = d.servedM || d.radiusM;
      const pts: number[][] = [[d.ap.lat, d.ap.lon]];
      for (let i = 0; i <= 24; i++) pts.push(towards(d.ap.lat, d.ap.lon, d.sector.center - d.sector.width / 2 + (d.sector.width * i) / 24, reach));
      ctl.L.polygon(pts, { color: '#0f172a', weight: 1.5, fill: false, dashArray: '4 5', interactive: false }).addTo(ctl.sim);
    }
    ctl.L.circleMarker([d.ap.lat, d.ap.lon], { radius: 8, color: '#0f172a', weight: 3, fillColor: '#ffffff', fillOpacity: 1, interactive: false }).addTo(ctl.sim);
  }, [ctl, sim, simMode]);
  const sim3d = () => {
    const s = view3d.current.sim as { d: Sim } | null;
    if (s) void openSimulation3d({ ...(s as object), title: `3D · simulazione di ${s.d.ap.name} · ${MODE_NAME[simMode] ?? 'segnale'}` } as never);
  };

  // the model on the real customers (last Affidabilità della stima): where it gets it right, the KOs
  const accuracyData = () => (accuracy.current ??= api('/api/admin/coverage/accuracy').then((r) => r.last ?? {}));
  useEffect(() => {
    if (!ctl) return;
    let alive = true;
    ctl.real.clearLayers();
    if (!showReal) return void ctl.map.removeLayer(ctl.real);
    void accuracyData().then((acc) => {
      if (!alive) return;
      const pts = acc.points ?? [];
      if (!pts.length) toast('Nessuna misura: avvia «Affidabilità della stima» qui sotto');
      for (const q of pts) {
        const err = q.estimateDbm - q.realDbm;
        ctl.L.circleMarker([q.lat, q.lon], { radius: 4, color: ERR_COLOR(err), weight: 1, fillOpacity: 0.8, bubblingMouseEvents: false })
          .bindPopup(mapPopup(q.device, `AP ${q.ap}`, `reale ${q.realDbm} dBm · stimato ${q.estimateDbm} dBm`, `${err > 0 ? 'stima ottimista' : err < 0 ? 'stima pessimista' : 'esatta'} di ${Math.abs(err)} dB`))
          .addTo(ctl.real);
      }
      ctl.real.addTo(ctl.map);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctl, showReal]);
  useEffect(() => {
    if (!ctl) return;
    let alive = true;
    ctl.ko.clearLayers();
    if (!showKo) return void ctl.map.removeLayer(ctl.ko);
    void accuracyData().then((acc) => {
      if (!alive) return;
      for (const f of acc.failurePoints ?? []) {
        ctl.L.marker([f.lat, f.lon], { icon: ctl.L.divIcon({ className: 'ko-pin', html: '✕', iconSize: [16, 16] }) })
          .bindPopup(mapPopup('Installazione fallita', KO[f.reason] ?? f.reason, f.ap ? `verso ${f.ap}` : null, date(f.at)))
          .addTo(ctl.ko);
      }
      ctl.ko.addTo(ctl.map);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctl, showKo]);

  // the search: coordinates, the name of an AP (shown and simulated) or an address
  const search = async () => {
    const q = query.trim();
    if (!q) return;
    setChoices(null);
    const coords = parseCoords(q);
    if (coords) return check(coords[0], coords[1], 'Coordinate inserite');
    const ql = q.toLowerCase();
    const ap = aps.find((a) => a.name.toLowerCase() === ql) ?? aps.find((a) => `${a.name} ${a.ssid ?? ''}`.toLowerCase().includes(ql));
    if (ap) {
      ctl?.map.setView([ap.lat, ap.lon], 13);
      return simulate(ap.id);
    }
    const list = await api<Array<{ lat: number; lon: number; label: string }>>(`/api/geocode?q=${encodeURIComponent(q)}`);
    if (!list.length) return setChoices([]);
    if (list.length === 1) return check(list[0]!.lat, list[0]!.lon, list[0]!.label);
    setChoices(list);
  };
  const gps = () => {
    if (!('geolocation' in navigator) || !window.isSecureContext) return void toast('Il browser dà la posizione solo su HTTPS: usa l’indirizzo o le coordinate.');
    setGpsBusy(true);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setGpsBusy(false);
        void check(p.coords.latitude, p.coords.longitude, `Posizione del dispositivo (±${Math.round(p.coords.accuracy)} m)`);
      },
      (err) => {
        setGpsBusy(false);
        toast(`Posizione non disponibile: ${err.message}`);
      },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };
  // another radius or CPE: the same point again
  const recheck = (over: Partial<typeof cur.current>) => point && void check(point.la, point.lo, point.label, over);
  const changeHeight = (v: string) => {
    setHeight(v);
    recheck({ height: v });
  };
  const show3dLink = () => link && point && void openLink3d({ from: [point.la, point.lo], label: point.label?.split(',')[0], p: link.p, apName: link.a.name || link.a.id, others: aps } as never);
  // a blocked customer of Affidabilità: its point, its CPE height, then its link
  const inspect = async (b: { cpeHeightM: number; lat: number; lon: number; device: string; apId: string; ap: string }) => {
    const h = String(b.cpeHeightM);
    setHeight(h);
    const p = { la: b.lat, lo: b.lon, label: b.device };
    await check(b.lat, b.lon, b.device, { height: h, link: null });
    await openLink({ id: b.apId, name: b.ap } as Ap, { point: p, height: h });
    requestAnimationFrame(() => linkCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  return (
    <div className="ui-page">
      <PageHeader icon="explore" title="Copertura" subtitle="Verifica un punto, confronta gli AP e simula il segnale. Solo amministratori: gli installatori hanno la loro verifica, con i limiti impostati." />
      <Card title="Verifica un punto">
        <form className="cva-search" onSubmit={(e) => e.preventDefault()}>
          <label className="hl-search">
            <Icon name="search" />
            <input type="search" placeholder="Indirizzo, coordinate (37.56, 14.27) o nome di un AP" autoComplete="off" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Cerca" />
          </label>
          <AsyncButton type="submit" variant="primary" onClick={search} onError={fail}>
            Cerca
          </AsyncButton>
          <Button icon="my_location" busy={gpsBusy} onClick={gps}>
            La mia posizione
          </Button>
        </form>
        {choices &&
          (choices.length ? (
            <div className="ui-row">
              {choices.map((c) => (
                <Button key={`${c.lat},${c.lon}`} onClick={() => (setChoices(null), void check(c.lat, c.lon, c.label))}>
                  {c.label}
                </Button>
              ))}
            </div>
          ) : (
            <Notice tone="warn">Né indirizzo né AP trovati: prova ad aggiungere comune o CAP, oppure scrivi le coordinate.</Notice>
          ))}
        <div className="ui-grid-form">
          <Field label="Cerca gli AP entro">
            <select
              value={radius}
              onChange={(e) => {
                setRadius(Number(e.target.value));
                recheck({ radius: Number(e.target.value) });
              }}
            >
              {[5, 10, 15, 20].map((n) => (
                <option key={n} value={n}>
                  entro {n} km
                </option>
              ))}
            </select>
          </Field>
          <Field label="Altezza della CPE dal suolo (m)">
            <input type="number" min="0.5" max="100" step="0.5" inputMode="decimal" value={height} onChange={(e) => setHeight(e.target.value)} onBlur={(e) => recheck({ height: e.target.value })} />
          </Field>
          <Field label="CPE da installare">
            <select
              value={cpe}
              onChange={(e) => {
                setCpe(e.target.value);
                recheck({ cpe: e.target.value });
              }}
            >
              <option value="auto">Consigliata per ogni AP</option>
              {cpeModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} · {m.gainDbi} dBi
                </option>
              ))}
            </select>
          </Field>
        </div>
        <p className="ui-muted ui-small">Scrivi un indirizzo, delle coordinate o il nome di un AP, oppure clicca sulla mappa. L’altezza della CPE vale per il collegamento di questo punto.</p>
      </Card>

      <Card
        title="Mappa della rete"
        actions={
          <>
            <label className="ui-check ui-small">
              <input type="checkbox" checked={showReal} onChange={(e) => setShowReal(e.target.checked)} /> Clienti reali: segnale vero contro stima
            </label>
            <label className="ui-check ui-small">
              <input type="checkbox" checked={showKo} onChange={(e) => setShowKo(e.target.checked)} /> Installazioni fallite
            </label>
          </>
        }
      >
        <div className="map-stage">
          <MapView tall zoom={9} fitMode="never" onReady={onReady} draw={() => []} />
          {link && point && <LinkDock link={link} point={point} cpe={cpe} cpeModels={cpeModels} height={Number(String(height).replace(',', '.'))} dockRef={dockRef} onCpe={(v) => (setCpe(v), recheck({ cpe: v }))} onHeight={changeHeight} on3d={show3dLink} onClose={closeLink} />}
        </div>
        <Dom
          make={() =>
            legend([
              [STATE_COLOR.ok, 'AP in funzione'],
              [STATE_COLOR.degraded, 'molte CPE offline'],
              [STATE_COLOR.down, 'non raggiungibile'],
              [C.point, 'punto verificato'],
              ['#16a34a', 'cliente: stima entro 6 dB'],
              ['#dc2626', 'cliente: stima sbagliata di oltre 12 dB'],
            ])
          }
        />
        <div className="cva-tools">
          <p className="ui-muted ui-small">
            {net.error
              ? `AP non disponibili: ${(net.error as Error).message}`
              : `${aps.length} AP sulla mappa. Il primo clic sulla mappa sceglie il punto da verificare; poi la mappa si sposta liberamente e il punto si sposta trascinandolo (o con Nuovo punto sulla mappa). Clic su un AP per simularne la copertura.`}
          </p>
          <Button
            icon="my_location"
            onClick={() => {
              ctl?.picker.arm();
              toast('Clicca sulla mappa nel nuovo punto');
            }}
          >
            Nuovo punto sulla mappa
          </Button>
        </div>
        {sim && <SimulationPanel sim={sim} mode={simMode} onMode={setSimMode} onClear={() => setSim(null)} on3d={sim3d} />}
      </Card>

      {result?.loading && (
        <Card>
          <Skeleton lines={4} />
        </Card>
      )}
      {result?.error && <Notice tone="bad">{result.error}</Notice>}
      {result?.r && point && <Results r={result.r} point={point} onLink={(a) => void openLink(a)} onSimulate={(id) => void simulate(id)} />}
      <div ref={linkCardRef}>{link && point && <LinkDetails link={link} point={point} on3d={show3dLink} />}</div>

      <Card>
        <Segmented label="Strumenti" options={TABS} value={tab} onChange={setTab} />
        <div className="cov-tab">{tab === 'accuracy' ? <AccuracyTab onInspect={inspect} /> : tab === 'terrain' ? <TerrainTab /> : <AntennasTab />}</div>
      </Card>
    </div>
  );
}

/** The figures of a side of the dock. */
const Fact = ({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) => (
  <div className="dock-fact">
    <small>{label}</small>
    <b>{value}</b>
    {sub ? <span>{sub}</span> : null}
  </div>
);

/** The dock: AP (what UISP says) | the link | the CPE to install (what can be changed). */
function LinkDock({
  link,
  point,
  cpe,
  cpeModels,
  height,
  onCpe,
  onHeight,
  on3d,
  onClose,
  dockRef,
}: {
  link: { p: Profile; a: Ap };
  point: Point;
  cpe: string;
  cpeModels: Array<{ id: string; name: string; gainDbi: number }>;
  height: number;
  onCpe: (v: string) => void;
  onHeight: (v: string) => void;
  on3d: () => void;
  onClose: () => void;
  dockRef: { current: HTMLDivElement | null };
}) {
  const { p, a } = link;
  const first = p.chart[0];
  const last = p.chart[p.chart.length - 1];
  const tilt = (Math.atan2(last.los - first.los, p.distanceM) * 180) / Math.PI;
  const az = p.ap.lat != null ? bearing([point.la, point.lo], [p.ap.lat, p.ap.lon]) : a.bearing;
  const e = a.estimate ?? null;
  const noise = a.load?.noiseDbm ?? null;
  const verdict = linkVerdict(p);
  const hM = height || first.los - first.ground;
  const cap = e?.capacityMbps ?? null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ap = a as any;
  return (
    <div className="link-dock" ref={dockRef}>
      <div className="dock-grid">
        <section className="dock-side">
          <div className="dock-title">
            <span className="dock-tag ap">AP</span>
            <b>{a.name || a.id}</b>
          </div>
          <div className="ui-muted ui-small">{[ap.model, a.ssid].filter(Boolean).join(' · ')}</div>
          <div className="dock-facts">
            <Fact label="Frequenza" value={ap.frequency ? `${ap.frequency} MHz` : '—'} />
            <Fact label="Clienti" value={a.stations ?? '—'} sub={a.load?.level ? `sera: ${a.load.level}` : null} />
            <Fact label="Antenna" value={p.apAntenna ? `${p.apAntenna.aboveGroundM} m` : '—'} sub={p.apAntenna ? `${p.apAntenna.altitude} m s.l.m.` : null} />
            <Fact label="Rumore" value={noise != null ? `${noise} dBm` : '—'} />
          </div>
        </section>
        <section className="dock-mid">
          <div className="dock-title">
            <Badge tone={verdict[1]}>{verdict[0]}</Badge>
            <span className="ui-muted ui-small">
              {km(p.distanceM)} · Fresnel libera {freeFresnel(p)}%
            </span>
          </div>
          <div className="dock-cap">
            <span>Capacità stimata</span>
            <b>{cap == null ? '—' : `${cap} Mbit/s`}</b>
          </div>
          {e?.eveningMbps != null && <div className="ui-muted ui-small">La sera, condivisa con gli altri clienti dell’AP: ~{e.eveningMbps} Mbit/s</div>}
          <div className="cap-bar">
            <span style={{ width: `${cap == null ? 0 : Math.min(100, (cap / 400) * 100)}%` }} />
          </div>
          {e?.signalDbm != null && noise != null && <div className="ui-muted ui-small">SNR atteso {e.signalDbm - noise} dB</div>}
          <div className="dock-chart">
            <span className="ui-muted ui-small">Zona di Fresnel, altezze dalla linea di vista</span>
            <ProfileChart p={p} view="fresnel" height={190} />
          </div>
          {p.ap.lat != null && (
            <Button variant="ghost" className="dock-3d" onClick={on3d}>
              Vista 3D
            </Button>
          )}
        </section>
        <section className="dock-side">
          <div className="dock-title">
            <span className="dock-tag cpe">CPE</span>
            <b>{point.label?.split(',')[0] ?? 'Punto'}</b>
          </div>
          <Field label="Modello">
            <select value={cpe} onChange={(ev) => onCpe(ev.target.value)}>
              <option value="auto">Consigliata per ogni AP</option>
              {cpeModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} · {m.gainDbi} dBi
                </option>
              ))}
            </select>
          </Field>
          <div className="dock-facts">
            <div className="dock-fact">
              <small>Altezza</small>
              <div className="cv-stepper">
                <button type="button" aria-label="Più bassa" onClick={() => onHeight(String(Math.max(1, Math.round(hM - 1))))}>
                  −
                </button>
                <b>{Math.round(hM)} m</b>
                <button type="button" aria-label="Più alta" onClick={() => onHeight(String(Math.min(60, Math.round(hM + 1))))}>
                  +
                </button>
              </div>
            </div>
            <Fact label="Puntamento" value={`${Math.round(az)}°`} sub={`magnetico ${Math.round((az - DECLINATION_DEG + 360) % 360)}°`} />
            <Fact label="Inclinazione" value={`${tilt >= 0 ? '+' : ''}${dec(tilt)}°`} />
          </div>
          {p.roofM ? (
            <div className="ui-muted ui-small">
              Sul tetto: edificio di {p.roofM} m, antenna a {dec(p.mountedM)} m dal suolo
            </div>
          ) : p.mountedM > hM + 0.4 ? (
            <div className="ui-muted ui-small">Sopra gli ostacoli vicini: antenna a {dec(p.mountedM)} m dal suolo</div>
          ) : null}
          <SignalBar e={e} />
        </section>
      </div>
      <button type="button" className="cx-icon-btn dock-close" aria-label="Chiudi" onClick={onClose}>
        <Icon name="close" />
      </button>
    </div>
  );
}

/** The link in detail under the map: figures, the critical point, the profile and its legend. */
function LinkDetails({ link, point, on3d }: { link: { p: Profile; a: Ap }; point: Point; on3d: () => void }) {
  const { p, a } = link;
  const verdict: [string, Tone] = p.verdict === 'clear' ? ['Visibilità libera', 'good'] : p.verdict === 'fresnel' ? ['Linea libera ma zona di Fresnel invasa', 'warn'] : [p.buildings ? 'Linea ostruita da edifici' : 'Linea ostruita dal terreno', 'bad'];
  return (
    <Card
      title={`Collegamento con ${a.name}`}
      actions={
        <>
          <Badge tone={verdict[1]}>{verdict[0]}</Badge>
          {p.ap.lat != null && <Button onClick={on3d}>Vista 3D</Button>}
        </>
      }
    >
      <LinkFacts p={p} from={[point.la, point.lo]} estimate={a.estimate} />
      <p className="ui-small cva-p">
        {p.worst
          ? `Punto critico a ${km(p.worst.d)}: margine ${dec(p.worst.clearanceM)} m sulla linea di vista (per il 60% della zona di Fresnel ne servono ${dec(p.worst.fresnel60M)}).`
          : 'Linea di vista e zona di Fresnel libere su tutto il collegamento.'}
        {p.verdict === 'clear' || !(p.raiseCpeM > 0) ? '' : p.raiseCpeM <= MAX_MAST_M ? ` Alzando la CPE di ${dec(p.raiseCpeM)} m si libera.` : ` Non basta un palo di ${MAX_MAST_M} m: scegli un altro AP.`}
      </p>
      {p.apAntenna && (
        <p className="ui-small cva-p">
          Antenna dell’AP a {p.apAntenna.altitude} m s.l.m., {p.apAntenna.aboveGroundM} m sopra il suolo: {ALT_FROM[p.apAntenna.from as keyof typeof ALT_FROM] ?? 'altezza predefinita'}
          {p.apAntenna.reported !== null ? ` (in UISP: ${p.apAntenna.reported} m)` : ''}. Se l’antenna è più alta, correggi l’altitudine in UISP.
        </p>
      )}
      {p.ap.lat != null && <p className="ui-muted ui-small">Sulla mappa: il collegamento e la sua prima zona di Fresnel (allargata per essere visibile, la forma è quella reale), verde dove è libera, arancione dove terreno o ostacoli entrano nel 60% della zona, rosso dove coprono la linea di vista.</p>}
      <LinkCharts p={p} />
      <p className="ui-muted ui-small">
        {p.terrainSource === 'tinitaly'
          ? 'Terreno TINITALY (10 m); edifici dalle sagome di OpenStreetMap e alberi con la loro altezza dove importati (Terreno e ostacoli), altrimenti dalla mappa ESA con le altezze medie. Cambia l’altezza della CPE e il collegamento si aggiorna.'
          : 'Modello del terreno SRTM (circa 30 m): qui non sono scaricati terreno a 10 m, edifici e alberi. Cambia l’altezza della CPE e il collegamento si aggiorna.'}
      </p>
    </Card>
  );
}

/**
 * The two drawings of a link: the terrain along it (hills, buildings, trees) and the Fresnel zone,
 * measured from the line of sight on its own scale (on the terrain's scale it is a thin line).
 */
export function LinkCharts({ p }: { p: Profile }) {
  return (
    <div className="lk-charts">
      <figure>
        <figcaption>Profilo del terreno</figcaption>
        <ProfileChart p={p} view="full" height={260} />
      </figure>
      <figure>
        <figcaption>Zona di Fresnel: altezze misurate dalla linea di vista (0 m)</figcaption>
        <ProfileChart p={p} view="fresnel" height={220} />
      </figure>
        <Dom
          make={() =>
            legend([
              ['#a8a29e', 'terreno (con la curvatura terrestre)'],
              ['#78716c', 'edifici'],
              ['#4d7c0f', 'alberi'],
              ['#2563eb', 'linea di vista'],
              ['#38bdf8', 'prima zona di Fresnel'],
              ['#f59e0b', 'limite del 60%'],
            ])
          }
        />
    </div>
  );
}

/** The radio simulation of one AP: what is drawn on the map, the figures and how to read them. */
function SimulationPanel({ sim, mode, onMode, onClear, on3d }: { sim: { d?: Sim; loading?: boolean; error?: string }; mode: Mode; onMode: (m: Mode) => void; onClear: () => void; on3d: () => void }) {
  if (sim.loading) return <Skeleton lines={3} />;
  if (sim.error) return <Notice tone="bad">{sim.error}</Notice>;
  const d = sim.d!;
  if (!d.cells.length) {
    return (
      <Notice tone="warn">
        {d.ap.name}: simulazione non possibile, {d.customers ? 'troppo pochi clienti con segnale e posizione' : 'nessun cliente con posizione'} per stimare il segnale.{' '}
        <Button variant="ghost" onClick={onClear}>
          Togli simulazione
        </Button>
      </Notice>
    );
  }
  const n = d.cells.length;
  const good = d.cells.filter((c) => c.dbm >= d.minDbm).length;
  const fast = d.cells.filter((c) => c.dbm >= d.minDbm && (c.cap ?? 0) >= 50).length;
  const evening = d.eveningShare != null ? d.cells.filter((c) => c.dbm >= d.minDbm && (c.cap ?? 0) * d.eveningShare! >= 30).length : null;
  const modes: Array<{ value: Mode; label: string }> = [{ value: 'dbm', label: 'Segnale' }, ...(d.capacity ? [{ value: 'cap' as const, label: 'Capacità' }] : []), ...(d.capacity && d.eveningShare != null ? [{ value: 'eve' as const, label: 'Velocità la sera' }] : [])];
  return (
    <div className="sim-info cva-sim">
      <div className="cva-sim-head">
        <strong>
          Simulazione {d.theoretical ? 'teorica ' : ''}di {d.ap.name}
          {d.cpe ? ` con ${d.cpe.name}` : ''}
        </strong>
        <span className="ui-row">
          <Button onClick={on3d}>Vista 3D</Button>
          <Button variant="ghost" onClick={onClear}>
            Togli simulazione
          </Button>
        </span>
      </div>
      <div className="cov-figures">
        <div className="cov-figure">
          <small>Sopra {d.minDbm} dBm</small>
          <b>{Math.round((100 * good) / n)}%</b>
          <span>dell’area, raggio {km(d.radiusM)}</span>
        </div>
        {d.capacity && (
          <div className="cov-figure">
            <small>Almeno 50 Mbit/s</small>
            <b>{Math.round((100 * fast) / n)}%</b>
            <span>capacità del collegamento</span>
          </div>
        )}
        {evening !== null && (
          <div className="cov-figure">
            <small>Almeno 30 Mbit/s la sera</small>
            <b>{Math.round((100 * evening) / n)}%</b>
            <span>tempo radio libero {Math.round(d.eveningShare! * 100)}%</span>
          </div>
        )}
        <div className="cov-figure">
          <small>Calibrazione</small>
          <b>{d.theoretical ? 'teorica' : d.customers}</b>
          <span>{d.theoretical ? 'nessun cliente da cui calibrare' : `${d.customers === 1 ? 'cliente' : 'clienti'}${d.ignored ? `, ${d.ignored} esclusi` : ''}`}</span>
        </div>
      </div>
      {modes.length > 1 && <Segmented label="Mostra" options={modes} value={mode} onChange={onMode} />}
      <Dom make={() => legend(scaleFor(d, mode).map(([, color, text]) => [color, text]))} deps={[d, mode]} />
      {d.load?.level && (
        <div className="ui-small">
          Carico serale dell’AP: <LoadCell l={d.load} />
        </div>
      )}
      <div className={d.theoretical ? 'ui-notice ui-tone-warn' : 'ui-muted ui-small'}>
        <div>
          Segnale atteso per una CPE nuova: potenza irradiata dell’AP e guadagno della CPE (Impostazioni server → Simulazione radio), spazio libero{d.antenna ? ', diagramma dell’antenna (azimut da UISP)' : ''}
          {d.terrain ? ', terreno, edifici e alberi tra ogni punto e l’AP (dove scaricati in Terreno e ostacoli)' : ' (terreno non disponibile: le colline non sono considerate)'}.{' '}
          {d.theoretical ? 'Stima teorica, margine ±8 dB: l’AP non ha ancora clienti con segnale da cui calibrarla.' : 'I clienti già collegati correggono la teoria, con un peso che cresce con il loro numero: pochi clienti, stima vicina alla teoria.'}
          {d.capacity ? ' Capacità: dal segnale stimato con la curva segnale → capacità delle CPE reali della rete (e di come va questo AP); è la velocità del collegamento radio, la sera condivisa con gli altri clienti dell’AP.' : ''}
          {d.eveningShare != null ? ` Velocità la sera: la capacità per la parte di tempo radio che l’AP ha libera al picco serale (${Math.round(d.eveningShare * 100)}%, mai meno della parte equa tra i suoi clienti).` : ''}
          {` Area vuota: segnale sotto ${d.minDbm - 5} dBm o AP nascosto da una collina. Colori tenui: stima poco affidabile o collina in mezzo (da verificare). Tratteggio: settore dell’antenna o area già servita. Per un punto preciso usa Collegamento.`}
          {d.antenna ? '' : ' Antenna e azimut dell’AP non sono indicati: la stima è uguale in tutte le direzioni (per questo può sembrare un cerchio). Indicali in Antenne degli AP per il fascio vero.'}
        </div>
      </div>
    </div>
  );
}

/** The answer for the point: the verdict in evidence, then the APs ranked by the server. */
function Results({ r, point, onLink, onSimulate }: { r: AdminResult; point: Point; onLink: (a: Ap) => void; onSimulate: (id: string) => void }) {
  const useful = r.aps.filter((a) => a.rating !== 'improbabile' && a.rating !== 'non attivo');
  const others = r.aps.filter((a) => !useful.includes(a));
  const best = useful[0] ?? r.aps[0];
  const [title, tone] = best ? (VERDICT[best.rating ?? ''] ?? ['Copertura improbabile', 'bad']) : ['Nessun AP', 'bad'];
  const rows = (list: Ap[]) => (
    <ul className="hl-list cv-aps">
      {list.map((a) => (
        <ApRow key={a.id} a={a} r={r} onLink={onLink} onSimulate={onSimulate} />
      ))}
    </ul>
  );
  return (
    <Card title="AP consigliati per il punto">
      <p className="ui-muted ui-small">
        {point.label} · {point.la.toFixed(5)}, {point.lo.toFixed(5)}
      </p>
      {r.aps.length ? (
        <>
          {best && (
            <div className={`cov-verdict ${tone}`}>
              <div>
                <div className="cov-verdict-title">{title}</div>
                <div>
                  Il migliore è <b>{best.name}</b>, a {km(best.distanceM)}
                  {best.estimate?.signalDbm != null ? `, segnale stimato ${best.estimate.signalDbm} dBm` : ', senza stima del segnale'}
                  {best.estimate?.eveningMbps != null ? `, la sera ~${best.estimate.eveningMbps} Mbit/s` : ''}.
                </div>
              </div>
              <div className="ui-row">
                <Button onClick={() => onLink(best)}>Collegamento</Button>
                <Button onClick={() => onSimulate(best.id)}>Simula</Button>
              </div>
            </div>
          )}
          {useful.length ? rows(useful) : <Notice tone="warn">Nessun AP utilizzabile da qui: tutti quelli nel raggio sono improbabili o spenti.</Notice>}
          {others.length > 0 && (
            <details className="ui-details cva-more">
              <summary>Altri {others.length} AP nel raggio (segnale stimato insufficiente o non attivi)</summary>
              {rows(others)}
            </details>
          )}
        </>
      ) : (
        <Notice tone="warn">
          {r.hiddenWeak
            ? `Nessun AP con segnale stimato migliore di ${r.hideBelowDbm} dBm: ${r.hiddenWeak} ${r.hiddenWeak === 1 ? 'AP più debole non mostrato' : 'AP più deboli non mostrati'} (soglia in Impostazioni server → Copertura per gli installatori, −100 = tutti).`
            : `Nessun AP con posizione entro ${r.maxKm} km da questo punto.`}
        </Notice>
      )}
      <p className="ui-muted ui-small">
        {r.inRange} AP valutati entro {r.maxKm} km{r.hiddenWeak ? `, ${r.hiddenWeak} non mostrati perché più deboli di ${r.hideBelowDbm} dBm (Impostazioni server)` : ''}
        {r.inRange - (r.hiddenWeak ?? 0) > r.aps.length ? ` (mostrati i ${r.aps.length} migliori)` : ''}, ordinati per segnale stimato (minimo per il collaudo {r.minSignalDbm} dBm). La stima viene dalle CPE già collegate a ogni AP; il collegamento usa il terreno e l’altezza della CPE indicata.
      </p>
    </Card>
  );
}

/** One AP for the point: rating, pointing, CPE, estimate and evening load; Simula and Collegamento. */
function ApRow({ a, r, onLink, onSimulate }: { a: Ap; r: AdminResult; onLink: (a: Ap) => void; onSimulate: (id: string) => void }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const freq = (a as any).frequency as number | undefined;
  return (
    <li className="hl-row cv-ap" role="button" tabIndex={0} onClick={() => onLink(a)} onKeyDown={(e) => e.key === 'Enter' && onLink(a)}>
      <div className="hl-main">
        <div className="hl-name">
          {a.rating && <Badge tone={RATING[a.rating]?.[1] ?? 'neutral'}>{RATING[a.rating]?.[0] ?? a.rating}</Badge>}
          <strong>{a.name || a.id}</strong>
          <span className="ui-muted ui-small">{[a.ssid, a.siteName].filter(Boolean).join(' · ')}</span>
        </div>
        <div className="cv-facts">
          <span>
            <span className="cv-arrow" style={{ transform: `rotate(${a.bearing}deg)` }} aria-hidden="true">
              ↑
            </span>{' '}
            {a.bearing}° {a.direction} · {km(a.distanceM)}
          </span>
          {a.stations != null && <span>{a.stations} client</span>}
          {freq ? <span>{freq} MHz</span> : null}
          {a.cpe && (
            <span>
              CPE {a.cpe.name} · {a.cpe.gainDbi} dBi{a.cpe.auto ? (a.cpe.proposed ? ' · consigliata' : ` · nessuna arriva a ${r.goodSignalDbm} dBm: di riferimento`) : ' · scelta'}
            </span>
          )}
        </div>
        <div className="cv-cells">
          <EstimateCell e={a.estimate} />
          <LoadCell l={a.load} />
        </div>
        {!!a.failures && (
          <div className="ui-small">
            {a.failures} {a.failures === 1 ? 'installazione fallita' : 'installazioni fallite'} qui vicino verso questo AP
          </div>
        )}
      </div>
      <div className="hl-actions" onClick={(e) => e.stopPropagation()}>
        <Button variant="ghost" onClick={() => onSimulate(a.id)}>
          Simula
        </Button>
        <Button variant="ghost" onClick={() => onLink(a)}>
          Collegamento
        </Button>
      </div>
    </li>
  );
}
