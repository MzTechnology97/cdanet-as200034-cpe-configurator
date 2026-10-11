/**
 * The tools under the map of Copertura (admins), as tabs: how reliable the estimate is on the real
 * customers, the terrain and obstacles downloaded by the server, the antennas of the APs.
 */
import { api } from '../api.js';
import { toast } from '../dom.js';
import { html, useEffect, useMemo, useState } from '../react.js';
import { BusyButton, Field, fmtDate, Notice, Table } from '../ui.js';
import { ALT_FROM } from './coverage-link.js';

const sign = (v) => `${v > 0 ? '+' : ''}${v}`;

/**
 * Polls [load] every [ms] while [running] is true and this tab is open; [load] also runs once.
 * Returns [data, error, reload].
 */
function usePolled(load, running, ms) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const reload = async () => {
    try {
      setData(await load());
      setError('');
    } catch (e) {
      setError(e.message);
    }
  };
  useEffect(() => {
    void reload();
  }, []);
  useEffect(() => {
    if (!data || !running(data)) return undefined;
    const t = setTimeout(() => void reload(), ms);
    return () => clearTimeout(t);
  }, [data]);
  return [data, error, reload];
}

const TERRAIN = { tinitaly: 'terreno 10 m', srtm: 'terreno 30 m', nessuno: 'senza terreno' };
const VERDICT = { clear: 'libero', fresnel: 'Fresnel', blocked: 'ostruito', 'n/d': 'n/d' };

/**
 * Affidabilità della stima: the model measured on the real customers (each one estimated without
 * itself), the history to compare before/after, the APs and the customers it gets most wrong.
 * [onInspect](blocked customer) opens its point and its link on the map.
 */
