import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useState } from 'react';
import { api, download } from '../../lib/api';
import { toast } from '../../lib/toast';
import type { PageContext } from '../../shell/routes';
import { AsyncButton, Badge, Button, Card, Drawer, EmptyState, Field, Icon, Notice, PageHeader, Segmented, Skeleton, Stat, Table } from '../../ui';
import { MyGroups } from './MyGroups';
import { date, myId, type SpecAcceptance, type SpecConnector, type SpecJob, type SpecSummary, STATUS, VERDICT } from './types';

/**
 * Storico Specialist: the specialist's installations for the companies he works for, apart from
 * CDA Net's history, statistics and NOC. They are written by the app (section Specialist); here he
 * checks them: what was written, the optional acceptance test, the authorization in the company's
 * UISP, the CSV for Excel.
 */

type Show = '' | 'success' | 'failed' | 'prepared' | 'to_authorize' | 'no_acceptance';
const SHOW: Array<{ value: Show; label: string }> = [
  { value: '', label: 'Tutte' },
  { value: 'success', label: 'Scritte' },
  { value: 'failed', label: 'Non riuscite' },
  { value: 'to_authorize', label: 'Da autorizzare' },
  { value: 'no_acceptance', label: 'Senza collaudo' },
];
const fail = (e: unknown) => toast((e as Error).message, 'bad');
/** No MAC yet: prepared before connecting to the CPE, the app reads it at the write. */
const macPending = (j: SpecJob) => (j.cpeAtWrite ? 'letto alla scrittura' : '—');

