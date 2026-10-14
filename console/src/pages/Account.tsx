import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { toast } from '../../../web/js/dom.js';
import { MyTelegram } from '../account/MyTelegram';
import { api, session } from '../lib/api';
import { AsyncButton, Badge, Button, Card, Field, Notice, PageHeader, Skeleton, Stat } from '../ui';
import { openAttestation } from './Privacy';

/**
 * Il mio account (everyone): password, two-step verification, personal Telegram, the phones
 * signed in to the app, the privacy notice accepted and "log out everywhere".
 */

interface Me {
  username: string;
  role: string;
  lastLoginAt: string | null;
  createdAt: string;
  totpEnabled: boolean;
  totpRequired: boolean;
  recoveryCodesLeft: number;
}

const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const fail = (e: unknown) => toast((e as Error).message, 'bad');
const KEY = ['auth', 'account'];

export function Account() {
  const q = useQuery({ queryKey: KEY, queryFn: () => api<Me>('/api/auth/account') });
  const a = q.data;
  if (q.error) return <Notice tone="bad">{(q.error as Error).message}</Notice>;
  if (!a) {
    return (
      <div className="ui-page">
        <PageHeader icon="lock" title="Il mio account" />
        <Skeleton lines={6} />
      </div>
    );
  }
  const role = a.role === 'admin' ? 'Amministratore' : 'Installatore';
  return (
    <div className="ui-page">
      {a.totpRequired && !a.totpEnabled && <Notice tone="bad">Per gli amministratori la verifica in due passaggi è obbligatoria: attivala qui sotto per usare la console.</Notice>}
      <PageHeader icon="lock" title="Il mio account" subtitle={`${a.username} · ${role}`} />
      <section className="ui-stats" aria-label="Account">
        <Stat label="utente" value={<span className="ac-date">{a.username}</span>} />
        <Stat label="ruolo" value={<span className="ac-date">{role}</span>} />
        <Stat label="ultimo accesso" value={<span className="ac-date">{date(a.lastLoginAt)}</span>} />
        <Stat label="creato il" value={<span className="ac-date">{date(a.createdAt)}</span>} />
      </section>
      <div className="ui-grid-2">
        <PasswordCard />
        <TotpCard a={a} />
      </div>
      <MyTelegram />
      <PhonesCard />
      <PrivacyCard />
      <Card title="Sessioni">
        <p className="ui-muted ui-small ac-p">Telefono perso o accesso da un PC condiviso? Chiudi tutte le sessioni: servirà un nuovo accesso ovunque.</p>
        <div className="ui-row">
          <AsyncButton
            variant="danger"
            onClick={async () => {
              if (!confirm('Chiudere tutte le sessioni di questo account, compresa questa e quelle dell’app?')) return;
              await api('/api/auth/logout-all', { method: 'POST', body: {} });
              session.clear();
              window.dispatchEvent(new Event('cda:logout'));
            }}
            onError={fail}
          >
            Esci da tutti i dispositivi
          </AsyncButton>
        </div>
      </Card>
    </div>
  );
}

function PasswordCard() {
  const [f, setF] = useState({ current: '', next: '', again: '' });
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    if (f.next.length < 12) return setMsg({ tone: 'bad', text: 'La nuova password deve avere almeno 12 caratteri.' });
    if (f.next !== f.again) return setMsg({ tone: 'bad', text: 'Le due password nuove non coincidono.' });
    setBusy(true);
    try {
      const r = await api<{ token: string; expiresAt: string }>('/api/auth/password', { method: 'POST', body: { currentPassword: f.current, newPassword: f.next } });
      session.set({ ...session.get()!, token: r.token, expiresAt: r.expiresAt });
      setF({ current: '', next: '', again: '' });
      toast('Password cambiata');
      setMsg({ tone: 'good', text: 'Password cambiata. Le altre sessioni sono state chiuse.' });
    } catch (err) {
      setMsg({ tone: 'bad', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Password">
      <form className="ac-form" onSubmit={submit}>
        <Field label="Password attuale">
          <input type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} />
        </Field>
        <Field label="Nuova password" hint="Almeno 12 caratteri.">
          <input type="password" autoComplete="new-password" minLength={12} value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} />
        </Field>
        <Field label="Ripeti la nuova password">
          <input type="password" autoComplete="new-password" minLength={12} value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} />
        </Field>
        <p className="ui-muted ui-small ac-p">Dopo il cambio, le altre sessioni (app e browser) vengono chiuse: andrà rifatto l’accesso con la nuova password.</p>
        <div className="ui-row">
          <Button type="submit" variant="primary" busy={busy}>
            Cambia password
          </Button>
        </div>
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      </form>
    </Card>
  );
}

