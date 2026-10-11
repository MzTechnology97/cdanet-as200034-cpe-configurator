import { api } from '../api.js';
import { toast } from '../dom.js';
import { createMap, drawOutages, fit, legend, MAP_COLORS as C } from '../map.js';
import { html, reactView, useEffect, useMemo, useRef, useState } from '../react.js';
import { Badge, BusyButton, Card, Dom, Field, fmtDate, Notice, PageHead, Table } from '../ui.js';
import { itemLabel, itemNames, picker } from './infra-picker.js';
import { myTelegramCard } from './my-telegram.js';

const KIND = { guasto_mt: ['Guasto MT', 'bad'], guasto_bt: ['Guasto BT', 'warn'], lavoro: ['Lavoro programmato', ''], altro: ['Interruzione', 'warn'] };
const local = (s) => (s ? s.replace('T', ' ').replace(/^(\d{4})-(\d{2})-(\d{2})/, '$3/$2/$1') : '—');
const dist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`);
const coords = (z) => `${z.lat.toFixed(4)}, ${z.lon.toFixed(4)}`;

/**
 * New area of interest: GPS of the device (with the address filled in), address search or typed
 * coordinates (with "address from coordinates"). [post] stores it (shared zone or personal zone);
 * [rules]: personal zones choose which outages notify (planned works off by default).
 */
function ZoneForm({ post, onDone, rules = false }) {
  const empty = { name: '', street: '', number: '', city: '', prov: '', cap: '', lat: '', lon: '', radius: 2, mt: true, bt: true, planned: false };
  const [f, setF] = useState(empty);
  const [where, setWhere] = useState('');
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const fillAddress = async (la, lo) => {
    const r = await api(`/api/geocode/reverse?lat=${la}&lon=${lo}`).catch(() => null);
    if (!r) return;
    setF((x) => ({ ...x, street: r.street, number: r.houseNumber, city: r.city, prov: r.province, cap: r.postcode, name: x.name.trim() ? x.name : [r.street, r.city].filter(Boolean).join(', ') }));
    setWhere(r.label);
  };
  const gps = async () => {
    if (!navigator.geolocation) throw new Error('Geolocalizzazione non disponibile in questo browser');
    if (!window.isSecureContext) throw new Error('Il GPS del browser funziona solo con la console in HTTPS');
    const p = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, (e) => rej(new Error(e.code === 1 ? 'Permesso di posizione negato' : 'Posizione non disponibile')), { enableHighAccuracy: true, timeout: 20000 }));
    setF((x) => ({ ...x, lat: p.coords.latitude.toFixed(6), lon: p.coords.longitude.toFixed(6) }));
    setWhere(`Precisione ±${Math.round(p.coords.accuracy)} m · ricerca indirizzo…`);
    await fillAddress(p.coords.latitude, p.coords.longitude);
  };
  const find = async () => {
    const q = [[f.street, f.number].filter(Boolean).join(' '), f.cap, f.city, f.prov].map((x) => x.trim()).filter(Boolean).join(', ');
    if (q.length < 3) throw new Error('Inserisci almeno via e città');
    const g = await api(`/api/geocode?q=${encodeURIComponent(q)}`);
    if (!g.length) throw new Error('Indirizzo non trovato');
    setF((x) => ({ ...x, lat: g[0].lat.toFixed(6), lon: g[0].lon.toFixed(6), name: x.name.trim() ? x.name : [x.street, x.city].map((v) => v.trim()).filter(Boolean).join(', ') }));
    setWhere(g[0].label);
  };
  const num = (v) => Number(String(v).replace(',', '.'));
  const add = async () => {
    const la = num(f.lat);
    const lo = num(f.lon);
    if (!f.lat || !f.lon || !Number.isFinite(la) || !Number.isFinite(lo)) throw new Error('Coordinate mancanti: usa il GPS, cerca l’indirizzo o inseriscile a mano');
    await post({ name: f.name.trim(), lat: la, lon: lo, radiusKm: Number(f.radius) || 2, ...(rules ? { notifyMt: f.mt, notifyBt: f.bt, notifyPlanned: f.planned } : {}) });
    toast('Zona aggiunta: entra nel prossimo controllo (entro 10 minuti)');
    setF(empty);
    setWhere('');
    await onDone();
  };
  const input = (k, props = {}) => html`<input value=${f[k]} onInput=${set(k)} ...${props} />`;
  return html`
    <div class="zone-form">
      <h3>Nuova zona</h3>
      <div class="row">
        <${Field} label="Nome">${input('name', { placeholder: 'es. Centro Enna, casa, frazione' })}<//>
        <${Field} label="Raggio (km)">${input('radius', { type: 'number', min: 0.2, max: 50, step: 0.5 })}<//>
      </div>
      <div class="btns"><${BusyButton} onClick=${gps}>Usa GPS di questo dispositivo<//></div>
      <div class="row">
        <${Field} label="Via">${input('street', { placeholder: 'Via Roma' })}<//>
        <${Field} label="Civico">${input('number', { placeholder: '12', inputmode: 'numeric' })}<//>
        <${Field} label="Città">${input('city', { placeholder: 'Enna' })}<//>
        <${Field} label="Provincia">${input('prov', { placeholder: 'EN', maxlength: 30 })}<//>
        <${Field} label="CAP">${input('cap', { placeholder: '94100', inputmode: 'numeric', maxlength: 5 })}<//>
      </div>
      <div class="btns"><${BusyButton} onClick=${find}>Cerca indirizzo<//></div>
      <div class="row">
        <${Field} label="Latitudine">${input('lat', { placeholder: '37.5670', inputmode: 'decimal' })}<//>
        <${Field} label="Longitudine">${input('lon', { placeholder: '14.2790', inputmode: 'decimal' })}<//>
      </div>
      ${rules
        ? html`<div class="btns">
            <span class="small muted">Avvisami di:</span>
            <label><input type="checkbox" checked=${f.mt} onChange=${set('mt')} /> guasti media tensione</label>
            <label><input type="checkbox" checked=${f.bt} onChange=${set('bt')} /> guasti bassa tensione</label>
            <label><input type="checkbox" checked=${f.planned} onChange=${set('planned')} /> lavori programmati</label>
          </div>`
        : null}
      <div class="btns">
        <${BusyButton} onClick=${() => fillAddress(num(f.lat), num(f.lon))}>Indirizzo dalle coordinate<//>
        <${BusyButton} className="primary" onClick=${add}>Aggiungi zona<//>
      </div>
      <p class="small muted">${where}</p>
    </div>
  `;
}

/** A button that shows a point on the page's own map (the outage or the zone), never an external site. */
const MapLink = ({ o, onMap, children }) => html`<button type="button" class="link" title="Mostra sulla mappa" onClick=${() => onMap(o)}>${children}</button>`;

const DeleteButton = ({ z, onDelete }) => html`<${BusyButton} className="danger" onClick=${async () => confirm(`Eliminare la zona ${z.name}?`) && (await onDelete(z))}>Elimina<//>`;

