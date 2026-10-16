import { useState } from 'react';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { AsyncButton, Badge, Button, Card, Field, Icon, Notice } from '../ui';

/**
 * Connettori → NAS: every night the encrypted backup of the database goes to a folder of a NAS
 * (SMB/CIFS: Synology, QNAP, a Windows share), each copy is read back and opened (restore test)
 * and only the newest stay. The network path is typed in any common form and recognized by the
 * server (name → address, SMB port, the real names of share and folders), or chosen by browsing the
 * NAS here. Passwords stay sealed on the server and never come back.
 */

const ERRORS: Record<string, string> = {
  nas_path_invalid: 'Percorso di rete non valido: scrivi \\\\NAS\\cartella condivisa\\sottocartella (oppure smb://NAS/cartella).',
  nas_path_drive: 'Una lettera di unità (Z:) esiste solo sul PC: scrivi il percorso di rete, per esempio \\\\NAS\\backup.',
  nas_host_unknown: 'Il server non trova il NAS con questo nome: usa il suo indirizzo IP, per esempio \\\\192.168.1.20\\backup.',
  nas_unreachable: 'NAS non raggiungibile dal server sulla porta SMB (445): controlla indirizzo, firewall e che il servizio SMB sia attivo.',
  nas_auth_failed: 'Utente o password del NAS rifiutati.',
  nas_access_denied: 'L’utente del NAS non ha i permessi su questa cartella.',
  nas_share_not_found: 'Cartella condivisa non trovata sul NAS.',
  nas_path_not_found: 'Cartella non trovata sul NAS.',
  nas_exists: 'Esiste già una cartella con questo nome.',
  nas_disk_full: 'Spazio esaurito sul NAS.',
  nas_protocol: 'Il NAS non parla SMB2 o SMB3: attivali nelle impostazioni del NAS (SMB1 non è supportato).',
  nas_timeout: 'Il NAS non ha risposto in tempo.',
  nas_client_missing: 'Sul server manca smbclient: aggiorna il server all’ultima versione.',
  nas_error: 'Errore dal NAS.',
  nas_incomplete: 'Salva prima percorso del NAS e password del backup.',
  nas_busy: 'Un backup è già in corso.',
  nas_copy_mismatch: 'La copia sul NAS non ha la dimensione attesa: trasferimento interrotto.',
  nas_verify_failed: 'La copia sul NAS non supera la prova di ripristino.',
  nas_backup_password_required: 'Serve la password del backup (almeno 12 caratteri).',
  nas_password_required: 'Serve la password dell’utente del NAS.',
  nas_name_invalid: 'Nome di cartella non valido.',
  nas_no_backup: 'Nessun backup sul NAS.',
  backup_wrong_password: 'La password del backup non apre la copia sul NAS.',
};
type ApiErr = Error & { body?: { error?: string; detail?: string; shares?: string[]; issues?: Array<{ message: string }> } };
const errText = (code?: string | null, detail?: string, shares?: string[]) =>
  [ERRORS[code ?? ''] ?? code ?? 'Errore', detail && !/^NT_STATUS/.test(detail) ? detail : null, shares?.length ? `Cartelle condivise sul NAS: ${shares.join(', ')}` : null].filter(Boolean).join(' ');
