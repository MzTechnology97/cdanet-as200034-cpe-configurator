import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from '../lib/toast';
import { api } from '../lib/api';
import { AsyncButton, Badge, Card, Field, Notice } from '../ui';

/**
 * Connettori → CRM (ISP Billing): the API key sealed on the server, a test of every module the
 * integration reads (each key has its own permissions) and the RADIUS state copied for the NOC.
 */

const ERRORS: Record<string, string> = {
  crm_incomplete: 'Servono indirizzo, API ID e API key.',
  crm_unreachable: 'ISP Billing non raggiungibile dal server (indirizzo, DNS o firewall).',
  crm_auth_failed: 'API ID o API key non validi.',
  crm_forbidden: 'Accesso negato: la chiave non ha questo permesso, oppure l’IP del server non è tra quelli autorizzati della chiave.',
  crm_error: 'ISP Billing ha risposto con un errore.',
};
const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const apiError = (e: unknown) => {
  const err = e as Error & { body?: { error?: string; issues?: Array<{ message: string }> } };
  return new Error(ERRORS[err.body?.error ?? ''] ?? err.body?.issues?.[0]?.message ?? err.message);
};
const fail = (e: unknown) => toast((e as Error).message, 'bad');

export interface Crm {
  configured: boolean;
  enabled: boolean;
  url: string;
  apiId: string;
  keySet: boolean;
  keyHint?: string;
  updatedAt?: string | null;
  updatedBy?: string | null;
}
interface Test {
  ok: boolean;
  error?: string;
  status?: number;
  detail?: string;
  latencyMs?: number;
  modules?: Array<{ label: string; ok: boolean; count?: number | null; error?: string; status?: number }>;
}
interface Radius {
  configured: boolean;
  at?: string | null;
  ms?: number;
  accounts: number;
  online: number;
  offline: number;
  suspended: number;
  running?: boolean;
  error?: string | null;
}

