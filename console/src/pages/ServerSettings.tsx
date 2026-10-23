import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState } from 'react';
import { toast } from '../lib/toast';
import { api } from '../lib/api';
import { AsyncButton, Badge, Card, Field, Notice, PageHeader, Skeleton } from '../ui';

/**
 * Impostazioni server (admins): the .env parameters editable from the console, so that no SSH
 * access is needed; they win over the file. Secrets are write-only: only whether they are set is
 * shown. Also the antenna heights for the pointing in the app, and the infrastructure (address,
 * HTTPS, updates, maps) applied by the server's update agent.
 */

type Tone = 'good' | 'warn' | 'bad' | 'neutral';
const SOURCE: Record<string, [string, Tone]> = { web: ['impostato dal web', 'good'], env: ['da .env', 'neutral'], default: ['predefinito', 'neutral'] };

interface Setting {
  key: string;
  group: string;
  label: string;
  env: string;
  kind: 'bool' | 'secret' | 'int' | 'text';
  value: string | number | boolean | null;
  envValue?: string | null;
  isSet?: boolean;
  min?: number;
  max?: number;
  help?: string;
  restart?: boolean;
  source: 'web' | 'env' | 'default';
}
interface Settings {
  settings: Setting[];
  updatedAt?: string | null;
  updatedBy?: string | null;
  restartNeeded?: string[];
}

const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const fail = (e: unknown) => toast((e as Error).message, 'bad');
const KEY = ['admin', 'server-settings'];

export function ServerSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: () => api<Settings>('/api/admin/server-settings') });
  const [restart, setRestart] = useState<string[]>([]);
  const apply = (r: Settings) => {
    qc.setQueryData(KEY, r);
    setRestart(r.restartNeeded ?? []);
  };
  const d = q.data;
  const groups = d ? [...new Set(d.settings.map((s) => s.group))] : [];
  return (
    <div className="ui-page">
      <PageHeader icon="dns" title="Impostazioni server" subtitle="Parametri del server modificabili da qui senza accedere al server: hanno la precedenza sul file .env. Le password non vengono mai mostrate." />
      {restart.length > 0 && (
        <Notice tone="warn" title="Serve un riavvio dell’app">
          <p className="ss-p">Valgono dopo un riavvio: {restart.join(', ')}.</p>
          <AsyncButton
            variant="primary"
            onClick={async () => {
              await api('/api/admin/server-settings/restart', { method: 'POST', body: {} });
              toast('Riavvio in corso: la console torna disponibile tra qualche secondo');
              setTimeout(() => location.reload(), 8000);
            }}
            onError={fail}
          >
            Riavvia l’app ora
          </AsyncButton>
        </Notice>
      )}
      {q.error && <Notice tone="bad">{(q.error as Error).message}</Notice>}
      {!d && !q.error && <Skeleton lines={10} />}
      {d && (
        <>
          {d.updatedAt && (
            <p className="ui-muted ui-small ss-p">
              Ultima modifica {date(d.updatedAt)}
              {d.updatedBy ? ` da ${d.updatedBy}` : ''}.
            </p>
          )}
          {groups.map((g) => (
            <SettingsGroup key={`${g}-${d.updatedAt ?? ''}`} title={g} settings={d.settings.filter((s) => s.group === g)} onSaved={apply} />
          ))}
        </>
      )}
      <PointingCard />
      <InfraCard />
      <Card title="Restano nel file .env">
        <p className="ui-muted ui-small ss-p">Solo i segreti di base (JWT_SECRET, chiave master) e il geocoder OpenStreetMap: non si cambiano dal web per sicurezza.</p>
      </Card>
    </div>
  );
}

