import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { toast } from '../lib/toast';
import { api } from '../lib/api';
import { AsyncButton, Button, Field, Notice, Skeleton, Table } from '../ui';
import { ALT_FROM } from './link';

/**
 * The tools under the map of Copertura (admins), as tabs: how reliable the estimate is on the real
 * customers, the terrain and obstacles downloaded by the server, the antennas of the APs.
 */

const sign = (v: number) => `${v > 0 ? '+' : ''}${v}`;
const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const fail = (e: unknown) => toast((e as Error).message, 'bad');
const TERRAIN: Record<string, string> = { tinitaly: 'terreno 10 m', srtm: 'terreno 30 m', nessuno: 'senza terreno' };
const VERDICT: Record<string, string> = { clear: 'libero', fresnel: 'Fresnel', blocked: 'ostruito', 'n/d': 'n/d' };

/** A figure of a tab: what, the number, a line under it; [tone] colours its left edge. */
function Figure({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub: React.ReactNode; tone?: 'on' | 'warn' | '' }) {
  return (
    <div className={`cov-figure ${tone ?? ''}`}>
      <small>{label}</small>
      <b>{value}</b>
      <span>{sub}</span>
    </div>
  );
}

/** The state of a tool, read again every [ms] while it says it is working. */
function usePolled<T>(key: string[], url: string, running: (d: T) => boolean, ms: number) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: key, queryFn: () => api<T>(url), refetchInterval: (s) => (s.state.data && running(s.state.data) ? ms : false) });
  return { ...q, reload: () => qc.invalidateQueries({ queryKey: key }) };
}

interface Settings {
  buildingM: number;
  treeM: number;
  eirpDbm: number;
  calibrationDb: number;
}
interface Measure {
  at: string;
  terrain: string;
  settings: Settings;
  customers: number;
  medianAbsDb: number;
  p90AbsDb: number;
  within6Pct: number;
  biasDb: number;
  blockedButConnected: number;
  unlikelyButConnected?: number;
  realHeights?: number;
  byTerrain?: Record<string, { n: number; medianAbsDb: number; biasDb: number }>;
  failures?: { n: number; rated: Record<string, number> };
  aps?: Array<{ name: string; customers: number; biasDb: number; medianAbsDb: number }>;
  blocked?: Blocked[];
  worst?: Array<{ device: string; mac?: string; ap: string; realDbm: number; estimateDbm: number; errorDb: number; terrain?: string; distanceM: number }>;
}
export interface Blocked {
  device: string;
  deviceId?: string;
  mac?: string;
  ap: string;
  apId: string;
  apAltitudeFrom?: string;
  realDbm: number;
  estimateDbm: number;
  cause: string;
  where: string;
  raiseCpeM: number | null;
  distanceM: number;
  cpeHeightM: number;
  lat: number;
  lon: number;
}
interface Accuracy {
  running: boolean;
  error?: string | null;
  last?: Measure | null;
  history?: Measure[];
}

/**
 * Affidabilità della stima: the model measured on the real customers (each one estimated without
 * itself), the history to compare before/after, the APs and the customers it gets most wrong.
 * [onInspect](blocked customer) opens its point and its link on the map.
 */
