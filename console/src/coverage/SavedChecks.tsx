import { useEffect, useRef, useState } from 'react';
import { api, download } from '../lib/api';
import { toast } from '../lib/toast';
import { AsyncButton, Badge, Button, Card, Drawer, Field, Icon, Notice, Segmented, Skeleton } from '../ui';

/**
 * Saved coverage and feasibility checks. «Salva» names the check: the name written, or a customer
 * of ISP Billing (admins: those with a site near the point first, then those matching what is
 * written). The list shows what each check said when it was saved; «Apri» checks the same point
 * again with the same options, «Rinomina» changes the name or the customer, feasibility has its PDF.
 */

export type CheckKind = 'coverage' | 'feasibility';
export interface CheckPoint {
  lat: number;
  lon: number;
  label: string;
}
export interface CheckParams {
  cpe?: string;
  height?: number;
  km?: number;
  limit?: number;
}
interface CrmCustomer {
  customerId: string;
  name: string;
  code: string;
  address: string;
  distanceM: number | null;
}
type Summary =
  | { kind: 'coverage'; verdict: 'buono' | 'possibile' | 'improbabile' | 'none'; title: string; best: { name: string; rating: string; distanceM: number | null; signalDbm: number | null; eveningMbps: number | null } | null; aps: number; others?: string | null }
  | { kind: 'feasibility'; verdict: 'yes' | 'maybe' | 'no'; title: string; eveningMbps: number | null; sticker: string | null; others: string | null };
export interface SavedCheck {
  id: number;
  kind: CheckKind;
  name: string;
  customer: { id: string; name: string; code: string } | null;
  point: CheckPoint;
  params: CheckParams;
  summary: Summary | null;
  by: string;
  mine: boolean;
  createdAt: string;
  updatedAt: string;
}

const TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral'> = { buono: 'good', possibile: 'warn', improbabile: 'bad', none: 'neutral', yes: 'good', maybe: 'warn', no: 'bad' };
const when = (iso: string) => new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
const km = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1).replace('.', ',')} km` : `${m} m`);

/** What the check said when it was saved, in a line. */
export function summaryText(s: Summary | null): string {
  if (!s) return '';
  if (s.kind === 'coverage') {
    const others = s.others ? `altri operatori: ${s.others}` : null;
    if (!s.best) return [s.title, others].filter(Boolean).join(' · ');
    return [`${s.title}: ${s.best.name}`, s.best.distanceM != null ? km(s.best.distanceM) : null, s.best.signalDbm != null ? `${s.best.signalDbm} dBm stimati` : null, s.best.eveningMbps != null ? `la sera ~${s.best.eveningMbps} Mbit/s` : null, others].filter(Boolean).join(' · ');
  }
  return [s.title, s.eveningMbps != null ? `la sera ~${s.eveningMbps} Mbit/s` : null, s.sticker ? `bollino ${s.sticker}` : null, s.others ? `altri operatori: ${s.others}` : null].filter(Boolean).join(' · ');
}

/** «Salva» (a new check of [point]) or «Rinomina» ([existing]): the name, or a customer of ISP Billing. */
export function SaveCheckDrawer({
  kind,
  point,
  params,
  admin,
  existing,
  onClose,
  onSaved,
}: {
  kind: CheckKind;
  point: CheckPoint;
  params?: CheckParams;
  admin: boolean;
  existing?: SavedCheck;
  onClose: () => void;
  onSaved: (c: SavedCheck) => void;
}) {
  const [name, setName] = useState(existing?.name ?? '');
  const [customer, setCustomer] = useState<{ customerId: string; name: string; code: string } | null>(existing?.customer ? { customerId: existing.customer.id, name: existing.customer.name, code: existing.customer.code } : null);
  const [near, setNear] = useState<CrmCustomer[] | null>(null);
  const [found, setFound] = useState<CrmCustomer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  // admins: the customers with a site near the point
  useEffect(() => {
    if (!admin) return;
    api<{ near: CrmCustomer[] }>(`/api/admin/saved-checks/customers?lat=${point.lat}&lon=${point.lon}`)
      .then((r) => setNear(r.near))
      .catch(() => setNear([]));
  }, [admin, point.lat, point.lon]);
  // and those matching what is written (while no customer is chosen)
  useEffect(() => {
    if (!admin || customer || name.trim().length < 2) return void setFound([]);
    const n = ++seq.current;
    const t = setTimeout(() => {
      api<{ found: CrmCustomer[]; near: CrmCustomer[] }>(`/api/admin/saved-checks/customers?q=${encodeURIComponent(name.trim())}`)
        .then((r) => n === seq.current && setFound(r.found.concat(r.near)))
        .catch(() => n === seq.current && setFound([]));
    }, 300);
    return () => clearTimeout(t);
  }, [admin, customer, name]);

  const choose = (c: CrmCustomer) => {
    setCustomer({ customerId: c.customerId, name: c.name, code: c.code });
    setName(c.name);
    setFound([]);
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      let saved: SavedCheck;
      if (existing) {
        const changed = (existing.customer?.id ?? null) !== (customer?.customerId ?? null);
        saved = await api<SavedCheck>(`/api/saved-checks/${existing.id}`, { method: 'PATCH', body: { name, ...(changed ? { customerId: customer?.customerId ?? null } : {}) } });
        toast('Nome aggiornato');
      } else {
        saved = await api<SavedCheck>('/api/saved-checks', { method: 'POST', body: { kind, name, customerId: customer?.customerId, lat: point.lat, lon: point.lon, label: point.label, params: kind === 'coverage' ? (params ?? {}) : {} } });
        toast(`Verifica salvata: ${saved.name}`);
      }
      onSaved(saved);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const list = (title: string, rows: CrmCustomer[]) =>
    rows.length > 0 && (
      <div className="sv-customers">
        <p className="ui-small ui-muted">{title}</p>
        <ul className="hl-list">
          {rows.map((c) => (
            <li key={c.customerId}>
              <button type="button" className="sv-customer" onClick={() => choose(c)}>
                <strong>{c.name}</strong>
                <span className="ui-small ui-muted">{[c.code, c.address, c.distanceM != null ? `a ${km(c.distanceM)} dal punto` : null].filter(Boolean).join(' · ')}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    );

  return (
    <Drawer
      title={existing ? 'Rinomina la verifica' : kind === 'coverage' ? 'Salva la verifica di copertura' : 'Salva la verifica di fattibilità'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Annulla</Button>
          <Button variant="primary" busy={busy} onClick={() => void save()}>
            {existing ? 'Salva il nome' : 'Salva'}
          </Button>
        </>
      }
    >
      <form
        className="sv-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="ui-small ui-muted">
          {point.label || 'Punto'} · {point.lat.toFixed(5)}, {point.lon.toFixed(5)}
        </p>
        <Field
          label="Nome"
          hint={admin ? 'Scrivi un nome, oppure scegli un cliente di ISP Billing: il nome diventa il suo.' : 'Per esempio il nome del cliente. Vuoto: resta l’indirizzo.'}
        >
          <input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder={point.label || 'Nome della verifica'} autoComplete="off" />
        </Field>
        {customer && (
          <div className="sv-chosen">
            <Badge tone="brand">Cliente ISP Billing</Badge>
            <span>
              <strong>{customer.name}</strong>
              {customer.code ? <span className="ui-small ui-muted"> · {customer.code}</span> : null}
            </span>
            <button type="button" className="cx-icon-btn" aria-label="Togli il cliente" onClick={() => setCustomer(null)}>
              <Icon name="close" />
            </button>
          </div>
        )}
        {admin && !customer && (
          <>
            {list('Clienti con un indirizzo vicino al punto', near ?? [])}
            {list('Clienti che corrispondono al nome', found.filter((c) => !(near ?? []).some((n) => n.customerId === c.customerId)))}
            {near && !near.length && name.trim().length < 2 && <p className="ui-small ui-muted">Nessun cliente di ISP Billing entro 300 m: scrivi il nome per cercarlo, o lascia il nome scritto.</p>}
          </>
        )}
        {!existing && <p className="ui-small ui-muted">Il server rifà la verifica e la salva con il risultato di adesso: ci vuole qualche secondo.</p>}
        {error && <Notice tone="bad">{error}</Notice>}
      </form>
    </Drawer>
  );
}

/** The saved checks of one kind: the user's own, or everyone's for admins. */
export function SavedChecksCard({ kind, admin, version, onOpen }: { kind: CheckKind; admin: boolean; version: number; onOpen: (c: SavedCheck) => void }) {
  const [scope, setScope] = useState<'all' | 'mine'>('all');
  const [q, setQ] = useState('');
  const [data, setData] = useState<{ total: number; items: SavedCheck[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<SavedCheck | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    const t = setTimeout(
      () => {
        const p = new URLSearchParams({ kind, limit: '50' });
        if (admin && scope === 'mine') p.set('mine', '1');
        if (q.trim()) p.set('q', q.trim());
        api<{ total: number; items: SavedCheck[] }>(`/api/saved-checks?${p}`)
          .then((r) => live && (setData(r), setError(null)))
          .catch((e) => live && setError((e as Error).message));
      },
      q ? 300 : 0,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [kind, admin, scope, q, version, reload]);

  const remove = async (c: SavedCheck) => {
    if (!confirm(`Eliminare la verifica salvata «${c.name}»?`)) return;
    await api(`/api/saved-checks/${c.id}`, { method: 'DELETE' });
    toast('Verifica eliminata');
    setReload((n) => n + 1);
  };

  return (
    <Card
      title="Verifiche salvate"
      padded={false}
      actions={admin ? <Segmented label="Di chi" value={scope} onChange={setScope} options={[{ value: 'all', label: 'Tutte' }, { value: 'mine', label: 'Mie' }]} /> : undefined}
    >
      <div className="sv-search">
        <label className="hl-search">
          <Icon name="search" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cerca per nome, indirizzo o codice cliente" aria-label="Cerca tra le verifiche salvate" autoComplete="off" />
        </label>
      </div>
      {error && (
        <div className="sv-pad">
          <Notice tone="bad">{error}</Notice>
        </div>
      )}
      {!data && !error && (
        <div className="sv-pad">
          <Skeleton lines={3} />
        </div>
      )}
      {data && !data.items.length && <p className="ui-muted ui-small sv-pad">{q ? 'Nessuna verifica salvata con questo nome.' : `Nessuna verifica salvata. Dopo una verifica, «Salva» la tiene qui con il nome del cliente.`}</p>}
      {data && data.items.length > 0 && (
        <ul className="hl-list">
          {data.items.map((c) => (
            <li key={c.id} className="hl-row">
              <div className="hl-main">
                <div className="hl-name">
                  <strong>{c.name}</strong>
                  {c.customer && <Badge tone="brand">{c.customer.code ? `cliente ${c.customer.code}` : 'cliente ISP Billing'}</Badge>}
                  {c.summary && <Badge tone={TONE[c.summary.verdict] ?? 'neutral'}>{c.summary.title}</Badge>}
                </div>
                <div className="hl-sub">{summaryText(c.summary)}</div>
                <div className="hl-sub">
                  {[c.point.label || `${c.point.lat.toFixed(5)}, ${c.point.lon.toFixed(5)}`, when(c.createdAt), admin && !c.mine ? `di ${c.by}` : null].filter(Boolean).join(' · ')}
                </div>
              </div>
              <div className="hl-actions sv-actions">
                <Button variant="primary" onClick={() => onOpen(c)}>
                  Apri
                </Button>
                <Button onClick={() => setEditing(c)}>Rinomina</Button>
                {c.kind === 'feasibility' && (
                  <AsyncButton onClick={() => download(`/api/saved-checks/${c.id}/pdf`, 'fattibilita.pdf')} onError={(e) => toast((e as Error).message, 'bad')}>
                    PDF
                  </AsyncButton>
                )}
                <AsyncButton variant="ghost" icon="delete" aria-label={`Elimina ${c.name}`} onClick={() => remove(c)} onError={(e) => toast((e as Error).message, 'bad')}>
                  {''}
                </AsyncButton>
              </div>
            </li>
          ))}
        </ul>
      )}
      {data && data.total > data.items.length && <p className="ui-muted ui-small sv-pad">Le ultime {data.items.length} di {data.total}: cerca per trovare le altre.</p>}
      {editing && <SaveCheckDrawer kind={kind} point={editing.point} admin={admin} existing={editing} onClose={() => setEditing(null)} onSaved={() => setReload((n) => n + 1)} />}
    </Card>
  );
}

/** «Salva» next to a check: opens the drawer, tells the list to read itself again. */
export function SaveCheckButton({ kind, point, params, admin, onSaved }: { kind: CheckKind; point: CheckPoint; params?: CheckParams; admin: boolean; onSaved: (c: SavedCheck) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button icon="bookmark" onClick={() => setOpen(true)}>
        Salva
      </Button>
      {open && <SaveCheckDrawer kind={kind} point={point} params={params} admin={admin} onClose={() => setOpen(false)} onSaved={onSaved} />}
    </>
  );
}

/** Above the answer of a check opened from the list: which one, and what it said then. */
export function OpenedCheck({ c, onClose }: { c: SavedCheck; onClose: () => void }) {
  return (
    <Notice tone="info" title={`Verifica salvata: ${c.name}`}>
      <span className="ui-small">
        Salvata il {when(c.createdAt)}
        {c.mine ? '' : ` da ${c.by}`}
        {c.summary ? `, allora: ${summaryText(c.summary)}` : ''}. Sotto, la stessa verifica rifatta adesso.{' '}
      </span>
      <button type="button" className="ui-link ui-small" onClick={onClose}>
        Chiudi
      </button>
    </Notice>
  );
}
