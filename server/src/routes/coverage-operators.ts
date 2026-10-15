import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { recordEvent } from '../db.ts';
import { isValidLatLon } from '../domain/geo.ts';
import { HttpError } from '../auth.ts';

/**
 * Copertura → «Altri operatori»: who else covers a point (fibre, FTTC, FWA, mobile) and with which
 * AGCOM sticker. Admins only for now; the address is never written whole in the activity log.
 */
export function coverageOpsRoutes(app: FastifyInstance, ctx: AppContext) {
  const admin = { preHandler: ctx.auth.requireAdmin };

  app.get('/api/admin/coverage/operators', admin, async (req) => {
    const q = z.object({ lat: z.coerce.number(), lon: z.coerce.number(), refresh: z.coerce.boolean().default(false) }).parse(req.query);
    if (!isValidLatLon(q.lat, q.lon)) throw new HttpError(400, 'invalid_coordinates');
    const r = await ctx.coverageOps.atPoint(q.lat, q.lon, { refresh: q.refresh });
    if (r.fresh) recordEvent(ctx.db, req.user!.id, 'coverage.operators', r.address?.city || 'punto', `${r.available} offerte attivabili${r.best ? ` · migliore ${r.best}` : ''}`);
    const { fresh: _, ...out } = r;
    return out;
  });
}
