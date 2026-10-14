import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from '../lib/toast';
import { api } from '../lib/api';
import { AsyncButton, Badge, Card, Field, Notice, Skeleton, Table } from '../ui';

/**
 * Postponed installations and definitive KOs reported by the installers, and the NOC approval of
 * an acceptance test with poor radio: the card "Da seguire" on top of Storico provisioning and the
 * sections of one job.
 */

type Tone = 'good' | 'warn' | 'bad' | 'neutral';
export const KO_REASONS: Record<string, string> = {
  no_signal: 'Segnale insufficiente o nessun AP',
  no_link: 'La CPE non si aggancia',
  obstacles: 'Ostacoli, nessuna visibilità',
  cpe_fault: 'CPE guasta',
  no_access: 'Cliente assente o accesso impossibile',
  weather: 'Maltempo',
  material: 'Materiale mancante',
  other: 'Altro',
};
export const KO_STEPS: Record<string, string> = { config: 'Configurazione', write: 'Scrittura nella CPE', verify: 'Verifica della CPE', link: "Aggancio all'AP", aim: 'Puntamento', final: 'Verifica finale e collaudo' };
export const KO_KIND: Record<string, [string, Tone]> = { postponed: ['Rimandata', 'warn'], definitive: ['KO definitivo', 'bad'] };
export const REVIEW: Record<string, [string, Tone]> = { pending: ['Da approvare (NOC)', 'warn'], approved: ['Approvata dal NOC', 'good'], rejected: ['Rifiutata dal NOC', 'bad'] };

interface Ko {
  id: number;
  createdAt: string;
  kind: string;
  attempts?: number;
  deviceName?: string;
  pppoeUser?: string;
  mode?: string;
  mac?: string;
  ssid?: string;
  step: string;
  reason: string;
  note?: string;
  retryOn?: string | null;
  signal?: number | null;
  installer?: string;
  resolvedAt?: string | null;
  resolution?: string | null;
  resolvedBy?: string | null;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Job = Record<string, any> & { id: string };

const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const dmy = (d?: string | null) => (d ? d.split('-').reverse().join('/') : '');
const fail = (e: unknown) => toast((e as Error).message, 'bad');
const tone = (map: Record<string, [string, Tone]>, k: string): [string, Tone] => map[k] ?? [k, 'neutral'];

export const KoBadge = ({ ko }: { ko?: { kind: string; reason: string } | null }) => (ko ? <Badge tone={tone(KO_KIND, ko.kind)[1]}>{`${tone(KO_KIND, ko.kind)[0]} · ${KO_REASONS[ko.reason] ?? ko.reason}`}</Badge> : null);
export const ReviewBadge = ({ state }: { state?: string | null }) => (state ? <Badge tone={tone(REVIEW, state)[1]}>{tone(REVIEW, state)[0]}</Badge> : null);

/** The reports as a table; admins can close an open one, saying how it was solved. */
function KoTable({ rows, admin, onChanged }: { rows: Ko[]; admin: boolean; onChanged: () => Promise<unknown> }) {
  const resolve = async (k: Ko) => {
    const note = prompt('Come è stato risolto? (es. "Installata il 14/10 da Mario")');
    if (!note || note.trim().length < 3) return;
    await api(`/api/admin/installs/ko/${k.id}/resolve`, { method: 'POST', body: { note: note.trim() } });
    toast('Segnalazione chiusa');
    await onChanged();
  };
  return (
    <Table
      rows={rows}
      rowKey={(k) => k.id}
      columns={[
        { label: 'Data', render: (k) => date(k.createdAt) },
        {
          label: 'Tipo',
          render: (k) => (
            <span>
              <Badge tone={tone(KO_KIND, k.kind)[1]}>{tone(KO_KIND, k.kind)[0]}</Badge>
              {(k.attempts ?? 0) > 1 && <div className="ui-muted ui-small">tentativo {k.attempts}</div>}
            </span>
          ),
        },
        {
          label: 'Cliente / CPE',
          render: (k) => (
            <div>
              {k.deviceName || k.pppoeUser || (k.mode === 'repoint' ? 'Ripuntamento' : '—')}
              <div className="ui-muted ui-small ui-mono">{[k.mac, k.ssid].filter(Boolean).join(' · ')}</div>
            </div>
          ),
        },
        { label: 'Fase', render: (k) => KO_STEPS[k.step] ?? k.step },
        {
          label: 'Motivo',
          render: (k) => (
            <div>
              <strong>{KO_REASONS[k.reason] ?? k.reason}</strong>
              {k.note && <div className="ui-small">{k.note}</div>}
              {k.retryOn && <div className="ui-muted ui-small">Da riprovare il {dmy(k.retryOn)}</div>}
              {k.signal != null && <div className="ui-muted ui-small">Segnale {k.signal} dBm</div>}
            </div>
          ),
        },
        ...(admin ? [{ label: 'Installatore', render: (k: Ko) => k.installer ?? '—' }] : []),
        {
          label: 'Stato',
          render: (k) =>
            k.resolvedAt ? (
              <div className="ui-small">
                <Badge tone="good">Risolto</Badge>
                <div className="ui-muted">
                  {k.resolution}
                  {k.resolvedBy ? ` · ${k.resolvedBy}` : ''}
                </div>
              </div>
            ) : admin ? (
              <AsyncButton variant="ghost" onClick={() => resolve(k)} onError={fail}>
                Segna come risolto
              </AsyncButton>
            ) : (
              <Badge tone="warn">Aperto</Badge>
            ),
        },
      ]}
    />
  );
}

/** "Da seguire": acceptance tests waiting for the NOC and the open postponed or KO installations. */
export function FollowUp({ admin, onOpenJob }: { admin: boolean; onOpenJob: (j: Job) => void }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['jobs', 'follow-up'],
    queryFn: async () => {
      const [open, review] = await Promise.all([api<Ko[]>('/api/installs/ko?open=1&limit=200'), api<Job[]>('/api/provisioning/jobs?status=review&limit=200')]);
      return { open, review };
    },
  });
  const d = q.data;
  if (!d || (!d.open.length && !d.review.length)) return null;
  return (
    <Card title="Da seguire" padded={false}>
      {d.review.length > 0 && (
        <section className="jb-follow">
          <h3>Collaudi con segnale pessimo da approvare ({d.review.length})</h3>
          <Table
            rows={d.review}
            rowKey={(j) => j.id}
            onRow={onOpenJob}
            columns={[
              { label: 'Data', render: (j) => date(j.createdAt) },
              {
                label: 'Cliente',
                render: (j) => (
                  <div>
                    {j.deviceName || '—'}
                    <div className="ui-muted ui-small">{j.pppoeUser}</div>
                  </div>
                ),
              },
              { label: 'CPE', render: (j) => <span className="ui-mono ui-small">{`${j.mac} · ${j.ssid}`}</span> },
              ...(admin ? [{ label: 'Installatore', render: (j: Job) => j.installer ?? '—' }] : []),
              { label: '', end: true, render: () => (admin ? <span className="ui-small">Apri per decidere →</span> : <ReviewBadge state="pending" />) },
            ]}
          />
        </section>
      )}
      {d.open.length > 0 && (
        <section className="jb-follow">
          <h3>Installazioni rimandate o KO aperte ({d.open.length})</h3>
          <KoTable rows={d.open} admin={admin} onChanged={() => qc.invalidateQueries({ queryKey: ['jobs'] })} />
        </section>
      )}
    </Card>
  );
}

