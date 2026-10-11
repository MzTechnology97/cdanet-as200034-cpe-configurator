import { api } from '../api.js';
import { h, toast } from '../dom.js';
import { createMap, drawFresnelLink, fit, legend, pointPicker, popup, simulationOverlay, towards, MAP_COLORS as C } from '../map.js';
import { openLink3d, openSimulation3d } from '../map3d.js';
import { html, reactView, useEffect, useRef, useState } from '../react.js';
import { Badge, BusyButton, Card, Dom, Field, fmtDate, Notice, PageHead, Segmented, Table } from '../ui.js';
import { estimateCell, loadCell, osmLink, RATING } from './coverage.js';
import { AccuracyTab, AntennasTab, TerrainTab } from './coverage-cards.js';
import { ALT_FROM, bearing, DECLINATION_DEG, dec, km, linkFacts, MAX_MAST_M, parseCoords, profileChart, signalBar } from './coverage-link.js';

// the link helpers lived here: other pages may still import them from this module
export { DECLINATION_DEG, linkFacts, parseCoords, profileChart, signalBar };

/**
 * Copertura for admins: every AP on the map, one search box (address, coordinates, AP name or a
 * click on the map), the APs ranked for the point, the link to one of them docked on the map (as in
 * UISP Design) and a radio simulation of each AP. Installers keep their restricted page.
 */
const STATE_COLOR = { ok: '#14b8a6', degraded: '#f59e0b', down: '#dc2626' };
const RATING_COLOR = { buono: '#16a34a', possibile: '#f59e0b', 'senza stima': '#64748b', improbabile: '#dc2626', 'non attivo': '#dc2626' };
/** Signal scale of the simulation, from excellent to unusable. */
const SCALE = [
  [-60, '#15803d', 'oltre −60 dBm'],
  [-65, '#22c55e', '−60…−65'],
  [-70, '#a3e635', '−65…−70'],
  [-75, '#facc15', '−70…−75'],
  [-80, '#f97316', '−75…−80'],
  [-999, '#dc2626', 'sotto −80'],
];
const scaleColor = (dbm) => SCALE.find(([min]) => dbm >= min)[1];
/** Capacity scale of the simulation (downlink of the radio link), Mbit/s. */
const CAP_SCALE = [
  [150, '#15803d', 'oltre 150 Mbit/s'],
  [100, '#22c55e', '100–150'],
  [50, '#a3e635', '50–100'],
  [25, '#facc15', '25–50'],
  [10, '#f97316', '10–25'],
  [-1, '#dc2626', 'sotto 10'],
];
const capColor = (mbps) => CAP_SCALE.find(([min]) => mbps >= min)[1];
const ERR_COLOR = (e) => (Math.abs(e) <= 6 ? '#16a34a' : Math.abs(e) <= 12 ? '#f59e0b' : '#dc2626');
const KO = { no_signal: 'nessun segnale', no_link: 'non si aggancia', obstacles: 'ostacoli' };
const MODE_NAME = { dbm: 'segnale', cap: 'capacità del collegamento', eve: 'velocità la sera' };
const VERDICT = {
  buono: ['Copertura probabile', 'good'],
  possibile: ['Copertura da verificare', 'warn'],
};
const LINK_VERDICT = (p) => ({ clear: ['Linea libera', 'good'], fresnel: ['Fresnel invasa', 'warn'], blocked: [p.buildings ? 'Ostruita da edifici' : 'Ostruita dal terreno', 'bad'] })[p.verdict];
/** Usable cell of a simulation: below the minimum by more than 5 dB, or hidden by a hill under it, stays empty. */
const usable = (d) => (c) => c.dbm >= d.minDbm - 5 && !(c.blocked && c.dbm < d.minDbm);
const scaleFor = (d, mode) => (mode === 'dbm' ? SCALE.filter(([min]) => min >= d.minDbm - 5) : CAP_SCALE);
const freeFresnel = (p) => (p.worst ? Math.max(0, Math.round((100 * p.worst.clearanceM) / (p.worst.fresnel60M / 0.6 || 1))) : 100);

/**
 * The Leaflet map of the page, created once: layers for every AP, the checked point, the link, the
 * simulation and the real customers. [handlers] (always the latest): onPick(lat, lon), view3d().
 * Returns a ref to a promise of the controller (null when the page went away).
 */
function useNetworkMap(elRef, handlers) {
  const ctl = useRef(Promise.resolve(null));
  const hs = useRef(handlers);
  hs.current = handlers;
  useEffect(() => {
    let gone = false;
    const ready = createMap(elRef.current, { zoom: 9 }).then((map) => {
      if (!map || gone) return null;
      const L = window.L;
      const c = { map, L, sim: L.layerGroup().addTo(map), base: L.layerGroup().addTo(map), point: L.layerGroup().addTo(map), link: L.layerGroup().addTo(map), real: L.layerGroup(), ko: L.layerGroup() };
      // the first click places the point; then the map moves freely and the point is dragged
      c.picker = pointPicker(map, (la, lo) => hs.current.onPick(la, lo));
      // the 3D button of the map: the APs, the simulation and the link shown here
      map.cda3d = () => hs.current.view3d();
      setTimeout(() => map.invalidateSize(), 200);
      return c;
    });
    ctl.current = ready;
    return () => {
      gone = true;
      ready.then((c) => c?.map.remove()).catch(() => {});
    };
  }, []);
  return ctl;
}

