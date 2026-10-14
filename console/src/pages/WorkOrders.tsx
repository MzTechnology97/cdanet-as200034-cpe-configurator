import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { toast } from '../lib/toast';
import { api } from '../lib/api';
import type { PageContext } from '../shell/routes';
import { AsyncButton, Badge, Button, Card, Drawer, EmptyState, Field, Notice, PageHeader, Segmented, Skeleton, Stat } from '../ui';

/**
 * Interventi: the office plans the day of each installer with the customer's data and the PPPoE
 * credentials (the password is sealed on the server, never shown); installers find them in the
 * app (Oggi) and here, read-only.
 */

type Tone = 'good' | 'warn' | 'bad' | 'neutral' | 'info';
const KINDS: Record<string, string> = { new: 'Nuova installazione', repoint: 'Ripuntamento / cambio AP', repair: 'Guasto', survey: 'Sopralluogo' };
const STATUS: Record<string, [string, Tone]> = { open: ['da fare', 'neutral'], started: ['in corso', 'info'], done: ['fatto', 'good'], postponed: ['rimandato', 'warn'], cancelled: ['annullato', 'bad'] };

interface Order {
  id: number;
  day: string;
  slot: string;
  kind: string;
  customer: string;
  address: string;
  lat: number | null;
  lon: number | null;
  contact: string;
  pppoeUser: string;
  hasPassword: boolean;
  model: string | null;
  notes: string;
  status: string;
  statusNote?: string | null;
  overdue: boolean;
  assignedTo: number | null;
  assignee?: string | null;
  jobId?: string | null;
}

const romeDay = (offset = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + offset * 86_400_000));
const dayLabel = (d: string) => {
  if (d === romeDay()) return 'Oggi';
  if (d === romeDay(1)) return 'Domani';
  if (d === romeDay(-1)) return 'Ieri';
  return new Date(`${d}T12:00:00`).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
};

function StatusBadges({ o }: { o: Order }) {
  return (
    <span className="ui-row">
      <Badge tone={STATUS[o.status]?.[1] ?? 'neutral'}>{STATUS[o.status]?.[0] ?? o.status}</Badge>
      {o.overdue && <Badge tone="bad">in ritardo</Badge>}
    </span>
  );
}

export function WorkOrders({ user }: PageContext) {
  return user.role === 'admin' ? <Office /> : <Mine />;
}

/** Installers: their orders of a day plus the ones left open. */
function Mine() {
  const [day, setDay] = useState(romeDay());
  const q = useQuery({ queryKey: ['work-orders', 'mine', day], queryFn: () => api<{ items: Order[] }>(`/api/work-orders?day=${day}`) });
  return (
    <div className="ui-page">
      <PageHeader icon="pending_actions" title="I miei interventi" subtitle="Assegnati dall’ufficio: quelli del giorno e quelli rimasti aperti. Si avviano dall’app (Oggi → Inizia): cliente, posizione e PPPoE sono già compilati." />
      <div className="wo-toolbar">
        <Segmented
          label="Giorno"
          value={day === romeDay() ? 'today' : day === romeDay(1) ? 'tomorrow' : 'other'}
          onChange={(v) => v !== 'other' && setDay(v === 'today' ? romeDay() : romeDay(1))}
          options={[{ value: 'today', label: 'Oggi' }, { value: 'tomorrow', label: 'Domani' }, { value: 'other', label: 'Altro giorno' }]}
        />
        <input type="date" className="wo-date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} aria-label="Giorno" />
      </div>
      {q.error ? <Notice tone="bad">{(q.error as Error).message}</Notice> : !q.data ? <Skeleton lines={4} /> : <OrderList items={q.data.items} />}
    </div>
  );
}

