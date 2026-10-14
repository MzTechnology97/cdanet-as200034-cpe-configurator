import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import type { PageContext } from '../shell/routes';
import { AsyncButton, Badge, Card, EmptyState, Field, Notice, PageHeader, Skeleton, Stat, Table } from '../ui';

/**
 * Magazzino. The NOC: the CPEs of every warehouse of ISP Billing by model, who is short of CPEs,
 * the installed CPEs still to unload in ISP Billing (by hand: it has no API to unload) and the log
 * of the movements of a CPE. Installers and partners: the CPEs of their own warehouse (never the
 * name of the data source).
 */

const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const day = (iso?: string | null) => (iso ? new Date(iso).toLocaleDateString('it-IT', { dateStyle: 'short' }) : '—');
const fail = (e: unknown) => toast((e as Error).message, 'bad');
/** Why the last reading of the stock failed (the CRM connector of ISPBilling). */
const SYNC_ERRORS: Record<string, string> = {
  crm_not_configured: 'connettore CRM (ISPBilling) non configurato: impostalo in Connettori',
  crm_unreachable: 'ISPBilling non raggiungibile dal server',
  crm_auth_failed: 'API ID o API key di ISPBilling non validi',
  crm_forbidden: 'la chiave di ISPBilling non ha il permesso del magazzino',
  crm_error: 'ISPBilling ha risposto con un errore',
};
const syncError = (code: string) => SYNC_ERRORS[code] ?? code;

export function Warehouse({ user }: PageContext) {
  return user.role === 'admin' ? <Office /> : <Mine />;
}

interface Overview {
  at: string | null;
  items: number;
  error: string | null;
  byModel: Array<{ siteId: number; site: string; model: string; n: number }>;
  lowStock: Array<{ userId: number; username: string; site: string; cpe: number }>;
  lowStockBelow: number;
  toUnload: Array<{ site: string; model: string; mac: string; serial: string; jobId: string | null; customer: string; installedAt: string | null; accepted: boolean }>;
}