export function AccuracyTab({ onInspect }) {
  const [v, error, reload] = usePolled(() => api('/api/admin/coverage/accuracy'), (d) => d.running, 4000);
  if (error) return html`<${Notice} kind="bad">${error}<//>`;
  if (!v) return html`<p class="muted">Caricamento…</p>`;
  const last = v.last;
  const measure = async () => {
    await api('/api/admin/coverage/accuracy', { method: 'POST', body: {} });
    await reload();
  };
  return html`
    <div>
      ${last
        ? html`
            <div class="cov-figures">
              <div class="cov-figure"><small>Errore tipico</small><b>${last.medianAbsDb} dB</b><span>su ${last.customers} clienti collegati</span></div>
              <div class="cov-figure"><small>Entro ±6 dB</small><b>${last.within6Pct}%</b><span>1 su 10 sbaglia più di ${last.p90AbsDb} dB</span></div>
              <div class="cov-figure"><small>Tendenza</small><b>${sign(last.biasDb)} dB</b><span>${last.biasDb > 0 ? 'stima ottimista' : last.biasDb < 0 ? 'stima pessimista' : 'centrata'}</span></div>
              <div class="cov-figure"><small>Ultima misura</small><b>${fmtDate(last.at)}</b><span>${TERRAIN[last.terrain]}</span></div>
            </div>
            <p class="small muted">
              Edifici ${last.settings.buildingM} m, alberi ${last.settings.treeM} m, EIRP ${last.settings.eirpDbm} dBm (calibrazione ${sign(last.settings.calibrationDb)} dB). Per terreno:
              ${' '}${Object.entries(last.byTerrain).map(([k, s]) => `${VERDICT[k] ?? k} ${s.n} (errore ${s.medianAbsDb} dB, tendenza ${sign(s.biasDb)})`).join(' · ')}. Collegati ma dati per ostruiti: ${last.blockedButConnected}; giudicati improbabili:
              ${' '}${last.unlikelyButConnected}.${last.realHeights ? ` Con l’altezza reale della CPE dal collaudo: ${last.realHeights}.` : ''}
            </p>
            ${last.failures?.n
              ? html`<p class="small">
                  Installazioni fallite per segnale, aggancio o ostacoli: ${last.failures.n}. Il modello le avrebbe giudicate:
                  ${' '}${Object.entries(last.failures.rated).map(([k, n]) => `${k} ${n}`).join(', ')}${last.failures.rated.buono ? ' — quelle "buono" sono gli errori da guardare.' : '.'}
                </p>`
              : html`<p class="small muted">Nessuna installazione fallita per motivi radio da confrontare: quando l’app ne registra (Segnala KO), qui si vede se il modello le avrebbe evitate.</p>`}
          `
        : html`<p class="muted">Nessuna misura ancora: avviala per vedere quanto è affidabile la stima sulla tua rete.</p>`}
      ${v.error ? html`<${Notice} kind="bad">${v.error}<//>` : null}
      <div class="row"><${BusyButton} disabled=${v.running} onClick=${measure}>${v.running ? 'Misura in corso…' : 'Misura ora'}<//></div>
      ${v.history?.length > 1
        ? html`<details>
            <summary>Storico (${v.history.length} misure)</summary>
            <${Table}
              rows=${[...v.history].reverse()}
              keyOf=${(s) => s.at}
              columns=${[
                { label: 'Quando', render: (s) => fmtDate(s.at) },
                { label: 'Dati', render: (s) => `${TERRAIN[s.terrain]} · edifici ${s.settings.buildingM} m · alberi ${s.settings.treeM} m · EIRP ${s.settings.eirpDbm}` },
                { label: 'Clienti', render: (s) => s.customers },
                { label: 'Errore tipico', render: (s) => `${s.medianAbsDb} dB` },
                { label: 'Entro ±6 dB', render: (s) => `${s.within6Pct}%` },
                { label: 'Tendenza', render: (s) => `${sign(s.biasDb)} dB` },
                { label: 'Ostruiti ma collegati', render: (s) => s.blockedButConnected },
              ]}
            />
          </details>`
        : null}
      ${last?.aps?.length
        ? html`<details>
            <summary>AP dove la stima sbaglia di più (in media)</summary>
            <${Table}
              rows=${last.aps}
              keyOf=${(a) => a.name}
              columns=${[
                { label: 'AP', render: (a) => a.name },
                { label: 'Clienti', render: (a) => a.customers },
                { label: 'Tendenza', render: (a) => `${sign(a.biasDb)} dB` },
                { label: 'Errore tipico', render: (a) => `${a.medianAbsDb} dB` },
              ]}
            />
            <p class="small muted">Tendenza positiva: la stima è più ottimista del reale (antenna più bassa, potenza minore o ostacoli non visti); negativa: più pessimista (azimut, altezza dell’antenna, potenza maggiore). Controlla in UISP azimut e altezza di questi AP.</p>
          </details>`
        : null}
      ${last?.blocked?.length
        ? html`<details>
            <summary>Collegati ma dati per ostruiti: ${last.blocked.length} da verificare</summary>
            <p class="small muted">Questi clienti funzionano, ma per il modello qualcosa copre la linea verso l’AP. Verifica apre il punto sulla mappa e il profilo del terreno con l’altezza della CPE: di solito l’antenna dell’AP è più alta di quanto dice UISP, la CPE è su un palo o un terrazzo più alto, oppure l’ostacolo (un edificio o un bosco) nella realtà non c’è.</p>
            <${Table}
              rows=${last.blocked}
              keyOf=${(b, i) => b.mac ?? `${b.device}-${i}`}
              columns=${[
                { label: 'CPE', render: (b) => html`<div>${b.deviceId ? html`<a href=${`#/cpe?id=${encodeURIComponent(b.deviceId)}`}>${b.device}</a>` : b.device}<div class="small muted mono">${b.mac ?? ''}</div></div>` },
                { label: 'AP', render: (b) => html`<div>${b.ap}<div class="small muted">${b.apAltitudeFrom ? (ALT_FROM[b.apAltitudeFrom] ?? '') : ''}</div></div>` },
                { label: 'Reale / stimato', render: (b) => `${b.realDbm} / ${b.estimateDbm} dBm` },
                { label: 'Cosa copre', render: (b) => `${b.cause}, ${b.where}` },
                { label: 'CPE più alta di', render: (b) => (b.raiseCpeM === null ? 'oltre 60 m' : `${b.raiseCpeM} m`) },
                { label: 'Distanza', render: (b) => `${(b.distanceM / 1000).toFixed(2)} km` },
                { label: '', render: (b) => html`<${BusyButton} className="small-btn" onClick=${() => onInspect(b)}>Verifica<//>` },
              ]}
            />
          </details>`
        : null}
      ${last?.worst?.length
        ? html`<details>
            <summary>Clienti stimati peggio</summary>
            <${Table}
              rows=${last.worst}
              keyOf=${(c, i) => c.mac ?? `${c.device}-${i}`}
              columns=${[
                { label: 'CPE', render: (c) => html`<div>${c.device}<div class="small muted mono">${c.mac ?? ''}</div></div>` },
                { label: 'AP', render: (c) => c.ap },
                { label: 'Reale', render: (c) => `${c.realDbm} dBm` },
                { label: 'Stimato', render: (c) => `${c.estimateDbm} dBm` },
                { label: 'Errore', render: (c) => `${sign(c.errorDb)} dB` },
                { label: 'Terreno', render: (c) => VERDICT[c.terrain ?? 'n/d'] },
                { label: 'Distanza', render: (c) => `${(c.distanceM / 1000).toFixed(2)} km` },
              ]}
            />
          </details>`
        : null}
      <p class="small muted">Ogni cliente collegato viene stimato senza usare il suo segnale e confrontato con quello reale. La misura si ripete da sola dopo ogni scaricamento di terreno e ostacoli.</p>
    </div>
  `;
}

