import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, type AuthUser } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { nowIso, recordEvent } from '../db.ts';
import { isValidLatLon } from '../domain/geo.ts';
import { KIND_LABEL, OUTAGE_SOURCE } from '../services/outages.ts';

/** "Guasti Enel": outages in the areas of interest (module power_outages). */
export function outageRoutes(app: FastifyInstance, ctx: AppContext) {
  const user = { preHandler: [ctx.auth.requireUser, ctx.modules.require('power_outages')] };
  const admin = { preHandler: [ctx.auth.requireAdmin, ctx.modules.require('power_outages')] };
  const { db } = ctx;

  /** Admins see everything; installers only the POPs/APs/zones the admin assigned to them. */
  const keysFor = (u: AuthUser) => (u.role === 'admin' ? undefined : new Set(ctx.outages.assignments(u.id).map((i) => i.key)));

  const view = (u: AuthUser) => ({
    generatedAt: ctx.outages.status()?.at ?? null,
    lastRun: u.role === 'admin' ? ctx.outages.status() : null,
    source: 'e-distribuzione',
    labels: KIND_LABEL,
    scope: u.role === 'admin' ? { all: true, assigned: [] } : { all: false, assigned: ctx.outages.assignments(u.id) },
    active: ctx.outages.active(keysFor(u)),
  });

  app.get('/api/outages', user, async (req) => {
    const { recent } = z.object({ recent: z.coerce.boolean().default(false) }).parse(req.query);
    return { ...view(req.user!), ...(recent ? { recent: ctx.outages.recent(48, keysFor(req.user!)) } : {}) };
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
      active: ctx.outages.active(keysFor(u)).map((o) => ({
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
    zones: ctx.outages.manualZones(),
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

  app.get('/api/admin/outages/assignments', admin, async () => {
    const all = ctx.outages.allAssignments();
    const users = db.prepare("SELECT id, username, role, active FROM users WHERE role = 'installer' ORDER BY username").all() as Array<{ id: number; username: string; role: string; active: number }>;
    return {
      users: users.map((u) => ({ id: u.id, username: u.username, active: !!u.active, outagesModule: ctx.modules.stateFor(u.id).power_outages, items: all.get(u.id) ?? [] })),
    };
  });

  app.put('/api/admin/outages/assignments/:userId', admin, async (req) => {
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
      .object({ apZones: z.boolean().optional(), apRadiusKm: z.number().min(0.5).max(30).optional(), includePlanned: z.boolean().optional(), impactRadiusKm: z.number().min(0.1).max(5).optional() })
      .strict()
      .parse(req.body);
    const c = ctx.outages.setConfig(b, req.user!.id);
    recordEvent(db, req.user!.id, 'outages.config', 'Guasti Enel', JSON.stringify(b));
    return c;
  });

  app.post('/api/admin/outages/zones', admin, async (req, reply) => {
    const b = z.object({ name: z.string().trim().min(2).max(80), lat: z.number(), lon: z.number(), radiusKm: z.number().min(0.2).max(50) }).strict().parse(req.body);
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
