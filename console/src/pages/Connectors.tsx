import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from '../lib/toast';
import { type Crm, CrmCard } from '../connectors/CrmCard';
import { type Firebase, FirebaseCard } from '../connectors/FirebaseCard';
import { type Imagery, ImageryCard } from '../connectors/ImageryCard';
import { type Telegram, TelegramCard } from '../connectors/TelegramCard';
import { type Victron, VictronCard } from '../connectors/VictronCard';
import { type MyWic, MyWicCard } from '../connectors/MyWicCard';
import { type Nas, NasCard } from '../connectors/NasCard';
import { api } from '../lib/api';
import { AsyncButton, Badge, Card, Field, Notice, PageHeader, Skeleton, Stat } from '../ui';

/**
 * Connettori (admins): the external systems, configured and tested from the console. Credentials
 * stay on the server, encrypted, and are never shown again (only whether they are set). UISP and
 * the address search, CRM (ISP Billing), Victron VRM (the POPs' solar systems), the NAS of the nightly backup, Telegram, Firebase (push
 * notifications of the app) and aerial imagery.
 */

const ERRORS: Record<string, string> = {
  uisp_unreachable: 'UISP non raggiungibile dal server (indirizzo, DNS, firewall o porta).',
  uisp_auth_failed: 'Token rifiutato da UISP: verifica il token e che abbia permessi di lettura/scrittura.',
  uisp_tls_error: 'Certificato TLS non valido o autofirmato: attiva «Ignora verifica TLS» solo se la rete è fidata.',
  uisp_error: 'UISP ha risposto con un errore.',
  connector_incomplete: 'Servono indirizzo UISP e token.',
  uisp_crm_unauthorized: 'UISP ha rifiutato la chiave del CRM.',
  uisp_crm_error: 'Errore del CRM di UISP.',
};
const SOURCE: Record<string, string> = { console: 'configurato dalla console', env: 'da file .env del server', none: 'non configurato' };

interface Uisp {
  source: 'console' | 'env' | 'none';
  enabled: boolean;
  active: boolean;
  url: string;
  tokenSet: boolean;
  tokenHint?: string;
  /** The app key of the UISP CRM is set (never returned): new subscribers at acceptance. */
  crmKeySet?: boolean;
  ignoreTls: boolean;
  autoBackup: boolean;
  coverageMaxKm: number;
  cacheSeconds: number;
  updatedAt?: string | null;
  updatedBy?: string | null;
}
interface Geocoder {
  local: boolean;
  url: string;
  fallbackUrl?: string | null;
  contact?: string | null;
}
interface Data {
  uisp: Uisp;
  crm: Crm;
  victron?: Victron | null;
  mywic?: MyWic | null;
  nas?: Nas | null;
  telegram?: Telegram | null;
  geocoder: Geocoder;
  imagery?: Imagery | null;
  firebase?: Firebase | null;
}
interface TestResult {
  ok: boolean;
  version?: string;
  deployment?: string;
  latencyMs?: number;
  devices?: number;
  aps?: number;
  apsWithLocation?: number;
  ptpLinks?: number | null;
  pending?: number;
  sites?: number;
  error?: string;
  status?: number;
  detail?: string;
  /** The CRM app key (typed or saved): the service plans it can read; null without a key. */
  crm?: { ok: boolean; plans?: number; error?: string } | null;
}

const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const fail = (e: unknown) => toast((e as Error).message, 'bad');
const apiError = (e: unknown) => {
  const err = e as Error & { body?: { error?: string } };
  return new Error(ERRORS[err.body?.error ?? ''] ?? err.message);
};

