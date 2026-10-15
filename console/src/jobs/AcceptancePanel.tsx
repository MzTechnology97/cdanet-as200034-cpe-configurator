import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, download } from '../lib/api';
import { toast } from '../lib/toast';
import { AsyncButton, Badge, Skeleton } from '../ui';

/**
 * "Collaudo" of a job (Storico provisioning): the measures sent by the app, the checks, the notes,
 * the photos and the «Rapporto di collaudo» made by the server as a PDF, to view or to download.
 */

type Tone = 'good' | 'warn' | 'bad' | 'neutral';
const VERDICT: Record<string, [string, Tone]> = { ok: ['superato', 'good'], warn: ['con riserva', 'warn'], bad: ['non superato', 'bad'] };
const MARK: Record<string, string> = { ok: '✔', warn: '⚠', bad: '✖', info: '•' };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Acceptance = Record<string, any> & { verdict: string; createdAt: string; by: string; samples?: number; checks?: Array<{ verdict: string; title: string; detail: string }>; notes?: string; measuredAt?: string };
interface Photo {
  id: number;
  caption?: string | null;
  createdAt: string;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Job = Record<string, any> & { id: string };

const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const n = (v: unknown, unit: string, digits = 0) => (v == null ? '—' : `${Number(v).toFixed(digits)} ${unit}`);

export const AcceptanceBadge = ({ v }: { v?: string | null }) => (v ? <Badge tone={VERDICT[v]?.[1] ?? 'neutral'}>{VERDICT[v]?.[0] ?? v}</Badge> : null);

function measures(a: Acceptance): Array<[string, string]> {
  const r = a.radio ?? {};
  return [
    ['Segnale', r.signal != null ? `${r.signal} dBm${r.signalMin != null ? ` (min ${r.signalMin} / max ${r.signalMax})` : ''}` : '—'],
    ['Segnale atteso', n(r.expectedSignal, 'dBm')],
    ['Segnale lato AP', n(r.remoteSignal, 'dBm')],
    ['Catene', r.chains?.length ? `${r.chains.join(' / ')} dBm` : '—'],
    ['Rumore', n(r.noise, 'dBm')],
    ['CINR', n(r.cinrRx, 'dB')],
    ['Capacità', r.dlCapacityMbps != null ? `${Math.round(r.dlCapacityMbps)} / ${Math.round(r.ulCapacityMbps ?? 0)} Mbit/s` : '—'],
    ['AP', [a.cpe?.apName, a.cpe?.essid].filter(Boolean).join(' · ') || '—'],
    ['Distanza', a.cpe?.distanceM != null ? (a.cpe.distanceM >= 1000 ? `${(a.cpe.distanceM / 1000).toFixed(1)} km` : `${a.cpe.distanceM} m`) : '—'],
    ['Porta LAN', a.lan ? (a.lan.plugged ? `${a.lan.speedMbps} Mbit/s ${a.lan.fullDuplex ? 'full' : 'half'}` : 'scollegata') : '—'],
    ['PPPoE', a.pppoe?.enabled ? a.pppoe.ip || 'non attivo' : '—'],
    ['Internet (dal cliente)', a.internet?.tested ? `${n(a.internet.downloadMbps, '↓ Mbit/s', 1)} · ${n(a.internet.uploadMbps, '↑ Mbit/s', 1)} · ping ${n(a.internet.pingMs, 'ms')}` : a.internet?.note || 'non misurato'],
    ['Firmware', a.cpe?.firmware || '—'],
    ['Altezza CPE dal suolo', a.cpeHeightM != null ? `${String(a.cpeHeightM).replace('.', ',')} m` : '—'],
  ];
}

/** A photo of the job as a data: URL (the request needs the session). */
async function photoUrl(jobId: string, id: number): Promise<string> {
  const r = await api<Response>(`/api/provisioning/jobs/${jobId}/photos/${id}`, { raw: true });
  if (!r.ok) throw new Error(`foto ${id}: HTTP ${r.status}`);
  const blob = await r.blob();
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.readAsDataURL(blob);
  });
}

