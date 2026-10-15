import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, download } from '../lib/api';
import { toast } from '../lib/toast';
import { AsyncButton, Card, Notice, Skeleton, Stat, Table } from '../ui';

/**
 * Statistiche → «Report mensile»: the numbers of one month for the management, the PDF to download.
 * The same report goes to the group on Telegram on the 1st of the month (event «Riepilogo»).
 */

interface Report {
  month: string;
  label: string;
  installs: { success: number; failed: number; replacements: number; acceptances: number; ok: number; warn: number; bad: number; avgSignal: number | null; nocPassed: number; prevSuccess: number };
  repoints: number;
  workOrders: { total: number; done: number; cancelled: number; open: number; late: number; missed: number };
  ko: { postponed: number; definitive: number; reasons: Array<{ label: string; n: number }> };
  speed: { tests: number; below: number };
  installers: Array<{ name: string; installs: number; failed: number; okPct: number | null; avgSignal: number | null; ordersDone: number; ordersLate: number }>;
}

const romeMonth = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7);
const delta = (now: number, before: number) => (before ? `${now >= before ? '+' : ''}${Math.round(((now - before) / before) * 100)}% sul mese prima` : 'il mese prima: 0');

export function MonthlyReportCard() {
  const [month, setMonth] = useState(romeMonth());
  const q = useQuery({ queryKey: ['reports', 'monthly', month], queryFn: () => api<Report>(`/api/admin/reports/monthly?month=${month}`) });
  const r = q.data;
  return (
    <Card
      title="Report mensile"
      actions={
        <>
          <input type="month" className="wo-date" value={month} max={romeMonth()} onChange={(e) => e.target.value && setMonth(e.target.value)} aria-label="Mese" />
          <AsyncButton onClick={() => download(`/api/admin/reports/monthly.pdf?month=${month}`, `report-cdanet-${month}.pdf`)} onError={(e) => toast((e as Error).message, 'bad')}>
            Scarica PDF
          </AsyncButton>
        </>
      }
    >
      {q.error && <Notice tone="bad">{(q.error as Error).message}</Notice>}
      {!r && !q.error && <Skeleton lines={4} />}
      {r && (
        <>
          <section className="ui-stats" aria-label={`Report di ${r.label}`}>
            <Stat label="installazioni" value={r.installs.success} hint={delta(r.installs.success, r.installs.prevSuccess)} />
            <Stat label="collaudi superati" value={r.installs.ok} hint={`${r.installs.warn} con riserva · ${r.installs.bad} non superati${r.installs.nocPassed ? ` · ${r.installs.nocPassed} dal NOC` : ''}`} tone="good" />
            <Stat label="interventi fatti" value={r.workOrders.done} hint={`su ${r.workOrders.total}${r.workOrders.late ? ` · ${r.workOrders.late} in ritardo` : ''}${r.workOrders.missed ? ` · ${r.workOrders.missed} non fatti` : ''}`} />
            <Stat label="ripuntamenti" value={r.repoints} />
            <Stat label="rimandi / KO" value={`${r.ko.postponed} / ${r.ko.definitive}`} hint={r.ko.reasons[0] ? `più spesso: ${r.ko.reasons[0].label}` : undefined} tone={r.ko.definitive ? 'warn' : 'neutral'} />
            {r.speed.tests > 0 && <Stat label="speedtest sotto profilo" value={`${r.speed.below} / ${r.speed.tests}`} tone={r.speed.below ? 'warn' : 'good'} />}
          </section>
          {r.installers.length > 0 && (
            <Table
              rows={r.installers}
              rowKey={(x) => x.name}
              columns={[
                { label: 'Installatore', render: (x) => <strong>{x.name}</strong> },
                { label: 'Installazioni', render: (x) => `${x.installs}${x.failed ? ` (+${x.failed} fallite)` : ''}` },
                { label: 'Collaudi ok', render: (x) => (x.okPct != null ? `${x.okPct}%` : '—') },
                { label: 'Segnale medio', render: (x) => (x.avgSignal != null ? `${x.avgSignal} dBm` : '—') },
                { label: 'Interventi', render: (x) => `${x.ordersDone}${x.ordersLate ? ` · ${x.ordersLate} in ritardo` : ''}` },
              ]}
            />
          )}
          <p className="ui-muted ui-small">Il report del mese appena finito arriva da solo nel gruppo Telegram il 1° del mese alle 8, testo e PDF (evento «Riepilogo serale e report mensile» del connettore Telegram).</p>
        </>
      )}
    </Card>
  );
}
