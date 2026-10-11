import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { isOn } from '../../../web/js/modules.js';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { Badge, Card, Notice, PageHeader, Skeleton, Stat } from '../ui';

/** Panoramica (admins): what needs the office today, what is left to configure, the services. */

interface Status {
  version: string;
  runtimeSecrets: { cpeAdminPassword: boolean; uispEnrollment: boolean; snmpCommunity: string };
  policy: {
    cpeAdminUsername: string;
    snmpContact: string;
    network: { factoryIp: string; lanIp: string; lanNetmask: string; dhcpStart: string; dhcpEnd: string; dhcpLease: number; pppoeMtu: number; pppoeMru: number; watchdogHost: string; ntpServer: string };
    jobTtlMinutes: number;
    minAndroidVersion: string;
    auditRetentionDays: number;
  };
  today: { workOrders: number; workOrdersDone: number; workOrdersLate: number; nocPending: number; koOpen: number; jobs24h: number };
  counts: { users: number; wirelessNetworks: number; profiles: number; templates: number; jobs30d: number; success30d: number };
  androidRelease: { versionName: string; versionCode: number; sha256: string; mandatory?: boolean } | null;
  androidReleaseSync: { repo: string; everyMinutes: number } | null;
}
interface Advisor {
  at: string | null;
  critico: number;
  apsCritical: number;
  optimizations: Array<{ apName: string; state: string; startAt: string }>;
}
interface Uisp {
  configured: boolean;
  ok?: boolean;
  error?: string;
  status?: number;
  devices?: number;
  aps?: number;
  apsWithLocation?: number;
  pending?: number;
  sites?: number;
  version?: string;
}
interface Geocoder {
  primary: { ok: boolean; local: boolean; dataUpdated?: string | null };
  fallback?: { ok: boolean } | null;
}

const UISP_ERRORS: Record<string, string> = {
  uisp_tls_error: 'certificato TLS di UISP non valido',
  uisp_unreachable: 'UISP non raggiungibile dal server',
  uisp_auth_failed: 'token UISP rifiutato',
};

const go = (href: string) => () => {
  location.hash = href;
};
const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');

