import type { Config } from '../config.ts';
import { nowIso, type Db } from '../db.ts';
import { escapeHtml as e, type Telegram } from './telegram.ts';
import type { Uisp } from './uisp.ts';

/**
 * What the NOC is told on Telegram (only what needs an action):
 * failed provisioning, CPE to accept in UISP, UISP down/up, security events, evening summary.
 */
export function createNotifier(db: Db, cfg: Config, telegram: Telegram, getUisp: () => Uisp | null, version: string, log: (m: string) => void = () => {}) {
  const jobLink = (mac: string) => (cfg.publicUrl ? `\n<a href="${e(cfg.publicUrl)}/#/jobs?q=${encodeURIComponent(mac)}">Apri nello storico</a>` : '');

  function provisioningResult(jobId: string) {
    const j = db
      .prepare('SELECT j.status, j.model, j.mac, j.ssid, j.error, j.stages, j.replaces_job_id, u.username FROM provisioning_jobs j JOIN users u ON u.id = j.user_id WHERE j.id = ?')
      .get(jobId) as { status: string; model: string; mac: string; ssid: string; error: string; stages: string; replaces_job_id: string | null; username: string } | undefined;
    if (!j) return;
    if (j.status === 'failed') {
      const stages = (() => {
        try {
          return (JSON.parse(j.stages) as string[]).slice(-1)[0] ?? '';
        } catch {
          return '';
        }
      })();
      void telegram.notify(
        'provisioning_failed',
        `❌ <b>Provisioning fallito</b>\nInstallatore: ${e(j.username)}\nCPE: ${e(j.model)} · ${e(j.mac)}\nSSID: ${e(j.ssid)}` +
          (stages ? `\nUltima fase: ${e(stages)}` : '') +
          (j.error ? `\nErrore: ${e(j.error.slice(0, 300))}` : '') +
          jobLink(j.mac),
      );
    } else if (j.status === 'success' && getUisp()) {
      void telegram.notify(
        'uisp_pending',
        `🆕 <b>CPE ${j.replaces_job_id ? 'sostitutiva ' : ''}pronta da accettare in UISP</b>\n${e(j.model)} · ${e(j.mac)} · ${e(j.ssid)}\nInstallatore: ${e(j.username)}` + jobLink(j.mac),
      );
    }
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
           (SELECT count(*) FROM job_acceptance WHERE created_at >= ?) accepted
         FROM provisioning_jobs WHERE created_at >= ?`,
      )
      .get(new Date(now.getTime() - 7 * 86400_000).toISOString(), since, since) as { ok: number | null; ko: number | null; pending: number; accepted: number };
    return (
      `📊 <b>Riepilogo CDA Net CPE</b> (ultime 24 ore)\n` +
      `Installazioni riuscite: ${c.ok ?? 0}\nFallite: ${c.ko ?? 0}\nCollaudi registrati: ${c.accepted}\n` +
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

  let timers: NodeJS.Timeout[] = [];
  return {
    provisioningResult,
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
        } catch (err) {
          log(`notify summary: ${(err as Error).message}`);
        }
      };
      timers = [setTimeout(tick, 30_000), setInterval(tick, 5 * 60_000)];
      timers.forEach((t) => t.unref());
    },
    stop() {
      timers.forEach((t) => clearTimeout(t));
      timers = [];
    },
  };
}
export type Notifier = ReturnType<typeof createNotifier>;
