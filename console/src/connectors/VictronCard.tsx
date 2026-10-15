import { useState } from 'react';
import { toast } from '../lib/toast';
import { api } from '../lib/api';
import { AsyncButton, Badge, Card, Field, Notice } from '../ui';

/**
 * Connettori → Victron VRM: the solar and battery systems that power the POPs. A personal access
 * token of a VRM user, sealed on the server; the test reads the installations it sees (counts
 * only) and writes nothing to VRM.
 */

const ERRORS: Record<string, string> = {
  vrm_incomplete: 'Serve il token di accesso VRM.',
  vrm_unreachable: 'VRM non raggiungibile dal server (DNS o firewall).',
  vrm_auth_failed: 'Token rifiutato da VRM: controlla di averlo copiato tutto e che non sia scaduto o revocato.',
  vrm_forbidden: 'VRM ha negato l’accesso con questo token.',
  vrm_rate_limited: 'Troppe richieste a VRM: riprova tra qualche secondo.',
  vrm_error: 'VRM ha risposto con un errore.',
};
const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const apiError = (e: unknown) => {
  const err = e as Error & { body?: { error?: string; issues?: Array<{ message: string }> } };
  return new Error(ERRORS[err.body?.error ?? ''] ?? err.body?.issues?.[0]?.message ?? err.message);
};
const fail = (e: unknown) => toast((e as Error).message, 'bad');

export interface Victron {
  configured: boolean;
  enabled: boolean;
  tokenSet: boolean;
  tokenHint?: string;
  updatedAt?: string | null;
  updatedBy?: string | null;
}
interface Test {
  ok: boolean;
  error?: string;
  status?: number | null;
  detail?: string;
  latencyMs?: number;
  user?: string;
  installations?: number;
  withAlarms?: number;
  silent?: number;
}

export function VictronCard({ v, onSaved }: { v: Victron; onSaved: () => Promise<void> }) {
  const [f, setF] = useState({ enabled: v.configured ? v.enabled : true, token: '' });
  const [test, setTest] = useState<{ r?: Test; loading?: boolean } | null>(null);
  const body = () => ({ enabled: f.enabled, ...(f.token.trim() ? { token: f.token.trim() } : {}) });
  const on = v.configured && v.enabled;
  const runTest = async () => {
    setTest({ loading: true });
    try {
      setTest({ r: await api<Test>('/api/admin/connectors/victron/test', { method: 'POST', body: body() }) });
    } catch (e) {
      setTest(null);
      throw apiError(e);
    }
  };
  const save = async () => {
    try {
      const r = await api<{ enabled: boolean }>('/api/admin/connectors/victron', { method: 'PUT', body: body() });
      toast(r.enabled ? 'Connettore Victron salvato e attivo' : 'Connettore Victron salvato (disattivato)');
      setF({ ...f, token: '' });
      await onSaved();
    } catch (e) {
      throw apiError(e);
    }
  };
  const remove = async () => {
    if (!confirm('Rimuovere il connettore Victron? Il token salvato viene cancellato dal server.')) return;
    await api('/api/admin/connectors/victron', { method: 'DELETE' });
    toast('Connettore Victron rimosso');
    await onSaved();
  };
  const r = test?.r;
  return (
    <Card title="Victron VRM" actions={<Badge tone={on ? 'good' : v.configured ? 'neutral' : 'warn'}>{on ? 'attivo' : v.configured ? 'disattivato' : 'non configurato'}</Badge>}>
      <p className="ui-muted ui-small cn-p">Impianti fotovoltaici e batterie che alimentano i POP: stato, allarmi e ultimo dato ricevuto, in sola lettura.</p>
      {v.updatedAt && (
        <p className="ui-muted ui-small cn-p">
          Ultima modifica {date(v.updatedAt)}
          {v.updatedBy ? ` · ${v.updatedBy}` : ''}
        </p>
      )}
      <label className="ui-check">
        <input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
        Connettore attivo
      </label>
      <div className="ui-grid-form">
        <Field label="Token di accesso VRM">
          <input type="password" autoComplete="off" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} placeholder={v.tokenSet ? `Impostato (${v.tokenHint}): lascia vuoto per non cambiarlo` : 'Token di accesso'} />
        </Field>
      </div>
      <p className="ui-muted ui-small cn-p">
        Crea il token in VRM con l’utente che vede gli impianti dei POP: Preferenze → Integrazioni → Token di accesso. Il token resta cifrato sul server e non viene mai mostrato; il server legge soltanto, non cambia nulla in VRM. Gli installatori non vedono questa fonte.
      </p>
      <div className="ui-row">
        <AsyncButton onClick={runTest} onError={fail}>
          Testa connessione
        </AsyncButton>
        <AsyncButton variant="primary" onClick={save} onError={fail}>
          Salva
        </AsyncButton>
        {v.configured && (
          <AsyncButton variant="danger" onClick={remove} onError={fail}>
            Rimuovi configurazione
          </AsyncButton>
        )}
      </div>
      {test?.loading && <p className="ui-muted ui-small cn-p">Test in corso…</p>}
      {r &&
        (r.ok ? (
          <Notice tone={r.installations ? 'good' : 'warn'}>
            Token valido{r.user ? ` · utente ${r.user}` : ''} · {r.installations ?? 0} impianti visibili
            {r.installations ? ` · ${r.withAlarms ?? 0} con allarmi attivi · ${r.silent ?? 0} senza dati da oltre un’ora` : ': questo utente VRM non vede nessun impianto'} · {r.latencyMs} ms
          </Notice>
        ) : (
          <Notice tone="bad">
            {ERRORS[r.error ?? ''] ?? r.error}
            {r.status ? ` (HTTP ${r.status})` : ''}
            {r.detail && <div className="ui-mono ui-small">{r.detail}</div>}
          </Notice>
        ))}
    </Card>
  );
}
