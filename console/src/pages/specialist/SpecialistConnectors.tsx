import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../lib/api';
import { toast } from '../../lib/toast';
import { AsyncButton, Badge, Button, Card, Drawer, EmptyState, Field, Notice, PageHeader, Skeleton } from '../../ui';
import { date, type SpecConnector } from './types';

/**
 * I miei connettori: the connectors of the companies the specialist works for, his own (never
 * CDA Net's). UISP to begin with, one per company: the installed CPEs are authorized there and its
 * device key goes into the configuration. Token and key are sealed on the server, never shown.
 */

const fail = (e: unknown) => toast((e as Error).message, 'bad');

interface TestResult {
  ok: boolean;
  version?: string | null;
  devices?: number;
  aps?: number;
  pending?: number;
  sites?: number;
  latencyMs?: number;
  error?: string;
  status?: number | null;
  detail?: string;
}

const TEST_ERRORS: Record<string, string> = {
  uisp_auth_failed: 'token rifiutato da UISP',
  uisp_unreachable: 'UISP non raggiungibile dal server',
  uisp_tls_error: 'certificato TLS non valido (prova «Certificato non verificato»)',
  uisp_error: 'UISP ha risposto con un errore',
  connector_incomplete: 'servono indirizzo e token',
};

function TestView({ r }: { r: TestResult }) {
  if (!r.ok) return <Notice tone="bad" title="Connessione non riuscita">{`${TEST_ERRORS[r.error ?? ''] ?? r.error ?? 'errore'}${r.status ? ` (HTTP ${r.status})` : ''}${r.detail ? ` · ${r.detail}` : ''}`}</Notice>;
  return (
    <Notice tone="good" title="Connessione riuscita">
      UISP {r.version ?? ''} · {r.devices ?? 0} dispositivi, {r.aps ?? 0} AP, {r.sites ?? 0} site{r.pending ? ` · ${r.pending} da autorizzare` : ''}
      {r.latencyMs != null ? ` · ${r.latencyMs} ms` : ''}
    </Notice>
  );
}

