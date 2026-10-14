import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useState } from 'react';
import { toast } from '../lib/toast';
import { isOn } from '../lib/modules';
import { AcceptancePanel } from '../jobs/AcceptancePanel';
import { FollowUp, JobKo, KO_REASONS, ReviewPanel } from '../jobs/KoPanels';
import { UispPanel } from '../jobs/UispPanel';
import { api, download } from '../lib/api';
import { keys } from '../lib/query';
import type { PageContext } from '../shell/routes';
import { AsyncButton, Badge, Button, Card, Drawer, EmptyState, Field, Icon, Notice, PageHeader, Skeleton } from '../ui';

/**
 * Storico provisioning: every provisioning (admins) or the user's own (installers), metadata only,
 * never a password. Filters by text, outcome and dates; one job opens in a panel with its
 * acceptance test, KO, network state and stages.
 * #/jobs?q=… and ?status=… (links from Panoramica and from the Telegram notifications).
 */

type Tone = 'good' | 'warn' | 'bad' | 'neutral';
const STATUS: Record<string, [string, Tone]> = { success: ['Completato', 'good'], failed: ['Fallito', 'bad'], prepared: ['Preparato', 'warn'], expired: ['Scaduto', 'neutral'] };
const KO_KIND: Record<string, [string, Tone]> = { postponed: ['Rimandata', 'warn'], definitive: ['KO definitivo', 'bad'] };
const REVIEW: Record<string, [string, Tone]> = { pending: ['Da approvare (NOC)', 'warn'], approved: ['Approvata dal NOC', 'good'], rejected: ['Rifiutata dal NOC', 'bad'] };
const ACCEPTANCE: Record<string, [string, Tone]> = { ok: ['collaudo superato', 'good'], warn: ['collaudo con riserva', 'warn'], bad: ['collaudo non superato', 'bad'] };
const FILTERS: Array<[string, string]> = [
  ['', 'Tutti'],
  ['success', 'Completati'],
  ['failed', 'Falliti'],
  ['prepared', 'Preparati / in corso'],
  ['expired', 'Scaduti'],
  ['ko', 'Rimandate o KO aperte'],
  ['review', 'Da approvare (NOC)'],
];
const SOURCE: Record<string, string> = { gps: 'GPS del telefono', address: 'da indirizzo', manual: 'inserita a mano' };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Job = Record<string, any> & {
  id: string;
  createdAt: string;
  status: string;
  attempts?: number;
  ko?: { kind: string; reason: string } | null;
  review?: string | null;
  acceptance?: string | null;
  photos?: number;
  deviceName?: string;
  pppoeUser?: string;
  model?: string;
  template?: string;
  mac?: string;
  ssid?: string;
  installer?: string;
  uispAuthorizedAt?: string | null;
  uispSite?: string;
};

const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const tone = (map: Record<string, [string, Tone]>, k: string) => map[k] ?? [k, 'neutral'];

function JobBadges({ j }: { j: Job }) {
  const [st, stTone] = tone(STATUS, j.status);
  return (
    <>
      <Badge tone={stTone}>{st}</Badge>
      {(j.attempts ?? 0) > 1 && <span className="ui-muted ui-small">{j.attempts} tentativi</span>}
      {j.ko && <Badge tone={tone(KO_KIND, j.ko.kind)[1]}>{`${tone(KO_KIND, j.ko.kind)[0]} · ${KO_REASONS[j.ko.reason] ?? j.ko.reason}`}</Badge>}
      {j.review && <Badge tone={tone(REVIEW, j.review)[1]}>{tone(REVIEW, j.review)[0]}</Badge>}
      {isOn('acceptance') && j.acceptance && <Badge tone={tone(ACCEPTANCE, j.acceptance)[1]}>{tone(ACCEPTANCE, j.acceptance)[0]}</Badge>}
    </>
  );
}

/** A job prepared from a work order gets MAC and serial from the field (scanned by the installer on site). */
const onSite = (j: { status?: string; mac?: string | null }) => j.status === 'prepared' && !j.mac;
const macText = (j: { status?: string; mac?: string | null }) => j.mac || (onSite(j) ? 'MAC da scansionare sul posto' : '');

