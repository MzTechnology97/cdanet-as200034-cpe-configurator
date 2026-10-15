import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { AsyncButton, Badge, Button, Field, Icon, Notice, Skeleton, Table } from '../ui';
import { countLabel, type Infra, itemLabel, itemNames, Picker, type Zone } from './Picker';

/**
 * Admin (Account): the POPs and APs (and Guasti Enel zones) assigned to each installer. An installer
 * sees only these in the coverage check and in Guasti Enel (impacted POPs/APs), on the web, in the
 * app and in the notifications; their own zones of the outages stay theirs. The list of accounts
 * shows how many each one has; the editor is a tab of the account.
 */

export interface Assigned {
  id: number;
  username: string;
  active: boolean;
  modules: { coverage: boolean; power_outages: boolean };
  items: Array<{ key: string; name: string }>;
}
export interface AssignmentsData {
  inf: Infra | null;
  /** Why the POPs/APs could not be read (UISP not configured…). */
  infError: string | null;
  users: Assigned[];
  zones: Zone[];
  installerClients: boolean;
}
export const ASSIGNMENTS_KEY = ['admin', 'assignments'];
const fail = (e: unknown) => toast((e as Error).message, 'bad');

export function useAssignments() {
  return useQuery({
    queryKey: ASSIGNMENTS_KEY,
    queryFn: async (): Promise<AssignmentsData> => {
      const [inf, data] = await Promise.all([
        api<Infra>('/api/admin/infrastructure').then(
          (v) => ({ v, e: null as string | null }),
          (e: Error & { body?: { error?: string } }) => ({ v: null, e: e.body?.error === 'uisp_not_configured' ? 'Serve UISP configurato (Connettori): POP e AP arrivano da lì.' : e.message }),
        ),
        api<Omit<AssignmentsData, 'inf' | 'infError'>>('/api/admin/assignments'),
      ]);
      return { inf: inf.v, infError: inf.e, ...data };
    },
    retry: false,
    staleTime: 60_000,
  });
}

/** key → the other installers who have it (to see at a glance who covers a POP). */
function othersOf(d: AssignmentsData, exceptId: number) {
  const m = new Map<string, string[]>();
  for (const u of d.users) {
    if (u.id === exceptId || !u.active) continue;
    for (const i of u.items) m.set(i.key, [...(m.get(i.key) ?? []), u.username]);
  }
  return m;
}