export function Dashboard() {
  const status = useQuery({ queryKey: ['admin', 'status'], queryFn: () => api<Status>('/api/admin/status'), refetchInterval: 60_000 });
  const profiles = useQuery({ queryKey: ['admin', 'profiles'], queryFn: () => api<Array<{ model: string; templates: unknown[] }>>('/api/admin/profiles') });
  const privacy = useQuery({ queryKey: ['admin', 'privacy'], queryFn: () => api<{ complete: boolean }>('/api/admin/privacy') });
  const advisor = useQuery({ queryKey: [...keys.advisor, 'summary'], queryFn: () => api<Advisor>('/api/admin/advisor/summary') });
  const network = useQuery({ queryKey: keys.network, queryFn: () => api<{ summary: { down: number; powerOutage: number } }>('/api/network/status'), enabled: isOn('network_status'), refetchInterval: 60_000 });
  const uisp = useQuery({ queryKey: ['admin', 'uisp', 'status'], queryFn: () => api<Uisp>('/api/admin/uisp/status').catch((e: Error): Uisp => ({ configured: true, ok: false, error: e.message })) });
  const geocoder = useQuery({ queryKey: ['admin', 'geocoder', 'test'], queryFn: () => api<Geocoder>('/api/admin/connectors/geocoder/test', { method: 'POST', body: {} }), staleTime: 5 * 60_000 });

  const s = status.data;
  if (status.error) return <Notice tone="bad">{(status.error as Error).message}</Notice>;
  if (!s) {
    return (
      <div className="ui-page">
        <PageHeader icon="home" title="Panoramica" />
        <Skeleton lines={6} />
      </div>
    );
  }

  const t = s.today;
  const net = network.data?.summary;
  const ia = advisor.data;
  const missing = (profiles.data ?? []).filter((p) => !p.templates.length).map((p) => p.model);
  const todo = [
    !s.runtimeSecrets.cpeAdminPassword && 'CPE_ADMIN_PASSWORD non configurata: il provisioning è bloccato.',
    !s.runtimeSecrets.uispEnrollment && 'UISP_ENROLLMENT non configurata: i profili che usano ${UISP_ENROLLMENT} verranno rifiutati.',
    missing.length > 0 && `Profili airOS 8.7.4 mancanti: ${missing.join(', ')}.`,
    !s.counts.wirelessNetworks && 'Nessuna chiave WPA2 configurata.',
    !s.androidRelease && 'Nessuna release Android pubblicata nel canale aggiornamenti.',
    privacy.data && !privacy.data.complete && 'Informativa privacy da completare con i dati del titolare (Amministrazione → Informativa privacy): finché manca, l’app non la fa accettare.',
  ].filter((x): x is string => !!x);
  const running = ia?.optimizations.find((r) => r.state === 'in_corso');
  const next = [...(ia?.optimizations ?? [])].sort((a, b) => a.startAt.localeCompare(b.startAt))[0];
  const n = s.policy.network;

  return (
    <div className="ui-page">
      <PageHeader icon="home" title="Panoramica" subtitle={`Server v${s.version}`} />

      <section aria-label="Oggi" className="ui-stats">
        {isOn('work_orders') && <Stat label="interventi di oggi fatti" value={`${t.workOrdersDone}/${t.workOrders}`} onClick={go('#/work-orders')} />}
        {isOn('work_orders') && t.workOrdersLate > 0 && <Stat label="interventi in ritardo" value={t.workOrdersLate} tone="bad" onClick={go('#/work-orders')} />}
        <Stat label="collaudi da approvare (NOC)" value={t.nocPending} tone={t.nocPending ? 'warn' : 'good'} onClick={go('#/jobs?status=review')} />
        <Stat label="KO o rimandi aperti" value={t.koOpen} tone={t.koOpen ? 'warn' : 'good'} onClick={go('#/jobs?status=ko')} />
        <Stat label="provisioning nelle ultime 24 ore" value={t.jobs24h} onClick={go('#/jobs')} />
        {net && <Stat label="AP non raggiungibili" value={net.down} tone={net.down ? 'bad' : 'good'} onClick={go('#/network')} />}
        {net && net.powerOutage > 0 && <Stat label="AP con guasto Enel vicino" value={net.powerOutage} tone="warn" onClick={go('#/outages')} />}
        {ia?.at && <Stat label="problemi critici IA-AP" hint={ia.apsCritical ? `su ${ia.apsCritical} AP` : undefined} value={ia.critico} tone={ia.critico ? 'bad' : 'good'} onClick={go('#/ia-ap')} />}
        {ia && ia.optimizations.length > 0 && (
          <Stat
            label={running ? `ottimizzazione in corso su ${running.apName}` : ia.optimizations.length === 1 ? 'ottimizzazione programmata' : 'ottimizzazioni programmate'}
            hint={!running && next ? `prossima ${next.apName} ${date(next.startAt)}` : undefined}
            value={ia.optimizations.length}
            tone="warn"
            onClick={go('#/ia-ap')}
          />
        )}
      </section>

      {todo.length ? (
        <Notice tone="warn" title="Da completare">
          <ul className="ui-list">
            {todo.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </Notice>
      ) : (
        <Notice tone="good">Configurazione completa: il provisioning è operativo.</Notice>
      )}

      <div className="ui-grid-2">
        <Card title="Attività ultimi 30 giorni">
          <Facts
            rows={[
              ['Provisioning avviati', s.counts.jobs30d],
              ['Completati', `${s.counts.success30d}${s.counts.jobs30d ? ` (${Math.round((100 * s.counts.success30d) / s.counts.jobs30d)}%)` : ''}`],
              ['Account attivi', s.counts.users],
              ['Reti WPA2', s.counts.wirelessNetworks],
              ['Modelli con template', `${s.counts.profiles} / 5`],
              ['Template airOS', s.counts.templates],
            ]}
          />
        </Card>
        <Card title="UISP" actions={<a href="#/connectors">Connettori</a>}>
          <UispFacts u={uisp.data} />
        </Card>
        <Card title="Ricerca indirizzi (OpenStreetMap)">
          {geocoder.data ? (
            <Facts
              rows={[
                ['Servizio', geocoder.data.primary.local ? 'Nominatim locale' : 'pubblico (openstreetmap.org)'],
                ['Stato', geocoder.data.primary.ok ? <Badge tone="good">operativo</Badge> : geocoder.data.primary.local && geocoder.data.fallback?.ok ? <Badge tone="warn">non pronto: si usa la riserva</Badge> : <Badge tone="bad">non disponibile</Badge>],
                ['Dati aggiornati al', date(geocoder.data.primary.dataUpdated)],
              ]}
            />
          ) : geocoder.isError ? (
            <p className="ui-muted">Stato non disponibile.</p>
          ) : (
            <Skeleton lines={3} />
          )}
        </Card>
        <Card title="App Android">
          <Facts
            rows={[
              ['Release pubblicata', s.androidRelease ? `${s.androidRelease.versionName} (${s.androidRelease.versionCode})` : 'nessuna'],
              ['Versione minima client', s.policy.minAndroidVersion],
              ['Sync GitHub', s.androidReleaseSync ? `${s.androidReleaseSync.repo} · ogni ${s.androidReleaseSync.everyMinutes} min` : 'disattivato'],
            ]}
          />
          {s.androidRelease && <p className="ui-muted ui-mono ui-small">SHA-256 {s.androidRelease.sha256}</p>}
        </Card>
      </div>

      <details className="ui-card ui-details">
        <summary>Parametri delle CPE (dalle variabili d’ambiente del server)</summary>
        <Facts
          rows={[
            ['IP factory', n.factoryIp],
            ['Utente admin CPE', s.policy.cpeAdminUsername],
            ['LAN', `${n.lanIp} / ${n.lanNetmask}`],
            ['DHCP', `${n.dhcpStart} – ${n.dhcpEnd} · ${n.dhcpLease} s`],
            ['PPPoE MTU/MRU', `${n.pppoeMtu} / ${n.pppoeMru}`],
            ['Watchdog', n.watchdogHost],
            ['NTP', n.ntpServer],
            ['SNMP', `${s.runtimeSecrets.snmpCommunity} · contatto ${s.policy.snmpContact}`],
            ['Validità job', `${s.policy.jobTtlMinutes} min`],
            ['Conservazione registro', `${s.policy.auditRetentionDays} giorni`],
          ]}
        />
      </details>
    </div>
  );
}

function UispFacts({ u }: { u?: Uisp }) {
  if (!u) return <Skeleton lines={3} />;
  if (!u.configured) return <p className="ui-muted">Non configurata: impostala in Connettori per AP vicini, accettazione CPE e backup.</p>;
  if (u.ok === false) return <Notice tone="bad" title="Connessione UISP non riuscita">{`${UISP_ERRORS[u.error ?? ''] ?? u.error ?? ''}${u.status ? ` (HTTP ${u.status})` : ''}`}</Notice>;
  return (
    <Facts
      rows={[
        ['Connessione', <Badge tone="good">OK</Badge>],
        ['Dispositivi', u.devices],
        ['AP', `${u.aps} (${u.apsWithLocation} con posizione)`],
        ['In attesa', u.pending],
        ['Site', u.sites],
        ['Versione UISP', u.version ?? '—'],
      ]}
    />
  );
}

/** Label and value, in two columns. */
function Facts({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="ui-facts">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