const ZonesTable = ({ zones, onDelete, onMap, owner = false }) => html`
  <${Table}
    rows=${zones}
    columns=${[
      ...(owner ? [{ label: 'Installatore', render: (z) => z.owner }] : []),
      { label: 'Nome', render: (z) => z.name },
      { label: 'Centro', render: (z) => html`<${MapLink} o=${z} onMap=${onMap}>${coords(z)}<//>` },
      { label: 'Raggio', render: (z) => `${z.radiusKm} km` },
      { label: '', render: (z) => html`<${DeleteButton} z=${z} onDelete=${onDelete} />` },
    ]}
  />
`;

/**
 * The user's own areas of interest, each with its rules: active or paused, and which outages notify
 * (app and personal Telegram). Changes are saved at once.
 */
function MyZones({ onMap }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const load = () => api('/api/outages/zones').then(setD, (e) => setError(e.message));
  useEffect(() => void load(), []);
  const save = async (z, patch) => {
    try {
      await api(`/api/outages/zones/${z.id.slice(1)}`, { method: 'PUT', body: patch });
    } catch (e) {
      toast(e.message, 'bad');
    }
    await load();
  };
  const del = async (z) => {
    await api(`/api/outages/zones/${z.id.slice(1)}`, { method: 'DELETE' });
    await load();
  };
  const rule = (z, key, label) => html`<label class="small"><input type="checkbox" checked=${z[key]} disabled=${z.paused} onChange=${(e) => save(z, { [key]: e.target.checked })} /> ${label}</label>`;
  return html`
    <${Card}>
      <h2>Le mie aree di interesse</h2>
      <p class="small muted">
        Luoghi che vuoi seguire, anche fuori dai POP/AP che ti sono assegnati (massimo ${d?.max ?? 20}). Per ognuna scegli quali avvisi ricevere sul telefono e su Telegram, oppure mettila in pausa: i guasti restano comunque visibili qui. I POP/AP potenzialmente impattati li vedi solo per quelli assegnati.
      </p>
      ${error ? html`<${Notice} kind="bad">${error}<//>` : null}
      ${d?.zones.length
        ? html`<${Table}
            rows=${d.zones}
            columns=${[
              { label: 'Zona', render: (z) => html`<div><strong>${z.name}</strong><div class="small muted"><${MapLink} o=${z} onMap=${onMap}>${coords(z)}<//> · ${z.radiusKm} km</div></div>` },
              { label: 'Ora', render: (z) => (z.activeCount ? html`<${Badge} kind="warn">${z.activeCount} ${z.activeCount === 1 ? 'interruzione' : 'interruzioni'}<//>` : html`<${Badge} kind="good">nessuna<//>`) },
              { label: 'Avvisi', render: (z) => html`<div class="btns">${rule(z, 'notifyMt', 'MT')}${rule(z, 'notifyBt', 'BT')}${rule(z, 'notifyPlanned', 'lavori')}</div>` },
              {
                label: '',
                render: (z) => html`<div class="btns">
                  ${z.paused ? html`<${Badge} kind="warn">in pausa<//>` : null}
                  <${BusyButton} onClick=${() => save(z, { paused: !z.paused })}>${z.paused ? 'Riattiva' : 'Metti in pausa'}<//>
                  <${DeleteButton} z=${z} onDelete=${del} />
                </div>`,
              },
            ]}
          />`
        : d
          ? html`<p class="small muted">Nessuna area: aggiungine una qui sotto.</p>`
          : null}
      <${ZoneForm} post=${(body) => api('/api/outages/zones', { method: 'POST', body })} onDone=${load} rules=${true} />
    <//>
  `;
}

/** Admin: POPs and APs straight from UISP (names, addresses, coordinates): pick the ones to monitor. */
function InfraCard({ onSaved }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  const [mode, setMode] = useState('all');
  const [count, setCount] = useState('');
  const load = () =>
    Promise.all([api('/api/admin/outages/infra'), api('/api/admin/outages/selection'), api('/api/admin/outages/config')]).then(
      ([inf, sel, cfg]) => {
        setD({ inf, sel, cfg });
        setMode(sel.selectionOnly ? 'only' : 'all');
      },
      (e) => setError(e.body?.error === 'uisp_not_configured' ? 'UISP non configurato: POP e AP arrivano da UISP (Connettori).' : e.message),
    );
  useEffect(() => void load(), []);
  // the tree of checkboxes (shared with Account), its choice kept between the renders
  const pick = useMemo(() => {
    if (!d) return null;
    const names = itemNames(d.inf, d.cfg.zones);
    for (const it of d.sel.items) if (!names.has(it.key)) names.set(it.key, it.name);
    const chosen = new Set(d.sel.items.map((i) => i.key));
    const p = picker({ inf: d.inf, chosen, cascade: true });
    const upd = () => setCount(`${[...chosen].filter((k) => k.startsWith('pop:')).length} POP · ${[...chosen].filter((k) => k.startsWith('ap:')).length} AP selezionati`);
    p.onChange = upd;
    upd();
    return { p, chosen, names, upd };
  }, [d]);
  if (error) return html`<${Card}><h2>POP e AP da UISP</h2><p class="small muted">${error}</p><//>`;
  if (!d || !pick) return null;
  const { inf, sel } = d;
  const live = new Set(itemNames(inf, []).keys());
  const gone = sel.items.filter((i) => !live.has(i.key));
  const selectAll = () => {
    for (const k of pick.names.keys()) if (!k.startsWith('z')) pick.chosen.add(k);
    pick.p.render();
    pick.upd();
  };
  const selectNone = () => {
    pick.chosen.clear();
    pick.p.render();
    pick.upd();
  };
  const save = async () => {
    if (mode === 'only' && !pick.chosen.size) throw new Error('Seleziona almeno un POP o un AP, oppure scegli "tutti"');
    await api('/api/admin/outages/selection', { method: 'PUT', body: { selectionOnly: mode === 'only', items: [...pick.chosen].map((key) => ({ key, name: pick.names.get(key) ?? key })) } });
    toast(mode === 'only' ? `Monitorati solo i ${pick.chosen.size} POP/AP selezionati` : 'Monitorati tutti i POP/AP di UISP');
    await Promise.all([load(), onSaved()]);
  };
  return html`
    <${Card}>
      <h2>POP e AP da UISP: ${inf.pops.length} POP · ${inf.pops.reduce((t, p) => t + p.aps.length, 0) + inf.apsWithoutPop.length} AP</h2>
      <p class="small muted">Elenco, nomi, indirizzi e coordinate sono importati da UISP a ogni controllo: per correggerli modifica il site o il dispositivo in UISP. Un AP senza posizione propria usa quella del suo POP.</p>
      ${inf.missing.pops.length || inf.missing.aps.length
        ? html`<${Notice} kind="warn">Senza posizione in UISP (non monitorabili): ${[...inf.missing.pops.map((n) => `POP ${n}`), ...inf.missing.aps.map((n) => `AP ${n}`)].join(', ')}. Impostala in UISP → Sites/Devices → Location.<//>`
        : null}
      <label class="check"><input type="radio" name="selmode" checked=${mode === 'all'} onChange=${() => setMode('all')} />Monitora tutti i POP e gli AP di UISP</label>
      <label class="check"><input type="radio" name="selmode" checked=${mode === 'only'} onChange=${() => setMode('only')} />Monitora solo quelli selezionati qui sotto</label>
      ${gone.length ? html`<${Notice} kind="warn">Selezionati ma non più presenti in UISP: ${gone.map((i) => i.name).join(', ')}.<//>` : null}
      <div class="btns"><button type="button" onClick=${selectAll}>Seleziona tutti</button><button type="button" onClick=${selectNone}>Nessuno</button><span class="small muted">${count}</span></div>
      <${Dom} make=${() => pick.p.el} deps=${[pick]} />
      <div class="btns"><${BusyButton} className="primary" onClick=${save}>Salva selezione<//></div>
      <p class="small muted">Quali POP/AP vede ogni installatore (guasti e verifica copertura) si decide in Account → POP/AP assegnati agli installatori.</p>
    <//>
  `;
}

/** Admin: zones of interest (automatic around the APs, shared, personal of the installers) and the check. */
function AdminZones({ onMap, onChecked, version }) {
  const [c, setC] = useState(null);
  const [f, setF] = useState(null);
  const [error, setError] = useState('');
  const load = () =>
    api('/api/admin/outages/config').then(
      (r) => (setC(r), setF({ apZones: r.config.apZones, apRadiusKm: r.config.apRadiusKm, impactRadiusKm: r.config.impactRadiusKm ?? 1, includePlanned: r.config.includePlanned })),
      (e) => setError(e.message),
    );
  useEffect(() => void load(), [version]);
  if (error) return html`<${Notice} kind="bad">${error}<//>`;
  if (!c || !f) return null;
  const save = async () => {
    await api('/api/admin/outages/config', { method: 'PUT', body: { apZones: f.apZones, apRadiusKm: Number(f.apRadiusKm) || 3, includePlanned: f.includePlanned, impactRadiusKm: Number(f.impactRadiusKm) || 1 } });
    toast('Impostazioni salvate');
    await load();
  };
  const refresh = async () => {
    const r = await api('/api/admin/outages/refresh', { method: 'POST', body: {} });
    toast(r.ok ? `Controllo eseguito: ${r.active.length} eventi nelle zone` : `Errore: ${r.error}`, r.ok ? '' : 'bad');
    await onChecked();
  };
  const delZone = async (z) => {
    await api(`/api/admin/outages/zones/${z.id.slice(1)}`, { method: 'DELETE' });
    await load();
  };
  return html`
    <${Card}>
      <h2>Zone di interesse</h2>
      <label class="check"><input type="checkbox" checked=${f.apZones} onChange=${(e) => setF({ ...f, apZones: e.target.checked })} />Zone automatiche attorno a ogni AP e POP monitorato (${c.apZonesCount} con posizione)</label>
      <div class="row">
        <${Field} label="Raggio attorno agli AP (km)"><input type="number" min="0.5" max="30" step="0.5" value=${f.apRadiusKm} onInput=${(e) => setF({ ...f, apRadiusKm: e.target.value })} /><//>
        <${Field} label="Raggio «POP/AP impattati» (km)"><input type="number" min="0.1" max="5" step="0.1" value=${f.impactRadiusKm} onInput=${(e) => setF({ ...f, impactRadiusKm: e.target.value })} /><//>
      </div>
      <p class="small muted">Un guasto più vicino di questo raggio a un POP o a un AP monitorato viene segnalato come impatto probabile (🚨 su Telegram), anche fuori dalle zone.</p>
      <label class="check"><input type="checkbox" checked=${f.includePlanned} onChange=${(e) => setF({ ...f, includePlanned: e.target.checked })} />Includi i lavori programmati</label>
      <div class="btns"><${BusyButton} className="primary" onClick=${save}>Salva impostazioni<//><${BusyButton} onClick=${refresh}>Controlla ora<//></div>
      <h3>Zone condivise (aree extra senza AP o POP, es. una frazione)</h3>
      ${c.zones.length ? html`<${ZonesTable} zones=${c.zones} onDelete=${delZone} onMap=${onMap} />` : html`<p class="small muted">Nessuna zona condivisa.</p>`}
      <${ZoneForm} post=${(body) => api('/api/admin/outages/zones', { method: 'POST', body })} onDone=${load} />
      ${c.personalZones?.length
        ? html`<h3>Zone personali degli installatori</h3>
            <p class="small muted">Notificate solo all’installatore (app e Telegram personale), non al gruppo.</p>
            <${ZonesTable} zones=${c.personalZones} onDelete=${delZone} onMap=${onMap} owner=${true} />`
        : null}
      <p class="small muted">Le notifiche Telegram al gruppo si attivano in Connettori → Telegram → evento "Guasti Enel".</p>
    <//>
  `;
}