export function CrmCard({ c, onSaved }: { c: Crm; onSaved: () => Promise<void> }) {
  const [f, setF] = useState({ enabled: c.configured ? c.enabled : true, url: c.url, apiId: c.apiId, apiKey: '' });
  const [test, setTest] = useState<{ r?: Test; loading?: boolean } | null>(null);
  const body = () => ({ enabled: f.enabled, url: f.url.trim(), apiId: f.apiId.trim(), ...(f.apiKey.trim() ? { apiKey: f.apiKey.trim() } : {}) });
  const on = c.configured && c.enabled;
  const runTest = async () => {
    setTest({ loading: true });
    try {
      setTest({ r: await api<Test>('/api/admin/connectors/crm/test', { method: 'POST', body: body() }) });
    } catch (e) {
      setTest(null);
      throw apiError(e);
    }
  };
  const save = async () => {
    try {
      const r = await api<{ enabled: boolean }>('/api/admin/connectors/crm', { method: 'PUT', body: body() });
      toast(r.enabled ? 'Connettore CRM salvato e attivo' : 'Connettore CRM salvato (disattivato)');
      await onSaved();
    } catch (e) {
      throw apiError(e);
    }
  };
  const remove = async () => {
    if (!confirm('Rimuovere il connettore CRM? La chiave salvata viene cancellata dal server.')) return;
    await api('/api/admin/connectors/crm', { method: 'DELETE' });
    toast('Connettore CRM rimosso');
    await onSaved();
  };
  const r = test?.r;
  const readable = r?.modules?.filter((m) => m.ok).length ?? 0;
  return (
    <Card title="CRM · ISP Billing" actions={<Badge tone={on ? 'good' : c.configured ? 'neutral' : 'warn'}>{on ? 'attivo' : c.configured ? 'disattivato' : 'non configurato'}</Badge>}>
      <p className="ui-muted ui-small cn-p">Clienti, account RADIUS e profili, servizi, attività e magazzino.</p>
      {c.updatedAt && (
        <p className="ui-muted ui-small cn-p">
          Ultima modifica {date(c.updatedAt)}
          {c.updatedBy ? ` · ${c.updatedBy}` : ''}
        </p>
      )}
      <label className="ui-check">
        <input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
        Connettore attivo
      </label>
      <div className="ui-grid-form">
        <Field label="Indirizzo">
          <input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://ispbilling.it" inputMode="url" autoComplete="off" />
        </Field>
        <Field label="API ID">
          <input value={f.apiId} onChange={(e) => setF({ ...f, apiId: e.target.value })} placeholder="api_id" autoComplete="off" />
        </Field>
        <Field label="API key">
          <input type="password" autoComplete="off" value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} placeholder={c.keySet ? `Impostata (${c.keyHint}): lascia vuoto per non cambiarla` : 'API key'} />
        </Field>
      </div>
      <p className="ui-muted ui-small cn-p">
        Crea la chiave in ISP Billing (Dashboard → API) con i soli permessi di lettura che servono e, se possibile, limita gli IP all’indirizzo pubblico di questo server. La chiave resta cifrata sul server e non viene mai mostrata; gli installatori non vedono questa fonte.
      </p>
      <div className="ui-row">
        <AsyncButton onClick={runTest} onError={fail}>
          Testa connessione
        </AsyncButton>
        <AsyncButton variant="primary" onClick={save} onError={fail}>
          Salva
        </AsyncButton>
        {c.configured && (
          <AsyncButton variant="danger" onClick={remove} onError={fail}>
            Rimuovi configurazione
          </AsyncButton>
        )}
      </div>
      {test?.loading && <p className="ui-muted ui-small cn-p">Test in corso: un controllo per modulo…</p>}
      {r &&
        (!r.modules ? (
          <Notice tone="bad">
            {ERRORS[r.error ?? ''] ?? r.error}
            {r.status ? ` (HTTP ${r.status})` : ''}
            {r.detail && <div className="ui-mono ui-small">{r.detail}</div>}
          </Notice>
        ) : (
          <>
            <Notice tone={r.ok ? (readable === r.modules.length ? 'good' : 'warn') : 'bad'}>{r.ok ? `Chiave valida · ${readable} moduli su ${r.modules.length} leggibili · ${r.latencyMs} ms` : (ERRORS[r.error ?? ''] ?? r.error)}</Notice>
            <ul className="cn-modules">
              {r.modules.map((m) => (
                <li key={m.label}>
                  <span>
                    {m.ok ? '✅' : '⛔'} {m.label}
                  </span>
                  <span className="ui-muted ui-small">{m.ok ? (m.count != null ? `${m.count.toLocaleString('it-IT')} record` : 'leggibile') : m.error === 'crm_forbidden' ? 'permesso mancante (o IP non autorizzato)' : `${ERRORS[m.error ?? ''] ?? m.error}${m.status ? ` · HTTP ${m.status}` : ''}`}</span>
                </li>
              ))}
            </ul>
            {readable < r.modules.length && <p className="ui-muted ui-small cn-p">Per i moduli bloccati aggiungi il permesso alla chiave in ISP Billing (Dashboard → API) oppure lasciali così se non servono.</p>}
          </>
        ))}
      {on && <RadiusSync />}
    </Card>
  );
}

/** The RADIUS state copied for the NOC (Salute CPE, Stato rete): last sync and sync now. */
function RadiusSync() {
  const qc = useQueryClient();
  const key = ['admin', 'crm', 'radius'];
  const q = useQuery({ queryKey: key, queryFn: () => api<Radius>('/api/admin/crm/radius/status'), refetchInterval: (s) => (s.state.data?.running ? 4000 : false) });
  const r = q.data;
  if (!r?.configured) return null;
  return (
    <section className="cn-sec">
      <h3>Stato RADIUS per il NOC</h3>
      <p className="ui-muted ui-small cn-p">
        {r.at
          ? `Aggiornato ${date(r.at)} in ${Math.round((r.ms ?? 0) / 1000)} s: ${r.accounts.toLocaleString('it-IT')} account, ${r.online} online, ${r.offline} offline, ${r.suspended} sospesi.`
          : 'Non ancora sincronizzato: parte da solo entro un minuto dall’avvio e poi ogni 10 minuti.'}
        {r.running ? ' Sincronizzazione in corso…' : ''}
      </p>
      {r.error && <Notice tone="warn">Ultima sincronizzazione non riuscita: {ERRORS[r.error] ?? r.error}</Notice>}
      <div className="ui-row">
        <AsyncButton
          onClick={async () => {
            await api('/api/admin/crm/radius/sync', { method: 'POST' });
            toast('Sincronizzazione avviata: dura circa un minuto');
            await qc.invalidateQueries({ queryKey: key });
          }}
          onError={fail}
        >
          Sincronizza stato RADIUS
        </AsyncButton>
      </div>
    </section>
  );
}
