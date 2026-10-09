import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { recordEvent } from '../db.ts';
import { NOTIFY_KINDS, isNotifyKind, type NotifyKind } from '../services/inbox.ts';

/** Kinds a user can receive: the NOC's ones only for admins. */
const kindsFor = (role: string) => (Object.keys(NOTIFY_KINDS) as NotifyKind[]).filter((k) => role === 'admin' || NOTIFY_KINDS[k].audience === 'installer');

/** Notifications page (console and app) and which kinds also go to the personal Telegram chat. */
export function notificationRoutes(app: FastifyInstance, ctx: AppContext) {
  const user = { preHandler: ctx.auth.requireUser };
  const inbox = () => ctx.notify.inbox;

  app.get('/api/notifications', user, async (req, reply) => {
    const q = z.object({ unread: z.enum(['1', '0']).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    reply.header('Cache-Control', 'no-store');
    return { unread: inbox().unread(req.user!.id), items: inbox().list(req.user!.id, { unread: q.unread === '1', limit: q.limit }) };
  });

  /** Cheap count for the bell (polled by the console and the app). */
  app.get('/api/notifications/count', user, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { unread: inbox().unread(req.user!.id) };
  });

  app.post('/api/notifications/read', user, async (req) => {
    const b = z
      .union([z.object({ all: z.literal(true) }).strict(), z.object({ ids: z.array(z.number().int().positive()).min(1).max(500) }).strict()])
      .parse(req.body);
    const marked = inbox().markRead(req.user!.id, 'all' in b ? 'all' : b.ids);
    return { ok: true, marked, unread: inbox().unread(req.user!.id) };
  });

  app.get('/api/notifications/prefs', user, async (req) => {
    const on = new Set(inbox().telegramKinds(req.user!.id));
    const chat = (ctx.db.prepare('SELECT telegram_chat_id chat FROM users WHERE id = ?').get(req.user!.id) as { chat: string }).chat;
    return {
      kinds: kindsFor(req.user!.role).map((k) => ({ kind: k, label: NOTIFY_KINDS[k].label, noc: NOTIFY_KINDS[k].audience === 'noc', telegram: on.has(k) })),
      telegram: { available: ctx.modules.enabled('telegram') && ctx.telegram.personalAvailable(), linked: !!chat },
    };
  });

  app.put('/api/notifications/prefs', user, async (req) => {
    const b = z.object({ telegram: z.array(z.string().max(40)).max(20) }).strict().parse(req.body);
    const allowed = new Set(kindsFor(req.user!.role));
    const kinds = b.telegram.filter(isNotifyKind).filter((k) => allowed.has(k));
    // kinds the user may not receive keep their stored value (an admin demoted later)
    const keep = inbox().telegramKinds(req.user!.id).filter((k) => !allowed.has(k));
    inbox().setTelegramKinds(req.user!.id, [...kinds, ...keep]);
    recordEvent(ctx.db, req.user!.id, 'notifications.prefs', req.user!.username, kinds.join(', ') || 'nessuna su Telegram');
    return { ok: true, telegram: kinds };
  });
}