/** The reports of one installation (job detail). */
export function JobKo({ job, admin }: { job: Job; admin: boolean }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['jobs', job.id, 'ko'], queryFn: () => api<Ko[]>(`/api/installs/ko?jobId=${encodeURIComponent(job.id)}`) });
  if (q.error) return <Notice tone="bad">{(q.error as Error).message}</Notice>;
  if (!q.data) return <Skeleton lines={2} />;
  if (!q.data.length) return null;
  return (
    <section className="jb-sec">
      <h3>Rimandi e KO</h3>
      <KoTable rows={q.data} admin={admin} onChanged={() => qc.invalidateQueries({ queryKey: ['jobs'] })} />
    </section>
  );
}

interface Review {
  state: string;
  reason: string;
  by?: string | null;
  at?: string | null;
  note?: string | null;
}

/** NOC approval of an acceptance test with poor radio: the state, and for admins the decision. */
export function ReviewPanel({ job, admin, onChange }: { job: Job; admin: boolean; onChange?: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['jobs', job.id, 'acceptance'], queryFn: () => api<{ acceptance: { review?: Review | null } | null }>(`/api/provisioning/jobs/${job.id}/acceptance`) });
  const [note, setNote] = useState('');
  const r = q.data?.acceptance?.review;
  if (q.error) return <Notice tone="bad">{(q.error as Error).message}</Notice>;
  if (!r) return null;
  const decide = async (decision: 'approved' | 'rejected') => {
    if (decision === 'rejected' && note.trim().length < 3) throw new Error('Scrivi il motivo del rifiuto');
    await api(`/api/admin/provisioning/jobs/${job.id}/review`, { method: 'POST', body: { decision, note: note.trim() } });
    toast(decision === 'approved' ? 'Installazione approvata: l’installatore è stato avvisato' : 'Installazione rifiutata: l’installatore è stato avvisato');
    setNote('');
    await qc.invalidateQueries({ queryKey: ['jobs'] });
    onChange?.();
  };
  return (
    <section className="jb-sec">
      <h3>Approvazione NOC</h3>
      <div className="ui-row">
        <ReviewBadge state={r.state} />
        <span className="ui-small">{r.reason}</span>
      </div>
      {r.state !== 'pending' && (
        <p className="ui-muted ui-small jb-p">
          {r.state === 'approved' ? 'Approvata' : 'Rifiutata'} da {r.by ?? '—'} il {date(r.at)}
          {r.note ? `: ${r.note}` : ''}
        </p>
      )}
      {admin && r.state === 'pending' && (
        <div className="jb-review">
          <Field label="Nota" hint="Per l’installatore: obbligatoria se rifiuti.">
            <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Nota per l’installatore" />
          </Field>
          <div className="ui-row">
            <AsyncButton variant="primary" onClick={() => decide('approved')} onError={fail}>
              Approva
            </AsyncButton>
            <AsyncButton variant="danger" onClick={() => decide('rejected')} onError={fail}>
              Rifiuta
            </AsyncButton>
          </div>
        </div>
      )}
    </section>
  );
}
