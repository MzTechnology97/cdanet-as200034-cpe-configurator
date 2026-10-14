import { useQuery } from '@tanstack/react-query';
import { type Dispatch, type ReactNode, type SetStateAction, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from '../../../web/js/dom.js';
import { towards } from '../../../web/js/map.js';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { type Leaflet, type LMap, MapView, mapPopup } from '../map/MapView';
import type { PageContext } from '../shell/routes';
import { ago, isStale } from '../shell/UispBanner';
import { Badge, Button, Card, Icon, Notice, PageHeader, Skeleton, Stat } from '../ui';

/**
 * Stato rete: POPs and APs (installers: the assigned ones), refreshed every minute and on the
 * server's events. Admins also get the map: one click on an AP shows its details, a double click
 * opens (or closes) the sector already served by its customers.
 */

type State = 'ok' | 'degraded' | 'down';
type Tone = 'good' | 'warn' | 'bad';
const STATE: Record<State, [string, Tone]> = { ok: ['in funzione', 'good'], degraded: ['molte CPE offline', 'warn'], down: ['non raggiungibile', 'bad'] };
const OFFLINE: Record<string, string | null> = { none: null, some: 'alcune CPE offline', many: 'molte CPE offline' };
const STATE_COLOR: Record<State, string> = { ok: '#14b8a6', degraded: '#f59e0b', down: '#dc2626' };
const ALL: State[] = ['ok', 'degraded', 'down'];
const ORDER: Record<State, number> = { down: 0, degraded: 1, ok: 2 };

interface Ap {
  id: string;
  name: string;
  ssid?: string | null;
  model?: string | null;
  state: State;
  lat?: number | null;
  lon?: number | null;
  lastSeen?: string | null;
  cpe?: { total: number; offline: number } | null;
  cpeOffline?: string | null;
  pppoe?: { online: number; offline: number; suspended: number } | null;
  served?: { center: number; width: number; servedM: number } | null;
  locationFrom?: string;
  powerOutage?: boolean;
}
interface Pop {
  id: string | null;
  name: string;
  state: State | null;
  lat?: number | null;
  lon?: number | null;
  powerOutage?: boolean;
  aps: Ap[];
}
interface Data {
  generatedAt: string;
  summary: { aps: number; down: number; degraded: number; powerOutage: number };
  pops: Pop[];
  apsWithoutPop: Ap[];
  restricted?: boolean;
  assignedCount?: number | null;
  /** When the device list shown was read (the server serves its last copy when the source is slow). */
  dataAt?: string | null;
}

const km = (m: number) => (m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`);
const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const byState = (a: Ap, b: Ap) => ORDER[a.state] - ORDER[b.state] || a.name.localeCompare(b.name, 'it', { numeric: true });
const apText = (a: Ap, popName: string | null) => `${a.name} ${a.ssid ?? ''} ${popName ?? ''}`.toLowerCase();
const allAps = (d: Data) => [...d.pops.flatMap((p) => p.aps), ...d.apsWithoutPop];

/** "PPPoE 12 online · 2 offline · 1 sospeso" (admins, CRM connected), null otherwise. */
function pppoeText(a: Ap) {
  const p = a.pppoe;
  if (!p || !(p.online + p.offline + p.suspended)) return null;
  const parts = [`${p.online} online`];
  if (p.offline) parts.push(`${p.offline} offline`);
  if (p.suspended) parts.push(`${p.suspended} ${p.suspended === 1 ? 'sospeso' : 'sospesi'}`);
  return `PPPoE ${parts.join(' · ')}`;
}

const apPopup = (a: Ap, popName: string | null) =>
  mapPopup(
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
function CpeBar({ a }: { a: Ap }) {
  if (!a.cpe) return OFFLINE[a.cpeOffline ?? ''] ? <span className="ui-small">{OFFLINE[a.cpeOffline ?? '']}</span> : null;
  const online = a.cpe.total - a.cpe.offline;
  const ratio = a.cpe.total ? online / a.cpe.total : 1;
  const pppoe = pppoeText(a);
  return (
    <span className="nw-cpe">
      <span className="nw-bar">
        <i style={{ width: `${Math.round(ratio * 100)}%`, background: ratio >= 0.7 ? STATE_COLOR.ok : ratio >= 0.4 ? STATE_COLOR.degraded : STATE_COLOR.down }} />
      </span>
      <span className="ui-small">
        {online}/{a.cpe.total} CPE
      </span>
      {pppoe && (
        <span className={`ui-small ${a.pppoe?.offline ? 'nw-bad' : 'ui-muted'}`} title="Sessioni PPPoE dal RADIUS">
          · {pppoe}
        </span>
      )}
    </span>
  );
}

/** The state filters: one chip per state with its count; at least one stays on. */
function StateChips({ shown, counts, onToggle }: { shown: Set<State>; counts: Record<State, number>; onToggle: (k: State) => void }) {
  return (
    <div className="nw-chips" role="group" aria-label="Stato degli AP">
      {ALL.map((k) => (
        <button key={k} type="button" className={`nw-chip${shown.has(k) ? ' on' : ''}`} aria-pressed={shown.has(k)} title={shown.has(k) ? 'Nascondi questi AP' : 'Mostra questi AP'} onClick={() => onToggle(k)}>
          <i className="nw-dot" style={{ background: STATE_COLOR[k] }} />
          {STATE[k][0]}
          <span className="nw-count">{counts[k]}</span>
        </button>
      ))}
    </div>
  );
}

interface Hit {
  latlng: unknown;
  served: boolean;
  content: () => HTMLElement;
}
interface MapApi {
  focus: (id: string, sector?: boolean) => void;
  jump: () => void;
  toggle: (id: string) => void;
}

/**
 * Admins: every POP and AP on the map, coloured by state; several sectors can stay open together.
 * The map is created once; each refresh redraws without moving the view. [apiRef] receives
 * focus(id, sector), jump() and toggle(id) for the list and the search box.
 */
function NetworkMap({ data, shown, q, open, setOpen, apiRef, tools }: { data: Data; shown: Set<State>; q: string; open: Set<string>; setOpen: Dispatch<SetStateAction<Set<string>>>; apiRef: MutableRef<MapApi | null>; tools: ReactNode }) {
  const mapRef = useRef<LMap | null>(null);
  const byId = useRef(new Map<string, Hit>());
  const popupId = useRef<string | null>(null);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [note, setNote] = useState('');

  const showPopup = (id: string) => {
    const map = mapRef.current;
    const hit = byId.current.get(id);
    if (!map || !hit) return;
    popupId.current = id;
    (window as unknown as { L: Leaflet }).L.popup({ autoPan: true }).setLatLng(hit.latlng).setContent(hit.content()).openOn(map);
  };
  const toggle = (id: string) => {
    const hit = byId.current.get(id);
    if (!hit?.served) return void toast('Questo AP non ha ancora un fascio: mancano clienti con posizione.');
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  // markers and open sectors from the last data, with the current filters
  const draw = (target: Leaflet, L: Leaflet, map: LMap) => {
    byId.current.clear();
    const pts: unknown[] = [];
    let missing = 0;
    let hidden = 0;
    const ap = (a: Ap, popName: string | null) => {
      if (a.lat == null || a.lon == null) return void missing++;
      if (!shown.has(a.state) || (q && !apText(a, popName).includes(q))) return void hidden++;
      const color = STATE_COLOR[a.state];
      const id = `ap:${a.id}`;
      if (open.has(id) && a.served?.servedM) {
        const wedge: number[][] = [[a.lat, a.lon]];
        for (let i = 0; i <= 24; i++) wedge.push(towards(a.lat, a.lon, a.served.center - a.served.width / 2 + (a.served.width * i) / 24, a.served.servedM));
        L.polygon(wedge, { color, weight: 1.5, fillOpacity: 0.14, dashArray: '4 5', interactive: false }).addTo(target);
      }
      const m = L.circleMarker([a.lat, a.lon], { radius: open.has(id) ? 8 : 6, color, weight: open.has(id) ? 3 : 2, fillOpacity: 0.9, bubblingMouseEvents: false })
        .bindTooltip(a.name)
        .addTo(target);
      // one click: details (after a short wait, so that a double click does not open them too)
      m.on('click', () => {
        clearTimeout(clickTimer.current);
        clickTimer.current = setTimeout(() => showPopup(id), 260);
      });
      m.on('dblclick', (e: unknown) => {
        L.DomEvent.stop(e);
        clearTimeout(clickTimer.current);
        toggle(id);
      });
      byId.current.set(id, { latlng: m.getLatLng(), served: !!a.served?.servedM, content: () => apPopup(a, popName) });
      pts.push(m);
    };
    for (const p of data.pops) {
      if (p.lat != null && p.lon != null && (!q || `pop ${p.name}`.toLowerCase().includes(q) || p.aps.some((a) => apText(a, p.name).includes(q)))) {
        const id = `pop:${p.id}`;
        const m = L.circleMarker([p.lat, p.lon], { radius: 10, color: STATE_COLOR[p.state ?? 'ok'], weight: 3, fillColor: '#ffffff', fillOpacity: 1, bubblingMouseEvents: false })
          .bindTooltip(`POP ${p.name}`)
          .on('click', () => showPopup(id))
          .on('dblclick', (e: unknown) => L.DomEvent.stop(e))
          .addTo(target);
        byId.current.set(id, { latlng: m.getLatLng(), served: false, content: () => mapPopup(`POP ${p.name}`, `${p.aps.length} AP`, p.state ? STATE[p.state][0] : null, p.powerOutage && 'guasto Enel vicino') });
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
    // the details of a point the filters just hid make no sense any more
    if (popupId.current && !byId.current.has(popupId.current)) map.closePopup();
    return pts;
  };

  // for the list and the search box: centre an AP, show its details, open its sector if asked
  apiRef.current = {
    focus: (id, sector = false) => {
      const map = mapRef.current;
      const hit = byId.current.get(id);
      if (!map) return;
      if (!hit) return void toast('L’AP è nascosto dai filtri o non ha una posizione.');
      if (sector && hit.served && !open.has(id)) setOpen((s) => new Set([...s, id]));
      map.getContainer().scrollIntoView({ behavior: 'smooth', block: 'center' });
      map.setView(hit.latlng, Math.max(map.getZoom(), 13));
      showPopup(id);
    },
    jump: () => {
      const map = mapRef.current;
      if (!q || !map) return;
      const all = [...byId.current.entries()];
      const hit = all.find(([id]) => id.startsWith('ap:')) ?? all[0];
      if (hit) {
        map.setView(hit[1].latlng, 14);
        showPopup(hit[0]);
      }
    },
    toggle,
  };

  return (
    <Card
      title="Mappa della rete"
      actions={
        <Button disabled={open.size === 0} onClick={() => setOpen(new Set())}>
          {open.size ? `Chiudi tutti i fasci (${open.size})` : 'Chiudi tutti i fasci'}
        </Button>
      }
    >
      <div className="nw-tools">{tools}</div>
      <MapView tall zoom={10} fitMode="once" mapRef={mapRef} onReady={(map) => map.on('popupclose', () => (popupId.current = null))} draw={draw} deps={[data, shown, q, open]} />
      <p className="ui-muted ui-small">Clic su un AP: informazioni. Doppio clic: apre o chiude il fascio dei clienti già serviti (puoi aprirne più di uno).</p>
      <p className="ui-muted ui-small">{note}</p>
    </Card>
  );
}

type MutableRef<T> = { current: T };

export function Network({ user }: PageContext) {
  const admin = user.role === 'admin';
  const query = useQuery({ queryKey: keys.network, queryFn: () => api<Data>('/api/network/status'), refetchInterval: 60_000 });
  const [shown, setShown] = useState<Set<State>>(() => new Set(ALL));
  const [text, setText] = useState('');
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const mapApi = useRef<MapApi | null>(null);
  const q = text.trim().toLowerCase();
  const data = query.data;

  // sectors of APs no longer on the map (removed in UISP) are forgotten
  useEffect(() => {
    if (!data || !open.size) return;
    const ids = new Set(allAps(data).map((a) => `ap:${a.id}`));
    if ([...open].some((id) => !ids.has(id))) setOpen(new Set([...open].filter((id) => ids.has(id))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const counts = useMemo(() => {
    const c: Record<State, number> = { ok: 0, degraded: 0, down: 0 };
    if (data) for (const a of allAps(data)) c[a.state]++;
    return c;
  }, [data]);
  const toggleState = (k: State) =>
    setShown((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n.size ? n : new Set(ALL);
    });
  // a tile of the summary shows only that state; again, all of them
  const only = (k: State) => setShown((s) => (s.size === 1 && s.has(k) ? new Set(ALL) : new Set([k])));
  const isOnly = (k: State) => shown.size === 1 && shown.has(k);

  const groups = useMemo(() => {
    if (!data) return [];
    const list: Pop[] = [...data.pops, ...(data.apsWithoutPop.length ? [{ id: null, name: 'AP senza POP', state: null, powerOutage: false, aps: data.apsWithoutPop }] : [])];
    return list
      .map((p) => {
        const popHit = !!q && `pop ${p.name}`.toLowerCase().includes(q);
        const aps = p.aps.filter((a) => shown.has(a.state) && (!q || popHit || apText(a, p.name).includes(q))).sort(byState);
        return { p, aps, popHit };
      })
      .filter(({ p, aps, popHit }) => aps.length || (!p.aps.length && (!q || popHit)));
  }, [data, shown, q]);
  const total = groups.reduce((n, g) => n + g.aps.length, 0);

  const tools = (
    <>
      <label className="hl-search">
        <Icon name="search" />
        <input type="search" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && mapApi.current?.jump()} placeholder="Cerca POP, AP o SSID" aria-label="Cerca" />
      </label>
      <StateChips shown={shown} counts={counts} onToggle={toggleState} />
    </>
  );
  const s = data?.summary;

  return (
    <div className="ui-page">
      <PageHeader
        icon="hub"
        title="Stato rete"
        subtitle={admin ? 'Stato di POP e AP: raggiungibilità, CPE offline e guasti Enel vicini.' : 'Stato dei POP e degli AP che ti sono assegnati.'}
        actions={
          <Button icon="refresh" busy={query.isFetching} onClick={() => void query.refetch()}>
            Aggiorna
          </Button>
        }
      />
      {query.error && <Notice tone="bad">{(query.error as Error).message}</Notice>}
      {!data && !query.error && <Skeleton lines={6} />}
      {data && s && (
        <>
          <section aria-label="Riepilogo" className="ui-stats">
            <Stat label="AP" value={s.aps} />
            <Stat label="non raggiungibili" value={s.down} tone={s.down ? 'bad' : 'good'} active={isOnly('down')} onClick={() => only('down')} />
            <Stat label="con molte CPE offline" value={s.degraded} tone={s.degraded ? 'warn' : 'good'} active={isOnly('degraded')} onClick={() => only('degraded')} />
            <Stat label="con guasto Enel vicino" value={s.powerOutage} tone={s.powerOutage ? 'bad' : 'neutral'} />
          </section>
          {isStale(data.dataAt) ? (
            <Notice tone="warn">
              Dati della rete {ago(data.dataAt!)}: {admin ? 'UISP non risponde, la pagina mostra l’ultima copia.' : 'l’aggiornamento è in ritardo, la pagina mostra l’ultima copia.'}
            </Notice>
          ) : (
            <p className="ui-muted ui-small">
              Aggiornato {date(data.generatedAt)} · si aggiorna ogni minuto{admin ? ' · dati da UISP' : ''}.
            </p>
          )}
          {admin && <NetworkMap data={data} shown={shown} q={q} open={open} setOpen={setOpen} apiRef={mapApi} tools={tools} />}
          {data.restricted && !data.assignedCount ? (
            <Notice tone="warn">Nessun POP/AP assegnato al tuo account: chiedi all’amministratore.</Notice>
          ) : (
            <>
              {!admin && <div className="nw-tools">{tools}</div>}
              {groups.length ? (
                groups.map(({ p, aps }) => {
                  const down = p.aps.filter((a) => a.state === 'down').length;
                  const degraded = p.aps.filter((a) => a.state === 'degraded').length;
                  return (
                    <Card key={p.id ?? 'none'} padded={false}>
                      <div className="nw-pop">
                        <strong>{p.id == null ? p.name : `POP ${p.name}`}</strong>
                        {p.state && <Badge tone={STATE[p.state][1]}>{STATE[p.state][0]}</Badge>}
                        <span className="ui-muted ui-small">{[`${p.aps.length} AP`, down ? `${down} non raggiungibili` : null, degraded ? `${degraded} con molte CPE offline` : null].filter(Boolean).join(' · ')}</span>
                        {p.powerOutage && <Badge tone="bad">guasto Enel vicino</Badge>}
                      </div>
                      <ul className="hl-list">
                        {aps.map((a) => {
                          const id = `ap:${a.id}`;
                          const hasPos = a.lat != null && a.lon != null;
                          return (
                            <li key={id} className={`hl-row nw-ap ui-tone-${STATE[a.state][1]}`}>
                              <span className="hl-dot" />
                              <div className="hl-main">
                                <div className="hl-name">
                                  <strong>{a.name}</strong>
                                  {a.ssid && a.ssid !== a.name && <span className="ui-muted ui-small">{a.ssid}</span>}
                                  <Badge tone={STATE[a.state][1]}>{STATE[a.state][0]}</Badge>
                                  {a.powerOutage && <Badge tone="bad">guasto Enel vicino</Badge>}
                                </div>
                                <div className="hl-sub nw-sub">
                                  <CpeBar a={a} />
                                  {a.model && <span className="ui-muted ui-small">{a.model}</span>}
                                </div>
                              </div>
                              {a.lastSeen && (
                                <div className="hl-signal">
                                  <span className="ui-small">{date(a.lastSeen)}</span>
                                  <span className="ui-muted ui-small">ultimo contatto</span>
                                </div>
                              )}
                              {admin && (
                                <div className="hl-actions">
                                  {hasPos ? (
                                    <>
                                      <Button variant="ghost" onClick={() => mapApi.current?.focus(id)}>
                                        Mappa
                                      </Button>
                                      {a.served?.servedM ? (
                                        <Button variant={open.has(id) ? 'secondary' : 'ghost'} onClick={() => (open.has(id) ? mapApi.current?.toggle(id) : mapApi.current?.focus(id, true))}>
                                          {open.has(id) ? 'Chiudi fascio' : 'Fascio'}
                                        </Button>
                                      ) : null}
                                    </>
                                  ) : (
                                    <span className="ui-muted ui-small">senza posizione</span>
                                  )}
                                </div>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </Card>
                  );
                })
              ) : (
                <Card>
                  <p className="ui-muted">{data.pops.length || data.apsWithoutPop.length ? 'Nessun AP con questi filtri.' : 'Nessun POP o AP.'}</p>
                </Card>
              )}
              <p className="ui-muted ui-small">{total} AP mostrati. "Molte CPE offline": almeno il 30% delle CPE dell’AP non è raggiungibile (probabile problema di settore, non del singolo cliente).</p>
            </>
          )}
        </>
      )}
    </div>
  );
}
