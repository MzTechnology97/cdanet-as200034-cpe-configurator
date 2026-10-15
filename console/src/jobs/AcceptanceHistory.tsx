import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { toast } from '../lib/toast';
import { AsyncButton, Badge } from '../ui';
import { type Acceptance, AcceptanceBadge, measures, photoUrl } from './AcceptancePanel';

/**
 * The earlier acceptance tests of an installation: every re-pointing keeps the test it replaced,
 * with its photos and the NOC's decision. Admins also see who may save re-pointings on an
 * installation of someone else's (taken on site, for a few hours) and can end that access.
 */

type HistoryItem = Acceptance & {
  id: number;
  kind: 'install' | 'repoint';
  createdAt: string;
  archivedAt: string;
  username: string | null;
  reviewer: string | null;
  review: string | null;
  reviewReason?: string | null;
  reviewNote?: string | null;
  workOrderId: number | null;
  photos: Array<{ id: number; caption?: string | null; createdAt: string }>;
};
const KIND: Record<string, string> = { install: 'Installazione', repoint: 'Ripuntamento' };
const REVIEW: Record<string, [string, 'good' | 'warn' | 'bad']> = { pending: ['da approvare', 'warn'], approved: ['approvato dal NOC', 'good'], rejected: ['rifiutato dal NOC', 'bad'] };
const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');

/** The photos of an earlier test, loaded when it is opened. */
function Photos({ jobId, photos }: { jobId: string; photos: HistoryItem['photos'] }) {
  const q = useQuery({ queryKey: ['jobs', jobId, 'history-photos', photos.map((p) => p.id).join(',')], queryFn: () => Promise.all(photos.map((p) => photoUrl(jobId, p.id))), enabled: photos.length > 0, staleTime: Infinity });
  if (!photos.length) return null;
  return (
    <div className="ah-photos">
      {photos.map((p, i) => (q.data?.[i] ? <img key={p.id} src={q.data[i]} alt={p.caption || 'foto del collaudo'} title={p.caption || ''} /> : <span key={p.id} className="ah-ph" />))}
    </div>
  );
}

function Test({ jobId, t }: { jobId: string; t: HistoryItem }) {
  const [open, setOpen] = useState(false);
  const r = t.radio ?? {};
  const rv = t.review ? REVIEW[t.review] : undefined;
  return (
    <li className="ah-item">
      <button type="button" className="ah-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="ui-small ah-date">{date(t.createdAt)}</span>
        <Badge tone={t.kind === 'repoint' ? 'info' : 'neutral'}>{KIND[t.kind] ?? t.kind}</Badge>
        <AcceptanceBadge v={t.verdict} />
        {rv && <Badge tone={rv[1]}>{rv[0]}</Badge>}
        <span className="ui-small ah-sum">
          {[r.signal != null ? `${r.signal} dBm` : null, t.cpe?.apName, t.username, t.workOrderId ? `intervento #${t.workOrderId}` : null].filter(Boolean).join(' · ')}
        </span>
        <span className="ui-muted ui-small">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="ah-body">
          <dl className="ui-facts">
            {measures(t).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          {!!t.checks?.length && (
            <ul className="ah-checks ui-small">
              {t.checks.map((c, i) => (
                <li key={i}>
                  <strong>{c.title}</strong>: {c.detail}
                </li>
              ))}
            </ul>
          )}
          {t.notes && <p className="wo-notes">{t.notes}</p>}
          {t.review && (
            <p className="ui-small ui-muted">
              Decisione del NOC{t.reviewer ? ` (${t.reviewer})` : ''}: {REVIEW[t.review]?.[0] ?? t.review}
              {t.reviewNote ? ` · ${t.reviewNote}` : ''}
              {t.reviewReason ? ` · motivo: ${t.reviewReason}` : ''}
            </p>
          )}
          <Photos jobId={jobId} photos={t.photos} />
          <p className="ui-muted ui-small">Sostituito dal collaudo successivo il {date(t.archivedAt)}.</p>
        </div>
      )}
    </li>
  );
}

export function AcceptanceHistory({ jobId }: { jobId: string }) {
  const q = useQuery({ queryKey: ['jobs', jobId, 'acceptance-history'], queryFn: () => api<{ items: HistoryItem[] }>(`/api/provisioning/jobs/${jobId}/acceptance/history`), retry: false });
  if (!q.data?.items.length) return null;
  return (
    <>
      <h4 className="jb-h4">Collaudi precedenti · {q.data.items.length}</h4>
      <ul className="ah-list">
        {q.data.items.map((t) => (
          <Test key={t.id} jobId={jobId} t={t} />
        ))}
      </ul>
    </>
  );
}

/** Admins: the technicians who took this installation of someone else's for a re-pointing. */
export function RepointGrants({ jobId }: { jobId: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['jobs', jobId, 'repoint-grants'], queryFn: () => api<{ hours: number; items: Array<{ userId: number; username: string; grantedAt: string; active: boolean }> }>(`/api/admin/provisioning/jobs/${jobId}/repoint-grants`), retry: false });
  if (!q.data?.items.length) return null;
  return (
    <>
      <h4 className="jb-h4">Ripuntamento da altri installatori</h4>
      <ul className="ah-list">
        {q.data.items.map((g) => (
          <li key={g.userId} className="ah-grant">
            <strong>{g.username}</strong>
            <span className="ui-small ui-muted">presa sul posto il {date(g.grantedAt)}</span>
            {g.active ? <Badge tone="warn">accesso attivo fino al {date(new Date(Date.parse(g.grantedAt) + q.data.hours * 3_600_000).toISOString())}</Badge> : <Badge>scaduto</Badge>}
            {g.active && (
              <AsyncButton
                variant="ghost"
                onClick={async () => {
                  if (!confirm(`Togliere a ${g.username} l’accesso al collaudo di questa installazione?`)) return;
                  await api(`/api/admin/provisioning/jobs/${jobId}/repoint-grants/${g.userId}`, { method: 'DELETE' });
                  toast('Accesso revocato');
                  await qc.invalidateQueries({ queryKey: ['jobs', jobId, 'repoint-grants'] });
                }}
                onError={(e) => toast((e as Error).message, 'bad')}
              >
                Revoca
              </AsyncButton>
            )}
          </li>
        ))}
      </ul>
      <p className="ui-muted ui-small">Un installatore può prendere sul posto la CPE installata da un altro per ripuntarla: solo collaudo e foto, mai le credenziali, per {q.data.hours} ore. Il NOC riceve l’avviso a ogni presa.</p>
    </>
  );
}