/** One group of settings, saved together: only what changed is sent. */
function SettingsGroup({ title, settings, onSaved }: { title: string; settings: Setting[]; onSaved: (r: Settings) => void }) {
  const initial = () => Object.fromEntries(settings.map((s) => [s.key, s.kind === 'bool' ? !!s.value : s.kind === 'secret' ? '' : String(s.value ?? '')]));
  const [v, setV] = useState<Record<string, string | boolean>>(initial);
  const save = async () => {
    const values: Record<string, unknown> = {};
    for (const s of settings) {
      const now = v[s.key];
      if (s.kind === 'bool') {
        if (now !== !!s.value) values[s.key] = now;
      } else if (s.kind === 'secret') {
        if (now) values[s.key] = now;
      } else if (s.kind === 'int') {
        const n = Number(now);
        if (now !== '' && n !== s.value) values[s.key] = n;
      } else if (String(now).trim() !== String(s.value ?? '')) {
        values[s.key] = String(now).trim();
      }
    }
    if (values.CROWDSEC === '1' && !confirm('Attivare CrowdSec? Il server scarica il suo container (circa 170 MB) e le regole; poi blocca gli indirizzi che attaccano il server e quelli della lista della comunità CrowdSec, alla quale invia indirizzo e tipo degli attacchi visti qui (mai il contenuto delle richieste). Blocchi ed eccezioni: pagina Accessi bloccati.')) return;
    if (!Object.keys(values).length) throw new Error('Nessuna modifica');
    const r = await api<Settings>('/api/admin/server-settings', { method: 'PUT', body: { values } });
    toast(`${title}: impostazioni salvate`);
    onSaved(r);
  };
  const resetToEnv = async (s: Setting) => {
    const r = await api<Settings>('/api/admin/server-settings', { method: 'PUT', body: { values: { [s.key]: null } } });
    toast(`${s.label}: valore del .env ripristinato`);
    onSaved(r);
  };
  return (
    <Card title={title}>
      {title === 'Credenziali delle CPE' && (
        <Notice tone="info">Rete, DHCP, PPPoE, porte, NTP, watchdog, SNMP e chiave UISP delle CPE non sono più impostazioni del server: ogni template ha i suoi, in Profili airOS.</Notice>
      )}
      <div className="ss-list">
        {settings.map((s) => {
          const meta: ReactNode = (
            <span className="ss-meta">
              <Badge tone={SOURCE[s.source]![1]}>{SOURCE[s.source]![0]}</Badge>
              <span className="ui-mono">{s.env}</span>
              {s.restart && <span>richiede riavvio</span>}
              {s.kind === 'secret' && <span>{s.isSet ? 'impostata' : 'non impostata'}</span>}
              {s.source === 'web' && (
                <AsyncButton variant="ghost" className="ss-reset" onClick={() => resetToEnv(s)} onError={fail}>
                  Ripristina .env
                </AsyncButton>
              )}
            </span>
          );
          return (
            <div key={s.key} className="ss-item">
              {s.kind === 'bool' ? (
                <label className="ui-check">
                  <input type="checkbox" checked={!!v[s.key]} onChange={(e) => setV({ ...v, [s.key]: e.target.checked })} />
                  {s.label}
                </label>
              ) : (
                <Field label={s.label}>
                  {s.kind === 'secret' ? (
                    <input type="password" autoComplete="new-password" value={String(v[s.key])} onChange={(e) => setV({ ...v, [s.key]: e.target.value })} placeholder={s.isSet ? 'impostata · scrivi per cambiarla' : 'non impostata'} />
                  ) : (
                    <input
                      type={s.kind === 'int' ? 'number' : 'text'}
                      min={s.kind === 'int' ? s.min : undefined}
                      max={s.kind === 'int' ? s.max : undefined}
                      step={s.kind === 'int' ? 1 : undefined}
                      value={String(v[s.key])}
                      onChange={(e) => setV({ ...v, [s.key]: e.target.value })}
                      placeholder={s.envValue != null ? `.env: ${s.envValue}` : ''}
                    />
                  )}
                </Field>
              )}
              {meta}
              {s.help && <p className="ui-muted ui-small ss-p">{s.help}</p>}
            </div>
          );
        })}
      </div>
      <div className="ui-row">
        <AsyncButton variant="primary" onClick={save} onError={fail}>
          Salva
        </AsyncButton>
      </div>
    </Card>
  );
}

