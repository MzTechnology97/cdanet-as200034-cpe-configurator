import type { FastifyInstance } from 'fastify';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { recordEvent } from '../db.ts';
import { MAX_LINK_M } from '../domain/coverage-model.ts';
import { createCoverageAccuracy } from '../services/coverage-accuracy.ts';
import { isPtp } from '../services/uisp.ts';
import type { Bbox } from '../services/terrain-store.ts';

/** Area of the network: every AP that serves customers, plus the farthest link around it. */
export function networkArea(aps: Array<{ location: { lat: number; lon: number } }>, marginM = MAX_LINK_M): Bbox | null {
  if (!aps.length) return null;
  const lats = aps.map((a) => a.location.lat);
  const lons = aps.map((a) => a.location.lon);
  const dLat = marginM / 111_320;
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const dLon = marginM / (111_320 * Math.cos((midLat * Math.PI) / 180));
  return { minLat: Math.min(...lats) - dLat, minLon: Math.min(...lons) - dLon, maxLat: Math.max(...lats) + dLat, maxLon: Math.max(...lons) + dLon };
}

/**
 * Terreno e ostacoli (admins): what is imported (TINITALY elevation, WorldCover land cover) and
 * the import for the area of the network, run in the background (downloads from INGV and ESA).
 */
export function terrainRoutes(app: FastifyInstance, ctx: AppContext) {
  const admin = { preHandler: [ctx.auth.requireAdmin] };
  const accuracy = createCoverageAccuracy(ctx);

  /** Reliability of the coverage estimate on the real customers: last run, history, running. */
  app.get('/api/admin/coverage/accuracy', admin, async () => accuracy.view());

  app.post('/api/admin/coverage/accuracy', admin, async (req) => {
    if (!ctx.uisp) throw new HttpError(503, 'uisp_not_configured');
    const started = accuracy.start();
    if (started) recordEvent(ctx.db, req.user!.id, 'coverage.accuracy', 'Affidabilità della copertura', 'misura avviata');
    return { started, running: true };
  });

  app.get('/api/admin/terrain', admin, async () => {
    const aps = ctx.uisp ? await ctx.uisp.apsWithLocation().catch(() => []) : [];
    return { ...ctx.terrain.status(), area: networkArea(aps.filter((a) => !isPtp(a))) };
  });

  app.post('/api/admin/terrain/import', admin, async (req) => {
    if (!ctx.uisp) throw new HttpError(503, 'uisp_not_configured');
    if (ctx.terrain.state().running) throw new HttpError(409, 'import_running');
    const area = networkArea((await ctx.uisp.apsWithLocation()).filter((a) => !isPtp(a)));
    if (!area) throw new HttpError(409, 'no_aps');
    recordEvent(ctx.db, req.user!.id, 'terrain.import', 'Terreno e ostacoli', `area ${area.minLat.toFixed(2)}–${area.maxLat.toFixed(2)} N, ${area.minLon.toFixed(2)}–${area.maxLon.toFixed(2)} E`);
    // when the new terrain is in, measure again: the history shows what changed
    void ctx.terrain.importArea(area).then(() => accuracy.start());
    return { started: true, area };
  });
}
