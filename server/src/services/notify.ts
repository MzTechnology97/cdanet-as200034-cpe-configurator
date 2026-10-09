import type { Config } from '../config.ts';
import { nowIso, type Db } from '../db.ts';
import { KO_KINDS, KO_REASONS, KO_STEPS } from '../routes/ko.ts';
import { createInbox } from './inbox.ts';
import { dueAlerts, inWords, orderStart } from '../domain/work-order-time.ts';
import { escapeHtml as e, type Telegram } from './telegram.ts';
import type { Uisp } from './uisp.ts';

/**
 * What the NOC is told on Telegram (only what needs an action):
 * failed provisioning, CPE to accept in UISP, UISP down/up, security events, evening summary.
 */
export function createNotifier(
  db: Db,
  cfg: Config,
  rawTelegram: Telegram,
  getUisp: () => Uisp | null,
  version: string,
  isOn: () => boolean = () => true,
  log: (m: string) => void = () => {},
) {
  // Module "Notifiche Telegram" off: every notification is dropped here.
  const telegram = { ...rawTelegram, notify: (...a: Parameters<Telegram['notify']>) => (isOn() ? rawTelegram.notify(...a) : Promise.resolve()), summaryHour: () => (isOn() ? rawTelegram.summaryHour() : null) };
  const jobLink = (mac: string) => (cfg.publicUrl ? `\n<a href="${e(cfg.publicUrl)}/#/jobs?q=${encodeURIComponent(mac)}">Apri nello storico</a>` : '');
  // Notifications page of each user; personal Telegram only with the module on and the bot set
  const inbox = createInbox(
    db,
    (chat, html) => {
      if (isOn() && rawTelegram.personalAvailable()) void rawTelegram.sendTo(chat, html).catch((err) => log(`telegram personal: ${(err as Error).message}`));
    },
    e,
    jobLink,
  );

  function provisioningResult(jobId: string) {
    const j = db
      .prepare('SELECT j.status, j.model, j.mac, j.ssid, j.error, j.stages, j.replaces_job_id, j.attempts, u.username FROM provisioning_jobs j JOIN users u ON u.id = j.user_id WHERE j.id = ?')
      .get(jobId) as { status: string; model: string; mac: string; ssid: string; error: string; stages: string; replaces_job_id: string | null; attempts: number; username: string } | undefined;
    if (!j) return;
    if (j.status === 'failed') {
      const stages = (() => {
        try {
          return (JSON.parse(j.stages) as string[]).slice(-1)[0] ?? '';
        } catch {
          return '';
        }
      })();
      const title = `Provisioning fallito${j.attempts > 1 ? ` · tentativo ${j.attempts}` : ''}`;
      const lines = [`Installatore: ${j.username}`, `CPE: ${j.model} · ${j.mac}`, `SSID: ${j.ssid}`, ...(stages ? [`Ultima fase: ${stages}`] : []), ...(j.error ? [`Errore: ${j.error.slice(0, 300)}`] : [])];
      void telegram.notify('provisioning_failed', `❌ <b>${e(title)}</b>\n${lines.map(e).join('\n')}` + jobLink(j.mac));
      inbox.push('noc', { kind: 'provisioning_failed', title, lines, jobId, mac: j.mac });
    } else if (j.status === 'success' && getUisp()) {
      void telegram.notify(
        'uisp_pending',
        `🆕 <b>CPE ${j.replaces_job_id ? 'sostitutiva ' : ''}pronta da accettare in UISP</b>\n${e(j.model)} · ${e(j.mac)} · ${e(j.ssid)}\nInstallatore: ${e(j.username)}` + jobLink(j.mac),
      );
    }
  }

  /** Postponed or KO installation reported by the technician (same switch as a failed provisioning). */
  function installKo(id: number) {
    const k = db
      .prepare(
        `SELECT k.kind, k.job_id jobId, k.mode, k.step, k.reason, k.note, k.mac, k.ssid, k.data, u.username, j.device_name deviceName,
                (SELECT count(*) FROM install_ko o WHERE o.id < k.id AND ((k.job_id IS NOT NULL AND o.job_id = k.job_id) OR (k.mac <> '' AND o.mac = k.mac))) before
           FROM install_ko k JOIN users u ON u.id = k.user_id LEFT JOIN provisioning_jobs j ON j.id = k.job_id WHERE k.id = ?`,
      )
      .get(id) as
      | { kind: keyof typeof KO_KINDS; jobId: string | null; mode: string; step: keyof typeof KO_STEPS; reason: keyof typeof KO_REASONS; note: string; mac: string; ssid: string; data: string; username: string; deviceName: string | null; before: number }
      | undefined;
    if (!k) return;
    const d = JSON.parse(k.data || '{}') as { signal?: number | null; retryOn?: string };
    const title = `${k.kind === 'postponed' ? 'Installazione rimandata' : 'Installazione KO'}${k.mode === 'repoint' ? ' (ripuntamento)' : ''}${k.before ? ` · tentativo ${k.before + 1}` : ''}`;
    const lines = [
      `Installatore: ${k.username}`,
      ...(k.deviceName ? [`Cliente: ${k.deviceName}`] : []),
      ...(k.mac || k.ssid ? [`CPE: ${[k.mac, k.ssid].filter(Boolean).join(' · ')}${d.signal != null ? ` · ${d.signal} dBm` : ''}`] : []),
      `Fase: ${KO_STEPS[k.step] ?? k.step}`,
      `Motivo: ${KO_REASONS[k.reason] ?? k.reason}`,
      ...(d.retryOn ? [`Da riprovare il: ${d.retryOn.split('-').reverse().join('/')}`] : []),
      `Motivazione: ${k.note.slice(0, 500)}`,
    ];
    void telegram.notify('provisioning_failed', `${k.kind === 'postponed' ? '⏸' : '⛔'} <b>${e(title)}</b>\n${lines.map(e).join('\n')}` + (k.mac ? jobLink(k.mac) : ''));
    inbox.push('noc', { kind: 'install_ko', title, lines, jobId: k.jobId, mac: k.mac || null });
  }

  type ReviewRow = { jobId: string; userId: number; byId: number; username: string; deviceName: string; pppoeUser: string; mac: string; ssid: string; review: string; reason: string; note: string; signal: number | null };
  const reviewRow = (jobId: string) =>
    db
      .prepare(
        `SELECT j.id jobId, j.user_id userId, a.user_id byId, u.username, j.device_name deviceName, j.pppoe_user pppoeUser, j.mac, j.ssid,
                a.review, a.review_reason reason, a.review_note note, json_extract(a.data, '$.radio.signal') signal
           FROM job_acceptance a JOIN provisioning_jobs j ON j.id = a.job_id JOIN users u ON u.id = a.user_id WHERE a.job_id = ?`,
      )
      .get(jobId) as ReviewRow | undefined;
  const customer = (r: { deviceName: string; pppoeUser: string }) => r.deviceName || r.pppoeUser;

  /** Acceptance test with a poor signal: the NOC has to approve it. */
  function reviewPending(jobId: string) {
    const r = reviewRow(jobId);
    if (!r) return;
    const title = 'Collaudo da approvare: segnale pessimo';
    const lines = [`Installatore: ${r.username}`, `Cliente: ${customer(r)}`, `CPE: ${r.mac} · ${r.ssid}${r.signal != null ? ` · ${r.signal} dBm` : ''}`, `Motivo: ${r.reason}`];
    void telegram.notify('provisioning_failed', `📶 <b>${e(title)}</b>\n${lines.map(e).join('\n')}` + jobLink(r.mac));
    inbox.push('noc', { kind: 'review_pending', title, lines, jobId, mac: r.mac });
  }

  /** The NOC's decision, to who installed the CPE and who did the acceptance test. */
  function reviewDecision(jobId: string, by: string) {
    const r = reviewRow(jobId);
    if (!r || (r.review !== 'approved' && r.review !== 'rejected')) return;
    const ok = r.review === 'approved';
    const title = ok ? `Installazione accettata dal NOC: ${customer(r)}` : `Installazione non accettata dal NOC: ${customer(r)}`;
    const lines = [
      `CPE: ${r.mac} · ${r.ssid}${r.signal != null ? ` · ${r.signal} dBm` : ''}`,
      `Deciso da: ${by}`,
      ...(r.note ? [`Nota: ${r.note}`] : []),
      ...(ok ? [] : ['Ripeti il puntamento (o cambia AP) e un nuovo collaudo, oppure segnala KO.']),
    ];
    inbox.push([...new Set([r.userId, r.byId])], { kind: 'review_decision', title: `${ok ? '✅' : '❌'} ${title}`, lines, jobId, mac: r.mac });
  }

  /** The NOC activated the customer's CPE on the network (no data source named to installers). */
  function installActivated(jobId: string, by: string) {
    const j = db.prepare('SELECT user_id userId, device_name deviceName, pppoe_user pppoeUser, mac, ssid FROM provisioning_jobs WHERE id = ?').get(jobId) as
      | { userId: number; deviceName: string; pppoeUser: string; mac: string; ssid: string }
      | undefined;
    if (!j) return;
    inbox.push([j.userId], { kind: 'install_activated', title: `✅ Installazione attivata dal NOC: ${customer(j)}`, lines: [`CPE: ${j.mac} · ${j.ssid}`, `Attivata da: ${by}`], jobId, mac: j.mac });
  }

  function security(text: string) {
    void telegram.notify('security', `🔐 <b>Sicurezza</b>\n${text}`);
  }

  /** Admin logged in from an address never seen for that account (last 20 kept). */
  function adminLogin(userId: number, username: string, ip: string) {
    const key = `seen_ips.${userId}`;
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    const seen: string[] = row ? JSON.parse(row.value) : [];
    if (seen.includes(ip)) return;
    db.prepare(
      `INSERT INTO settings(key, value, updated_at, updated_by) VALUES(?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(key, JSON.stringify([ip, ...seen].slice(0, 20)), nowIso(), userId);
    // The very first login of an account only records the address.
    if (seen.length) security(`Accesso amministratore <b>${e(username)}</b> da un indirizzo nuovo: ${e(ip)}`);
  }

  // ---- UISP reachability (state changes only) -------------------------------------------
  let uispUp: boolean | null = null;
  async function checkUisp() {
    const u = getUisp();
    if (!u) {
      uispUp = null;
      return;
    }
    const ok = await u.ping().then(() => true, () => false);
    if (uispUp !== null && ok !== uispUp) {
      void telegram.notify('uisp_status', ok ? '✅ <b>UISP di nuovo raggiungibile</b>' : '⚠️ <b>UISP non raggiungibile</b> dal server CDA Net: accettazioni, copertura e backup sono sospesi.');
    } else if (uispUp === null && !ok) {
      void telegram.notify('uisp_status', '⚠️ <b>UISP non raggiungibile</b> dal server CDA Net (all\'avvio).');
    }
    uispUp = ok;
  }

  // ---- Evening summary ------------------------------------------------------------------
  const romeHour = (d: Date) => Number(new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', hour12: false }).format(d));
  const romeDay = (d: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(d);

  function summaryText(now = new Date()) {
    const since = new Date(now.getTime() - 24 * 3600_000).toISOString();
    const c = db
      .prepare(
        `SELECT
           SUM(status = 'success') ok, SUM(status = 'failed') ko,
           (SELECT count(*) FROM provisioning_jobs WHERE status = 'success' AND uisp_authorized_at IS NULL AND created_at >= ?) pending,
           (SELECT count(*) FROM job_acceptance WHERE created_at >= ?) accepted,
           (SELECT count(*) FROM install_ko WHERE created_at >= ? AND kind = 'postponed') postponed,
           (SELECT count(*) FROM install_ko WHERE created_at >= ? AND kind = 'definitive') definitive
         FROM provisioning_jobs WHERE created_at >= ?`,
      )
      .get(new Date(now.getTime() - 7 * 86400_000).toISOString(), since, since, since, since) as { ok: number | null; ko: number | null; pending: number; accepted: number; postponed: number; definitive: number };
    return (
      `📊 <b>Riepilogo CDA Net CPE</b> (ultime 24 ore)\n` +
      `Installazioni riuscite: ${c.ok ?? 0}\nFallite: ${c.ko ?? 0}\nCollaudi registrati: ${c.accepted}\n` +
      (c.postponed || c.definitive ? `Rimandate: ${c.postponed} · KO definitivi: ${c.definitive}\n` : '') +
      (getUisp() ? `CPE ancora da accettare in UISP (7 giorni): ${c.pending}\n` : '') +
      `Server: v${e(version)}`
    );
  }

  function maybeSummary(now = new Date()) {
    const hour = telegram.summaryHour();
    if (hour === null || romeHour(now) !== hour) return false;
    const day = romeDay(now);
    const row = db.prepare("SELECT value FROM settings WHERE key = 'telegram.summary.last'").get() as { value: string } | undefined;
    if (row?.value === day) return false;
    db.prepare(
      `INSERT INTO settings(key, value, updated_at) VALUES('telegram.summary.last', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(day, nowIso());
    void telegram.notify('daily_summary', summaryText(now));
    return true;
  }

  /** A work order assigned (or moved) to an installer: they hear it at once. */
  function workOrderAssigned(o: { id: number; assignedTo: number | null; day: string; slot: string; kindLabel: string; customer: string; address: string }, changed = false) {
    if (o.assignedTo == null) return;
    const when = `${o.day.split('-').reverse().join('/')}${o.slot ? ` · ${o.slot}` : ''}`;
    inbox.push([o.assignedTo], {
      kind: 'work_order_assigned',
      title: `📋 ${changed ? 'Intervento modificato' : 'Nuovo intervento'}: ${o.customer}`,
      lines: [`${when} · ${o.kindLabel}`, o.address].filter(Boolean),
    });
  }

  /**
   * Reminders before each order, late and missed orders (installer and NOC): every minute. Each
   * alert is sent once, remembered on the order.
   */
  function workOrderAlerts(now = new Date()) {
    const today = romeDay(now);
    const rows = db
      .prepare(
        `SELECT w.id, w.assigned_to assignedTo, w.day, w.slot, w.kind, w.customer, w.address, w.status, w.reminders, w.late_at lateAt, w.missed_at missedAt, u.username
           FROM work_orders w LEFT JOIN users u ON u.id = w.assigned_to
          WHERE w.status IN ('open','started') AND w.assigned_to IS NOT NULL AND w.day >= ?`,
      )
      .all(new Date(now.getTime() - 3 * 86400_000).toISOString().slice(0, 10)) as Array<{
      id: number;
      assignedTo: number;
      day: string;
      slot: string;
      kind: string;
      customer: string;
      address: string;
      status: string;
      reminders: string;
      lateAt: string | null;
      missedAt: string | null;
      username: string | null;
    }>;
    const when = (o: { day: string; slot: string }) => `${o.day.split('-').reverse().join('/')}${o.slot ? ` · ${o.slot}` : ` · dalle ${orderStart(o.day, o.slot).toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' })}`}`;
    for (const o of rows) {
      for (const a of dueAlerts(o, now, today)) {
        if (a.type === 'reminder') {
          inbox.push([o.assignedTo], { kind: 'work_order_reminder', title: `⏰ Intervento ${inWords(orderStart(o.day, o.slot), now)}: ${o.customer}`, lines: [when(o), o.address].filter(Boolean) });
          db.prepare('UPDATE work_orders SET reminders = ? WHERE id = ?').run(a.sent.join(','), o.id);
        } else if (a.type === 'late') {
          inbox.push([o.assignedTo], { kind: 'work_order_late', title: `⚠️ Intervento in ritardo: ${o.customer}`, lines: [when(o), 'Non risulta iniziato: toccalo in Oggi con Inizia, oppure Rimanda con il motivo.'] });
          inbox.push('noc', { kind: 'work_order_noc', title: `⚠️ Intervento in ritardo: ${o.customer}`, lines: [when(o), `Installatore: ${o.username ?? '—'}`, 'Non risulta iniziato 30 minuti dopo l’orario previsto.'] });
          db.prepare('UPDATE work_orders SET late_at = ? WHERE id = ?').run(nowIso(), o.id);
        } else {
          inbox.push([o.assignedTo], { kind: 'work_order_late', title: `❌ Intervento non fatto: ${o.customer}`, lines: [when(o), 'Il giorno è passato senza esito: segnala all’ufficio cosa è successo.'] });
          inbox.push('noc', { kind: 'work_order_noc', title: `❌ Intervento mancato: ${o.customer}`, lines: [when(o), `Installatore: ${o.username ?? '—'}`, `Stato: ${o.status === 'started' ? 'iniziato ma non chiuso' : 'mai iniziato'}`] });
          db.prepare('UPDATE work_orders SET missed_at = ? WHERE id = ?').run(nowIso(), o.id);
        }
      }
    }
  }

  let timers: NodeJS.Timeout[] = [];
  return {
    workOrderAssigned,
    workOrderAlerts,
    inbox,
    provisioningResult,
    installKo,
    reviewPending,
    reviewDecision,
    installActivated,
    security,
    adminLogin,
    checkUisp,
    summaryText,
    maybeSummary,
    start() {
      const tick = () => {
        checkUisp().catch((err) => log(`notify uisp: ${(err as Error).message}`));
        try {
          maybeSummary();
          inbox.sweep();
        } catch (err) {
          log(`notify summary: ${(err as Error).message}`);
        }
      };
      const alerts = () => {
        try {
          workOrderAlerts();
        } catch (err) {
          log(`notify work orders: ${(err as Error).message}`);
        }
      };
      timers = [setTimeout(tick, 30_000), setInterval(tick, 5 * 60_000), setInterval(alerts, 60_000)];
      timers.forEach((t) => t.unref());
    },
    stop() {
      timers.forEach((t) => clearTimeout(t));
      timers = [];
    },
  };
}
export type Notifier = ReturnType<typeof createNotifier>;
