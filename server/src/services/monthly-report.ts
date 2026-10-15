import { nowIso, type Db } from '../db.ts';
import { KO_REASONS } from '../routes/ko.ts';
import { drawLogo } from './acceptance-report.ts';
import { A4, PdfDoc, type Rgb } from './pdf.ts';
import { escapeHtml as e } from './telegram.ts';

/**
 * The monthly report for the management: installations and acceptance tests, re-pointings, work
 * orders (done, late, missed), postponements and KO by reason, speedtests under the profile, one
 * line per installer, with the month before to compare. As JSON for the console, as a PDF, and
 * sent to the group on the 1st of the month (the month just ended).
 */

export interface MonthlyReport {
  month: string;
  label: string;
  generatedAt: string;
  installs: { success: number; failed: number; replacements: number; acceptances: number; ok: number; warn: number; bad: number; avgSignal: number | null; nocPassed: number; prevSuccess: number };
  repoints: number;
  workOrders: { total: number; done: number; cancelled: number; open: number; late: number; missed: number; byKind: Record<string, number> };
  ko: { postponed: number; definitive: number; reasons: Array<{ label: string; n: number }> };
  speed: { tests: number; below: number };
  installers: Array<{ name: string; installs: number; failed: number; okPct: number | null; avgSignal: number | null; ordersDone: number; ordersLate: number }>;
}

const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
export const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
/** «2026-10» → «2026-09». */
export const prevMonth = (m: string) => {
  const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)) - 2, 1));
  return d.toISOString().slice(0, 7);
};

