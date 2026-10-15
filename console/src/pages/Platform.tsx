import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { toast } from '../lib/toast';
import { AsyncButton, Badge, Card, Field, Notice, PageHeader, Skeleton } from '../ui';

/**
 * Salute piattaforma (admins): every source the server reads (when it last worked, the last error,
 * whether it is late), the server (database, disk, backups), the encrypted backup of the database
 * to download, and the check of a backup file (nothing is replaced).
 */

type State = 'ok' | 'warn' | 'bad' | 'off';
interface Source {
  id: string;
  label: string;
  state: State;
  at: string | null;
  error: string | null;
  everyMin: number;
  lateMin: number;
}
interface Health {
  generatedAt: string;
  server: {
    version: string;
    uptimeS: number;
    dbBytes: number;
    diskFreeBytes: number | null;
    diskLow: boolean;
    localBackups: { count: number; last: string | null };
    lastDownload: { at: string; by: string; bytes: number } | null;
  };
  sources: Source[];
}
interface Verified {
  ok: boolean;
  integrity: string;
  schema: number;
  includesKey: boolean;
  dbBytes: number;
  meta: { createdAt?: string; version?: string };
  counts: Record<string, number | null>;
}

const STATE: Record<State, [string, 'good' | 'warn' | 'bad' | 'neutral']> = { ok: ['regolare', 'good'], warn: ['in ritardo', 'warn'], bad: ['errore', 'bad'], off: ['non configurato', 'neutral'] };
const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const since = (iso: string | null) => {
  if (!iso) return 'mai';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 1 ? 'adesso' : m < 120 ? `${m} min fa` : m < 48 * 60 ? `${Math.round(m / 60)} h fa` : `${Math.round(m / 1440)} g fa`;
};
const size = (b: number | null) => (b == null ? '—' : b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1).replace('.', ',')} GB` : `${Math.max(1, Math.round(b / 1024 ** 2))} MB`);
const uptime = (s: number) => (s < 3600 ? `${Math.round(s / 60)} min` : s < 172_800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86_400)} giorni`);
const COUNT: Record<string, string> = { users: 'account', installations: 'installazioni', workOrders: 'interventi', acceptanceTests: 'collaudi', events: 'eventi del registro' };

