import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { toast } from '../lib/toast';
import { loadModules } from '../lib/modules';
import { Assignments } from '../infra/Assignments';
import { api } from '../lib/api';
import type { PageContext, User } from '../shell/routes';
import { AsyncButton, Badge, Button, Card, Drawer, Field, Icon, Notice, PageHeader, Skeleton, Table } from '../ui';

/**
 * Account (admins): installers and administrators. Disabling an account and resetting its password
 * or its two-step verification close its sessions at once. Per-user modules and templates, the
 * security policy and the POP/AP assigned to each installer are here too.
 */

interface Account {
  id: number;
  username: string;
  role: 'admin' | 'installer';
  active: boolean;
  totpEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  jobs: number;
}
interface Template {
  model: string;
  name: string;
  audience: string;
  defaultForAssigned?: boolean;
  users: Array<{ id: number }>;
}
interface UserModule {
  key: string;
  label: string;
  area: string;
  global: boolean;
  override: boolean | null;
  effective: boolean;
}

const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const fail = (e: unknown) => toast((e as Error).message, 'bad');

export function Users({ user: me }: PageContext) {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: () => api<Account[]>('/api/admin/users') });
  const profiles = useQuery({ queryKey: ['admin', 'profiles'], queryFn: () => api<Array<{ model: string; templates: Template[] }>>('/api/admin/profiles') });
  const security = useQuery({ queryKey: ['admin', 'security'], queryFn: () => api<{ totpRequiredForAdmins: boolean }>('/api/admin/security') });
  const [open, setOpen] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [text, setText] = useState('');
  const reload = () => qc.invalidateQueries({ queryKey: ['admin', 'users'] });

  const setPolicy = async (on: boolean) => {
    try {
      await api('/api/admin/security', { method: 'PUT', body: { totpRequiredForAdmins: on } });
      qc.setQueryData(['admin', 'security'], { totpRequiredForAdmins: on });
      toast(on ? 'Verifica in due passaggi obbligatoria per gli admin' : 'Verifica in due passaggi facoltativa');
    } catch (e) {
      fail(e);
    }
  };

  const t = text.trim().toLowerCase();
  const rows = (users.data ?? []).filter((u) => !t || u.username.toLowerCase().includes(t));
  const current = users.data?.find((u) => u.id === open) ?? null;

  return (
    <div className="ui-page">
      <PageHeader
        icon="person"
        title="Account"
        subtitle="Installatori e amministratori. Disabilitazione e reset revocano subito le sessioni."
        actions={
          <Button variant="primary" icon="add_circle" onClick={() => setCreating(true)}>
            Nuovo account
          </Button>
        }
      />
      <Card title="Sicurezza">
        {security.data ? (
          <label className="ui-check">
            <input type="checkbox" checked={security.data.totpRequiredForAdmins} onChange={(e) => void setPolicy(e.target.checked)} />
            Verifica in due passaggi obbligatoria per gli amministratori
          </label>
        ) : (
          <Skeleton lines={1} />
        )}
        <p className="ui-muted ui-small us-p">Gli admin senza 2FA potranno solo attivarla da «Il mio account». Per abilitarla devi averla già attiva tu. Gli installatori possono attivarla quando vogliono.</p>
      </Card>

      {users.error ? (
        <Notice tone="bad">{(users.error as Error).message}</Notice>
      ) : !users.data ? (
        <Skeleton lines={6} />
      ) : (
        <Card padded={false}>
          <div className="us-head">
            <label className="hl-search">
              <Icon name="search" />
              <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Cerca un account" aria-label="Cerca" />
            </label>
            <span className="ui-muted ui-small">
              {users.data.length} account · {users.data.filter((u) => u.active).length} attivi
            </span>
          </div>
          <Table
            rows={rows}
            rowKey={(u) => u.id}
            onRow={(u) => setOpen(u.id)}
            empty="Nessun account trovato."
            columns={[
              { label: 'Username', render: (u) => <strong>{u.username}</strong> },
              { label: 'Ruolo', render: (u) => <Badge tone={u.role === 'admin' ? 'warn' : 'neutral'}>{u.role === 'admin' ? 'Admin' : 'Installatore'}</Badge> },
              { label: 'Stato', render: (u) => <Badge tone={u.active ? 'good' : 'bad'}>{u.active ? 'Attivo' : 'Disabilitato'}</Badge> },
              { label: '2FA', render: (u) => (u.totpEnabled ? <Badge tone="good">attiva</Badge> : u.role === 'admin' ? <Badge tone="warn">no</Badge> : '—') },
              { label: 'Ultimo accesso', render: (u) => date(u.lastLoginAt) },
              { label: 'Provisioning', end: true, render: (u) => u.jobs },
            ]}
          />
        </Card>
      )}

      <Assignments />

      {creating && (
        <NewAccount
          onClose={() => setCreating(false)}
          onDone={async () => {
            setCreating(false);
            await reload();
          }}
        />
      )}
      {current && <AccountDrawer u={current} me={me} templates={(profiles.data ?? []).flatMap((m) => m.templates)} onClose={() => setOpen(null)} onChanged={reload} />}
    </div>
  );
}