/** The assignments of one installer: what they have, and the editor. */
export function AssignTab({ userId, username }: { userId: number; username: string }) {
  const qc = useQueryClient();
  const q = useAssignments();
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const [copyFrom, setCopyFrom] = useState('');
  const d = q.data;
  const me = d?.users.find((u) => u.id === userId);
  const others = useMemo(() => (d ? othersOf(d, userId) : new Map<string, string[]>()), [d, userId]);

  if (q.error) return <Notice tone="bad">{(q.error as Error).message}</Notice>;
  if (!d) return <Skeleton lines={4} />;
  if (!me) return <p className="ui-muted ui-small">Solo gli installatori hanno POP/AP assegnati: gli amministratori vedono tutto.</p>;

  const intro = (
    <p className="ui-muted ui-small as-p">
      Nella verifica copertura e in Guasti Enel {username} vede solo i POP e gli AP assegnati qui, sul web, nell’app e nelle notifiche. Un POP include tutti i suoi AP.
      {!me.modules.coverage && !me.modules.power_outages ? ' Copertura e Guasti Enel sono spenti per questo account (scheda Funzioni).' : ''}
    </p>
  );

  if (!chosen) {
    // what they have, grouped: POPs, APs, zones
    const groups = (['pop:', 'ap:', ''] as const).map((prefix) => me.items.filter((i) => (prefix ? i.key.startsWith(prefix) : !i.key.startsWith('pop:') && !i.key.startsWith('ap:'))));
    return (
      <div className="as-tab">
        {intro}
        <div className="as-summary">
          <strong>{countLabel(me.items.map((i) => i.key))}</strong>
          <Button variant="primary" icon="settings_input_antenna" disabled={!d.inf} onClick={() => setChosen(new Set(me.items.map((i) => i.key)))}>
            {me.items.length ? 'Modifica POP/AP' : 'Assegna POP/AP'}
          </Button>
        </div>
        {d.infError && <Notice tone="warn">{d.infError}</Notice>}
        {me.items.length ? (
          groups.map((g, i) =>
            g.length ? (
              <section key={i} className="as-group">
                <h4>{['POP (con tutti i loro AP)', 'AP singoli', 'Zone Guasti Enel'][i]}</h4>
                <ul className="as-chips">
                  {g.map((it) => (
                    <li key={it.key}>{itemLabel(it)}</li>
                  ))}
                </ul>
              </section>
            ) : null,
          )
        ) : (
          <Notice tone="warn">Nessun POP/AP: la sua verifica copertura è vuota e dei guasti vede solo le sue zone personali.</Notice>
        )}
      </div>
    );
  }

  const names = itemNames(d.inf!, d.zones);
  for (const it of me.items) if (!names.has(it.key)) names.set(it.key, it.name);
  const save = async () => {
    // an AP of a chosen POP is already included: not saved twice
    const covered = new Set(d.inf!.pops.filter((p) => chosen.has(`pop:${p.id}`)).flatMap((p) => p.aps.map((a) => `ap:${a.id}`)));
    const keys = [...chosen].filter((k) => !covered.has(k));
    await api(`/api/admin/assignments/${userId}`, { method: 'PUT', body: { items: keys.map((key) => ({ key, name: names.get(key) ?? key })) } });
    toast(`POP/AP di ${username} salvati: ${countLabel(keys)}`);
    setChosen(null);
    await qc.invalidateQueries({ queryKey: ASSIGNMENTS_KEY });
  };
  const copy = (id: string) => {
    const from = d.users.find((u) => String(u.id) === id);
    if (!from) return;
    setChosen(new Set([...chosen, ...from.items.map((i) => i.key)]));
    toast(`Aggiunti i POP/AP di ${from.username}`);
    setCopyFrom('');
  };
  const sources = d.users.filter((u) => u.id !== userId && u.items.length);

  return (
    <div className="as-tab">
      {intro}
      {sources.length > 0 && (
        <Field label="Aggiungi quelli di un altro installatore">
          <select value={copyFrom} onChange={(e) => copy(e.target.value)}>
            <option value="">— scegli —</option>
            {sources.map((u) => (
              <option key={u.id} value={u.id}>
                {u.username} ({countLabel(u.items.map((i) => i.key))})
              </option>
            ))}
          </select>
        </Field>
      )}
      <Picker inf={d.inf!} zones={d.zones} chosen={chosen} onChange={setChosen} popCoversAps others={others} />
      <div className="as-save">
        <AsyncButton variant="primary" onClick={save} onError={fail}>
          Salva ({countLabel(chosen)})
        </AsyncButton>
        <Button variant="ghost" onClick={() => setChosen(null)}>
          Annulla
        </Button>
      </div>
    </div>
  );
}

/** Rules for all installers: whether they see the number of customers of their POPs/APs. */
export function InstallerClientsRule() {
  const qc = useQueryClient();
  const q = useAssignments();
  if (!q.data) return null;
  const setClients = (on: boolean) =>
    void api('/api/admin/assignments/settings', { method: 'PUT', body: { installerClients: on } }).then(
      () => {
        toast(on ? 'Numero clienti visibile agli installatori' : 'Numero clienti nascosto agli installatori');
        void qc.invalidateQueries({ queryKey: ASSIGNMENTS_KEY });
      },
      fail,
    );
  return (
    <label className="ui-check">
      <input type="checkbox" checked={q.data.installerClients} onChange={(e) => setClients(e.target.checked)} />
      Mostra agli installatori il numero di clienti (CPE) dei loro POP/AP (guasti, mappe, copertura)
    </label>
  );
}