/**
 * Map of outages, zones and POPs/APs (installers: only assigned POPs/APs, as an approximate area).
 * [apiRef] receives show(item) for the lists: the outage or the zone, centred with its details.
 */
function OutagesMap({ admin, apiRef, version }) {
  const el = useRef(null);
  const ctl = useRef(Promise.resolve(null));
  const [note, setNote] = useState(admin ? '' : 'POP e AP sono mostrati come area approssimativa.');
  useEffect(() => {
    let gone = false;
    const ready = createMap(el.current).then((map) => (map && !gone ? { map, layer: window.L.layerGroup().addTo(map), markers: new Map(), fitted: false } : null));
    ctl.current = ready;
    return () => {
      gone = true;
      ready.then((c) => c?.map.remove()).catch(() => {});
    };
  }, []);
  // outages, zones and POPs/APs: drawn again after every check
  useEffect(() => {
    void ctl.current
      .then(async (c) => {
        if (!c) return;
        const d = await api('/api/outages/map');
        c.layer.clearLayers();
        c.markers.clear();
        const layers = drawOutages(c.layer, d, (o, marker) => c.markers.set(o.id, marker));
        for (const [i, z] of (d.zones ?? []).entries()) c.markers.set(z.id, layers[i]);
        if (!c.fitted && layers.length) {
          fit(c.map, layers);
          c.fitted = true;
        }
      })
      .catch((e) => setNote(e.message));
  }, [version]);
  apiRef.current = {
    show: async (o) => {
      const c = await ctl.current;
      if (!c) return;
      el.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const m = c.markers.get(o.id);
      if (m?.getBounds) c.map.fitBounds(m.getBounds().pad(0.1), { maxZoom: 15 });
      else c.map.setView(m ? m.getLatLng() : [o.lat, o.lon], Math.max(c.map.getZoom(), 15));
      m?.openPopup();
    },
  };
  return html`
    <${Card}>
      <h2>Mappa</h2>
      <div class="map" ref=${el}></div>
      <${Dom}
        make=${() =>
          legend([
            [C.guasto_mt, 'Guasto MT'],
            [C.guasto_bt, 'Guasto BT'],
            [C.lavoro, 'Lavoro programmato'],
            [C.pop, 'POP'],
            [C.ap, 'AP'],
            [C.impacted, 'POP/AP potenzialmente impattato'],
            [admin ? C.zone : C.personal, admin ? 'Zona condivisa / personale' : 'Le tue zone'],
          ])}
      />
      <p class="small muted">${note}</p>
    <//>
  `;
}

