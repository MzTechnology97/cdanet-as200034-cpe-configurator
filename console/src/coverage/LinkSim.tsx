import { type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api';
import { drawFresnelLink, type Leaflet, type LMap } from '../map/leaflet';
import { openLink3d } from '../map/map3d';
import { AsyncButton, Badge, Button, Card, Icon, Notice } from '../ui';
import { bearing, DECLINATION_DEG, type LinkProfile, MAX_MAST_M, parseCoords, ProfileChart, SignalBar } from './link';

/**
 * Collegamento PTP A → B (titolare and Carmelo, 21/10/2026): a link between two points chosen by
 * hand, shown like the AP–customer link of Copertura. On the map A and B (dragged), the link with
 * its Fresnel zone coloured by the clearance; over the map the dock: A | the link | B, with the
 * heights, the pointing, the expected signal and modulation, the Fresnel profile and the 3D view.
 * Under the map the radio, every figure and the whole profile. Same terrain, 3D buildings and
 * trees as Visibilità; nothing of the network is needed.
 */

export interface LinkSim extends LinkProfile {
  verdict: 'clear' | 'fresnel' | 'blocked';
  raiseCpeM: number;
  a: End;
  b: End;
  terrainSource: 'tinitaly' | 'srtm';
  lossDb: number;
  /** The physics of the obstacles (Deygout and foliage): the worst case of a new link. */
  diffractionDb?: number;
  foliageM: number;
  buildings: boolean;
  radio: { eirpDbm: number; gainDbi: number; noiseDbm: number };
  estimate: Est;
  physical?: Est;
  tooFar: boolean;
}
interface Est {
  signalDbm: number;
  snrDb: number | null;
  mcs: number | null;
  label: string | null;
}
interface End {
  lat: number;
  lon: number;
  ground: number;
  heightM: number;
  mountedM: number;
  roofM: number | null;
}
type Side = 'a' | 'b';
interface MapAp {
  id?: string;
  name: string;
  lat: number;
  lon: number;
}

const ERRORS: Record<string, string> = {
  link_too_short: 'A e B sono quasi nello stesso punto.',
  link_too_long: 'Oltre 100 km: troppo lontano anche per una simulazione.',
  dem_not_configured: 'Modello del terreno non configurato sul server (Copertura → Terreno e ostacoli).',
  dem_unavailable: 'Manca il terreno su una parte del percorso.',
  invalid_position: 'Coordinate non valide.',
};
const km = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 2 : 1).replace('.', ',')} km`);
const dec = (n: number) => String(Math.round(n * 10) / 10).replace('.', ',');
const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
const dir = (deg: number) => `${Math.round(deg)}° ${DIRS[Math.round(deg / 45) % 8]}`;
const fmt = (p: [number, number]) => `${p[0].toFixed(5)}, ${p[1].toFixed(5)}`;
/** airMAX ac rate multipliers (1x…13x) of the modulations of SignalBar: 13.5 Mbit/s per stream at 40 MHz each. */
const MULT = [1, 2, 3, 4, 6, 8, 9, 10, 12, 13.33];
/** Radio rate (PHY, 2×2) and the throughput a link usually gives (about 60%), Mbit/s. */
const capacity = (mcs: number | null, widthMhz: number) => {
  if (mcs == null || mcs < 0) return null;
  const phy = Math.round(MULT[Math.min(mcs, MULT.length - 1)]! * 13.5 * 2 * (widthMhz / 40));
  return { phy, real: Math.round(phy * 0.6) };
};
const verdictOf = (d: LinkSim): [string, 'good' | 'warn' | 'bad'] =>
  d.verdict === 'clear' ? ['Visibilità libera', 'good'] : d.verdict === 'fresnel' ? ['Fresnel invasa', 'warn'] : [d.buildings ? 'Ostruita da edifici' : d.foliageM > 0 ? 'Ostruita da terreno e alberi' : 'Ostruita dal terreno', 'bad'];
const freeFresnel = (d: LinkSim) => (d.worst ? Math.min(100, Math.max(0, Math.round((100 * d.worst.clearanceM) / (d.worst.fresnel60M / 0.6 || 1)))) : 100);

/** What the 3D view of the map (and the 3D button) needs of a simulation. */
export function linkSim3d(d: LinkSim, names: Record<Side, string>) {
  return {
    from: [d.a.lat, d.a.lon] as [number, number],
    label: `A · ${names.a}`,
    apName: `B · ${names.b}`,
    ends: ['A', 'B'] as [string, string],
    p: { ap: { lat: d.b.lat, lon: d.b.lon }, chart: d.chart, mountedM: d.a.mountedM, apAntenna: { aboveGroundM: Math.round(d.b.mountedM) } },
  };
}

const Fact = ({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) => (
  <div className="dock-fact">
    <small>{label}</small>
    <b>{value}</b>
    {sub ? <span>{sub}</span> : null}
  </div>
);

export function PtpMode({
  map,
  L,
  linkLayer,
  stage,
  aps,
  point,
  onPicking,
  onResult,
  onClose,
}: {
  map: LMap | null;
  L: Leaflet | null;
  /** The layer of the map where a link with its Fresnel zone is drawn (shared with Copertura). */
  linkLayer: Leaflet | null;
  /** The map's stage: the dock goes over the map, as for an AP and a customer. */
  stage: HTMLElement | null;
  /** The APs of the network: A or B may be one of them. */
  aps: MapAp[];
  /** The point checked in Copertura, to use as A. */
  point: { la: number; lo: number; label?: string } | null;
  onPicking: (on: boolean) => void;
  /** The last simulation (for the 3D button of the map), null when cleared. */
  onResult: (d: ReturnType<typeof linkSim3d> | null) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState<Record<Side, string>>({ a: '', b: '' });
  const [names, setNames] = useState<Record<Side, string>>({ a: 'Punto A', b: 'Punto B' });
  const [h, setH] = useState<Record<Side, number>>({ a: 15, b: 15 });
  const [freq, setFreq] = useState('5600');
  const [width, setWidth] = useState('40');
  const [eirp, setEirp] = useState('');
  const [gain, setGain] = useState('');
  const [raise, setRaise] = useState(true);
  // opened with nothing chosen: the next click on the map is A, then B
  const [picking, setPicking] = useState<Side | null>('a');
  const [res, setRes] = useState<{ d?: LinkSim; error?: string; loading?: boolean } | null>(null);
  const pins = useRef<Leaflet | null>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  const pts: Record<Side, [number, number] | null> = { a: parseCoords(text.a), b: parseCoords(text.b) };
  const setEnd = (s: Side, p: [number, number] | null, name?: string) => {
    setText((t) => ({ ...t, [s]: p ? fmt(p) : '' }));
    setNames((n) => ({ ...n, [s]: name || (s === 'a' ? 'Punto A' : 'Punto B') }));
    if (p) chosen(s);
  };
  /** A or B chosen in any way: the click on the map waits for the other one, if still missing. */
  const chosen = (s: Side) => setPicking((cur) => (cur === s ? (s === 'a' && !parseCoords(text.b) ? 'b' : null) : cur));

  // the next click on the map is A or B (the check of Copertura waits)
  useEffect(() => {
    if (!map || !picking) return;
    onPicking(true);
    map.getContainer().classList.add('picking');
    const on = (e: { latlng: { lat: number; lng: number } }) => setEnd(picking, [e.latlng.lat, e.latlng.lng]);
    map.once('click', on);
    return () => {
      map.off('click', on);
      map.getContainer().classList.remove('picking');
      setTimeout(() => onPicking(false), 50);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, picking, onPicking]);

  // the link with its Fresnel zone (as an AP and a customer), A and B on top, draggable
  useEffect(() => {
    if (!map || !L || !linkLayer) return;
    pins.current ??= L.layerGroup().addTo(map);
    const g = pins.current;
    g.clearLayers();
    const d = res?.d;
    if (d && pts.a && pts.b) {
      const below = (dockRef.current?.offsetHeight ?? 0) + 24;
      drawFresnelLink(map, linkLayer, [d.a.lat, d.a.lon], { ...d, ap: { lat: d.b.lat, lon: d.b.lon } }, { paddingTopLeft: [20, 20], paddingBottomRight: [20, below] });
    } else {
      linkLayer.clearLayers();
      if (pts.a && pts.b) L.polyline([pts.a, pts.b], { color: '#2563eb', weight: 3, opacity: 0.8, dashArray: '6 6', interactive: false }).addTo(g);
    }
    for (const s of ['a', 'b'] as const) {
      const p = pts[s];
      if (!p) continue;
      const m = L.marker(p, { draggable: true, zIndexOffset: 1000, title: `${names[s]}: trascina per spostarlo`, icon: L.divIcon({ className: `ab-pin ab-pin-${s}`, html: `<span>${s.toUpperCase()}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(g);
      m.on('dragend', () => {
        const q = m.getLatLng();
        setEnd(s, [q.lat, q.lng]);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, L, linkLayer, text.a, text.b, res?.d]);
  useEffect(
    () => () => {
      pins.current?.remove();
      linkLayer?.clearLayers();
      onResult(null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const run = async () => {
    if (!pts.a || !pts.b) throw new Error('Scegli A e B sulla mappa, tra gli AP o con le coordinate');
    setRes((r) => ({ ...r, loading: true, error: undefined }));
    const q = new URLSearchParams({
      aLat: String(pts.a[0]),
      aLon: String(pts.a[1]),
      bLat: String(pts.b[0]),
      bLon: String(pts.b[1]),
      aH: String(h.a),
      bH: String(h.b),
      freq: freq || '5600',
      raise: raise ? '1' : '0',
      ...(eirp.trim() ? { eirp: eirp.trim() } : {}),
      ...(gain.trim() ? { gain: gain.trim() } : {}),
    });
    try {
      const d = await api<LinkSim>(`/api/coverage/link?${q}`);
      setRes({ d });
      onResult(linkSim3d(d, names));
    } catch (e) {
      const code = (e as Error & { body?: { error?: string } }).body?.error ?? '';
      setRes({ error: ERRORS[code] ?? (e as Error).message });
      onResult(null);
    }
  };
  // a new A or B, a height or the radio changed: simulated again (a moment after the last change)
  useEffect(() => {
    if (!pts.a || !pts.b || picking) return;
    const t = setTimeout(() => void run().catch(() => {}), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text.a, text.b, picking, h.a, h.b, freq, eirp, gain, raise]);

  const swap = () => {
    setText((t) => ({ a: t.b, b: t.a }));
    setNames((n) => ({ a: n.b === 'Punto B' ? 'Punto A' : n.b, b: n.a === 'Punto A' ? 'Punto B' : n.a }));
    setH((x) => ({ a: x.b, b: x.a }));
  };
  const d = res?.d;
  const sorted = [...aps].sort((x, y) => x.name.localeCompare(y.name, 'it'));
  // a line of sight cut by the terrain: the physics decides (a design, not a connected customer)
  const shown = d && d.verdict === 'blocked' && d.physical ? d.physical : d?.estimate;
  const cap = capacity(shown?.mcs ?? null, Number(width) || 40);
  const az = d ? bearing([d.a.lat, d.a.lon], [d.b.lat, d.b.lon]) : pts.a && pts.b ? bearing(pts.a, pts.b) : null;
  const tilt = d ? (Math.atan2(d.chart[d.chart.length - 1]!.los - d.chart[0]!.los, d.distanceM) * 180) / Math.PI : null;
  const show3d = () => d && void openLink3d({ ...linkSim3d(d, names), others: aps } as never);

  const side = (s: Side) => {
    const e = d?.[s];
    const a = s === 'a' ? az : az == null ? null : (az + 180) % 360;
    const t = tilt == null ? null : s === 'a' ? tilt : -tilt;
    return (
      <section className="dock-side">
        <div className="dock-title">
          <span className={`dock-tag ab-${s}`}>{s.toUpperCase()}</span>
          <b>{names[s]}</b>
        </div>
        <div className="ab-row">
          <select
            value=""
            onChange={(ev) => {
              const ap = sorted.find((x) => (x.id ?? x.name) === ev.target.value);
              if (ap) setEnd(s, [ap.lat, ap.lon], ap.name);
            }}
            aria-label={`Un AP della rete come ${s.toUpperCase()}`}
          >
            <option value="">Un AP della rete…</option>
            {sorted.map((ap) => (
              <option key={ap.id ?? ap.name} value={ap.id ?? ap.name}>
                {ap.name}
              </option>
            ))}
          </select>
          <Button variant={picking === s ? 'primary' : 'secondary'} onClick={() => setPicking(picking === s ? null : s)}>
            {picking === s ? 'Clicca sulla mappa' : 'Sulla mappa'}
          </Button>
        </div>
        {s === 'a' && point && !pts.a && (
          <Button variant="ghost" onClick={() => setEnd('a', [point.la, point.lo], point.label?.split(',')[0] || 'Punto verificato')}>
            Usa il punto verificato
          </Button>
        )}
        <div className="dock-facts">
          <div className="dock-fact">
            <small>Altezza</small>
            <div className="cv-stepper">
              <button type="button" aria-label="Più bassa" onClick={() => setH((x) => ({ ...x, [s]: Math.max(1, x[s] - 1) }))}>
                −
              </button>
              <b>{h[s]} m</b>
              <button type="button" aria-label="Più alta" onClick={() => setH((x) => ({ ...x, [s]: Math.min(200, x[s] + 1) }))}>
                +
              </button>
            </div>
          </div>
          <Fact label="Quota" value={e ? `${e.ground} m` : '—'} sub={e ? `antenna ${e.ground + Math.round(e.mountedM)} m s.l.m.` : null} />
          <Fact label="Puntamento" value={a == null ? '—' : `${Math.round(a)}°`} sub={a == null ? null : `magnetico ${Math.round((a - DECLINATION_DEG + 360) % 360)}° · ${dir(a).split(' ')[1]}`} />
          <Fact label="Inclinazione" value={t == null ? '—' : `${t >= 0 ? '+' : ''}${dec(t)}°`} />
        </div>
        {e && (e.roofM ? <div className="ui-muted ui-small">Sul tetto: edificio di {dec(e.roofM)} m, antenna a {dec(e.mountedM)} m dal suolo</div> : e.mountedM > e.heightM + 0.4 ? <div className="ui-muted ui-small">Sopra gli ostacoli vicini: antenna a {dec(e.mountedM)} m dal suolo</div> : null)}
        <div className="ui-muted ui-small ui-mono">{text[s] || 'non ancora scelto'}</div>
      </section>
    );
  };

  const dock = (
    <div className="link-dock ptp-dock" ref={dockRef}>
      <div className="dock-grid">
        {side('a')}
        <section className="dock-mid">
          <div className="dock-title">
            <span className="dock-tag ptp">PTP</span>
            {d ? <Badge tone={verdictOf(d)[1]}>{verdictOf(d)[0]}</Badge> : null}
            <span className="ui-muted ui-small">{d ? `${km(d.distanceM)} · Fresnel libera ${freeFresnel(d)}% · ${d.frequencyMhz} MHz` : picking ? `Clicca sulla mappa il punto ${picking.toUpperCase()}` : res?.loading ? 'Calcolo del profilo…' : 'Scegli A e B'}</span>
            <button type="button" className="ab-swap" onClick={swap} title="Scambia A e B" aria-label="Scambia A e B" disabled={!text.a && !text.b}>
              ⇄
            </button>
          </div>
          {res?.error && <Notice tone="bad">{res.error}</Notice>}
          {d && shown && (
            <>
              <div className="dock-cap">
                <span>Capacità stimata</span>
                <b>{cap ? `${cap.real} Mbit/s` : '—'}</b>
              </div>
              <div className="ui-muted ui-small">{cap ? `Radio ${cap.phy} Mbit/s (2×2, canale ${width} MHz): reale ~60%` : 'Nessuna modulazione: il collegamento non si aggancia'}</div>
              <div className="cap-bar">
                <span style={{ width: `${cap ? Math.min(100, (cap.real / 600) * 100) : 0}%` }} />
              </div>
              <SignalBar e={shown} />
              {d.verdict !== 'clear' && (
                <div className="ui-small ab-warn">
                  {d.raiseCpeM > 0 ? (d.raiseCpeM <= MAX_MAST_M ? `Alzando A di ${dec(d.raiseCpeM)} m si libera il 60% della zona di Fresnel.` : `Servirebbe alzare A di ${dec(d.raiseCpeM)} m: serve un punto più alto o un ripetitore.`) : ''}
                  {shown !== d.estimate ? ` Diffrazione pura ${dec(d.diffractionDb ?? 0)} dB${shown.signalDbm < -80 ? ': da non progettare così' : ''}.` : ''}
                </div>
              )}
              <div className="dock-chart">
                <span className="ui-muted ui-small">Zona di Fresnel, altezze dalla linea di vista</span>
                <ProfileChart p={d} view="fresnel" height={190} ends={['A', 'B']} />
              </div>
              <Button variant="ghost" className="dock-3d" onClick={show3d}>
                Vista 3D
              </Button>
            </>
          )}
        </section>
        {side('b')}
      </div>
      <button type="button" className="cx-icon-btn dock-close" aria-label="Chiudi il collegamento PTP" onClick={onClose}>
        <Icon name="close" />
      </button>
    </div>
  );

  return (
    <>
      {stage ? createPortal(dock, stage) : dock}
      <Card
        title="Collegamento PTP A → B"
        actions={
          <div className="ui-row">
            {d && <Badge tone={verdictOf(d)[1]}>{verdictOf(d)[0]}</Badge>}
            <Button icon="explore" disabled={!d} onClick={show3d}>
              Vista 3D
            </Button>
          </div>
        }
      >
        <p className="ui-muted ui-small cn-p">Due punti qualsiasi, come un AP e un cliente: terreno, edifici 3D e alberi come in Visibilità. A e B si scelgono sulla mappa (e si trascinano), tra gli AP o con le coordinate; altezze, frequenza e potenza si cambiano e la simulazione riparte da sola.</p>
        <div className="ui-grid-form">
          {(['a', 'b'] as const).map((s) => (
            <label className="ui-field" key={s}>
              <span className="ui-field-label">Coordinate di {s.toUpperCase()}</span>
              <input
                className="ui-mono"
                value={text[s]}
                onChange={(e) => {
                  setText((t) => ({ ...t, [s]: e.target.value }));
                  setNames((n) => ({ ...n, [s]: s === 'a' ? 'Punto A' : 'Punto B' }));
                  if (parseCoords(e.target.value)) chosen(s);
                }}
                placeholder="37.56, 14.27"
                spellCheck={false}
              />
            </label>
          ))}
          <label className="ui-field">
            <span className="ui-field-label">Frequenza (MHz)</span>
            <input type="number" min={2400} max={6200} step={5} value={freq} onChange={(e) => setFreq(e.target.value)} />
          </label>
          <label className="ui-field">
            <span className="ui-field-label">Canale (MHz)</span>
            <select value={width} onChange={(e) => setWidth(e.target.value)}>
              {['10', '20', '40', '80'].map((w) => (
                <option key={w} value={w}>
                  {w} MHz
                </option>
              ))}
            </select>
          </label>
          <label className="ui-field">
            <span className="ui-field-label">EIRP di A (dBm)</span>
            <input type="number" min={0} max={60} value={eirp} onChange={(e) => setEirp(e.target.value)} placeholder="quella degli AP" />
          </label>
          <label className="ui-field">
            <span className="ui-field-label">Guadagno antenna B (dBi)</span>
            <input type="number" min={0} max={40} value={gain} onChange={(e) => setGain(e.target.value)} placeholder="quello della CPE" />
          </label>
        </div>
        <label className="ui-check">
          <input type="checkbox" checked={raise} onChange={(e) => setRaise(e.target.checked)} />
          Antenne sopra tetti e alberi intorno (come si montano)
        </label>
        <div className="ui-row">
          <AsyncButton variant="primary" onClick={run} onError={(e) => setRes({ error: (e as Error).message })} disabled={!pts.a || !pts.b}>
            Simula
          </AsyncButton>
          <Button
            variant="ghost"
            onClick={() => {
              setEnd('a', null);
              setEnd('b', null);
              setRes(null);
              onResult(null);
              setPicking('a');
            }}
          >
            Ricomincia
          </Button>
        </div>
        {d && shown && (
          <>
            <div className="link-facts">
              <div className="link-fact">
                <small>Distanza</small>
                <strong>{km(d.distanceM)}</strong>
              </div>
              <div className="link-fact">
                <small>Segnale atteso in B</small>
                <strong>{shown.signalDbm} dBm</strong>
                <span className="ui-small ui-muted">{shown === d.estimate ? `EIRP ${d.radio.eirpDbm} dBm · antenna ${d.radio.gainDbi} dBi` : `diffrazione pura · come Copertura ${d.estimate.signalDbm} dBm`}</span>
              </div>
              <div className="link-fact">
                <small>Perdita stimata (come Copertura)</small>
                <strong>{dec(d.lossDb)} dB</strong>
                <span className="ui-small ui-muted">{[d.buildings ? 'edifici' : null, d.foliageM > 0 ? `${Math.round(d.foliageM)} m di alberi` : null].filter(Boolean).join(' · ') || (d.lossDb > 0 ? 'il terreno' : 'nessun ostacolo')}</span>
              </div>
              {d.diffractionDb != null && d.verdict !== 'clear' && (
                <div className="link-fact">
                  <small>Diffrazione pura</small>
                  <strong>{dec(d.diffractionDb)} dB</strong>
                  <span className="ui-small ui-muted">{d.physical ? `segnale ${d.physical.signalDbm} dBm` : 'fisica degli ostacoli'}</span>
                </div>
              )}
              <div className="link-fact">
                <small>Fresnel libera</small>
                <strong>{freeFresnel(d)}%</strong>
                <span className="ui-small ui-muted">{d.worst ? `nel punto critico, a ${km(d.worst.d)}` : 'su tutto il collegamento'}</span>
              </div>
              {d.tooFar && (
                <div className="link-fact">
                  <small>Distanza</small>
                  <strong>oltre 20 km</strong>
                  <span className="ui-small ui-muted">poco realistico per l’airMAX</span>
                </div>
              )}
            </div>
            <ProfileChart p={d} view="full" height={260} ends={['A', 'B']} />
            <p className="ui-muted ui-small cn-p">
              Terreno {d.terrainSource === 'tinitaly' ? 'TINITALY 10 m' : 'SRTM 30 m'}, edifici 3D e alberi dove importati. Il segnale usa la perdita empirica della Copertura (come UISP Design); con la linea ostruita dal terreno conta la diffrazione pura, il caso peggiore da usare per progettare. Capacità: modulazione attesa su airMAX ac 2×2 nel canale scelto, circa il 60% della velocità radio. Rumore {d.radio.noiseDbm} dBm: una stima, non una misura.
            </p>
          </>
        )}
      </Card>
    </>
  );
}