const REGIONS = { SICI: 'Sicilia', CALA: 'Calabria', CAMP: 'Campania', PUGL: 'Puglia', BASI: 'Basilicata', SARD: 'Sardegna', LAZI: 'Lazio' };

/**
 * Terreno e ostacoli: TINITALY (10 m) and ESA WorldCover (buildings, trees) for the area of the
 * network, downloaded and converted by the server when the admin asks; the house numbers of ANNCSU.
 */
export function TerrainTab() {
  const [s, error, reload] = usePolled(() => api('/api/admin/terrain'), (d) => d.import?.running || d.anncsu?.import?.running, 3000);
  const [region, setRegion] = useState(null);
  if (error) return html`<${Notice} kind="bad">${error}<//>`;
  if (!s) return html`<p class="muted">Caricamento…</p>`;
  const imp = s.import ?? {};
  const reg = region ?? s.anncsu?.region ?? 'SICI';
  const area = s.area ? `${s.area.minLat.toFixed(2)}–${s.area.maxLat.toFixed(2)}° N, ${s.area.minLon.toFixed(2)}–${s.area.maxLon.toFixed(2)}° E` : 'nessun AP con posizione';
  const post = (path, body, question) => async () => {
    if (question && !confirm(question)) return;
    await api(path, { method: 'POST', body });
    await reload();
  };
  const off = imp.running || !s.area;
  return html`
    <div>
      <div class="cov-figures">
        <div class=${`cov-figure ${s.dtmTiles ? 'on' : ''}`}><small>Terreno</small><b>${s.dtmTiles ? '10 m' : '30 m'}</b><span>${s.dtmTiles ? `TINITALY, ${s.dtmTiles} riquadri` : 'SRTM: scarica per i 10 m'}</span></div>
        <div class=${`cov-figure ${s.buildingTiles ? 'on' : ''}`}><small>Edifici</small><b>${s.buildingTiles ? s.buildings.toLocaleString('it-IT') : '—'}</b><span>${s.buildingTiles ? 'sagome OpenStreetMap' : 'classe ESA «edificato»'}</span></div>
        <div class=${`cov-figure ${s.canopyTiles ? 'on' : ''}`}><small>Alberi</small><b>${s.canopyTiles ? 'veri' : 'medi'}</b><span>${s.canopyTiles ? `Meta/WRI, ${s.canopyTiles} riquadri` : 'classe ESA «alberi»'}</span></div>
        <div class=${`cov-figure ${s.anncsu?.civics ? 'on' : ''}`}><small>Civici</small><b>${s.anncsu?.civics ? s.anncsu.civics.toLocaleString('it-IT') : '—'}</b><span>${s.anncsu?.civics ? `ANNCSU ${s.anncsu.regionName}` : 'solo OpenStreetMap'}</span></div>
      </div>
      <p>
        ${s.dtmTiles
          ? `Terreno a 10 m: ${s.dtmTiles} riquadri di 0,1° (${s.tinitaly} file TINITALY) · edifici e vegetazione: ${s.coverTiles} riquadri (${s.worldcover} file WorldCover) · aggiornato ${fmtDate(s.updatedAt)}.`
          : 'Non ancora scaricati: la copertura usa il modello SRTM (circa 30 m) e non vede edifici e alberi.'}
      </p>
      ${imp.running
        ? html`<${Notice}>In corso: ${imp.phase} (${imp.done}/${imp.total})…<//>`
        : imp.error
          ? html`<${Notice} kind="bad">Ultimo scaricamento interrotto (${imp.phase}): ${imp.error}. Riprova: riparte da dove si era fermato.<//>`
          : null}
      <p>
        ${s.buildingTiles
          ? `Edifici veri dalla mappa base: ${s.buildings.toLocaleString('it-IT')} sagome su ${s.buildingTiles} riquadri (${fmtDate(s.buildingsAt)}). Al posto della classe «edificato» di ESA (che copre anche strade e piazze) il calcolo usa le sagome di OpenStreetMap con la loro altezza dove è mappata, altrimenti quella media (3 m per i manufatti piccoli); la CPE si considera sul tetto, 2 m sopra.`
          : s.basemap
            ? 'Edifici: non ancora presi dalla mappa base. Con «Edifici dalla mappa base» il calcolo usa le sagome vere degli edifici di OpenStreetMap invece della classe «edificato» di ESA.'
            : 'Edifici: serve la mappa base installata sul server (sudo cdanet-cpe map update).'}
      </p>
      <p>
        ${s.canopyTiles
          ? `Alberi veri: altezza di ogni albero dalla mappa Meta/WRI su ${s.canopyTiles} riquadri (${fmtDate(s.canopyAt)}), al posto della classe «alberi» di ESA con l’altezza media.`
          : 'Alberi: oggi la classe «alberi» di ESA con l’altezza media. Con «Altezze degli alberi» il calcolo usa l’altezza di ogni albero della mappa Meta/WRI (circa 1 m, letta a 4 m).'}
      </p>
      <div class="row">
        <${BusyButton}
          disabled=${off}
          onClick=${post(
            '/api/admin/terrain/import',
            {},
            `Il server scarica il modello del terreno TINITALY 1.1 (INGV, 10 m) e la mappa del suolo ESA WorldCover 2021 per l’area della rete (${area}): per la Sicilia circa 800 MB da INGV e 60 MB da ESA, convertiti e poi cancellati (restano circa 300–400 MB). Procedo?`,
          )}
          >${s.dtmTiles ? 'Aggiorna per l’area della rete' : 'Scarica terreno e ostacoli'}<//
        >
        ${s.basemap ? html`<${BusyButton} disabled=${off} onClick=${post('/api/admin/terrain/buildings', {})}>${s.buildingTiles ? 'Aggiorna gli edifici' : 'Edifici dalla mappa base'}<//>` : null}
        <${BusyButton}
          disabled=${off}
          onClick=${post(
            '/api/admin/terrain/canopy',
            {},
            `Il server legge da AWS Open Data la mappa delle altezze degli alberi di Meta e World Resources Institute (CHM v2, CC BY 4.0) per l’area della rete (${area}): solo i pezzi che servono, circa 4 MB ogni riquadro di 0,1° (per la rete intera circa 500 MB letti, 30–60 MB salvati). Procedo?`,
          )}
          >${s.canopyTiles ? 'Aggiorna le altezze degli alberi' : 'Altezze degli alberi'}<//
        >
      </div>
      <p>
        ${s.anncsu?.civics
          ? `Civici ANNCSU (${s.anncsu.regionName}, ${s.anncsu.file}): ${s.anncsu.civics.toLocaleString('it-IT')} numeri civici con coordinate nell’area della rete. Quando un indirizzo cercato ha via e numero, la ricerca lo mette sulla casa invece che sulla via.`
          : 'Civici: la ricerca di un indirizzo usa OpenStreetMap, che spesso conosce la via ma non il numero. Con l’archivio nazionale dei civici (ANNCSU, Agenzia delle Entrate – ISTAT) il punto cade sulla casa.'}
      </p>
      ${s.anncsu?.import?.running ? html`<${Notice}>${s.anncsu.import.phase}…<//>` : s.anncsu?.import?.error ? html`<${Notice} kind="bad">Civici: ${s.anncsu.import.error}<//>` : null}
      <div class="row">
        <${Field} label="Regione dei civici">
          <select value=${reg} onChange=${(e) => setRegion(e.target.value)}>${Object.entries(REGIONS).map(([k, l]) => html`<option key=${k} value=${k}>${l}</option>`)}</select>
        <//>
        <${BusyButton}
          disabled=${s.anncsu?.import?.running || !s.area}
          onClick=${post(
            '/api/admin/terrain/anncsu',
            { region: reg },
            `Il server scarica l’archivio dei numeri civici della regione ${REGIONS[reg]} dall’Agenzia delle Entrate (ANNCSU, dati aperti aggiornati ogni mese; per la Sicilia circa 37 MB) e tiene solo i civici con coordinate nell’area della rete. Procedo?`,
          )}
          >${s.anncsu?.civics ? 'Aggiorna i civici' : 'Scarica i civici ANNCSU'}<//
        >
      </div>
      <p class="small muted">
        Area della rete: ${area}, cioè gli AP più 20 km intorno. Le altezze medie di edifici e vegetazione si impostano in Impostazioni server → Simulazione radio. Fonti: TINITALY 1.1, Tarquini et al. (2023), INGV,
        doi:10.13127/tinitaly/1.1 (CC BY 4.0); ESA WorldCover 10 m 2021 v200, doi:10.5281/zenodo.7254221 (CC BY 4.0); edifici © OpenStreetMap contributors (ODbL) tramite Protomaps; alberi: Meta e World Resources Institute, Canopy Height Maps v2 (CC BY 4.0).
      </p>
    </div>
  `;
}

/** Polar drawing of a horizontal cut (attenuation in dB: the edge is the peak, the centre 30 dB down). */
function Polar({ az, size = 64 }) {
  const c = size / 2;
  const r = (db) => Math.max(0, (1 - Math.min(30, db) / 30) * (c - 2));
  const pts = az.map((db, i) => {
    const a = ((i - 90) * Math.PI) / 180;
    return `${(c + r(db) * Math.cos(a)).toFixed(1)},${(c + r(db) * Math.sin(a)).toFixed(1)}`;
  });
  return html`
    <svg viewBox=${`0 0 ${size} ${size}`} width=${size} height=${size} class="ant-polar">
      <circle cx=${c} cy=${c} r=${c - 2} class="ring" />
      <circle cx=${c} cy=${c} r=${(c - 2) / 2} class="ring" />
      <polygon points=${pts.join(' ')} class="lobe" />
    </svg>
  `;
}

const patterns = new Map();
const patternOf = (id) => {
  if (!patterns.has(id)) patterns.set(id, api(`/api/admin/antennas/pattern/${encodeURIComponent(id)}`));
  return patterns.get(id);
};

/** The horizontal pattern of an antenna, loaded once per antenna. */
function PatternPreview({ id }) {
  const [az, setAz] = useState(null);
  useEffect(() => {
    let alive = true;
    setAz(null);
    if (id) patternOf(id).then((p) => alive && setAz(p.az)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [id]);
  return html`<span class="ant-pv">${az ? html`<${Polar} az=${az} />` : null}</span>`;
}

/** One AP: antenna, azimuth and tilt (its own state), saved on its own; the cells of its row. */
function useAntennaCells(a, lib) {
  const [ant, setAnt] = useState(a.antennaFrom === 'admin' ? a.antennaId : '');
  const [az, setAz] = useState(a.azimuth ?? '');
  const [tilt, setTilt] = useState(a.tilt ?? '');
  const num = (v) => (String(v).trim() === '' ? null : Number(v));
  const save = async () => {
    await api(`/api/admin/antennas/ap/${encodeURIComponent(a.id)}`, { method: 'PUT', body: { antennaId: ant || null, azimuth: num(az), tilt: num(tilt) } });
    toast(`${a.name}: salvato`);
    Object.assign(a, { antennaId: ant || a.antennaId, antennaFrom: ant ? 'admin' : a.antennaFrom, azimuth: num(az), tilt: num(tilt) });
  };
  const shown = ant || (a.antennaFrom === 'modello' ? a.antennaId : null);
  return {
    ap: html`<div>${a.name}<div class="small muted">${a.model ?? ''} · ${a.customers} clienti</div></div>`,
    antenna: html`
      <div class="ant-cell">
        <${PatternPreview} id=${shown} />
        <select value=${ant} onChange=${(e) => setAnt(e.target.value)}>
          <option value="">${a.external ? '— da indicare —' : a.antennaFrom === 'modello' ? 'integrata (dal modello)' : 'integrata (diagramma non pubblicato)'}</option>
          ${['Ubiquiti', 'RF elements'].map(
            (v) => html`<optgroup key=${v} label=${v}>${lib.filter((p) => p.vendor === v).map((p) => html`<option key=${p.id} value=${p.id}>${p.name} · ${p.gainDbi ?? '?'} dBi · ${p.hBeam}°×${p.vBeam}°</option>`)}</optgroup>`,
          )}
        </select>
      </div>
    `,
    azimuth: html`
      <div>
        <input type="number" class="ant-num" min="0" max="359" step="1" value=${az} placeholder=${a.uispAzimuth != null ? `UISP ${a.uispAzimuth}°` : a.suggested ? `clienti ~${a.suggested.azimuth}°` : '°'} onInput=${(e) => setAz(e.target.value)} />
        ${a.suggested && a.azimuth == null ? html`<button type="button" class="small-btn" onClick=${() => setAz(a.suggested.azimuth)}>usa ${a.suggested.azimuth}°</button>` : null}
      </div>
    `,
    tilt: html`<input type="number" class="ant-num" min="-30" max="30" step="0.5" value=${tilt} placeholder="°" onInput=${(e) => setTilt(e.target.value)} />`,
    save: html`<${BusyButton} className="small-btn" onClick=${save}>Salva<//>`,
  };
}