const loadScript = (src: string) =>
  new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = reject;
    document.head.append(s);
  });

function RecoveryCodes({ codes }: { codes: string[] }) {
  return (
    <Notice tone="warn" title="Codici di recupero: salvali ora, non verranno più mostrati.">
      <p className="ui-small ac-p">Ognuno vale una sola volta, al posto del codice dell’app (es. telefono perso o cambiato).</p>
      <pre className="ac-codes">{codes.join('\n')}</pre>
      <Button onClick={() => void navigator.clipboard?.writeText(codes.join('\n')).then(() => toast('Codici copiati'))}>Copia</Button>
    </Notice>
  );
}

/** Two-step verification: QR enrolment, recovery codes, disable. */
function TotpCard({ a }: { a: Me }) {
  const qc = useQueryClient();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [setup, setSetup] = useState<{ secret: string; svg: string | null } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: KEY });

  const start = async () => {
    const s = await api<{ otpauthUrl: string; secret: string }>('/api/auth/totp/setup', { method: 'POST', body: { password } });
    // the QR library only here, where it is used
    const w = window as unknown as { qrcode?: (t: number, l: string) => { addData: (s: string) => void; make: () => void; createSvgTag: (o: object) => string } };
    if (!w.qrcode) await loadScript('/vendor/qrcode.js').catch(() => {});
    let svg: string | null = null;
    if (w.qrcode) {
      const qr = w.qrcode(0, 'M');
      qr.addData(s.otpauthUrl);
      qr.make();
      svg = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
    }
    setSetup({ secret: s.secret, svg });
    setPassword('');
  };
  const enable = async () => {
    const r = await api<{ recoveryCodes: string[] }>('/api/auth/totp/enable', { method: 'POST', body: { code: code.trim() } });
    toast('Verifica in due passaggi attiva');
    setSetup(null);
    setCode('');
    setCodes(r.recoveryCodes);
    await refresh();
  };
  const regen = async () => {
    const r = await api<{ recoveryCodes: string[] }>('/api/auth/totp/recovery', { method: 'POST', body: { password } });
    setCodes(r.recoveryCodes);
    setPassword('');
    await refresh();
  };
  const disable = async () => {
    if (!confirm('Disattivare la verifica in due passaggi?')) return;
    await api('/api/auth/totp/disable', { method: 'POST', body: { password, code: code.trim() } });
    toast('Verifica in due passaggi disattivata');
    setPassword('');
    setCode('');
    setCodes(null);
    await refresh();
  };

  return (
    <Card title="Verifica in due passaggi" actions={a.totpEnabled ? <Badge tone="good">attiva</Badge> : <Badge tone={a.totpRequired ? 'bad' : 'neutral'}>non attiva</Badge>}>
      {codes && <RecoveryCodes codes={codes} />}
      {!a.totpEnabled && !setup && (
        <>
          <p className="ui-muted ui-small ac-p">Oltre alla password serve un codice di 6 cifre generato dal telefono: chi ruba la password non entra.</p>
          <form className="ac-inline" onSubmit={(e) => e.preventDefault()}>
            <Field label="Password attuale">
              <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <AsyncButton type="submit" variant="primary" onClick={start} onError={fail}>
              Attiva
            </AsyncButton>
          </form>
        </>
      )}
      {setup && (
        <>
          <ol className="ui-list ui-small">
            <li>Apri Google Authenticator, Microsoft Authenticator o un’app simile e aggiungi un account con il QR code.</li>
            <li>Inserisci il codice di 6 cifre che compare nell’app.</li>
          </ol>
          {/* the SVG is made here by the QR library from the server's otpauth address */}
          {setup.svg && <div className="ac-qr" dangerouslySetInnerHTML={{ __html: setup.svg }} />}
          <p className="ui-muted ui-small ac-p">
            Non riesci a inquadrarlo? Chiave da inserire a mano: <span className="ui-mono">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</span>
          </p>
          <form className="ac-inline" onSubmit={(e) => e.preventDefault()}>
            <Field label="Codice">
              <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} />
            </Field>
            <AsyncButton type="submit" variant="primary" onClick={enable} onError={fail}>
              Conferma e attiva
            </AsyncButton>
          </form>
        </>
      )}
      {a.totpEnabled && (
        <>
          <p className="ui-small ac-p">Codici di recupero rimasti: {a.recoveryCodesLeft}</p>
          {a.recoveryCodesLeft <= 2 && <Notice tone="warn">Ti restano pochi codici di recupero: generane di nuovi.</Notice>}
          <form className="ui-grid-form" onSubmit={(e) => e.preventDefault()}>
            <Field label="Password attuale">
              <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            {!a.totpRequired && (
              <Field label="Codice (per disattivare)">
                <input inputMode="numeric" maxLength={9} placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} />
              </Field>
            )}
          </form>
          <div className="ui-row">
            <AsyncButton onClick={regen} onError={fail}>
              Nuovi codici di recupero
            </AsyncButton>
            {!a.totpRequired && (
              <AsyncButton variant="danger" onClick={disable} onError={fail}>
                Disattiva
              </AsyncButton>
            )}
          </div>
          {a.totpRequired && <p className="ui-muted ui-small ac-p">Obbligatoria per gli amministratori: non si può disattivare.</p>}
        </>
      )}
    </Card>
  );
}

