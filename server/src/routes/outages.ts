import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { nowIso, recordEvent } from '../db.ts';
import { isValidLatLon } from '../domain/geo.ts';
import { KIND_LABEL, OUTAGE_SOURCE } from '../services/outages.ts';

/** "Guasti Enel": outages in the areas of interest (module power_outages). */
export function outageRoutes(app: FastifyInstance, ctx: AppContext) {
  const user = { preHandler: [ctx.auth.requireUser, ctx.modules.require('power_outages')] };
  const admin = { preHandler: [ctx.auth.requireAdmin, ctx.modules.require('power_outages')] };
  const { db } = ctx;

  const view = () => ({
    generatedAt: ctx.outages.status()?.at ?? null,
    lastRun: ctx.outages.status(),
    source: 'e-distribuzione',
    labels: KIND_LABEL,
    active: ctx.outages.active(),
  });

  app.get('/api/outages', user, async (req) => {
    const { recent } = z.object({ recent: z.coerce.boolean().default(false) }).parse(req.query);
    return { ...view(), ...(recent ? { recent: ctx.outages.recent() } : {}) };
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
      active: ctx.outages.active().map((o) => ({
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

  app.post('/api/admin/outages/refresh', admin, async () => {
    const r = await ctx.outages.refresh();
    return { ...r, ...view() };
  });
}