export function SpecialistConnectors() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['specialist', 'connectors'], queryFn: () => api<{ kinds: Array<{ kind: string; label: string }>; items: SpecConnector[] }>('/api/specialist/connectors') });
  const [editing, setEditing] = useState<SpecConnector | 'new' | null>(null);
  const [tests, setTests] = useState<Record<number, TestResult>>({});
  const reload = () => qc.invalidateQueries({ queryKey: ['specialist'] });
  const test = async (c: SpecConnector) => {
    const r = await api<TestResult>(`/api/specialist/connectors/${c.id}/test`, { method: 'POST', body: {} });
    setTests({ ...tests, [c.id]: r });
    await reload();
  };
  const remove = async (c: SpecConnector) => {
    if (!confirm(`Eliminare il connettore «${c.name}»? Le installazioni fatte con esso restano nello storico, con il nome dell’azienda.`)) return;
    await api(`/api/specialist/connectors/${c.id}`, { method: 'DELETE' });
    toast('Connettore eliminato');
    await reload();
  };
  return (
    <div className="ui-page">
      <PageHeader
        icon="link"
        title="I miei connettori"
        subtitle="I connettori delle aziende per cui lavori, tuoi e separati da quelli di CDA Net. Per ora UISP: autorizzi lì le CPE installate e la sua chiave dei dispositivi entra nella configurazione. Altri connettori arriveranno."
        actions={
          <Button variant="primary" icon="add_circle" onClick={() => setEditing('new')}>
            Nuovo connettore UISP
          </Button>
        }
      />
      {q.error ? (
        <Notice tone="bad">{(q.error as Error).message}</Notice>
      ) : !q.data ? (
        <Skeleton lines={4} />
      ) : !q.data.items.length ? (
        <Card>
          <EmptyState icon="link" title="Nessun connettore">
            Aggiungi l’UISP di un’azienda: indirizzo, token API (UISP → Impostazioni → Utenti → token API) e, facoltativa, la chiave UISP dei dispositivi (UISP → Impostazioni → Dispositivi).
          </EmptyState>
        </Card>
      ) : (
        <div className="ui-grid-2">
          {q.data.items.map((c) => (
            <Card
              key={c.id}
              title={c.name}
              actions={
                <>
                  <AsyncButton icon="refresh" onClick={() => test(c)} onError={fail}>
                    Prova
                  </AsyncButton>
                  <Button onClick={() => setEditing(c)}>Modifica</Button>
                </>
              }
            >
              <div className="ui-row">
                <Badge tone="info">UISP</Badge>
                <Badge tone={c.enabled ? 'good' : 'neutral'}>{c.enabled ? 'attivo' : 'disattivato'}</Badge>
                {c.ignoreTls && <Badge tone="warn">certificato non verificato</Badge>}
              </div>
              <dl className="ui-facts sp-facts">
                <div>
                  <dt>Indirizzo</dt>
                  <dd className="ui-mono">{c.url}</dd>
                </div>
                <div>
                  <dt>Token</dt>
                  <dd>{c.tokenSet ? `impostato (${c.tokenHint})` : 'mancante'}</dd>
                </div>
                <div>
                  <dt>Chiave dei dispositivi</dt>
                  <dd>{c.uispKeySet ? 'impostata' : 'non impostata (si scrive nell’app)'}</dd>
                </div>
                <div>
                  <dt>Installazioni</dt>
                  <dd>{c.jobs}</dd>
                </div>
              </dl>
              {tests[c.id] ? (
                <TestView r={tests[c.id]!} />
              ) : c.lastTest ? (
                <p className={`ui-small ${c.lastTest.ok ? 'ui-muted' : 'sp-bad'}`}>
                  Ultima prova {date(c.lastTest.at)}: {c.lastTest.ok ? 'riuscita' : 'non riuscita'} · {c.lastTest.detail}
                </p>
              ) : (
                <p className="ui-muted ui-small">Mai provato.</p>
              )}
              <div className="ui-row">
                <AsyncButton variant="ghost" icon="delete" onClick={() => remove(c)} onError={fail}>
                  Elimina
                </AsyncButton>
              </div>
            </Card>
          ))}
        </div>
      )}
      <Card title="Come funziona">
        <ul className="ui-list ui-small">
          <li>Nel flusso Specialist dell’app scegli l’azienda: la sua chiave UISP va nella configurazione della CPE (se il template ha il segnaposto, altrimenti la scrivi lì).</li>
          <li>Dopo la scrittura la CPE si collega all’UISP dell’azienda: dall’app o dallo Storico Specialist la autorizzi nel site del suo AP (proposto) o in quello che scegli.</li>
          <li>Token e chiave restano cifrati sul server e non vengono mai mostrati, né all’app né qui.</li>
        </ul>
      </Card>
      {editing && (
        <ConnectorDrawer
          c={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function ConnectorDrawer({ c, onClose, onSaved }: { c: SpecConnector | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [f, setF] = useState({ name: c?.name ?? '', url: c?.url ?? '', token: '', uispKey: '', ignoreTls: c?.ignoreTls ?? false, enabled: c?.enabled ?? true, removeKey: false });
  const [result, setResult] = useState<TestResult | null>(null);
  const test = async () => {
    const r = await api<TestResult>('/api/specialist/connectors/test', {
      method: 'POST',
      body: { ...(c ? { id: c.id } : {}), url: f.url.trim(), ...(f.token.trim() ? { token: f.token.trim() } : {}), ignoreTls: f.ignoreTls },
    });
    setResult(r);
  };
  const save = async () => {
    if (!f.name.trim()) throw new Error('Scrivi il nome dell’azienda');
    if (!f.url.trim()) throw new Error('Scrivi l’indirizzo di UISP');
    if (!c && !f.token.trim()) throw new Error('Serve il token API di UISP');
    const body = {
      name: f.name.trim(),
      url: f.url.trim(),
      ...(f.token.trim() ? { token: f.token.trim() } : {}),
      ...(f.uispKey.trim() ? { uispKey: f.uispKey.trim() } : f.removeKey ? { uispKey: null } : {}),
      ignoreTls: f.ignoreTls,
      enabled: f.enabled,
    };
    if (c) await api(`/api/specialist/connectors/${c.id}`, { method: 'PATCH', body });
    else await api('/api/specialist/connectors', { method: 'POST', body: { kind: 'uisp', ...body } });
    toast(`Connettore «${body.name}» salvato`);
    await onSaved();
  };
  return (
    <Drawer
      title={c ? `Connettore · ${c.name}` : 'Nuovo connettore UISP'}
      onClose={onClose}
      footer={
        <>
          <AsyncButton variant="primary" onClick={save} onError={fail}>
            Salva
          </AsyncButton>
          <AsyncButton onClick={test} onError={fail}>
            Prova con questi valori
          </AsyncButton>
          <Button variant="ghost" onClick={onClose}>
            Annulla
          </Button>
        </>
      }
    >
      <div className="ui-grid-form">
        <Field label="Azienda" hint="Il nome con cui la scegli nell’app e la trovi nello storico.">
          <input value={f.name} maxLength={60} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="es. Wireless Sud Srl" />
        </Field>
        <Field label="Indirizzo di UISP" hint="Come nel browser, es. https://uisp.azienda.it (anche con /nms/api/v2.1).">
          <input className="ui-mono" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://uisp.azienda.it" />
        </Field>
      </div>
      <Field label="Token API" hint={c?.tokenSet ? `Impostato (${c.tokenHint}): lascia vuoto per non cambiarlo. Cifrato, mai mostrato.` : 'UISP → Impostazioni → Utenti → token API (lettura e scrittura dei dispositivi). Cifrato, mai mostrato.'}>
        <input type="password" autoComplete="new-password" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} />
      </Field>
      <Field
        label="Chiave UISP dei dispositivi (wss://…), facoltativa"
        hint={c?.uispKeySet ? 'Impostata: lascia vuoto per non cambiarla. Cifrata, mai mostrata.' : 'UISP → Impostazioni → Dispositivi → «UISP key»: va nella configurazione delle CPE dell’azienda. Senza, la scrivi nell’app quando serve.'}
      >
        <input type="password" autoComplete="new-password" value={f.uispKey} disabled={f.removeKey} onChange={(e) => setF({ ...f, uispKey: e.target.value })} />
      </Field>
      {c?.uispKeySet && (
        <label className="ui-check ui-small">
          <input type="checkbox" checked={f.removeKey} onChange={(e) => setF({ ...f, removeKey: e.target.checked, uispKey: '' })} />
          Rimuovi la chiave dei dispositivi
        </label>
      )}
      <label className="ui-check">
        <input type="checkbox" checked={f.ignoreTls} onChange={(e) => setF({ ...f, ignoreTls: e.target.checked })} />
        Certificato non verificato (UISP con certificato autofirmato)
      </label>
      <label className="ui-check">
        <input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
        Attivo (si può scegliere nell’app)
      </label>
      {result && <TestView r={result} />}
    </Drawer>
  );
}
