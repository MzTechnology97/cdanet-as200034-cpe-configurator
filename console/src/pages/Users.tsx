import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { toast } from '../lib/toast';
import { loadModules } from '../lib/modules';
import { AssignTab, CoverageByPop, InstallerClientsRule, useAssignments } from '../infra/Assignments';
import { countLabel } from '../infra/Picker';
import { api } from '../lib/api';
import type { PageContext, User } from '../shell/routes';
import { AsyncButton, Badge, Button, Card, Drawer, Field, Icon, Notice, PageHeader, Segmented, Skeleton, Table, Tabs } from '../ui';
import { roleLabel } from '../lib/roles';

/**
 * Account (admins): installers and administrators. Disabling an account and resetting its password
 * or its two-step verification close its sessions at once. Per-user modules and templates, the
 * security policy and the POP/AP assigned to each installer (a tab of the account) are here too.
 */

interface Account {
  id: number;
  username: string;
  role: 'admin' | 'installer' | 'specialist';
  active: boolean;
  totpEnabled: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  jobs: number;
  /** Warehouse of the stock (ISP Billing site) and whether CPEs outside it may be installed. */
  warehouseSiteId?: number | null;
  warehouseMinStock?: number | null;
  warehouseSite?: string | null;
  stockBypass?: boolean;
  /** A specialist with «visibilità piena» on CDA Net's data (issue #275). */
  fullView?: boolean;
  /** The work groups of a specialist. */
  workGroups?: Array<{ id: number; name: string }>;
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
  const [show, setShow] = useState<'all' | 'installer' | 'specialist' | 'admin' | 'off'>('all');
  const [view, setView] = useState<'accounts' | 'pops'>('accounts');
  const [openTab, setOpenTab] = useState<'access' | 'infra'>('access');
  const assignments = useAssignments();
  const assigned = new Map((assignments.data?.users ?? []).map((a) => [a.id, a.items.map((i) => i.key)]));
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
  const rows = (users.data ?? []).filter(
    (u) => (!t || u.username.toLowerCase().includes(t) || (u.warehouseSite ?? '').toLowerCase().includes(t)) && (show === 'all' || (show === 'off' ? !u.active : u.active && u.role === show)),
  );
  const n = (pred: (u: Account) => boolean) => (users.data ?? []).filter(pred).length;
  const current = users.data?.find((u) => u.id === open) ?? null;