export function AccuracyTab({ onInspect }: { onInspect: (b: Blocked) => Promise<void> }) {
  const q = usePolled<Accuracy>(['admin', 'coverage', 'accuracy'], '/api/admin/coverage/accuracy', (d) => d.running, 4000);
  if (q.error) return <Notice tone="bad">{(q.error as Error).message}</Notice>;
  const v = q.data;
  if (!v) return <Skeleton lines={4} />;
  const last = v.last;
  const measure = async () => {
    await api('/api/admin/coverage/accuracy', { method: 'POST', body: {} });
    await q.reload();
  };
  return (
    <div>
      {last ? (
        <>
          <div className="cov-figures">
            <Figure label="Errore tipico" value={`${last.medianAbsDb} dB`} sub={`su ${last.customers} clienti collegati`} />
            <Figure label="Entro ±6 dB" value={`${last.within6Pct}%`} sub={`1 su 10 sbaglia più di ${last.p90AbsDb} dB`} />
            <Figure label="Tendenza" value={`${sign(last.biasDb)} dB`} sub={last.biasDb > 0 ? 'stima ottimista' : last.biasDb < 0 ? 'stima pessimista' : 'centrata'} />
            <Figure label="Ultima misura" value={date(last.at)} sub={TERRAIN[last.terrain]} />
          </div>
          <p className="ui-small ui-muted">
            Edifici {last.settings.buildingM} m, alberi {last.settings.treeM} m, EIRP {last.settings.eirpDbm} dBm (calibrazione {sign(last.settings.calibrationDb)} dB). Per terreno:{' '}
            {Object.entries(last.byTerrain ?? {})
              .map(([k, s]) => `${VERDICT[k] ?? k} ${s.n} (errore ${s.medianAbsDb} dB, tendenza ${sign(s.biasDb)})`)
              .join(' · ')}
            . Collegati ma dati per ostruiti: {last.blockedButConnected}; giudicati improbabili: {last.unlikelyButConnected}.{last.realHeights ? ` Con l’altezza reale della CPE dal collaudo: ${last.realHeights}.` : ''}
          </p>
          {last.failures?.n ? (
            <p className="ui-small">
              Installazioni fallite per segnale, aggancio o ostacoli: {last.failures.n}. Il modello le avrebbe giudicate:{' '}
              {Object.entries(last.failures.rated)
                .map(([k, n]) => `${k} ${n}`)
                .join(', ')}
              {last.failures.rated.buono ? ' — quelle "buono" sono gli errori da guardare.' : '.'}
            </p>
          ) : (
            <p className="ui-small ui-muted">Nessuna installazione fallita per motivi radio da confrontare: quando l’app ne registra (Segnala KO), qui si vede se il modello le avrebbe evitate.</p>
          )}
        </>
      ) : (
        <p className="ui-muted">Nessuna misura ancora: avviala per vedere quanto è affidabile la stima sulla tua rete.</p>
      )}
      {v.error && <Notice tone="bad">{v.error}</Notice>}
      <div className="ui-row cov-actions">
        <AsyncButton disabled={v.running} onClick={measure} onError={fail}>
          {v.running ? 'Misura in corso…' : 'Misura ora'}
        </AsyncButton>
      </div>
      {(v.history?.length ?? 0) > 1 && (
        <details className="ui-details cov-more">
          <summary>Storico ({v.history!.length} misure)</summary>
          <Table
            rows={[...v.history!].reverse()}
            rowKey={(s) => s.at}
            columns={[
              { label: 'Quando', render: (s) => date(s.at) },
              { label: 'Dati', render: (s) => `${TERRAIN[s.terrain]} · edifici ${s.settings.buildingM} m · alberi ${s.settings.treeM} m · EIRP ${s.settings.eirpDbm}` },
              { label: 'Clienti', render: (s) => s.customers, end: true },
              { label: 'Errore tipico', render: (s) => `${s.medianAbsDb} dB`, end: true },
              { label: 'Entro ±6 dB', render: (s) => `${s.within6Pct}%`, end: true },
              { label: 'Tendenza', render: (s) => `${sign(s.biasDb)} dB`, end: true },
              { label: 'Ostruiti ma collegati', render: (s) => s.blockedButConnected, end: true },
            ]}
          />
        </details>
      )}
      {!!last?.aps?.length && (
        <details className="ui-details cov-more">
          <summary>AP dove la stima sbaglia di più (in media)</summary>
          <Table
            rows={last.aps}
            rowKey={(a) => a.name}
            columns={[
              { label: 'AP', render: (a) => a.name },
              { label: 'Clienti', render: (a) => a.customers, end: true },
              { label: 'Tendenza', render: (a) => `${sign(a.biasDb)} dB`, end: true },
              { label: 'Errore tipico', render: (a) => `${a.medianAbsDb} dB`, end: true },
            ]}
          />
          <p className="ui-small ui-muted">Tendenza positiva: la stima è più ottimista del reale (antenna più bassa, potenza minore o ostacoli non visti); negativa: più pessimista (azimut, altezza dell’antenna, potenza maggiore). Controlla in UISP azimut e altezza di questi AP.</p>
        </details>
      )}
      {!!last?.blocked?.length && (
        <details className="ui-details cov-more">
          <summary>Collegati ma dati per ostruiti: {last.blocked.length} da verificare</summary>
          <p className="ui-small ui-muted">
            Questi clienti funzionano, ma per il modello qualcosa copre la linea verso l’AP. Verifica apre il punto sulla mappa e il profilo del terreno con l’altezza della CPE: di solito l’antenna dell’AP è più alta di quanto dice UISP, la CPE è su un palo o un terrazzo più alto, oppure l’ostacolo (un edificio o un bosco) nella realtà non c’è.
          </p>
          <Table
            rows={last.blocked.map((b, i) => ({ ...b, key: b.mac ?? `${b.device}-${i}` }))}
            rowKey={(b) => b.key}
            columns={[
              {
                label: 'CPE',
                render: (b) => (
                  <div>
                    {b.deviceId ? <a href={`#/cpe?id=${encodeURIComponent(b.deviceId)}`}>{b.device}</a> : b.device}
                    <div className="ui-small ui-muted ui-mono">{b.mac ?? ''}</div>
                  </div>
                ),
              },
              {
                label: 'AP',
                render: (b) => (
                  <div>
                    {b.ap}
                    <div className="ui-small ui-muted">{b.apAltitudeFrom ? (ALT_FROM[b.apAltitudeFrom] ?? '') : ''}</div>
                  </div>
                ),
              },
              { label: 'Reale / stimato', render: (b) => `${b.realDbm} / ${b.estimateDbm} dBm` },
              { label: 'Cosa copre', render: (b) => `${b.cause}, ${b.where}` },
              { label: 'CPE più alta di', render: (b) => (b.raiseCpeM === null ? 'oltre 60 m' : `${b.raiseCpeM} m`) },
              { label: 'Distanza', render: (b) => `${(b.distanceM / 1000).toFixed(2)} km`, end: true },
              {
                label: '',
                end: true,
                render: (b) => (
                  <AsyncButton onClick={() => onInspect(b)} onError={fail}>
                    Verifica
                  </AsyncButton>
                ),
              },
            ]}
          />
        </details>
      )}
      {!!last?.worst?.length && (
        <details className="ui-details cov-more">
          <summary>Clienti stimati peggio</summary>
          <Table
            rows={last.worst.map((c, i) => ({ ...c, key: c.mac ?? `${c.device}-${i}` }))}
            rowKey={(c) => c.key}
            columns={[
              {
                label: 'CPE',
                render: (c) => (
                  <div>
                    {c.device}
                    <div className="ui-small ui-muted ui-mono">{c.mac ?? ''}</div>
                  </div>
                ),
              },
              { label: 'AP', render: (c) => c.ap },
              { label: 'Reale', render: (c) => `${c.realDbm} dBm`, end: true },
              { label: 'Stimato', render: (c) => `${c.estimateDbm} dBm`, end: true },
              { label: 'Errore', render: (c) => `${sign(c.errorDb)} dB`, end: true },
              { label: 'Terreno', render: (c) => VERDICT[c.terrain ?? 'n/d'] },
              { label: 'Distanza', render: (c) => `${(c.distanceM / 1000).toFixed(2)} km`, end: true },
            ]}
          />
        </details>
      )}
      <p className="ui-small ui-muted">Ogni cliente collegato viene stimato senza usare il suo segnale e confrontato con quello reale. La misura si ripete da sola dopo ogni scaricamento di terreno e ostacoli.</p>
    </div>
  );
}