/** Guasti Enel: outages and planned works in the areas of interest (admins: everything; installers: their own). */
function OutagesPage({ admin }) {
  const [d, setD] = useState(null);
  const [error, setError] = useState('');
  // a new check (or a change of the zones) redraws the map and the lists
  const [version, setVersion] = useState(0);
  const mapApi = useRef(null);
  const onMap = (o) => mapApi.current?.show(o);
  const load = () => api('/api/outages?recent=1').then((r) => (setD(r), setError('')), (e) => setError(e.message));
  useEffect(() => void load(), [version]);
  const reloadAll = async () => setVersion((v) => v + 1);

  const faults = d ? d.active.filter((o) => o.kind !== 'lavoro') : [];
  const seesImpact = admin || d?.scope?.assigned?.length > 0;
  const impacted = d ? new Set(d.active.flatMap((o) => o.impact.map((i) => `${i.type}:${i.id}`))).size : 0;
  const kpi = (label, value, cls) => html`<div class=${`ia-kpi static ${cls || 'plain'}`}><span class="ia-kpi-value">${value}</span><span class="ia-kpi-label">${label}</span></div>`;

  return html`
    <div>
      <${PageHead} title="Guasti Enel" subtitle=${admin ? 'Guasti e lavori della rete elettrica (e-distribuzione) nelle zone di interesse e attorno agli AP.' : 'Guasti e lavori della rete elettrica nelle tue zone.'} />
      ${error ? html`<${Notice} kind="bad">${error}<//>` : null}
      ${d
        ? html`
            <div class=${`ia-kpis${seesImpact ? ' five' : ''}`}>
              ${kpi('Guasti in corso', faults.length, faults.length ? 'bad' : '')} ${kpi('Di cui media tensione', faults.filter((o) => o.kind === 'guasto_mt').length, '')}
              ${kpi('Lavori programmati', d.active.length - faults.length, '')} ${kpi('Clienti Enel disalimentati', d.active.reduce((a, o) => a + o.customers, 0), '')}
              ${seesImpact ? kpi('POP/AP potenzialmente impattati', impacted, impacted ? 'warn' : '') : null}
            </div>
            <p class="small muted ia-meta">
              ${admin
                ? `${d.lastRun ? `Ultimo controllo ${fmtDate(d.lastRun.at)}${d.lastRun.ok ? '' : ` · errore: ${d.lastRun.error}`} · ` : 'Nessun controllo ancora eseguito · '}fonte: mappa pubblica dei guasti di e-distribuzione, controllata ogni 10 minuti.`
                : d.generatedAt
                  ? `Aggiornato ${fmtDate(d.generatedAt)} · ogni 10 minuti`
                  : 'In attesa del primo aggiornamento'}
            </p>
          `
        : !error
          ? html`<p class="muted">Caricamento…</p>`
          : null}
      <${OutagesMap} admin=${admin} apiRef=${mapApi} version=${version} />
      ${d && !admin && d.scope
        ? html`<${Card}>
            <h2>POP/AP assegnati a te</h2>
            ${d.scope.assigned.length
              ? html`<div class="btns">${d.scope.assigned.map((i) => html`<${Badge} key=${i.key}>${itemLabel(i)}<//>`)}</div>`
              : html`<p class="small muted">Nessuno: vedi i guasti nelle tue zone, senza i POP/AP potenzialmente impattati.</p>`}
          <//>`
        : null}
      ${d
        ? html`<${Card}>
            <h2>${admin ? 'In corso nelle zone di interesse' : 'In corso nelle tue zone'}</h2>
            ${d.active.length
              ? html`<${Table}
                  rows=${d.active}
                  columns=${[
                    { label: 'Tipo', render: (o) => html`<${Badge} kind=${KIND[o.kind]?.[1] ?? ''}>${KIND[o.kind]?.[0] ?? o.kind}<//>` },
                    { label: 'Località', render: (o) => html`<div>${o.place || '—'}<div class="small muted">${o.province}</div></div>` },
                    { label: 'Zona', render: (o) => html`<div>${o.zones[0]?.name ?? '—'}<div class="small muted">${o.zones[0] ? `a ${dist(o.zones[0].distanceM)}${o.zones.length > 1 ? ` · +${o.zones.length - 1}` : ''}` : ''}</div></div>` },
                    ...(seesImpact
                      ? [
                          {
                            label: 'POP/AP impattati',
                            render: (o) =>
                              o.impact.length
                                ? html`<div class="btns">
                                    ${o.impact.slice(0, 4).map((i) => html`<${Badge} key=${`${i.type}:${i.id}`} kind="bad">${i.type === 'pop' ? 'POP' : 'AP'} ${i.name} · ${dist(i.distanceM)}${i.stations != null ? ` · ${i.stations} CPE` : ''}<//>`)}
                                    ${o.impact.length > 4 ? html`<span class="small">+${o.impact.length - 4}</span>` : null}
                                  </div>`
                                : '—',
                          },
                        ]
                      : []),
                    { label: 'Clienti', render: (o) => o.customers },
                    { label: 'Dal', render: (o) => local(o.start) },
                    { label: 'Ripristino previsto', render: (o) => local(o.expectedRestore) },
                    { label: '', render: (o) => html`<button type="button" class="small-btn" onClick=${() => onMap(o)}>Mappa</button>` },
                  ]}
                />`
              : html`<${Notice} kind="good">${admin ? 'Nessun guasto né lavoro in corso nelle zone di interesse.' : 'Nessun guasto né lavoro in corso nelle tue zone.'}<//>`}
          <//>`
        : null}
      ${d?.recent?.length
        ? html`<${Card}>
            <h2>Ripristinati nelle ultime 48 ore</h2>
            <${Table}
              rows=${d.recent}
              columns=${[
                { label: 'Tipo', render: (o) => html`<${Badge}>${KIND[o.kind]?.[0] ?? o.kind}<//>` },
                { label: 'Località', render: (o) => `${o.place} (${o.province})` },
                { label: 'Zona', render: (o) => o.zones[0]?.name ?? '—' },
                { label: 'Durata', render: (o) => `${fmtDate(o.firstSeen)} → ${fmtDate(o.endedAt)}` },
              ]}
            />
          <//>`
        : null}
      <${Dom} make=${() => myTelegramCard({ title: 'Notifiche', appHint: true })} />
      ${admin ? null : html`<${MyZones} onMap=${onMap} />`}
      ${admin ? html`<${InfraCard} onSaved=${reloadAll} />` : null}
      ${admin ? html`<${AdminZones} onMap=${onMap} onChecked=${reloadAll} version=${version} />` : null}
    </div>
  `;
}

export const outagesView = ({ user }) => reactView(OutagesPage, { admin: user.role === 'admin' });
