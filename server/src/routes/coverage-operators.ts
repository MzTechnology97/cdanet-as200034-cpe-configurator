import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { recordEvent } from '../db.ts';
import { isValidLatLon } from '../domain/geo.ts';
import { HttpError } from '../auth.ts';
import { forInstaller } from '../services/coverage-operators.ts';

/**
 * Copertura → «Altri operatori»: who else covers a point or an exact address (fibre, FTTC, FWA,
 * mobile) and with which AGCOM sticker. Admins see the operators; installers the same answer without
 * their names (rows of the same kind merged, so the names cannot be told by counting them). The
 * address is never written whole in the activity log.
 */
export function coverageOpsRoutes(app: FastifyInstance, ctx: AppContext) {
  const admin = { preHandler: ctx.auth.requireStaff };
  const field = { preHandler: [ctx.auth.requireUser, ctx.modules.require('coverage')] };

  const where = z.object({
    lat: z.coerce.number().optional(),
    lon: z.coerce.number().optional(),
    city: z.string().trim().min(2).max(80).optional(),
    street: z.string().trim().min(1).max(120).optional(),
    streetType: z.string().trim().max(40).default(''),
    number: z.string().trim().min(1).max(20).optional(),
    stair: z.string().trim().max(20).optional(),
    refresh: z.enum(['0', '1']).default('0'),
  });
  const step = z.object({
    city: z.string().trim().max(80).optional(),
    street: z.string().trim().max(120).optional(),
    streetType: z.string().trim().max(40).optional(),
    number: z.string().trim().max(20).optional(),
    q: z.string().trim().max(60).optional(),
  });

  async function lookup(req: FastifyRequest, refreshAllowed: boolean) {
    const q = where.parse(req.query);
    const refresh = refreshAllowed && q.refresh === '1';
    let r;
    if (q.city && q.street && q.number) r = await ctx.coverageOps.atAddress({ city: q.city, street: q.street, streetType: q.streetType, number: q.number, stair: q.stair || null }, { refresh });
    else if (q.lat != null && q.lon != null) {
      if (!isValidLatLon(q.lat, q.lon)) throw new HttpError(400, 'invalid_coordinates');
      r = await ctx.coverageOps.atPoint(q.lat, q.lon, { refresh });
    } else throw new HttpError(400, 'invalid_request');
    if (r.fresh) recordEvent(ctx.db, req.user!.id, 'coverage.operators', r.address?.city || 'punto', `${r.available} offerte attivabili${r.best ? ` · migliore ${r.best}` : ''}`);
    const { fresh: _, ...out } = r;
    return out;
  }

  app.get('/api/admin/coverage/operators', admin, (req) => lookup(req, true));
  app.get('/api/admin/coverage/operators/places', admin, (req) => ctx.coverageOps.place(step.parse(req.query)));

  // installers: without the operators' names, never a forced new reading
  app.get('/api/field/coverage/operators', field, async (req) => forInstaller(await lookup(req, false)));
  app.get('/api/field/coverage/operators/places', field, (req) => ctx.coverageOps.place(step.parse(req.query)));
}
