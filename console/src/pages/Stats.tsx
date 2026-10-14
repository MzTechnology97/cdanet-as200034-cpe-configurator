import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { Card, Field, Notice, PageHeader, Skeleton, Stat, Table } from '../ui';

/** Statistiche (admins): installations, acceptance tests and quality per month, installer and model. */

interface Month {
  month: string;
  jobs: number;
  success: number;
  failed: number;
  postponed: number;
  definitive: number;
  acceptances: number;
  acceptOk: number;
  acceptWarn: number;
  acceptBad: number;
  avgSignal: number | null;
  avgDownload: number | null;
  replacements: number;
  uispAccepted: number;
}
interface Installer {
  installer: string;
  jobs: number;
  success: number;
  failed: number;
  acceptances: number;
  acceptWarn: number;
  acceptBad: number;
  avgSignal: number | null;
  lastJob: string | null;
}
interface Data {
  months: Month[];
  installers: Installer[];
  koReasons?: Array<{ label: string; postponed: number; definitive: number; resolved: number }>;
  models: Array<{ model: string; jobs: number; failed: number }>;
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
const monthName = (m: string) => new Date(`${m}-01T00:00:00`).toLocaleDateString('it-IT', { month: 'short', year: '2-digit' });
const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '—');

/** Stacked bars: successful and failed installations per month. */
function MonthChart({ months }: { months: Month[] }) {
  const W = 640;
  const H = 200;
  const P = 24;
  const bw = (W - P * 2) / Math.max(1, months.length);
  const max = Math.max(1, ...months.map((m) => m.jobs));
  const y = (v: number) => H - 24 - (v / max) * (H - 44);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="st-chart" role="img" aria-label="Installazioni per mese">
      {months.map((m, i) => {
        const x = P + i * bw + bw * 0.2;
        const w = bw * 0.6;
        return (
          <g key={m.month}>
            <rect x={x} y={y(m.success)} width={w} height={H - 24 - y(m.success)} rx={3} className="st-ok">
              <title>{`${m.success} riuscite`}</title>
            </rect>
            <rect x={x} y={y(m.success + m.failed)} width={w} height={y(m.success) - y(m.success + m.failed)} rx={3} className="st-ko">
              <title>{`${m.failed} fallite`}</title>
            </rect>
            <text x={x + w / 2} y={y(m.jobs) - 4} textAnchor="middle" className="st-val">
              {m.jobs || ''}
            </text>
            <text x={x + w / 2} y={H - 6} textAnchor="middle" className="st-axis">
              {monthName(m.month)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function Stats() {
  const [months, setMonths] = useState(6);
  const q = useQuery({ queryKey: ['admin', 'stats', months], queryFn: () => api<Data>(`/api/admin/stats?months=${months}`), placeholderData: (prev) => prev });
  const d = q.data;
  const tot = d ? d.months.reduce((a, m) => ({ jobs: a.jobs + m.jobs, success: a.success + m.success, failed: a.failed + m.failed, acc: a.acc + m.acceptances }), { jobs: 0, success: 0, failed: 0, acc: 0 }) : null;

  return (
    <div className="ui-page">
      <PageHeader
        icon="query_stats"
        title="Statistiche"
        subtitle="Installazioni, collaudi e qualità per mese, installatore e modello."
        actions={
          <Field label="Periodo">
            <select value={months} onChange={(e) => setMonths(Number(e.target.value))}>
              {[3, 6, 12, 24].map((n) => (
                <option key={n} value={n}>
                  Ultimi {n} mesi
                </option>
              ))}
            </select>
          </Field>
        }
      />
      {q.error && <Notice tone="bad">{(q.error as Error).message}</Notice>}
      {!d && !q.error && <Skeleton lines={8} />}
      {d && tot && (
        <>
          <section className="ui-stats" aria-label="Totali del periodo">
            <Stat label="provisioning" value={tot.jobs} />
            <Stat label="riuscite" value={tot.success} hint={pct(tot.success, tot.jobs)} tone="good" />
            <Stat label="fallite" value={tot.failed} hint={pct(tot.failed, tot.jobs)} tone={tot.failed ? 'bad' : 'neutral'} />
            <Stat label="collaudate" value={tot.acc} hint={`${pct(tot.acc, tot.success)} delle riuscite`} />
          </section>
          <Card title="Installazioni per mese">
            <MonthChart months={d.months} />
            <p className="ui-muted ui-small st-p">Verde: riuscite · rosso: fallite (tentativi, non installazioni distinte).</p>
          </Card>
          <Card title="Mese per mese" padded={false}>
            <Table
              rows={[...d.months].reverse()}
              rowKey={(m) => m.month}
              columns={[
                { label: 'Mese', render: (m) => monthName(m.month) },
                { label: 'Riuscite', end: true, render: (m) => m.success },
                { label: 'Fallite', end: true, render: (m) => m.failed },
                { label: 'Rimandate / KO', end: true, render: (m) => (m.postponed || m.definitive ? `${m.postponed} / ${m.definitive}` : '—') },
                { label: 'Collaudi (ok / riserva / ko)', end: true, render: (m) => (m.acceptances ? `${m.acceptOk} / ${m.acceptWarn} / ${m.acceptBad}` : '—') },
                { label: 'Segnale medio', end: true, render: (m) => (m.avgSignal != null ? `${m.avgSignal} dBm` : '—') },
                { label: 'Download medio', end: true, render: (m) => (m.avgDownload != null ? `${m.avgDownload} Mbit/s` : '—') },
                { label: 'Sostituzioni', end: true, render: (m) => m.replacements },
                { label: 'Accettate UISP', end: true, render: (m) => m.uispAccepted },
              ]}
            />
          </Card>
          <Card title="Per installatore" padded={false}>
            <Table
              rows={d.installers}
              rowKey={(r) => r.installer}
              empty="Nessun provisioning nel periodo."
              columns={[
                { label: 'Installatore', render: (r) => <strong>{r.installer}</strong> },
                { label: 'Riuscite', end: true, render: (r) => r.success },
                { label: 'Fallite', end: true, render: (r) => `${r.failed} (${pct(r.failed, r.jobs)})` },
                { label: 'Collaudate', end: true, render: (r) => `${r.acceptances} (${pct(r.acceptances, r.success)})` },
                { label: 'Con riserva / ko', end: true, render: (r) => `${r.acceptWarn} / ${r.acceptBad}` },
                { label: 'Segnale medio', end: true, render: (r) => (r.avgSignal != null ? `${r.avgSignal} dBm` : '—') },
                { label: 'Ultimo', render: (r) => date(r.lastJob) },
              ]}
            />
          </Card>
          {!!d.koReasons?.length && (
            <Card title="Rimandi e KO per motivo" padded={false}>
              <p className="ui-muted ui-small st-note">Segnalazioni dei tecnici (ogni tentativo conta: una stessa installazione può essere rimandata più volte).</p>
              <Table
                rows={d.koReasons}
                rowKey={(r) => r.label}
                columns={[
                  { label: 'Motivo', render: (r) => r.label },
                  { label: 'Rimandate', end: true, render: (r) => r.postponed },
                  { label: 'KO definitivi', end: true, render: (r) => r.definitive },
                  { label: 'Poi risolte', end: true, render: (r) => `${r.resolved} (${pct(r.resolved, r.postponed + r.definitive)})` },
                ]}
              />
            </Card>
          )}
          <Card title="Per modello" padded={false}>
            <Table
              rows={d.models}
              rowKey={(r) => r.model}
              columns={[
                { label: 'Modello', render: (r) => r.model },
                { label: 'Provisioning', end: true, render: (r) => r.jobs },
                { label: 'Falliti', end: true, render: (r) => `${r.failed} (${pct(r.failed, r.jobs)})` },
              ]}
            />
          </Card>
        </>
      )}
    </div>
  );
}