  return (
    <div className="ui-page">
      <PageHeader
        icon="person"
        title="Account"
        subtitle="Installatori, specialist e amministratori. Disabilitazione e reset revocano subito le sessioni."
        actions={
          <Button variant="primary" icon="add_circle" onClick={() => setCreating(true)}>
            Nuovo account
          </Button>
        }
      />
      <Card title="Regole">
        {security.data ? (
          <label className="ui-check">
            <input type="checkbox" checked={security.data.totpRequiredForAdmins} onChange={(e) => void setPolicy(e.target.checked)} />
            Verifica in due passaggi obbligatoria per gli amministratori e gli specialist
          </label>
        ) : (
          <Skeleton lines={1} />
        )}
        <p className="ui-muted ui-small us-p">Gli admin e gli specialist senza 2FA potranno solo attivarla da «Il mio account». Per abilitarla devi averla già attiva tu. Gli installatori possono attivarla quando vogliono.</p>
        <InstallerClientsRule />
      </Card>

      <Tabs
        value={view}
        onChange={setView}
        tabs={[
          { value: 'accounts', label: 'Account' },
          { value: 'pops', label: 'POP/AP: chi li copre' },
        ]}
      />
      {view === 'pops' ? (
        <Card padded={false}>
          <CoverageByPop
            onOpen={(id) => {
              setOpenTab('infra');
              setOpen(id);
            }}
          />
        </Card>
      ) : (
        <>
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
              <Segmented
                label="Mostra"
                value={show}
                onChange={setShow}
                options={[
                  { value: 'all', label: `Tutti ${users.data.length}` },
                  { value: 'installer', label: `Installatori ${n((u) => u.active && u.role === 'installer')}` },
                  { value: 'specialist', label: `Specialist ${n((u) => u.active && u.role === 'specialist')}` },
                  { value: 'admin', label: `Admin ${n((u) => u.active && u.role === 'admin')}` },
                  { value: 'off', label: `Disabilitati ${n((u) => !u.active)}` },
                ]}
              />
            </div>
            <Table
              rows={rows}
              rowKey={(u) => u.id}
              onRow={(u) => {
                    setOpenTab('access');
                    setOpen(u.id);
                  }}
              empty="Nessun account trovato."
              columns={[
                { label: 'Username', render: (u) => <strong>{u.username}</strong> },
                { label: 'Ruolo', render: (u) => <RoleBadge role={u.role} /> },
                { label: 'Stato', render: (u) => <Badge tone={u.active ? 'good' : 'bad'}>{u.active ? 'Attivo' : 'Disabilitato'}</Badge> },
                { label: '2FA', render: (u) => (u.totpEnabled ? <Badge tone="good">attiva</Badge> : u.role !== 'installer' ? <Badge tone="warn">no</Badge> : '—') },
                {
                  label: 'POP/AP',
                  render: (u) =>
                    u.role !== 'installer' ? (
                      <span className="ui-muted ui-small">tutti</span>
                    ) : !assignments.data ? (
                      <span className="ui-muted ui-small">…</span>
                    ) : assigned.get(u.id)?.length ? (
                      <span className="ui-small">{countLabel(assigned.get(u.id)!)}</span>
                    ) : (
                      <Badge tone="warn">nessuno</Badge>
                    ),
                },
                { label: 'Magazzino', render: (u) => (u.warehouseSite ? <span className="ui-small">{u.warehouseSite}{u.stockBypass ? ' · anche fuori magazzino' : ''}</span> : <span className="ui-muted">—</span>) },
                { label: 'Ultimo accesso', render: (u) => date(u.lastLoginAt) },
                { label: 'Provisioning', end: true, render: (u) => u.jobs },
              ]}
            />
          </Card>
        )}

        </>
      )}

      {creating && (
        <NewAccount
          onClose={() => setCreating(false)}
          onDone={async () => {
            setCreating(false);
            await reload();
          }}
        />
      )}
      {current && <AccountDrawer key={`${current.id}-${openTab}`} u={current} me={me} initialTab={current.role === 'installer' ? openTab : 'access'} templates={(profiles.data ?? []).flatMap((m) => m.templates)} onClose={() => setOpen(null)} onChanged={reload} />}
    </div>
  );
}

function NewAccount({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('installer');
  const [stock, setStock] = useState<{ siteId: number | null; bypass: boolean }>({ siteId: null, bypass: false });
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/api/admin/users', { method: 'POST', body: { username: username.trim(), password, role, ...(role === 'installer' ? { warehouseSiteId: stock.siteId, stockBypass: stock.bypass } : {}) } });
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
            <option value="specialist">Specialist</option>
            <option value="admin">Admin</option>
          </select>
        </Field>
        <RoleHint role={role} />
        {role === 'installer' && <WarehouseFields value={stock} onChange={setStock} />}
      </form>
    </Drawer>
  );
}

type AccountTab = 'access' | 'infra' | 'stock' | 'more';

