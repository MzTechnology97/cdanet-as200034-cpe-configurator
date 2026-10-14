import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { recordEvent } from '../db.ts';
import { orderStart } from '../domain/work-order-time.ts';
import { todayRome, WORK_ORDER_KIND_LABEL } from './work-orders.ts';
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

  /**
   * Read-only token for the app's background worker: it reads the notifications and the next
   * work orders (for the reminders on the phone), never opens a session.
   */
  app.post('/api/notifications/device-token', user, async (req) => {
    const u = ctx.db.prepare('SELECT id, username, token_version FROM users WHERE id = ?').get(req.user!.id) as { id: number; username: string; token_version: number };
    recordEvent(ctx.db, u.id, 'notifications.device', u.username, 'notifiche sul telefono attivate');
    return { token: await ctx.auth.issueFeedToken(u, 'feed') };
  });

  /** The session of the app, or the read-only token of its background service (FCM token renewed with the app closed). */
  const phoneUser = async (req: FastifyRequest) => {
    if (/^Bearer\s/i.test(req.headers.authorization ?? '')) {
      try {
        await ctx.auth.requireUser(req, undefined as unknown as FastifyReply);
        if (req.user) return req.user;
      } catch {
        // not a session: the feed token below
      }
    }
    return ctx.auth.verifyFeedToken(req, ['feed']);
  };

  /** Push notifications: how the app starts Firebase (null: not configured, the app stays connected to /api/events). */
  app.get('/api/mobile/push-config', async (req, reply) => {
    await phoneUser(req);
    const { package: pkg } = z.object({ package: z.string().max(120).default('it.cdanet.cpeconfigurator') }).parse(req.query);
    reply.header('Cache-Control', 'no-store');
    return { firebase: ctx.push.client(pkg) };
  });

  /** The FCM token of this phone: the notifications of the user reach it at once. */
  app.post('/api/notifications/push-token', async (req) => {
    const u = await phoneUser(req);
    const { token } = z.object({ token: z.string().min(20).max(4096) }).parse(req.body);
    ctx.push.register(u.id, token);
    return { ok: true };
  });

  /** Logout on the phone: no more push notifications to it. */
  app.delete('/api/notifications/push-token', async (req) => {
    await phoneUser(req);
    const { token } = z.object({ token: z.string().min(20).max(4096) }).parse(req.body);
    ctx.push.unregister(token);
    return { ok: true };
  });

  /** Feed of the background worker: unread notifications after [after] and the next work orders. */
  app.get('/api/notifications/feed', async (req, reply) => {
    const u = await ctx.auth.verifyFeedToken(req, ['feed']);
    const { after } = z.object({ after: z.coerce.number().int().min(0).default(0) }).parse(req.query);
    reply.header('Cache-Control', 'no-store');
    const items = ctx.db
      .prepare('SELECT id, kind, title, body FROM notifications WHERE user_id = ? AND read_at IS NULL AND id > ? ORDER BY id LIMIT 20')
      .all(u.id, after);
    const today = todayRome();
    const tomorrow = todayRome(new Date(Date.now() + 86400_000));
    const orders = ctx.modules.stateFor(u.id).work_orders
      ? (ctx.db
          .prepare("SELECT id, day, slot, kind, customer, address, updated_at updatedAt FROM work_orders WHERE assigned_to = ? AND status = 'open' AND day BETWEEN ? AND ? ORDER BY day, slot")
          .all(u.id, today, tomorrow) as Array<{ id: number; day: string; slot: string; kind: keyof typeof WORK_ORDER_KIND_LABEL; customer: string; address: string; updatedAt: string }>)
      : [];
    return {
      items,
      workOrders: orders.map((o) => ({
        id: o.id,
        customer: o.customer,
        address: o.address,
        slot: o.slot,
        kindLabel: WORK_ORDER_KIND_LABEL[o.kind],
        startAt: orderStart(o.day, o.slot).toISOString(),
        updatedAt: o.updatedAt,
      })),
    };
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
    // the bell of the user's other open consoles
    if (marked) ctx.live.publish('notifications', [req.user!.id]);
    return { ok: true, marked, unread: inbox().unread(req.user!.id) };
  });

  /**
   * The app saw a screenshot or screen recording by an account that may not take them (Android 14+
   * tells it; the image is black): the NOC is told, the activity log keeps it.
   */
  app.post('/api/security/screenshot-attempt', user, async (req) => {
    const b = z.object({ screen: z.string().trim().max(80).default(''), at: z.string().datetime().optional() }).strict().parse(req.body);
    if (req.user!.role === 'admin' || ctx.modules.stateFor(req.user!.id).screenshots) return { ok: true, notified: false };
    recordEvent(ctx.db, req.user!.id, 'security.screenshot', req.user!.username, b.screen || 'app');
    inbox().push('noc', {
      kind: 'screenshot_attempt',
      title: `Tentativo di screenshot: ${req.user!.username}`,
      lines: [`${req.user!.username} ha provato a fare uno screenshot o a registrare lo schermo nell'app${b.screen ? ` (schermata «${b.screen}»)` : ''}.`, "L'immagine è uscita nera: il suo account non può farne."],
    });
    return { ok: true, notified: true };
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