/** The figures of a side of the dock. */
const Fact = ({ label, value, sub }) => html`<div class="dock-fact"><small>${label}</small><b>${value}</b>${sub ? html`<span>${sub}</span>` : null}</div>`;

/** The dock: AP (what UISP says) | the link | the CPE to install (what can be changed). */
function LinkDock({ link, point, cpe, cpeModels, height, onCpe, onHeight, on3d, onClose, dockRef }) {
  const { p, a } = link;
  const first = p.chart[0];
  const last = p.chart[p.chart.length - 1];
  const tilt = (Math.atan2(last.los - first.los, p.distanceM) * 180) / Math.PI;
  const az = p.ap.lat != null ? bearing([point.la, point.lo], [p.ap.lat, p.ap.lon]) : a.bearing;
  const e = a.estimate ?? null;
  const noise = a.load?.noiseDbm ?? null;
  const verdict = LINK_VERDICT(p);
  const hM = height || first.los - first.ground;
  const cap = e?.capacityMbps ?? null;
  return html`
    <div class="link-dock" ref=${dockRef}>
      <div class="dock-grid">
        <section class="dock-side">
          <div class="dock-title"><span class="dock-tag ap">AP</span><b>${a.name || a.id}</b></div>
          <div class="small muted">${[a.model, a.ssid].filter(Boolean).join(' · ')}</div>
          <div class="dock-facts">
            <${Fact} label="Frequenza" value=${a.frequency ? `${a.frequency} MHz` : '—'} />
            <${Fact} label="Clienti" value=${a.stations ?? '—'} sub=${a.load?.level ? `sera: ${a.load.level}` : null} />
            <${Fact} label="Antenna" value=${p.apAntenna ? `${p.apAntenna.aboveGroundM} m` : '—'} sub=${p.apAntenna ? `${p.apAntenna.altitude} m s.l.m.` : null} />
            <${Fact} label="Rumore" value=${noise != null ? `${noise} dBm` : '—'} />
          </div>
        </section>
        <section class="dock-mid">
          <div class="dock-title"><${Badge} kind=${verdict[1]}>${verdict[0]}<//><span class="small muted">${km(p.distanceM)} · Fresnel libera ${freeFresnel(p)}%</span></div>
          <div class="dock-cap"><span>Capacità stimata</span><b>${cap == null ? '—' : `${cap} Mbit/s`}</b></div>
          ${e?.eveningMbps != null ? html`<div class="small muted">La sera, condivisa con gli altri clienti dell’AP: ~${e.eveningMbps} Mbit/s</div>` : null}
          <div class="cap-bar"><span style=${{ width: `${cap == null ? 0 : Math.min(100, (cap / 400) * 100)}%` }}></span></div>
          ${e?.signalDbm != null && noise != null ? html`<div class="small muted">SNR atteso ${e.signalDbm - noise} dB</div>` : null}
          <${Dom} className="dock-chart" make=${() => profileChart(p)} deps=${[p]} />
          ${p.ap.lat != null ? html`<button type="button" class="small-btn dock-3d" onClick=${on3d}>Vista 3D</button>` : null}
        </section>
        <section class="dock-side">
          <div class="dock-title"><span class="dock-tag cpe">CPE</span><b>${point.label?.split(',')[0] ?? 'Punto'}</b></div>
          <${Field} label="Modello">
            <select value=${cpe} onChange=${(ev) => onCpe(ev.target.value)}>
              <option value="auto">Consigliata per ogni AP</option>
              ${cpeModels.map((m) => html`<option key=${m.id} value=${m.id}>${m.name} · ${m.gainDbi} dBi</option>`)}
            </select>
          <//>
          <div class="dock-facts">
            <div class="dock-fact">
              <small>Altezza</small>
              <div class="stepper">
                <button type="button" aria-label="Più bassa" onClick=${() => onHeight(Math.max(1, Math.round(hM - 1)))}>−</button>
                <b>${Math.round(hM)} m</b>
                <button type="button" aria-label="Più alta" onClick=${() => onHeight(Math.min(60, Math.round(hM + 1)))}>+</button>
              </div>
            </div>
            <${Fact} label="Puntamento" value=${`${Math.round(az)}°`} sub=${`magnetico ${Math.round((az - DECLINATION_DEG + 360) % 360)}°`} />
            <${Fact} label="Inclinazione" value=${`${tilt >= 0 ? '+' : ''}${dec(tilt)}°`} />
          </div>
          ${p.roofM
            ? html`<div class="small muted">Sul tetto: edificio di ${p.roofM} m, antenna a ${dec(p.mountedM)} m dal suolo</div>`
            : p.mountedM > hM + 0.4
              ? html`<div class="small muted">Sopra gli ostacoli vicini: antenna a ${dec(p.mountedM)} m dal suolo</div>`
              : null}
          <${Dom} make=${() => signalBar(e)} deps=${[e]} />
        </section>
      </div>
      <button type="button" class="dock-close" aria-label="Chiudi" onClick=${onClose}>×</button>
    </div>
  `;
}

