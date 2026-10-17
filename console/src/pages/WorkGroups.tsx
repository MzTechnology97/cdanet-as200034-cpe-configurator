import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { AsyncButton, Badge, Button, Card, Drawer, EmptyState, Field, Notice, PageHeader, Skeleton } from '../ui';

/**
 * Gruppi di lavoro (admins and the «direttore tecnico», issue #275): specialists who share their
 * airOS templates, their installation history and their calendar. Nothing else is shared
 * (connectors and secrets stay personal, CDA Net's data stays out); every template and installation
 * keeps its author, and whoever leaves a group stops seeing the others' work at once. The «direttore
 * tecnico» (a specialist with «visibilità piena») sees every specialist's work; the members of his
 * groups never inherit it.
 */

interface Group {
  id: number;
  name: string;
  notes: string;
  updatedAt: string;
  members: Array<{ id: number; username: string; active: boolean }>;
}
interface Account {
  id: number;
  username: string;
  active: boolean;
  fullView?: boolean;
}
const fail = (e: unknown) => toast((e as Error).message, 'bad');
const MESSAGES: Record<string, string> = {
  work_group_name_exists: 'Esiste già un gruppo con questo nome.',
  work_group_specialists_only: 'Nei gruppi di lavoro entrano solo gli specialist.',
};
const apiError = (e: unknown) => new Error(MESSAGES[(e as Error & { body?: { error?: string } }).body?.error ?? ''] ?? (e as Error).message);

export function WorkGroups() {
  const q = useQuery({ queryKey: ['admin', 'work-groups'], queryFn: () => api<{ items: Group[]; specialists: Account[] }>('/api/admin/work-groups') });
  const [edit, setEdit] = useState<Group | 'new' | null>(null);
  const specialists = q.data?.specialists ?? [];
  const remove = async (g: Group) => {
    if (!confirm(`Eliminare il gruppo «${g.name}»? I membri smettono subito di vedere il lavoro degli altri; template e installazioni restano ai loro autori.`)) return;
    await api(`/api/admin/work-groups/${g.id}`, { method: 'DELETE' });
    toast('Gruppo eliminato');
    await q.refetch();
  };
  return (
    <div className="ui-page">
      <PageHeader
        icon="person"
        title="Gruppi di lavoro"
        subtitle="Specialist che condividono template delle CPE, storico provisioning e calendario."
        actions={
          <Button variant="primary" icon="add_circle" onClick={() => setEdit('new')}>
            Nuovo gruppo
          </Button>
        }
      />
      {q.data && <Pyramid groups={q.data.items} specialists={specialists} />}
      <Notice tone="info">
        Nel gruppo si condividono solo i template delle CPE (vederli, usarli e modificarli; li elimina solo chi li ha creati), lo storico provisioning (in sola lettura per gli altri) e il calendario. I connettori e le loro credenziali restano personali; i dati di CDA Net restano fuori, e la copia di un template CDA Net arriva solo a chi può già usare l’originale. Chi esce dal gruppo smette subito di vedere il lavoro degli altri, e gli altri il suo. Uno specialist può stare in più gruppi; i gruppi non si sommano tra loro. Il direttore tecnico (specialist con visibilità piena, in Account) vede il lavoro di tutti gli specialist e gestisce i gruppi: la sua visibilità non passa ai membri.
      </Notice>
      {q.error && <Notice tone="bad">{(q.error as Error).message}</Notice>}
      {!q.data && !q.error && <Skeleton lines={4} />}
      {q.data &&
        (q.data.items.length ? (
          q.data.items.map((g) => (
            <Card
              key={g.id}
              title={g.name}
              actions={
                <div className="ui-row">
                  <Button onClick={() => setEdit(g)}>Modifica</Button>
                  <AsyncButton variant="danger" onClick={() => remove(g)} onError={fail}>
                    Elimina
                  </AsyncButton>
                </div>
              }
            >
              {g.notes && <p className="ui-muted ui-small cn-p">{g.notes}</p>}
              <div className="ui-row">
                {g.members.length ? (
                  g.members.map((m) => (
                    <Badge key={m.id} tone={m.active ? 'info' : 'neutral'}>
                      {m.username}
                      {m.active ? '' : ' (disattivato)'}
                    </Badge>
                  ))
                ) : (
                  <span className="ui-muted ui-small">Nessun membro</span>
                )}
              </div>
            </Card>
          ))
        ) : (
          <EmptyState icon="person" title="Nessun gruppo di lavoro">
            Ogni specialist vede solo il proprio lavoro. Crea un gruppo per far condividere a più specialist template, storico e calendario.
          </EmptyState>
        ))}
      {edit && (
        <GroupDrawer
          group={edit === 'new' ? null : edit}
          specialists={specialists}
          onClose={() => setEdit(null)}
          onSaved={async () => {
            setEdit(null);
            await q.refetch();
          }}
        />
      )}
    </div>
  );
}

