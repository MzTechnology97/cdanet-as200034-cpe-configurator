import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ChangeEvent, useMemo, useRef, useState } from 'react';
import { toast } from '../lib/toast';
import { drawOutages, MAP_COLORS as C } from '../map/leaflet';
import { MyTelegram } from '../account/MyTelegram';
import { type Infra, itemLabel, itemNames, Picker } from '../infra/Picker';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { type LMap, MapView } from '../map/MapView';
import type { PageContext } from '../shell/routes';
import { AsyncButton, Badge, Button, Card, EmptyState, Field, Notice, PageHeader, Skeleton, Stat } from '../ui';

/**
 * Guasti Enel: outages and planned works of the power network in the areas of interest (admins:
 * every zone and the POPs/APs monitored; installers: their own zones and the POPs/APs assigned to
 * them, the latter as approximate areas). The map is the page's own: a "Mappa" button never opens
 * an external site. The server's live events refresh the lists and the map.
 */

type Tone = 'good' | 'warn' | 'bad' | 'neutral';
const KIND: Record<string, [string, Tone]> = { guasto_mt: ['Guasto MT', 'bad'], guasto_bt: ['Guasto BT', 'warn'], lavoro: ['Lavoro programmato', 'neutral'], altro: ['Interruzione', 'warn'] };
const local = (s?: string | null) => (s ? s.replace('T', ' ').replace(/^(\d{4})-(\d{2})-(\d{2})/, '$3/$2/$1') : '—');
const dist = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`);
const coords = (z: { lat: number; lon: number }) => `${z.lat.toFixed(4)}, ${z.lon.toFixed(4)}`;
const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const fail = (e: unknown) => toast((e as Error).message, 'bad');

interface Impact {
  type: 'pop' | 'ap';
  id: string;
  name: string;
  distanceM: number;
  stations?: number | null;
}
interface Outage {
  id: string;
  kind: string;
  place: string;
  province: string;
  customers: number;
  start?: string;
  expectedRestore?: string | null;
  firstSeen?: string;
  endedAt?: string;
  lat: number;
  lon: number;
  zones: Array<{ id: string; name: string; distanceM: number }>;
  impact: Impact[];
}
interface List {
  active: Outage[];
  recent?: Outage[];
  generatedAt?: string | null;
  lastRun?: { at: string; ok: boolean; error?: string } | null;
  scope?: { assigned: Array<{ key: string; name: string }> } | null;
}
interface Zone {
  id: string;
  name: string;
  lat: number;
  lon: number;
  radiusKm: number;
  owner?: string;
  paused?: boolean;
  notifyMt?: boolean;
  notifyBt?: boolean;
  notifyPlanned?: boolean;
  activeCount?: number;
}
type Point = { id: string; lat: number; lon: number };

/** The view of the map the lists ask for: an outage or a zone, centred with its details. */
interface MapApi {
  show: (o: Point) => void;
}

export function Outages({ user }: PageContext) {
  const admin = user.role === 'admin';
  const qc = useQueryClient();
  const list = useQuery({ queryKey: [...keys.outages, 'list'], queryFn: () => api<List>('/api/outages?recent=1'), refetchInterval: 5 * 60_000 });
  const mapApi = useRef<MapApi | null>(null);
  const onMap = (o: Point) => mapApi.current?.show(o);
  // a check or a change of the zones: everything of this page read again
  const reloadAll = () => qc.invalidateQueries({ queryKey: keys.outages });
  const d = list.data;

  const faults = d ? d.active.filter((o) => o.kind !== 'lavoro') : [];
  const seesImpact = admin || (d?.scope?.assigned?.length ?? 0) > 0;
  const impacted = d ? new Set(d.active.flatMap((o) => o.impact.map((i) => `${i.type}:${i.id}`))).size : 0;

  return (
    <div className="ui-page">
      <PageHeader
        icon="power_off"
        title="Guasti Enel"
        subtitle={admin ? 'Guasti e lavori della rete elettrica (e-distribuzione) nelle zone di interesse e attorno agli AP.' : 'Guasti e lavori della rete elettrica nelle tue zone.'}
        actions={
          <Button icon="refresh" busy={list.isFetching} onClick={() => void reloadAll()}>
            Aggiorna
          </Button>
        }
      />
      {list.error && <Notice tone="bad">{(list.error as Error).message}</Notice>}
      {!d && !list.error && <Skeleton lines={4} />}
      {d && (
        <>
          <section aria-label="Riepilogo" className="ui-stats">
            <Stat label="guasti in corso" value={faults.length} tone={faults.length ? 'bad' : 'good'} />
            <Stat label="di cui media tensione" value={faults.filter((o) => o.kind === 'guasto_mt').length} />
            <Stat label="lavori programmati" value={d.active.length - faults.length} />
            <Stat label="clienti Enel disalimentati" value={d.active.reduce((a, o) => a + o.customers, 0)} />
            {seesImpact && <Stat label="POP/AP potenzialmente impattati" value={impacted} tone={impacted ? 'warn' : 'good'} />}
          </section>
          <p className="ui-muted ui-small">
            {admin
              ? `${d.lastRun ? `Ultimo controllo ${date(d.lastRun.at)}${d.lastRun.ok ? '' : ` · errore: ${d.lastRun.error}`} · ` : 'Nessun controllo ancora eseguito · '}fonte: mappa pubblica dei guasti di e-distribuzione, controllata ogni 10 minuti.`
              : d.generatedAt
                ? `Aggiornato ${date(d.generatedAt)} · ogni 10 minuti`
                : 'In attesa del primo aggiornamento'}
          </p>
        </>
      )}
      <OutagesMap admin={admin} apiRef={mapApi} />
      {d && !admin && d.scope && (
        <Card title="POP/AP assegnati a te">
          {d.scope.assigned.length ? (
            <div className="ui-row">
              {d.scope.assigned.map((i) => (
                <Badge key={i.key}>{itemLabel(i)}</Badge>
              ))}
            </div>
          ) : (
            <p className="ui-muted ui-small">Nessuno: vedi i guasti nelle tue zone, senza i POP/AP potenzialmente impattati.</p>
          )}
        </Card>
      )}
      {d && (
        <Card title={admin ? 'In corso nelle zone di interesse' : 'In corso nelle tue zone'} padded={!d.active.length}>
          {d.active.length ? (
            <ul className="hl-list">
              {d.active.map((o) => (
                <li key={o.id} className={`hl-row og-row ui-tone-${KIND[o.kind]?.[1] ?? 'warn'}`}>
                  <span className="hl-dot" />
                  <div className="hl-main">
                    <div className="hl-name">
                      <Badge tone={KIND[o.kind]?.[1] ?? 'warn'}>{KIND[o.kind]?.[0] ?? o.kind}</Badge>
                      <strong>{o.place || '—'}</strong>
                      <span className="ui-muted ui-small">{o.province}</span>
                    </div>
                    <div className="hl-sub og-sub">
                      {o.zones[0] && (
                        <span>
                          zona {o.zones[0].name} a {dist(o.zones[0].distanceM)}
                          {o.zones.length > 1 ? ` · +${o.zones.length - 1}` : ''}
                        </span>
                      )}
                      <span>{o.customers} clienti Enel</span>
                      <span>dal {local(o.start)}</span>
                      <span>ripristino previsto {local(o.expectedRestore)}</span>
                    </div>
                    {seesImpact && o.impact.length > 0 && (
                      <div className="ui-row hl-badges">
                        {o.impact.slice(0, 4).map((i) => (
                          <Badge key={`${i.type}:${i.id}`} tone="bad">
                            {i.type === 'pop' ? 'POP' : 'AP'} {i.name} · {dist(i.distanceM)}
                            {i.stations != null ? ` · ${i.stations} CPE` : ''}
                          </Badge>
                        ))}
                        {o.impact.length > 4 && <span className="ui-small">+{o.impact.length - 4}</span>}
                      </div>
                    )}
                  </div>
                  <div className="hl-actions">
                    <Button variant="ghost" icon="explore" onClick={() => onMap(o)}>
                      Mappa
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title={admin ? 'Nessun guasto né lavoro in corso nelle zone di interesse' : 'Nessun guasto né lavoro in corso nelle tue zone'} />
          )}
        </Card>
      )}
      {!!d?.recent?.length && (
        <Card title="Ripristinati nelle ultime 48 ore" padded={false}>
          <ul className="hl-list">
            {d.recent.map((o) => (
              <li key={o.id} className="hl-row">
                <div className="hl-main">
                  <div className="hl-name">
                    <Badge>{KIND[o.kind]?.[0] ?? o.kind}</Badge>
                    <strong>
                      {o.place} ({o.province})
                    </strong>
                  </div>
                  <div className="hl-sub og-sub">
                    {o.zones[0] && <span>zona {o.zones[0].name}</span>}
                    <span>
                      {date(o.firstSeen)} → {date(o.endedAt)}
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <MyTelegram title="Notifiche" appHint />
      {!admin && <MyZones onMap={onMap} />}
      {admin && <InfraCard onSaved={reloadAll} />}
      {admin && <AdminZones onMap={onMap} onChecked={reloadAll} />}
    </div>
  );
}

/**
 * Map of outages, zones and POPs/APs (installers: only assigned POPs/APs, as approximate areas),
 * drawn again after every check without moving the view.
 */
function OutagesMap({ admin, apiRef }: { admin: boolean; apiRef: { current: MapApi | null } }) {
  const q = useQuery({ queryKey: [...keys.outages, 'map'], queryFn: () => api('/api/outages/map') });
  const mapRef = useRef<LMap | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const markers = useRef(new Map<string, any>());
  apiRef.current = {
    show: (o) => {
      const map = mapRef.current;
      if (!map) return;
      map.getContainer().scrollIntoView({ behavior: 'smooth', block: 'center' });
      const m = markers.current.get(o.id);
      if (m?.getBounds) map.fitBounds(m.getBounds().pad(0.1), { maxZoom: 15 });
      else map.setView(m ? m.getLatLng() : [o.lat, o.lon], Math.max(map.getZoom(), 15));
      m?.openPopup();
    },
  };
  return (
    <Card title="Mappa">
      <MapView
        zoom={9}
        fitMode="once"
        mapRef={mapRef}
        deps={[q.data]}
        draw={(target) => {
          markers.current.clear();
          if (!q.data) return [];
          const layers = drawOutages(target, q.data, (o, marker) => void markers.current.set(String(o.id), marker));
          for (const [i, z] of ((q.data.zones ?? []) as Array<{ id: string }>).entries()) markers.current.set(z.id, layers[i]);
          return layers;
        }}
        legendItems={[
          [C.guasto_mt, 'Guasto MT'],
          [C.guasto_bt, 'Guasto BT'],
          [C.lavoro, 'Lavoro programmato'],
          [C.pop, 'POP'],
          [C.ap, 'AP'],
          [C.impacted, 'POP/AP potenzialmente impattato'],
          [admin ? C.zone : C.personal, admin ? 'Zona condivisa / personale' : 'Le tue zone'],
        ]}
      />
      {q.error ? <p className="ui-muted ui-small">{(q.error as Error).message}</p> : !admin && <p className="ui-muted ui-small">POP e AP sono mostrati come area approssimativa.</p>}
    </Card>
  );
}

/**
 * New area of interest: GPS of the device (with the address filled in), address search or typed
 * coordinates (with "address from coordinates"). [post] stores it (shared zone or personal zone);
 * [rules]: personal zones choose which outages notify (planned works off by default).
 */
function ZoneForm({ post, onDone, rules = false }: { post: (body: object) => Promise<unknown>; onDone: () => Promise<unknown> | void; rules?: boolean }) {
  const empty = { name: '', street: '', number: '', city: '', prov: '', cap: '', lat: '', lon: '', radius: '2', mt: true, bt: true, planned: false };
  const [f, setF] = useState(empty);
  const [where, setWhere] = useState('');
  const set = (k: keyof typeof empty) => (e: ChangeEvent<HTMLInputElement>) => {
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setF((x) => ({ ...x, [k]: v }));
  };
  const fillAddress = async (la: number, lo: number) => {
    const r = await api(`/api/geocode/reverse?lat=${la}&lon=${lo}`).catch(() => null);
    if (!r) return;
    setF((x) => ({ ...x, street: r.street ?? '', number: r.houseNumber ?? '', city: r.city ?? '', prov: r.province ?? '', cap: r.postcode ?? '', name: x.name.trim() ? x.name : [r.street, r.city].filter(Boolean).join(', ') }));
    setWhere(r.label);
  };
  const gps = async () => {
    if (!navigator.geolocation) throw new Error('Geolocalizzazione non disponibile in questo browser');
    if (!window.isSecureContext) throw new Error('Il GPS del browser funziona solo con la console in HTTPS');
    const p = await new Promise<GeolocationPosition>((res, rej) => navigator.geolocation.getCurrentPosition(res, (e) => rej(new Error(e.code === 1 ? 'Permesso di posizione negato' : 'Posizione non disponibile')), { enableHighAccuracy: true, timeout: 20000 }));
    setF((x) => ({ ...x, lat: p.coords.latitude.toFixed(6), lon: p.coords.longitude.toFixed(6) }));
    setWhere(`Precisione ±${Math.round(p.coords.accuracy)} m · ricerca indirizzo…`);
    await fillAddress(p.coords.latitude, p.coords.longitude);
  };
  const find = async () => {
    const q = [[f.street, f.number].filter(Boolean).join(' '), f.cap, f.city, f.prov].map((x) => x.trim()).filter(Boolean).join(', ');
    if (q.length < 3) throw new Error('Inserisci almeno via e città');
    const g = await api<Array<{ lat: number; lon: number; label: string }>>(`/api/geocode?q=${encodeURIComponent(q)}`);
    if (!g.length) throw new Error('Indirizzo non trovato');
    setF((x) => ({ ...x, lat: g[0]!.lat.toFixed(6), lon: g[0]!.lon.toFixed(6), name: x.name.trim() ? x.name : [x.street, x.city].map((v) => v.trim()).filter(Boolean).join(', ') }));
    setWhere(g[0]!.label);
  };
  const num = (v: string) => Number(String(v).replace(',', '.'));
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
  const input = (k: keyof typeof empty, props: Record<string, unknown> = {}) => <input value={String(f[k])} onChange={set(k)} {...props} />;
  return (
    <details className="og-form ui-details">
      <summary>Nuova zona</summary>
      <div className="ui-grid-form">
        <Field label="Nome">{input('name', { placeholder: 'es. Centro Enna, casa, frazione' })}</Field>
        <Field label="Raggio (km)">{input('radius', { type: 'number', min: 0.2, max: 50, step: 0.5 })}</Field>
      </div>
      <div className="ui-row">
        <AsyncButton icon="my_location" onClick={gps} onError={fail}>
          Usa GPS di questo dispositivo
        </AsyncButton>
      </div>
      <div className="ui-grid-form">
        <Field label="Via">{input('street', { placeholder: 'Via Roma' })}</Field>
        <Field label="Civico">{input('number', { placeholder: '12', inputMode: 'numeric' })}</Field>
        <Field label="Città">{input('city', { placeholder: 'Enna' })}</Field>
        <Field label="Provincia">{input('prov', { placeholder: 'EN', maxLength: 30 })}</Field>
        <Field label="CAP">{input('cap', { placeholder: '94100', inputMode: 'numeric', maxLength: 5 })}</Field>
      </div>
      <div className="ui-row">
        <AsyncButton icon="search" onClick={find} onError={fail}>
          Cerca indirizzo
        </AsyncButton>
      </div>
      <div className="ui-grid-form">
        <Field label="Latitudine">{input('lat', { placeholder: '37.5670', inputMode: 'decimal' })}</Field>
        <Field label="Longitudine">{input('lon', { placeholder: '14.2790', inputMode: 'decimal' })}</Field>
      </div>
      {rules && (
        <div className="ui-row">
          <span className="ui-muted ui-small">Avvisami di:</span>
          <label className="ui-check">
            <input type="checkbox" checked={f.mt} onChange={set('mt')} /> guasti media tensione
          </label>
          <label className="ui-check">
            <input type="checkbox" checked={f.bt} onChange={set('bt')} /> guasti bassa tensione
          </label>
          <label className="ui-check">
            <input type="checkbox" checked={f.planned} onChange={set('planned')} /> lavori programmati
          </label>
        </div>
      )}
      <div className="ui-row">
        <AsyncButton onClick={() => fillAddress(num(f.lat), num(f.lon))} onError={fail}>
          Indirizzo dalle coordinate
        </AsyncButton>
        <AsyncButton variant="primary" icon="add_circle" onClick={add} onError={fail}>
          Aggiungi zona
        </AsyncButton>
      </div>
      {where && <p className="ui-muted ui-small">{where}</p>}
    </details>
  );
}

function DeleteZone({ z, onDelete }: { z: Zone; onDelete: (z: Zone) => Promise<unknown> }) {
  return (
    <AsyncButton variant="danger" onClick={async () => confirm(`Eliminare la zona ${z.name}?`) && (await onDelete(z))} onError={fail}>
      Elimina
    </AsyncButton>
  );
}

/** Zones as rows: name, centre (on the page's map), radius, delete. */
function ZoneRows({ zones, onDelete, onMap, owner = false }: { zones: Zone[]; onDelete: (z: Zone) => Promise<unknown>; onMap: (z: Point) => void; owner?: boolean }) {
  return (
    <ul className="hl-list og-zones">
      {zones.map((z) => (
        <li key={z.id} className="hl-row">
          <div className="hl-main">
            <div className="hl-name">
              <strong>{z.name}</strong>
              {owner && <span className="ui-muted ui-small">{z.owner}</span>}
            </div>
            <div className="hl-sub">
              <button type="button" className="ui-link" title="Mostra sulla mappa" onClick={() => onMap(z)}>
                {coords(z)}
              </button>{' '}
              · raggio {z.radiusKm} km
            </div>
          </div>
          <div className="hl-actions">
            <DeleteZone z={z} onDelete={onDelete} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * The user's own areas of interest, each with its rules: active or paused, and which outages notify
 * (app and personal Telegram). Changes are saved at once.
 */
function MyZones({ onMap }: { onMap: (z: Point) => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: [...keys.outages, 'my-zones'], queryFn: () => api<{ zones: Zone[]; max: number }>('/api/outages/zones') });
  const reload = () => qc.invalidateQueries({ queryKey: keys.outages });
  const save = async (z: Zone, patch: Partial<Zone>) => {
    try {
      await api(`/api/outages/zones/${z.id.slice(1)}`, { method: 'PUT', body: patch });
    } catch (e) {
      fail(e);
    }
    await reload();
  };
  const del = async (z: Zone) => {
    await api(`/api/outages/zones/${z.id.slice(1)}`, { method: 'DELETE' });
    await reload();
  };
  const rule = (z: Zone, key: 'notifyMt' | 'notifyBt' | 'notifyPlanned', label: string) => (
    <label className="ui-check ui-small">
      <input type="checkbox" checked={!!z[key]} disabled={z.paused} onChange={(e) => void save(z, { [key]: e.target.checked })} /> {label}
    </label>
  );
  const d = q.data;
  return (
    <Card title="Le mie aree di interesse">
      <p className="ui-muted ui-small">
        Luoghi che vuoi seguire, anche fuori dai POP/AP che ti sono assegnati (massimo {d?.max ?? 20}). Per ognuna scegli quali avvisi ricevere sul telefono e su Telegram, oppure mettila in pausa: i guasti restano comunque visibili qui. I POP/AP potenzialmente impattati li vedi solo per quelli assegnati.
      </p>
      {q.error && <Notice tone="bad">{(q.error as Error).message}</Notice>}
      {d?.zones.length ? (
        <ul className="hl-list og-zones">
          {d.zones.map((z) => (
            <li key={z.id} className="hl-row">
              <div className="hl-main">
                <div className="hl-name">
                  <strong>{z.name}</strong>
                  {z.activeCount ? (
                    <Badge tone="warn">
                      {z.activeCount} {z.activeCount === 1 ? 'interruzione' : 'interruzioni'}
                    </Badge>
                  ) : (
                    <Badge tone="good">nessuna interruzione</Badge>
                  )}
                  {z.paused && <Badge tone="warn">in pausa</Badge>}
                </div>
                <div className="hl-sub">
                  <button type="button" className="ui-link" title="Mostra sulla mappa" onClick={() => onMap(z)}>
                    {coords(z)}
                  </button>{' '}
                  · {z.radiusKm} km
                </div>
                <div className="ui-row">
                  <span className="ui-muted ui-small">Avvisi:</span>
                  {rule(z, 'notifyMt', 'MT')}
                  {rule(z, 'notifyBt', 'BT')}
                  {rule(z, 'notifyPlanned', 'lavori')}
                </div>
              </div>
              <div className="hl-actions">
                <AsyncButton onClick={() => save(z, { paused: !z.paused })} onError={fail}>
                  {z.paused ? 'Riattiva' : 'Metti in pausa'}
                </AsyncButton>
                <DeleteZone z={z} onDelete={del} />
              </div>
            </li>
          ))}
        </ul>
      ) : d ? (
        <p className="ui-muted ui-small">Nessuna area: aggiungine una qui sotto.</p>
      ) : null}
      <ZoneForm post={(body) => api('/api/outages/zones', { method: 'POST', body })} onDone={reload} rules />
    </Card>
  );
}

interface InfraData {
  inf: Infra & { missing: { pops: string[]; aps: string[] } };
  sel: { selectionOnly: boolean; items: Array<{ key: string; name: string }> };
  cfg: { zones: Zone[] };
}

/** Admin: POPs and APs straight from UISP (names, addresses, coordinates): pick the ones to monitor. */
function InfraCard({ onSaved }: { onSaved: () => Promise<unknown> }) {
  const q = useQuery({
    queryKey: [...keys.outages, 'infra'],
    queryFn: async (): Promise<InfraData> => {
      const [inf, sel, cfg] = await Promise.all([api('/api/admin/outages/infra'), api('/api/admin/outages/selection'), api('/api/admin/outages/config')]);
      return { inf, sel, cfg };
    },
    staleTime: 5 * 60_000,
  });
  const [mode, setMode] = useState<'all' | 'only' | null>(null);
  const [edited, setEdited] = useState<Set<string> | null>(null);
  const d = q.data;
  const names = useMemo(() => {
    if (!d) return new Map<string, string>();
    const m = itemNames(d.inf, d.cfg.zones);
    for (const it of d.sel.items) if (!m.has(it.key)) m.set(it.key, it.name);
    return m;
  }, [d]);
  if (q.error) {
    const e = q.error as Error & { body?: { error?: string } };
    return (
      <Card title="POP e AP da UISP">
        <p className="ui-muted ui-small">{e.body?.error === 'uisp_not_configured' ? 'UISP non configurato: POP e AP arrivano da UISP (Connettori).' : e.message}</p>
      </Card>
    );
  }
  if (!d) return null;
  const { inf, sel } = d;
  // the choice being made (the saved one until a box is touched)
  const chosen = edited ?? new Set(sel.items.map((i) => i.key));
  const count = `${[...chosen].filter((k) => k.startsWith('pop:')).length} POP · ${[...chosen].filter((k) => k.startsWith('ap:')).length} AP selezionati`;
  const how = mode ?? (sel.selectionOnly ? 'only' : 'all');
  const live = new Set(itemNames(inf, []).keys());
  const gone = sel.items.filter((i) => !live.has(i.key));
  const apCount = inf.pops.reduce((t: number, p: { aps: unknown[] }) => t + p.aps.length, 0) + inf.apsWithoutPop.length;
  const selectAll = () => setEdited(new Set([...names.keys()].filter((k) => !k.startsWith('z'))));
  const selectNone = () => setEdited(new Set());
  const save = async () => {
    if (how === 'only' && !chosen.size) throw new Error('Seleziona almeno un POP o un AP, oppure scegli "tutti"');
    await api('/api/admin/outages/selection', { method: 'PUT', body: { selectionOnly: how === 'only', items: [...chosen].map((key) => ({ key, name: names.get(key) ?? key })) } });
    toast(how === 'only' ? `Monitorati solo i ${chosen.size} POP/AP selezionati` : 'Monitorati tutti i POP/AP di UISP');
    setMode(null);
    setEdited(null);
    await onSaved();
  };
  return (
    <Card title={`POP e AP da UISP: ${inf.pops.length} POP · ${apCount} AP`}>
      <p className="ui-muted ui-small">Elenco, nomi, indirizzi e coordinate sono importati da UISP a ogni controllo: per correggerli modifica il site o il dispositivo in UISP. Un AP senza posizione propria usa quella del suo POP.</p>
      {(inf.missing.pops.length > 0 || inf.missing.aps.length > 0) && (
        <Notice tone="warn">
          Senza posizione in UISP (non monitorabili): {[...inf.missing.pops.map((n: string) => `POP ${n}`), ...inf.missing.aps.map((n: string) => `AP ${n}`)].join(', ')}. Impostala in UISP → Sites/Devices → Location.
        </Notice>
      )}
      <label className="ui-check">
        <input type="radio" name="selmode" checked={how === 'all'} onChange={() => setMode('all')} />
        Monitora tutti i POP e gli AP di UISP
      </label>
      <label className="ui-check">
        <input type="radio" name="selmode" checked={how === 'only'} onChange={() => setMode('only')} />
        Monitora solo quelli selezionati qui sotto
      </label>
      {gone.length > 0 && <Notice tone="warn">Selezionati ma non più presenti in UISP: {gone.map((i) => i.name).join(', ')}.</Notice>}
      <div className="ui-row">
        <Button onClick={selectAll}>Seleziona tutti</Button>
        <Button onClick={selectNone}>Nessuno</Button>
        <span className="ui-muted ui-small">{count}</span>
      </div>
      <Picker inf={inf} chosen={chosen} onChange={setEdited} cascade />
      <div className="ui-row">
        <AsyncButton variant="primary" onClick={save} onError={fail}>
          Salva selezione
        </AsyncButton>
      </div>
      <p className="ui-muted ui-small">Quali POP/AP vede ogni installatore (guasti e verifica copertura) si decide in Account → POP/AP assegnati agli installatori.</p>
    </Card>
  );
}

interface Config {
  config: { apZones: boolean; apRadiusKm: number; impactRadiusKm?: number; includePlanned: boolean };
  zones: Zone[];
  personalZones?: Zone[];
  apZonesCount: number;
}

/** Admin: zones of interest (automatic around the APs, shared, personal of the installers) and the check. */
function AdminZones({ onMap, onChecked }: { onMap: (z: Point) => void; onChecked: () => Promise<unknown> }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: [...keys.outages, 'config'], queryFn: () => api<Config>('/api/admin/outages/config') });
  const [edit, setEdit] = useState<{ apZones: boolean; apRadiusKm: string; impactRadiusKm: string; includePlanned: boolean } | null>(null);
  const c = q.data;
  if (q.error) return <Notice tone="bad">{(q.error as Error).message}</Notice>;
  if (!c) return null;
  const f = edit ?? { apZones: c.config.apZones, apRadiusKm: String(c.config.apRadiusKm), impactRadiusKm: String(c.config.impactRadiusKm ?? 1), includePlanned: c.config.includePlanned };
  const reload = () => qc.invalidateQueries({ queryKey: keys.outages });
  const save = async () => {
    await api('/api/admin/outages/config', { method: 'PUT', body: { apZones: f.apZones, apRadiusKm: Number(f.apRadiusKm) || 3, includePlanned: f.includePlanned, impactRadiusKm: Number(f.impactRadiusKm) || 1 } });
    toast('Impostazioni salvate');
    setEdit(null);
    await reload();
  };
  const refresh = async () => {
    const r = await api<{ ok: boolean; active: unknown[]; error?: string }>('/api/admin/outages/refresh', { method: 'POST', body: {} });
    toast(r.ok ? `Controllo eseguito: ${r.active.length} eventi nelle zone` : `Errore: ${r.error}`, r.ok ? '' : 'bad');
    await onChecked();
  };
  const delZone = async (z: Zone) => {
    await api(`/api/admin/outages/zones/${z.id.slice(1)}`, { method: 'DELETE' });
    await reload();
  };
  return (
    <Card title="Zone di interesse">
      <label className="ui-check">
        <input type="checkbox" checked={f.apZones} onChange={(e) => setEdit({ ...f, apZones: e.target.checked })} />
        Zone automatiche attorno a ogni AP e POP monitorato ({c.apZonesCount} con posizione)
      </label>
      <div className="ui-grid-form">
        <Field label="Raggio attorno agli AP (km)">
          <input type="number" min="0.5" max="30" step="0.5" value={f.apRadiusKm} onChange={(e) => setEdit({ ...f, apRadiusKm: e.target.value })} />
        </Field>
        <Field label="Raggio «POP/AP impattati» (km)" hint="Un guasto più vicino di questo raggio a un POP o a un AP monitorato viene segnalato come impatto probabile (🚨 su Telegram), anche fuori dalle zone.">
          <input type="number" min="0.1" max="5" step="0.1" value={f.impactRadiusKm} onChange={(e) => setEdit({ ...f, impactRadiusKm: e.target.value })} />
        </Field>
      </div>
      <label className="ui-check">
        <input type="checkbox" checked={f.includePlanned} onChange={(e) => setEdit({ ...f, includePlanned: e.target.checked })} />
        Includi i lavori programmati
      </label>
      <div className="ui-row">
        <AsyncButton variant="primary" onClick={save} onError={fail}>
          Salva impostazioni
        </AsyncButton>
        <AsyncButton icon="refresh" onClick={refresh} onError={fail}>
          Controlla ora
        </AsyncButton>
      </div>
      <h3 className="og-h3">Zone condivise (aree extra senza AP o POP, es. una frazione)</h3>
      {c.zones.length ? <ZoneRows zones={c.zones} onDelete={delZone} onMap={onMap} /> : <p className="ui-muted ui-small">Nessuna zona condivisa.</p>}
      <ZoneForm post={(body) => api('/api/admin/outages/zones', { method: 'POST', body })} onDone={reload} />
      {!!c.personalZones?.length && (
        <>
          <h3 className="og-h3">Zone personali degli installatori</h3>
          <p className="ui-muted ui-small">Notificate solo all’installatore (app e Telegram personale), non al gruppo.</p>
          <ZoneRows zones={c.personalZones} onDelete={delZone} onMap={onMap} owner />
        </>
      )}
      <p className="ui-muted ui-small">Le notifiche Telegram al gruppo si attivano in Connettori → Telegram → evento "Guasti Enel".</p>
    </Card>
  );
}