export function SpecialistJobs({ params }: PageContext) {
  const qc = useQueryClient();
  const initial = SHOW.some((s) => s.value === params.get('status')) ? (params.get('status') as Show) : '';
  const [form, setForm] = useState({ q: params.get('q') ?? '', status: initial, connectorId: '', from: '', to: '' });
  const [applied, setApplied] = useState(form);
  const [open, setOpen] = useState<SpecJob | null>(null);
  const query = (f = applied, limit = '200') => {
    const p = new URLSearchParams({ limit });
    if (f.q.trim()) p.set('q', f.q.trim());
    if (f.status) p.set('status', f.status);
    if (f.connectorId) p.set('connectorId', f.connectorId);
    if (f.from) p.set('from', f.from);
    if (f.to) p.set('to', f.to);
    return p.toString();
  };
  const summary = useQuery({ queryKey: ['specialist', 'summary'], queryFn: () => api<SpecSummary>('/api/specialist/summary') });
  const connectors = useQuery({ queryKey: ['specialist', 'connectors'], queryFn: () => api<{ items: SpecConnector[] }>('/api/specialist/connectors') });
  const list = useQuery({ queryKey: ['specialist', 'jobs', applied], queryFn: () => api<{ total: number; items: SpecJob[] }>(`/api/specialist/jobs?${query()}`) });
  const reload = () => qc.invalidateQueries({ queryKey: ['specialist'] });
  const s = summary.data;
  const filterBy = (status: Show) => {
    const next = { ...form, status };
    setForm(next);
    setApplied(next);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setApplied(form);
  };

  return (
    <div className="ui-page">
      <PageHeader
        icon="history"
        title="Storico Specialist"
        subtitle="Le tue installazioni per le aziende per cui lavori, a parte da quelle di CDA Net. Le CPE si configurano dall’app (sezione Specialist); qui controlli cosa è stato scritto, il collaudo e l’autorizzazione nell’UISP dell’azienda."
        actions={
          <AsyncButton icon="arrow_forward" onClick={() => download(`/api/specialist/jobs.csv?${query(applied, '5000')}`, 'storico-specialist.csv')} onError={fail}>
            Esporta CSV
          </AsyncButton>
        }
      />
      <MyGroups shared="lo storico delle installazioni, in sola lettura, e il calendario" />
      <section className="ui-stats" aria-label="Riepilogo">
        <Stat label="installazioni negli ultimi 30 giorni" value={s ? s.jobs30d : '…'} onClick={() => filterBy('')} />
        <Stat label="scritte" value={s ? s.success30d : '…'} tone="good" onClick={() => filterBy('success')} />
        <Stat label="non riuscite" value={s ? s.failed30d : '…'} tone={s?.failed30d ? 'bad' : 'neutral'} onClick={() => filterBy('failed')} />
        <Stat label="da autorizzare in UISP" value={s ? s.toAuthorize : '…'} tone={s?.toAuthorize ? 'warn' : 'good'} onClick={() => filterBy('to_authorize')} />
        <Stat label="i miei template" value={s ? s.templates : '…'} onClick={() => (location.hash = '#/specialist-templates')} />
        <Stat label="i miei connettori" value={s ? s.connectors : '…'} onClick={() => (location.hash = '#/specialist-connectors')} />
      </section>

      <Card>
        <form className="sp-filters" onSubmit={submit}>
          <label className="hl-search">
            <Icon name="search" />
            <input type="search" value={form.q} onChange={(e) => setForm({ ...form, q: e.target.value })} placeholder="Cliente, nome CPE, MAC, SSID, utente PPPoE, azienda…" aria-label="Cerca" />
          </label>
          <select value={form.connectorId} onChange={(e) => setForm({ ...form, connectorId: e.target.value })} aria-label="Azienda">
            <option value="">Tutte le aziende</option>
            {(connectors.data?.items ?? []).map((c) => (
              <option key={c.id} value={String(c.id)}>
                {c.name}
              </option>
            ))}
          </select>
          <input type="date" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} aria-label="Dal" />
          <input type="date" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} aria-label="Al" />
          <Button type="submit" variant="primary" icon="search">
            Cerca
          </Button>
        </form>
        <Segmented label="Mostra" value={form.status} onChange={filterBy} options={SHOW} />
      </Card>

      {list.error ? (
        <Notice tone="bad">{(list.error as Error).message}</Notice>
      ) : !list.data ? (
        <Skeleton lines={6} />
      ) : !list.data.items.length ? (
        <Card>
          <EmptyState icon="history" title={applied.q || applied.status || applied.connectorId || applied.from || applied.to ? 'Nessuna installazione con questi filtri' : 'Ancora nessuna installazione'}>
            Le installazioni si fanno dall’app: sezione Specialist → Nuova configurazione. Prima crea un template in «I miei template» e, se l’azienda usa UISP, il suo connettore in «I miei connettori».
          </EmptyState>
        </Card>
      ) : (
        <Card padded={false} title={`${list.data.total} ${list.data.total === 1 ? 'installazione' : 'installazioni'}${list.data.total > list.data.items.length ? ` (le ultime ${list.data.items.length})` : ''}`}>
          <Table
            rows={list.data.items}
            rowKey={(j) => j.id}
            onRow={setOpen}
            columns={[
              { label: 'Data', render: (j) => <span className="ui-small">{date(j.createdAt)}</span> },
              { label: 'Specialist', render: (j) => (j.authorId === myId() ? <span className="ui-small">io</span> : <Badge tone="neutral">{j.author}</Badge>) },
              { label: 'Azienda', render: (j) => j.company || <span className="ui-muted">—</span> },
              {
                label: 'Cliente',
                render: (j) => (
                  <span>
                    <strong>{j.customer || j.deviceName || '—'}</strong>
                    {j.customer && j.deviceName && <span className="ui-muted ui-small"> · {j.deviceName}</span>}
                  </span>
                ),
              },
              { label: 'CPE', render: (j) => <span className="ui-small">{j.model} · {j.mac ? <span className="ui-mono">{j.mac}</span> : <span className="ui-muted">{macPending(j)}</span>}</span> },
              { label: 'Esito', render: (j) => <Badge tone={STATUS[j.status][1]}>{STATUS[j.status][0]}</Badge> },
              { label: 'Collaudo', render: (j) => (j.acceptance?.verdict ? <Badge tone={VERDICT[j.acceptance.verdict][1]}>{VERDICT[j.acceptance.verdict][0]}</Badge> : <span className="ui-muted ui-small">—</span>) },
              { label: 'UISP', render: (j) => <UispBadge j={j} /> },
            ]}
          />
        </Card>
      )}
      {open && (
        <JobDrawer
          key={open.id}
          j={open}
          onClose={() => setOpen(null)}
          onChanged={async (next) => {
            if (next) setOpen(next);
            await reload();
          }}
          onDeleted={async () => {
            setOpen(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}

function UispBadge({ j }: { j: SpecJob }) {
  if (j.uisp.authorizedAt) return <Badge tone="good">autorizzata{j.uisp.site ? ` · ${j.uisp.site}` : ''}</Badge>;
  // written without the company's key (titolare, 18/10/2026): the CPE has UISP off
  if (j.uisp.off) return <Badge tone="neutral">UISP spento</Badge>;
  if (j.status === 'success' && j.connector) return <Badge tone="warn">da autorizzare</Badge>;
  return <span className="ui-muted ui-small">—</span>;
}

function JobDrawer({ j, onClose, onChanged, onDeleted }: { j: SpecJob; onClose: () => void; onChanged: (next?: SpecJob) => Promise<void>; onDeleted: () => Promise<void> }) {
  const fact = (k: string, v: ReactNode) => (
    <div key={k}>
      <dt>{k}</dt>
      <dd>{v || '—'}</dd>
    </div>
  );
  const mine = j.authorId === myId();
  const remove = async () => {
    if (!confirm(`Eliminare dallo storico l’installazione di «${j.customer || j.deviceName || j.mac || j.model}»? La CPE resta configurata com’è; resta solo la voce nel registro attività.`)) return;
    await api(`/api/specialist/jobs/${j.id}`, { method: 'DELETE' });
    toast('Installazione eliminata dallo storico');
    await onDeleted();
  };
  return (
    <Drawer
      title={j.customer || j.deviceName || `CPE ${j.mac || j.model}`}
      onClose={onClose}
      footer={
        <>
          {mine && (
            <AsyncButton variant="danger" icon="delete" onClick={remove} onError={fail}>
              Elimina dallo storico
            </AsyncButton>
          )}
          <Button onClick={onClose}>Chiudi</Button>
        </>
      }
    >
      {!mine && <Notice tone="info">Installazione di {j.author || 'un altro specialist'} del tuo gruppo di lavoro: in sola lettura. Collaudo e autorizzazione in UISP li fa chi l’ha installata, con i suoi connettori.</Notice>}
      <div className="ui-row">
        <Badge tone={STATUS[j.status][1]}>{STATUS[j.status][0]}</Badge>
        {j.attempts > 1 && <Badge>{j.attempts} scritture</Badge>}
        <UispBadge j={j} />
      </div>
      <dl className="ui-facts">
        {fact('Preparata', date(j.createdAt))}
        {fact('Scritta', date(j.completedAt))}
        {fact('Azienda', j.company)}
        {fact('Cliente', j.customer)}
        {fact('Nome CPE', j.deviceName)}
        {fact('Modello', j.model)}
        {fact('MAC', j.mac ? <span className="ui-mono">{j.mac}</span> : macPending(j))}
        {fact('Seriale', j.serial ? <span className="ui-mono">{j.serial}</span> : '')}
        {fact('Firmware', j.detected.firmware || j.firmware)}
        {fact('Template', j.template)}
        {fact('SSID', j.ssid)}
        {fact('Utente PPPoE', j.pppoeUser)}
      </dl>
      {j.notes && <p className="ui-small sp-p">{j.notes}</p>}
      <section className="jb-sec">
        <h3>Posizione</h3>
        {j.location ? (
          <p className="ui-small">
            {j.location.lat.toFixed(6)}, {j.location.lon.toFixed(6)} ·{' '}
            <a href={`https://www.openstreetmap.org/?mlat=${j.location.lat}&mlon=${j.location.lon}#map=17/${j.location.lat}/${j.location.lon}`} target="_blank" rel="noopener noreferrer">
              apri su OpenStreetMap
            </a>
          </p>
        ) : (
          <p className="ui-muted ui-small">Non registrata.</p>
        )}
      </section>
      {mine && j.status === 'success' && <AcceptanceSection j={j} onChanged={onChanged} />}
      {mine && j.status === 'success' && j.connector && !j.uisp.off && <UispSection j={j} onChanged={onChanged} />}
      {!!j.stages.length && (
        <section className="jb-sec">
          <h3>Fasi della scrittura</h3>
          <ol className="jb-stages">
            {j.stages.map((st, i) => (
              <li key={i}>{st}</li>
            ))}
          </ol>
        </section>
      )}
      {j.error && <Notice tone="bad" title="Errore">{j.error}</Notice>}
      <p className="ui-muted ui-small">Chiave Wi-Fi, password PPPoE e password della CPE non sono mai salvate: il server tiene solo l’impronta (SHA-256) del file scritto. Job {j.id}</p>
    </Drawer>
  );
}

/** The optional acceptance test: the specialist's own judgment (no NOC), from the app or here. */
function AcceptanceSection({ j, onChanged }: { j: SpecJob; onChanged: (next?: SpecJob) => Promise<void> }) {
  const a = j.acceptance;
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState({
    verdict: (a?.verdict ?? 'ok') as 'ok' | 'warn' | 'bad',
    signal: a?.radio?.signal != null ? String(a.radio.signal) : '',
    down: a?.speedtest?.downMbps != null ? String(a.speedtest.downMbps) : '',
    up: a?.speedtest?.upMbps != null ? String(a.speedtest.upMbps) : '',
    notes: a?.notes ?? '',
  });
  const num = (v: string) => (v.trim() === '' ? undefined : Number(v.replace(',', '.')));
  const save = async () => {
    const signal = num(f.signal);
    const down = num(f.down);
    const up = num(f.up);
    if ([signal, down, up].some((x) => x !== undefined && !Number.isFinite(x))) throw new Error('Numeri non validi');
    const body: SpecAcceptance = {
      verdict: f.verdict,
      ...(a?.radio || signal !== undefined ? { radio: { ...(a?.radio ?? {}), ...(signal !== undefined ? { signal } : {}) } } : {}),
      ...(down !== undefined && up !== undefined ? { speedtest: { ...(a?.speedtest ?? {}), downMbps: down, upMbps: up } } : a?.speedtest ? { speedtest: a.speedtest } : {}),
      ...(a?.heightM !== undefined ? { heightM: a.heightM } : {}),
      ...(f.notes.trim() ? { notes: f.notes.trim() } : {}),
    };
    const next = await api<SpecJob>(`/api/specialist/jobs/${j.id}/acceptance`, { method: 'PUT', body });
    toast('Collaudo salvato');
    setEditing(false);
    await onChanged(next);
  };
  const clear = async () => {
    if (!confirm('Togliere il collaudo da questa installazione?')) return;
    const next = await api<SpecJob>(`/api/specialist/jobs/${j.id}/acceptance`, { method: 'DELETE' });
    await onChanged(next);
  };
  return (
    <section className="jb-sec">
      <h3>Collaudo (facoltativo)</h3>
      {a && !editing && (
        <>
          <div className="ui-row">
            {a.verdict && <Badge tone={VERDICT[a.verdict][1]}>{VERDICT[a.verdict][0]}</Badge>}
            <span className="ui-muted ui-small">{date(a.at)}</span>
          </div>
          <dl className="ui-facts sp-facts">
            {a.radio?.signal != null && <Fact k="Segnale" v={`${a.radio.signal} dBm`} />}
            {a.radio?.noise != null && <Fact k="Rumore" v={`${a.radio.noise} dBm`} />}
            {a.radio?.ccq != null && <Fact k="CCQ" v={`${a.radio.ccq}%`} />}
            {a.radio?.capacityDown != null && <Fact k="Capacità" v={`${a.radio.capacityDown}/${a.radio.capacityUp ?? '—'} Mbit/s`} />}
            {a.radio?.apName && <Fact k="AP" v={a.radio.apName} />}
            {a.radio?.distanceM != null && <Fact k="Distanza" v={a.radio.distanceM >= 1000 ? `${(a.radio.distanceM / 1000).toFixed(1)} km` : `${Math.round(a.radio.distanceM)} m`} />}
            {a.speedtest && <Fact k="Speedtest" v={`↓ ${a.speedtest.downMbps} · ↑ ${a.speedtest.upMbps} Mbit/s${a.speedtest.pingMs != null ? ` · ${a.speedtest.pingMs} ms` : ''}`} />}
            {a.heightM != null && <Fact k="Altezza" v={`${a.heightM} m`} />}
          </dl>
          {a.notes && <p className="ui-small sp-p">{a.notes}</p>}
        </>
      )}
      {!a && !editing && <p className="ui-muted ui-small">Nessun collaudo: si fa dall’app dopo la scrittura (misure e speedtest), oppure lo scrivi qui.</p>}
      {editing ? (
        <div className="sp-acc">
          <Segmented label="Esito" value={f.verdict} onChange={(v) => setF({ ...f, verdict: v })} options={[
            { value: 'ok', label: 'Buono' },
            { value: 'warn', label: 'Con riserva' },
            { value: 'bad', label: 'Non buono' },
          ]} />
          <div className="ui-grid-form">
            <Field label="Segnale (dBm)">
              <input inputMode="numeric" value={f.signal} onChange={(e) => setF({ ...f, signal: e.target.value })} placeholder="-58" />
            </Field>
            <Field label="Download (Mbit/s)">
              <input inputMode="decimal" value={f.down} onChange={(e) => setF({ ...f, down: e.target.value })} />
            </Field>
            <Field label="Upload (Mbit/s)">
              <input inputMode="decimal" value={f.up} onChange={(e) => setF({ ...f, up: e.target.value })} />
            </Field>
          </div>
          <Field label="Note">
            <textarea rows={3} maxLength={1000} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
          </Field>
          <div className="ui-row">
            <AsyncButton variant="primary" onClick={save} onError={fail}>
              Salva collaudo
            </AsyncButton>
            <Button onClick={() => setEditing(false)}>Annulla</Button>
          </div>
        </div>
      ) : (
        <div className="ui-row">
          <Button onClick={() => setEditing(true)}>{a ? 'Modifica collaudo' : 'Scrivi il collaudo'}</Button>
          {a && (
            <AsyncButton variant="ghost" onClick={clear} onError={fail}>
              Togli collaudo
            </AsyncButton>
          )}
        </div>
      )}
    </section>
  );
}

function Fact({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}

interface UispState {
  connector: string;
  device: { id: string; name: string; mac: string | null; model: string; authorized: boolean; site: string | null; status: string; signal: number | null } | null;
  proposedSite: { id: string; name: string } | null;
  authorizedAt: string | null;
  site: string | null;
}

/** The CPE in the company's UISP: found by MAC, then authorized in the site of its AP (or the one chosen). */
function UispSection({ j, onChanged }: { j: SpecJob; onChanged: (next?: SpecJob) => Promise<void> }) {
  const q = useQuery({ queryKey: ['specialist', 'jobs', j.id, 'uisp'], queryFn: () => api<UispState>(`/api/specialist/jobs/${j.id}/uisp`), retry: false });
  const pending = !!q.data?.device && !q.data.device.authorized;
  const sites = useQuery({
    queryKey: ['specialist', 'connectors', j.connector?.id, 'sites'],
    queryFn: () => api<Array<{ id: string; name: string }>>(`/api/specialist/connectors/${j.connector!.id}/sites`),
    enabled: pending,
    retry: false,
    staleTime: 5 * 60_000,
  });
  const [site, setSite] = useState('');
  const authorize = async () => {
    const r = await api<{ site: string; job: SpecJob }>(`/api/specialist/jobs/${j.id}/uisp/authorize`, { method: 'POST', body: site ? { siteId: site } : {} });
    toast(`CPE autorizzata in UISP · ${r.site}`);
    await q.refetch();
    await onChanged(r.job);
  };
  const s = q.data;
  return (
    <section className="jb-sec">
      <h3>UISP · {j.connector?.name}</h3>
      {q.error ? (
        <Notice tone="warn">{(q.error as Error).message}</Notice>
      ) : !s ? (
        <Skeleton lines={2} />
      ) : !s.device ? (
        <Notice tone="warn">CPE non ancora presente nell’UISP dell’azienda (ricerca per MAC): dopo il riavvio e il collegamento all’AP può servire qualche minuto.</Notice>
      ) : (
        <>
          <section className="ui-stats" aria-label="Stato in UISP">
            <Stat label="UISP" value={<span className="ac-date">{s.device.authorized ? 'Autorizzata' : 'Da autorizzare'}</span>} tone={s.device.authorized ? 'good' : 'warn'} />
            <Stat label="stato" value={<span className="ac-date">{s.device.status === 'active' ? 'online' : s.device.status || '—'}</span>} />
            <Stat label="segnale" value={<span className="ac-date">{s.device.signal != null ? `${s.device.signal} dBm` : '—'}</span>} />
            <Stat label="site" value={<span className="ac-date">{s.site ?? s.device.site ?? (s.proposedSite ? `${s.proposedSite.name} (proposto)` : '—')}</span>} />
          </section>
          {s.authorizedAt && <p className="ui-muted ui-small">Autorizzata il {date(s.authorizedAt)}</p>}
          {pending && (
            <Field label={s.proposedSite ? `Site (proposto: ${s.proposedSite.name}, quello del suo AP)` : 'Site dell’AP non determinabile: scegli il site'}>
              <select value={site} onChange={(e) => setSite(e.target.value)}>
                <option value="">{s.proposedSite ? `${s.proposedSite.name} (proposto)` : '—'}</option>
                {(sites.data ?? []).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </>
      )}
      <div className="ui-row">
        <AsyncButton icon="refresh" onClick={() => q.refetch()} onError={fail}>
          Aggiorna
        </AsyncButton>
        {pending && (
          <AsyncButton variant="primary" disabled={!site && !s?.proposedSite} onClick={authorize} onError={fail}>
            Autorizza in UISP
          </AsyncButton>
        )}
      </div>
      {j.uisp.error && !j.uisp.authorizedAt && <p className="ui-small ui-muted">Ultimo tentativo non riuscito: {j.uisp.error}</p>}
    </section>
  );
}