interface Pointing {
  apHeightM: number;
  cpeHeightM: number;
  dem: boolean;
  apSources?: { total: number; siteHeight: number; gps: number; fallback: string[] } | null;
}

/** Antenna heights for the tilt in the app ("Trova l'AP") and the default CPE height. */
function PointingCard() {
  const q = useQuery({ queryKey: ['admin', 'pointing', 'config'], queryFn: () => api<Pointing>('/api/admin/pointing/config') });
  const [edit, setEdit] = useState<{ ap: string; cpe: string } | null>(null);
  const c = q.data;
  if (!c) return null;
  const f = edit ?? { ap: String(c.apHeightM), cpe: String(c.cpeHeightM) };
  const src = c.apSources;
  return (
    <Card title="Puntamento nell’app">
      <p className="ui-muted ui-small ss-p">Per tilt, visibilità e segnale verso un AP servono l’altitudine dell’AP e quella della CPE. Il terreno viene dal modello SRTM (scaricato dal server solo per le zone usate).</p>
      <ul className="ui-list ui-small">
        <li>
          <strong>AP:</strong> si usa prima l’altezza del suo sito in UISP sopra il terreno; se manca, l’altitudine GPS dell’AP in UISP (scartata se lo mette a più di 60 m dal suolo: l’errore verticale del GPS arriva a decine di metri). Solo se UISP non ha nessuno dei due vale l’altezza antenne qui sotto: non si somma mai ai dati di UISP.
        </li>
        <li>
          <strong>CPE:</strong> terreno più l’altezza dal suolo. Quella qui sotto è solo il valore di partenza: il tecnico la cambia nell’app per ogni installazione.
        </li>
      </ul>
      <div className="ui-grid-form">
        <Field label="Altezza antenne AP (m dal suolo)" hint="Solo per gli AP senza altitudine in UISP.">
          <input type="number" min={0} max={200} step={1} value={f.ap} onChange={(e) => setEdit({ ...f, ap: e.target.value })} />
        </Field>
        <Field label="Altezza CPE di partenza (m dal suolo)">
          <input type="number" min={0} max={100} step={0.5} value={f.cpe} onChange={(e) => setEdit({ ...f, cpe: e.target.value })} />
        </Field>
      </div>
      {!src ? (
        <p className="ui-muted ui-small ss-p">UISP non collegato: non si sa quanti AP usano questo valore.</p>
      ) : (
        <div className="ui-small">
          <p className="ss-p">
            Su {src.total} AP: {src.siteHeight} con l’altezza del sito in UISP, {src.gps} solo con l’altitudine GPS, <strong>{src.fallback.length} senza nessuno dei due</strong>
            {src.fallback.length ? ': per questi vale l’altezza impostata qui.' : ': l’altezza impostata qui oggi non viene usata.'}
          </p>
          {src.fallback.length > 0 && (
            <details className="ui-details">
              <summary>Vedi i {src.fallback.length} AP senza altitudine (completala in UISP per non usare il valore qui)</summary>
              <p className="ui-muted ss-p">{src.fallback.join(', ')}</p>
            </details>
          )}
        </div>
      )}
      {!c.dem && <Notice tone="warn">Modello del terreno disattivato (DEM_URL vuoto): il tilt non viene calcolato.</Notice>}
      <div className="ui-row">
        <AsyncButton
          variant="primary"
          disabled={!edit}
          onClick={async () => {
            await api('/api/admin/pointing/config', { method: 'PUT', body: { apHeightM: Number(f.ap) || 0, cpeHeightM: Number(f.cpe) || 0 } });
            toast('Altezze salvate');
            setEdit(null);
            await q.refetch();
          }}
          onError={fail}
        >
          Salva
        </AsyncButton>
      </div>
    </Card>
  );
}

