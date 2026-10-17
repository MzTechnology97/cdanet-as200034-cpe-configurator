import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { recordEvent } from '../db.ts';
import { MAX_LINK_M } from '../domain/coverage-model.ts';
import { createCoverageAccuracy } from '../services/coverage-accuracy.ts';
import { isPtp } from '../services/uisp.ts';
import type { Bbox } from '../services/terrain-store.ts';
import { existsSync } from 'node:fs';
import { PmTilesReader } from '../domain/pmtiles.ts';
import { REGIONS } from '../services/anncsu.ts';

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
  // what the specialist sees (the imports of terrain and data stay with the admins)
  const staff = { preHandler: [ctx.auth.requireStaff] };
  // the accuracy of the coverage model is measured on CDA Net's customers (issue #275)
  const all = { preHandler: [ctx.auth.requireSeesAll] };
  const accuracy = createCoverageAccuracy(ctx);

  /** Reliability of the coverage estimate on the real customers: last run, history, running. */
  app.get('/api/admin/coverage/accuracy', all, async () => accuracy.view());

  app.post('/api/admin/coverage/accuracy', all, async (req) => {
    if (!ctx.uisp) throw new HttpError(503, 'uisp_not_configured');
    const started = accuracy.start();
    if (started) recordEvent(ctx.db, req.user!.id, 'coverage.accuracy', 'Affidabilità della copertura', 'misura avviata');
    return { started, running: true };
  });

  app.get('/api/admin/terrain', staff, async () => {
    const aps = ctx.uisp ? await ctx.uisp.apsWithLocation().catch(() => []) : [];
    return { ...ctx.terrain.status(), basemap: existsSync(ctx.cfg.mapFile), anncsu: { ...ctx.anncsu.status(), import: ctx.anncsu.state() }, area: networkArea(aps.filter((a) => !isPtp(a))) };
  });

  app.post('/api/admin/terrain/import', admin, async (req) => {
    if (!ctx.uisp) throw new HttpError(503, 'uisp_not_configured');
    if (ctx.terrain.state().running) throw new HttpError(409, 'import_running');
    const area = networkArea((await ctx.uisp.apsWithLocation()).filter((a) => !isPtp(a)));
    if (!area) throw new HttpError(409, 'no_aps');
    recordEvent(ctx.db, req.user!.id, 'terrain.import', 'Terreno e ostacoli', `area ${area.minLat.toFixed(2)}–${area.maxLat.toFixed(2)} N, ${area.minLon.toFixed(2)}–${area.maxLon.toFixed(2)} E`);
    // then the buildings of the basemap (no download); when all is in, measure again: the
    // history shows what changed
    void ctx.terrain
      .importArea(area)
      .then(() => (existsSync(ctx.cfg.mapFile) ? buildings(area) : undefined))
      .then(() => accuracy.start());
    return { started: true, area };
  });

  /** Buildings of the basemap over [area], with the reader closed at the end. */
  async function buildings(area: Bbox) {
    const reader = new PmTilesReader(ctx.cfg.mapFile);
    try {
      await ctx.terrain.importBuildings(area, reader, ctx.cfg.coverageBuildingM);
    } finally {
      await reader.close();
    }
  }

  /**
   * Tree heights of the canopy map (Meta/WRI CHM v2, AWS Open Data) for the area of the network:
   * the server reads only the blocks it needs (about 4 MB per 0.1° tile).
   */
  app.post('/api/admin/terrain/canopy', admin, async (req) => {
    if (!ctx.uisp) throw new HttpError(503, 'uisp_not_configured');
    if (ctx.terrain.state().running) throw new HttpError(409, 'import_running');
    const area = networkArea((await ctx.uisp.apsWithLocation()).filter((a) => !isPtp(a)));
    if (!area) throw new HttpError(409, 'no_aps');
    recordEvent(ctx.db, req.user!.id, 'terrain.canopy', 'Altezze degli alberi', `area ${area.minLat.toFixed(2)}–${area.maxLat.toFixed(2)} N, ${area.minLon.toFixed(2)}–${area.maxLon.toFixed(2)} E`);
    void ctx.terrain.importCanopy(area).then(() => accuracy.start());
    return { started: true, area };
  });

  /** House numbers of ANNCSU for one region (Agenzia delle Entrate open data, tens of MB). */
  app.post('/api/admin/terrain/anncsu', admin, async (req) => {
    const { region } = z.object({ region: z.string().regex(/^[A-Z]{4}$/) }).parse(req.body);
    if (!REGIONS[region]) throw new HttpError(400, 'unknown_region');
    if (!ctx.uisp) throw new HttpError(503, 'uisp_not_configured');
    if (ctx.anncsu.state().running) throw new HttpError(409, 'import_running');
    const area = networkArea((await ctx.uisp.apsWithLocation()).filter((a) => !isPtp(a)));
    if (!area) throw new HttpError(409, 'no_aps');
    recordEvent(ctx.db, req.user!.id, 'terrain.anncsu', 'Civici ANNCSU', REGIONS[region]!);
    void ctx.anncsu.importRegion(region, area);
    return { started: true };
  });

  /** Only the buildings of the basemap (already on the server: a minute or two, nothing downloaded). */
  app.post('/api/admin/terrain/buildings', admin, async (req) => {
    if (!ctx.uisp) throw new HttpError(503, 'uisp_not_configured');
    if (ctx.terrain.state().running) throw new HttpError(409, 'import_running');
    if (!existsSync(ctx.cfg.mapFile)) throw new HttpError(409, 'basemap_missing');
    const area = networkArea((await ctx.uisp.apsWithLocation()).filter((a) => !isPtp(a)));
    if (!area) throw new HttpError(409, 'no_aps');
    recordEvent(ctx.db, req.user!.id, 'terrain.buildings', 'Edifici dalla mappa base', `area ${area.minLat.toFixed(2)}–${area.maxLat.toFixed(2)} N, ${area.minLon.toFixed(2)}–${area.maxLon.toFixed(2)} E`);
    void buildings(area).then(() => accuracy.start());
    return { started: true, area };
  });
}