/** The link in detail under the map: figures, the critical point, the profile and its legend. */
function LinkDetails({ link, point, on3d }) {
  const { p, a } = link;
  const verdict = { clear: ['Visibilità libera', 'good'], fresnel: ['Linea libera ma zona di Fresnel invasa', 'warn'], blocked: [p.buildings ? 'Linea ostruita da edifici' : 'Linea ostruita dal terreno', 'bad'] }[p.verdict];
  return html`
    <${Card}>
      <div class="link-head">
        <h2>Collegamento con ${a.name}</h2>
        <${Badge} kind=${verdict[1]}>${verdict[0]}<//>
        ${p.ap.lat != null ? html`<button type="button" class="small-btn" onClick=${on3d}>Vista 3D</button>` : null}
      </div>
      <${Dom} make=${() => linkFacts(p, [point.la, point.lo], a.estimate)} deps=${[p, a]} />
      <p class="small">
        ${p.worst
          ? `Punto critico a ${km(p.worst.d)}: margine ${dec(p.worst.clearanceM)} m sulla linea di vista (per il 60% della zona di Fresnel ne servono ${dec(p.worst.fresnel60M)}).`
          : 'Linea di vista e zona di Fresnel libere su tutto il collegamento.'}
        ${p.verdict === 'clear' || !(p.raiseCpeM > 0) ? '' : p.raiseCpeM <= MAX_MAST_M ? ` Alzando la CPE di ${dec(p.raiseCpeM)} m si libera.` : ` Non basta un palo di ${MAX_MAST_M} m: scegli un altro AP.`}
      </p>
      ${p.apAntenna
        ? html`<p class="small">
            Antenna dell’AP a ${p.apAntenna.altitude} m s.l.m., ${p.apAntenna.aboveGroundM} m sopra il suolo: ${ALT_FROM[p.apAntenna.from] ?? 'altezza predefinita'}${p.apAntenna.reported !== null ? ` (in UISP: ${p.apAntenna.reported} m)` : ''}. Se l’antenna è più alta, correggi l’altitudine in UISP.
          </p>`
        : null}
      ${p.ap.lat != null
        ? html`<p class="small muted">Sulla mappa: il collegamento e la sua prima zona di Fresnel (allargata per essere visibile, la forma è quella reale), verde dove è libera, arancione dove terreno o ostacoli entrano nel 60% della zona, rosso dove coprono la linea di vista.</p>`
        : null}
      <${Dom} make=${() => profileChart(p)} deps=${[p]} />
      <${Dom}
        make=${() =>
          legend([
            ['#a8a29e', 'terreno (con la curvatura terrestre)'],
            ['#78716c', 'edifici'],
            ['#4d7c0f', 'alberi'],
            ['#2563eb', 'linea di vista'],
            ['#38bdf8', 'prima zona di Fresnel'],
            ['#f59e0b', 'limite del 60%'],
          ])}
      />
      <p class="small muted">
        ${p.terrainSource === 'tinitaly'
          ? 'Terreno TINITALY (10 m); edifici dalle sagome di OpenStreetMap e alberi con la loro altezza dove importati (Terreno e ostacoli), altrimenti dalla mappa ESA con le altezze medie. Cambia l’altezza della CPE e il collegamento si aggiorna.'
          : 'Modello del terreno SRTM (circa 30 m): qui non sono scaricati terreno a 10 m, edifici e alberi. Cambia l’altezza della CPE e il collegamento si aggiorna.'}
      </p>
    <//>
  `;
}