function NewAccount({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('installer');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/api/admin/users', { method: 'POST', body: { username: username.trim(), password, role } });
      toast(`Account ${username.trim()} creato`);
      await onDone();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer
      title="Nuovo account"
      onClose={onClose}
      footer={
        <>
          <Button type="submit" form="new-account" variant="primary" busy={busy}>
            Crea account
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Annulla
          </Button>
        </>
      }
    >
      <form id="new-account" className="ui-grid-form us-form" onSubmit={submit}>
        <Field label="Username">
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" placeholder="mario.rossi" required />
        </Field>
        <Field label="Password iniziale" hint="Minimo 12 caratteri: l’utente potrà cambiarla da «Il mio account».">
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={12} required />
        </Field>
        <Field label="Ruolo">
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="installer">Installatore</option>
            <option value="admin">Admin</option>
          </select>
        </Field>
      </form>
    </Drawer>
  );
}

/** One account: password, two-step verification, its templates and modules, state and role. */
function AccountDrawer({ u, me, templates, onClose, onChanged }: { u: Account; me: User; templates: Template[]; onClose: () => void; onChanged: () => Promise<void> }) {
  const [pw, setPw] = useState('');
  const patch = async (body: object, msg: string) => {
    await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body });
    toast(msg);
    await onChanged();
  };
  const mine = templates.filter((t) => t.audience === 'users' && t.users.some((x) => x.id === u.id));
  return (
    <Drawer title={`Account ${u.username}`} onClose={onClose}>
      <div className="ui-row">
        <Badge tone={u.role === 'admin' ? 'warn' : 'neutral'}>{u.role === 'admin' ? 'Admin' : 'Installatore'}</Badge>
        <Badge tone={u.active ? 'good' : 'bad'}>{u.active ? 'Attivo' : 'Disabilitato'}</Badge>
        <span className="ui-muted ui-small">Creato {date(u.createdAt)}</span>
      </div>

      <section className="us-sec">
        <h3>Password</h3>
        <form
          className="us-inline"
          onSubmit={(e) => {
            e.preventDefault();
          }}
        >
          <Field label="Nuova password" hint="Minimo 12 caratteri. Le sessioni esistenti vengono chiuse.">
            <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" minLength={12} />
          </Field>
          <AsyncButton
            type="submit"
            onClick={async () => {
              if (pw.length < 12) throw new Error('Password: minimo 12 caratteri');
              await patch({ password: pw }, 'Password aggiornata: sessioni esistenti revocate');
              setPw('');
            }}
            onError={fail}
          >
            Reimposta password
          </AsyncButton>
        </form>
        {u.totpEnabled && (
          <AsyncButton onClick={async () => confirm(`Azzerare la verifica in due passaggi di ${u.username}? (telefono perso) Le sue sessioni verranno chiuse.`) && (await patch({ resetTotp: true }, 'Verifica in due passaggi azzerata'))} onError={fail}>
            Azzera verifica in due passaggi
          </AsyncButton>
        )}
      </section>

      <section className="us-sec">
        <h3>Template airOS</h3>
        {mine.length ? (
          <ul className="ui-list ui-small">
            {mine.map((t) => (
              <li key={`${t.model}-${t.name}`}>
                {t.model} · {t.name}
                {t.defaultForAssigned ? ' (predefinito per lui/lei)' : ''}
                {t.users.length > 1 ? ` · condiviso con ${t.users.length - 1} altri` : ''}
              </li>
            ))}
          </ul>
        ) : (
          <p className="ui-muted ui-small">Usa i template visibili a tutti. Nessun template riservato.</p>
        )}
        <a className="ui-btn ui-btn-secondary us-link" href={`#/profiles?user=${u.id}`}>
          Crea template personale
        </a>
      </section>

      <section className="us-sec">
        <h3>Funzionalità per questo utente</h3>
        <UserModules u={u} me={me} />
      </section>

      <section className="us-sec">
        <h3>Stato e ruolo</h3>
        {u.id === me.id ? (
          <p className="ui-muted ui-small">Non puoi disabilitare o declassare il tuo account.</p>
        ) : (
          <div className="ui-row">
            <AsyncButton
              variant={u.active ? 'danger' : 'secondary'}
              onClick={async () => {
                if (u.active && !confirm(`Disabilitare ${u.username}? Le sessioni attive verranno chiuse.`)) return;
                await patch({ active: !u.active }, u.active ? 'Account disabilitato' : 'Account abilitato');
              }}
              onError={fail}
            >
              {u.active ? 'Disabilita' : 'Abilita'}
            </AsyncButton>
            <AsyncButton onClick={() => patch({ role: u.role === 'admin' ? 'installer' : 'admin' }, 'Ruolo aggiornato')} onError={fail}>
              {u.role === 'admin' ? 'Rendi installatore' : 'Rendi admin'}
            </AsyncButton>
          </div>
        )}
      </section>
    </Drawer>
  );
}