const REGIONS: Record<string, string> = { SICI: 'Sicilia', CALA: 'Calabria', CAMP: 'Campania', PUGL: 'Puglia', BASI: 'Basilicata', SARD: 'Sardegna', LAZI: 'Lazio' };

interface TerrainState {
  area?: { minLat: number; maxLat: number; minLon: number; maxLon: number } | null;
  import?: { running?: boolean; phase?: string; done?: number; total?: number; error?: string | null };
  dtmTiles: number;
  tinitaly?: number;
  coverTiles?: number;
  worldcover?: number;
  updatedAt?: string | null;
  basemap?: boolean;
  buildingTiles?: number;
  buildings: number;
  buildingsAt?: string | null;
  canopyTiles?: number;
  canopyAt?: string | null;
  anncsu?: { civics?: number; region?: string; regionName?: string; file?: string; import?: { running?: boolean; phase?: string; error?: string | null } };
}

/**
 * Terreno e ostacoli: TINITALY (10 m) and ESA WorldCover (buildings, trees) for the area of the
 * network, downloaded and converted by the server when the admin asks; the house numbers of ANNCSU.
 */
export function TerrainTab() {
  const q = usePolled<TerrainState>(['admin', 'terrain'], '/api/admin/terrain', (d) => !!(d.import?.running || d.anncsu?.import?.running), 3000);
  const [region, setRegion] = useState<string | null>(null);
  if (q.error) return <Notice tone="bad">{(q.error as Error).message}</Notice>;
  const s = q.data;
  if (!s) return <Skeleton lines={4} />;
  const imp = s.import ?? {};
  const reg = region ?? s.anncsu?.region ?? 'SICI';
  const area = s.area ? `${s.area.minLat.toFixed(2)}–${s.area.maxLat.toFixed(2)}° N, ${s.area.minLon.toFixed(2)}–${s.area.maxLon.toFixed(2)}° E` : 'nessun AP con posizione';
  const post = (path: string, body: object, question?: string) => async () => {
    if (question && !confirm(question)) return;
    await api(path, { method: 'POST', body });
    await q.reload();
  };
  const off = !!imp.running || !s.area;
  const civics = s.anncsu?.civics;
  return (
    <div>
      <div className="cov-figures">
        <Figure tone={s.dtmTiles ? 'on' : ''} label="Terreno" value={s.dtmTiles ? '10 m' : '30 m'} sub={s.dtmTiles ? `TINITALY, ${s.dtmTiles} riquadri` : 'SRTM: scarica per i 10 m'} />
        <Figure tone={s.buildingTiles ? 'on' : ''} label="Edifici" value={s.buildingTiles ? s.buildings.toLocaleString('it-IT') : '—'} sub={s.buildingTiles ? 'sagome OpenStreetMap' : 'classe ESA «edificato»'} />
        <Figure tone={s.canopyTiles ? 'on' : ''} label="Alberi" value={s.canopyTiles ? 'veri' : 'medi'} sub={s.canopyTiles ? `Meta/WRI, ${s.canopyTiles} riquadri` : 'classe ESA «alberi»'} />
        <Figure tone={civics ? 'on' : ''} label="Civici" value={civics ? civics.toLocaleString('it-IT') : '—'} sub={civics ? `ANNCSU ${s.anncsu!.regionName}` : 'solo OpenStreetMap'} />
      </div>
      <p>
        {s.dtmTiles
          ? `Terreno a 10 m: ${s.dtmTiles} riquadri di 0,1° (${s.tinitaly} file TINITALY) · edifici e vegetazione: ${s.coverTiles} riquadri (${s.worldcover} file WorldCover) · aggiornato ${date(s.updatedAt)}.`
          : 'Non ancora scaricati: la copertura usa il modello SRTM (circa 30 m) e non vede edifici e alberi.'}
      </p>
      {imp.running ? (
        <Notice>
          In corso: {imp.phase} ({imp.done}/{imp.total})…
        </Notice>
      ) : imp.error ? (
        <Notice tone="bad">
          Ultimo scaricamento interrotto ({imp.phase}): {imp.error}. Riprova: riparte da dove si era fermato.
        </Notice>
      ) : null}
      <p>
        {s.buildingTiles
          ? `Edifici veri dalla mappa base: ${s.buildings.toLocaleString('it-IT')} sagome su ${s.buildingTiles} riquadri (${date(s.buildingsAt)}). Al posto della classe «edificato» di ESA (che copre anche strade e piazze) il calcolo usa le sagome di OpenStreetMap con la loro altezza dove è mappata, altrimenti quella media (3 m per i manufatti piccoli); la CPE si considera sul tetto, 2 m sopra.`
          : s.basemap
            ? 'Edifici: non ancora presi dalla mappa base. Con «Edifici dalla mappa base» il calcolo usa le sagome vere degli edifici di OpenStreetMap invece della classe «edificato» di ESA.'
            : 'Edifici: serve la mappa base installata sul server (sudo cdanet-cpe map update).'}
      </p>
      <p>
        {s.canopyTiles
          ? `Alberi veri: altezza di ogni albero dalla mappa Meta/WRI su ${s.canopyTiles} riquadri (${date(s.canopyAt)}), al posto della classe «alberi» di ESA con l’altezza media.`
          : 'Alberi: oggi la classe «alberi» di ESA con l’altezza media. Con «Altezze degli alberi» il calcolo usa l’altezza di ogni albero della mappa Meta/WRI (circa 1 m, letta a 4 m).'}
      </p>
      <div className="ui-row cov-actions">
        <AsyncButton
          disabled={off}
          onError={fail}
          onClick={post(
            '/api/admin/terrain/import',
            {},
            `Il server scarica il modello del terreno TINITALY 1.1 (INGV, 10 m) e la mappa del suolo ESA WorldCover 2021 per l’area della rete (${area}): per la Sicilia circa 800 MB da INGV e 60 MB da ESA, convertiti e poi cancellati (restano circa 300–400 MB). Procedo?`,
          )}
        >
          {s.dtmTiles ? 'Aggiorna per l’area della rete' : 'Scarica terreno e ostacoli'}
        </AsyncButton>
        {s.basemap && (
          <AsyncButton disabled={off} onError={fail} onClick={post('/api/admin/terrain/buildings', {})}>
            {s.buildingTiles ? 'Aggiorna gli edifici' : 'Edifici dalla mappa base'}
          </AsyncButton>
        )}
        <AsyncButton
          disabled={off}
          onError={fail}
          onClick={post(
            '/api/admin/terrain/canopy',
            {},
            `Il server legge da AWS Open Data la mappa delle altezze degli alberi di Meta e World Resources Institute (CHM v2, CC BY 4.0) per l’area della rete (${area}): solo i pezzi che servono, circa 4 MB ogni riquadro di 0,1° (per la rete intera circa 500 MB letti, 30–60 MB salvati). Procedo?`,
          )}
        >
          {s.canopyTiles ? 'Aggiorna le altezze degli alberi' : 'Altezze degli alberi'}
        </AsyncButton>
      </div>
      <p>
        {civics
          ? `Civici ANNCSU (${s.anncsu!.regionName}, ${s.anncsu!.file}): ${civics.toLocaleString('it-IT')} numeri civici con coordinate nell’area della rete. Quando un indirizzo cercato ha via e numero, la ricerca lo mette sulla casa invece che sulla via.`
          : 'Civici: la ricerca di un indirizzo usa OpenStreetMap, che spesso conosce la via ma non il numero. Con l’archivio nazionale dei civici (ANNCSU, Agenzia delle Entrate – ISTAT) il punto cade sulla casa.'}
      </p>
      {s.anncsu?.import?.running ? <Notice>{s.anncsu.import.phase}…</Notice> : s.anncsu?.import?.error ? <Notice tone="bad">Civici: {s.anncsu.import.error}</Notice> : null}
      <div className="ui-row cov-actions cov-civics">
        <Field label="Regione dei civici">
          <select value={reg} onChange={(e) => setRegion(e.target.value)}>
            {Object.entries(REGIONS).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <AsyncButton
          disabled={!!s.anncsu?.import?.running || !s.area}
          onError={fail}
          onClick={post(
            '/api/admin/terrain/anncsu',
            { region: reg },
            `Il server scarica l’archivio dei numeri civici della regione ${REGIONS[reg]} dall’Agenzia delle Entrate (ANNCSU, dati aperti aggiornati ogni mese; per la Sicilia circa 37 MB) e tiene solo i civici con coordinate nell’area della rete. Procedo?`,
          )}
        >
          {civics ? 'Aggiorna i civici' : 'Scarica i civici ANNCSU'}
        </AsyncButton>
      </div>
      <p className="ui-small ui-muted">
        Area della rete: {area}, cioè gli AP più 20 km intorno. Le altezze medie di edifici e vegetazione si impostano in Impostazioni server → Simulazione radio. Fonti: TINITALY 1.1, Tarquini et al. (2023), INGV, doi:10.13127/tinitaly/1.1 (CC BY 4.0); ESA WorldCover 10 m 2021 v200, doi:10.5281/zenodo.7254221 (CC BY 4.0); edifici ©
        OpenStreetMap contributors (ODbL) tramite Protomaps; alberi: Meta e World Resources Institute, Canopy Height Maps v2 (CC BY 4.0).
      </p>
    </div>
  );
}

/** Polar drawing of a horizontal cut (attenuation in dB: the edge is the peak, the centre 30 dB down). */
function Polar({ az, size = 64 }: { az: number[]; size?: number }) {
  const c = size / 2;
  const r = (db: number) => Math.max(0, (1 - Math.min(30, db) / 30) * (c - 2));
  const pts = az.map((db, i) => {
    const a = ((i - 90) * Math.PI) / 180;
    return `${(c + r(db) * Math.cos(a)).toFixed(1)},${(c + r(db) * Math.sin(a)).toFixed(1)}`;
  });
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} className="ant-polar">
      <circle cx={c} cy={c} r={c - 2} className="ring" />
      <circle cx={c} cy={c} r={(c - 2) / 2} className="ring" />
      <polygon points={pts.join(' ')} className="lobe" />
    </svg>
  );
}