export function Jobs({ user, params }: PageContext) {
  const admin = user.role === 'admin';
  const qc = useQueryClient();
  const initialStatus = FILTERS.some(([v]) => v === params.get('status')) ? params.get('status')! : '';
  const [form, setForm] = useState({ q: params.get('q') ?? '', status: initialStatus, from: '', to: '' });
  const [applied, setApplied] = useState(form);
  const [open, setOpen] = useState<Job | null>(null);
  const [followRev, setFollowRev] = useState(0);

  const filters = (limit: string, f = applied) => {
    const p = new URLSearchParams({ limit });
    if (f.q.trim()) p.set('q', f.q.trim());
    if (f.status) p.set('status', f.status);
    if (f.from) p.set('from', f.from);
    if (f.to) p.set('to', f.to);
    return p;
  };
  const list = useQuery({ queryKey: keys.jobs(filters('300').toString()), queryFn: () => api<Job[]>(`/api/provisioning/jobs?${filters('300')}`) });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setApplied(form);
  };
  const setStatus = (status: string) => {
    const f = { ...form, status };
    setForm(f);
    setApplied(f);
  };
  // a decision on a job (NOC review, KO solved): the lists and the panel read again
  const changed = async () => {
    setFollowRev((n) => n + 1);
    await qc.invalidateQueries({ queryKey: ['jobs'] });
    if (open) {
      const fresh = await api<Job[]>(`/api/provisioning/jobs?q=${encodeURIComponent(open.mac || open.id)}&limit=50`).catch(() => []);
      setOpen(fresh.find((x) => x.id === open.id) ?? open);
    }
  };
  const jobs = list.data ?? [];

  return (
    <div className="ui-page">
      <PageHeader
        icon="history"
        title="Storico provisioning"
        subtitle={admin ? 'Tutti gli installatori · solo metadati, nessuna password' : 'I tuoi provisioning · solo metadati'}
        actions={
          isOn('csv_export') && (
            <AsyncButton icon="arrow_forward" onClick={() => download(`/api/provisioning/jobs.csv?${filters('5000')}`, 'storico-provisioning.csv')} onError={(e) => toast((e as Error).message, 'bad')}>
              Esporta CSV
            </AsyncButton>
          )
        }
      />
      <FollowUp key={followRev} admin={admin} onOpenJob={(j) => setOpen(j as Job)} />

      <form className="jb-filters" onSubmit={submit}>
        <label className="hl-search">
          <Icon name="search" />
          <input type="search" value={form.q} onChange={(e) => setForm({ ...form, q: e.target.value })} placeholder="MAC, seriale, utente RADIUS, SSID, cliente…" aria-label="Ricerca" />
        </label>
        <Field label="Dal">
          <input type="date" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} />
        </Field>
        <Field label="Al">
          <input type="date" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} />
        </Field>
        <Button type="submit" variant="primary" icon="search" busy={list.isFetching}>
          Cerca
        </Button>
      </form>
      <div className="jb-chips" role="group" aria-label="Esito">
        {FILTERS.map(([v, label]) => (
          <button key={v} type="button" className={`nw-chip${applied.status === v ? ' on' : ''}`} aria-pressed={applied.status === v} onClick={() => setStatus(v)}>
            {label}
          </button>
        ))}
      </div>

      {list.error ? (
        <Notice tone="bad">{(list.error as Error).message}</Notice>
      ) : !list.data ? (
        <Skeleton lines={8} />
      ) : (
        <Card padded={false}>
          <div className="hl-count">
            {jobs.length} provisioning{jobs.length >= 300 ? ' (i più recenti: restringi con i filtri)' : ''}
          </div>
          {jobs.length ? (
            <ul className="hl-list">
              {jobs.map((j) => (
                <li key={j.id} className={`hl-row jb-row ui-tone-${tone(STATUS, j.status)[1]}`} role="button" tabIndex={0} onClick={() => setOpen(j)} onKeyDown={(e) => e.key === 'Enter' && setOpen(j)}>
                  <span className="hl-dot" />
                  <div className="hl-main">
                    <div className="hl-name">
                      <strong>{j.deviceName || j.pppoeUser || j.mac || '—'}</strong>
                      {j.deviceName && j.pppoeUser && <span className="ui-muted ui-small">{j.pppoeUser}</span>}
                    </div>
                    <div className="hl-sub">{[j.model, macText(j), j.ssid, j.template && `template ${j.template}`].filter(Boolean).join(' · ')}</div>
                    <div className="ui-row hl-badges">
                      <JobBadges j={j} />
                      {!!j.photos && <span className="ui-muted ui-small">{j.photos} foto</span>}
                    </div>
                  </div>
                  <div className="hl-signal">
                    <span className="ui-small">{date(j.createdAt)}</span>
                    {admin && j.installer && <span className="ui-muted ui-small">{j.installer}</span>}
                    <span className="ui-muted ui-small">{j.uispAuthorizedAt ? `✓ ${admin ? 'UISP' : 'in rete'}${j.uispSite ? ` · ${j.uispSite}` : ''}` : j.status === 'success' ? 'da accettare in rete' : ''}</span>
                  </div>
                  <Icon name="chevron_right" />
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon="history" title="Nessun provisioning con questi filtri" />
          )}
        </Card>
      )}
      {open && <JobDrawer j={open} admin={admin} onClose={() => setOpen(null)} onChange={changed} />}
    </div>
  );
}

/** One job: the facts, where the CPE is, the acceptance test, KO, network state, stages, error. */
function JobDrawer({ j, admin, onClose, onChange }: { j: Job; admin: boolean; onClose: () => void; onChange: () => Promise<void> }) {
  const fact = (k: string, v: ReactNode) => (
    <div key={k}>
      <dt>{k}</dt>
      <dd>{v ?? '—'}</dd>
    </div>
  );
  return (
    <Drawer title={j.deviceName || `Job ${j.id.slice(0, 8)}`} onClose={onClose}>
      <div className="ui-row">
        <JobBadges j={j} />
      </div>
      <dl className="ui-facts">
        {fact('Creato', date(j.createdAt))}
        {fact('Completato', date(j.completedAt))}
        {fact('Cliente', [j.deviceName, j.pppoeUser].filter(Boolean).join(' · ') || '—')}
        {fact('CPE', [j.model, macText(j)].filter(Boolean).join(' · ') || '—')}
        {fact('SSID', j.ssid || '—')}
        {fact('Template', j.template || '—')}
        {fact('Client', j.client || '—')}
        {fact('Seriale', j.serial || (onSite(j) ? 'da scansionare sul posto' : '—'))}
        {fact('Firmware rilevato', j.detected?.firmware || '—')}
        {fact('Board rilevata', j.detected?.board || '—')}
        {fact('MAC rilevato', j.detected?.mac || '—')}
        {admin && fact('Installatore', j.installer || '—')}
        {fact('Job', <span className="ui-mono ui-small">{j.id}</span>)}
      </dl>
      <section className="jb-sec">
        <h3>Posizione CPE</h3>
        {j.latitude != null ? (
          <p className="ui-small">
            {j.latitude.toFixed(6)}, {j.longitude.toFixed(6)}
            {j.locationAccuracy ? ` · ±${Math.round(j.locationAccuracy)} m` : ''} · {SOURCE[j.locationSource] ?? j.locationSource} ·{' '}
            <a href={`https://www.openstreetmap.org/?mlat=${j.latitude}&mlon=${j.longitude}#map=17/${j.latitude}/${j.longitude}`} target="_blank" rel="noopener noreferrer">
              apri su OpenStreetMap
            </a>
          </p>
        ) : (
          <p className="ui-muted ui-small">Non registrata.</p>
        )}
      </section>
      {j.status === 'success' && isOn('acceptance') && (
        <section className="jb-sec">
          <h3>Collaudo</h3>
          <AcceptancePanel j={j} />
          <ReviewPanel job={j} admin={admin} onChange={() => void onChange()} />
        </section>
      )}
      <JobKo job={j} admin={admin} />
      {j.replacesJobId && <p className="ui-muted ui-small">Sostituisce la CPE del job {j.replacesJobId}</p>}
      {j.status === 'success' && (
        <section className="jb-sec">
          <h3>{admin ? 'UISP' : 'Stato in rete'}</h3>
          <UispPanel job={j} admin={admin} />
        </section>
      )}
      {!!j.stages?.length && (
        <section className="jb-sec">
          <h3>Fasi</h3>
          <ol className="jb-stages">
            {j.stages.map((s: string, i: number) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </section>
      )}
      {j.error && (
        <section className="jb-sec">
          <h3>Errore</h3>
          <pre className="ro-out">{j.error}</pre>
        </section>
      )}
    </Drawer>
  );
}