/** One account, in tabs: access (role, state, password, 2FA), POP/AP, warehouse, templates and features. */
function AccountDrawer({ u, me, templates, initialTab = 'access', onClose, onChanged }: { u: Account; me: User; templates: Template[]; initialTab?: AccountTab; onClose: () => void; onChanged: () => Promise<void> }) {
  const [pw, setPw] = useState('');
  const [tab, setTab] = useState<AccountTab>(initialTab);
  const patch = async (body: object, msg: string) => {
    await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body });
    toast(msg);
    await onChanged();
  };
  const mine = templates.filter((t) => t.audience === 'users' && t.users.some((x) => x.id === u.id));
  const installer = u.role === 'installer';
  const tabs: Array<{ value: AccountTab; label: string }> = [
    { value: 'access', label: 'Accesso' },
    ...(installer
      ? [
          { value: 'infra' as const, label: 'POP/AP' },
          { value: 'stock' as const, label: 'Magazzino' },
        ]
      : []),
    { value: 'more', label: 'Template e funzioni' },
  ];
  return (
    <Drawer title={`Account ${u.username}`} onClose={onClose}>
      <div className="ui-row">
        <RoleBadge role={u.role} />
        <Badge tone={u.active ? 'good' : 'bad'}>{u.active ? 'Attivo' : 'Disabilitato'}</Badge>
        <span className="ui-muted ui-small">
          Creato {date(u.createdAt)} · ultimo accesso {date(u.lastLoginAt)}
        </span>
      </div>
      <Tabs value={tab} tabs={tabs} onChange={setTab} />

      {tab === 'access' && (
        <>
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
                {(['installer', 'specialist', 'admin'] as const)
                  .filter((r) => r !== u.role)
                  .map((r) => (
                    <AsyncButton
                      key={r}
                      onClick={async () => {
                        if (r !== 'installer' && !confirm(`Rendere ${u.username} ${r === 'admin' ? 'amministratore' : 'specialist'}? ${r === 'admin' ? 'Gestirà tutta la piattaforma.' : 'Avrà la sua sezione Specialist e vedrà solo il proprio lavoro e quello dei suoi gruppi.'} Le sessioni attive verranno chiuse.`)) return;
                        await patch({ role: r }, 'Ruolo aggiornato');
                      }}
                      onError={fail}
                    >
                      {r === 'admin' ? 'Rendi admin' : r === 'specialist' ? 'Rendi specialist' : 'Rendi installatore'}
                    </AsyncButton>
                  ))}
              </div>
            )}
            <RoleHint role={u.role} />
            {u.role === 'specialist' && (
              <div className="us-full">
                <label className="ui-check">
                  <input
                    type="checkbox"
                    checked={!!u.fullView}
                    onChange={async (e) => {
                      const on = e.target.checked;
                      if (on && !confirm(`Dare a ${u.username} la visibilità piena (direttore tecnico)? Vedrà clienti, rete, interventi e lavoro di CDA Net come un amministratore, potrà fare installazioni CDA Net (con le chiavi Wi-Fi delle reti e la password delle CPE di CDA Net), vedrà il lavoro di tutti gli specialist e gestirà i gruppi di lavoro. La visibilità non passa ai membri dei suoi gruppi. Da dare solo a uno specialist interno all’azienda. Le sue sessioni verranno chiuse.`)) return;
                      try {
                        await patch({ fullView: on }, on ? 'Visibilità piena data' : 'Visibilità piena tolta');
                      } catch (err) {
                        fail(err);
                      }
                    }}
                  />
                  Visibilità piena · direttore tecnico (solo per uno specialist interno)
                </label>
                <p className="ui-muted ui-small us-p">
                  Gruppi di lavoro: {u.workGroups?.length ? u.workGroups.map((g) => g.name).join(', ') : 'nessuno'} · <a href="#/work-groups">Gruppi di lavoro</a>
                </p>
              </div>
            )}
          </section>
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
          </section>
          <section className="us-sec">
            <h3>Verifica in due passaggi</h3>
            {u.totpEnabled ? (
              <AsyncButton onClick={async () => confirm(`Azzerare la verifica in due passaggi di ${u.username}? (telefono perso) Le sue sessioni verranno chiuse.`) && (await patch({ resetTotp: true }, 'Verifica in due passaggi azzerata'))} onError={fail}>
                Azzera verifica in due passaggi
              </AsyncButton>
            ) : (
              <p className="ui-muted ui-small">Non attiva: l’utente la attiva da «Il mio account».</p>
            )}
          </section>
        </>
      )}

      {tab === 'infra' && installer && <AssignTab userId={u.id} username={u.username} />}

      {tab === 'stock' && installer && (
        <section className="us-sec">
          <AccountWarehouse u={u} onSave={(body) => patch(body, 'Magazzino aggiornato')} />
        </section>
      )}

      {tab === 'more' && (
        <>
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
        </>
      )}
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

interface WarehouseSites {
  at: string | null;
  error: string | null;
  sites: Array<{ id: number; name: string; items: number; cpe: number }>;
}