export function Connectors() {
  const q = useQuery({ queryKey: ['admin', 'connectors'], queryFn: () => api<Data>('/api/admin/connectors') });
  const reload = async () => void (await q.refetch());
  const d = q.data;
  return (
    <div className="ui-page">
      <PageHeader icon="link" title="Connettori" subtitle="Integrazioni con sistemi esterni. Le credenziali restano sul server, cifrate, e non vengono mai mostrate." />
      {q.error && <Notice tone="bad">{(q.error as Error).message}</Notice>}
      {!d && !q.error && <Skeleton lines={10} />}
      {d && (
        <>
          <UispCard key={`${d.uisp.updatedAt ?? ''}-${d.uisp.source}`} u={d.uisp} onSaved={reload} />
          <CrmCard key={`crm-${d.crm.updatedAt ?? ""}`} c={d.crm} onSaved={reload} />
          {d.victron ? <VictronCard key={`vrm-${d.victron.updatedAt ?? ''}`} v={d.victron} onSaved={reload} /> : null}
          {d.mywic ? <MyWicCard key={`mw-${d.mywic.updatedAt ?? ''}`} m={d.mywic} onSaved={reload} /> : null}
          {d.nas ? <NasCard key={`nas-${d.nas.updatedAt ?? ''}`} n={d.nas} onSaved={reload} /> : null}
          {d.telegram ? <TelegramCard key={`tg-${d.telegram.updatedAt ?? ""}`} t={d.telegram} onSaved={reload} /> : null}
          {d.firebase ? <FirebaseCard key={`fb-${d.firebase.updatedAt ?? ''}-${d.firebase.configured}`} f={d.firebase} onSaved={reload} /> : null}
          <GeocoderCard g={d.geocoder} />
          {d.imagery ? <ImageryCard key={`im-${d.imagery.updatedAt ?? ""}`} v={d.imagery} onSaved={reload} /> : null}
        </>
      )}
    </div>
  );
}

