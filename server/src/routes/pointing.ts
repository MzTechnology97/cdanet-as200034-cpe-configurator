import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { nowIso, recordEvent } from '../db.ts';
import { approxPoint, roughDistance } from '../domain/approx.ts';
import { distanceM, isValidLatLon } from '../domain/geo.ts';
import { lineOfSight, pathPoints, resolveApAltitude } from '../domain/los.ts';
import { MAX_LINK_M, rankCoverage, type ApModel } from '../domain/coverage-model.ts';
import { buildProfile, estimateForAp, obstacles, pointingConfig, profileEffect, terrainSampler } from '../services/terrain.ts';
import { elevationAngle } from '../services/dem.ts';

export { resolveApAltitude } from '../domain/los.ts';

export type { PointingConfig } from '../services/terrain.ts';

/**
 * Pointing from the installation point (module "compass"): the nearest APs with distance, azimuth,
 * altitude a.s.l. and tilt (terrain from the DEM + antenna heights). Installers: only assigned
 * APs, approximate position, rounded distance; azimuth and tilt stay exact (needed to aim).
 */
export function pointingRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;
  const config = () => pointingConfig(db);

  // with how many APs actually use the configured antenna height (those without altitude in UISP)
  app.get('/api/admin/pointing/config', { preHandler: ctx.auth.requireAdmin }, async () => ({
    ...config(),
    dem: ctx.dem.enabled,
    apSources: ctx.uisp ? await ctx.uisp.apAltitudeSources().catch(() => null) : null,
  }));

  app.put('/api/admin/pointing/config', { preHandler: ctx.auth.requireAdmin }, async (req) => {
    const b = z.object({ apHeightM: z.number().min(0).max(200), cpeHeightM: z.number().min(0).max(100) }).strict().parse(req.body);
    db.prepare(
      `INSERT INTO settings(key, value, updated_at, updated_by) VALUES('pointing.config', ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ).run(JSON.stringify(b), nowIso(), req.user!.id);
    recordEvent(db, req.user!.id, 'pointing.config', 'Puntamento', `AP ${b.apHeightM} m, CPE ${b.cpeHeightM} m`);
    return b;
  });

  app.get('/api/pointing', { preHandler: [ctx.auth.requireUser, ctx.modules.require('compass')] }, async (req) => {
    const c = config();
    const q = z
      .object({
        lat: z.coerce.number(),
        lon: z.coerce.number(),
        height: z.coerce.number().min(0).max(100).optional(),
        limit: z.coerce.number().int().min(1).max(15).default(8),
      })
      .parse(req.query);
    if (!isValidLatLon(q.lat, q.lon)) throw new HttpError(400, 'invalid_position');
    if (!ctx.uisp) throw new HttpError(503, 'uisp_not_configured');
    const keys = req.user!.role === 'admin' ? null : new Set(ctx.outages.assignments(req.user!.id).map((i) => i.key));
    const allow = keys ? (a: { id: string; siteId: string | null }) => keys.has(`ap:${a.id}`) || (a.siteId !== null && keys.has(`pop:${a.siteId}`)) : undefined;
    // same choice as Copertura: every AP within range rated by estimated signal, the limit last
    // (installers: the number set in Impostazioni server, no inactive or hopeless APs)
    const maxKm = Math.min(ctx.uispSettings.coverageMaxKm, MAX_LINK_M / 1000);
    const inRange = await ctx.uisp.nearestAps({ lat: q.lat, lon: q.lon }, 500, maxKm, allow);
    const radio = { eirpDbm: ctx.cfg.coverageEirpDbm, cpeGainDbi: ctx.cfg.coverageCpeGainDbi };
    const models = await ctx.uisp.apModels(inRange.map((a) => a.id), radio).catch(() => new Map<string, ApModel>());
    const clientsShown = !keys || ctx.outages.config().installerClients;
    const height = q.height ?? c.cpeHeightM;
    // the terrain towards every AP, as in Visibilità: a hill in the way lowers the expected signal
    const at = await terrainSampler(ctx.terrain, [{ lat: q.lat, lon: q.lon }, ...inRange]);
    const estimateFor = (a: (typeof inRange)[number]) => {
      const e = estimateForAp(models.get(a.id), a, { lat: q.lat, lon: q.lon }, at, { cpeM: height, apM: c.apHeightM }, radio, obstacles(ctx));
      return e && { ...e, basis: clientsShown ? e.basis : null, nearby: clientsShown ? e.nearby : null };
    };
    const ranked = rankCoverage(
      inRange.map((a) => ({ ...a, estimate: estimateFor(a) })),
      ctx.cfg.thresholds.signalMin,
    );
    const useful = keys ? ranked.filter((a) => a.rating !== 'non attivo' && a.rating !== 'improbabile') : ranked;
    const aps = useful.slice(0, keys ? ctx.cfg.installerCoverageAps : q.limit);
    const [ground, ...apGround] = await Promise.all([ctx.dem.elevation(q.lat, q.lon), ...aps.map((a) => ctx.dem.elevation(a.lat, a.lon))]);
    const from = ground === null ? null : ground + height;
    return {
      from: { lat: q.lat, lon: q.lon, ground, height, altitude: from },
      apHeightM: c.apHeightM,
      maxKm,
      restricted: !!keys,
      assignedCount: keys ? [...keys].filter((k) => !k.startsWith('z')).length : null,
      inRange: inRange.length,
      discarded: ranked.length - useful.length,
      aps: aps.map(({ lat, lon, siteId: _site, stations: _st, ...a }, i) => {
        const { altitude, from: altitudeFrom } = resolveApAltitude(a.gpsAltitude, apGround[i] ?? null, a.siteHeight ?? c.apHeightM);
        const base = {
          id: a.id,
          name: a.name,
          ssid: a.ssid,
          siteName: a.siteName,
          status: a.status,
          bearing: a.bearing,
          direction: a.direction,
          altitude,
          altitudeFrom,
          tiltDeg: altitude !== null && from !== null ? elevationAngle(a.distanceM, from, altitude) : null,
          estimate: a.estimate,
          rating: a.rating,
        };
        return keys ? { ...base, distanceM: roughDistance(a.distanceM, ctx.cfg.installerDistanceStepM), approx: approxPoint(lat, lon, `ap:${a.id}`, ctx.cfg.jwtSecret) } : { ...base, distanceM: a.distanceM, lat, lon };
      }),
    };
  });

  /**
   * Line of sight towards one AP: terrain profile (DEM) between the CPE point and the AP, earth
   * curvature and 60% of the first Fresnel zone. Installers get distances and heights only, never
   * the AP's coordinates.
   */
  app.get('/api/pointing/profile', { preHandler: [ctx.auth.requireUser, ctx.modules.require('compass')] }, async (req) => {
    const c = config();
    const q = z
      .object({ lat: z.coerce.number(), lon: z.coerce.number(), apId: z.string().min(1).max(80), height: z.coerce.number().min(0).max(100).optional() })
      .parse(req.query);
    if (!isValidLatLon(q.lat, q.lon)) throw new HttpError(400, 'invalid_position');
    if (!ctx.uisp) throw new HttpError(503, 'uisp_not_configured');
    const keys = req.user!.role === 'admin' ? null : new Set(ctx.outages.assignments(req.user!.id).map((i) => i.key));
    const allow = keys ? (a: { id: string; siteId: string | null }) => keys.has(`ap:${a.id}`) || (a.siteId !== null && keys.has(`pop:${a.siteId}`)) : undefined;
    // any AP within range: the list may have ranked a farther one first (admins: as far as Copertura goes)
    const aps = await ctx.uisp.nearestAps({ lat: q.lat, lon: q.lon }, 500, keys ? ctx.uispSettings.coverageMaxKm : 200, allow);
    const ap = aps.find((a) => a.id === q.apId);
    if (!ap) throw new HttpError(404, 'ap_not_found');
    const height = q.height ?? c.cpeHeightM;
    // the same profile as the expected signal: TINITALY (or SRTM), buildings and trees of the land cover
    const at = await terrainSampler(ctx.terrain, [{ lat: q.lat, lon: q.lon }, ap], 500);
    if (!at) throw new HttpError(503, 'dem_not_configured');
    const p = buildProfile(at, { lat: q.lat, lon: q.lon }, height, ap, c.apHeightM, obstacles(ctx), 25, 400);
    if (!p) throw new HttpError(503, 'dem_unavailable');
    const solid = p.d.map((d, i) => ({ d, ground: p.ground[i]! + (p.obstacle[i]?.kind === 'edificio' ? p.obstacle[i]!.h : 0) }));
    const r = lineOfSight(solid, p.from, p.to, p.freq);
    const effect = profileEffect(p);
    // chart: bare ground (with the earth bulge) and the obstacle standing on it, for the drawing
    const R_EFF = 6371000 * (4 / 3);
    const chart = r.chart.map((pt, i) => {
      const bulge = (p.d[i]! * (p.D - p.d[i]!)) / (2 * R_EFF);
      const o = p.obstacle[i];
      return { ...pt, ground: Math.round((p.ground[i]! + bulge) * 10) / 10, ...(o ? { obstacle: o.kind, top: Math.round((p.ground[i]! + bulge + o.h) * 10) / 10 } : {}) };
    });
    return {
      ap: { id: ap.id, name: ap.name },
      distanceM: keys ? roughDistance(p.D, ctx.cfg.installerDistanceStepM) : Math.round(p.D),
      cpeHeightM: height,
      frequencyMhz: p.freq,
      terrainSource: at.fine ? 'tinitaly' : 'srtm',
      lossDb: effect.lossDb,
      foliageM: effect.foliageM ?? 0,
      buildings: effect.buildings ?? false,
      ...r,
      chart,
    };
  });
}
