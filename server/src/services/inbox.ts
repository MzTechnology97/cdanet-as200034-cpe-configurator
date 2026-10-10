import { nowIso, type Db } from '../db.ts';

/**
 * Kinds of notification. "noc": every admin (the NOC); "installer": who did the installation.
 * Each user chooses which ones also reach their personal Telegram chat.
 */
export const NOTIFY_KINDS = {
  provisioning_failed: { label: 'Provisioning fallito', audience: 'noc', telegram: false },
  install_ko: { label: 'Installazione KO o rimandata', audience: 'noc', telegram: false },
  review_pending: { label: 'Collaudo con segnale pessimo da approvare', audience: 'noc', telegram: false },
  review_decision: { label: 'Esito dell’approvazione del NOC', audience: 'installer', telegram: true },
  install_activated: { label: 'Installazione attivata dal NOC', audience: 'installer', telegram: true },
  work_order_assigned: { label: 'Intervento assegnato o modificato', audience: 'installer', telegram: true },
  work_order_reminder: { label: 'Promemoria degli interventi (24 h, 2 h, 1 h, 30 min prima)', audience: 'installer', telegram: true },
  work_order_late: { label: 'Intervento in ritardo o non fatto', audience: 'installer', telegram: true },
  work_order_noc: { label: 'Interventi in ritardo o non fatti (NOC)', audience: 'noc', telegram: true },
  network_advice: { label: 'Assistente rete: nuovi problemi critici su AP e CPE', audience: 'noc', telegram: false },
} as const;
export type NotifyKind = keyof typeof NOTIFY_KINDS;
export const isNotifyKind = (k: string): k is NotifyKind => k in NOTIFY_KINDS;

export interface Notice {
  kind: NotifyKind;
  title: string;
  /** Plain text lines (the console and the app). */
  lines: string[];
  jobId?: string | null;
  mac?: string | null;
}

const prefsKey = (userId: number) => `notify.telegram.${userId}`;

export function createInbox(
  db: Db,
  /** Personal Telegram message (HTML), when the bot and the user's chat are there. */
  sendPersonal: (chatId: string, html: string) => void,
  escape: (s: string) => string,
  link: (mac: string) => string,
) {
  /** Kinds the user receives on Telegram (default: their own installations only). */
  function telegramKinds(userId: number): NotifyKind[] {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(prefsKey(userId)) as { value: string } | undefined;
    if (row) {
      try {
        return (JSON.parse(row.value) as string[]).filter(isNotifyKind);
      } catch {
        /* default below */
      }
    }
    return (Object.keys(NOTIFY_KINDS) as NotifyKind[]).filter((k) => NOTIFY_KINDS[k].telegram);
  }

  function setTelegramKinds(userId: number, kinds: NotifyKind[]) {
    db.prepare(
      `INSERT INTO settings(key, value, updated_at, updated_by) VALUES(?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ).run(prefsKey(userId), JSON.stringify([...new Set(kinds)]), nowIso(), userId);
  }

  /** To the NOC (every active admin) or to the given users; each one gets a row and maybe a Telegram. */
  function push(to: 'noc' | number[], n: Notice) {
    const users = (
      to === 'noc'
        ? db.prepare("SELECT id, telegram_chat_id chat FROM users WHERE role = 'admin' AND active = 1").all()
        : to.length
          ? db.prepare(`SELECT id, telegram_chat_id chat FROM users WHERE active = 1 AND id IN (${to.map(() => '?').join(',')})`).all(...to)
          : []
    ) as Array<{ id: number; chat: string }>;
    const insert = db.prepare('INSERT INTO notifications(created_at, user_id, kind, title, body, job_id, mac) VALUES(?,?,?,?,?,?,?)');
    const now = nowIso();
    const html = `<b>${escape(n.title)}</b>\n${n.lines.map(escape).join('\n')}${n.mac ? link(n.mac) : ''}`;
    for (const u of users) {
      insert.run(now, u.id, n.kind, n.title, n.lines.join('\n'), n.jobId ?? null, n.mac ?? '');
      if (u.chat && telegramKinds(u.id).includes(n.kind)) sendPersonal(u.chat, html);
    }
    return users.length;
  }

  function list(userId: number, opts: { unread?: boolean; limit: number }) {
    return db
      .prepare(
        `SELECT id, created_at createdAt, kind, title, body, job_id jobId, mac, read_at readAt FROM notifications
          WHERE user_id = ? ${opts.unread ? 'AND read_at IS NULL' : ''} ORDER BY id DESC LIMIT ?`,
      )
      .all(userId, opts.limit);
  }

  const unread = (userId: number) => (db.prepare('SELECT count(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId) as { n: number }).n;

  function markRead(userId: number, ids: number[] | 'all') {
    const now = nowIso();
    if (ids === 'all') return Number(db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now, userId).changes);
    const mark = db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL');
    return ids.reduce((n, id) => n + Number(mark.run(now, id, userId).changes), 0);
  }

  /** Old notifications go after 90 days. */
  function sweep() {
    db.prepare('DELETE FROM notifications WHERE created_at < ?').run(new Date(Date.now() - 90 * 86400_000).toISOString());
  }

  return { push, list, unread, markRead, telegramKinds, setTelegramKinds, sweep };
}
export type Inbox = ReturnType<typeof createInbox>;
