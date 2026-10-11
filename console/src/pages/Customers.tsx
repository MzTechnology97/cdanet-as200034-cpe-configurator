import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { MapView, mapPopup } from '../map/MapView';
import type { PageContext } from '../shell/routes';
import { Badge, Button, Card, Drawer, EmptyState, Icon, Notice, PageHeader, Skeleton } from '../ui';

/**
 * Clienti (admins, ISP Billing connected): customer records and installation sites from the CRM,
 * with the PPPoE session and the CPE in UISP. Read only: the position of each site is compared with
 * the CPE's, nothing is written.
 */

type Tone = 'good' | 'warn' | 'bad' | 'neutral' | 'info';
const FILTERS: Array<[string, string]> = [
  ['with_accounts', 'Clienti con PPPoE'],
  ['offline', 'PPPoE offline'],
  ['suspended', 'Sospesi'],
  ['mismatch', 'Sede e CPE distanti oltre 100 m'],
  ['nocoords', 'Sede senza coordinate'],
  ['all', 'Tutte le anagrafiche'],
];
const TYPES: Record<string, string> = { private: 'privato', business: 'azienda', association: 'associazione', public_administration: 'pubblica amministrazione' };
const STATUS: Record<string, [string, Tone]> = {
  active: ['attivo', 'good'],
  suspended: ['sospeso', 'warn'],
  termination_in_progress: ['in cessazione', 'warn'],
  activation_in_progress: ['in attivazione', 'neutral'],
  waiting_confirmation: ['da confermare', 'neutral'],
  occasional: ['occasionale', 'neutral'],
};
const SITE_COLOR = '#3b82f6';
const CPE_COLOR = '#f97316';

interface Account {
  username: string;
  online?: boolean | null;
  suspended?: boolean;
  profile?: string;
  speed?: { down: number; up: number } | null;
  clientIp?: string;
}
interface Site {
  address?: string;
  description?: string;
  position?: { lat: number; lon: number } | null;
  approximate?: boolean;
  account: Account;
  cpe?: { id?: string; name: string; model?: string; mac?: string; apName?: string | null; status?: string; signal?: number | null; position?: { lat: number; lon: number } | null } | null;
  distanceM?: number | null;
  suspicious?: boolean;
}
interface Customer {
  customerId: string;
  name: string;
  code?: string;
  type?: string;
  status: string;
  group?: string;
  phone?: string;
  phone2?: string;
  email?: string;
  mainAddress?: string;
  sites: Site[];
}

const dist = (m?: number | null) => (m == null ? '—' : m < 1000 ? `${m} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`);
const ppp = (a: Account): [string, Tone] => (a.suspended ? ['sospeso', 'warn'] : a.online === true ? ['online', 'good'] : a.online === false ? ['offline', 'bad'] : ['?', 'neutral']);

function Gap({ x }: { x: Site }) {
  if (!x.position) return <Badge tone="warn">senza coordinate</Badge>;
  if (!x.cpe) return <span className="ui-muted ui-small">CPE non trovata in rete</span>;
  if (!x.cpe.position) return <span className="ui-muted ui-small">CPE senza posizione</span>;
  return (
    <span>
      {x.distanceM != null && x.distanceM > 100 ? <Badge tone={x.distanceM > 500 ? 'bad' : 'warn'}>{dist(x.distanceM)}</Badge> : <span className="ui-small">{dist(x.distanceM)}</span>}
      {x.suspicious && <span className="ui-muted ui-small"> · posizione UISP = AP o sito</span>}
    </span>
  );
}