const REGIONS: Array<[string, string]> = [
  ['sicilia', 'Sicilia'],
  ['isole', 'Sicilia e Sardegna'],
  ['sud', 'Sud'],
  ['centro', 'Centro'],
  ['nord-est', 'Nord-Est'],
  ['nord-ovest', 'Nord-Ovest'],
  ['italia', 'Tutta Italia (file grande)'],
  ['custom', 'Area personalizzata'],
];
const RESULT: Record<string, [string, Tone]> = { ok: ['applicato', 'good'], error: ['errore', 'bad'], running: ['in corso', 'warn'] };
const LABELS: Record<string, string> = {
  APP_LISTEN: 'Indirizzo della console',
  HTTPS_SITES: 'Indirizzi HTTPS autofirmati',
  UPDATE_INTERVAL: 'Intervallo di controllo (s)',
  UPDATE_WINDOW: 'Finestra oraria',
  CDANET_CHANNEL: 'Canale / versione',
  MAP_MODE: 'Tipo di mappa',
  MAP_REGION: 'Regione',
  MAP_BBOX: 'Area (minLon,minLat,maxLon,maxLat)',
  NOMINATIM_REGION: 'Regione OpenStreetMap',
};
const HELP: Record<string, string> = {
  APP_LISTEN: ':80 = HTTP sulla rete; un nome (es. cpe.esempio.it) attiva HTTPS automatico con certificato pubblico.',
  HTTPS_SITES: 'HTTPS con certificato autofirmato su questi indirizzi, separati da spazio.',
  UPDATE_INTERVAL: 'Secondi tra un controllo e l’altro (minimo 60).',
  UPDATE_WINDOW: 'Ore in cui sono ammessi gli aggiornamenti; vuoto = sempre.',
  CDANET_CHANNEL: '«stable» segue le nuove versioni; un numero (es. 1.26.0) blocca quella versione.',
  MAP_REGION: 'Cambiando area la mappa viene riscaricata (qualche minuto).',
  NOMINATIM_REGION: 'Area degli indirizzi cercati sul server. Cambiandola i dati vengono reimportati da zero (RAM e disco: Sicilia ~3 GB / 15 GB, Italia ~8 GB / 90 GB).',
};
const PLACEHOLDER: Record<string, string> = { APP_LISTEN: ':80', HTTPS_SITES: 'https://192.0.2.10 https://10.0.0.10', UPDATE_WINDOW: 'sempre (es. 02-05 = dalle 2 alle 5)', CDANET_CHANNEL: 'stable', MAP_BBOX: 'minLon,minLat,maxLon,maxLat' };

interface Infra {
  values: Record<string, string | undefined>;
  agent: boolean;
  pending: boolean;
  stale?: boolean;
  status?: { result: string; at: string; message: string } | null;
  geocoderMode?: string;
}

/**
 * Infrastructure (address/HTTPS, auto-update, maps): applied by the update agent of the server,
 * which receives the request, updates .env and restarts what is needed. One request at a time:
 * the form waits until the agent reports the outcome.
 */
