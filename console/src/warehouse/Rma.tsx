import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { Badge, Card, EmptyState, Notice, Segmented, Skeleton, Table } from '../ui';
import { canManage } from '../lib/roles';

/**
 * Magazzino → «CPE smontate»: every CPE taken off in a replacement, from «da rientrare» to its end
 * (back in the warehouse, in repair, scrapped, used again), with what the installer said of it.
 */

type State = 'to_return' | 'returned' | 'repair' | 'scrapped' | 'reused';
interface Rma {
  id: number;
  createdAt: string;
  mac: string;
  model: string;
  customer: string;
  condition: 'unknown' | 'working' | 'broken';
  state: State;
  note: string;
  removedBy: string | null;
  updatedAt: string;
  updatedBy: string | null;
}
const STATE: Record<State, [string, 'warn' | 'good' | 'info' | 'bad' | 'neutral']> = {
  to_return: ['da rientrare', 'warn'],
  returned: ['rientrata', 'good'],
  repair: ['in riparazione', 'info'],
  scrapped: ['rottamata', 'neutral'],
  reused: ['riutilizzata', 'good'],
};
const CONDITION: Record<string, [string, 'good' | 'bad' | 'neutral']> = { working: ['funzionante', 'good'], broken: ['guasta', 'bad'], unknown: ['da verificare', 'neutral'] };
const date = (iso: string) => new Date(iso).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit' });

export function RmaCard() {
  const qc = useQueryClient();
  const [show, setShow] = useState<'open' | 'all'>('open');
  const q = useQuery({ queryKey: ['warehouse', 'rma', show], queryFn: () => api<{ items: Rma[]; counts: Partial<Record<State, number>> }>(`/api/admin/rma?state=${show}`) });
  const set = async (r: Rma, body: { state?: State; note?: string }) => {
    try {
      await api(`/api/admin/rma/${r.id}`, { method: 'PUT', body });
      await qc.invalidateQueries({ queryKey: ['warehouse', 'rma'] });
    } catch (e) {
      toast((e as Error).message, 'bad');
    }
  };
  const c = q.data?.counts ?? {};
  return (
    <Card
      title="CPE smontate nelle sostituzioni"
      actions={
        <Segmented
          label="Mostra"
          value={show}
          onChange={setShow}
          options={[
            { value: 'open', label: `Da chiudere (${(c.to_return ?? 0) + (c.repair ?? 0)})` },
            { value: 'all', label: 'Tutte' },
          ]}
        />
      }
    >
      {q.error && <Notice tone="bad">{(q.error as Error).message}</Notice>}
      {!q.data && !q.error && <Skeleton lines={3} />}
      {q.data &&
        (q.data.items.length ? (
          <Table
            rows={q.data.items}
            rowKey={(r) => r.id}
            columns={[
              { label: 'Smontata', render: (r) => <span className="ui-small">{date(r.createdAt)}{r.removedBy ? ` · ${r.removedBy}` : ''}</span> },
              {
                label: 'CPE',
                render: (r) => (
                  <span>
                    <strong>{r.customer || r.mac}</strong>
                    <span className="ui-muted ui-small"> · {r.model} · {r.mac}</span>
                  </span>
                ),
              },
              { label: 'Come sta', render: (r) => <Badge tone={CONDITION[r.condition]![1]}>{CONDITION[r.condition]![0]}</Badge> },
              {
                label: 'Stato',
                render: (r) =>
                  !canManage() ? (
                    <Badge>{STATE[r.state]?.[0] ?? r.state}</Badge>
                  ) : (
                  <select className="wo-date" value={r.state} onChange={(e) => void set(r, { state: e.target.value as State })} aria-label="Stato">
                    {Object.entries(STATE).map(([k, [l]]) => (
                      <option key={k} value={k}>
                        {l}
                      </option>
                    ))}
                  </select>
                  ),
              },
              {
                label: 'Nota',
                render: (r) =>
                  !canManage() ? (
                    <span className="ui-small">{r.note || '—'}</span>
                  ) : (
                  <input
                    className="wo-date rma-note"
                    defaultValue={r.note}
                    placeholder="—"
                    onBlur={(e) => e.target.value.trim() !== r.note && void set(r, { note: e.target.value.trim() })}
                    aria-label="Nota"
                  />
                ),
              },
            ]}
          />
        ) : (
          <EmptyState title={show === 'open' ? 'Nessuna CPE da rientrare' : 'Nessuna sostituzione'}>Ogni sostituzione aggiunge qui la CPE smontata; l’installatore indica dall’app se funziona o è guasta.</EmptyState>
        ))}
      <p className="ui-muted ui-small">Stati: {Object.values(STATE).map(([l]) => l).join(', ')}. Lo scarico o il carico in ISPBilling resta da fare a mano.</p>
    </Card>
  );
}
