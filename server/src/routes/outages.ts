import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, type AuthUser } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { nowIso, recordEvent } from '../db.ts';
import { approxPoint, roughDistance } from '../domain/approx.ts';
import { isValidLatLon } from '../domain/geo.ts';
import { KIND_LABEL, OUTAGE_SOURCE } from '../services/outages.ts';

/** "Guasti Enel": outages in the areas of interest (module power_outages). */
export function outageRoutes(app: FastifyInstance, ctx: AppContext) {
  const user = { preHandler: [ctx.auth.requireUser, ctx.modules.require('power_outages')] };
  const admin = { preHandler: [ctx.auth.requireAdmin, ctx.modules.require('power_outages')] };
  const { db } = ctx;

  /**
   * Admins see everything. Installers see the outages in their own zones and in what the admin assigned
   * to them; the potentially affected POPs/APs only for the assigned ones.
   */
  const keysFor = (u: AuthUser) => ctx.outages.keysFor(u.id, u.role);
  /** Installers: distances from POPs/APs rounded (no way back to the real position). */
  const shown = <T extends { impact: Array<{ distanceM: number; stations: number | null }>; zones: Array<{ distanceM?: number }> }>(u: AuthUser, list: T[]): T[] =>
    u.role === 'admin'
      ? list
      : list.map((o) => ({
          ...o,
          impact: o.impact.map((i) => ({ ...i, distanceM: roughDistance(i.distanceM), stations: ctx.outages.config().installerClients ? i.stations : null })),
          zones: o.zones.map((z) => (z.distanceM != null ? { ...z, distanceM: roughDistance(z.distanceM) } : z)),
        }));

  const view = (u: AuthUser) => ({
    generatedAt: ctx.outages.status()?.at ?? null,
    lastRun: u.role === 'admin' ? ctx.outages.status() : null,
    source: 'e-distribuzione',
    labels: KIND_LABEL,
    scope: u.role === 'admin' ? { all: true, assigned: [], zones: [] } : { all: false, assigned: ctx.outages.assignments(u.id), zones: ctx.outages.manualZones(u.id) },
    active: shown(u, ctx.outages.active(keysFor(u))),
  });

  app.get('/api/outages', user, async (req) => {
    const { recent } = z.object({ recent: z.coerce.boolean().default(false) }).parse(req.query);
    return { ...view(req.user!), ...(recent ? { recent: shown(req.user!, ctx.outages.recent(48, keysFor(req.user!))) } : {}) };
  });

  // ---- Personal areas of interest (every user with the module) -------------------------------
  const zoneBody = z.object({ name: z.string().trim().min(2).max(80), lat: z.number(), lon: z.number(), radiusKm: z.number().min(0.2).max(50) }).strict();
  const MAX_PERSONAL_ZONES = 20;

  app.get('/api/outages/zones', user, async (req) => ({ zones: ctx.outages.manualZones(req.user!.id) }));

  app.post('/api/outages/zones', user, async (req, reply) => {
    const b = zoneBody.parse(req.body);
    if (!isValidLatLon(b.lat, b.lon)) throw new HttpError(400, 'invalid_position');
    if (ctx.outages.manualZones(req.user!.id).length >= MAX_PERSONAL_ZONES) throw new HttpError(400, 'too_many_zones');
    const r = db
      .prepare('INSERT INTO outage_zones(name, lat, lon, radius_km, created_at, created_by, owner_id) VALUES(?,?,?,?,?,?,?)')
      .run(b.name, b.lat, b.lon, b.radiusKm, nowIso(), req.user!.id, req.user!.id);
    recordEvent(db, req.user!.id, 'outages.my_zone_add', b.name, `${b.radiusKm} km`);
    return reply.code(201).send({ id: Number(r.lastInsertRowid) });
  });

  app.delete('/api/outages/zones/:id', user, async (req) => {
    const id = z.coerce.number().int().positive().parse((req.params as { id: string }).id);
    const z0 = db.prepare('SELECT name FROM outage_zones WHERE id = ? AND owner_id = ?').get(id, req.user!.id) as { name: string } | undefined;
    if (!z0) throw new HttpError(404, 'zone_not_found');
    db.prepare('DELETE FROM outage_zones WHERE id = ?').run(id);
    recordEvent(db, req.user!.id, 'outages.my_zone_delete', z0.name, '');
    return { ok: true };
  });

  // ---- Personal Telegram (bot configured by the admin, each user links their own chat) ------
  const links = new Map<string, { userId: number; expires: number }>();
  const telegramState = (userId: number) => {
    const r = db.prepare('SELECT telegram_chat_id chat, telegram_planned planned FROM users WHERE id = ?').get(userId) as { chat: string; planned: number };
    return {
      available: ctx.modules.enabled('telegram') && ctx.telegram.personalAvailable(),
      linked: !!r.chat,
      chatHint: r.chat ? `…${r.chat.slice(-4)}` : '',
      planned: !!r.planned,
    };
  };
  const requireTelegram = () => {
    if (!ctx.modules.enabled('telegram') || !ctx.telegram.personalAvailable()) throw new HttpError(503, 'telegram_not_configured');
  };
  const linkChat = async (userId: number, chatId: string) => {
    await ctx.telegram.sendTo(chatId, '✅ <b>CDA Net</b>: riceverai qui le notifiche dei guasti Enel nelle tue zone.', true);
    db.prepare('UPDATE users SET telegram_chat_id = ? WHERE id = ?').run(chatId, userId);
  };

  app.get('/api/outages/telegram', user, async (req) => telegramState(req.user!.id));

  /** Link code: the user opens the bot and presses Start, then "Verifica". */
  app.post('/api/outages/telegram/link', user, async (req) => {
    requireTelegram();
    const bot = await ctx.telegram.botName();
    for (const [k, v] of links) if (v.expires < Date.now() || v.userId === req.user!.id) links.delete(k);
    const code = randomBytes(6).toString('hex');
    links.set(code, { userId: req.user!.id, expires: Date.now() + 15 * 60_000 });
    return { bot, code, url: `https://t.me/${bot}?start=${code}`, expiresInMin: 15 };
  });

  app.post('/api/outages/telegram/verify', user, async (req) => {
    requireTelegram();
    const code = [...links].find(([, v]) => v.userId === req.user!.id && v.expires > Date.now())?.[0];
    if (!code) throw new HttpError(400, 'link_expired');
    const chat = await ctx.telegram.findStart(code);
    if (!chat) throw new HttpError(409, 'start_not_found');
    await linkChat(req.user!.id, chat.id);
    links.delete(code);
    recordEvent(db, req.user!.id, 'outages.telegram_link', req.user!.username, 'Telegram personale collegato');
    return telegramState(req.user!.id);
  });

  app.put('/api/outages/telegram', user, async (req) => {
    const b = z
      .object({ chatId: z.string().trim().regex(/^-?\d{3,20}$/).optional(), planned: z.boolean().optional() })
      .strict()
      .parse(req.body);
    if (b.chatId) {
      requireTelegram();
      await linkChat(req.user!.id, b.chatId);
      recordEvent(db, req.user!.id, 'outages.telegram_link', req.user!.username, 'Telegram personale collegato (ID)');
    }
    if (b.planned !== undefined) db.prepare('UPDATE users SET telegram_planned = ? WHERE id = ?').run(b.planned ? 1 : 0, req.user!.id);
    return telegramState(req.user!.id);
  });

  app.delete('/api/outages/telegram', user, async (req) => {
    db.prepare("UPDATE users SET telegram_chat_id = '' WHERE id = ?").run(req.user!.id);
    recordEvent(db, req.user!.id, 'outages.telegram_unlink', req.user!.username, '');
    return telegramState(req.user!.id);
  });

  /**
   * Map data. Admins: outages, every zone and the monitored POPs/APs with their real position.
   * Installers: outages they may see, their zones, and only the assigned POPs/APs as an approximate area.
   */
  app.get('/api/outages/map', user, async (req) => {
    const u = req.user!;
    const keys = keysFor(u);
    const active = ctx.outages.active(keys);
    const hit = new Set(active.flatMap((o) => o.impact.map((i) => `${i.type}:${i.id}`)));
    const inf = await ctx.outages.infra();
    const mineAp = (a: { id: string; siteId: string | null }) => !keys || keys.has(`ap:${a.id}`) || (a.siteId !== null && keys.has(`pop:${a.siteId}`));
    const place = (key: string, lat: number, lon: number) => (keys ? { approx: approxPoint(lat, lon, key, ctx.cfg.jwtSecret) } : { lat, lon });
    const clients = (n: number | null) => (keys && !ctx.outages.config().installerClients ? null : n);
    const zones = keys
      ? [...ctx.outages.manualZones(u.id).map((z) => ({ ...z, personal: true })), ...ctx.outages.manualZones('shared').filter((z) => keys.has(z.id)).map((z) => ({ ...z, personal: false }))]
      : ctx.outages.manualZones('all').map((z) => ({ ...z, personal: z.ownerId != null }));
    return {
      outages: active.map((o) => ({ id: o.id, kind: o.kind, label: KIND_LABEL[o.kind], place: o.place, province: o.province, customers: o.customers, expectedRestore: o.expectedRestore, lat: o.lat, lon: o.lon, impacted: o.impact.length > 0 })),
      zones: zones.map((z) => ({ id: z.id, name: z.name, lat: z.lat, lon: z.lon, radiusKm: z.radiusKm, personal: z.personal })),
      infra: [
        ...inf.pops.filter((p) => !keys || keys.has(`pop:${p.id}`)).map((p) => ({ type: 'pop' as const, id: p.id, name: p.name, stations: clients(p.stations), impacted: hit.has(`pop:${p.id}`), ...place(`pop:${p.id}`, p.lat, p.lon) })),
        ...inf.aps.filter(mineAp).map((a) => ({ type: 'ap' as const, id: a.id, name: a.name, stations: clients(a.stations), impacted: hit.has(`ap:${a.id}`), ...place(`ap:${a.id}`, a.lat, a.lon) })),
      ],
    };
  });

  /** Read-only token for the app's background notifications (outage feed only). */
  app.post('/api/outages/device-token', user, async (req) => {
    const u = db.prepare('SELECT id, username, token_version FROM users WHERE id = ?').get(req.user!.id) as { id: number; username: string; token_version: number };
    recordEvent(db, u.id, 'outages.device', u.username, 'notifiche guasti sull’app attivate');
    return { token: await ctx.auth.issueFeedToken(u) };
  });

  /** Feed for the app's periodic worker (scoped token, minimal data). */
  app.get('/api/outages/feed', async (req) => {
    const u = await ctx.auth.verifyFeedToken(req);
    if (!ctx.modules.stateFor(u.id).power_outages) throw new HttpError(404, 'module_disabled');
    return {
      generatedAt: ctx.outages.status()?.at ?? null,
      active: shown(u, ctx.outages.active(keysFor(u))).map((o) => ({
        id: o.id,
        kind: o.kind,
        label: KIND_LABEL[o.kind],
        place: o.place,
        province: o.province,
        customers: o.customers,
        expectedRestore: o.expectedRestore,
        zone: o.zones[0]?.name ?? o.impact[0]?.name ?? '',
        impact: o.impact.slice(0, 5).map((i) => `${i.type === 'pop' ? 'POP' : 'AP'} ${i.name} (${i.distanceM} m)`),
      })),
    };
  });

  // ---- Admin: zones and settings -----------------------------------------------------------
  app.get('/api/admin/outages/config', admin, async () => ({
    config: ctx.outages.config(),
    zones: ctx.outages.manualZones('shared'),
    personalZones: ctx.outages
      .manualZones('all')
      .filter((x) => x.ownerId != null)
      .map((x) => ({ ...x, owner: (db.prepare('SELECT username FROM users WHERE id = ?').get(x.ownerId!) as { username: string } | undefined)?.username ?? '' })),
    apZonesCount: (await ctx.outages.zones()).filter((z) => z.source === 'ap').length,
    source: OUTAGE_SOURCE,
  }));

  /** POPs and APs read from UISP (addresses, coordinates), with what lacks a position. */
  app.get('/api/admin/outages/infra', admin, async () => {
    if (!ctx.uisp) throw new HttpError(503, 'uisp_not_configured');
    const inf = await ctx.uisp.infrastructure();
    return {
      ...inf,
      missing: {
        pops: inf.pops.filter((p) => p.lat === null).map((p) => p.name),
        aps: [...inf.pops.flatMap((p) => p.aps), ...inf.apsWithoutPop].filter((a) => a.lat === null).map((a) => a.name),
      },
    };
  });

  // ---- Admin: POPs/APs of interest (imported from UISP) and assignment to installers ---------
  const itemRef = z.object({
    key: z.string().regex(/^(?:(?:pop|ap):[\w.:-]{1,100}|z\d{1,9})$/),
    name: z.string().trim().min(1).max(120),
  });
  const items = z.array(itemRef).max(5000);

  app.get('/api/admin/outages/selection', admin, async () => ({ selectionOnly: ctx.outages.config().selectionOnly, items: ctx.outages.selection() }));

  app.put('/api/admin/outages/selection', admin, async (req) => {
    const b = z.object({ selectionOnly: z.boolean(), items }).strict().parse(req.body);
    const r = ctx.outages.setSelection(b.items, b.selectionOnly, req.user!.id);
    recordEvent(db, req.user!.id, 'outages.selection', 'Guasti Enel', b.selectionOnly ? `${b.items.length} POP/AP monitorati` : 'tutti i POP/AP');
    return { selectionOnly: r.config.selectionOnly, items: r.items };
  });

  // POP/AP assignments are general (Guasti Enel and coverage check): admin only, whatever the modules.
  const adminOnly = { preHandler: [ctx.auth.requireAdmin] };

  /** POPs and APs of UISP for the assignment picker. */
  app.get('/api/admin/infrastructure', adminOnly, async () => {
    if (!ctx.uisp) throw new HttpError(503, 'uisp_not_configured');
    return ctx.uisp.infrastructure();
  });

  app.get('/api/admin/assignments', adminOnly, async () => {
    const all = ctx.outages.allAssignments();
    const users = db.prepare("SELECT id, username, role, active FROM users WHERE role = 'installer' ORDER BY username").all() as Array<{ id: number; username: string; role: string; active: number }>;
    return {
      installerClients: ctx.outages.config().installerClients,
      zones: ctx.outages.manualZones('shared'),
      users: users.map((u) => {
        const m = ctx.modules.stateFor(u.id);
        return { id: u.id, username: u.username, active: !!u.active, modules: { power_outages: m.power_outages, coverage: m.coverage }, items: all.get(u.id) ?? [] };
      }),
    };
  });

  /** What installers may see of the POPs/APs (independent of the Guasti Enel module). */
  app.put('/api/admin/assignments/settings', adminOnly, async (req) => {
    const b = z.object({ installerClients: z.boolean() }).strict().parse(req.body);
    ctx.outages.setConfig(b, req.user!.id);
    recordEvent(db, req.user!.id, 'assignments.settings', 'POP/AP installatori', b.installerClients ? 'numero clienti visibile' : 'numero clienti nascosto');
    return b;
  });

  app.put('/api/admin/assignments/:userId', adminOnly, async (req) => {
    const userId = z.coerce.number().int().positive().parse((req.params as { userId: string }).userId);
    const u = db.prepare('SELECT username, role FROM users WHERE id = ?').get(userId) as { username: string; role: string } | undefined;
    if (!u) throw new HttpError(404, 'user_not_found');
    if (u.role === 'admin') throw new HttpError(400, 'admin_sees_all');
    const b = z.object({ items }).strict().parse(req.body);
    const r = ctx.outages.setAssignments(userId, b.items);
    recordEvent(db, req.user!.id, 'outages.assign', u.username, `${r.length} POP/AP/zone`);
    return { items: r };
  });

  app.put('/api/admin/outages/config', admin, async (req) => {
    const b = z
      .object({
        apZones: z.boolean().optional(),
        apRadiusKm: z.number().min(0.5).max(30).optional(),
        includePlanned: z.boolean().optional(),
        impactRadiusKm: z.number().min(0.1).max(5).optional(),
        installerClients: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    const c = ctx.outages.setConfig(b, req.user!.id);
    recordEvent(db, req.user!.id, 'outages.config', 'Guasti Enel', JSON.stringify(b));
    return c;
  });

  app.post('/api/admin/outages/zones', admin, async (req, reply) => {
    const b = zoneBody.parse(req.body);
    if (!isValidLatLon(b.lat, b.lon)) throw new HttpError(400, 'invalid_position');
    const r = db.prepare('INSERT INTO outage_zones(name, lat, lon, radius_km, created_at, created_by) VALUES(?,?,?,?,?,?)').run(b.name, b.lat, b.lon, b.radiusKm, nowIso(), req.user!.id);
    recordEvent(db, req.user!.id, 'outages.zone_add', b.name, `${b.radiusKm} km`);
    return reply.code(201).send({ id: Number(r.lastInsertRowid) });
  });

  app.delete('/api/admin/outages/zones/:id', admin, async (req) => {
    const id = z.coerce.number().int().positive().parse((req.params as { id: string }).id);
    const z0 = db.prepare('SELECT name FROM outage_zones WHERE id = ?').get(id) as { name: string } | undefined;
    if (!z0) throw new HttpError(404, 'zone_not_found');
    db.prepare('DELETE FROM outage_zones WHERE id = ?').run(id);
    recordEvent(db, req.user!.id, 'outages.zone_delete', z0.name, '');
    return { ok: true };
  });

  app.post('/api/admin/outages/refresh', admin, async (req) => {
    const r = await ctx.outages.refresh();
    return { ...r, ...view(req.user!) };
  });
}