/** The radio simulation of one AP: what is drawn on the map, the figures and how to read them. */
function SimulationPanel({ sim, mode, onMode, onClear, on3d }) {
  if (sim.loading) return html`<p class="small muted">Simulazione in corso…</p>`;
  if (sim.error) return html`<${Notice} kind="bad">${sim.error}<//>`;
  const d = sim.d;
  if (!d.cells.length) {
    return html`<${Notice} kind="warn">
      ${d.ap.name}: simulazione non possibile, ${d.customers ? 'troppo pochi clienti con segnale e posizione' : 'nessun cliente con posizione'} per stimare il segnale.
      ${' '}<button type="button" class="small-btn" onClick=${onClear}>Togli simulazione</button>
    <//>`;
  }
  const n = d.cells.length;
  const good = d.cells.filter((c) => c.dbm >= d.minDbm).length;
  const fast = d.cells.filter((c) => c.dbm >= d.minDbm && (c.cap ?? 0) >= 50).length;
  const evening = d.eveningShare != null ? d.cells.filter((c) => c.dbm >= d.minDbm && (c.cap ?? 0) * d.eveningShare >= 30).length : null;
  const modes = [['dbm', 'Segnale'], ...(d.capacity ? [['cap', 'Capacità']] : []), ...(d.capacity && d.eveningShare != null ? [['eve', 'Velocità la sera']] : [])];
  return html`
    <div class="sim-info">
      <div class="sim-head">
        <b>Simulazione ${d.theoretical ? 'teorica ' : ''}di ${d.ap.name}${d.cpe ? ` con ${d.cpe.name}` : ''}</b>
        <span class="btns">
          <button type="button" class="small-btn" onClick=${on3d}>Vista 3D</button>
          <button type="button" class="small-btn" onClick=${onClear}>Togli simulazione</button>
        </span>
      </div>
      <div class="cov-figures">
        <div class="cov-figure"><small>Sopra ${d.minDbm} dBm</small><b>${Math.round((100 * good) / n)}%</b><span>dell’area, raggio ${km(d.radiusM)}</span></div>
        ${d.capacity ? html`<div class="cov-figure"><small>Almeno 50 Mbit/s</small><b>${Math.round((100 * fast) / n)}%</b><span>capacità del collegamento</span></div>` : null}
        ${evening !== null ? html`<div class="cov-figure"><small>Almeno 30 Mbit/s la sera</small><b>${Math.round((100 * evening) / n)}%</b><span>tempo radio libero ${Math.round(d.eveningShare * 100)}%</span></div>` : null}
        <div class="cov-figure"><small>Calibrazione</small><b>${d.theoretical ? 'teorica' : d.customers}</b><span>${d.theoretical ? 'nessun cliente da cui calibrare' : `${d.customers === 1 ? 'cliente' : 'clienti'}${d.ignored ? `, ${d.ignored} esclusi` : ''}`}</span></div>
      </div>
      ${modes.length > 1 ? html`<${Segmented} label="Mostra" options=${modes} value=${mode} onChange=${onMode} />` : null}
      <${Dom} make=${() => legend(scaleFor(d, mode).map(([, color, text]) => [color, text]))} deps=${[d, mode]} />
      ${d.load ? html`<div class="small">Carico serale dell’AP: <${Dom} className="dom-inline" make=${() => loadCell(d.load)} deps=${[d]} /></div>` : null}
      <div class=${d.theoretical ? 'notice warn' : 'small muted'}>
        Segnale atteso per una CPE nuova: potenza irradiata dell’AP e guadagno della CPE (Impostazioni server → Simulazione radio), spazio libero${d.antenna ? ', diagramma dell’antenna (azimut da UISP)' : ''}${d.terrain
          ? ', terreno, edifici e alberi tra ogni punto e l’AP (dove scaricati in Terreno e ostacoli)'
          : ' (terreno non disponibile: le colline non sono considerate)'}.
        ${' '}${d.theoretical
          ? 'Stima teorica, margine ±8 dB: l’AP non ha ancora clienti con segnale da cui calibrarla.'
          : 'I clienti già collegati correggono la teoria, con un peso che cresce con il loro numero: pochi clienti, stima vicina alla teoria.'}
        ${d.capacity ? ' Capacità: dal segnale stimato con la curva segnale → capacità delle CPE reali della rete (e di come va questo AP); è la velocità del collegamento radio, la sera condivisa con gli altri clienti dell’AP.' : ''}
        ${d.eveningShare != null ? ` Velocità la sera: la capacità per la parte di tempo radio che l’AP ha libera al picco serale (${Math.round(d.eveningShare * 100)}%, mai meno della parte equa tra i suoi clienti).` : ''}
        ${` Area vuota: segnale sotto ${d.minDbm - 5} dBm o AP nascosto da una collina. Colori tenui: stima poco affidabile o collina in mezzo (da verificare). Tratteggio: settore dell’antenna o area già servita. Per un punto preciso usa Collegamento.`}
        ${d.antenna ? '' : ' Antenna e azimut dell’AP non sono indicati: la stima è uguale in tutte le direzioni (per questo può sembrare un cerchio). Indicali in Antenne degli AP per il fascio vero.'}
      </div>
    </div>
  `;
}