function Office() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin', 'warehouse', 'overview'], queryFn: () => api<Overview>('/api/admin/warehouse/overview') });
  const d = q.data;
  const refresh = async () => {
    const r = await api<{ ok: boolean; items: number; error?: string | null }>('/api/admin/warehouse/refresh', { method: 'POST' });
    if (r.ok) toast(`Magazzino riletto: ${r.items} giacenze`);
    else toast(`Lettura non riuscita: ${syncError(r.error ?? 'crm_error')}`, 'bad');
    await qc.invalidateQueries({ queryKey: ['admin', 'warehouse'] });
  };

  // warehouses as rows, the models as columns
  const sites = [...new Map((d?.byModel ?? []).map((r) => [r.siteId, r.site])).entries()];
  const models = [...new Set((d?.byModel ?? []).map((r) => r.model))].sort();
  const count = (siteId: number, model: string) => d?.byModel.find((r) => r.siteId === siteId && r.model === model)?.n ?? 0;

  return (
    <div className="ui-page">
      <PageHeader
        icon="inventory"
        title="Magazzino"
        subtitle="Le CPE nei magazzini ISPBilling di installatori e partner: chi ne ha poche, quelle installate da scaricare e la storia di ogni CPE."
        actions={
          <AsyncButton icon="refresh" onClick={refresh} onError={fail}>
            Aggiorna ora
          </AsyncButton>
        }
      />
      {q.error ? (
        <Notice tone="bad">{(q.error as Error).message}</Notice>
      ) : !d ? (
        <Skeleton lines={8} />
      ) : (
        <>
          <p className="ui-muted ui-small wh-p">
            Ultima lettura da ISPBilling: {date(d.at)} · {d.items} giacenze. Si rilegge da sola; «Aggiorna ora» per leggere subito.
          </p>
          {d.error && <Notice tone="warn">Ultima lettura non riuscita: {syncError(d.error)}. {d.at ? 'I dati mostrati sono quelli della lettura precedente.' : ''}</Notice>}
          <section className="ui-stats" aria-label="Riepilogo">
            <Stat label="CPE in magazzino" value={(d.byModel ?? []).reduce((s, r) => s + r.n, 0)} />
            <Stat label="magazzini" value={sites.length} />
            <Stat label={`con meno di ${d.lowStockBelow} CPE`} value={d.lowStock.length} tone={d.lowStock.length ? 'warn' : 'good'} />
            <Stat label="da scaricare" value={d.toUnload.length} tone={d.toUnload.length ? 'warn' : 'good'} />
          </section>

          <Card title="Da scaricare in ISPBilling">
            <p className="ui-muted ui-small wh-p">CPE già installate che risultano ancora in un magazzino: vanno scaricate a mano in ISPBilling (non ha un’API per farlo). Prima quelle con il collaudo superato o approvato dal NOC.</p>
            {d.toUnload.length ? (
              <Table
                rows={d.toUnload}
                rowKey={(r) => r.mac}
                columns={[
                  { label: 'Cliente', render: (r) => <strong>{r.customer || '—'}</strong> },
                  {
                    label: 'CPE',
                    render: (r) => (
                      <span>
                        {r.model}
                        <span className="ui-mono ui-small ui-muted"> · {r.mac}</span>
                        {r.serial ? <span className="ui-mono ui-small ui-muted"> · S/N {r.serial}</span> : null}
                      </span>
                    ),
                  },
                  { label: 'Magazzino', render: (r) => r.site },
                  { label: 'Installata', render: (r) => day(r.installedAt) },
                  { label: 'Collaudo', render: (r) => (r.accepted ? <Badge tone="good">superato</Badge> : <Badge>da collaudare</Badge>) },
                  { label: '', end: true, render: (r) => (r.jobId ? <a href={`#/jobs?id=${encodeURIComponent(r.jobId)}`}>Storico</a> : null) },
                ]}
              />
            ) : (
              <EmptyState title="Niente da scaricare">Tutte le CPE installate sono già uscite dai magazzini.</EmptyState>
            )}
          </Card>

          <Card title={`Magazzini con meno di ${d.lowStockBelow} CPE`}>
            {d.lowStock.length ? (
              <Table
                rows={d.lowStock}
                rowKey={(r) => r.userId}
                columns={[
                  { label: 'Account', render: (r) => <strong>{r.username}</strong> },
                  { label: 'Magazzino', render: (r) => r.site },
                  { label: 'CPE', end: true, render: (r) => <Badge tone={r.cpe ? 'warn' : 'bad'}>{r.cpe}</Badge> },
                ]}
              />
            ) : (
              <EmptyState title="Scorte a posto">Ogni installatore o partner con un magazzino ha almeno {d.lowStockBelow} CPE.</EmptyState>
            )}
          </Card>

          <Card title="CPE per magazzino e modello">
            {sites.length ? (
              <Table
                rows={sites}
                rowKey={([id]) => id}
                columns={[
                  { label: 'Magazzino', render: ([, name]) => <strong>{name}</strong> },
                  ...models.map((m) => ({ label: m, end: true, render: ([id]: [number, string]) => count(id, m) || '—' })),
                  { label: 'Totale', end: true, render: ([id]) => <strong>{models.reduce((s, m) => s + count(id, m), 0)}</strong> },
                ]}
              />
            ) : (
              <EmptyState title="Nessuna CPE in magazzino">{d.at ? 'L’ultima lettura non ha trovato CPE nei magazzini.' : 'Il magazzino non è ancora stato letto: premi «Aggiorna ora».'}</EmptyState>
            )}
          </Card>

          <Movements />
        </>
      )}
    </div>
  );
}

interface Movement {
  id: number;
  at: string;
  mac: string;
  model: string;
  kind: 'entrata' | 'uscita' | 'trasferimento' | 'installata' | 'collaudo' | string;
  fromSite: string | null;
  toSite: string | null;
  detail: string;
  jobId: string | null;
}
const KIND_TONE: Record<string, 'good' | 'warn' | 'info' | 'neutral' | 'brand'> = { entrata: 'good', uscita: 'warn', trasferimento: 'info', installata: 'brand', collaudo: 'good' };

