import { api } from '../api.js';
import { toast } from '../dom.js';
import { createMap, fit, popup, towards } from '../map.js';
import { Fragment, html, reactView, useEffect, useMemo, useRef, useState } from '../react.js';
import { nms } from '../terms.js';
import { Badge, Card, fmtDate, Notice, PageHead } from '../ui.js';

const STATE = { ok: ['in funzione', 'good'], degraded: ['molte CPE offline', 'warn'], down: ['non raggiungibile', 'bad'] };
const OFFLINE = { none: null, some: 'alcune CPE offline', many: 'molte CPE offline' };
const STATE_COLOR = { ok: '#14b8a6', degraded: '#f59e0b', down: '#dc2626' };
const ALL = ['ok', 'degraded', 'down'];
const km = (m) => (m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`);

const ORDER = { down: 0, degraded: 1, ok: 2 };
const byState = (a, b) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name, 'it', { numeric: true });
const apText = (a, popName) => `${a.name} ${a.ssid ?? ''} ${popName ?? ''}`.toLowerCase();

/** "PPPoE 12 online · 2 offline · 1 sospeso" (admins, CRM connected), null otherwise. */
function pppoeText(a) {
  const p = a.pppoe;
  if (!p || !(p.online + p.offline + p.suspended)) return null;
  const parts = [`${p.online} online`];
  if (p.offline) parts.push(`${p.offline} offline`);
  if (p.suspended) parts.push(`${p.suspended} ${p.suspended === 1 ? 'sospeso' : 'sospesi'}`);
  return `PPPoE ${parts.join(' · ')}`;
}

const apPopup = (a, popName) =>
  popup(
    a.name,
    a.ssid && a.ssid !== a.name ? a.ssid : null,
    popName ? `POP ${popName}` : 'AP senza POP',
    STATE[a.state][0],
    a.cpe ? `CPE ${a.cpe.total - a.cpe.offline}/${a.cpe.total} online` : null,
    pppoeText(a),
    a.model,
    a.served?.servedM ? `settore ${a.served.width}° verso ${a.served.center}°, clienti fino a ${km(a.served.servedM)}` : 'nessun fascio: mancano clienti con posizione',
    a.locationFrom === 'pop' ? 'posizione del POP (l’AP non ne ha una sua)' : null,
    a.powerOutage ? 'guasto Enel vicino' : null,
  );

/** CPE online over total, as a small bar (green, amber below 70%, red below 40%). */
function CpeBar({ a }) {
  if (!a.cpe) return OFFLINE[a.cpeOffline] ? html`<span class="small">${OFFLINE[a.cpeOffline]}</span>` : html`<span class="muted">—</span>`;
  const online = a.cpe.total - a.cpe.offline;
  const ratio = a.cpe.total ? online / a.cpe.total : 1;
  const pppoe = pppoeText(a);
  return html`
    <span class="cpe-cell">
      <span class="cpe-bar"><i style=${{ width: `${Math.round(ratio * 100)}%`, background: ratio >= 0.7 ? STATE_COLOR.ok : ratio >= 0.4 ? STATE_COLOR.degraded : STATE_COLOR.down }}></i></span>
      <span class="small">${online}/${a.cpe.total}</span>
      ${pppoe ? html`<span class=${`small ${a.pppoe.offline ? 'bad-text' : 'muted'}`} title="Sessioni PPPoE dal RADIUS"> · ${pppoe}</span>` : null}
    </span>
  `;
}

/** The state filters: one chip per state with its count; at least one stays on. */
const StateChips = ({ shown, counts, onToggle }) => html`
  <div class="state-chips">
    ${ALL.map(
      (k) => html`
        <button key=${k} type="button" class=${`state-chip${shown.has(k) ? ' on' : ''}`} aria-pressed=${shown.has(k) ? 'true' : 'false'} title=${shown.has(k) ? 'Nascondi questi AP' : 'Mostra questi AP'} onClick=${() => onToggle(k)}>
          <i class="dot" style=${{ background: STATE_COLOR[k] }}></i>${STATE[k][0]}<span class="count">${counts[k]}</span>
        </button>
      `,
    )}
  </div>
`;

/**
 * Admins: every POP and AP on the map, coloured by state. One click on an AP shows its details,
 * a double click opens (or closes) the sector already served by its customers; several sectors
 * can stay open together. The map is created once; each refresh redraws without moving the view.
 * [api] (a ref) receives focus(id, sector) for the list.
 */
function NetworkMap({ data, shown, q, open, setOpen, apiRef, tools }) {
  const el = useRef(null);
  const ctl = useRef(Promise.resolve(null));
  const byId = useRef(new Map());
  const popupId = useRef(null);
  const fitted = useRef(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    let gone = false;
    const ready = createMap(el.current, { zoom: 10 }).then((map) => {
      if (!map || gone) return null;
      const L = window.L;
      const c = { map, L, wedges: L.layerGroup().addTo(map), markers: L.layerGroup().addTo(map), clickTimer: null };
      map.on('popupclose', () => (popupId.current = null));
      setTimeout(() => map.invalidateSize(), 200);
      return c;
    });
    ctl.current = ready;
    return () => {
      gone = true;
      ready.then((c) => c?.map.remove()).catch(() => {});
    };
  }, []);

  const showPopup = (c, id) => {
    const hit = byId.current.get(id);
    if (!hit) return;
    popupId.current = id;
    c.L.popup({ autoPan: true }).setLatLng(hit.latlng).setContent(hit.content()).openOn(c.map);
  };
  const toggle = (id) => {
    const hit = byId.current.get(id);
    if (!hit?.served) return void toast('Questo AP non ha ancora un fascio: mancano clienti con posizione.');
    setOpen((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  // markers and open sectors from the last data, with the current filters
  useEffect(() => {
    if (!data) return;
    void ctl.current.then((c) => {
      if (!c) return;
      const { L } = c;
      c.markers.clearLayers();
      c.wedges.clearLayers();
      byId.current.clear();
      const pts = [];
      let missing = 0;
      let hidden = 0;
      const ap = (a, popName) => {
        if (a.lat == null || a.lon == null) return void missing++;
        if (!shown.has(a.state) || (q && !apText(a, popName).includes(q))) return void hidden++;
        const color = STATE_COLOR[a.state];
        const id = `ap:${a.id}`;
        if (open.has(id) && a.served?.servedM) {
          const wedge = [[a.lat, a.lon]];
          for (let i = 0; i <= 24; i++) wedge.push(towards(a.lat, a.lon, a.served.center - a.served.width / 2 + (a.served.width * i) / 24, a.served.servedM));
          L.polygon(wedge, { color, weight: 1.5, fillOpacity: 0.14, dashArray: '4 5', interactive: false }).addTo(c.wedges);
        }
        const m = L.circleMarker([a.lat, a.lon], { radius: open.has(id) ? 8 : 6, color, weight: open.has(id) ? 3 : 2, fillOpacity: 0.9, bubblingMouseEvents: false })
          .bindTooltip(a.name)
          .addTo(c.markers);
        // one click: details (after a short wait, so that a double click does not open them too)
        m.on('click', () => {
          clearTimeout(c.clickTimer);
          c.clickTimer = setTimeout(() => showPopup(c, id), 260);
        });
        m.on('dblclick', (e) => {
          L.DomEvent.stop(e);
          clearTimeout(c.clickTimer);
          toggle(id);
        });
        byId.current.set(id, { latlng: m.getLatLng(), served: !!a.served?.servedM, content: () => apPopup(a, popName) });
        pts.push(m);
      };
      for (const p of data.pops) {
        if (p.lat != null && p.lon != null && (!q || `pop ${p.name}`.toLowerCase().includes(q) || p.aps.some((a) => apText(a, p.name).includes(q)))) {
          const id = `pop:${p.id}`;
          const m = L.circleMarker([p.lat, p.lon], { radius: 10, color: STATE_COLOR[p.state], weight: 3, fillColor: '#ffffff', fillOpacity: 1, bubblingMouseEvents: false })
            .bindTooltip(`POP ${p.name}`)
            .on('click', () => showPopup(c, id))
            .on('dblclick', (e) => L.DomEvent.stop(e))
            .addTo(c.markers);
          byId.current.set(id, { latlng: m.getLatLng(), content: () => popup(`POP ${p.name}`, `${p.aps.length} AP`, STATE[p.state][0], p.powerOutage ? 'guasto Enel vicino' : null) });
          pts.push(m);
        }
        for (const a of p.aps) ap(a, p.name);
      }
      for (const a of data.apsWithoutPop) ap(a, null);
      setNote(
        [`${pts.length} punti sulla mappa`, hidden ? `${hidden} AP nascosti dai filtri` : null, missing ? `${missing} AP senza posizione (correggila nel gestionale)` : null]
          .filter(Boolean)
          .join(' · ')
          .concat('. Cerchio bianco: POP; punti: AP.'),
      );
      if (!fitted.current && pts.length) {
        fit(c.map, pts);
        fitted.current = true;
      }
      // the details of a point the filters just hid make no sense any more
      if (popupId.current && !byId.current.has(popupId.current)) c.map.closePopup();
    });
  }, [data, shown, q, open]);

  // for the list and the search box: centre an AP, show its details, open its sector if asked
  apiRef.current = {
    focus: async (id, sector = false) => {
      const c = await ctl.current;
      const hit = byId.current.get(id);
      if (!c) return;
      if (!hit) return void toast('L’AP è nascosto dai filtri o non ha una posizione.');
      if (sector && hit.served && !open.has(id)) setOpen((s) => new Set([...s, id]));
      el.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      c.map.setView(hit.latlng, Math.max(c.map.getZoom(), 13));
      showPopup(c, id);
    },
    jump: async () => {
      const c = await ctl.current;
      if (!q || !c) return;
      const all = [...byId.current.entries()];
      const hit = all.find(([id]) => id.startsWith('ap:')) ?? all[0];
      if (hit) {
        c.map.setView(hit[1].latlng, 14);
        showPopup(c, hit[0]);
      }
    },
    toggle,
  };

  return html`
    <${Card}>
      <h2>Mappa della rete</h2>
      <div class="map-tools">
        ${tools}
        <button type="button" disabled=${open.size === 0} onClick=${() => setOpen(new Set())}>${open.size ? `Chiudi tutti i fasci (${open.size})` : 'Chiudi tutti i fasci'}</button>
      </div>
      <div class="map map-tall" ref=${el}></div>
      <p class="small muted">Clic su un AP: informazioni. Doppio clic: apre o chiude il fascio dei clienti già serviti (puoi aprirne più di uno).</p>
      <p class="small muted">${note}</p>
    <//>
  `;
}

/** "Stato rete": POPs and APs (installers: the assigned ones), refreshed every minute. No notifications. */
function NetworkPage({ admin }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [shown, setShown] = useState(() => new Set(ALL));
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(() => new Set());
  const mapApi = useRef(null);
  const q = query.trim().toLowerCase();

  useEffect(() => {
    const load = () =>
      api('/api/network/status')
        .then((d) => (setData(d), setError('')))
        .catch((e) => setError(e.message));
    void load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);
  // sectors of APs no longer on the map (removed in UISP) are forgotten
  useEffect(() => {
    if (!data || !open.size) return;
    const ids = new Set([...data.pops.flatMap((p) => p.aps), ...data.apsWithoutPop].map((a) => `ap:${a.id}`));
    if ([...open].some((id) => !ids.has(id))) setOpen(new Set([...open].filter((id) => ids.has(id))));
  }, [data]);

  const counts = useMemo(() => {
    const c = { ok: 0, degraded: 0, down: 0 };
    if (data) for (const a of [...data.pops.flatMap((p) => p.aps), ...data.apsWithoutPop]) c[a.state]++;
    return c;
  }, [data]);
  const toggleState = (k) =>
    setShown((s) => {
      const n = new Set(s);
      n.has(k) ? n.delete(k) : n.add(k);
      return n.size ? n : new Set(ALL);
    });
  // a counter of the summary shows only that state; again, all of them
  const only = (k) => setShown((s) => (s.size === 1 && s.has(k) ? new Set(ALL) : new Set([k])));

  const groups = useMemo(() => {
    if (!data) return [];
    return [...data.pops, ...(data.apsWithoutPop.length ? [{ id: null, name: 'AP senza POP', state: null, powerOutage: false, aps: data.apsWithoutPop }] : [])]
      .map((p) => {
        const popHit = q && `pop ${p.name}`.toLowerCase().includes(q);
        const aps = p.aps.filter((a) => shown.has(a.state) && (!q || popHit || apText(a, p.name).includes(q))).sort(byState);
        return { p, aps, popHit };
      })
      .filter(({ p, aps, popHit }) => aps.length || (!p.aps.length && (!q || popHit)));
  }, [data, shown, q]);
  const total = groups.reduce((n, g) => n + g.aps.length, 0);

  const search = html`<input type="search" class="grow" placeholder="Cerca POP, AP o SSID" value=${query} onInput=${(e) => setQuery(e.target.value)} onKeyDown=${(e) => e.key === 'Enter' && mapApi.current?.jump()} />`;
  const filters = html`${search}<${StateChips} shown=${shown} counts=${counts} onToggle=${toggleState} />`;

  const s = data?.summary;
  const kpi = (k, label, value, cls, state) => html`
    <button key=${k} type="button" class=${`ia-kpi ${cls}${state && shown.size === 1 && shown.has(state) ? ' on' : ''}${state ? '' : ' plain'}`} onClick=${state ? () => only(state) : undefined}>
      <span class="ia-kpi-value">${value}</span><span class="ia-kpi-label">${label}</span>
    </button>
  `;

  return html`
    <div>
      <${PageHead} title="Stato rete" subtitle=${admin ? 'Stato di POP e AP: raggiungibilità, CPE offline e guasti Enel vicini.' : 'Stato dei POP e degli AP che ti sono assegnati.'} />
      ${error ? html`<${Notice} kind="bad">${error}<//>` : null}
      ${!data && !error ? html`<p class="muted">Caricamento…</p>` : null}
      ${data
        ? html`
            <div class="ia-kpis">
              ${kpi('aps', 'AP', s.aps, 'info', null)} ${kpi('down', 'Non raggiungibili', s.down, 'bad', 'down')} ${kpi('degraded', 'Con molte CPE offline', s.degraded, 'warn', 'degraded')}
              ${kpi('power', 'Con guasto Enel vicino', s.powerOutage, s.powerOutage ? 'bad' : 'info', null)}
            </div>
            <p class="small muted ia-meta">Aggiornato ${fmtDate(data.generatedAt)} · si aggiorna ogni minuto${nms(' · dati da UISP', '')}.</p>
            ${admin ? html`<${NetworkMap} data=${data} shown=${shown} q=${q} open=${open} setOpen=${setOpen} apiRef=${mapApi} tools=${filters} />` : null}
            ${data.restricted && !data.assignedCount
              ? html`<${Notice} kind="warn">Nessun POP/AP assegnato al tuo account: chiedi all’amministratore.<//>`
              : html`<${Card}>
                  <h2>${data.restricted ? 'I tuoi POP e AP' : 'POP e AP'}</h2>
                  ${admin ? null : html`<div class="map-tools">${filters}</div>`}
                  ${groups.length
                    ? html`<div class="table-wrap">
                        <table class="net-table">
                          <thead><tr>${['Stato', 'AP', 'CPE online', 'Ultimo contatto', 'Note', ''].map((t, i) => html`<th key=${i}>${t}</th>`)}</tr></thead>
                          <tbody>
                            ${groups.map(({ p, aps }) => {
                              const down = p.aps.filter((a) => a.state === 'down').length;
                              const degraded = p.aps.filter((a) => a.state === 'degraded').length;
                              return html`
                                <${Fragment} key=${p.id ?? 'none'}>
                                  <tr class="pop-row">
                                    <td colspan="6">
                                      <div class="pop-head">
                                        <b>${p.id == null ? p.name : `POP ${p.name}`}</b>
                                        ${p.state ? html`<${Badge} kind=${STATE[p.state][1]}>${STATE[p.state][0]}<//>` : null}
                                        <span class="small muted">${[`${p.aps.length} AP`, down ? `${down} non raggiungibili` : null, degraded ? `${degraded} con molte CPE offline` : null].filter(Boolean).join(' · ')}</span>
                                        ${p.powerOutage ? html`<${Badge} kind="bad">guasto Enel vicino<//>` : null}
                                      </div>
                                    </td>
                                  </tr>
                                  ${aps.map((a) => {
                                    const id = `ap:${a.id}`;
                                    return html`
                                      <tr key=${id} class=${`ap-row state-${a.state}`}>
                                        <td data-label="Stato"><${Badge} kind=${STATE[a.state][1]}>${STATE[a.state][0]}<//></td>
                                        <td data-label="AP"><div class="ap-name"><b>${a.name}</b>${a.ssid && a.ssid !== a.name ? html`<span class="small muted">${a.ssid}</span>` : null}</div></td>
                                        <td data-label="CPE online"><${CpeBar} a=${a} /></td>
                                        <td data-label="Ultimo contatto">${a.lastSeen ? html`<span class="small">${fmtDate(a.lastSeen)}</span>` : html`<span class="muted">—</span>`}</td>
                                        <td data-label="Note">${a.powerOutage ? html`<${Badge} kind="bad">guasto Enel vicino<//>` : a.model ? html`<span class="small muted">${a.model}</span>` : html`<span class="muted">—</span>`}</td>
                                        <td class="ap-actions">
                                          ${admin
                                            ? a.lat != null && a.lon != null
                                              ? html`<div class="btns">
                                                  <button type="button" class="small-btn" onClick=${() => mapApi.current?.focus(id)}>Mappa</button>
                                                  ${a.served?.servedM
                                                    ? html`<button type="button" class=${`small-btn${open.has(id) ? ' on' : ''}`} onClick=${() => (open.has(id) ? mapApi.current?.toggle(id) : mapApi.current?.focus(id, true))}>${open.has(id) ? 'Chiudi fascio' : 'Fascio'}</button>`
                                                    : null}
                                                </div>`
                                              : html`<span class="small muted">senza posizione</span>`
                                            : null}
                                        </td>
                                      </tr>
                                    `;
                                  })}
                                <//>
                              `;
                            })}
                          </tbody>
                        </table>
                      </div>`
                    : html`<p class="small muted">${data.pops.length || data.apsWithoutPop.length ? 'Nessun AP con questi filtri.' : 'Nessun POP o AP.'}</p>`}
                  <p class="small muted">${total} AP mostrati. "Molte CPE offline": almeno il 30% delle CPE dell’AP non è raggiungibile (probabile problema di settore, non del singolo cliente).</p>
                <//>`}
          `
        : null}
    </div>
  `;
}

export const networkView = ({ user }) => reactView(NetworkPage, { admin: user.role === 'admin' });