interface Device {
  id: number;
  name: string | null;
  active: boolean;
  persistent: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

/** Phones signed in to the app (persistent login or fingerprint/face): list and revoke. */
function PhonesCard() {
  const q = useQuery({ queryKey: ['auth', 'devices'], queryFn: () => api<{ devices: Device[] }>('/api/auth/devices') });
  const off = async (d: Device) => {
    if (!confirm(`Scollegare ${d.name || 'questo telefono'}? Al prossimo avvio l’app chiederà la password.`)) return;
    await api(`/api/auth/devices/${d.id}`, { method: 'DELETE' });
    toast('Telefono scollegato');
    await q.refetch();
  };
  return (
    <Card title="Telefoni collegati" padded={!q.data?.devices.length}>
      <p className={`ui-muted ui-small ac-p${q.data?.devices.length ? ' ac-pad' : ''}`}>
        Dopo il primo accesso l’app resta collegata (la sessione si rinnova a ogni apertura e scade dopo 30 giorni senza uso); in Impostazioni si può chiedere impronta o volto a ogni apertura. La password non resta sul telefono; «Esci da tutti i dispositivi», il cambio password o la disattivazione dell’account scollegano anche i telefoni.
      </p>
      {q.error ? (
        <Notice tone="bad">{(q.error as Error).message}</Notice>
      ) : !q.data ? (
        <Skeleton lines={2} />
      ) : !q.data.devices.length ? (
        <p className="ui-small ac-p">Nessun telefono collegato.</p>
      ) : (
        <ul className="hl-list">
          {q.data.devices.map((d) => (
            <li key={d.id} className="hl-row">
              <div className="hl-main">
                <div className="hl-name">
                  <strong>{d.name || 'Telefono'}</strong>
                  <Badge tone={d.active ? 'good' : 'neutral'}>{d.active ? 'attivo' : 'scaduto'}</Badge>
                  <Badge>{d.persistent ? 'resta collegato' : 'impronta o volto'}</Badge>
                </div>
                <div className="hl-sub">
                  Attivato {date(d.createdAt)} · ultimo uso {date(d.lastUsedAt)}
                  {d.expiresAt ? ` · scade ${date(d.expiresAt)} se non usato` : ''}
                </div>
              </div>
              <div className="hl-actions">
                <AsyncButton variant="danger" onClick={() => off(d)} onError={fail}>
                  Scollega
                </AsyncButton>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** The privacy notice this user accepted, with the attestation to download. */
function PrivacyCard() {
  const q = useQuery({ queryKey: ['privacy', 'mine'], queryFn: () => api<{ notice?: unknown; acceptanceId?: number; acceptedAt?: string; version?: string }>('/api/privacy') });
  const p = q.data;
  if (!p || (!p.notice && !p.acceptanceId)) return null;
  return (
    <Card title="Informativa privacy">
      {p.acceptanceId ? (
        <>
          <p className="ui-small ac-p">
            Accettata il {date(p.acceptedAt)} (versione {p.version}).
          </p>
          <div className="ui-row">
            <AsyncButton onClick={() => openAttestation(p.acceptanceId!)} onError={fail}>
              Scarica attestazione
            </AsyncButton>
          </div>
        </>
      ) : (
        <Notice tone="warn">Non ancora accettata: la trovi al prossimo accesso dall’app.</Notice>
      )}
    </Card>
  );
}