/**
 * The other way round, for many accounts and POPs: every POP (and loose AP) with the installers who
 * have it, directly or through one of its APs, and the ones nobody covers. A click on a name opens
 * that account.
 */
export function CoverageByPop({ onOpen }: { onOpen: (userId: number) => void }) {
  const q = useAssignments();
  const [text, setText] = useState('');
  const [onlyEmpty, setOnlyEmpty] = useState(false);
  const d = q.data;
  const rows = useMemo(() => {
    if (!d?.inf) return [];
    const active = d.users.filter((u) => u.active);
    const holders = (key: string) => active.filter((u) => u.items.some((i) => i.key === key));
    const pops = d.inf.pops.map((p) => {
      const whole = holders(`pop:${p.id}`);
      const partial = active.filter((u) => !whole.includes(u) && p.aps.some((a) => u.items.some((i) => i.key === `ap:${a.id}`)));
      return { key: `pop:${p.id}`, name: `POP ${p.name}`, sub: [p.address, `${p.aps.length} AP`, p.stations != null ? `${p.stations} CPE` : null].filter(Boolean).join(' · '), whole, partial, search: [p.name, p.address, ...p.aps.map((a) => a.name)].join(' ').toLowerCase() };
    });
    const loose = d.inf.apsWithoutPop.map((a) => ({ key: `ap:${a.id}`, name: a.name, sub: ['AP senza POP', a.stations != null ? `${a.stations} CPE` : null].filter(Boolean).join(' · '), whole: holders(`ap:${a.id}`), partial: [] as Assigned[], search: `${a.name} ${a.ssid ?? ''}`.toLowerCase() }));
    return [...pops, ...loose].sort((a, b) => a.name.localeCompare(b.name, 'it', { numeric: true }));
  }, [d]);

  if (q.error) return <Notice tone="bad">{(q.error as Error).message}</Notice>;
  if (!d) return <Skeleton lines={6} />;
  if (!d.inf) return <Notice tone="warn">{d.infError}</Notice>;
  const t = text.trim().toLowerCase();
  const empty = rows.filter((r) => !r.whole.length && !r.partial.length).length;
  const shown = rows.filter((r) => (!t || r.search.includes(t) || [...r.whole, ...r.partial].some((u) => u.username.toLowerCase().includes(t))) && (!onlyEmpty || (!r.whole.length && !r.partial.length)));
  const who = (us: Assigned[], tone?: string) =>
    us.map((u) => (
      <button key={u.id} type="button" className={`as-who${tone ? ` ${tone}` : ''}`} onClick={() => onOpen(u.id)} title={`Apri l’account di ${u.username}`}>
        {u.username}
      </button>
    ));
  return (
    <div className="as-bypop">
      <div className="us-head">
        <label className="hl-search">
          <Icon name="search" />
          <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Cerca POP, AP o installatore" aria-label="Cerca" />
        </label>
        <label className="ui-check ui-small">
          <input type="checkbox" checked={onlyEmpty} onChange={(e) => setOnlyEmpty(e.target.checked)} />
          Solo senza installatore ({empty})
        </label>
      </div>
      <Table
        rows={shown}
        rowKey={(r) => r.key}
        empty={onlyEmpty ? 'Ogni POP/AP ha almeno un installatore.' : 'Nessun risultato.'}
        columns={[
          {
            label: 'POP / AP',
            render: (r) => (
              <div>
                <strong>{r.name}</strong>
                <div className="ui-muted ui-small">{r.sub}</div>
              </div>
            ),
          },
          {
            label: 'Installatori',
            render: (r) =>
              r.whole.length || r.partial.length ? (
                <div className="as-whos">
                  {who(r.whole)}
                  {r.partial.length > 0 && (
                    <>
                      <span className="ui-muted ui-small">solo alcuni AP:</span>
                      {who(r.partial, 'partial')}
                    </>
                  )}
                </div>
              ) : (
                <Badge tone="warn">nessuno</Badge>
              ),
          },
        ]}
      />
    </div>
  );
}