export function Customers({ params }: PageContext) {
  const [which, setWhich] = useState(params.get('q') ? 'all' : 'with_accounts');
  const [q, setQ] = useState(params.get('q') ?? '');
  const [term, setTerm] = useState(q.trim());
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);
  const list = useQuery({
    queryKey: ['customers', 'list', which, term],
    queryFn: () => api<{ at: string | null; running?: boolean; total: number; rows: Customer[] }>(`/api/admin/crm/customers?filter=${which}&q=${encodeURIComponent(term)}&limit=300`),
  });
  const r = list.data;

  return (
    <div className="ui-page">
      <PageHeader
        icon="my_location"
        title="Clienti"
        subtitle="Anagrafiche e sedi di installazione dal CRM, con la sessione PPPoE e la CPE in rete. Solo consultazione: le posizioni vengono confrontate, non modificate."
        actions={
          <Button icon="refresh" busy={list.isFetching} onClick={() => void list.refetch()}>
            Aggiorna
          </Button>
        }
      />
      <div className="hl-toolbar">
        <label className="hl-search">
          <Icon name="search" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nome, codice, telefono, indirizzo, utente PPPoE, MAC, AP…" aria-label="Cerca" />
        </label>
        <select className="wo-date" value={which} onChange={(e) => setWhich(e.target.value)} aria-label="Mostra">
          {FILTERS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>
      {list.error ? (
        <Notice tone="bad">{(list.error as Error).message}</Notice>
      ) : !r ? (
        <Skeleton lines={6} />
      ) : !r.at && !r.total ? (
        <Notice tone="warn">Nessun dato dal CRM: collega ISP Billing in Connettori → CRM e attendi la prima sincronizzazione (circa un minuto).</Notice>
      ) : (
        <Card padded={false}>
          <div className="hl-count">
            {r.total.toLocaleString('it-IT')} clienti
            <span className="ui-muted">
              {' '}
              · dati del CRM aggiornati {r.at ? new Date(r.at).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : 'mai'}
              {r.running ? ' · aggiornamento in corso…' : ''}
            </span>
          </div>
          {!r.rows.length ? (
            <EmptyState title="Nessun cliente con questi filtri" />
          ) : (
            <ul className="hl-list">
              {r.rows.map((c) => (
                <li key={c.customerId} className="hl-row cu-row" role="button" tabIndex={0} onClick={() => setOpen(c.customerId)} onKeyDown={(e) => e.key === 'Enter' && setOpen(c.customerId)}>
                  <div className="hl-main">
                    <div className="hl-name">
                      <strong>{c.name || '—'}</strong>
                      {c.status !== 'active' && STATUS[c.status] && <Badge tone={STATUS[c.status]![1]}>{STATUS[c.status]![0]}</Badge>}
                    </div>
                    <div className="hl-sub">{[c.code, TYPES[c.type ?? ''] ?? c.type, c.group, c.sites.length ? c.sites.map((x) => x.address).filter(Boolean).join(' · ') : c.mainAddress].filter(Boolean).join(' · ')}</div>
                    <div className="ui-row hl-badges">
                      {c.sites.map((x, i) => (
                        <span key={i} className="ui-row">
                          <Badge tone={ppp(x.account)[1]}>PPPoE {ppp(x.account)[0]}</Badge>
                          {x.cpe ? <Badge>{x.cpe.name}</Badge> : <Badge tone="neutral">CPE non trovata</Badge>}
                          <Gap x={x} />
                        </span>
                      ))}
                    </div>
                  </div>
                  <Icon name="chevron_right" />
                </li>
              ))}
            </ul>
          )}
          {r.total > r.rows.length && <p className="ui-muted ui-small hl-more">Mostrati i primi {r.rows.length}: usa la ricerca o i filtri.</p>}
        </Card>
      )}
      {open && <CustomerDrawer id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** One customer: contacts, each installation site with its PPPoE and CPE, and the map of both. */
function CustomerDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['customers', 'one', id], queryFn: () => api<Customer>(`/api/admin/crm/customers/${encodeURIComponent(id)}`) });
  const c = q.data;
  return (
    <Drawer title={c?.name ?? 'Cliente'} onClose={onClose}>
      {q.error ? (
        <Notice tone="bad">{(q.error as Error).message}</Notice>
      ) : !c ? (
        <Skeleton lines={6} />
      ) : (
        <>
          <div className="ui-row">
            {STATUS[c.status] && <Badge tone={STATUS[c.status]![1]}>{STATUS[c.status]![0]}</Badge>}
            <span className="ui-muted ui-small">{[c.code, TYPES[c.type ?? ''] ?? c.type, c.group].filter(Boolean).join(' · ')}</span>
          </div>
          <div className="cp-contacts">
            {[c.phone, c.phone2].filter(Boolean).map((p) => (
              <a key={p} className="ui-btn ui-btn-secondary" href={`tel:${p!.replace(/\s+/g, '')}`}>
                Chiama {p}
              </a>
            ))}
            {c.email && (
              <a className="ui-btn ui-btn-ghost" href={`mailto:${c.email}`}>
                {c.email}
              </a>
            )}
          </div>
          {c.mainAddress && <p className="ui-small">Indirizzo principale: {c.mainAddress}</p>}
          {c.sites.map((x, i) => (
            <Card key={i} title={`Sede di installazione${c.sites.length > 1 ? ` ${i + 1}` : ''}`}>
              <dl className="ui-facts">
                <div>
                  <dt>Indirizzo</dt>
                  <dd>{[x.address, x.description && x.description !== 'Indirizzo principale' ? `(${x.description})` : ''].filter(Boolean).join(' ') || '—'}</dd>
                </div>
                <div>
                  <dt>Posizione</dt>
                  <dd>{x.position ? `${x.position.lat.toFixed(6)}, ${x.position.lon.toFixed(6)}${x.approximate ? ' · dall’indirizzo, approssimativa' : ''}` : 'non disponibile'}</dd>
                </div>
                <div>
                  <dt>PPPoE</dt>
                  <dd>{[x.account.username, ppp(x.account)[0], x.account.profile, x.account.clientIp].filter(Boolean).join(' · ')}</dd>
                </div>
                <div>
                  <dt>CPE in rete</dt>
                  <dd>{x.cpe ? [x.cpe.name, x.cpe.model, x.cpe.mac, x.cpe.apName, x.cpe.signal != null ? `${x.cpe.signal} dBm` : '', x.cpe.status].filter(Boolean).join(' · ') : 'non trovata (PPPoE da un router o un ONT del cliente?)'}</dd>
                </div>
                {x.distanceM != null && (
                  <div>
                    <dt>Distanza sede ↔ CPE</dt>
                    <dd>
                      {dist(x.distanceM)}
                      {x.suspicious ? ' · la posizione UISP è quella di un AP o di un sito: probabilmente non è della CPE' : ''}
                    </dd>
                  </div>
                )}
              </dl>
              {x.cpe?.id && (
                <div className="ui-row">
                  <a className="ui-btn ui-btn-secondary" href={`#/cpe?id=${encodeURIComponent(x.cpe.id)}`}>
                    Gestisci la CPE
                  </a>
                </div>
              )}
            </Card>
          ))}
          <MapView
            zoom={14}
            fitMaxZoom={17}
            deps={[c.customerId]}
            legendItems={[
              [SITE_COLOR, 'sede di installazione (CRM)'],
              [CPE_COLOR, 'CPE (UISP)'],
            ]}
            draw={(m, L) => {
              const layers: unknown[] = [];
              for (const x of c.sites) {
                if (x.position) layers.push(L.circleMarker([x.position.lat, x.position.lon], { radius: 9, color: SITE_COLOR, weight: 3, fillOpacity: 0.6 }).bindPopup(mapPopup('Sede di installazione', x.address, x.approximate && 'posizione dall’indirizzo, approssimativa')).addTo(m));
                const p = x.cpe?.position;
                if (p && x.cpe) layers.push(L.circleMarker([p.lat, p.lon], { radius: 7, color: CPE_COLOR, weight: 3, fillOpacity: 0.9 }).bindPopup(mapPopup(x.cpe.name, x.cpe.model, x.cpe.apName && `AP ${x.cpe.apName}`, x.suspicious && 'posizione di un AP o sito')).addTo(m));
                if (x.position && p) L.polyline([[x.position.lat, x.position.lon], [p.lat, p.lon]], { color: '#64748b', weight: 2, dashArray: '6 6' }).addTo(m);
              }
              return layers;
            }}
          />
        </>
      )}
    </Drawer>
  );
}