/** Office: the agenda of every installer, new orders and changes in a side panel. */
function Office() {
  const qc = useQueryClient();
  const [range, setRange] = useState<'today' | 'tomorrow' | 'week' | 'custom'>('today');
  const [from, setFrom] = useState(romeDay());
  const [to, setTo] = useState(romeDay());
  const [who, setWho] = useState('');
  const [editing, setEditing] = useState<Order | 'new' | null>(null);

  const span = range === 'today' ? [romeDay(), romeDay()] : range === 'tomorrow' ? [romeDay(1), romeDay(1)] : range === 'week' ? [romeDay(), romeDay(6)] : [from, to < from ? from : to];
  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: () => api<Array<{ id: number; username: string; role: string; active?: boolean }>>('/api/admin/users') });
  const models = useQuery({ queryKey: ['admin', 'profiles'], queryFn: () => api<Array<{ model: string }>>('/api/admin/profiles') });
  const installers = (users.data ?? []).filter((u) => u.active !== false && u.role !== 'admin');
  const list = useQuery({
    queryKey: ['work-orders', 'office', span[0], span[1], who],
    queryFn: () => api<{ items: Order[] }>(`/api/admin/work-orders?${new URLSearchParams({ from: span[0]!, to: span[1]!, ...(who ? { user: who } : {}) })}`),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['work-orders'] });
  const items = list.data?.items ?? [];
  const n = (pred: (o: Order) => boolean) => items.filter(pred).length;

  return (
    <div className="ui-page">
      <PageHeader
        icon="pending_actions"
        title="Interventi"
        subtitle="L’agenda degli installatori: ognuno trova i suoi in Oggi nell’app, con cliente, posizione e PPPoE già compilati."
        actions={
          <Button variant="primary" icon="add_circle" onClick={() => setEditing('new')}>
            Nuovo intervento
          </Button>
        }
      />
      <div className="wo-toolbar">
        <Segmented
          label="Periodo"
          value={range}
          onChange={setRange}
          options={[
            { value: 'today', label: 'Oggi' },
            { value: 'tomorrow', label: 'Domani' },
            { value: 'week', label: '7 giorni' },
            { value: 'custom', label: 'Date' },
          ]}
        />
        {range === 'custom' && (
          <>
            <input type="date" className="wo-date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} aria-label="Dal" />
            <input type="date" className="wo-date" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} aria-label="Al" />
          </>
        )}
        <select className="wo-date" value={who} onChange={(e) => setWho(e.target.value)} aria-label="Installatore">
          <option value="">Tutti gli installatori</option>
          {installers.map((u) => (
            <option key={u.id} value={u.id}>
              {u.username}
            </option>
          ))}
        </select>
      </div>
      {list.data && (
        <section className="ui-stats" aria-label="Riepilogo">
          <Stat label="da fare" value={n((o) => o.status === 'open')} />
          <Stat label="in corso" value={n((o) => o.status === 'started')} tone="info" />
          <Stat label="fatti" value={n((o) => o.status === 'done')} tone="good" />
          <Stat label="in ritardo" value={n((o) => o.overdue)} tone={n((o) => o.overdue) ? 'bad' : 'good'} />
          <Stat label="da assegnare" value={n((o) => !o.assignedTo && o.status !== 'cancelled')} tone={n((o) => !o.assignedTo && o.status !== 'cancelled') ? 'warn' : 'good'} />
        </section>
      )}
      {list.error ? (
        <Notice tone="bad">{(list.error as Error).message}</Notice>
      ) : !list.data ? (
        <Skeleton lines={5} />
      ) : (
        <OrderList
          items={items}
          office
          onEdit={(o) => setEditing(o)}
          onDelete={async (o) => {
            if (!confirm(`${o.jobId ? 'Annullare' : 'Eliminare'} l’intervento di ${o.customer}?`)) return;
            await api(`/api/admin/work-orders/${o.id}`, { method: 'DELETE' });
            await refresh();
          }}
        />
      )}
      {editing && (
        <OrderForm
          order={editing === 'new' ? null : editing}
          day={span[0]!}
          installers={installers}
          models={(models.data ?? []).map((m) => m.model)}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
          }}
        />
      )}
    </div>
  );
}