function GroupDrawer({ group, specialists, onClose, onSaved }: { group: Group | null; specialists: Account[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(group?.name ?? '');
  const [notes, setNotes] = useState(group?.notes ?? '');
  const [members, setMembers] = useState<number[]>(group?.members.map((m) => m.id) ?? []);
  const toggle = (id: number) => setMembers((x) => (x.includes(id) ? x.filter((y) => y !== id) : [...x, id]));
  const save = async () => {
    if (!name.trim()) throw new Error('Scrivi il nome del gruppo');
    const body = { name: name.trim(), notes: notes.trim(), members };
    try {
      if (group) await api(`/api/admin/work-groups/${group.id}`, { method: 'PUT', body });
      else await api('/api/admin/work-groups', { method: 'POST', body });
    } catch (e) {
      throw apiError(e);
    }
    toast(group ? 'Gruppo aggiornato' : 'Gruppo creato');
    await onSaved();
  };
  return (
    <Drawer
      title={group ? `Gruppo «${group.name}»` : 'Nuovo gruppo di lavoro'}
      onClose={onClose}
      footer={
        <div className="ui-row">
          <AsyncButton variant="primary" onClick={save} onError={fail}>
            Salva
          </AsyncButton>
          <Button variant="ghost" onClick={onClose}>
            Annulla
          </Button>
        </div>
      }
    >
      <Field label="Nome" hint="Per esempio l’azienda o la squadra">
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
      </Field>
      <Field label="Note" hint="Facoltative, solo per gli admin">
        <input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
      </Field>
      <Field label="Specialist del gruppo" hint="Solo gli account specialist possono far parte di un gruppo">
        <div className="wg-members">
          {specialists.length === 0 && <span className="ui-muted ui-small">Nessun account specialist: crealo in Account.</span>}
          {specialists.map((s) => (
            <label key={s.id} className="ui-check">
              <input type="checkbox" checked={members.includes(s.id)} onChange={() => toggle(s.id)} />
              {s.username}
              {!s.active && <span className="ui-muted ui-small"> (disattivato)</span>}
              {s.fullView && <Badge tone="warn">direttore tecnico</Badge>}
            </label>
          ))}
        </div>
      </Field>
    </Drawer>
  );
}

/**
 * The pyramid of who sees what (titolare, 17/10/2026): the admins over everything; the «direttore
 * tecnico» (specialist with «visibilità piena») over every specialist; each group over its members;
 * a specialist without a group sees only his own work.
 */
function Pyramid({ groups, specialists }: { groups: Group[]; specialists: Account[] }) {
  const directors = specialists.filter((s) => s.fullView);
  const grouped = new Set(groups.flatMap((g) => g.members.map((m) => m.id)));
  const alone = specialists.filter((s) => !s.fullView && !grouped.has(s.id));
  const who = (list: Array<{ id: number; username: string; active: boolean }>) =>
    list.length ? list.map((m) => (
      <Badge key={m.id} tone={m.active ? 'info' : 'neutral'}>
        {m.username}
        {m.active ? '' : ' (disattivato)'}
      </Badge>
    )) : <span className="ui-muted ui-small">nessuno</span>;
  return (
    <Card title="Chi vede cosa">
      <ul className="wg-tree">
        <li>
          <strong>Amministratori</strong> <span className="ui-muted ui-small">· tutta la piattaforma</span>
          <ul>
            <li>
              <strong>Direttore tecnico</strong> <span className="ui-muted ui-small">· dati di CDA Net, lavoro di tutti gli specialist, gestione dei gruppi</span>
              <div className="ui-row wg-who">{who(directors)}</div>
              <ul>
                {groups.map((g) => (
                  <li key={g.id}>
                    <strong>{g.name}</strong> <span className="ui-muted ui-small">· template, storico e calendario condivisi tra i membri</span>
                    <div className="ui-row wg-who">{who(g.members)}</div>
                  </li>
                ))}
                <li>
                  <strong>Senza gruppo</strong> <span className="ui-muted ui-small">· solo il proprio lavoro</span>
                  <div className="ui-row wg-who">{who(alone)}</div>
                </li>
              </ul>
            </li>
          </ul>
        </li>
      </ul>
      <p className="ui-muted ui-small cn-p">La visibilità scende dall’alto verso il basso e mai al contrario: i membri di un gruppo non vedono ciò che vede il direttore tecnico, e due gruppi non si sommano.</p>
    </Card>
  );
}
