import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { nowIso, recordEvent } from '../db.ts';
import { approxPoint, roughDistance } from '../domain/approx.ts';
import { distanceM, isValidLatLon } from '../domain/geo.ts';
import { lineOfSight, pathPoints } from '../domain/los.ts';
import { estimateOrTheory, rankCoverage, type ApModel } from '../domain/coverage-model.ts';
import { FIELD_THRESHOLDS } from './field.ts';
import { elevationAngle } from '../services/dem.ts';

/**
 * Altitude of the AP antenna, metres a.s.l. UISP's location.altitude is the GPS altitude on GPS
 * APs; on the others it holds small values (a height above the ground typed in UISP). Otherwise:
 * terrain + antenna height (site height in UISP, else the admin default). Pure, unit-tested.
 */
export function resolveApAltitude(reported: number | null, ground: number | null, height: number): { altitude: number | null; from: 'gps' | 'uisp' | 'terreno' | null } {
  if (reported !== null) {
    if (ground !== null ? reported >= ground - 30 : reported >= 100) return { altitude: reported, from: 'gps' };
    if (ground !== null && reported >= 0 && reported < 100) return { altitude: ground + reported, from: 'uisp' };
  }
  return ground === null ? { altitude: null, from: null } : { altitude: ground + height, from: 'terreno' };
}

export interface PointingConfig {
  /** Height of the AP antennas above the ground (UISP has no field for it). */
  apHeightM: number;
  /** Default height of the CPE above the ground (the technician can change it). */
  cpeHeightM: number;
}
const DEFAULT: PointingConfig = { apHeightM: 15, cpeHeightM: 6 };

/**
 * Pointing from the installation point (module "compass"): the nearest APs with distance, azimuth,
 * altitude a.s.l. and tilt (terrain from the DEM + antenna heights). Installers: only assigned
 * APs, approximate position, rounded distance; azimuth and tilt stay exact (needed to aim).
 */
export function pointingRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;
  const config = (): PointingConfig => {
    const r = db.prepare("SELECT value FROM settings WHERE key = 'pointing.config'").get() as { value: string } | undefined;
    return { ...DEFAULT, ...(r ? (JSON.parse(r.value) as Partial<PointingConfig>) : {}) };
  };

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
    const inRange = await ctx.uisp.nearestAps({ lat: q.lat, lon: q.lon }, 500, ctx.uispSettings.coverageMaxKm, allow);
    const models = await ctx.uisp.apModels(inRange.map((a) => a.id)).catch(() => new Map<string, ApModel>());
    const clientsShown = !keys || ctx.outages.config().installerClients;
    const radio = { eirpDbm: ctx.cfg.coverageEirpDbm, cpeGainDbi: ctx.cfg.coverageCpeGainDbi };
    const estimateFor = (a: { id: string; distanceM: number; bearing: number; frequency: number | null }) => {
      const m = models.get(a.id);
      if (!m) return null;
      // no customers on the AP: theoretical estimate (less accurate, marked as such)
      const e = estimateOrTheory(m, a.distanceM, (a.bearing + 180) % 360, a.frequency, radio);
      return { ...e, basis: clientsShown ? e.basis : null, nearby: clientsShown ? e.nearby : null };
    };
    const ranked = rankCoverage(
      inRange.map((a) => ({ ...a, estimate: estimateFor(a) })),
      FIELD_THRESHOLDS.signalMin,
    );
    const useful = keys ? ranked.filter((a) => a.rating !== 'non attivo' && a.rating !== 'improbabile') : ranked;
    const aps = useful.slice(0, keys ? ctx.cfg.installerCoverageAps : q.limit);
    const height = q.height ?? c.cpeHeightM;
    const [ground, ...apGround] = await Promise.all([ctx.dem.elevation(q.lat, q.lon), ...aps.map((a) => ctx.dem.elevation(a.lat, a.lon))]);
    const from = ground === null ? null : ground + height;
    return {
      from: { lat: q.lat, lon: q.lon, ground, height, altitude: from },
      apHeightM: c.apHeightM,
      maxKm: ctx.uispSettings.coverageMaxKm,
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
        return keys ? { ...base, distanceM: roughDistance(a.distanceM), approx: approxPoint(lat, lon, `ap:${a.id}`, ctx.cfg.jwtSecret) } : { ...base, distanceM: a.distanceM, lat, lon };
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
    if (!ctx.dem.enabled) throw new HttpError(503, 'dem_not_configured');
    const keys = req.user!.role === 'admin' ? null : new Set(ctx.outages.assignments(req.user!.id).map((i) => i.key));
    const allow = keys ? (a: { id: string; siteId: string | null }) => keys.has(`ap:${a.id}`) || (a.siteId !== null && keys.has(`pop:${a.siteId}`)) : undefined;
    // any AP within range: the list may have ranked a farther one first (admins: as far as Copertura goes)
    const aps = await ctx.uisp.nearestAps({ lat: q.lat, lon: q.lon }, 500, keys ? ctx.uispSettings.coverageMaxKm : 200, allow);
    const ap = aps.find((a) => a.id === q.apId);
    if (!ap) throw new HttpError(404, 'ap_not_found');
    const D = distanceM({ lat: q.lat, lon: q.lon }, { lat: ap.lat, lon: ap.lon });
    const n = Math.max(16, Math.min(96, Math.round(D / 60)));
    const pts = pathPoints({ lat: q.lat, lon: q.lon }, { lat: ap.lat, lon: ap.lon }, n);
    const ground = await Promise.all(pts.map((p) => ctx.dem.elevation(p.lat, p.lon)));
    if (ground.some((g) => g === null)) throw new HttpError(503, 'dem_unavailable');
    const height = q.height ?? c.cpeHeightM;
    const from = ground[0]! + height;
    const { altitude } = resolveApAltitude(ap.gpsAltitude, ground[n]!, ap.siteHeight ?? c.apHeightM);
    const freq = ap.frequency && ap.frequency > 1000 ? ap.frequency : 5600;
    const r = lineOfSight(pts.map((p, i) => ({ d: p.f * D, ground: ground[i]! })), from, altitude ?? ground[n]! + c.apHeightM, freq);
    return {
      ap: { id: ap.id, name: ap.name },
      distanceM: keys ? roughDistance(D) : Math.round(D),
      cpeHeightM: height,
      frequencyMhz: freq,
      ...r,
    };
  });
}