/** The log of the movements; a MAC shows the story of one CPE. */
function Movements() {
  const [mac, setMac] = useState('');
  const [search, setSearch] = useState('');
  const q = useQuery({
    queryKey: ['admin', 'warehouse', 'movements', search],
    queryFn: () => api<{ items: Movement[] }>(`/api/admin/warehouse/movements?${new URLSearchParams({ limit: '300', ...(search ? { mac: search } : {}) })}`),
    retry: false,
  });
  return (
    <Card title="Registro movimenti">
      <form
        className="ui-row wh-search"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(mac.trim());
        }}
      >
        <Field label="MAC della CPE" hint="Vuoto: gli ultimi movimenti di tutte le CPE.">
          <input value={mac} onChange={(e) => setMac(e.target.value)} placeholder="24:A4:3C:…" autoComplete="off" spellCheck={false} className="ui-mono" />
        </Field>
        <AsyncButton type="submit" onClick={async () => setSearch(mac.trim())}>
          Cerca
        </AsyncButton>
      </form>
      {q.error ? (
        <Notice tone="bad">{(q.error as Error).message}</Notice>
      ) : !q.data ? (
        <Skeleton lines={4} />
      ) : (
        <Table
          rows={q.data.items}
          rowKey={(r) => r.id}
          empty={search ? 'Nessun movimento per questo MAC.' : 'Nessun movimento registrato.'}
          columns={[
            { label: 'Quando', render: (r) => date(r.at) },
            { label: 'Movimento', render: (r) => <Badge tone={KIND_TONE[r.kind] ?? 'neutral'}>{r.kind}</Badge> },
            {
              label: 'CPE',
              render: (r) => (
                <button type="button" className="ui-link ui-mono ui-small" onClick={() => (setMac(r.mac), setSearch(r.mac))} title="Solo i movimenti di questa CPE">
                  {r.model ? `${r.model} · ` : ''}
                  {r.mac}
                </button>
              ),
            },
            { label: 'Da → a', render: (r) => [r.fromSite, r.toSite].filter(Boolean).join(' → ') || '—' },
            {
              label: 'Dettaglio',
              render: (r) => (
                <span className="ui-small">
                  {r.detail}
                  {r.jobId ? (
                    <>
                      {' '}
                      <a href={`#/jobs?id=${encodeURIComponent(r.jobId)}`}>storico</a>
                    </>
                  ) : null}
                </span>
              ),
            },
          ]}
        />
      )}
    </Card>
  );
}

interface Mine {
  linked: boolean;
  site: string;
  bypass: boolean;
  syncedAt: string | null;
  items: Array<{ model: string; article?: string; mac: string; serial: string; status?: string; since?: string | null }>;
}

/** Installers and partners: the CPEs of their warehouse, the ones they can install. */
function Mine() {
  const q = useQuery({ queryKey: ['warehouse', 'mine'], queryFn: () => api<Mine>('/api/warehouse/mine') });
  const d = q.data;
  const byModel = [...(d?.items ?? []).reduce((m, x) => m.set(x.model, (m.get(x.model) ?? 0) + 1), new Map<string, number>()).entries()];
  return (
    <div className="ui-page">
      <PageHeader icon="inventory" title="Il mio magazzino" subtitle="Le CPE assegnate al tuo magazzino: sono quelle che puoi installare." />
      {q.error ? (
        <Notice tone="bad">{(q.error as Error).message}</Notice>
      ) : !d ? (
        <Skeleton lines={5} />
      ) : !d.linked ? (
        <EmptyState title="Nessun magazzino collegato">Il tuo account non ha un magazzino: puoi installare qualunque CPE. Se ti serve, chiedilo all’ufficio.</EmptyState>
      ) : (
        <>
          <p className="ui-muted ui-small wh-p">
            Magazzino {d.site} · aggiornato {date(d.syncedAt)}
            {d.bypass ? ' · puoi installare anche CPE non presenti qui' : ''}
          </p>
          <section className="ui-stats" aria-label="Riepilogo">
            <Stat label="CPE" value={d.items.length} tone={d.items.length ? 'neutral' : 'warn'} />
            {byModel.map(([m, n]) => (
              <Stat key={m} label={m} value={n} />
            ))}
          </section>
          <Card title="CPE disponibili">
            <Table
              rows={d.items}
              rowKey={(r) => r.mac}
              empty="Nessuna CPE nel tuo magazzino: chiedi all’ufficio di rifornirlo."
              columns={[
                { label: 'Modello', render: (r) => <strong>{r.model}</strong> },
                { label: 'MAC', render: (r) => <span className="ui-mono ui-small">{r.mac}</span> },
                { label: 'Seriale', render: (r) => <span className="ui-mono ui-small">{r.serial || '—'}</span> },
                { label: 'Dal', render: (r) => day(r.since) },
              ]}
            />
          </Card>
        </>
      )}
    </div>
  );
}
