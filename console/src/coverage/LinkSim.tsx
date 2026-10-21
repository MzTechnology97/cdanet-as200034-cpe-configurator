import { type ReactNode, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import type { Leaflet, LMap } from '../map/leaflet';
import { AsyncButton, Badge, Button, Card, Field, Notice } from '../ui';
import { bearing, type LinkProfile, MAX_MAST_M, parseCoords, ProfileChart, SignalBar } from './link';

/**
 * Simulazione A → B (titolare and Carmelo, 21/10/2026): a link between two points chosen by hand on
 * the map of Copertura (or typed), with the same terrain, 3D buildings and trees of Visibilità: the
 * profile with the Fresnel zone and the obstacles, the loss, the expected signal and modulation.
 * Nothing of the network is needed: two points, two heights, the radio.
 */

interface LinkSim extends LinkProfile {
  verdict: 'clear' | 'fresnel' | 'blocked';
  raiseCpeM: number;
  a: End;
  b: End;
  terrainSource: 'tinitaly' | 'srtm';
  lossDb: number;
  foliageM: number;
  buildings: boolean;
  radio: { eirpDbm: number; gainDbi: number; noiseDbm: number };
  estimate: { signalDbm: number; snrDb: number | null; mcs: number | null; label: string | null };
  tooFar: boolean;
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

export function LinkSimCard({ map, L, onPicking }: { map: LMap | null; L: Leaflet | null; onPicking: (on: boolean) => void }) {
  const [text, setText] = useState<Record<Side, string>>({ a: '', b: '' });
  const [h, setH] = useState<Record<Side, string>>({ a: '6', b: '15' });
  const [freq, setFreq] = useState('5600');
  const [eirp, setEirp] = useState('');
  const [gain, setGain] = useState('');
  const [raise, setRaise] = useState(true);
  const [picking, setPicking] = useState<Side | null>(null);
  const [res, setRes] = useState<{ d?: LinkSim; error?: string; loading?: boolean } | null>(null);
  const layer = useRef<Leaflet | null>(null);
  const pts: Record<Side, [number, number] | null> = { a: parseCoords(text.a), b: parseCoords(text.b) };

  // the next click on the map is A or B (the check of Copertura waits)
  useEffect(() => {
    if (!map || !picking) return;
    onPicking(true);
    map.getContainer().classList.add('picking');
    const on = (e: { latlng: { lat: number; lng: number } }) => {
      setText((t) => ({ ...t, [picking]: fmt([e.latlng.lat, e.latlng.lng]) }));
      setPicking(null);
    };
    map.once('click', on);
    return () => {
      map.off('click', on);
      map.getContainer().classList.remove('picking');
      // the click that picked A or B is not a point of Copertura
      setTimeout(() => onPicking(false), 50);
    };
  }, [map, picking, onPicking]);

  // A, B and the line between them on the map; dragging A or B moves it
  useEffect(() => {
    if (!map || !L) return;
    layer.current ??= L.layerGroup().addTo(map);
    const g = layer.current;
    g.clearLayers();
    const color = res?.d ? (res.d.verdict === 'clear' ? '#16a34a' : res.d.verdict === 'fresnel' ? '#d97706' : '#dc2626') : '#2563eb';
    if (pts.a && pts.b) L.polyline([pts.a, pts.b], { color, weight: 4, opacity: 0.85, dashArray: res?.d ? undefined : '6 6', interactive: false }).addTo(g);
    for (const s of ['a', 'b'] as const) {
      const p = pts[s];
      if (!p) continue;
      const m = L.marker(p, { draggable: true, title: `Punto ${s.toUpperCase()}: trascina per spostarlo`, icon: L.divIcon({ className: 'ab-pin', html: `<span>${s.toUpperCase()}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] }) }).addTo(g);
      m.on('dragend', () => {
        const q = m.getLatLng();
        setText((t) => ({ ...t, [s]: fmt([q.lat, q.lng]) }));
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, L, text.a, text.b, res?.d?.verdict]);
  useEffect(() => () => layer.current?.remove(), []);

  const run = async () => {
    if (!pts.a || !pts.b) throw new Error('Scegli A e B sulla mappa o scrivi le coordinate');
    setRes({ loading: true });
    const q = new URLSearchParams({
      aLat: String(pts.a[0]),
      aLon: String(pts.a[1]),
      bLat: String(pts.b[0]),
      bLon: String(pts.b[1]),
      aH: h.a || '6',
      bH: h.b || '15',
      freq: freq || '5600',
      raise: raise ? '1' : '0',
      ...(eirp.trim() ? { eirp: eirp.trim() } : {}),
      ...(gain.trim() ? { gain: gain.trim() } : {}),
    });
    try {
      setRes({ d: await api<LinkSim>(`/api/coverage/link?${q}`) });
    } catch (e) {
      const code = (e as Error & { body?: { error?: string } }).body?.error ?? '';
      setRes({ error: ERRORS[code] ?? (e as Error).message });
    }
  };
  // a new A or B (picked, dragged or typed): simulated again at once
  useEffect(() => {
    if (pts.a && pts.b && !picking) void run().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text.a, text.b]);

  const d = res?.d;
  const side = (s: Side, label: string) => (
    <div className="ab-side">
      <Field label={`Punto ${label}`} hint="Coordinate, oppure scegli sulla mappa">
        <div className="ab-row">
          <input className="ui-mono" value={text[s]} onChange={(e) => setText((t) => ({ ...t, [s]: e.target.value }))} placeholder="37.56, 14.27" spellCheck={false} />
          <Button variant={picking === s ? 'primary' : 'secondary'} onClick={() => setPicking(picking === s ? null : s)}>
            {picking === s ? 'Clicca sulla mappa…' : 'Sulla mappa'}
          </Button>
        </div>
      </Field>
      <Field label={`Altezza antenna ${label} (m)`} hint="Dal suolo; con l’opzione qui sotto, almeno sopra tetti e alberi intorno">
        <input type="number" min={0} max={200} step={0.5} value={h[s]} onChange={(e) => setH((x) => ({ ...x, [s]: e.target.value }))} />
      </Field>
    </div>
  );
  const fact = (label: string, value: ReactNode, sub?: ReactNode) => (
    <div className="link-fact" key={label}>
      <small>{label}</small>
      <strong>{value}</strong>
      {sub ? <span className="ui-small ui-muted">{sub}</span> : null}
    </div>
  );
  const verdict: [string, 'good' | 'warn' | 'bad'] | null = d
    ? d.verdict === 'clear'
      ? ['Visibilità libera', 'good']
      : d.verdict === 'fresnel'
        ? ['Linea libera ma zona di Fresnel invasa', 'warn']
        : [d.buildings ? 'Linea ostruita da edifici' : d.foliageM > 0 ? 'Linea ostruita da terreno e alberi' : 'Linea ostruita dal terreno', 'bad']
    : null;
  const tilt = d ? (Math.atan2(d.chart[d.chart.length - 1]!.los - d.chart[0]!.los, d.distanceM) * 180) / Math.PI : 0;
  const az = d ? bearing([d.a.lat, d.a.lon], [d.b.lat, d.b.lon]) : 0;
  const clearPct = d?.worst ? Math.round((100 * d.worst.clearanceM) / (d.worst.fresnel60M / 0.6 || 1)) : null;

  return (
    <Card title="Simulazione A → B">
      <p className="ui-muted ui-small cn-p">Un collegamento tra due punti qualsiasi, scelti sulla mappa o con le coordinate: terreno, edifici 3D e alberi come in Visibilità. Utile per un nuovo AP, un ponte radio o una CPE lontana dagli AP esistenti.</p>
      <div className="ab-grid">
        {side('a', 'A')}
        {side('b', 'B')}
      </div>
      <div className="ui-grid-form">
        <Field label="Frequenza (MHz)" hint="Quella del collegamento">
          <input type="number" min={2400} max={6200} step={5} value={freq} onChange={(e) => setFreq(e.target.value)} />
        </Field>
        <Field label="Potenza trasmessa da A (EIRP, dBm)" hint="Vuoto: quella degli AP (Impostazioni server)">
          <input type="number" min={0} max={60} value={eirp} onChange={(e) => setEirp(e.target.value)} placeholder="predefinita" />
        </Field>
        <Field label="Guadagno antenna B (dBi)" hint="Vuoto: quello della CPE predefinita">
          <input type="number" min={0} max={40} value={gain} onChange={(e) => setGain(e.target.value)} placeholder="predefinito" />
        </Field>
      </div>
      <label className="ui-check">
        <input type="checkbox" checked={raise} onChange={(e) => setRaise(e.target.checked)} />
        Antenne sopra tetti e alberi intorno (come si montano)
      </label>
      <div className="ui-row">
        <AsyncButton variant="primary" onClick={run} onError={(e) => setRes({ error: (e as Error).message })} disabled={!pts.a || !pts.b}>
          Simula
        </AsyncButton>
        {(text.a || text.b) && (
          <Button
            variant="ghost"
            onClick={() => {
              setText({ a: '', b: '' });
              setRes(null);
            }}
          >
            Azzera
          </Button>
        )}
      </div>
      {res?.loading && <p className="ui-muted ui-small">Calcolo del profilo…</p>}
      {res?.error && <Notice tone="bad">{res.error}</Notice>}
      {d && verdict && (
        <>
          <Notice tone={verdict[1]}>
            <strong>{verdict[0]}</strong>
            {d.verdict !== 'clear' && d.raiseCpeM > 0
              ? d.raiseCpeM <= MAX_MAST_M
                ? ` · alzando A di ${dec(d.raiseCpeM)} m si libera il 60% della zona di Fresnel`
                : ` · servirebbe alzare A di ${dec(d.raiseCpeM)} m: non basta un palo, serve un punto più alto o un ripetitore`
              : ''}
            {d.tooFar ? ' · oltre 20 km: collegamento poco realistico per l’airMAX' : ''}
          </Notice>
          <div className="link-facts">
            {fact('Distanza', km(d.distanceM))}
            {fact('Frequenza', `${d.frequencyMhz} MHz`)}
            {fact('Puntamento A → B', dir(az), `inclinazione ${tilt >= 0 ? '+' : ''}${dec(tilt)}°`)}
            {fact('Puntamento B → A', dir((az + 180) % 360), `inclinazione ${-tilt >= 0 ? '+' : ''}${dec(-tilt)}°`)}
            {fact('Antenna A', `${dec(d.a.mountedM)} m dal suolo`, `${d.a.ground + Math.round(d.a.mountedM)} m s.l.m.${d.a.roofM ? ` · edificio ${dec(d.a.roofM)} m` : ''}`)}
            {fact('Antenna B', `${dec(d.b.mountedM)} m dal suolo`, `${d.b.ground + Math.round(d.b.mountedM)} m s.l.m.${d.b.roofM ? ` · edificio ${dec(d.b.roofM)} m` : ''}`)}
            {fact('Perdite per ostacoli', `${dec(d.lossDb)} dB`, [d.buildings ? 'edifici' : null, d.foliageM > 0 ? `${Math.round(d.foliageM)} m di alberi` : null].filter(Boolean).join(' · ') || (d.lossDb > 0 ? 'il terreno' : 'nessun ostacolo'))}
            {fact('Segnale atteso in B', `${d.estimate.signalDbm} dBm`, `EIRP ${d.radio.eirpDbm} dBm · antenna ${d.radio.gainDbi} dBi`)}
            {clearPct !== null ? fact('Fresnel libera', `${Math.max(0, clearPct)}%`, `nel punto critico, a ${km(d.worst!.d)}`) : fact('Fresnel libera', '100%', 'su tutto il collegamento')}
          </div>
          <SignalBar e={d.estimate} />
          <ProfileChart p={d} view="full" height={260} ends={['A', 'B']} />
          <ProfileChart p={d} view="fresnel" height={200} ends={['A', 'B']} />
          <p className="ui-muted ui-small cn-p">
            Terreno {d.terrainSource === 'tinitaly' ? 'TINITALY 10 m' : 'SRTM 30 m'}, edifici 3D e alberi dove importati (altrimenti la copertura del suolo). Segnale stimato con lo stesso modello della Copertura, rumore {d.radio.noiseDbm} dBm: una stima, non una misura.
          </p>
        </>
      )}
      {picking && (
        <Badge tone="info">{`Clicca sulla mappa qui sopra per il punto ${picking.toUpperCase()}`}</Badge>
      )}
    </Card>
  );
}