export function monthlyReport(db: Db, month: string): MonthlyReport {
  const one = <T>(sql: string, ...args: Array<string | number>) => db.prepare(sql).get(...args) as T;
  const inst = one<{ success: number | null; failed: number | null; replacements: number | null; acceptances: number | null; ok: number | null; warn: number | null; bad: number | null; avgSignal: number | null }>(
    `SELECT SUM(j.status = 'success') success, SUM(j.status = 'failed') failed, SUM(j.status = 'success' AND j.replaces_job_id IS NOT NULL) replacements,
            SUM(a.job_id IS NOT NULL) acceptances, SUM(a.verdict = 'ok') ok, SUM(a.verdict = 'warn') warn, SUM(a.verdict = 'bad') bad,
            ROUND(AVG(json_extract(a.data, '$.radio.signal')), 1) avgSignal
       FROM provisioning_jobs j LEFT JOIN job_acceptance a ON a.job_id = j.id WHERE substr(j.created_at, 1, 7) = ? AND j.status IN ('success','failed')`,
    month,
  );
  const prev = one<{ n: number }>(`SELECT count(*) n FROM provisioning_jobs WHERE status = 'success' AND substr(created_at, 1, 7) = ?`, prevMonth(month)).n;
  const nocPassed = one<{ n: number }>(`SELECT count(*) n FROM events WHERE action = 'job.acceptance_pass' AND substr(created_at, 1, 7) = ?`, month).n;
  const repoints =
    one<{ n: number }>(`SELECT count(*) n FROM job_acceptance WHERE kind = 'repoint' AND substr(created_at, 1, 7) = ?`, month).n +
    one<{ n: number }>(`SELECT count(*) n FROM acceptance_history WHERE kind = 'repoint' AND substr(created_at, 1, 7) = ?`, month).n;
  const wo = db
    .prepare(`SELECT kind, status, late_at IS NOT NULL late, missed_at IS NOT NULL missed FROM work_orders WHERE substr(day, 1, 7) = ?`)
    .all(month) as Array<{ kind: string; status: string; late: number; missed: number }>;
  const ko = db.prepare(`SELECT kind, reason, count(*) n FROM install_ko WHERE substr(created_at, 1, 7) = ? GROUP BY kind, reason`).all(month) as Array<{ kind: string; reason: string; n: number }>;
  const reasons = new Map<string, number>();
  for (const k of ko) reasons.set(k.reason, (reasons.get(k.reason) ?? 0) + k.n);
  const speed = one<{ tests: number; below: number | null }>(`SELECT count(*) tests, SUM(passed = 0) below FROM speed_tests WHERE substr(measured_at, 1, 7) = ?`, month);
  const installers = (
    db
      .prepare(
        `SELECT u.username name,
                (SELECT count(*) FROM provisioning_jobs j WHERE j.user_id = u.id AND j.status = 'success' AND substr(j.created_at, 1, 7) = ?1) installs,
                (SELECT count(*) FROM provisioning_jobs j WHERE j.user_id = u.id AND j.status = 'failed' AND substr(j.created_at, 1, 7) = ?1) failed,
                (SELECT count(*) FROM job_acceptance a JOIN provisioning_jobs j ON j.id = a.job_id WHERE j.user_id = u.id AND substr(a.created_at, 1, 7) = ?1) tests,
                (SELECT count(*) FROM job_acceptance a JOIN provisioning_jobs j ON j.id = a.job_id WHERE j.user_id = u.id AND a.verdict = 'ok' AND substr(a.created_at, 1, 7) = ?1) ok,
                (SELECT ROUND(AVG(json_extract(a.data, '$.radio.signal')), 1) FROM job_acceptance a JOIN provisioning_jobs j ON j.id = a.job_id WHERE j.user_id = u.id AND substr(a.created_at, 1, 7) = ?1) avgSignal,
                (SELECT count(*) FROM work_orders w WHERE w.assigned_to = u.id AND w.status = 'done' AND substr(w.day, 1, 7) = ?1) ordersDone,
                (SELECT count(*) FROM work_orders w WHERE w.assigned_to = u.id AND w.late_at IS NOT NULL AND substr(w.day, 1, 7) = ?1) ordersLate
           FROM users u WHERE u.role <> 'admin'`,
      )
      .all(month) as Array<{ name: string; installs: number; failed: number; tests: number; ok: number; avgSignal: number | null; ordersDone: number; ordersLate: number }>
  )
    .filter((i) => i.installs || i.failed || i.ordersDone || i.ordersLate || i.tests)
    .map(({ tests, ok, ...i }) => ({ ...i, okPct: tests ? Math.round((100 * ok) / tests) : null }))
    .sort((a, b) => b.installs - a.installs || b.ordersDone - a.ordersDone);
  return {
    month,
    label: monthLabel(month),
    generatedAt: nowIso(),
    installs: { success: inst.success ?? 0, failed: inst.failed ?? 0, replacements: inst.replacements ?? 0, acceptances: inst.acceptances ?? 0, ok: inst.ok ?? 0, warn: inst.warn ?? 0, bad: inst.bad ?? 0, avgSignal: inst.avgSignal, nocPassed, prevSuccess: prev },
    repoints,
    workOrders: {
      total: wo.length,
      done: wo.filter((w) => w.status === 'done').length,
      cancelled: wo.filter((w) => w.status === 'cancelled').length,
      open: wo.filter((w) => ['open', 'started', 'postponed'].includes(w.status)).length,
      late: wo.filter((w) => w.late).length,
      missed: wo.filter((w) => w.missed).length,
      byKind: Object.fromEntries(['new', 'repoint', 'repair', 'survey'].map((k) => [k, wo.filter((w) => w.kind === k).length])),
    },
    ko: {
      postponed: ko.filter((k) => k.kind === 'postponed').reduce((n, k) => n + k.n, 0),
      definitive: ko.filter((k) => k.kind === 'definitive').reduce((n, k) => n + k.n, 0),
      reasons: [...reasons].map(([r, n]) => ({ label: KO_REASONS[r as keyof typeof KO_REASONS] ?? r, n })).sort((a, b) => b.n - a.n).slice(0, 6),
    },
    speed: { tests: speed.tests, below: speed.below ?? 0 },
    installers,
  };
}