/** The horizontal pattern of an antenna, loaded once per antenna. */
function PatternPreview({ id }: { id: string | null }) {
  const q = useQuery({ queryKey: ['admin', 'antenna-pattern', id], queryFn: () => api<{ az: number[] }>(`/api/admin/antennas/pattern/${encodeURIComponent(id!)}`), enabled: !!id, staleTime: Infinity });
  return <span className="ant-pv">{id && q.data ? <Polar az={q.data.az} /> : null}</span>;
}

interface Pattern {
  id: string;
  vendor: string;
  name: string;
  gainDbi?: number | null;
  hBeam: number;
  vBeam: number;
}
interface ApAntenna {
  id: string;
  name: string;
  model?: string | null;
  customers: number;
  external?: boolean;
  antennaId?: string | null;
  antennaFrom?: 'admin' | 'modello' | string | null;
  azimuth?: number | null;
  uispAzimuth?: number | null;
  tilt?: number | null;
  suggested?: { azimuth: number } | null;
}
interface Antennas {
  aps: ApAntenna[];
  library?: Pattern[];
  import?: { running?: boolean; done?: number; total?: number; error?: string | null };
}

/** One AP: antenna, azimuth and tilt (its own state), saved on its own. */
function AntennaRow({ a, lib, onSaved }: { a: ApAntenna; lib: Pattern[]; onSaved: () => Promise<void> }) {
  const [ant, setAnt] = useState(a.antennaFrom === 'admin' ? (a.antennaId ?? '') : '');
  const [az, setAz] = useState(a.azimuth != null ? String(a.azimuth) : '');
  const [tilt, setTilt] = useState(a.tilt != null ? String(a.tilt) : '');
  const num = (v: string) => (v.trim() === '' ? null : Number(v));
  const save = async () => {
    await api(`/api/admin/antennas/ap/${encodeURIComponent(a.id)}`, { method: 'PUT', body: { antennaId: ant || null, azimuth: num(az), tilt: num(tilt) } });
    toast(`${a.name}: salvato`);
    await onSaved();
  };
  const shown = ant || (a.antennaFrom === 'modello' ? (a.antennaId ?? null) : null);
  return (
    <tr>
      <td data-label="AP">
        {a.name}
        <div className="ui-small ui-muted">
          {a.model ?? ''} · {a.customers} clienti
        </div>
      </td>
      <td data-label="Antenna">
        <div className="ant-cell">
          <PatternPreview id={shown} />
          <select value={ant} onChange={(e) => setAnt(e.target.value)} aria-label={`Antenna di ${a.name}`}>
            <option value="">{a.external ? '— da indicare —' : a.antennaFrom === 'modello' ? 'integrata (dal modello)' : 'integrata (diagramma non pubblicato)'}</option>
            {['Ubiquiti', 'RF elements'].map((v) => (
              <optgroup key={v} label={v}>
                {lib
                  .filter((p) => p.vendor === v)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.gainDbi ?? '?'} dBi · {p.hBeam}°×{p.vBeam}°
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </div>
      </td>
      <td data-label="Azimut">
        <div className="ui-row">
          <input
            type="number"
            className="ant-num"
            min={0}
            max={359}
            step={1}
            value={az}
            aria-label={`Azimut di ${a.name}`}
            placeholder={a.uispAzimuth != null ? `UISP ${a.uispAzimuth}°` : a.suggested ? `clienti ~${a.suggested.azimuth}°` : '°'}
            onChange={(e) => setAz(e.target.value)}
          />
          {a.suggested && a.azimuth == null && <Button onClick={() => setAz(String(a.suggested!.azimuth))}>usa {a.suggested.azimuth}°</Button>}
        </div>
      </td>
      <td data-label="Tilt (giù +)">
        <input type="number" className="ant-num" min={-30} max={30} step={0.5} value={tilt} aria-label={`Tilt di ${a.name}`} placeholder="°" onChange={(e) => setTilt(e.target.value)} />
      </td>
      <td className="end">
        <AsyncButton onClick={save} onError={fail}>
          Salva
        </AsyncButton>
      </td>
    </tr>
  );
}

const todo = (a: ApAntenna) => a.customers >= 3 && ((a.azimuth == null && a.uispAzimuth == null) || (!!a.external && !a.antennaId));

/**
 * Antenne degli AP: the makers' radiation patterns (Ubiquiti, RF elements) and, for every AP, the
 * antenna, azimuth and tilt the coverage model uses. UISP rarely knows the azimuth and never which
 * horn is on a Rocket: the admin says it here (the customers suggest the azimuth).
 */
export function AntennasTab() {
  const q = usePolled<Antennas>(['admin', 'antennas'], '/api/admin/antennas', (d) => !!d.import?.running, 2000);
  const [onlyTodo, setOnlyTodo] = useState(true);
  const s = q.data;
  const rows = useMemo(() => (s ? (onlyTodo ? s.aps.filter(todo) : s.aps).slice(0, 300) : []), [s, onlyTodo]);
  // a saved AP leaves the list "to complete" only when the list is asked for again
  const [kept, setKept] = useState<ApAntenna[] | null>(null);
  useEffect(() => setKept(null), [onlyTodo]);
  if (q.error) return <Notice tone="bad">{(q.error as Error).message}</Notice>;
  if (!s) return <Skeleton lines={4} />;
  const imp = s.import ?? {};
  const lib = s.library ?? [];
  const download = async () => {
    if (!confirm('Il server scarica i diagrammi di radiazione pubblicati dai costruttori: Ubiquiti airMAX (27 file da dl.ui.com, circa 0,7 MB) e RF elements (horn, settori e parabole: 1 file da rfelements.com, 135 KB). Restano sul server, non nel codice. Procedo?')) return;
    await api('/api/admin/antennas/import', { method: 'POST', body: {} });
    await q.reload();
  };
  const missing = s.aps.filter(todo).length;
  const shown = (kept ?? rows).map((a) => s.aps.find((x) => x.id === a.id) ?? a);
  const saved = async () => {
    setKept(kept ?? rows);
    await q.reload();
  };
  return (
    <div>
      <div className="cov-figures">
        <Figure
          tone={lib.length ? 'on' : ''}
          label="Diagrammi"
          value={lib.length || '—'}
          sub={lib.length ? `${lib.filter((p) => p.vendor === 'Ubiquiti').length} Ubiquiti, ${lib.filter((p) => p.vendor === 'RF elements').length} RF elements` : 'da scaricare'}
        />
        <Figure tone={missing ? 'warn' : 'on'} label="AP da completare" value={missing} sub="con almeno 3 clienti" />
      </div>
      {imp.running ? (
        <Notice>
          Scaricamento… ({imp.done}/{imp.total})
        </Notice>
      ) : imp.error ? (
        <Notice tone="bad">{imp.error}</Notice>
      ) : null}
      <div className="ui-row cov-actions">
        <AsyncButton disabled={!!imp.running} onClick={download} onError={fail}>
          {lib.length ? 'Aggiorna i diagrammi' : 'Scarica i diagrammi delle antenne'}
        </AsyncButton>
        <label className="ui-check ui-small">
          <input type="checkbox" checked={onlyTodo} onChange={(e) => setOnlyTodo(e.target.checked)} /> Solo gli AP da completare
        </label>
      </div>
      {shown.length ? (
        <div className="ui-table-wrap">
          <table className="ui-table">
            <thead>
              <tr>
                <th>AP</th>
                <th>Antenna</th>
                <th>Azimut</th>
                <th>Tilt (giù +)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((a) => (
                <AntennaRow key={a.id} a={a} lib={lib} onSaved={saved} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="ui-muted">{onlyTodo ? 'Tutti gli AP con clienti hanno azimut e antenna.' : 'Nessun AP.'}</p>
      )}
      <p className="ui-small ui-muted">
        Con antenna e azimut la copertura usa il diagramma vero (orizzontale; anche verticale se indichi il tilt meccanico: quello elettrico è già nel diagramma). L’azimut suggerito è il centro dell’arco dei clienti collegati: confermalo solo se torna con l’antenna reale. IA-AP segnala gli AP senza azimut e i Rocket senza antenna indicata.
      </p>
    </div>
  );
}
