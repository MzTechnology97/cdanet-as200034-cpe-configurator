import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from '../../../web/js/dom.js';
import { api } from '../lib/api';
import { AsyncButton, Badge, Button, Card, Notice, Skeleton, Table } from '../ui';
import { type Infra, itemLabel, itemNames, Picker, type Zone } from './Picker';

/**
 * Admin (Account): the POPs and APs (and Guasti Enel zones) assigned to each installer. An installer
 * sees only these in the coverage check and in Guasti Enel (impacted POPs/APs), on the web, in the
 * app and in the notifications; their own zones of the outages stay theirs.
 */

interface Assigned {
  id: number;
  username: string;
  active: boolean;
  modules: { coverage: boolean; power_outages: boolean };
  items: Array<{ key: string; name: string }>;
}
interface Data {
  inf: Infra;
  users: Assigned[];
  zones: Zone[];
  installerClients: boolean;
}
const KEY = ['admin', 'assignments'];
const fail = (e: unknown) => toast((e as Error).message, 'bad');

export function Assignments() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: KEY,
    queryFn: async (): Promise<Data> => {
      const [inf, data] = await Promise.all([api<Infra>('/api/admin/infrastructure'), api<Omit<Data, 'inf'>>('/api/admin/assignments')]);
      return { inf, ...data };
    },
    retry: false,
  });
  const [editing, setEditing] = useState<{ user: Assigned; chosen: Set<string> } | null>(null);
  const title = 'POP/AP assegnati agli installatori';

  if (q.error) {
    const e = q.error as Error & { body?: { error?: string } };
    return (
      <Card title={title}>
        <Notice tone="warn">{e.body?.error === 'uisp_not_configured' ? 'Serve UISP configurato (Connettori): POP e AP arrivano da lì.' : e.message}</Notice>
      </Card>
    );
  }
  if (!q.data)
    return (
      <Card title={title}>
        <Skeleton lines={3} />
      </Card>
    );
  const d = q.data;
  const names = itemNames(d.inf, d.zones);

  const save = async () => {
    if (!editing) return;
    for (const it of editing.user.items) if (!names.has(it.key)) names.set(it.key, it.name);
    await api(`/api/admin/assignments/${editing.user.id}`, { method: 'PUT', body: { items: [...editing.chosen].map((key) => ({ key, name: names.get(key) ?? key })) } });
    toast(`Assegnazioni di ${editing.user.username} salvate`);
    setEditing(null);
    await qc.invalidateQueries({ queryKey: KEY });
  };
  const setClients = (on: boolean) =>
    void api('/api/admin/assignments/settings', { method: 'PUT', body: { installerClients: on } }).then(
      () => {
        toast(on ? 'Numero clienti visibile agli installatori' : 'Numero clienti nascosto agli installatori');
        void qc.invalidateQueries({ queryKey: KEY });
      },
      fail,
    );

  return (
    <Card title={title} padded={false}>
      <p className="ui-muted ui-small as-pad">Gli amministratori vedono tutto. Ogni installatore, nella verifica copertura e in Guasti Enel (POP/AP potenzialmente impattati), vede solo i POP e gli AP assegnati qui: sul web, nell’app e nelle notifiche. Le sue zone personali dei guasti restano sue.</p>
      <Table
        rows={d.users}
        rowKey={(u) => u.id}
        empty="Nessun installatore."
        columns={[
          {
            label: 'Installatore',
            render: (u) => (
              <div>
                <strong>{u.username}</strong>
                {!u.active && <div className="ui-muted ui-small">disattivato</div>}
              </div>
            ),
          },
          {
            label: 'Moduli',
            render: (u) => (
              <div className="ui-row">
                <Badge tone={u.modules.coverage ? 'good' : 'neutral'}>Copertura {u.modules.coverage ? 'sì' : 'no'}</Badge>
                <Badge tone={u.modules.power_outages ? 'good' : 'neutral'}>Guasti {u.modules.power_outages ? 'sì' : 'no'}</Badge>
              </div>
            ),
          },
          {
            label: 'Assegnati',
            render: (u) =>
              u.items.length ? (
                <div className="ui-row">
                  {u.items.map((i) => (
                    <Badge key={i.key}>{itemLabel(i)}</Badge>
                  ))}
                </div>
              ) : (
                <span className="ui-muted ui-small">nessuno: copertura vuota, guasti solo nelle sue zone</span>
              ),
          },
          {
            label: '',
            end: true,
            render: (u) => (
              <Button variant="ghost" onClick={() => setEditing({ user: u, chosen: new Set(u.items.map((i) => i.key)) })}>
                Modifica
              </Button>
            ),
          },
        ]}
      />
      <div className="as-pad as-foot">
        <label className="ui-check">
          <input type="checkbox" checked={d.installerClients} onChange={(e) => setClients(e.target.checked)} />
          Mostra agli installatori il numero di clienti (CPE) dei loro POP/AP (guasti, mappe, copertura)
        </label>
        {editing && (
          <section className="as-edit">
            <h3>POP/AP di {editing.user.username}</h3>
            <p className="ui-muted ui-small as-p">Un POP assegnato include tutti i suoi AP.</p>
            <Picker inf={d.inf} zones={d.zones} chosen={editing.chosen} onChange={(chosen) => setEditing({ ...editing, chosen })} popCoversAps />
            <div className="ui-row">
              <AsyncButton variant="primary" onClick={save} onError={fail}>
                Salva assegnazioni di {editing.user.username}
              </AsyncButton>
              <Button variant="ghost" onClick={() => setEditing(null)}>
                Annulla
              </Button>
            </div>
          </section>
        )}
      </div>
    </Card>
  );
}