/** The answer for the point: the verdict in evidence, then the APs ranked by the server. */
function Results({ r, point, onLink, onSimulate }) {
  const useful = r.aps.filter((a) => a.rating !== 'improbabile' && a.rating !== 'non attivo');
  const others = r.aps.filter((a) => !useful.includes(a));
  const best = useful[0] ?? r.aps[0];
  const [title, tone] = best ? (VERDICT[best.rating] ?? ['Copertura improbabile', 'bad']) : ['Nessun AP', 'bad'];
  const columns = [
    { label: 'Valutazione', render: (a) => (a.rating ? html`<${Badge} kind=${RATING[a.rating][1]}>${RATING[a.rating][0]}<//>` : '—') },
    { label: 'AP', render: (a) => html`<div><b>${a.name || a.id}</b><div class="small muted">${[a.ssid, a.siteName].filter(Boolean).join(' · ')}</div></div>` },
    { label: 'Distanza', render: (a) => km(a.distanceM) },
    { label: 'Puntamento', render: (a) => html`<span class="bearing"><span class="arrow" style=${{ transform: `rotate(${a.bearing}deg)` }}>↑</span> ${a.bearing}° ${a.direction}</span>` },
    {
      label: 'CPE',
      render: (a) =>
        a.cpe
          ? html`<div><b>${a.cpe.name}</b><div class="small muted">${a.cpe.gainDbi} dBi${a.cpe.auto ? (a.cpe.proposed ? ' · consigliata' : ` · nessuna arriva a ${r.goodSignalDbm} dBm: di riferimento`) : ' · scelta'}</div></div>`
          : '—',
    },
    {
      label: 'Segnale stimato',
      render: (a) => html`<div>
        <${Dom} make=${() => estimateCell(a.estimate)} deps=${[a]} />
        ${a.failures ? html`<div class="small">${a.failures} ${a.failures === 1 ? 'installazione fallita' : 'installazioni fallite'} qui vicino verso questo AP</div>` : null}
      </div>`,
    },
    { label: 'Carico (20–23)', render: (a) => html`<${Dom} make=${() => loadCell(a.load)} deps=${[a]} />` },
    { label: 'Client', render: (a) => a.stations ?? '—' },
    { label: 'Frequenza', render: (a) => (a.frequency ? `${a.frequency} MHz` : '—') },
    {
      label: '',
      render: (a) => html`<div class="btns ap-actions">
        <button type="button" class="small-btn" onClick=${(e) => (e.stopPropagation(), onSimulate(a.id))}>Simula</button>
        <button type="button" class="small-btn" onClick=${(e) => (e.stopPropagation(), onLink(a))}>Collegamento</button>
      </div>`,
    },
  ];
  return html`
    <${Card}>
      <h2>AP consigliati per il punto</h2>
      <p class="small muted">${point.label} · ${point.la.toFixed(5)}, ${point.lo.toFixed(5)} · <a href=${osmLink(point.la, point.lo)} target="_blank" rel="noopener">apri su OpenStreetMap</a></p>
      ${r.aps.length
        ? html`
            ${best
              ? html`<div class=${`cov-verdict ${tone}`}>
                  <div>
                    <div class="cov-verdict-title">${title}</div>
                    <div>Il migliore è <b>${best.name}</b>, a ${km(best.distanceM)}${best.estimate?.signalDbm != null ? `, segnale stimato ${best.estimate.signalDbm} dBm` : ', senza stima del segnale'}${best.estimate?.eveningMbps != null ? `, la sera ~${best.estimate.eveningMbps} Mbit/s` : ''}.</div>
                  </div>
                  <div class="btns">
                    <button type="button" class="small-btn" onClick=${() => onLink(best)}>Collegamento</button>
                    <button type="button" class="small-btn" onClick=${() => onSimulate(best.id)}>Simula</button>
                  </div>
                </div>`
              : null}
            ${useful.length ? html`<${Table} columns=${columns} rows=${useful} onRow=${onLink} />` : html`<${Notice} kind="warn">Nessun AP utilizzabile da qui: tutti quelli nel raggio sono improbabili o spenti.<//>`}
            ${others.length
              ? html`<details class="more-aps">
                  <summary>Altri ${others.length} AP nel raggio (segnale stimato insufficiente o non attivi)</summary>
                  <${Table} columns=${columns} rows=${others} onRow=${onLink} />
                </details>`
              : null}
          `
        : html`<${Notice} kind="warn">
            ${r.hiddenWeak
              ? `Nessun AP con segnale stimato migliore di ${r.hideBelowDbm} dBm: ${r.hiddenWeak} ${r.hiddenWeak === 1 ? 'AP più debole non mostrato' : 'AP più deboli non mostrati'} (soglia in Impostazioni server → Copertura per gli installatori, −100 = tutti).`
              : `Nessun AP con posizione entro ${r.maxKm} km da questo punto.`}
          <//>`}
      <p class="small muted">
        ${r.inRange} AP valutati entro ${r.maxKm} km${r.hiddenWeak ? `, ${r.hiddenWeak} non mostrati perché più deboli di ${r.hideBelowDbm} dBm (Impostazioni server)` : ''}${r.inRange - (r.hiddenWeak ?? 0) > r.aps.length ? ` (mostrati i ${r.aps.length} migliori)` : ''}, ordinati per segnale stimato (minimo per il collaudo ${r.minSignalDbm} dBm). La stima viene dalle CPE già collegate a ogni AP; il collegamento usa il terreno e l’altezza della CPE indicata.
      </p>
    <//>
  `;
}

const TABS = [
  ['accuracy', 'Affidabilità della stima'],
  ['terrain', 'Terreno e ostacoli'],
  ['antennas', 'Antenne degli AP'],
];

function CoveragePage() {
  const mapEl = useRef(null);
  const dockRef = useRef(null);
  const linkCardRef = useRef(null);
  const [query, setQuery] = useState('');
  const [choices, setChoices] = useState(null);
  const [km_, setKm] = useState(20);
  const [height, setHeight] = useState(6);
  const [cpe, setCpe] = useState('auto');
  const [cpeModels, setCpeModels] = useState([]);
  const [aps, setAps] = useState([]);
  const [mapNote, setMapNote] = useState('');
  const [point, setPoint] = useState(null);
  const [result, setResult] = useState(null); // { r } | { loading } | { error }
  const [link, setLink] = useState(null); // { p, a }
  const [sim, setSim] = useState(null); // { d } | { loading } | { error }
  const [simMode, setSimMode] = useState('dbm');
  const [showReal, setShowReal] = useState(false);
  const [showKo, setShowKo] = useState(false);
  const [tab, setTab] = useState('accuracy');
  const [gpsBusy, setGpsBusy] = useState(false);
  // what the map and the 3D view need to read without waiting for a render
  const cur = useRef({});
  cur.current = { height, cpe, km: km_, point, link, aps };
  const view3d = useRef({ sim: null, link: null });
  const accuracy = useRef(null);

  const ctl = useNetworkMap(mapEl, {
    onPick: (la, lo) => check(la, lo, 'Punto scelto sulla mappa'),
    view3d: () => ({ aps: cur.current.aps, sim: view3d.current.sim, link: view3d.current.link }),
  });

  // CPE height: starts from the default of Impostazioni server, changed for every check
  useEffect(() => {
    api('/api/admin/pointing/config')
      .then((c) => setHeight(c.cpeHeightM))
      .catch(() => {});
  }, []);

  // every AP on the map, with "Simula copertura" in its popup
  useEffect(() => {
    api('/api/network/status')
      .then(async (d) => {
        const list = [...d.pops.flatMap((p) => p.aps.map((a) => ({ ...a, pop: p.name }))), ...d.apsWithoutPop.map((a) => ({ ...a, pop: null }))].filter((a) => a.lat != null && a.lon != null);
        setAps(list);
        const c = await ctl.current;
        if (!c) return;
        c.base.clearLayers();
        const pts = list.map((a) => {
          const btn = h('button', { type: 'button', class: 'small-btn', onclick: () => (c.map.closePopup(), simulate(a.id)) }, 'Simula copertura');
          return c.L.circleMarker([a.lat, a.lon], { radius: 5, color: STATE_COLOR[a.state] ?? '#64748b', weight: 2, fillOpacity: 0.85, bubblingMouseEvents: false })
            .bindTooltip(a.name)
            .bindPopup(h('div', {}, popup(a.name, a.ssid && a.ssid !== a.name ? a.ssid : null, a.pop ? `POP ${a.pop}` : 'AP senza POP', a.model), h('div', { class: 'btns' }, btn)))
            .addTo(c.base);
        });
        setMapNote(`${pts.length} AP sulla mappa. Il primo clic sulla mappa sceglie il punto da verificare; poi la mappa si sposta liberamente e il punto si sposta trascinandolo (o con Nuovo punto sulla mappa). Clic su un AP per simularne la copertura.`);
        if (pts.length && !cur.current.point) fit(c.map, pts);
      })
      .catch((e) => setMapNote(`AP non disponibili: ${e.message}`));
  }, []);

  /** Nearest APs ranked for the point, drawn on the map with the lines towards them. */
  async function check(la, lo, label, over = {}) {
    const o = { ...cur.current, ...over };
    const p = { la, lo, label };
    setPoint(p);
    setResult({ loading: true });
    let r;
    try {
      // every AP in range, already ranked by the server (50 is its maximum)
      const hM = Number(String(o.height).replace(',', '.'));
      r = await api(`/api/coverage?lat=${la}&lon=${lo}&limit=50&km=${o.km}${hM >= 0.5 && hM <= 100 ? `&height=${hM}` : ''}&cpe=${encodeURIComponent(o.cpe)}`);
    } catch (e) {
      setResult({ error: e.message });
      return;
    }
    if (r.cpeModels?.length) setCpeModels((m) => (m.length ? m : r.cpeModels));
    setResult({ r });
    const useful = r.aps.filter((a) => a.rating !== 'improbabile' && a.rating !== 'non attivo');
    const c = await ctl.current;
    if (c) {
      c.point.clearLayers();
      c.link.clearLayers();
      const layers = [c.picker.set(la, lo, c.point).bindPopup(popup(label, `${la.toFixed(5)}, ${lo.toFixed(5)}`, 'Trascina il punto per spostarlo'))];
      for (const a of useful) {
        const color = RATING_COLOR[a.rating] ?? '#64748b';
        c.L.polyline([[la, lo], [a.lat, a.lon]], { color, weight: a === useful[0] ? 4 : 2, dashArray: a === useful[0] ? null : '6 6', interactive: false }).addTo(c.point);
        layers.push(c.L.circleMarker([a.lat, a.lon], { radius: 7, color, weight: 3, fillOpacity: 0.2, interactive: false }).addTo(c.point));
      }
      fit(c.map, layers);
    }
    // the dock follows the check: the same AP again (another CPE or height), closed otherwise
    const again = o.link ? r.aps.find((x) => x.id === o.link.a.id) : null;
    if (again) await openLink(again, { point: p, height: o.height });
    else closeLink();
  }

  /** The link from the checked point to [a] (line of sight with the CPE height), docked on the map. */
  async function openLink(a, over = {}) {
    const o = { ...cur.current, ...over };
    if (!o.point) return;
    const hM = Number(String(o.height).replace(',', '.'));
    if (!(hM >= 0.5 && hM <= 100)) return toast('Altezza della CPE non valida (0,5–100 m)');
    try {
      const p = await api(`/api/pointing/profile?lat=${o.point.la}&lon=${o.point.lo}&apId=${encodeURIComponent(a.id)}&height=${hM}`);
      view3d.current.link = { from: [o.point.la, o.point.lo], label: o.point.label?.split(',')[0], p, apName: a.name || a.id };
      setLink({ p, a });
    } catch (e) {
      toast(`Collegamento con ${a.name}: ${e.message}`, 'bad');
    }
  }
  function closeLink() {
    view3d.current.link = null;
    setLink(null);
  }
  // the link on the map with its Fresnel zone, framed above the dock
  useEffect(() => {
    if (!link || !point) return;
    void ctl.current.then((c) => {
      if (!c || link.p.ap.lat == null) return;
      const below = (dockRef.current?.offsetHeight ?? 0) + 24;
      drawFresnelLink(c.map, c.link, [point.la, point.lo], link.p, { paddingTopLeft: [20, 20], paddingBottomRight: [20, below] });
    });
  }, [link]);

  /** Estimated signal of a new CPE all around one AP (from its customers), on the map. */
  async function simulate(apId) {
    setSim({ loading: true });
    setSimMode('dbm');
    try {
      const o = cur.current;
      const d = await api(`/api/admin/coverage/simulation?apId=${encodeURIComponent(apId)}${o.cpe !== 'auto' ? `&cpe=${encodeURIComponent(o.cpe)}` : ''}`);
      setSim({ d });
      const c = await ctl.current;
      if (c && d.cells.length && !o.point) c.map.fitBounds(c.L.latLng(d.ap.lat, d.ap.lon).toBounds(d.radiusM * 2.1));
    } catch (e) {
      setSim({ error: e.message });
    }
  }
  const clearSim = () => setSim(null);
  // the simulation on the map: one smooth image of the usable cells, the sector and the AP
  useEffect(() => {
    let alive = true;
    void ctl.current.then((c) => {
      if (!c || !alive) return;
      c.sim.clearLayers();
      view3d.current.sim = null;
      const d = sim?.d;
      if (!d?.cells.length) return;
      const ok = usable(d);
      const overlay = simulationOverlay(d, (cell) => (!ok(cell) ? null : simMode === 'cap' ? (cell.cap == null ? null : capColor(cell.cap)) : simMode === 'eve' ? (cell.cap == null ? null : capColor(cell.cap * d.eveningShare)) : scaleColor(cell.dbm))).addTo(c.sim);
      view3d.current.sim = { d, image: overlay.canvas, bounds: overlay.cellBounds, legendItems: scaleFor(d, simMode).map(([, color, text]) => ['scale', text, color]), title: `simulazione di ${d.ap.name}` };
      // learned: the area already served; theory: the sector of the antenna (azimuth from UISP)
      if (d.sector && (d.servedM || d.theoretical)) {
        const reach = d.servedM || d.radiusM;
        const pts = [[d.ap.lat, d.ap.lon]];
        for (let i = 0; i <= 24; i++) pts.push(towards(d.ap.lat, d.ap.lon, d.sector.center - d.sector.width / 2 + (d.sector.width * i) / 24, reach));
        c.L.polygon(pts, { color: '#0f172a', weight: 1.5, fill: false, dashArray: '4 5', interactive: false }).addTo(c.sim);
      }
      c.L.circleMarker([d.ap.lat, d.ap.lon], { radius: 8, color: '#0f172a', weight: 3, fillColor: '#ffffff', fillOpacity: 1, interactive: false }).addTo(c.sim);
    });
    return () => {
      alive = false;
    };
  }, [sim, simMode]);
  const sim3d = () => {
    const s = view3d.current.sim;
    if (s) openSimulation3d({ ...s, title: `3D · simulazione di ${s.d.ap.name} · ${MODE_NAME[simMode] ?? 'segnale'}` });
  };

  // the model on the real customers (last Affidabilità della stima): where it gets it right, the KOs
  const accuracyData = async () => (accuracy.current ??= (await api('/api/admin/coverage/accuracy')).last ?? {});
  useEffect(() => {
    void ctl.current.then(async (c) => {
      if (!c) return;
      c.real.clearLayers();
      if (!showReal) return c.map.removeLayer(c.real);
      const pts = (await accuracyData()).points ?? [];
      if (!pts.length) toast('Nessuna misura: avvia «Affidabilità della stima» qui sotto');
      for (const q of pts) {
        const err = q.estimateDbm - q.realDbm;
        c.L.circleMarker([q.lat, q.lon], { radius: 4, color: ERR_COLOR(err), weight: 1, fillOpacity: 0.8, bubblingMouseEvents: false })
          .bindPopup(popup(q.device, `AP ${q.ap}`, `reale ${q.realDbm} dBm · stimato ${q.estimateDbm} dBm`, `${err > 0 ? 'stima ottimista' : err < 0 ? 'stima pessimista' : 'esatta'} di ${Math.abs(err)} dB`))
          .addTo(c.real);
      }
      c.real.addTo(c.map);
    });
  }, [showReal]);
  useEffect(() => {
    void ctl.current.then(async (c) => {
      if (!c) return;
      c.ko.clearLayers();
      if (!showKo) return c.map.removeLayer(c.ko);
      for (const f of (await accuracyData()).failurePoints ?? []) {
        c.L.marker([f.lat, f.lon], { icon: c.L.divIcon({ className: 'ko-pin', html: '✕', iconSize: [16, 16] }) })
          .bindPopup(popup('Installazione fallita', KO[f.reason] ?? f.reason, f.ap ? `verso ${f.ap}` : null, fmtDate(f.at)))
          .addTo(c.ko);
      }
      c.ko.addTo(c.map);
    });
  }, [showKo]);

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
      (await ctl.current)?.map.setView([ap.lat, ap.lon], 13);
      return simulate(ap.id);
    }
    const list = await api(`/api/geocode?q=${encodeURIComponent(q)}`);
    if (!list.length) return setChoices([]);
    if (list.length === 1) return check(list[0].lat, list[0].lon, list[0].label);
    setChoices(list);
  };
  const gps = () => {
    if (!('geolocation' in navigator) || !window.isSecureContext) return toast('Il browser dà la posizione solo su HTTPS: usa l’indirizzo o le coordinate.');
    setGpsBusy(true);
    navigator.geolocation.getCurrentPosition(
      (p) => (setGpsBusy(false), check(p.coords.latitude, p.coords.longitude, `Posizione del dispositivo (±${Math.round(p.coords.accuracy)} m)`)),
      (err) => (setGpsBusy(false), toast(`Posizione non disponibile: ${err.message}`)),
      { enableHighAccuracy: true, timeout: 15000 },
    );
  };
  // another radius or CPE: the same point again
  const recheck = (over) => point && check(point.la, point.lo, point.label, over);
  const changeHeight = (v) => {
    setHeight(v);
    recheck({ height: v });
  };
  const show3dLink = () => link && point && openLink3d({ from: [point.la, point.lo], label: point.label?.split(',')[0], p: link.p, apName: link.a.name || link.a.id, others: aps });
  // a blocked customer of Affidabilità: its point, its CPE height, then its link
  const inspect = async (b) => {
    setHeight(b.cpeHeightM);
    const p = { la: b.lat, lo: b.lon, label: b.device };
    await check(b.lat, b.lon, b.device, { height: b.cpeHeightM, link: null });
    await openLink({ id: b.apId, name: b.ap }, { point: p, height: b.cpeHeightM });
    requestAnimationFrame(() => linkCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  return html`
    <div class="cov-page">
      <${PageHead} title="Copertura" subtitle="Verifica un punto, confronta gli AP e simula il segnale. Solo amministratori: gli installatori hanno la loro verifica, con i limiti impostati." />
      <${Card}>
        <h2>Verifica un punto</h2>
        <form class="row" onSubmit=${(e) => e.preventDefault()}>
          <input type="search" class="grow" placeholder="Indirizzo, coordinate (37.56, 14.27) o nome di un AP" autocomplete="off" value=${query} onInput=${(e) => setQuery(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && (e.preventDefault(), e.currentTarget.form.querySelector('.primary').click())} />
          <${BusyButton} className="primary" onClick=${search}>Cerca<//>
          <button type="button" disabled=${gpsBusy} onClick=${gps}>La mia posizione</button>
        </form>
        ${choices
          ? choices.length
            ? html`<div class="btns">${choices.map((c) => html`<button key=${`${c.lat},${c.lon}`} type="button" onClick=${() => (setChoices(null), check(c.lat, c.lon, c.label))}>${c.label}</button>`)}</div>`
            : html`<${Notice} kind="warn">Né indirizzo né AP trovati: prova ad aggiungere comune o CAP, oppure scrivi le coordinate.<//>`
          : null}
        <div class="row">
          <${Field} label="Cerca gli AP entro">
            <select value=${km_} onChange=${(e) => (setKm(Number(e.target.value)), recheck({ km: Number(e.target.value) }))}>${[5, 10, 15, 20].map((n) => html`<option key=${n} value=${n}>entro ${n} km</option>`)}</select>
          <//>
          <${Field} label="Altezza della CPE dal suolo (m)">
            <input type="number" min="0.5" max="100" step="0.5" inputmode="decimal" value=${height} onInput=${(e) => setHeight(e.target.value)} onChange=${(e) => recheck({ height: e.target.value })} />
          <//>
          <${Field} label="CPE da installare">
            <select value=${cpe} onChange=${(e) => (setCpe(e.target.value), recheck({ cpe: e.target.value }))}>
              <option value="auto">Consigliata per ogni AP</option>
              ${cpeModels.map((m) => html`<option key=${m.id} value=${m.id}>${m.name} · ${m.gainDbi} dBi</option>`)}
            </select>
          <//>
        </div>
        <p class="small muted">Scrivi un indirizzo, delle coordinate o il nome di un AP, oppure clicca sulla mappa. L’altezza della CPE vale per il collegamento di questo punto.</p>
      <//>
      <${Card}>
        <div class="link-head">
          <h2>Mappa della rete</h2>
          <label class="check small"><input type="checkbox" checked=${showReal} onChange=${(e) => setShowReal(e.target.checked)} /> Clienti reali: segnale vero contro stima</label>
          <label class="check small"><input type="checkbox" checked=${showKo} onChange=${(e) => setShowKo(e.target.checked)} /> Installazioni fallite</label>
        </div>
        <div class="map-stage">
          <div class="map map-tall" ref=${mapEl}></div>
          ${link && point
            ? html`<${LinkDock}
                link=${link}
                point=${point}
                cpe=${cpe}
                cpeModels=${cpeModels}
                height=${Number(String(height).replace(',', '.'))}
                dockRef=${dockRef}
                onCpe=${(v) => (setCpe(v), recheck({ cpe: v }))}
                onHeight=${changeHeight}
                on3d=${show3dLink}
                onClose=${closeLink}
              />`
            : null}
        </div>
        <${Dom}
          make=${() =>
            legend([
              [STATE_COLOR.ok, 'AP in funzione'],
              [STATE_COLOR.degraded, 'molte CPE offline'],
              [STATE_COLOR.down, 'non raggiungibile'],
              [C.point, 'punto verificato'],
              ['#16a34a', 'cliente: stima entro 6 dB'],
              ['#dc2626', 'cliente: stima sbagliata di oltre 12 dB'],
            ])}
        />
        <div class="map-tools">
          <p class="small muted">${mapNote}</p>
          <button type="button" class="small-btn" onClick=${async () => ((await ctl.current)?.picker.arm(), toast('Clicca sulla mappa nel nuovo punto'))}>Nuovo punto sulla mappa</button>
        </div>
        ${sim ? html`<${SimulationPanel} sim=${sim} mode=${simMode} onMode=${setSimMode} onClear=${clearSim} on3d=${sim3d} />` : null}
      <//>
      ${result?.loading ? html`<${Card}><p class="muted">Valutazione degli AP…</p><//>` : null}
      ${result?.error ? html`<${Notice} kind="bad">${result.error}<//>` : null}
      ${result?.r && point ? html`<${Results} r=${result.r} point=${point} onLink=${(a) => openLink(a)} onSimulate=${simulate} />` : null}
      <div ref=${linkCardRef}>${link && point ? html`<${LinkDetails} link=${link} point=${point} on3d=${show3dLink} />` : null}</div>
      <${Card} className="cov-tools">
        <${Segmented} label="Strumenti" options=${TABS} value=${tab} onChange=${setTab} />
        <div class="cov-tab">${tab === 'accuracy' ? html`<${AccuracyTab} onInspect=${inspect} />` : tab === 'terrain' ? html`<${TerrainTab} />` : html`<${AntennasTab} />`}</div>
      <//>
    </div>
  `;
}

export const adminCoverageView = () => reactView(CoveragePage);