const apiError = (e: unknown) => {
  const err = e as ApiErr;
  return new Error(err.body?.error ? errText(err.body.error, err.body.detail, err.body.shares) : (err.body?.issues?.[0]?.message ?? err.message));
};
const fail = (e: unknown) => toast((e as Error).message, 'bad');
const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const size = (b: number | null | undefined) => (b == null ? '—' : b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1).replace('.', ',')} GB` : `${Math.max(1, Math.round(b / 1024 ** 2))} MB`);
/** cdanet-backup-2026-10-16-030012.cdanet → 16/10/26, 03:00 (the NAS's own date is in its language). */
const fileDate = (name: string) => {
  const m = /(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})\d{2}/.exec(name);
  return m ? `${m[3]}/${m[2]}/${m[1]!.slice(2)}, ${m[4]}:${m[5]}` : null;
};
const pathOf = (host: string, share: string | null, dir: string[]) => `\\\\${[host, ...(share ? [share, ...dir] : [])].join('\\')}`;

export interface Nas {
  configured: boolean;
  enabled: boolean;
  path: string;
  username: string;
  domain: string;
  passwordSet: boolean;
  backupPasswordSet: boolean;
  includeKey: boolean;
  hour: number;
  keep: number;
  updatedAt: string | null;
  updatedBy: string | null;
  state: {
    running: boolean;
    lastRunAt: string | null;
    lastOkAt: string | null;
    lastError: string | null;
    lastFile: string | null;
    lastBytes: number | null;
    durationMs: number | null;
    verify: { at: string; ok: boolean; integrity: string; counts: Record<string, number | null> } | null;
    freeBytes: number | null;
  };
}
interface Probe {
  host: string;
  ip: string;
  port: number;
  path: string;
  share: string | null;
  dir: string[];
  exists: boolean;
  missing: string[];
  corrected: boolean;
  folders: string[];
  files: number;
  freeBytes: number | null;
}
interface Test extends Partial<Probe> {
  ok: boolean;
  writable?: boolean;
  error?: string;
  detail?: string;
  shares?: string[];
}
interface Files {
  path: string;
  keep: number;
  freeBytes: number | null;
  files: Array<{ name: string; size: number; modified: string }>;
}

export function NasCard({ n, onSaved }: { n: Nas; onSaved: () => Promise<void> }) {
  const [f, setF] = useState({ enabled: n.configured ? n.enabled : true, path: n.path, username: n.username, password: '', domain: n.domain, backupPassword: '', includeKey: n.includeKey, hour: n.hour, keep: n.keep });
  const [found, setFound] = useState<Probe | null>(null);
  const [browser, setBrowser] = useState<Probe | null>(null);
  const [test, setTest] = useState<Test | null>(null);
  const [files, setFiles] = useState<Files | null>(null);
  const account = () => ({ username: f.username.trim(), domain: f.domain.trim(), ...(f.password ? { password: f.password } : {}) });
  const browse = (path: string) => api<Probe>('/api/admin/connectors/nas/browse', { method: 'POST', body: { path, ...account() } }).catch((e) => Promise.reject(apiError(e)));

  const recognize = async () => {
    setTest(null);
    const r = await browse(f.path);
    setFound(r);
    if (r.share) setF((x) => ({ ...x, path: r.path }));
  };
  const open = async () => {
    if (!f.path.trim()) throw new Error('Scrivi almeno il nome o l’indirizzo del NAS, per esempio \\\\192.168.1.20');
    setBrowser(await browse(f.path));
  };
  const go = async (path: string) => setBrowser(await browse(path));
  const here = (b: Probe) => pathOf(b.host, b.share, b.dir);
  const mkdir = async () => {
    if (!browser?.share) return;
    const name = prompt('Nome della nuova cartella', 'CDA Net backup')?.trim();
    if (!name) return;
    try {
      setBrowser(await api<Probe>('/api/admin/connectors/nas/mkdir', { method: 'POST', body: { path: here(browser), name, ...account() } }));
      toast(`Cartella «${name}» creata sul NAS`);
    } catch (e) {
      throw apiError(e);
    }
  };
  const choose = () => {
    if (!browser?.share) return;
    setF((x) => ({ ...x, path: here(browser) }));
    setFound({ ...browser, path: here(browser), exists: true, missing: [], corrected: false });
    setBrowser(null);
  };
  const runTest = async () => {
    setTest(await api<Test>('/api/admin/connectors/nas/test', { method: 'POST', body: { path: f.path, ...account() } }).catch((e) => Promise.reject(apiError(e))));
  };
  const save = async () => {
    try {
      const r = await api<Nas>('/api/admin/connectors/nas', {
        method: 'PUT',
        body: { enabled: f.enabled, path: f.path, ...account(), ...(f.backupPassword ? { backupPassword: f.backupPassword } : {}), includeKey: f.includeKey, hour: f.hour, keep: f.keep },
      });
      toast(r.enabled ? `Backup sul NAS attivo: ogni notte alle ${r.hour}:00` : 'Connettore NAS salvato (backup automatico spento)');
      await onSaved();
    } catch (e) {
      throw apiError(e);
    }
  };
  const runNow = async () => {
    try {
      const r = await api<{ file: string; bytes: number; deleted: string[] }>('/api/admin/connectors/nas/run', { method: 'POST' });
      toast(`Backup ${r.file} copiato e verificato (${size(r.bytes)})${r.deleted.length ? ` · ${r.deleted.length} copie vecchie cancellate` : ''}`);
      await onSaved();
    } catch (e) {
      await onSaved();
      throw apiError(e);
    }
  };
  const verify = async (file?: string) => {
    try {
      const r = await api<{ ok: boolean; file: string; integrity: string }>('/api/admin/connectors/nas/verify', { method: 'POST', body: file ? { file } : {} });
      toast(r.ok ? `${r.file}: si apre con la password e il database è integro` : `${r.file}: database danneggiato (${r.integrity})`, r.ok ? 'good' : 'bad');
    } catch (e) {
      throw apiError(e);
    }
  };
  const remove = async () => {
    if (!confirm('Rimuovere il connettore NAS? Le password salvate vengono cancellate dal server; i backup già sul NAS restano.')) return;
    await api('/api/admin/connectors/nas', { method: 'DELETE' });
    toast('Connettore NAS rimosso');
    await onSaved();
  };

  const s = n.state;
  const failing = !!s.lastError && (!s.lastOkAt || (s.lastRunAt ?? '') > s.lastOkAt);
  const on = n.configured && n.enabled;
  return (
    <Card title="NAS (backup automatico)" actions={<Badge tone={on ? (failing ? 'bad' : 'good') : n.configured ? 'neutral' : 'warn'}>{on ? (failing ? 'ultimo backup non riuscito' : 'attivo') : n.configured ? 'disattivato' : 'non configurato'}</Badge>}>
      <p className="ui-muted ui-small cn-p">
        Ogni notte il backup cifrato del database va in una cartella del NAS (SMB/CIFS: Synology, QNAP, condivisione Windows). Ogni copia viene riletta dal NAS e aperta con la password (prova di ripristino); restano solo le più recenti.
      </p>
      {n.updatedAt && (
        <p className="ui-muted ui-small cn-p">
          Ultima modifica {date(n.updatedAt)}
          {n.updatedBy ? ` · ${n.updatedBy}` : ''}
        </p>
      )}
      <label className="ui-check">
        <input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
        Backup automatico ogni notte
      </label>
      <div className="ui-grid-form">
        <Field label="Utente del NAS" hint="Vuoto per l’accesso ospite">
          <input autoComplete="off" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} placeholder="backup" />
        </Field>
        <Field label="Password del NAS" hint="Resta cifrata sul server">
          <input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} placeholder={n.passwordSet ? 'Impostata: lascia vuoto per non cambiarla' : 'Password'} />
        </Field>
        <Field label="Dominio o gruppo di lavoro" hint="Facoltativo, solo se il NAS è in un dominio">
          <input autoComplete="off" value={f.domain} onChange={(e) => setF({ ...f, domain: e.target.value })} placeholder="WORKGROUP" />
        </Field>
      </div>
      <Field label="Percorso di rete" hint="Come lo scrivi in Esplora file: \\NAS\cartella\sottocartella. Vanno bene anche //NAS/cartella, smb://NAS/cartella e l’indirizzo IP al posto del nome.">
        <div className="nas-path">
          <input
            className="ui-mono"
            autoComplete="off"
            spellCheck={false}
            value={f.path}
            onChange={(e) => {
              setF({ ...f, path: e.target.value });
              setFound(null);
              setTest(null);
            }}
            placeholder="\\192.168.1.20\backup\cdanet"
          />
          <AsyncButton onClick={recognize} onError={fail} disabled={!f.path.trim()}>
            Riconosci
          </AsyncButton>
          <AsyncButton icon="folder" onClick={open} onError={fail}>
            Sfoglia il NAS
          </AsyncButton>
        </div>
      </Field>
      {found && <Recognized p={found} />}
      {browser && <Browser b={browser} go={go} mkdir={mkdir} choose={choose} close={() => setBrowser(null)} />}

      <div className="ui-grid-form">
        <Field label="Password del backup" hint="Almeno 12 caratteri. Serve per aprire i backup: conservala anche fuori dal server, senza di lei le copie sono inutilizzabili.">
          <input type="password" autoComplete="new-password" value={f.backupPassword} onChange={(e) => setF({ ...f, backupPassword: e.target.value })} placeholder={n.backupPasswordSet ? 'Impostata: lascia vuoto per non cambiarla' : 'Password del backup'} />
        </Field>
        <Field label="Ora del backup" hint="Ora italiana; se il server era spento, appena riparte">
          <select value={f.hour} onChange={(e) => setF({ ...f, hour: Number(e.target.value) })}>
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, '0')}:00
              </option>
            ))}
          </select>
        </Field>
        <Field label="Copie da tenere sul NAS" hint="Le più vecchie vengono cancellate (solo i backup creati da qui)">
          <input type="number" min={1} max={365} value={f.keep} onChange={(e) => setF({ ...f, keep: Math.max(1, Math.min(365, Number(e.target.value) || 1)) })} />
        </Field>
      </div>
      <label className="ui-check">
        <input type="checkbox" checked={f.includeKey} onChange={(e) => setF({ ...f, includeKey: e.target.checked })} />
        Includi la chiave principale (serve per ripristinare su un server nuovo; chi ha file e password del backup può leggere anche le credenziali salvate)
      </label>
      <div className="ui-row">
        <AsyncButton onClick={runTest} onError={fail} disabled={!f.path.trim()}>
          Testa connessione
        </AsyncButton>
        <AsyncButton variant="primary" onClick={save} onError={fail}>
          Salva
        </AsyncButton>
        {n.configured && (
          <AsyncButton variant="danger" onClick={remove} onError={fail}>
            Rimuovi configurazione
          </AsyncButton>
        )}
      </div>
      {test &&
        (test.ok ? (
          <Notice tone={test.writable ? 'good' : 'warn'}>
            {test.writable
              ? `Connessione riuscita: ${test.path} è scrivibile${test.freeBytes != null ? ` · liberi ${size(test.freeBytes)}` : ''}.`
              : test.exists
                ? `${test.path}: l’utente può leggere ma non scrivere. Dagli il permesso di scrittura sulla cartella.`
                : `${test.path}: la cartella «${test.missing?.join('\\')}» non esiste ancora. Creala da «Sfoglia il NAS».`}
          </Notice>
        ) : (
          <Notice tone="bad">{errText(test.error, test.detail, test.shares)}</Notice>
        ))}

      {n.configured && (
        <section className="cn-sec">
          <h3>Backup sul NAS</h3>
          <dl className="nas-state">
            <dt>Ultimo backup riuscito</dt>
            <dd>{s.lastOkAt ? `${date(s.lastOkAt)} · ${s.lastFile} · ${size(s.lastBytes)}${s.durationMs ? ` · ${Math.max(1, Math.round(s.durationMs / 1000))} s` : ''}` : 'nessuno'}</dd>
            <dt>Prova di ripristino</dt>
            <dd>{s.verify ? (s.verify.ok ? `superata ${date(s.verify.at)}: ${s.verify.counts.users ?? 0} utenti, ${s.verify.counts.installations ?? 0} installazioni` : `non superata (${s.verify.integrity})`) : '—'}</dd>
            <dt>Spazio libero sul NAS</dt>
            <dd>{size(s.freeBytes)}</dd>
            <dt>Prossimo</dt>
            <dd>{n.enabled ? `stanotte alle ${String(n.hour).padStart(2, '0')}:00 (se il server era spento, appena riparte)` : 'backup automatico spento'}</dd>
          </dl>
          {failing && (
            <Notice tone="bad">
              Ultimo tentativo {date(s.lastRunAt)} non riuscito: {errText(s.lastError)}
            </Notice>
          )}
          <div className="ui-row">
            <AsyncButton variant="primary" onClick={runNow} onError={fail} disabled={s.running}>
              {s.running ? 'Backup in corso…' : 'Esegui backup ora'}
            </AsyncButton>
            <AsyncButton onClick={() => verify()} onError={fail}>
              Prova di ripristino
            </AsyncButton>
            <AsyncButton
              onClick={async () => {
                try {
                  setFiles(await api<Files>('/api/admin/connectors/nas/files'));
                } catch (e) {
                  throw apiError(e);
                }
              }}
              onError={fail}
            >
              Copie sul NAS
            </AsyncButton>
          </div>
          {files && (
            <ul className="hl-list nas-files">
              {files.files.length === 0 && <li className="hl-row ui-muted">Nessun backup in {files.path}.</li>}
              {files.files.map((x) => (
                <li key={x.name} className="hl-row">
                  <div className="hl-main">
                    <div className="hl-name ui-mono">{x.name}</div>
                    <div className="hl-sub ui-small">
                      {size(x.size)} · {fileDate(x.name) ?? x.modified}
                    </div>
                  </div>
                  <AsyncButton variant="ghost" onClick={() => verify(x.name)} onError={fail}>
                    Verifica
                  </AsyncButton>
                </li>
              ))}
            </ul>
          )}
          <p className="ui-muted ui-small cn-p">Per ripristinare: Salute piattaforma → controlla il file con la sua password, poi il ripristino si fa sul server con l’assistenza. Un backup non riuscito arriva come avviso in Salute piattaforma e su Telegram.</p>
        </section>
      )}
    </Card>
  );
}

/** What the server recognized in the path typed. */
function Recognized({ p }: { p: Probe }) {
  const where = `${p.host}${p.ip !== p.host ? ` → ${p.ip}` : ''} · porta SMB ${p.port}`;
  if (!p.share)
    return (
      <Notice tone="warn">
        NAS trovato ({where}). Manca la cartella condivisa: scegline una con «Sfoglia il NAS». Cartelle condivise: {p.folders.join(', ') || 'nessuna visibile'}.
      </Notice>
    );
  return (
    <Notice tone={p.exists ? 'good' : 'warn'}>
      <div>
        Riconosciuto <span className="ui-mono">{p.path}</span>
      </div>
      <div className="ui-small">
        {where} · cartella condivisa «{p.share}»
        {p.dir.length ? ` · cartelle ${p.dir.map((d) => `«${d}»`).join(' › ')}` : ''}
        {p.freeBytes != null ? ` · liberi ${size(p.freeBytes)}` : ''}
      </div>
      {p.corrected && <div className="ui-small">Maiuscole corrette come sul NAS.</div>}
      {!p.exists && <div className="ui-small">«{p.missing.join('\\')}» non esiste ancora: creala da «Sfoglia il NAS» → Nuova cartella.</div>}
    </Notice>
  );
}

/** The folders of the NAS, to choose where the backups go. */
function Browser({ b, go, mkdir, choose, close }: { b: Probe; go: (path: string) => Promise<void>; mkdir: () => Promise<void>; choose: () => void; close: () => void }) {
  const crumbs: Array<{ label: string; path: string }> = [{ label: b.host, path: pathOf(b.host, null, []) }];
  if (b.share) {
    crumbs.push({ label: b.share, path: pathOf(b.host, b.share, []) });
    b.dir.forEach((d, i) => crumbs.push({ label: d, path: pathOf(b.host, b.share, b.dir.slice(0, i + 1)) }));
  }
  const into = (name: string) => (b.share ? pathOf(b.host, b.share, [...b.dir, name]) : pathOf(b.host, name, []));
  return (
    <div className="nas-browser" role="group" aria-label="Cartelle del NAS">
      <div className="nas-crumbs">
        <Icon name="dns" />
        {crumbs.map((c, i) => (
          <span key={c.path}>
            {i > 0 && <span className="ui-muted"> › </span>}
            {i < crumbs.length - 1 ? (
              <button type="button" className="nas-crumb" onClick={() => void go(c.path).catch(fail)}>
                {c.label}
              </button>
            ) : (
              <strong>{c.label}</strong>
            )}
          </span>
        ))}
      </div>
      <p className="ui-muted ui-small cn-p">
        {b.share ? 'Apri una cartella per entrarci, poi «Usa questa cartella».' : 'Le cartelle condivise del NAS: scegline una.'}
        {b.files ? ` In questa cartella ci sono anche ${b.files} file.` : ''}
      </p>
      <ul className="hl-list nas-folders">
        {b.folders.length === 0 && <li className="hl-row ui-muted">{b.share ? 'Nessuna sottocartella.' : 'Nessuna cartella condivisa visibile con questo utente.'}</li>}
        {b.folders.map((name) => (
          <li key={name}>
            <button type="button" className="hl-row nas-folder" onClick={() => void go(into(name)).catch(fail)}>
              <Icon name="folder" />
              <span>{name}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="ui-row">
        {crumbs.length > 1 && (
          <Button onClick={() => void go(crumbs[crumbs.length - 2]!.path).catch(fail)}>Cartella superiore</Button>
        )}
        {b.share && (
          <AsyncButton icon="add_circle" onClick={mkdir} onError={fail}>
            Nuova cartella
          </AsyncButton>
        )}
        {b.share && (
          <Button variant="primary" onClick={choose}>
            Usa questa cartella
          </Button>
        )}
        <Button variant="ghost" onClick={close}>
          Chiudi
        </Button>
      </div>
    </div>
  );
}
