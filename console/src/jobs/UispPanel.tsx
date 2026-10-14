import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from '../lib/toast';
import { isOn } from '../lib/modules';
import { api, download } from '../lib/api';
import { AsyncButton, Button, Notice, Segmented, Skeleton, Stat, Table } from '../ui';
import { NewSubscriber, type SubscriberDraft } from './NewSubscriber';
import { SignalChart, type SignalStats } from './SignalChart';

/**
 * The network side of a provisioning (job detail): the CPE as UISP sees it, its acceptance into a
 * site (or, with the UISP CRM key, as a new subscriber), the backups, the comparison with the
 * template and the signal over time. Installers see the same state without the data source and
 * without the actions.
 */

const ERRORS: Record<string, string> = {
  uisp_not_configured: 'UISP non configurato: impostalo in Connettori.',
  uisp_tls_error: 'Certificato TLS di UISP non valido: valuta «Ignora verifica TLS» in Connettori.',
  uisp_unreachable: 'UISP non raggiungibile dal server.',
  uisp_auth_failed: 'Token UISP rifiutato: verifica il token e i suoi permessi.',
  uisp_device_not_found: 'La CPE non è ancora comparsa in UISP: attendi che si colleghi dopo il riavvio e riprova.',
  uisp_already_authorized: 'La CPE è già stata accettata in UISP.',
  uisp_site_unknown: 'Non riesco a determinare il site dell’AP: sceglilo qui sotto.',
};
const errText = (e: unknown) => ERRORS[(e as { body?: { error?: string } }).body?.error ?? ''] ?? (e as Error).message;
const fail = (e: unknown) => toast(errText(e), 'bad');
const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');

