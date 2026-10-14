import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Badge, Button, Skeleton } from '../ui';

/**
 * "Collaudo" of a job (Storico provisioning): the measures sent by the app, the checks, the notes,
 * the photos and the printable installation report ("verbale", browser print → PDF).
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

/** The printable report in a new window (its own page, every value escaped). */
async function printReport(j: Job, a: Acceptance, photos: Photo[]) {
  const w = window.open('', '_blank');
  if (!w) return void alert('Consenti le finestre pop-up per stampare il verbale.');
  w.document.write('<p style="font-family:sans-serif">Preparazione del verbale…</p>');
  const imgs = await Promise.all(photos.map(async (p) => ({ ...p, src: await photoUrl(j.id, p.id).catch(() => '') })));
  const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const rows = (list: Array<[string, string]>) => list.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('');
  const html = `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Verbale installazione ${esc(j.deviceName || j.mac)}</title>
<style>
body{font:13px/1.45 system-ui,sans-serif;color:#111;margin:24px}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:18px 0 6px;border-bottom:1px solid #ccc}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:4px 6px;border-bottom:1px solid #eee;vertical-align:top}th{width:34%;color:#444;font-weight:600}
.v{display:inline-block;padding:2px 8px;border-radius:10px;font-weight:600}.ok{background:#dcfce7}.warn{background:#fef3c7}.bad{background:#fee2e2}
.ph{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.ph figure{margin:0;break-inside:avoid}.ph img{width:100%;border:1px solid #ddd}.ph figcaption{font-size:12px;color:#444}
.sign{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:40px}.sign div{border-top:1px solid #333;padding-top:4px}
@media print{body{margin:10mm}button{display:none}}
</style></head><body>
<button onclick="print()">Stampa / salva PDF</button>
<h1>Verbale di installazione CPE</h1>
<div>CDA Net · AS200034 · collaudo del ${esc(date(a.measuredAt))} · esito <span class="v ${esc(a.verdict)}">${esc(VERDICT[a.verdict]?.[0] ?? a.verdict)}</span></div>
<h2>Installazione</h2><table>${rows([
    ['Cliente', j.deviceName || '—'],
    ['Utente PPPoE', j.pppoeUser],
    ['CPE', `${j.model} · MAC ${j.mac} · S/N ${j.serial || '—'}`],
    ['SSID', j.ssid],
    ['Posizione', j.latitude != null ? `${j.latitude.toFixed(6)}, ${j.longitude.toFixed(6)}` : '—'],
    ['Installatore', a.by || j.installer || '—'],
  ])}</table>
<h2>Misure</h2><table>${rows(measures(a))}</table>
<h2>Controlli</h2><table>${(a.checks ?? []).map((c) => `<tr><th>${MARK[c.verdict] ?? ''} ${esc(c.title)}</th><td>${esc(c.detail)}</td></tr>`).join('')}</table>
${a.notes ? `<h2>Note</h2><p>${esc(a.notes)}</p>` : ''}
${imgs.length ? `<h2>Foto</h2><div class="ph">${imgs.map((p) => `<figure>${p.src ? `<img src="${p.src}">` : ''}<figcaption>${esc(p.caption || `Foto ${p.id}`)} · ${esc(date(p.createdAt))}</figcaption></figure>`).join('')}</div>` : ''}
<div class="sign"><div>L'installatore</div><div>Il cliente</div></div>
</body></html>`;
  w.document.open();
  w.document.write(html);
  w.document.close();
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
          <Button onClick={() => void printReport(j, a, photos)}>Verbale di installazione (stampa / PDF)</Button>
        </div>
      )}
    </div>
  );
}
