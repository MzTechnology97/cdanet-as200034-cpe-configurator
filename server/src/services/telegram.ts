import { HttpError } from '../auth.ts';
import type { Sealer } from '../crypto.ts';
import { nowIso, type Db } from '../db.ts';

/**
 * Telegram notifications for the NOC (Connettori → Telegram). Messages never contain
 * customer names, addresses, positions or secrets: only CPE model/MAC, SSID and installer.
 */

export const TELEGRAM_EVENTS = ['provisioning_failed', 'uisp_pending', 'uisp_status', 'security', 'daily_summary', 'power_outage'] as const;
export type TelegramEvent = (typeof TELEGRAM_EVENTS)[number];

interface Stored {
  enabled: boolean;
  tokenSealed: string;
  chatId: string;
  events: TelegramEvent[];
  summaryHour: number;
}

export interface TelegramView {
  configured: boolean;
  enabled: boolean;
  tokenSet: boolean;
  tokenHint: string;
  chatId: string;
  events: TelegramEvent[];
  summaryHour: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

const API = 'https://api.telegram.org';
const KEY = 'connector.telegram';

export const escapeHtml = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string);

export function createTelegram(db: Db, sealer: Sealer, opts: { fetchImpl?: typeof fetch | undefined; log?: (msg: string) => void; minIntervalMs?: number } = {}) {
  const f = opts.fetchImpl ?? fetch;
  let queue: Promise<unknown> = Promise.resolve();
  let last = 0;

  const read = () => {
    const r = db
      .prepare('SELECT s.value, s.updated_at, u.username FROM settings s LEFT JOIN users u ON u.id = s.updated_by WHERE s.key = ?')
      .get(KEY) as { value: string; updated_at: string; username: string | null } | undefined;
    return r ? { stored: JSON.parse(r.value) as Stored, updatedAt: r.updated_at, updatedBy: r.username } : null;
  };

  async function api(token: string, method: string, body: Record<string, unknown>) {
    let r: Response;
    try {
      r = await f(`${API}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      throw new HttpError(502, 'telegram_unreachable', { detail: (e as Error).message.slice(0, 160) });
    }
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: unknown };
    if (!r.ok || !j.ok) throw new HttpError(502, r.status === 401 ? 'telegram_bad_token' : 'telegram_error', { detail: String(j.description ?? `HTTP ${r.status}`).slice(0, 200) });
    return j.result;
  }

  /** Sends with at most one message per second (Telegram group limits), never throws. */
  function enqueue(token: string, chatId: string, html: string) {
    const run = queue.then(async () => {
      const wait = last + (opts.minIntervalMs ?? 1100) - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      await api(token, 'sendMessage', { chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true });
    });
    queue = run.catch((e) => opts.log?.(`telegram: ${(e as HttpError).code ?? (e as Error).message}`));
    return queue;
  }

  return {
    view(): TelegramView {
      const c = read();
      const s = c?.stored;
      const token = s?.tokenSealed ? sealer.open(s.tokenSealed) : '';
      return {
        configured: !!(s && token && s.chatId),
        enabled: s?.enabled ?? false,
        tokenSet: !!token,
        // bot tokens look like 123456:ABC…: show only the bot id part
        tokenHint: token ? `${token.split(':')[0]}:…` : '',
        chatId: s?.chatId ?? '',
        events: s?.events ?? [...TELEGRAM_EVENTS],
        summaryHour: s?.summaryHour ?? 19,
        updatedAt: c?.updatedAt ?? null,
        updatedBy: c?.updatedBy ?? null,
      };
    },

    save(input: { enabled: boolean; token?: string | undefined; chatId: string; events: TelegramEvent[]; summaryHour: number }, userId: number) {
      const prev = read()?.stored;
      const tokenSealed = input.token ? sealer.seal(input.token) : (prev?.tokenSealed ?? '');
      if (input.enabled && (!tokenSealed || !input.chatId)) throw new HttpError(400, 'connector_incomplete');
      const stored: Stored = { enabled: input.enabled, tokenSealed, chatId: input.chatId, events: [...new Set(input.events)], summaryHour: input.summaryHour };
      db.prepare(
        `INSERT INTO settings(key, value, updated_at, updated_by) VALUES(?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      ).run(KEY, JSON.stringify(stored), nowIso(), userId);
    },

    reset() {
      db.prepare('DELETE FROM settings WHERE key = ?').run(KEY);
    },

    savedToken(): string | null {
      const s = read()?.stored;
      return s?.tokenSealed ? sealer.open(s.tokenSealed) : null;
    },

    /** Test message with the given (or saved) token: errors are returned to the admin. */
    async test(token: string, chatId: string) {
      const me = (await api(token, 'getMe', {})) as { username?: string };
      await api(token, 'sendMessage', { chat_id: chatId, text: '✅ <b>CDA Net CPE</b>: notifiche Telegram attive.', parse_mode: 'HTML' });
      return { ok: true, bot: me?.username ?? null };
    },

    /** Chats that recently wrote to the bot (to find the group chat id). */
    async chats(token: string) {
      const updates = (await api(token, 'getUpdates', { limit: 50, allowed_updates: ['message', 'my_chat_member'] })) as Array<Record<string, unknown>>;
      const seen = new Map<string, { id: string; title: string; type: string }>();
      for (const u of updates ?? []) {
        const chat = ((u.message ?? u.my_chat_member) as { chat?: { id: number; title?: string; username?: string; first_name?: string; type?: string } } | undefined)?.chat;
        if (chat) seen.set(String(chat.id), { id: String(chat.id), title: chat.title ?? chat.username ?? chat.first_name ?? '', type: chat.type ?? '' });
      }
      return [...seen.values()];
    },

    /** Fire-and-forget notification for an enabled event. */
    notify(event: TelegramEvent, html: string) {
      const s = read()?.stored;
      if (!s?.enabled || !s.tokenSealed || !s.chatId || !s.events.includes(event)) return Promise.resolve();
      return enqueue(sealer.open(s.tokenSealed), s.chatId, html);
    },

    /** Resolves when every queued message has been sent (tests, shutdown). */
    idle: () => queue,

    summaryHour(): number | null {
      const s = read()?.stored;
      return s?.enabled && s.events.includes('daily_summary') ? s.summaryHour : null;
    },
  };
}
export type Telegram = ReturnType<typeof createTelegram>;
