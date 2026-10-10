import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { nowIso, recordEvent } from '../db.ts';
import { toCsv } from '../domain/csv.ts';
import { configDrift } from '../domain/drift.ts';
import { installedHealth, type InstalledJob } from '../domain/health.ts';
import type { RadiusInfo } from '../services/crm-sync.ts';
import { FIELD_THRESHOLDS } from './field.ts';
import { isValidLatLon } from '../domain/geo.ts';
import { parseMac, SSID_PARTS, TARGET_FIRMWARE } from '../domain/policy.ts';
import type { ModuleKey } from '../services/modules.ts';
import { isAp, isPtp, type UispDevice } from '../services/uisp.ts';
import { approxPoint, roughDistance } from '../domain/approx.ts';
import { estimateSignal, rankCoverage, type ApModel } from '../domain/coverage-model.ts';

interface JobRow {
  id: string;
  user_id: number;
  status: string;
  ssid: string;
  mac: string;
  detected: string;
  latitude: number | null;
  longitude: number | null;
  uisp_device_id: string;
  uisp_site: string;
  uisp_authorized_at: string | null;
}

export function uispRoutes(app: FastifyInstance, ctx: AppContext) {
  const user = { preHandler: ctx.auth.requireUser };
  const admin = { preHandler: ctx.auth.requireAdmin };
  const mod = (k: ModuleKey, base: typeof user | typeof admin = user) => ({ preHandler: [base.preHandler, ctx.modules.require(k)] });
  const { db } = ctx;

  const uisp = () => {
    if (!ctx.uisp) throw new HttpError(503, 'uisp_not_configured');
    return ctx.uisp;
  };

  const loadJob = (req: FastifyRequest) => {
    const id = z.string().uuid().parse((req.params as { id: string }).id);
    const job = db.prepare('SELECT * FROM provisioning_jobs WHERE id = ?').get(id) as JobRow | undefined;
    if (!job) throw new HttpError(404, 'job_not_found');
    if (job.user_id !== req.user!.id && req.user!.role !== 'admin') throw new HttpError(403, 'forbidden');
    return job;
  };

  /** The UISP device of a job: remembered id, else lookup by MAC (job MAC or MAC read on the CPE). */
  async function deviceOf(job: JobRow): Promise<UispDevice | null> {
    const u = uisp();
    if (job.uisp_device_id) {
      const d = await u.device(job.uisp_device_id);
      if (d) return d;
    }
    const detected = (() => {
      try {
        return (JSON.parse(job.detected || '{}') as { mac?: string }).mac;
      } catch {
        return undefined;
      }
    })();
    const d = await u.findByMac(job.mac, detected);
    if (d && d.id !== job.uisp_device_id) db.prepare('UPDATE provisioning_jobs SET uisp_device_id = ? WHERE id = ?').run(d.id, job.id);
    return d;
  }

  const near = (job: JobRow) => (job.latitude !== null && job.longitude !== null ? { lat: job.latitude, lon: job.longitude } : null);

  // ---- Coverage: nearest APs only (never the full network map) ------------------------
  app.get('/api/geocode', user, async (req) => {
    const { q } = z.object({ q: z.string().trim().min(3).max(200) }).parse(req.query);
    return ctx.geocoder.search(q);
  });

  app.get('/api/geocode/reverse', user, async (req) => {
    const { lat, lon } = z.object({ lat: z.coerce.number(), lon: z.coerce.number() }).parse(req.query);
    if (!isValidLatLon(lat, lon)) throw new HttpError(400, 'invalid_position');
    return (await ctx.geocoder.reverse(lat, lon)) ?? { label: '', street: '', houseNumber: '', city: '', province: '', postcode: '' };
  });

  app.get('/api/coverage', mod('coverage'), async (req) => {
    const q = z
      .object({ lat: z.coerce.number(), lon: z.coerce.number(), limit: z.coerce.number().int().min(1).max(50).default(5), km: z.coerce.number().min(1).max(200).optional() })
      .parse(req.query);
    // admins: no limits (up to 50 APs, the distance they ask up to 200 km); installers, from the
    // web or the app alike: the number set in Impostazioni server, within the configured radius
    const isAdmin = req.user!.role === 'admin';
    const limit = isAdmin ? q.limit : ctx.cfg.installerCoverageAps;
    const maxKm = isAdmin ? (q.km ?? ctx.uispSettings.coverageMaxKm) : ctx.uispSettings.coverageMaxKm;
    if (!isValidLatLon(q.lat, q.lon)) throw new HttpError(400, 'invalid_position');
    // Installers check coverage only on the POPs/APs assigned to them by the admin.
    const keys = req.user!.role === 'admin' ? null : new Set(ctx.outages.assignments(req.user!.id).map((i) => i.key));
    const allow = keys ? (a: { id: string; siteId: string | null }) => keys.has(`ap:${a.id}`) || (a.siteId !== null && keys.has(`pop:${a.siteId}`)) : undefined;
    // every AP within range is rated, the limit comes last: a good AP a bit farther away is not
    // hidden by closer ones with a worse signal
    const inRange = await uisp().nearestAps({ lat: q.lat, lon: q.lon }, 500, maxKm, allow);
    const models = await uisp().apModels(inRange.map((a) => a.id)).catch(() => new Map<string, ApModel>());
    const clientsShown = !keys || ctx.outages.config().installerClients;
    const estimateFor = (a: { id: string; distanceM: number; bearing: number }) => {
      const m = models.get(a.id);
      if (!m) return null;
      // bearing from the AP towards the point = reverse of the pointing direction
      const e = estimateSignal(m, a.distanceM, (a.bearing + 180) % 360);
      return { ...e, basis: clientsShown ? e.basis : null, nearby: clientsShown ? e.nearby : null };
    };
    const served = (a: { id: string }) => {
      const m = models.get(a.id);
      return m && m.sector ? { center: m.sector.center, width: m.sector.width, servedM: m.servedM } : null;
    };
    const ranked = rankCoverage(
      inRange.map((a) => ({ ...a, estimate: estimateFor(a) })),
      FIELD_THRESHOLDS.signalMin,
    );
    // installers: only the APs worth a try (no inactive ones, none whose best case is below the minimum)
    const useful = keys ? ranked.filter((a) => a.rating !== 'non attivo' && a.rating !== 'improbabile') : ranked;
    const aps = useful.slice(0, limit);
    return {
      maxKm,
      restricted: !!keys,
      assignedCount: keys ? [...keys].filter((k) => !k.startsWith('z')).length : null,
      minSignalDbm: FIELD_THRESHOLDS.signalMin,
      inRange: inRange.length,
      discarded: ranked.length - useful.length,
      aps: aps.map(({ lat, lon, siteId: _site, gpsAltitude: _alt, siteHeight: _h, ...a }) => {
        const m = a.ssid ? SSID_PARTS.exec(a.ssid) : null;
        const base = { ...a, node: m ? Number(m[1]) : null, district: m ? Number(m[2]) : null, relay: m?.[3] ? Number(m[3]) : null };
        // Installers: exact direction for pointing, rounded distance and only an approximate area on the map.
        if (!keys) return { ...base, lat, lon, served: served(a) };
        const stations = ctx.outages.config().installerClients ? base.stations : null;
        return { ...base, stations, distanceM: roughDistance(a.distanceM), approx: approxPoint(lat, lon, `ap:${a.id}`, ctx.cfg.jwtSecret) };
      }),
    };
  });

  /**
   * Admin, Copertura: radio simulation of one AP. Expected signal of a new CPE on a grid around
   * it, learned from the customers already connected (distance, direction, nearby customers);
   * obstacles are not considered (that is the line-of-sight profile). Cells with no estimate are
   * left out.
   */
  app.get('/api/admin/coverage/simulation', mod('coverage', admin), async (req) => {
    const q = z.object({ apId: z.string().min(1).max(80) }).parse(req.query);
    const ap = (await uisp().apsWithLocation()).find((a) => a.id === q.apId && !isPtp(a));
    if (!ap) throw new HttpError(404, 'ap_not_found');
    const m = (await uisp().apModels([ap.id])).get(ap.id);
    const base = { ap: { id: ap.id, name: ap.name, lat: ap.location.lat, lon: ap.location.lon }, minDbm: FIELD_THRESHOLDS.signalMin, goodDbm: FIELD_THRESHOLDS.signalGood };
    if (!m?.fit) return { ...base, customers: m?.samples.length ?? 0, cells: [], cellM: 0, radiusM: 0, sector: m?.sector ?? null, servedM: m?.servedM ?? null };
    // out to 1.5 times the customers served (at least 1.5 km, at most 15 km), 40 x 40 cells
    const radiusM = Math.round(Math.min(15000, Math.max(1500, (m.servedM ?? 2000) * 1.5)));
    const n = 40;
    const cellM = (2 * radiusM) / n;
    const mPerLat = 111_320;
    const mPerLon = 111_320 * Math.cos((ap.location.lat * Math.PI) / 180);
    const cells: Array<{ lat: number; lon: number; dbm: number; confidence: string }> = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const dx = -radiusM + (i + 0.5) * cellM;
        const dy = -radiusM + (j + 0.5) * cellM;
        const d = Math.hypot(dx, dy);
        if (d > radiusM) continue;
        const b = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
        const e = estimateSignal(m, d, b);
        if (e.signalDbm === null) continue;
        cells.push({ lat: Math.round((ap.location.lat + dy / mPerLat) * 1e6) / 1e6, lon: Math.round((ap.location.lon + dx / mPerLon) * 1e6) / 1e6, dbm: e.signalDbm, confidence: e.confidence });
      }
    }
    return { ...base, customers: m.samples.length, cells, cellM: Math.round(cellM), radiusM, sector: m.sector, servedM: m.servedM };
  });

  // ---- UISP status of a provisioned CPE -----------------------------------------------
  app.get('/api/provisioning/jobs/:id/uisp', user, async (req) => {
    const job = loadJob(req);
    if (!ctx.uisp) return { configured: false };
    const device = await deviceOf(job);
    const site = device && !device.authorized ? await ctx.uisp.siteForStation(device, job.ssid, near(job)) : null;
    return {
      configured: true,
      device,
      authorizedAt: job.uisp_authorized_at,
      site: job.uisp_site || device?.siteName || null,
      proposedSite: site ? { id: site.id, name: site.name } : null,
    };
  });

  /** Signal history of the CPE of a job (fault diagnosis: sudden failure vs slow degradation). */
  app.get('/api/provisioning/jobs/:id/uisp/statistics', mod('signal_history'), async (req) => {
    const job = loadJob(req);
    const range = z.enum(['day', 'week', 'month']).default('week').parse((req.query as { range?: string }).range);
    const device = await deviceOf(job);
    if (!device) throw new HttpError(409, 'uisp_device_not_found');
    const [stats, outages] = await Promise.all([uisp().statistics(device.id, range), uisp().outages(device.id, range).catch(() => null)]);
    return { device: { id: device.id, name: device.name }, ...stats, outages };
  });

  // ---- Salute CPE (module cpe_health) -------------------------------------------------------
  /** CPEs installed with the app (latest successful job per MAC, not replaced). Installers: their own. */
  const installedJobs = (viewer: { id: number; role: string }, installer?: string): InstalledJob[] =>
    (
      db
        .prepare(
          `SELECT j.id jobId, j.created_at createdAt, j.device_name deviceName, j.model, j.mac, j.ssid, u.username installer,
                  a.verdict acceptanceVerdict,
                  json_extract(a.data, '$.radio.signal') acceptanceSignal,
                  json_extract(a.data, '$.internet.downloadMbps') acceptanceDownload
           FROM provisioning_jobs j
           JOIN users u ON u.id = j.user_id
           LEFT JOIN job_acceptance a ON a.job_id = j.id
           WHERE j.status = 'success'
             AND NOT EXISTS (SELECT 1 FROM provisioning_jobs r WHERE r.replaces_job_id = j.id AND r.status = 'success')
             AND NOT EXISTS (SELECT 1 FROM provisioning_jobs n WHERE n.mac = j.mac AND n.status = 'success' AND n.created_at > j.created_at)
             ${viewer.role !== 'admin' ? 'AND j.user_id = ?' : installer ? 'AND u.username = ?' : ''}
           ORDER BY j.created_at DESC LIMIT 5000`,
        )
        .all(...(viewer.role !== 'admin' ? [viewer.id] : installer ? [installer] : [])) as unknown as InstalledJob[]
    );

  /** CPEs assigned to installers (MAC → user): customers installed before the app or by someone else. */
  const assignmentsByMac = (userId?: number) =>
    new Map(
      (
        db
          .prepare(`SELECT a.mac, a.name, a.user_id userId, u.username FROM cpe_assignments a JOIN users u ON u.id = a.user_id ${userId ? 'WHERE a.user_id = ?' : ''}`)
          .all(...(userId ? [userId] : [])) as Array<{ mac: string; name: string; userId: number; username: string }>
      ).map((r) => [r.mac, r]),
    );

  /** A customer CPE seen only in UISP, as a health row (no acceptance test to compare with). */
  const uispRow = (d: UispDevice, installer: string | null): InstalledJob => ({
    jobId: null,
    createdAt: null,
    deviceName: d.name,
    model: d.model,
    mac: d.mac!,
    ssid: d.ssid ?? '',
    installer: installer ?? '',
    acceptanceVerdict: null,
    acceptanceSignal: null,
    acceptanceDownload: null,
  });

  /** Customer CPEs in UISP: stations (not APs, not PtP backhaul ends) with a MAC. */
  const isCustomerCpe = (d: UispDevice) => !!d.mac && !isAp(d) && !isPtp(d) && (d.role === 'station' || d.wirelessMode.startsWith('sta') || !!d.apId);

  const cpeHealth = async (req: FastifyRequest) => {
    const q = z
      .object({ installer: z.string().trim().max(80).optional(), scope: z.enum(['all', 'app']).default('all') })
      .parse(req.query);
    const viewer = req.user!;
    const admin = viewer.role === 'admin';
    const jobs = installedJobs(viewer, q.installer);
    const assigned = assignmentsByMac(admin ? undefined : viewer.id);
    const byMac = new Map<string, UispDevice>();
    let uispOk = true;
    if (ctx.uisp) {
      try {
        for (const d of await ctx.uisp.allDevices()) if (d.mac) byMac.set(d.mac, d);
      } catch {
        uispOk = false;
      }
    }
    const tag = (j: InstalledJob, source: 'app' | 'uisp') => {
      const a = assigned.get(j.mac);
      return { ...j, source, assignedTo: a ? { id: a.userId, username: a.username } : null };
    };
    const rows = jobs.map((j) => tag(j, 'app'));
    const seen = new Set(jobs.map((j) => j.mac));
    if (admin) {
      const filterUser = q.installer ? (db.prepare('SELECT id FROM users WHERE username = ?').get(q.installer) as { id: number } | undefined)?.id : undefined;
      if (q.scope === 'all') {
        for (const d of byMac.values()) {
          if (!isCustomerCpe(d) || seen.has(d.mac!)) continue;
          const a = assigned.get(d.mac!);
          if (q.installer && a?.userId !== filterUser) continue; // installer filter: only theirs
          seen.add(d.mac!);
          rows.push(tag(uispRow(d, a?.username ?? null), 'uisp'));
        }
      }
    } else {
      // installers: also the CPEs the admin assigned to them
      for (const [mac, a] of assigned) {
        if (seen.has(mac)) continue;
        const d = byMac.get(mac);
        seen.add(mac);
        rows.push(tag(d ? uispRow(d, a.username) : { ...uispRow({ name: a.name, model: '', mac, ssid: null } as UispDevice, a.username) }, 'uisp'));
      }
    }
    const t = { ...FIELD_THRESHOLDS, targetFirmware: TARGET_FIRMWARE, signalDropDb: 6 };
    // admins with the CRM connected: the RADIUS account of each CPE, by session MAC or by the PPPoE user of the installation
    let radiusOf: ((j: InstalledJob) => RadiusInfo | null) | undefined;
    if (admin && ctx.crmSync.available()) {
      const idx = ctx.crmSync.index();
      const pppoe = new Map(
        (db.prepare("SELECT id, lower(pppoe_user) u FROM provisioning_jobs WHERE status = 'success' AND pppoe_user <> ''").all() as Array<{ id: string; u: string }>).map((r) => [r.id, r.u]),
      );
      radiusOf = (j) => idx.byMac.get(j.mac) ?? (j.jobId && pppoe.has(j.jobId) ? (idx.byUser.get(pppoe.get(j.jobId)!) ?? null) : null);
    }
    const h = installedHealth(rows, byMac, t, radiusOf);
    return {
      generatedAt: nowIso(),
      uisp: !!ctx.uisp && uispOk,
      thresholds: t,
      ...h,
      totals: {
        ...h.totals,
        fromApp: h.cpes.filter((c) => c.source === 'app').length,
        fromUisp: h.cpes.filter((c) => c.source === 'uisp').length,
        assigned: h.cpes.filter((c) => c.assignedTo).length,
      },
      ...(admin ? { installers: db.prepare("SELECT id, username FROM users WHERE role = 'installer' AND active = 1 ORDER BY username").all() } : {}),
    };
  };
  const healthUser = { preHandler: [ctx.auth.requireUser, ctx.modules.require('cpe_health')] };

  app.get('/api/cpe-health', healthUser, async (req) => {
    if (!ctx.uisp) throw new HttpError(503, 'uisp_not_configured');
    return cpeHealth(req);
  });

  /** Admin: assign customer CPEs (by MAC) to an installer, or remove the assignment (userId null). */
  app.put('/api/admin/cpe-assignments', { preHandler: [ctx.auth.requireAdmin, ctx.modules.require('cpe_health')] }, async (req) => {
    const b = z
      .object({ macs: z.array(z.string().trim().min(12).max(17)).min(1).max(5000), userId: z.number().int().positive().nullable() })
      .strict()
      .parse(req.body);
    const macs = [...new Set(b.macs.map((m) => parseMac(m)).filter((m): m is string => !!m))];
    if (!macs.length) throw new HttpError(400, 'invalid_mac');
    let username = '';
    if (b.userId !== null) {
      const u = db.prepare('SELECT username, role FROM users WHERE id = ?').get(b.userId) as { username: string; role: string } | undefined;
      if (!u) throw new HttpError(404, 'user_not_found');
      if (u.role === 'admin') throw new HttpError(400, 'admin_sees_all');
      username = u.username;
    }
    const names = new Map<string, string>();
    if (ctx.uisp) {
      try {
        for (const d of await ctx.uisp.allDevices()) if (d.mac) names.set(d.mac, d.name);
      } catch {
        // names are only a snapshot for CPEs that later disappear from UISP
      }
    }
    db.exec('BEGIN');
    try {
      if (b.userId === null) {
        const del = db.prepare('DELETE FROM cpe_assignments WHERE mac = ?');
        for (const m of macs) del.run(m);
      } else {
        const up = db.prepare(
          `INSERT INTO cpe_assignments(mac, user_id, name, assigned_at, assigned_by) VALUES(?,?,?,?,?)
           ON CONFLICT(mac) DO UPDATE SET user_id = excluded.user_id, name = excluded.name, assigned_at = excluded.assigned_at, assigned_by = excluded.assigned_by`,
        );
        for (const m of macs) up.run(m, b.userId, names.get(m) ?? '', nowIso(), req.user!.id);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    recordEvent(db, req.user!.id, 'cpe_health.assign', b.userId === null ? 'assegnazione rimossa' : username, `${macs.length} CPE`);
    return { ok: true, count: macs.length };
  });

  app.get('/api/cpe-health.csv', { preHandler: [ctx.auth.requireUser, ctx.modules.require('cpe_health'), ctx.modules.require('csv_export')] }, async (req, reply) => {
    if (!ctx.uisp) throw new HttpError(503, 'uisp_not_configured');
    const h = await cpeHealth(req);
    const label: Record<string, string> = { offline: 'offline', not_in_uisp: 'non trovata in UISP', pending: 'da accettare', weak_signal: 'segnale debole', signal_drop: 'segnale calato', ethernet: 'porta LAN', low_capacity: 'capacità bassa', firmware: 'firmware', pppoe_offline: 'PPPoE offline', account_suspended: 'account sospeso' };
    const withRadius = h.cpes.some((c) => 'radius' in c);
    const rows = h.cpes.map((c) => [
      (c.createdAt ?? '').slice(0, 10), c.source === 'app' ? 'app' : 'UISP', c.deviceName, c.model, c.mac, c.ssid, c.installer, c.assignedTo?.username ?? '', c.now?.status ?? '', c.acceptanceSignal ?? '', c.now?.signal ?? '', c.signalDelta ?? '',
      c.now?.ethMbps ? `${c.now.ethMbps}${c.now.ethHalfDuplex ? ' half' : ''}` : '', c.now?.firmware ?? '', c.now?.apName ?? '', c.issues.map((i) => label[i] ?? i).join(', '),
      // admins with the CRM: the RADIUS account of the CPE
      ...(withRadius
        ? (() => {
            const r = 'radius' in c ? c.radius : null;
            return [r?.username ?? '', r?.profile ?? '', r ? (r.suspended ? 'sospeso' : r.accountStatus) : '', r?.online == null ? '' : r.online ? 'online' : 'offline'];
          })()
        : []),
    ]);
    recordEvent(db, req.user!.id, 'cpe_health.export', `${rows.length} CPE`, '');
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="salute-cpe-${h.generatedAt.slice(0, 10)}.csv"`);
    return '﻿' + toCsv([['Installata il', 'Origine', 'Cliente', 'Modello', 'MAC', 'SSID', 'Installatore', 'Assegnata a', 'Stato', 'Segnale al collaudo', 'Segnale ora', 'Differenza dB', 'Porta LAN', 'Firmware', 'AP', 'Problemi', ...(withRadius ? ['Utente PPPoE', 'Profilo', 'Account', 'Sessione PPPoE'] : [])], ...rows]);
  });

  // ---- Admin actions ------------------------------------------------------------------------
  app.get('/api/admin/uisp/status', admin, async () => {
    if (!ctx.uisp) return { configured: false };
    try {
      return { configured: true, ...(await ctx.uisp.test()) };
    } catch (e) {
      const err = e as HttpError;
      return { configured: true, ok: false, error: err.code ?? 'uisp_error', ...(err.extra ?? {}) };
    }
  });

  app.get('/api/admin/uisp/sites', admin, async () => (await uisp().sites()).filter((s) => s.type !== 'endpoint').map((s) => ({ id: s.id, name: s.name })));

  app.post('/api/admin/provisioning/jobs/:id/uisp/authorize', admin, async (req) => {
    const job = loadJob(req);
    const b = z.object({ siteId: z.string().min(1).max(100).optional() }).strict().parse(req.body ?? {});
    const u = uisp();
    const device = await deviceOf(job);
    if (!device) throw new HttpError(409, 'uisp_device_not_found');
    if (device.authorized) throw new HttpError(409, 'uisp_already_authorized', { site: device.siteName });
    const proposed = await u.siteForStation(device, job.ssid, near(job));
    const siteId = b.siteId ?? proposed?.id;
    if (!siteId) throw new HttpError(409, 'uisp_site_unknown');
    const siteName = b.siteId ? ((await u.sites()).find((s) => s.id === b.siteId)?.name ?? b.siteId) : (proposed?.name ?? siteId);
    await u.authorize(device.id, siteId);
    db.prepare('UPDATE provisioning_jobs SET uisp_device_id = ?, uisp_site = ?, uisp_authorized_at = ?, uisp_authorized_by = ? WHERE id = ?').run(
      device.id,
      siteName,
      nowIso(),
      req.user!.id,
      job.id,
    );
    recordEvent(db, req.user!.id, 'uisp.authorize', `${device.name || device.mac} → ${siteName}`, job.id);
    ctx.notify.installActivated(job.id, req.user!.username);
    let backup: 'created' | 'failed' | 'disabled' = 'disabled';
    if (ctx.uispSettings.autoBackup) {
      backup = await u
        .createBackup(device.id)
        .then(() => 'created' as const)
        .catch(() => 'failed' as const);
    }
    return { ok: true, deviceId: device.id, site: siteName, backup };
  });

  /** What changed on the CPE compared with the CDA Net configuration (latest UISP backup). */
  app.get('/api/admin/provisioning/jobs/:id/uisp/drift', mod('config_drift', admin), async (req) => {
    const job = loadJob(req);
    if (job.status !== 'success') throw new HttpError(409, 'job_not_completed');
    const full = db.prepare('SELECT model, mac, serial, ssid, pppoe_user, template_name, latitude, longitude FROM provisioning_jobs WHERE id = ?').get(job.id) as {
      model: string; mac: string; serial: string; ssid: string; pppoe_user: string; template_name: string; latitude: number | null; longitude: number | null;
    };
    const tpl = db
      .prepare('SELECT template_ciphertext FROM profile_templates WHERE model = ? AND name = ? AND firmware = ?')
      .get(full.model, full.template_name, TARGET_FIRMWARE) as { template_ciphertext: string } | undefined;
    if (!tpl) throw new HttpError(409, 'drift_template_missing', { template: full.template_name });
    const wpa = db.prepare('SELECT wpa2_ciphertext FROM wireless_secrets WHERE ssid = ?').get(full.ssid) as { wpa2_ciphertext: string } | undefined;
    const device = await deviceOf(job);
    if (!device) throw new HttpError(409, 'uisp_device_not_found');
    const u = uisp();
    const latest = (await u.backups(device.id)).filter((b) => b.id).sort((a, b) => String(b.timestamp ?? '').localeCompare(String(a.timestamp ?? '')))[0];
    if (!latest) throw new HttpError(409, 'drift_no_backup');
    const r = await u.downloadBackup(device.id, latest.id);
    const cfgText = await r.text();
    if (!/^(radio|wireless|netconf|users)\./m.test(cfgText)) throw new HttpError(409, 'drift_backup_unreadable');
    const { values, name } = ctx.provisioning.jobValues(
      { ssid: full.ssid, pppoeUser: full.pppoe_user, mac: full.mac, serial: full.serial },
      wpa ? ctx.sealer.open(wpa.wpa2_ciphertext) : '',
    );
    if (!wpa) delete values.WPA2_PSK;
    const report = configDrift(
      ctx.sealer.open(tpl.template_ciphertext),
      values,
      ctx.provisioning.enforcedKeys(name, full.latitude != null && full.longitude != null ? { latitude: full.latitude, longitude: full.longitude } : null),
      cfgText,
    );
    recordEvent(db, req.user!.id, 'uisp.drift', device.name || device.mac || device.id, `${report.items.length} differenze`);
    return { backup: { id: latest.id, timestamp: latest.timestamp }, template: full.template_name, ...report };
  });

  app.get('/api/admin/provisioning/jobs/:id/uisp/backups', admin, async (req) => {
    const device = await deviceOf(loadJob(req));
    if (!device) throw new HttpError(409, 'uisp_device_not_found');
    return uisp().backups(device.id);
  });

  app.post('/api/admin/provisioning/jobs/:id/uisp/backups', admin, async (req) => {
    const job = loadJob(req);
    const device = await deviceOf(job);
    if (!device) throw new HttpError(409, 'uisp_device_not_found');
    await uisp().createBackup(device.id);
    recordEvent(db, req.user!.id, 'uisp.backup', device.name || device.mac || device.id, job.id);
    return { ok: true };
  });

  app.get('/api/admin/provisioning/jobs/:id/uisp/backups/:backupId', admin, async (req, reply) => {
    const job = loadJob(req);
    const backupId = z.string().min(1).max(100).parse((req.params as { backupId: string }).backupId);
    const device = await deviceOf(job);
    if (!device) throw new HttpError(409, 'uisp_device_not_found');
    const u = uisp();
    const meta = (await u.backups(device.id).catch(() => [])).find((b) => b.id === backupId);
    const r = await u.downloadBackup(device.id, backupId);
    const safe = (device.name || device.mac || device.id).replace(/[^\w.-]+/g, '_');
    // airMAX backups are served as the plain system.cfg (UISP unzips them).
    const ext = (meta?.extension ?? 'bin').replace(/[^\w]+/g, '');
    reply
      .header('Content-Type', r.headers.get('content-type') ?? 'application/octet-stream')
      .header('Content-Disposition', `attachment; filename="backup-${safe}-${backupId.replace(/[^\w.-]+/g, '_')}.${ext || 'bin'}"`);
    return reply.send(Readable.fromWeb(r.body as import('node:stream/web').ReadableStream));
  });
}