function UispCard({ u, onSaved }: { u: Uisp; onSaved: () => Promise<void> }) {
  const [f, setF] = useState({
    enabled: u.source === 'none' ? true : u.enabled,
    url: u.url,
    token: '',
    crmKey: '',
    ignoreTls: u.ignoreTls,
    autoBackup: u.autoBackup,
    radius: String(u.coverageMaxKm),
    cache: String(u.cacheSeconds),
  });
  const [test, setTest] = useState<{ r?: TestResult; error?: string; loading?: boolean } | null>(null);
  const body = () => ({
    enabled: f.enabled,
    url: f.url.trim(),
    ...(f.token.trim() ? { token: f.token.trim() } : {}),
    ...(f.crmKey.trim() ? { crmKey: f.crmKey.trim() } : {}),
    ignoreTls: f.ignoreTls,
    autoBackup: f.autoBackup,
    coverageMaxKm: Number(f.radius) || 15,
    cacheSeconds: Number(f.cache) || 60,
  });
  const runTest = async () => {
    setTest({ loading: true });
    try {
      setTest({ r: await api<TestResult>('/api/admin/connectors/uisp/test', { method: 'POST', body: body() }) });
    } catch (e) {
      setTest({ error: apiError(e).message });
    }
  };
  const save = async () => {
    try {
      const r = await api<{ active: boolean }>('/api/admin/connectors/uisp', { method: 'PUT', body: body() });
      toast(r.active ? 'Connettore UISP salvato e attivo' : 'Connettore UISP salvato (disattivato)');
      await onSaved();
    } catch (e) {
      throw apiError(e);
    }
  };
  const reset = async () => {
    if (!confirm('Rimuovere la configurazione UISP salvata nella console? Verranno usati i valori del file .env, se presenti.')) return;
    await api('/api/admin/connectors/uisp', { method: 'DELETE' });
    toast('Configurazione rimossa');
    await onSaved();
  };
  const r = test?.r;
  return (
    <Card
      title="UISP"
      actions={
        <>
          <Badge tone={u.active ? 'good' : 'neutral'}>{u.active ? 'attivo' : 'non attivo'}</Badge>
          <Badge tone={u.source === 'none' ? 'warn' : 'neutral'}>{SOURCE[u.source]}</Badge>
          <Badge tone={u.crmKeySet ? 'good' : 'neutral'}>{u.crmKeySet ? 'chiave CRM impostata' : 'chiave CRM non impostata'}</Badge>
        </>
      }
    >
      <p className="ui-muted ui-small cn-p">AP vicini e copertura, stato delle CPE, accettazione dallo storico (con la chiave del CRM anche come nuovo subscriber) e backup.</p>
      {u.updatedAt && (
        <p className="ui-muted ui-small cn-p">
          Ultima modifica {date(u.updatedAt)}
          {u.updatedBy ? ` · ${u.updatedBy}` : ''}
        </p>
      )}
      {u.source === 'env' && <p className="ui-muted ui-small cn-p">Attualmente letto dal .env: salvando qui la configurazione della console prende il sopravvento.</p>}
      <label className="ui-check">
        <input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
        Connettore attivo
      </label>
      <div className="ui-grid-form">
        <Field label="Indirizzo UISP">
          <input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://uisp.esempio.it" inputMode="url" autoComplete="off" />
        </Field>
        <Field label="Token API" hint="Da UISP → Settings → Users → API tokens (lettura/scrittura).">
          <input type="password" autoComplete="off" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} placeholder={u.tokenSet ? `Impostato (${u.tokenHint}): lascia vuoto per non cambiarlo` : 'Token API di UISP'} />
        </Field>
        <Field label="Chiave app CRM di UISP" hint="UISP → Impostazioni → Sicurezza → App keys, lettura e scrittura. Serve per creare il subscriber quando si accetta una CPE.">
          <input type="password" autoComplete="off" value={f.crmKey} onChange={(e) => setF({ ...f, crmKey: e.target.value })} placeholder={u.crmKeySet ? 'Impostata: lascia vuoto per non cambiarla' : 'Non impostata'} />
        </Field>
        <Field label="Raggio copertura (km)">
          <input type="number" min={1} max={100} value={f.radius} onChange={(e) => setF({ ...f, radius: e.target.value })} />
        </Field>
        <Field label="Cache dati UISP (secondi)">
          <input type="number" min={5} max={3600} value={f.cache} onChange={(e) => setF({ ...f, cache: e.target.value })} />
        </Field>
      </div>
      <p className="ui-muted ui-small cn-p">API usate: /nms/api/v2.1 (UISP 1.x–3.x, verificato sulla specifica UISP API 1.5.0).</p>
      <label className="ui-check">
        <input type="checkbox" checked={f.ignoreTls} onChange={(e) => setF({ ...f, ignoreTls: e.target.checked })} />
        Ignora verifica TLS (certificato autofirmato)
      </label>
      {f.ignoreTls && <Notice tone="warn">Con la verifica TLS disattivata il server accetta qualsiasi certificato da UISP: usala solo se UISP è raggiungibile su una rete di gestione fidata (es. certificato autofirmato interno).</Notice>}
      <label className="ui-check">
        <input type="checkbox" checked={f.autoBackup} onChange={(e) => setF({ ...f, autoBackup: e.target.checked })} />
        Backup automatico della CPE dopo «Accetta in UISP»
      </label>
      <div className="ui-row">
        <AsyncButton onClick={runTest} onError={fail}>
          Testa connessione
        </AsyncButton>
        <AsyncButton variant="primary" onClick={save} onError={fail}>
          Salva
        </AsyncButton>
        {u.source === 'console' && (
          <AsyncButton variant="danger" onClick={reset} onError={fail}>
            Rimuovi configurazione
          </AsyncButton>
        )}
      </div>
      {test?.loading && <p className="ui-muted ui-small cn-p">Test in corso…</p>}
      {test?.error && <Notice tone="bad">{test.error}</Notice>}
      {r &&
        (r.ok ? (
          <>
            <Notice tone="good">
              Connessione riuscita{r.version ? ` · UISP ${r.version}` : ''}
              {r.deployment ? ` (${r.deployment})` : ''} · {r.latencyMs} ms
            </Notice>
            <section className="ui-stats" aria-label="UISP">
              <Stat label="dispositivi" value={r.devices} />
              <Stat label="AP (PtMP)" value={r.aps} />
              <Stat label="AP con posizione" value={r.apsWithLocation} />
              {r.ptpLinks != null && <Stat label="link PtP (esclusi dalla copertura)" value={r.ptpLinks} />}
              <Stat label="in attesa di accettazione" value={r.pending} />
              <Stat label="site" value={r.sites} />
            </section>
            {r.crm && (
              <Notice tone={r.crm.ok ? 'good' : 'bad'}>
                CRM di UISP:{' '}
                {r.crm.ok ? `chiave valida, ${r.crm.plans} ${r.crm.plans === 1 ? 'piano di servizio' : 'piani di servizio'}${r.crm.plans ? '' : ' (creane uno in UISP per i nuovi subscriber)'}` : (ERRORS[r.crm.error ?? ''] ?? r.crm.error)}
              </Notice>
            )}
            {(r.aps ?? 0) > (r.apsWithLocation ?? 0) && <p className="ui-muted ui-small cn-p">{(r.aps ?? 0) - (r.apsWithLocation ?? 0)} AP senza coordinate (né sul dispositivo né sul site): non compariranno nella Copertura.</p>}
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

interface GeoStatus {
  ok: boolean;
  local?: boolean;
  latencyMs: number;
  version?: string;
  dataUpdated?: string | null;
  message?: string;
}

/** OpenStreetMap (Nominatim): the local container of the stack, with an optional public fallback. */
function GeocoderCard({ g }: { g: Geocoder }) {
  const [r, setR] = useState<{ primary: GeoStatus; fallback?: GeoStatus | null } | null>(null);
  const line = (title: string, st: GeoStatus, primary: boolean) => (
    <Notice tone={st.ok ? 'good' : 'warn'} title={`${title} · ${st.ok ? 'operativo' : 'non disponibile'} · ${st.latencyMs} ms`}>
      {[st.version ? `Nominatim ${st.version}` : '', st.dataUpdated ? `dati aggiornati al ${date(st.dataUpdated)}` : ''].filter(Boolean).join(' · ')}
      {!st.ok && <div className="ui-small">{primary && st.local ? `${st.message}: se è appena stato installato, l’import dei dati OSM è probabilmente ancora in corso (sudo cdanet-cpe geocoder).` : st.message}</div>}
    </Notice>
  );
  return (
    <Card title="OpenStreetMap (ricerca indirizzi)" actions={<Badge tone={g.local ? 'good' : 'warn'}>{g.local ? 'locale' : 'pubblico'}</Badge>}>
      <p className="ui-muted ui-small cn-p">Converte un indirizzo in coordinate per Copertura e provisioning.</p>
      <p className="ui-muted ui-small cn-p">
        {g.local
          ? `Nominatim gira nello stesso server (container «nominatim»): gli indirizzi cercati non escono dalla rete.${g.fallbackUrl ? ' Se il servizio locale non risponde (es. durante il primo import) si usa la riserva.' : ''}`
          : 'Servizio pubblico di OpenStreetMap: riceve solo l’indirizzo cercato, massimo 1 richiesta al secondo. Per averlo in locale: sudo CDANET_GEOCODER=local ./deploy/install-debian.sh'}
      </p>
      <dl className="ui-facts">
        <div>
          <dt>Servizio</dt>
          <dd className="ui-mono">{g.url}</dd>
        </div>
        <div>
          <dt>Riserva</dt>
          <dd className="ui-mono">{g.fallbackUrl || '—'}</dd>
        </div>
        {!g.local && (
          <div>
            <dt>Contatto</dt>
            <dd>{g.contact || '—'}</dd>
          </div>
        )}
      </dl>
      <div className="ui-row">
        <AsyncButton
          onClick={async () => {
            setR(await api('/api/admin/connectors/geocoder/test', { method: 'POST', body: {} }));
          }}
          onError={fail}
        >
          Verifica servizio
        </AsyncButton>
      </div>
      {r && (
        <>
          {line(r.primary.local ? 'Nominatim locale' : 'Servizio pubblico', r.primary, true)}
          {r.fallback && line('Riserva', r.fallback, false)}
        </>
      )}
    </Card>
  );
}
