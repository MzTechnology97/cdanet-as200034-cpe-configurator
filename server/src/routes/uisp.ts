import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { nowIso, recordEvent } from '../db.ts';
import { toCsv } from '../domain/csv.ts';
import { configDrift } from '../domain/drift.ts';
import { installedHealth, type InstalledJob } from '../domain/health.ts';
import { FIELD_THRESHOLDS } from './field.ts';
import { isValidLatLon } from '../domain/geo.ts';
import { TARGET_FIRMWARE } from '../domain/policy.ts';
import type { ModuleKey } from '../services/modules.ts';
import type { UispDevice } from '../services/uisp.ts';

const SSID_PARTS = /^CDA-NET-N(\d+)-D(\d+)$/;

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
      .object({ lat: z.coerce.number(), lon: z.coerce.number(), limit: z.coerce.number().int().min(1).max(10).default(5) })
      .parse(req.query);
    if (!isValidLatLon(q.lat, q.lon)) throw new HttpError(400, 'invalid_position');
    const aps = await uisp().nearestAps({ lat: q.lat, lon: q.lon }, q.limit, ctx.uispSettings.coverageMaxKm);
    return {
      maxKm: ctx.uispSettings.coverageMaxKm,
      aps: aps.map((a) => {
        const m = a.ssid ? SSID_PARTS.exec(a.ssid) : null;
        return { ...a, node: m ? Number(m[1]) : null, district: m ? Number(m[2]) : null };
      }),
    };
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

  // ---- Salute CPE installate (module cpe_health) --------------------------------------------
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

  const cpeHealth = async (req: FastifyRequest) => {
    const q = z.object({ installer: z.string().trim().max(80).optional() }).parse(req.query);
    const jobs = installedJobs(req.user!, q.installer);
    const byMac = new Map<string, UispDevice>();
    let uispOk = true;
    if (ctx.uisp && jobs.length) {
      try {
        for (const d of await ctx.uisp.allDevices()) if (d.mac) byMac.set(d.mac, d);
      } catch {
        uispOk = false;
      }
    }
    const t = { ...FIELD_THRESHOLDS, targetFirmware: TARGET_FIRMWARE, signalDropDb: 6 };
    return { generatedAt: nowIso(), uisp: !!ctx.uisp && uispOk, thresholds: t, ...installedHealth(jobs, byMac, t) };
  };
  const healthUser = { preHandler: [ctx.auth.requireUser, ctx.modules.require('cpe_health')] };

  app.get('/api/cpe-health', healthUser, async (req) => {
    if (!ctx.uisp) throw new HttpError(503, 'uisp_not_configured');
    return cpeHealth(req);
  });

  app.get('/api/cpe-health.csv', { preHandler: [ctx.auth.requireUser, ctx.modules.require('cpe_health'), ctx.modules.require('csv_export')] }, async (req, reply) => {
    if (!ctx.uisp) throw new HttpError(503, 'uisp_not_configured');
    const h = await cpeHealth(req);
    const label: Record<string, string> = { offline: 'offline', not_in_uisp: 'non trovata in UISP', pending: 'da accettare', weak_signal: 'segnale debole', signal_drop: 'segnale calato', ethernet: 'porta LAN', low_capacity: 'capacità bassa', firmware: 'firmware' };
    const rows = h.cpes.map((c) => [
      c.createdAt.slice(0, 10), c.deviceName, c.model, c.mac, c.ssid, c.installer, c.now?.status ?? '', c.acceptanceSignal ?? '', c.now?.signal ?? '', c.signalDelta ?? '',
      c.now?.ethMbps ? `${c.now.ethMbps}${c.now.ethHalfDuplex ? ' half' : ''}` : '', c.now?.firmware ?? '', c.now?.apName ?? '', c.issues.map((i) => label[i] ?? i).join(', '),
    ]);
    recordEvent(db, req.user!.id, 'cpe_health.export', `${rows.length} CPE`, '');
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="salute-cpe-${h.generatedAt.slice(0, 10)}.csv"`);
    return '\uFEFF' + toCsv([['Installata il', 'Cliente', 'Modello', 'MAC', 'SSID', 'Installatore', 'Stato', 'Segnale al collaudo', 'Segnale ora', 'Differenza dB', 'Porta LAN', 'Firmware', 'AP', 'Problemi'], ...rows]);
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