/** The warehouse of an installer or partner (from the last reading of ISPBilling) and the bypass. */
function WarehouseFields({ value, onChange }: { value: { siteId: number | null; bypass: boolean }; onChange: (v: { siteId: number | null; bypass: boolean }) => void }) {
  const q = useQuery({ queryKey: ['admin', 'warehouse', 'sites'], queryFn: () => api<WarehouseSites>('/api/admin/warehouse/sites'), staleTime: 60_000 });
  const sites = q.data?.sites ?? [];
  const known = value.siteId == null || sites.some((s) => s.id === value.siteId);
  return (
    <>
      <Field
        label="Magazzino ISPBilling"
        hint={q.error ? (q.error as Error).message : !q.data ? 'Caricamento dei magazzini…' : q.data.at ? 'Le CPE di questo magazzino sono quelle che può installare.' : 'Il magazzino non è ancora stato letto: aprilo da Magazzino → Aggiorna ora.'}
      >
        <select value={value.siteId ?? ''} onChange={(e) => onChange({ ...value, siteId: e.target.value ? Number(e.target.value) : null })}>
          <option value="">— nessuno (può installare qualunque CPE) —</option>
          {!known && <option value={value.siteId!}>magazzino non più presente</option>}
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.cpe} CPE)
            </option>
          ))}
        </select>
      </Field>
      {value.siteId != null && (
        <label className="ui-check">
          <input type="checkbox" checked={value.bypass} onChange={(e) => onChange({ ...value, bypass: e.target.checked })} />
          Può installare CPE non presenti nel suo magazzino
        </label>
      )}
    </>
  );
}

function AccountWarehouse({ u, onSave }: { u: Account; onSave: (body: { warehouseSiteId: number | null; stockBypass: boolean }) => Promise<void> }) {
  const [v, setV] = useState({ siteId: u.warehouseSiteId ?? null, bypass: !!u.stockBypass });
  const [min, setMin] = useState(u.warehouseMinStock == null ? '' : String(u.warehouseMinStock));
  const saveMin = async () => {
    const r = await api<{ min: number | null; defaultMin: number }>(`/api/admin/users/${u.id}/min-stock`, { method: 'PUT', body: { min: min.trim() === '' ? null : Number(min) } });
    toast(r.min === null ? `Minimo predefinito: ${r.defaultMin} CPE` : `Minimo di ${u.username}: ${r.min} CPE`);
  };
  const changed = v.siteId !== (u.warehouseSiteId ?? null) || v.bypass !== !!u.stockBypass;
  return (
    <div className="us-warehouse">
      <WarehouseFields value={v} onChange={setV} />
      <div className="ui-row">
        <AsyncButton disabled={!changed} onClick={() => onSave({ warehouseSiteId: v.siteId, stockBypass: v.siteId != null && v.bypass })} onError={fail}>
          Salva magazzino
        </AsyncButton>
      </div>
      {v.siteId != null && (
        <div className="ui-row us-min">
          <Field label="CPE minime in magazzino" hint="Sotto questo numero il NOC riceve l’avviso di rifornirlo. Vuoto: il minimo di Impostazioni server.">
            <input type="number" min={0} max={50} inputMode="numeric" value={min} onChange={(e) => setMin(e.target.value)} placeholder="predefinito" />
          </Field>
          <AsyncButton onClick={saveMin} onError={fail}>
            Salva minimo
          </AsyncButton>
        </div>
      )}
    </div>
  );
}

function RoleBadge({ role }: { role: string }) {
  return <Badge tone={role === 'admin' ? 'warn' : role === 'specialist' ? 'info' : 'neutral'}>{roleLabel(role)}</Badge>;
}

/** What a role may do, in a line. */
function RoleHint({ role }: { role: string }) {
  if (role === 'specialist') {
    return (
      <p className="ui-muted ui-small us-p">
        Specialist: lavora in autonomia per altre aziende, anche esterno a CDA Net. Ha la sua sezione (template suoi, connettori UISP delle aziende, storico a parte), gli strumenti tecnici e il flusso Specialist nell’app: niente magazzino, collaudo facoltativo, nessuna approvazione del NOC. Vede solo il proprio lavoro e quello dei suoi gruppi di lavoro (template, storico, calendario); clienti, rete e lavoro di CDA Net, comprese le installazioni CDA Net con le chiavi Wi-Fi e la password delle CPE, solo con la visibilità piena. Account, connettori, impostazioni, privacy, Claude, accessi bloccati e decisioni sul lavoro CDA Net restano agli admin.
      </p>
    );
  }
  if (role === 'admin') return <p className="ui-muted ui-small us-p">Admin: gestisce tutta la piattaforma.</p>;
  return <p className="ui-muted ui-small us-p">Installatore: le proprie installazioni, i POP/AP assegnati, il proprio magazzino.</p>;
}