const delta = (now: number, before: number) => (before ? `${now >= before ? '+' : ''}${Math.round(((now - before) / before) * 100)}% sul mese prima` : 'nessuna il mese prima');
const KIND: Record<string, string> = { new: 'installazioni', repoint: 'ripuntamenti', repair: 'guasti', survey: 'sopralluoghi' };

/** The message for the group (Telegram HTML). */
export function monthlyText(r: MonthlyReport): string {
  const i = r.installs;
  const w = r.workOrders;
  return [
    `📈 <b>Report di ${e(r.label)}</b>`,
    `Installazioni: <b>${i.success}</b> (${delta(i.success, i.prevSuccess)})${i.replacements ? `, di cui ${i.replacements} sostituzioni` : ''}${i.failed ? ` · ${i.failed} fallite` : ''}`,
    `Collaudi: ${i.ok} superati, ${i.warn} con riserva, ${i.bad} non superati${i.nocPassed ? ` (${i.nocPassed} superati dal NOC)` : ''}${i.avgSignal != null ? ` · segnale medio ${i.avgSignal} dBm` : ''}`,
    r.repoints ? `Ripuntamenti: ${r.repoints}` : '',
    w.total ? `Interventi: ${w.done} fatti su ${w.total}${w.late ? ` · ${w.late} in ritardo` : ''}${w.missed ? ` · ${w.missed} non fatti nel giorno` : ''}` : '',
    r.ko.postponed || r.ko.definitive ? `Rimandi ${r.ko.postponed} · KO ${r.ko.definitive}${r.ko.reasons[0] ? ` · motivo più frequente: ${e(r.ko.reasons[0].label)}` : ''}` : '',
    r.speed.tests ? `Speedtest: ${r.speed.tests}, ${r.speed.below} sotto il profilo` : '',
    r.installers.length ? `\n${r.installers.slice(0, 8).map((x) => `• ${e(x.name)}: ${x.installs} installazioni${x.ordersDone ? `, ${x.ordersDone} interventi` : ''}${x.okPct != null ? `, collaudi ok ${x.okPct}%` : ''}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

const BRAND: Rgb = [241, 90, 44];
const BRAND_INK: Rgb = [194, 68, 26];
const MUTED: Rgb = [91, 98, 112];
const LINE: Rgb = [226, 229, 234];
const SOFT: Rgb = [247, 248, 250];
const M = 40;
const CW = A4.w - 2 * M;

export function monthlyReportPdf(r: MonthlyReport, logoSvg: string | null): Buffer {
  const doc = new PdfDoc();
  let y = M;
  drawLogo(doc, logoSvg, M, y, 40);
  doc.text(A4.w - M, y + 2, 'Report mensile', { size: 17, font: 'bold', align: 'right' });
  doc.text(A4.w - M, y + 24, r.label.charAt(0).toUpperCase() + r.label.slice(1), { size: 10.5, color: MUTED, align: 'right' });
  y += 52;
  doc.rect(M, y, CW, 2.5, BRAND);
  y += 18;

  // the key numbers, as tiles
  const i = r.installs;
  const w = r.workOrders;
  const tiles: Array<[string, string, string]> = [
    [String(i.success), 'installazioni', delta(i.success, i.prevSuccess)],
    [String(i.ok), 'collaudi superati', `${i.warn} con riserva · ${i.bad} non superati`],
    [String(w.done), 'interventi fatti', `su ${w.total}${w.late ? ` · ${w.late} in ritardo` : ''}`],
    [String(r.repoints), 'ripuntamenti', r.speed.tests ? `${r.speed.below}/${r.speed.tests} speedtest sotto` : ''],
  ];
  const tw = (CW - 3 * 10) / 4;
  tiles.forEach(([v, l, s], k) => {
    const x = M + k * (tw + 10);
    doc.rect(x, y, tw, 62, SOFT, LINE, 0.5);
    doc.text(x + 10, y + 10, v, { size: 20, font: 'bold' });
    doc.text(x + 10, y + 34, l, { size: 9, font: 'bold' });
    doc.text(x + 10, y + 47, s, { size: 7.5, color: MUTED });
  });
  y += 80;

  const section = (title: string) => {
    y += 6;
    doc.text(M, y, title.toUpperCase(), { size: 8.5, font: 'bold', color: BRAND_INK });
    y += 13;
    doc.line(M, y, A4.w - M, y, LINE);
    y += 8;
  };
  const rows = (list: Array<[string, string]>) => {
    for (const [k, v] of list) {
      if (y > A4.h - 80) {
        doc.addPage();
        y = M;
      }
      doc.text(M, y, k, { size: 9, color: MUTED });
      doc.text(M + 200, y, v, { size: 9.5 });
      y += 15;
    }
  };
  section('Installazioni e collaudi');
  rows([
    ['Installazioni riuscite', `${i.success}${i.replacements ? ` (${i.replacements} sostituzioni)` : ''}`],
    ['Installazioni fallite', String(i.failed)],
    ['Collaudi', `${i.acceptances}: ${i.ok} superati, ${i.warn} con riserva, ${i.bad} non superati`],
    ['Superati per decisione del NOC', String(i.nocPassed)],
    ['Segnale medio al collaudo', i.avgSignal != null ? `${i.avgSignal.toLocaleString('it-IT')} dBm` : '—'],
    ['Ripuntamenti', String(r.repoints)],
  ]);
  section('Interventi');
  rows([
    ['Interventi del mese', `${w.total}: ${Object.entries(w.byKind).filter(([, n]) => n).map(([k, n]) => `${n} ${KIND[k] ?? k}`).join(', ') || '—'}`],
    ['Fatti / annullati / aperti', `${w.done} / ${w.cancelled} / ${w.open}`],
    ['In ritardo / non fatti nel giorno', `${w.late} / ${w.missed}`],
  ]);
  section('Rimandi e KO');
  rows([['Rimandi / KO definitivi', `${r.ko.postponed} / ${r.ko.definitive}`], ...r.ko.reasons.map((x): [string, string] => [x.label, String(x.n)])]);
  if (r.speed.tests) {
    section('Speedtest');
    rows([['Speedtest fatti', String(r.speed.tests)], ['Sotto la soglia del profilo', String(r.speed.below)]]);
  }
  if (r.installers.length) {
    section('Per installatore');
    const cols = [M, M + 150, M + 225, M + 290, M + 360, M + 440];
    const head = ['Installatore', 'Installazioni', 'Fallite', 'Collaudi ok', 'Segnale medio', 'Interventi (ritardi)'];
    head.forEach((h, k) => doc.text(cols[k]!, y, h, { size: 8, font: 'bold', color: MUTED }));
    y += 14;
    for (const x of r.installers) {
      if (y > A4.h - 80) {
        doc.addPage();
        y = M;
      }
      const v = [x.name, String(x.installs), String(x.failed), x.okPct != null ? `${x.okPct}%` : '—', x.avgSignal != null ? `${x.avgSignal} dBm` : '—', `${x.ordersDone} (${x.ordersLate})`];
      v.forEach((t, k) => doc.text(cols[k]!, y, t, { size: 9 }));
      y += 14;
    }
  }
  doc.line(M, A4.h - 38, A4.w - M, A4.h - 38, LINE);
  doc.text(M, A4.h - 32, `CDA Net · AS200034 · Report di ${r.label}`, { size: 7.5, color: MUTED });
  doc.text(A4.w - M, A4.h - 32, `Generato il ${new Date(r.generatedAt).toLocaleString('it-IT', { timeZone: 'Europe/Rome', dateStyle: 'short', timeStyle: 'short' })}`, { size: 7.5, color: MUTED, align: 'right' });
  return doc.build();
}

/** The month whose report is due now: on the 1st from 8:00 (Rome) the one just ended, else null. */
export function monthlyDue(now = new Date()): string | null {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const v = (t: string) => p.find((x) => x.type === t)!.value;
  if (Number(v('day')) !== 1 || Number(v('hour')) < 8) return null;
  return prevMonth(`${v('year')}-${v('month')}`);
}
