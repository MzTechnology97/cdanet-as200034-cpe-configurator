import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CrmPicker } from '../workorders/CrmPicker';
import { useMemo, useState } from 'react';
import { toast } from '../lib/toast';
import { api } from '../lib/api';
import type { PageContext } from '../shell/routes';
import { AsyncButton, Badge, Button, Drawer, EmptyState, Field, Notice, PageHeader, Segmented, Skeleton } from '../ui';
import { Calendar, type NewAt } from '../workorders/Calendar';
import { OfficeList, StatusBadges } from '../workorders/Office';
import { dayLabel, KIND_TONE, KINDS, type Order, romeDay } from '../workorders/shared';
import { canManage, seesAll } from '../lib/roles';

/**
 * Interventi: the office plans the day of each installer with the customer's data and the PPPoE
 * credentials (the password is sealed on the server, never shown); installers find them in the
 * app (Oggi) and here, read-only. Two views: the list and the calendar (workorders/Calendar.tsx).
 */

/** List or calendar, remembered on this browser. */
function useLayout(): ['list' | 'calendar', (v: 'list' | 'calendar') => void] {
  const [v, setV] = useState<'list' | 'calendar'>(() => {
    try {
      return localStorage.getItem('cda.workOrdersLayout') === 'calendar' ? 'calendar' : 'list';
    } catch {
      return 'list';
    }
  });
  return [
    v,
    (n) => {
      setV(n);
      try {
        localStorage.setItem('cda.workOrdersLayout', n);
      } catch {
        /* not remembered */
      }
    },
  ];
}
const LAYOUTS = [
  { value: 'list' as const, label: 'Elenco' },
  { value: 'calendar' as const, label: 'Calendario' },
];

export function WorkOrders({ user }: PageContext) {
  // the specialist sees the office's agenda; planning the work orders stays with the admins
  return seesAll(user) ? <Office /> : <Mine />;
}

/** Installers: their orders of a day plus the ones left open. */
function Mine() {
  const [day, setDay] = useState(romeDay());
  const [layout, setLayout] = useLayout();
  const [shown, setShown] = useState<Order | null>(null);
  const q = useQuery({ queryKey: ['work-orders', 'mine', day], queryFn: () => api<{ items: Order[] }>(`/api/work-orders?day=${day}`), enabled: layout === 'list' });
  const header = <PageHeader icon="pending_actions" title="I miei interventi" subtitle="Assegnati dall’ufficio: quelli del giorno e quelli rimasti aperti. Si avviano dall’app (Oggi → Inizia): cliente, posizione e PPPoE sono già compilati." actions={<Segmented label="Vista" value={layout} onChange={setLayout} options={LAYOUTS} />} />;
  if (layout === 'calendar') {
    return (
      <div className="ui-page">
        {header}
        <Calendar admin={false} onOpen={(o) => setShown(o as unknown as Order)} />
        {shown && (
          <Drawer title={shown.customer} onClose={() => setShown(null)}>
            <OrderList items={[shown]} />
          </Drawer>
        )}
      </div>
    );
  }
  return (
    <div className="ui-page">
      {header}
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
  const [editing, setEditing] = useState<Order | 'new' | NewAt | null>(null);
  const [layout, setLayout] = useLayout();

  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: () => api<Array<{ id: number; username: string; role: string; active?: boolean }>>('/api/admin/users'), enabled: canManage() });
  const models = useQuery({ queryKey: ['admin', 'profiles'], queryFn: () => api<Array<{ model: string }>>('/api/admin/profiles') });
  const installers = (users.data ?? []).filter((u) => u.active !== false && u.role === 'installer');
  const refresh = () => qc.invalidateQueries({ queryKey: ['work-orders'] });

  return (
    <div className="ui-page">
      <PageHeader
        icon="pending_actions"
        title="Interventi"
        subtitle="L’agenda degli installatori e lo storico: filtra per giorno, mese, anno, installatore e tipo; ogni intervento ha la sua cronologia."
        actions={
          <>
            <Segmented label="Vista" value={layout} onChange={setLayout} options={LAYOUTS} />
            {canManage() && (
              <Button variant="primary" icon="add_circle" onClick={() => setEditing('new')}>
                Nuovo intervento
              </Button>
            )}
          </>
        }
      />
      {layout === 'calendar' ? (
        <Calendar admin onNew={canManage() ? (at) => setEditing(at) : undefined} onOpen={(o) => (canManage() ? setEditing(o as unknown as Order) : undefined)} />
      ) : (
        <OfficeList
          installers={installers}
          onEdit={(o) => setEditing(o)}
          onDelete={async (o) => {
            if (!confirm(`${o.jobId || o.status === 'done' ? 'Annullare' : 'Eliminare'} l’intervento di ${o.customer}?`)) return;
            await api(`/api/admin/work-orders/${o.id}`, { method: 'DELETE' });
            toast(o.jobId || o.status === 'done' ? 'Intervento annullato' : 'Intervento eliminato');
            await refresh();
          }}
        />
      )}
      {editing && (
        <OrderForm
          order={editing === 'new' || !('id' in editing) ? null : editing}
          day={editing !== 'new' && !('id' in editing) ? editing.day : romeDay()}
          preset={editing !== 'new' && !('id' in editing) ? editing : undefined}
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
function OrderList({ items }: { items: Order[] }) {
  const groups = useMemo(() => {
    const g = new Map<string, Order[]>();
    for (const o of items) g.set(o.day, [...(g.get(o.day) ?? []), o]);
    return [...g.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [items]);
  if (!items.length) return <EmptyState icon="check_circle" title="Nessun intervento">Nel periodo scelto non ci sono interventi.</EmptyState>;
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
                  <Badge tone={KIND_TONE[o.kind] ?? 'neutral'}>{KINDS[o.kind] ?? o.kind}</Badge>
                </div>
                {o.contact && <span className="ui-small">Contatto: {o.contact}</span>}
                {o.notes && <p className="wo-notes">{o.notes}</p>}
                {o.statusNote && <p className="wo-notes">{o.statusNote}</p>}
              </article>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

/** New order or changes: the password goes to the server sealed and never comes back. */
function OrderForm({ order: o, day, preset, installers, models, onClose, onSaved }: { order: Order | null; day: string; preset?: NewAt; installers: Array<{ id: number; username: string }>; models: string[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [f, setF] = useState({
    assignedTo: o?.assignedTo ? String(o.assignedTo) : preset?.assignedTo ? String(preset.assignedTo) : '',
    day: o?.day ?? day,
    slot: o?.slot ?? preset?.slot ?? '',
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
      <CrmPicker
        onPick={(c, site) => {
          setF((x) => ({
            ...x,
            customer: c.name,
            address: site.address || x.address,
            lat: site.lat != null ? String(site.lat) : '',
            lon: site.lon != null ? String(site.lon) : '',
            contact: c.phone || x.contact,
            pppoeUser: site.pppoeUser || x.pppoeUser,
          }));
          setWhere(site.lat != null ? 'Posizione della sede in ISP Billing' : 'Sede senza posizione in ISP Billing: «Cerca indirizzo» la ricava dall’indirizzo');
          toast(site.pppoeUser ? 'Dati del cliente compilati: la password PPPoE va scritta a mano' : 'Dati del cliente compilati');
        }}
      />
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
