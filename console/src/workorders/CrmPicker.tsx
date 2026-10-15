import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Badge, Field, Icon } from '../ui';

/**
 * Nuovo intervento → «Cliente da ISP Billing»: the customer found by name («COGNOME NOME» or company
 * name), code, phone, address or PPPoE user, then one of its sites (PPPoE account and where it is).
 * The choice fills the order; the PPPoE password is not in ISP Billing and is typed by hand.
 */

export interface CrmSite {
  pppoeUser: string;
  status: string;
  profile: string;
  address: string;
  lat: number | null;
  lon: number | null;
}
export interface CrmCustomer {
  customerId: string;
  name: string;
  code: string;
  phone: string;
  status: string;
  sites: CrmSite[];
}

const STATUS_TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral'> = { Attivo: 'good', Sospeso: 'warn' };

export function CrmPicker({ onPick }: { onPick: (c: CrmCustomer, s: CrmSite) => void }) {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<{ configured: boolean; items: CrmCustomer[] } | null>(null);
  const [open, setOpen] = useState<CrmCustomer | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (q.trim().length < 2) return void setFound(null);
    const t = setTimeout(() => {
      api<{ configured: boolean; items: CrmCustomer[] }>(`/api/admin/work-orders/crm?q=${encodeURIComponent(q.trim())}`)
        .then((r) => (setFound(r), setError(null), setOpen(null)))
        .catch((e) => setError((e as Error).message));
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const pick = (c: CrmCustomer, s: CrmSite) => {
    onPick(c, s);
    setQ('');
    setFound(null);
    setOpen(null);
  };

  return (
    <div className="crm-pick">
      <Field label="Cliente da ISP Billing" hint="Nome, cognome o ragione sociale, codice, telefono, indirizzo o utente PPPoE: compila cliente, indirizzo, posizione, contatto e PPPoE.">
        <label className="hl-search">
          <Icon name="search" />
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Cerca il cliente…" autoComplete="off" />
        </label>
      </Field>
      {error && <p className="ui-small op-bad">{error}</p>}
      {found && !found.configured && !found.items.length && <p className="ui-muted ui-small">ISP Billing non è collegato (Connettori): compila a mano.</p>}
      {found?.configured && !found.items.length && <p className="ui-muted ui-small">Nessun cliente trovato.</p>}
      {!!found?.items.length && (
        <ul className="crm-list">
          {found.items.map((c) => (
            <li key={c.customerId}>
              <button
                type="button"
                className="crm-row"
                onClick={() => (c.sites.length === 1 ? pick(c, c.sites[0]!) : setOpen(open?.customerId === c.customerId ? null : c))}
              >
                <strong>{c.name}</strong>
                <span className="ui-muted ui-small">{[c.code, c.phone, c.sites.length > 1 ? `${c.sites.length} sedi` : c.sites[0]?.address].filter(Boolean).join(' · ')}</span>
              </button>
              {open?.customerId === c.customerId && (
                <ul className="crm-sites">
                  {c.sites.map((s) => (
                    <li key={`${s.pppoeUser}|${s.address}`}>
                      <button type="button" className="crm-row" onClick={() => pick(c, s)}>
                        <span>{s.address || 'indirizzo non indicato'}</span>
                        <span className="ui-small ui-mono">{s.pppoeUser || 'senza PPPoE'}</span>
                        {s.status && <Badge tone={STATUS_TONE[s.status] ?? 'neutral'}>{s.status.toLowerCase()}</Badge>}
                        {s.lat == null && <span className="ui-muted ui-small">senza posizione</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