export function Platform() {
  const q = useQuery({ queryKey: ['platform', 'health'], queryFn: () => api<Health>('/api/admin/platform/health'), refetchInterval: 60_000 });
  const d = q.data;
  return (
    <div className="ui-page">
      <PageHeader icon="check_circle" title="Salute piattaforma" subtitle="Come stanno i servizi che il server legge, il server stesso e i backup. Il NOC riceve un avviso (Notifiche e Telegram) quando un servizio si ferma o riparte." />
      {q.error && <Notice tone="bad">{(q.error as Error).message}</Notice>}
      {!d && !q.error && <Skeleton lines={6} />}
      {d && (
        <>
          <Card title="Servizi" padded={false}>
            <ul className="hl-list">
              {d.sources.map((s) => (
                <li key={s.id} className={`hl-row ui-tone-${STATE[s.state][1]}`}>
                  <span className="hl-dot" />
                  <div className="hl-main">
                    <div className="hl-name">
                      <strong>{s.label}</strong>
                      <Badge tone={STATE[s.state][1]}>{STATE[s.state][0]}</Badge>
                    </div>
                    <div className="hl-sub ui-small">
                      {s.state === 'off'
                        ? 'Non configurato o modulo spento: nessun avviso.'
                        : [`ultimo esito positivo ${since(s.at)}`, `letto ogni ${s.everyMin} min`, `in ritardo dopo ${s.lateMin} min`].join(' · ')}
                    </div>
                    {s.error && <div className="ui-small pf-error">{s.error}</div>}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
          <Card title="Server">
            <dl className="ui-facts">
              <div>
                <dt>Versione</dt>
                <dd>{d.server.version}</dd>
              </div>
              <div>
                <dt>Acceso da</dt>
                <dd>{uptime(d.server.uptimeS)}</dd>
              </div>
              <div>
                <dt>Database</dt>
                <dd>{size(d.server.dbBytes)}</dd>
              </div>
              <div>
                <dt>Spazio libero</dt>
                <dd>
                  {size(d.server.diskFreeBytes)} {d.server.diskLow && <Badge tone="bad">poco spazio</Badge>}
                </dd>
              </div>
              <div>
                <dt>Copie automatiche prima degli aggiornamenti</dt>
                <dd>{d.server.localBackups.count ? `${d.server.localBackups.count} sul server · ultima ${date(d.server.localBackups.last)}` : 'nessuna'}</dd>
              </div>
              <div>
                <dt>Ultimo backup scaricato</dt>
                <dd>{d.server.lastDownload ? `${date(d.server.lastDownload.at)} da ${d.server.lastDownload.by}` : 'mai'}</dd>
              </div>
            </dl>
            <p className="ui-muted ui-small">Aggiornato {date(d.generatedAt)}: si aggiorna ogni minuto. Le copie automatiche restano sul server stesso: per averne una altrove scarica il backup qui sotto.</p>
          </Card>
          <BackupCard />
          <VerifyCard />
        </>
      )}
    </div>
  );
}

/** The encrypted backup of the database: the password is chosen now and is needed to open it. */
function BackupCard() {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [withKey, setWithKey] = useState(false);
  const download = async () => {
    if (pw.length < 12) throw new Error('La password deve avere almeno 12 caratteri');
    if (pw !== pw2) throw new Error('Le due password non coincidono');
    const r = await api<Response>('/api/admin/platform/backup', { method: 'POST', body: { password: pw, includeKey: withKey }, raw: true });
    if (!r.ok) throw new ApiError(r.status, await r.json().catch(() => ({})));
    const name = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') ?? '')?.[1] ?? 'cdanet-backup.cdanet';
    const url = URL.createObjectURL(await r.blob());
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    setPw('');
    setPw2('');
    toast('Backup scaricato: conserva la password, senza non si apre');
  };
  return (
    <Card title="Backup del database">
      <p className="ui-muted ui-small">Una copia completa del database (account, installazioni, collaudi, interventi, impostazioni, registro), cifrata con la password che scegli ora. Il file non contiene le foto dei collaudi.</p>
      <div className="ui-grid-form">
        <Field label="Password del backup" hint="Almeno 12 caratteri: senza di lei il file non si apre, nemmeno noi possiamo recuperarla.">
          <input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </Field>
        <Field label="Ripeti la password">
          <input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        </Field>
      </div>
      <label className="ui-check ui-small">
        <input type="checkbox" checked={withKey} onChange={(e) => setWithKey(e.target.checked)} /> Includi la chiave principale del server
      </label>
      <p className="ui-muted ui-small">
        Le chiavi dei connettori, le password PPPoE degli interventi e le credenziali salvate nel database sono cifrate con la chiave principale del server: per ripristinare il backup su un server nuovo serve anche lei. Includila solo se conservi il file e la password in un posto sicuro.
      </p>
      <AsyncButton variant="primary" onClick={download} onError={(e) => toast((e as Error).message, 'bad')}>
        Scarica backup cifrato
      </AsyncButton>
    </Card>
  );
}

/** A backup file checked on the server: password, integrity, what it holds. Nothing is replaced. */
function VerifyCard() {
  const [file, setFile] = useState<File | null>(null);
  const [pw, setPw] = useState('');
  const [r, setR] = useState<Verified | null>(null);
  const [error, setError] = useState<string | null>(null);
  const check = async () => {
    setR(null);
    setError(null);
    if (!file) throw new Error('Scegli il file del backup');
    try {
      setR(await api<Verified>('/api/admin/platform/backup/verify', { method: 'POST', body: new Uint8Array(await file.arrayBuffer()), headers: { 'Content-Type': 'application/x-cdanet-backup', 'X-Backup-Password': pw } }));
    } catch (e) {
      const code = (e as ApiError).body?.error;
      setError(code === 'backup_wrong_password' ? 'Password sbagliata, oppure file danneggiato.' : code === 'backup_invalid' ? 'Non è un backup CDA Net.' : (e as Error).message);
    }
  };
  return (
    <Card title="Verifica un backup">
      <p className="ui-muted ui-small">Controlla che un file di backup si apra con la sua password e che il database dentro sia integro. È la prova di ripristino: non sostituisce niente sul server.</p>
      <div className="ui-grid-form">
        <Field label="File del backup">
          <input type="file" accept=".cdanet" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Field>
        <Field label="Password del backup">
          <input type="password" autoComplete="off" value={pw} onChange={(e) => setPw(e.target.value)} />
        </Field>
      </div>
      <AsyncButton onClick={check} onError={(e) => setError((e as Error).message)}>
        Verifica
      </AsyncButton>
      {error && <Notice tone="bad">{error}</Notice>}
      {r && (
        <Notice tone={r.ok ? 'good' : 'bad'}>
          {r.ok ? 'Backup integro: si può ripristinare.' : `Database danneggiato: ${r.integrity}`} Creato il {date(r.meta.createdAt)} con la versione {r.meta.version ?? '?'} · {size(r.dbBytes)} ·{' '}
          {Object.entries(r.counts)
            .filter(([, n]) => n != null)
            .map(([k, n]) => `${n} ${COUNT[k] ?? k}`)
            .join(', ')}{' '}
          · {r.includesKey ? 'contiene la chiave principale' : 'senza la chiave principale'}.
        </Notice>
      )}
    </Card>
  );
}