/** The «Rapporto di collaudo» (PDF made by the server) of a job: opened in a new tab, or downloaded. */
async function openReport(jobId: string) {
  // the tab opens now, while the click counts: a window opened after the download is blocked
  const w = window.open('', '_blank');
  try {
    const r = await api<Response>(`/api/provisioning/jobs/${jobId}/acceptance.pdf?view=1`, { raw: true });
    if (!r.ok) throw new Error(r.status === 404 ? 'Collaudo non ancora inviato.' : `Rapporto non disponibile (HTTP ${r.status})`);
    const url = URL.createObjectURL(await r.blob());
    if (w) w.location.href = url;
    else window.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) {
    w?.close();
    throw e;
  }
}

/** One photo of the job, read with the session when it scrolls into the panel. */
function JobPhoto({ jobId, p }: { jobId: string; p: Photo }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    photoUrl(jobId, p.id).then(
      (s) => live && setSrc(s),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [jobId, p.id]);
  return (
    <figure className="jb-photo">
      {failed ? <span className="ui-muted ui-small">foto non disponibile</span> : src ? <img src={src} alt={p.caption || `Foto ${p.id}`} /> : <div className="ui-sk jb-photo-sk" />}
      <figcaption className="ui-muted ui-small">{p.caption || `Foto ${p.id}`}</figcaption>
    </figure>
  );
}

export function AcceptancePanel({ j }: { j: Job }) {
  const q = useQuery({ queryKey: ['jobs', j.id, 'acceptance'], queryFn: () => api<{ acceptance: Acceptance | null; photos: Photo[] }>(`/api/provisioning/jobs/${j.id}/acceptance`) });
  if (q.error) return <p className="ui-muted ui-small">Collaudo non disponibile: {(q.error as Error).message}</p>;
  if (!q.data) return <Skeleton lines={3} />;
  const { acceptance: a, photos } = q.data;
  if (!a && !photos.length) return <p className="ui-muted ui-small">Collaudo non ancora eseguito: si fa dall’app (Storico → job → Collaudo).</p>;
  return (
    <div className="jb-acceptance">
      {a ? (
        <>
          <div className="ui-row">
            <AcceptanceBadge v={a.verdict} />
            <span className="ui-small">
              {date(a.createdAt)} · {a.by}
              {(a.samples ?? 0) > 1 ? ` · media di ${a.samples} letture` : ''}
            </span>
          </div>
          <dl className="ui-facts">
            {measures(a).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          {!!a.checks?.length && (
            <ul className="jb-checks">
              {a.checks.map((c, i) => (
                <li key={i} className={`jb-check ${c.verdict}`}>
                  <span aria-hidden="true">{MARK[c.verdict] ?? ''}</span> <strong>{c.title}</strong>: {c.detail}
                </li>
              ))}
            </ul>
          )}
          {a.notes && (
            <p className="ui-small jb-p">
              <strong>Note: </strong>
              {a.notes}
            </p>
          )}
        </>
      ) : (
        <p className="ui-muted ui-small">Misure non ancora inviate.</p>
      )}
      {photos.length > 0 && (
        <div className="jb-photos">
          {photos.map((p) => (
            <JobPhoto key={p.id} jobId={j.id} p={p} />
          ))}
        </div>
      )}
      {a && (
        <div className="ui-row">
          <AsyncButton icon="menu_book" onClick={() => openReport(j.id)} onError={(e) => toast((e as Error).message, 'bad')}>
            Visualizza rapporto
          </AsyncButton>
          <AsyncButton icon="arrow_forward" onClick={() => download(`/api/provisioning/jobs/${j.id}/acceptance.pdf`, `collaudo-${j.id.slice(0, 8)}.pdf`)} onError={(e) => toast((e as Error).message, 'bad')}>
            Scarica PDF
          </AsyncButton>
        </div>
      )}
    </div>
  );
}
