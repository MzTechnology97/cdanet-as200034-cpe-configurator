import { useState } from 'react';
import { toast } from '../lib/toast';
import { api } from '../lib/api';
import { AsyncButton, Badge, Card, Field, Notice } from '../ui';

/**
 * Connettori → Copertura multi-operatore (MyWic): FTTH, FTTC/FTTx and the radio networks (Eolo) of
 * the other operators, for the coverage search. An API token of the MyWic dashboard, sealed on the
 * server; the test lists the operators and technologies the account can check, nothing else.
 */

const ERRORS: Record<string, string> = {
  mywic_incomplete: 'Serve il token API di MyWic.',
  mywic_unreachable: 'MyWic non raggiungibile dal server (DNS o firewall).',
  mywic_auth_failed: 'Token rifiutato da MyWic: controlla di averlo copiato tutto e che non sia stato revocato.',
  mywic_forbidden: 'MyWic ha negato l’accesso con questo token.',
  mywic_rate_limited: 'Troppe richieste a MyWic: riprova tra qualche secondo.',
  mywic_error: 'MyWic ha risposto con un errore.',
};
const TECH: Record<string, string> = {
  FTTH: 'FTTH',
  FTTC: 'FTTC',
  GPON_BUSINESS: 'GPON business',
  FIBRA_P2P: 'fibra P2P',
  FTTO: 'FTTO',
  ASIM_ETH: 'ADSL',
  ASIM_ATM: 'ADSL',
  SIM_ATM: 'SHDSL',
  SIM_ETH: 'SHDSL',
  SIM_ATM_BOND: 'SHDSL bonding',
  WIRELESS: 'FWA',
  WIRELESS_28: 'FWA 28 GHz',
  WIRELESS_P2P: 'radio P2P',
  LTE: 'LTE',
};
const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const apiError = (e: unknown) => {
  const err = e as Error & { body?: { error?: string; issues?: Array<{ message: string }> } };
  return new Error(ERRORS[err.body?.error ?? ''] ?? err.body?.issues?.[0]?.message ?? err.message);
};
const fail = (e: unknown) => toast((e as Error).message, 'bad');

export interface MyWic {
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
  providers?: Array<{ name: string; technologies: string[] }>;
}

export function MyWicCard({ m, onSaved }: { m: MyWic; onSaved: () => Promise<void> }) {
  const [f, setF] = useState({ enabled: m.configured ? m.enabled : true, token: '' });
  const [test, setTest] = useState<{ r?: Test; loading?: boolean } | null>(null);
  const body = () => ({ enabled: f.enabled, ...(f.token.trim() ? { token: f.token.trim() } : {}) });
  const on = m.configured && m.enabled;
  const runTest = async () => {
    setTest({ loading: true });
    try {
      setTest({ r: await api<Test>('/api/admin/connectors/mywic/test', { method: 'POST', body: body() }) });
    } catch (e) {
      setTest(null);
      throw apiError(e);
    }
  };
  const save = async () => {
    try {
      const r = await api<{ enabled: boolean }>('/api/admin/connectors/mywic', { method: 'PUT', body: body() });
      toast(r.enabled ? 'Copertura multi-operatore salvata e attiva' : 'Copertura multi-operatore salvata (disattivata)');
      setF({ ...f, token: '' });
      await onSaved();
    } catch (e) {
      throw apiError(e);
    }
  };
  const remove = async () => {
    if (!confirm('Rimuovere il connettore della copertura multi-operatore? Il token salvato viene cancellato dal server.')) return;
    await api('/api/admin/connectors/mywic', { method: 'DELETE' });
    toast('Connettore rimosso');
    await onSaved();
  };
  const r = test?.r;
  return (
    <Card title="Copertura multi-operatore · MyWic" actions={<Badge tone={on ? 'good' : m.configured ? 'neutral' : 'warn'}>{on ? 'attivo' : m.configured ? 'disattivato' : 'non configurato'}</Badge>}>
      <p className="ui-muted ui-small cn-p">Copertura FTTH, FTTC e radio (Eolo) degli altri operatori, da affiancare alla nostra nella verifica di copertura, con il bollino AGCOM di ogni tecnologia.</p>
      {m.updatedAt && (
        <p className="ui-muted ui-small cn-p">
          Ultima modifica {date(m.updatedAt)}
          {m.updatedBy ? ` · ${m.updatedBy}` : ''}
        </p>
      )}
      <label className="ui-check">
        <input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
        Connettore attivo
      </label>
      <div className="ui-grid-form">
        <Field label="Token API">
          <input type="password" autoComplete="off" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} placeholder={m.tokenSet ? `Impostato (${m.tokenHint}): lascia vuoto per non cambiarlo` : 'Token API'} />
        </Field>
      </div>
      <p className="ui-muted ui-small cn-p">Crea il token nella dashboard di MyWic con «Generate API token». Resta cifrato sul server e non viene mai mostrato; il server legge soltanto. Gli installatori non vedono questa fonte.</p>
      <div className="ui-row">
        <AsyncButton onClick={runTest} onError={fail}>
          Testa connessione
        </AsyncButton>
        <AsyncButton variant="primary" onClick={save} onError={fail}>
          Salva
        </AsyncButton>
        {m.configured && (
          <AsyncButton variant="danger" onClick={remove} onError={fail}>
            Rimuovi configurazione
          </AsyncButton>
        )}
      </div>
      {test?.loading && <p className="ui-muted ui-small cn-p">Test in corso…</p>}
      {r &&
        (r.ok ? (
          <>
            <Notice tone={r.providers?.length ? 'good' : 'warn'}>
              {r.providers?.length ? `Token valido · ${r.providers.length} operatori verificabili · ${r.latencyMs} ms` : 'Token valido, ma l’account non ha operatori abilitati.'}
            </Notice>
            {!!r.providers?.length && (
              <ul className="cn-modules">
                {r.providers.map((p) => (
                  <li key={p.name}>
                    <span>{p.name}</span>
                    <span className="ui-muted ui-small">{[...new Set(p.technologies.map((t) => TECH[t] ?? t))].join(' · ') || '—'}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
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
