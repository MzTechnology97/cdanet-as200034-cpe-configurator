import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { recordEvent } from '../db.ts';
import { distanceM } from '../domain/geo.ts';
import { offGridHint, powerStatus } from '../services/victron-sync.ts';

/** Within this distance from a POP the GPS of a GX suggests that POP (the admin still confirms). */
const SUGGEST_M = 1000;

/**
 * Admins: the Victron installations read from VRM and the POP each one powers. The admin links
 * them by hand; the GPS of the GX (or a name with a word in common) only suggests a POP.
 */
export function victronRoutes(app: FastifyInstance, ctx: AppContext) {
  const admin = { preHandler: ctx.auth.requireAdmin };
  // the specialist sees the systems and reads them again; linking them to the POPs stays with the admins
  const staff = { preHandler: ctx.auth.requireStaff };

  const pops = async () =>
    ctx.uisp
      ? (await ctx.uisp.infrastructure()).pops.map((p) => ({
          id: p.id,
          name: p.name,
          lat: p.lat,
          lon: p.lon,
        }))
      : [];
  const words = (x: string) =>
    new Set(
      x
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .split(' ')
        .filter((w) => w.length >= 3 && !['pop', 'cda', 'net', 'cdanet', 'sito', 'victron'].includes(w)),
    );

  app.get('/api/admin/victron', staff, async () => {
    const list = await pops().catch(() => []);
    const byId = new Map(list.map((p) => [p.id, p]));
    const now = Date.now() / 1000;
    return {
      ...ctx.victronSync.state(),
      sites: ctx.victronSync.sites().map((s) => {
        // the nearest POP by the GPS of the GX, else the only POP with a word of the name in common
        let suggestion: {
          popId: string;
          popName: string;
          distanceM: number | null;
        } | null = null;
        if (s.lat !== null && s.lon !== null) {
          const near = list
            .filter((p) => p.lat !== null && p.lon !== null)
            .map((p) => ({
              p,
              d: distanceM({ lat: s.lat as number, lon: s.lon as number }, { lat: p.lat as number, lon: p.lon as number }),
            }))
            .sort((a, b) => a.d - b.d)[0];
          if (near && near.d <= SUGGEST_M)
            suggestion = {
              popId: near.p.id,
              popName: near.p.name,
              distanceM: Math.round(near.d),
            };
        }
        if (!suggestion) {
          const w = words(s.name);
          const hits = list.filter((p) => [...words(p.name)].some((x) => w.has(x)));
          if (hits.length === 1)
            suggestion = {
              popId: hits[0]!.id,
              popName: hits[0]!.name,
              distanceM: null,
            };
        }
        return {
          idSite: s.idSite,
          name: s.name,
          lastTs: s.lastTs,
          status: powerStatus(s, now),
          soc: s.soc,
          voltage: s.voltage,
          current: s.current,
          batteryState: s.batteryState,
          pvW: s.pvW,
          alarms: s.alarms,
          hasGps: s.lat !== null,
          acInput: s.acInput,
          offGrid: s.offGrid,
          // VRM: no grid on the AC input of the GX (the admin decides)
          offGridHint: offGridHint(s),
          popId: s.popId,
          popName: s.popId ? (byId.get(s.popId)?.name ?? null) : null,
          suggestion: s.popId ? null : suggestion,
        };
      }),
      pops: list.map((p) => ({ id: p.id, name: p.name })).sort((a, b) => a.name.localeCompare(b.name)),
    };
  });

  app.put('/api/admin/victron/:idSite/link', admin, async (req) => {
    const idSite = z.coerce
      .number()
      .int()
      .positive()
      .parse((req.params as { idSite: string }).idSite);
    // offGrid: the POP lives on its solar system only (an Enel outage hits only its customers)
    const { popId, offGrid } = z
      .object({ popId: z.string().trim().min(1).max(80).nullable(), offGrid: z.boolean().optional() })
      .strict()
      .parse(req.body);
    const site = ctx.victronSync.sites().find((s) => s.idSite === idSite);
    if (!site) throw new HttpError(404, 'vrm_site_not_found');
    const pop = popId ? (await pops()).find((p) => p.id === popId) : null;
    if (popId && !pop) throw new HttpError(404, 'pop_not_found');
    ctx.victronSync.link(idSite, popId, req.user!.id, offGrid);
    // a newly linked system gets its photovoltaic power now, not at the next sync
    if (popId && !site.popId) void ctx.victronSync.syncNow().catch(() => {});
    const now = ctx.victronSync.sites().find((s) => s.idSite === idSite);
    recordEvent(ctx.db, req.user!.id, 'victron.link', site.name, pop ? `alimenta ${pop.name}${now?.offGrid ? ' · off-grid' : ''}` : 'non collegato a un POP');
    return { idSite, popId, popName: pop?.name ?? null, offGrid: now?.offGrid ?? false };
  });

  app.post('/api/admin/victron/sync', staff, async () => {
    if (!ctx.victron.client()) throw new HttpError(400, 'vrm_incomplete');
    return ctx.victronSync.syncNow();
  });
}