/** Per-user module overrides: default (the global setting), on, off. */
function UserModules({ u, me }: { u: Account; me: User }) {
  const qc = useQueryClient();
  const key = ['admin', 'users', u.id, 'modules'];
  const q = useQuery({ queryKey: key, queryFn: () => api<UserModule[]>(`/api/admin/users/${u.id}/modules`) });
  const [busy, setBusy] = useState<string | null>(null);
  const set = async (m: UserModule, value: string) => {
    setBusy(m.key);
    try {
      const next = await api<UserModule[]>(`/api/admin/users/${u.id}/modules`, { method: 'PUT', body: { [m.key]: value === '' ? null : value === 'on' } });
      qc.setQueryData(key, next);
      toast(`${m.label}: ${value === '' ? 'predefinito' : value === 'on' ? 'attivo per questo utente' : 'disattivo per questo utente'}`);
      if (u.id === me.id) {
        await loadModules();
        window.dispatchEvent(new Event('cda:modules'));
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(null);
    }
  };
  if (q.error) return <p className="ui-muted ui-small">{(q.error as Error).message}</p>;
  if (!q.data) return <Skeleton lines={4} />;
  return (
    <>
      <p className="ui-muted ui-small us-p">«Predefinito» segue l’impostazione generale di Funzionalità. Le eccezioni valgono solo per questo utente (sull’app dal prossimo accesso).</p>
      <ul className="us-modules">
        {q.data.map((m) => (
          <li key={m.key}>
            <span>
              <strong>{m.label}</strong> <Badge tone={m.effective ? 'good' : 'neutral'}>{m.effective ? 'attivo' : 'spento'}</Badge>
              <span className="ui-muted ui-small us-area">{m.area}</span>
            </span>
            <select className="wo-date" value={m.override === null ? '' : m.override ? 'on' : 'off'} disabled={busy === m.key} onChange={(e) => void set(m, e.target.value)} aria-label={m.label}>
              <option value="">Predefinito ({m.global ? 'attivo' : 'spento'})</option>
              <option value="on">Attivo per questo utente</option>
              <option value="off">Disattivo per questo utente</option>
            </select>
          </li>
        ))}
      </ul>
    </>
  );
}