function InfraCard() {
  const qc = useQueryClient();
  const key = ['admin', 'infra'];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api<Infra>('/api/admin/infra'),
    refetchInterval: (query) => (query.state.data?.pending || query.state.data?.status?.result === 'running' ? 4000 : false),
  });
  const d = q.data;
  const [f, setF] = useState<Record<string, string>>({});
  // the form follows the server's values each time they change
  useEffect(() => {
    if (!d) return;
    const v = d.values;
    setF({
      APP_LISTEN: v.APP_LISTEN ?? '',
      HTTPS_SITES: v.HTTPS_SITES ?? '',
      AUTOUPDATE: (v.AUTOUPDATE ?? '1') !== '0' ? '1' : '0',
      UPDATE_INTERVAL: v.UPDATE_INTERVAL || '300',
      UPDATE_WINDOW: v.UPDATE_WINDOW ?? '',
      CDANET_CHANNEL: v.CDANET_CHANNEL ?? '',
      MAP_MODE: v.MAP_MODE ?? 'local',
      MAP_REGION: v.MAP_REGION ?? REGIONS[0]![0],
      MAP_BBOX: v.MAP_BBOX ?? '',
      NOMINATIM_REGION: v.NOMINATIM_REGION ?? REGIONS[0]![0],
      CROWDSEC: v.CROWDSEC === '1' ? '1' : '0',
    });
  }, [d]);

  if (q.error)
    return (
      <Card title="Infrastruttura">
        <Notice tone="bad">{(q.error as Error).message}</Notice>
      </Card>
    );
  if (!d || !f.MAP_MODE) return null;
  const osmLocal = d.geocoderMode === 'local';
  const locked = !d.agent || d.pending || d.status?.result === 'running';
  const groups: Array<[string, string[]]> = [
    ['Indirizzo e HTTPS', ['APP_LISTEN', 'HTTPS_SITES']],
    ['Aggiornamenti automatici', ['AUTOUPDATE', 'UPDATE_INTERVAL', 'UPDATE_WINDOW', 'CDANET_CHANNEL']],
    ['Mappe della console', ['MAP_MODE', 'MAP_REGION', 'MAP_BBOX']],
    ['OpenStreetMap locale (ricerca indirizzi)', osmLocal ? ['NOMINATIM_REGION'] : []],
    ['Protezione (CrowdSec)', ['CROWDSEC']],
  ];
  const set = (k: string, val: string) => setF({ ...f, [k]: val });

  const send = async (values: Record<string, string>, action?: string) => {
    try {
      const r = await api<Infra>('/api/admin/infra', { method: 'PUT', body: { values, ...(action ? { action } : {}) } });
      toast('Richiesta inviata al server: viene applicata entro pochi secondi');
      qc.setQueryData(key, r);
    } catch (e) {
      const err = e as Error & { body?: { key?: string } };
      throw err.body?.key ? new Error(`${err.message}: ${err.body.key}`) : err;
    }
  };
  const applyChanges = async () => {
    const values: Record<string, string> = {};
    for (const [, keys] of groups)
      for (const k of keys) {
        if (k === 'MAP_BBOX' && f.MAP_REGION !== 'custom') continue;
        const now = String(f[k] ?? '').trim().replace(/\s+/g, ' ');
        if (now !== (d.values[k] ?? (k === 'AUTOUPDATE' ? '1' : k === 'CROWDSEC' ? '0' : ''))) values[k] = now;
      }
    // the self-signed certificate is issued for the first address when the browser sends no name
    if (values.HTTPS_SITES) values.HTTPS_DEFAULT_SNI = values.HTTPS_SITES.split(' ')[0]!.replace(/^https:\/\//, '');
    if (values.APP_LISTEN && !values.APP_LISTEN.startsWith(':') && !confirm(`Con un nome (${values.APP_LISTEN}) la console sulla porta 80 risponde solo a quel nome, con certificato pubblico Let’s Encrypt: il nome deve puntare a questo server e le porte 80/443 devono essere raggiungibili da Internet. Gli indirizzi HTTPS autofirmati restano attivi. Continuare?`)) return;
    if (values.NOMINATIM_REGION && !confirm(`Cambiare la regione di OpenStreetMap in «${values.NOMINATIM_REGION}»? I dati attuali vengono cancellati e reimportati: da 20 minuti a qualche ora (tutta Italia anche di più). Nel frattempo la ricerca indirizzi usa il servizio pubblico.`)) return;
    if (!Object.keys(values).length) throw new Error('Nessuna modifica');
    await send(values);
  };

  const control = (k: string): ReactNode => {
    if (k === 'AUTOUPDATE')
      return (
        <label className="ui-check" key={k}>
          <input type="checkbox" checked={f.AUTOUPDATE === '1'} disabled={locked} onChange={(e) => set(k, e.target.checked ? '1' : '0')} />
          Aggiornamenti automatici attivi
        </label>
      );
    if (k === 'CROWDSEC')
      return (
        <div key={k}>
          <label className="ui-check">
            <input type="checkbox" checked={f.CROWDSEC === '1'} disabled={locked} onChange={(e) => set(k, e.target.checked ? '1' : '0')} />
            CrowdSec attivo
          </label>
          <p className="ui-muted ui-small">Riconosce scanner e tentativi di attacco nel log del web server e blocca anche gli indirizzi segnalati dalla comunità CrowdSec. Mai bloccati: le reti fidate, chi è entrato con successo negli ultimi 30 giorni e le eccezioni della pagina Accessi bloccati.</p>
        </div>
      );
    if (k === 'MAP_BBOX' && f.MAP_REGION !== 'custom') return null;
    const select = (opts: Array<[string, string]>) => (
      <select value={f[k]} disabled={locked || (k === 'MAP_REGION' && f.MAP_MODE === 'off')} onChange={(e) => set(k, e.target.value)}>
        {opts.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    );
    return (
      <Field key={k} label={LABELS[k]!} hint={HELP[k]}>
        {k === 'MAP_MODE' ? (
          select([
            ['local', 'Mappa locale (Protomaps)'],
            ['off', 'Mappe pubbliche OpenStreetMap'],
          ])
        ) : k === 'MAP_REGION' ? (
          select(REGIONS)
        ) : k === 'NOMINATIM_REGION' ? (
          select(REGIONS.filter(([r]) => r !== 'custom'))
        ) : (
          <input type={k === 'UPDATE_INTERVAL' ? 'number' : 'text'} min={k === 'UPDATE_INTERVAL' ? 60 : undefined} max={k === 'UPDATE_INTERVAL' ? 86400 : undefined} step={k === 'UPDATE_INTERVAL' ? 60 : undefined} value={f[k]} disabled={locked} placeholder={PLACEHOLDER[k]} onChange={(e) => set(k, e.target.value)} />
        )}
      </Field>
    );
  };

  const st = d.status;
  return (
    <Card title="Infrastruttura" actions={st ? <Badge tone={RESULT[st.result]?.[1] ?? 'neutral'}>{RESULT[st.result]?.[0] ?? st.result}</Badge> : undefined}>
      <p className="ui-muted ui-small ss-p">Applicate dall’agente di aggiornamento del server (riavvia da solo i servizi interessati).</p>
      {!d.agent && <Notice tone="warn">Agente di aggiornamento non ancora attivo su questo server: si attiva con il prossimo aggiornamento automatico, oppure rieseguendo una volta l’installer.</Notice>}
      {d.stale && <Notice tone="warn">La richiesta non è stata ancora raccolta: l’agente di aggiornamento potrebbe essere fermo (sudo cdanet-cpe ps).</Notice>}
      {d.pending && !d.stale && <Notice tone="info">Richiesta in attesa di essere applicata…</Notice>}
      {st && (
        <p className="ui-small ss-p">
          {date(st.at)} · {st.message}
        </p>
      )}
      {groups.map(([title, keys]) => (
        <section key={title} className="ss-group">
          <h3>{title}</h3>
          {keys.length ? <div className="ui-grid-form">{keys.map(control)}</div> : <p className="ui-muted ui-small ss-p">Non installato su questo server: la ricerca indirizzi usa il servizio pubblico. Si installa con l’installer (CDANET_GEOCODER=local).</p>}
        </section>
      ))}
      <div className="ui-row">
        <AsyncButton variant="primary" disabled={locked} onClick={applyChanges} onError={fail}>
          Applica
        </AsyncButton>
        <AsyncButton disabled={locked || d.values.MAP_MODE === 'off'} onClick={() => send({}, 'map_update')} onError={fail}>
          Aggiorna la mappa ora
        </AsyncButton>
        {osmLocal && (
          <AsyncButton
            disabled={locked}
            onClick={async () => {
              if (!confirm('Cancellare i dati OpenStreetMap importati e rifare l’import da zero (da 20 minuti a qualche ora)? Nel frattempo la ricerca indirizzi usa il servizio pubblico.')) return;
              await send({}, 'geocoder_reimport');
            }}
            onError={fail}
          >
            Reimporta OpenStreetMap da zero
          </AsyncButton>
        )}
      </div>
    </Card>
  );
}