/** Orders grouped by day (overdue ones under their own day), each a card. */
function OrderList({ items, office, onEdit, onDelete }: { items: Order[]; office?: boolean; onEdit?: (o: Order) => void; onDelete?: (o: Order) => Promise<void> }) {
  const groups = useMemo(() => {
    const g = new Map<string, Order[]>();
    for (const o of items) g.set(o.day, [...(g.get(o.day) ?? []), o]);
    return [...g.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [items]);
  if (!items.length) return <EmptyState icon="check_circle" title="Nessun intervento">Nel periodo scelto non ci sono interventi{office ? ': crealo con «Nuovo intervento»' : ''}.</EmptyState>;
  return (
    <>
      {groups.map(([day, os]) => (
        <section key={day} className="wo-day">
          <h3 className="nt-day-title">
            {dayLabel(day)} · {os.length} {os.length === 1 ? 'intervento' : 'interventi'}
          </h3>
          <div className="wo-cards">
            {os.map((o) => (
              <article key={o.id} className={`wo-card${o.overdue ? ' overdue' : ''}${o.status === 'cancelled' ? ' cancelled' : ''}`}>
                <header className="wo-card-head">
                  <span className="wo-slot">{o.slot || 'in giornata'}</span>
                  <StatusBadges o={o} />
                </header>
                <strong className="wo-customer">{o.customer}</strong>
                <span className="ui-muted ui-small">{o.address || 'indirizzo non indicato'}</span>
                <div className="ui-row wo-meta">
                  <Badge tone="info">{KINDS[o.kind] ?? o.kind}</Badge>
                  {office && (o.assignee ? <Badge>{o.assignee}</Badge> : <Badge tone="warn">da assegnare</Badge>)}
                </div>
                {o.contact && <span className="ui-small">Contatto: {o.contact}</span>}
                {office && o.pppoeUser && (
                  <span className="ui-small ui-mono">
                    PPPoE {o.pppoeUser}
                    {!o.hasPassword && <span className="ui-muted"> · senza password</span>}
                  </span>
                )}
                {o.notes && <p className="wo-notes">{o.notes}</p>}
                {o.statusNote && <p className="wo-notes">{o.statusNote}</p>}
                {office && o.status !== 'cancelled' && (
                  <footer className="ui-row">
                    {o.status !== 'done' && (
                      <Button variant="ghost" onClick={() => onEdit?.(o)}>
                        Modifica
                      </Button>
                    )}
                    <AsyncButton variant="ghost" onClick={() => onDelete!(o)} onError={(e) => toast((e as Error).message, 'bad')}>
                      {o.jobId || o.status === 'done' ? 'Annulla' : 'Elimina'}
                    </AsyncButton>
                  </footer>
                )}
              </article>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

/** New order or changes: the password goes to the server sealed and never comes back. */
function OrderForm({ order: o, day, installers, models, onClose, onSaved }: { order: Order | null; day: string; installers: Array<{ id: number; username: string }>; models: string[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [f, setF] = useState({
    assignedTo: o?.assignedTo ? String(o.assignedTo) : '',
    day: o?.day ?? day,
    slot: o?.slot ?? '',
    kind: o?.kind ?? 'new',
    customer: o?.customer ?? '',
    address: o?.address ?? '',
    lat: o?.lat != null ? String(o.lat) : '',
    lon: o?.lon != null ? String(o.lon) : '',
    contact: o?.contact ?? '',
    pppoeUser: o?.pppoeUser ?? '',
    pppoePassword: '',
    model: o?.model ?? '',
    notes: o?.notes ?? '',
  });
  const [where, setWhere] = useState('');
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const num = (x: string) => (x.trim() ? Number(x.replace(',', '.')) : null);

  const save = async () => {
    setError(null);
    const body = {
      assignedTo: f.assignedTo ? Number(f.assignedTo) : null,
      day: f.day,
      slot: f.slot.trim(),
      kind: f.kind,
      customer: f.customer.trim(),
      address: f.address.trim(),
      lat: num(f.lat),
      lon: num(f.lon),
      contact: f.contact.trim(),
      pppoeUser: f.pppoeUser.trim(),
      model: f.model,
      notes: f.notes.trim(),
      ...(f.pppoePassword ? { pppoePassword: f.pppoePassword } : {}),
    };
    if (o) await api(`/api/admin/work-orders/${o.id}`, { method: 'PUT', body });
    else await api('/api/admin/work-orders', { method: 'POST', body });
    toast(o ? 'Intervento aggiornato' : 'Intervento creato: l’installatore lo trova in Oggi');
    await onSaved();
  };

  return (
    <Drawer
      title={o ? `Modifica: ${o.customer}` : 'Nuovo intervento'}
      onClose={onClose}
      footer={
        <>
          <AsyncButton variant="primary" onClick={save} onError={(e) => setError((e as Error).message)}>
            {o ? 'Salva modifiche' : 'Crea intervento'}
          </AsyncButton>
          <Button onClick={onClose}>Chiudi</Button>
        </>
      }
    >
      {error && <Notice tone="bad">{error}</Notice>}
      <div className="ui-grid-form">
        <Field label="Installatore">
          <select value={f.assignedTo} onChange={set('assignedTo')}>
            <option value="">— da assegnare —</option>
            {installers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.username}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Tipo">
          <select value={f.kind} onChange={set('kind')}>
            {Object.entries(KINDS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Giorno">
          <input type="date" value={f.day} onChange={set('day')} />
        </Field>
        <Field label="Fascia oraria" hint="es. 09:00-11:00 o mattina">
          <input value={f.slot} maxLength={40} onChange={set('slot')} />
        </Field>
      </div>
      <div className="ui-grid-form">
        <Field label="Cliente">
          <input value={f.customer} onChange={set('customer')} placeholder="Nome e cognome o ragione sociale" />
        </Field>
        <Field label="Contatto">
          <input value={f.contact} onChange={set('contact')} placeholder="Telefono o referente sul posto" />
        </Field>
      </div>
      <Field label="Indirizzo" hint={where || 'Via, civico, CAP, comune: «Cerca» compila le coordinate'}>
        <input value={f.address} onChange={set('address')} />
      </Field>
      <div className="ui-grid-form">
        <Field label="Latitudine">
          <input value={f.lat} inputMode="decimal" onChange={set('lat')} placeholder="37.5670" />
        </Field>
        <Field label="Longitudine">
          <input value={f.lon} inputMode="decimal" onChange={set('lon')} placeholder="14.2790" />
        </Field>
      </div>
      <div className="ui-row">
        <AsyncButton
          icon="my_location"
          onClick={async () => {
            const g = await api<Array<{ lat: number; lon: number; label: string }>>(`/api/geocode?q=${encodeURIComponent(f.address.trim())}`);
            if (!g.length) throw new Error('Indirizzo non trovato');
            setF({ ...f, lat: g[0]!.lat.toFixed(6), lon: g[0]!.lon.toFixed(6) });
            setWhere(g[0]!.label);
          }}
          onError={(e) => setError((e as Error).message)}
        >
          Cerca indirizzo
        </AsyncButton>
      </div>
      <div className="ui-grid-form">
        <Field label="Utente PPPoE">
          <input value={f.pppoeUser} onChange={set('pppoeUser')} placeholder="cliente@cda-net.it" />
        </Field>
        <Field label="Password PPPoE">
          <input type="password" autoComplete="new-password" value={f.pppoePassword} onChange={set('pppoePassword')} placeholder={o?.hasPassword ? 'impostata · scrivi per cambiarla' : 'Password PPPoE del cliente'} />
        </Field>
        <Field label="Modello CPE">
          <select value={f.model} onChange={set('model')}>
            <option value="">da scegliere sul posto</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <p className="ui-muted ui-small">La password viene cifrata sul server e non viene mai mostrata: l’app la inserisce da sola nella configurazione della CPE.</p>
      <Field label="Note per l’installatore">
        <textarea rows={3} value={f.notes} onChange={set('notes')} placeholder="Accesso al tetto, cancello, orari…" />
      </Field>
    </Drawer>
  );
}