interface State {
  configured: boolean;
  device?: { name?: string; mac: string; authorized: boolean; status: string; signal?: number | null; apName?: string | null; firmware?: string | null } | null;
  site?: string | null;
  proposedSite?: { id: string; name: string } | null;
  authorizedAt?: string | null;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Job = Record<string, any> & { id: string };

export function UispPanel({ job, admin }: { job: Job; admin: boolean }) {
  const q = useQuery({ queryKey: ['jobs', job.id, 'uisp'], queryFn: () => api<State>(`/api/provisioning/jobs/${job.id}/uisp`), retry: false });
  const [sites, setSites] = useState<Array<{ id: string; name: string }> | null>(null);
  const [site, setSite] = useState('');
  const [drift, setDrift] = useState(false);
  const [backupsRev, setBackupsRev] = useState(0);
  const [newSub, setNewSub] = useState(false);
  const s = q.data;
  const waiting = admin && !!s?.device && !s.device.authorized;
  // with the UISP CRM key the CPE can be accepted as a new subscriber (the form starts from this draft)
  const draft = useQuery({ queryKey: ['jobs', job.id, 'uisp-subscriber'], queryFn: () => api<SubscriberDraft>(`/api/admin/provisioning/jobs/${job.id}/uisp/subscriber`), enabled: waiting, retry: false, staleTime: 60_000 });
  const crm = waiting && !!draft.data?.crm;

  if (q.error) return <Notice tone="bad">{errText(q.error)}</Notice>;
  if (!s) return <Skeleton lines={3} />;
  if (!s.configured) return <p className="ui-muted ui-small">{admin ? 'Integrazione UISP non configurata.' : 'Stato di rete non disponibile.'}</p>;
  const d = s.device;
  if (!d) {
    return (
      <>
        <Notice tone="warn">{admin ? 'CPE non ancora presente in UISP (ricerca per MAC). Dopo il riavvio può servire qualche minuto.' : 'CPE non ancora vista in rete. Dopo il riavvio può servire qualche minuto.'}</Notice>
        <div className="ui-row">
          <AsyncButton icon="refresh" onClick={() => q.refetch()} onError={fail}>
            Ricontrolla
          </AsyncButton>
        </div>
      </>
    );
  }
  const pending = !d.authorized;

  const accept = async () => {
    let siteId: string | undefined;
    if (s.proposedSite) {
      if (!confirm(`Accettare ${d.name || d.mac} in UISP nel site «${s.proposedSite.name}» (site dell’AP agganciato)?`)) return;
    } else {
      if (!sites) {
        setSites(await api<Array<{ id: string; name: string }>>('/api/admin/uisp/sites'));
        return;
      }
      if (!site) throw new Error('Scegli il site');
      siteId = site;
    }
    const r = await api<{ site: string; backup?: string }>(`/api/admin/provisioning/jobs/${job.id}/uisp/authorize`, { method: 'POST', body: siteId ? { siteId } : {} });
    toast(`CPE accettata nel site ${r.site}${r.backup === 'created' ? ' · backup avviato' : r.backup === 'failed' ? ' · backup non riuscito' : ''}`);
    setSites(null);
    await q.refetch();
  };
  const backupNow = async () => {
    await api(`/api/admin/provisioning/jobs/${job.id}/uisp/backups`, { method: 'POST', body: {} });
    toast('Backup richiesto a UISP');
    setTimeout(() => setBackupsRev((n) => n + 1), 3000);
  };

  return (
    <div className="jb-uisp">
      <section className="ui-stats" aria-label="Stato in rete">
        <Stat label={admin ? 'UISP' : 'rete'} value={<span className="ac-date">{pending ? 'In attesa di accettazione' : 'Accettata'}</span>} />
        <Stat label="stato" value={<span className="ac-date">{d.status === 'active' ? 'online' : d.status}</span>} />
        <Stat label="segnale" value={<span className="ac-date">{d.signal != null ? `${d.signal} dBm` : '—'}</span>} />
        <Stat label="AP" value={<span className="ac-date">{d.apName ?? '—'}</span>} />
        <Stat label="site" value={<span className="ac-date">{s.site ?? (pending && s.proposedSite ? `${s.proposedSite.name} (proposto)` : '—')}</span>} />
        <Stat label="firmware" value={<span className="ac-date">{d.firmware || '—'}</span>} />
      </section>
      {!pending && s.authorizedAt && <p className="ui-muted ui-small jb-p">Accettata il {date(s.authorizedAt)}</p>}
      {admin && pending && sites && !s.proposedSite && (
        <label className="ui-field">
          <span className="ui-field-label">Site dell’AP non determinabile: scegli il site</span>
          <select value={site} onChange={(e) => setSite(e.target.value)}>
            <option value="">—</option>
            {sites.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="ui-row">
        <AsyncButton icon="refresh" onClick={() => Promise.all([q.refetch(), waiting ? draft.refetch() : null])} onError={fail}>
          Aggiorna
        </AsyncButton>
        {crm && !newSub && (
          <Button variant="primary" onClick={() => setNewSub(true)}>
            Nuovo subscriber
          </Button>
        )}
        {admin && pending && !newSub && (
          <AsyncButton variant={crm ? 'secondary' : 'primary'} onClick={accept} onError={fail}>
            {sites && !s.proposedSite ? 'Accetta nel site scelto' : crm ? 'Accetta nel site dell’AP' : 'Accetta in UISP'}
          </AsyncButton>
        )}
        {admin && !pending && (
          <AsyncButton onClick={backupNow} onError={fail}>
            Backup ora
          </AsyncButton>
        )}
        {admin && !pending && isOn('config_drift') && <Button onClick={() => setDrift(true)}>Confronta con il template</Button>}
      </div>
      {crm && newSub && draft.data && (
        <NewSubscriber
          jobId={job.id}
          draft={draft.data}
          onCancel={() => setNewSub(false)}
          onDone={async () => {
            setNewSub(false);
            await q.refetch();
          }}
        />
      )}
      {!pending && isOn('signal_history') && <SignalHistory job={job} admin={admin} />}
      {drift && <Drift job={job} />}
      {admin && !pending && <Backups job={job} rev={backupsRev} />}
    </div>
  );
}

interface DriftData {
  backup: { timestamp: string };
  template: string;
  compared: number;
  skipped: number;
  extra: number;
  items: Array<{ key: string; kind: string; expected?: string | null; actual?: string | null }>;
}

/** The configuration of the CPE (last UISP backup) against its template. */
function Drift({ job }: { job: Job }) {
  const q = useQuery({ queryKey: ['jobs', job.id, 'drift'], queryFn: () => api<DriftData>(`/api/admin/provisioning/jobs/${job.id}/uisp/drift`), retry: false });
  const KIND: Record<string, string> = { changed: 'modificata', missing: 'assente sulla CPE', secret_changed: 'segreto diverso (valore non mostrato)' };
  if (q.error) return <Notice tone="bad">{errText(q.error)}</Notice>;
  if (!q.data) return <Skeleton lines={3} />;
  const r = q.data;
  return (
    <section className="jb-sec">
      <h3>Configurazione rispetto al template</h3>
      <p className="ui-muted ui-small jb-p">
        Backup UISP del {date(r.backup.timestamp)} · template «{r.template}» · {r.compared} chiavi confrontate, {r.skipped} non confrontabili (password), {r.extra} chiavi in più sulla CPE.
      </p>
      {r.items.length ? (
        <Table
          rows={r.items}
          rowKey={(i) => i.key}
          columns={[
            { label: 'Chiave', render: (i) => <span className="ui-mono ui-small">{i.key}</span> },
            { label: 'Differenza', render: (i) => KIND[i.kind] ?? i.kind },
            { label: 'Atteso', render: (i) => <span className="ui-mono ui-small">{i.expected ?? '—'}</span> },
            { label: 'Sulla CPE', render: (i) => <span className="ui-mono ui-small">{i.actual ?? '—'}</span> },
          ]}
        />
      ) : (
        <Notice tone="good">Nessuna differenza: la CPE ha la configurazione CDA Net.</Notice>
      )}
      <p className="ui-muted ui-small jb-p">Per un confronto aggiornato premi prima «Backup ora» e attendi qualche secondo.</p>
    </section>
  );
}

/** The backups UISP keeps of the CPE, to download. */
function Backups({ job, rev }: { job: Job; rev: number }) {
  const q = useQuery({ queryKey: ['jobs', job.id, 'backups', rev], queryFn: () => api<Array<{ id: string; timestamp: string; extension?: string }>>(`/api/admin/provisioning/jobs/${job.id}/uisp/backups`), retry: false });
  return (
    <section className="jb-sec">
      <h3>Backup in UISP</h3>
      {q.error ? (
        <p className="ui-muted ui-small">Backup non disponibili: {errText(q.error)}</p>
      ) : !q.data ? (
        <Skeleton lines={2} />
      ) : (
        <Table
          rows={q.data}
          rowKey={(b) => b.id}
          empty="Nessun backup."
          columns={[
            { label: 'Data', render: (b) => date(b.timestamp) },
            {
              label: '',
              end: true,
              render: (b) => (
                <AsyncButton variant="ghost" onClick={() => download(`/api/admin/provisioning/jobs/${job.id}/uisp/backups/${encodeURIComponent(b.id)}`, `backup-${b.id}.${b.extension || 'cfg'}`)} onError={fail}>
                  Scarica
                </AsyncButton>
              ),
            },
          ]}
        />
      )}
    </section>
  );
}

type Range = 'day' | 'week' | 'month';
interface Stats extends SignalStats {
  downlinkCapacity: { avg?: number | null };
  uplinkCapacity: { avg?: number | null };
  outages?: Array<{ start: string; end?: string | null; inProgress?: boolean; type: string }> | null;
}

/** "Storico segnale": sudden failure or slow degradation, from the statistics and the outages. */
function SignalHistory({ job, admin }: { job: Job; admin: boolean }) {
  const [range, setRange] = useState<Range>('week');
  const q = useQuery({ queryKey: ['jobs', job.id, 'stats', range], queryFn: () => api<Stats>(`/api/provisioning/jobs/${job.id}/uisp/statistics?range=${range}`), retry: false });
  const st = q.data;
  const s = st?.signal;
  return (
    <section className="jb-sec">
      <h3>{admin ? 'Storico segnale (UISP)' : 'Storico segnale'}</h3>
      <Segmented
        label="Periodo"
        value={range}
        onChange={setRange}
        options={[
          { value: 'day', label: 'Giorno' },
          { value: 'week', label: 'Settimana' },
          { value: 'month', label: 'Mese' },
        ]}
      />
      {q.error ? (
        <p className="ui-muted ui-small">Storico non disponibile: {errText(q.error)}</p>
      ) : !st || !s ? (
        <Skeleton lines={4} />
      ) : (
        <>
          <SignalChart st={st} admin={admin} />
          <p className="ui-muted ui-small jb-p">Linea piena: segnale ricevuto dalla CPE · tratteggio: segnale lato AP.</p>
          <dl className="ui-facts">
            <div>
              <dt>Segnale min / medio / max</dt>
              <dd>{s.avg != null ? `${s.min} / ${s.avg} / ${s.max} dBm` : '—'}</dd>
            </div>
            <div>
              <dt>Lato AP medio</dt>
              <dd>{st.remoteSignal.avg != null ? `${st.remoteSignal.avg} dBm` : '—'}</dd>
            </div>
            <div>
              <dt>Capacità media</dt>
              <dd>{st.downlinkCapacity.avg != null ? `${Math.round(st.downlinkCapacity.avg / 1000)} / ${Math.round((st.uplinkCapacity.avg ?? 0) / 1000)} Mbit/s` : '—'}</dd>
            </div>
            <div>
              <dt>Interruzioni</dt>
              <dd>{st.outages == null ? '—' : st.outages.length}</dd>
            </div>
          </dl>
          {s.trend != null && s.trend <= -4 && <Notice tone="warn">Segnale calato di {Math.abs(s.trend)} dB nel periodo: degrado lento (vegetazione, antenna spostata, staffa allentata).</Notice>}
          {s.trend != null && s.trend >= 4 && <Notice tone="good">Segnale migliorato di {s.trend} dB nel periodo.</Notice>}
          {!!st.outages?.length && (
            <ul className="ui-list ui-small">
              {st.outages.slice(0, 10).map((o, i) => (
                <li key={i}>
                  {date(o.start)} → {o.inProgress ? 'in corso' : date(o.end)} · {o.type === 'unreachable' ? 'non raggiungibile' : 'offline'}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