function AntennaTr({ a, lib }) {
  const c = useAntennaCells(a, lib);
  return html`
    <tr>
      <td data-label="AP">${c.ap}</td>
      <td data-label="Antenna">${c.antenna}</td>
      <td data-label="Azimut">${c.azimuth}</td>
      <td data-label="Tilt (giù +)">${c.tilt}</td>
      <td>${c.save}</td>
    </tr>
  `;
}

/**
 * Antenne degli AP: the makers' radiation patterns (Ubiquiti, RF elements) and, for every AP, the
 * antenna, azimuth and tilt the coverage model uses. UISP rarely knows the azimuth and never which
 * horn is on a Rocket: the admin says it here (the customers suggest the azimuth).
 */
export function AntennasTab() {
  const [s, error, reload] = usePolled(() => api('/api/admin/antennas'), (d) => d.import?.running, 2000);
  const [onlyTodo, setOnlyTodo] = useState(true);
  const todo = (a) => a.customers >= 3 && ((a.azimuth == null && a.uispAzimuth == null) || (a.external && !a.antennaId));
  const rows = useMemo(() => (s ? (onlyTodo ? s.aps.filter(todo) : s.aps).slice(0, 300) : []), [s, onlyTodo]);
  if (error) return html`<${Notice} kind="bad">${error}<//>`;
  if (!s) return html`<p class="muted">Caricamento…</p>`;
  const imp = s.import ?? {};
  const lib = s.library ?? [];
  const download = async () => {
    if (!confirm('Il server scarica i diagrammi di radiazione pubblicati dai costruttori: Ubiquiti airMAX (27 file da dl.ui.com, circa 0,7 MB) e RF elements (horn, settori e parabole: 1 file da rfelements.com, 135 KB). Restano sul server, non nel codice. Procedo?')) return;
    await api('/api/admin/antennas/import', { method: 'POST', body: {} });
    await reload();
  };
  const missing = s.aps.filter(todo).length;
  return html`
    <div>
      <div class="cov-figures">
        <div class=${`cov-figure ${lib.length ? 'on' : ''}`}><small>Diagrammi</small><b>${lib.length || '—'}</b><span>${lib.length ? `${lib.filter((p) => p.vendor === 'Ubiquiti').length} Ubiquiti, ${lib.filter((p) => p.vendor === 'RF elements').length} RF elements` : 'da scaricare'}</span></div>
        <div class=${`cov-figure ${missing ? 'warn' : 'on'}`}><small>AP da completare</small><b>${missing}</b><span>con almeno 3 clienti</span></div>
      </div>
      ${imp.running ? html`<${Notice}>Scaricamento… (${imp.done}/${imp.total})<//>` : imp.error ? html`<${Notice} kind="bad">${imp.error}<//>` : null}
      <div class="row">
        <${BusyButton} disabled=${imp.running} onClick=${download}>${lib.length ? 'Aggiorna i diagrammi' : 'Scarica i diagrammi delle antenne'}<//>
        <label class="check small"><input type="checkbox" checked=${onlyTodo} onChange=${(e) => setOnlyTodo(e.target.checked)} /> Solo gli AP da completare</label>
      </div>
      ${rows.length
        ? html`<div class="table-wrap">
            <table>
              <thead><tr><th>AP</th><th>Antenna</th><th>Azimut</th><th>Tilt (giù +)</th><th></th></tr></thead>
              <tbody>${rows.map((a) => html`<${AntennaTr} key=${a.id} a=${a} lib=${lib} />`)}</tbody>
            </table>
          </div>`
        : html`<p class="muted">${onlyTodo ? 'Tutti gli AP con clienti hanno azimut e antenna.' : 'Nessun AP.'}</p>`}
      <p class="small muted">Con antenna e azimut la copertura usa il diagramma vero (orizzontale; anche verticale se indichi il tilt meccanico: quello elettrico è già nel diagramma). L’azimut suggerito è il centro dell’arco dei clienti collegati: confermalo solo se torna con l’antenna reale. IA-AP segnala gli AP senza azimut e i Rocket senza antenna indicata.</p>
    </div>
  `;
}

