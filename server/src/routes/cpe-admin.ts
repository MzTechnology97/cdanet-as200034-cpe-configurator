import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { recordEvent } from '../db.ts';
import { cpeView, unmsWithMeta } from '../domain/cpe-view.ts';
import { isAp, isPtp } from '../services/uisp.ts';

const RANGES = ['day', 'week', 'month'] as const;

/**
 * Admin "Stato CPE" (console and app): one customer CPE as in the UISP app — detail, interfaces,
 * radio, firmware, backups — and the actions UISP allows through its API: refresh, restart,
 * firmware upgrade to the latest version, backup and restore, alias/note/maintenance. Every action
 * is in the activity log. Customer CPEs only: APs and PtP links are not managed from here.
 */
export function cpeAdminRoutes(app: FastifyInstance, ctx: AppContext) {
  const admin = { preHandler: [ctx.auth.requireAdmin, ctx.modules.require('cpe_health')] };
  const { db } = ctx;

  const uisp = () => {
    if (!ctx.uisp) throw new HttpError(503, 'uisp_not_configured');
    return ctx.uisp;
  };

  /** The device of the request: must exist in UISP and be a customer CPE. */
  async function cpeOf(req: FastifyRequest) {
    const id = z
      .string()
      .regex(/^[A-Za-z0-9-]{1,80}$/)
      .parse((req.params as { deviceId: string }).deviceId);
    const d = (await uisp().allDevices()).find((x) => x.id === id);
    if (!d) throw new HttpError(404, 'uisp_device_not_found');
    if (isAp(d) || isPtp(d)) throw new HttpError(409, 'not_a_customer_cpe');
    return d;
  }

  const log = (req: FastifyRequest, action: string, d: { id: string; name: string }, detail = '') => recordEvent(db, req.user!.id, `cpe.${action}`, d.id, [d.name, detail].filter(Boolean).join(' · '));

  app.get('/api/admin/cpe/:deviceId', admin, async (req) => {
    const d = await cpeOf(req);
    const u = uisp();
    const [detail, interfaces, wireless, unms, backups] = await Promise.all([
      u.deviceDetail(d.id),
      u.deviceInterfaces(d.id).catch(() => []),
      u.airmaxWireless(d.id),
      u.deviceUnms(d.id).catch(() => null),
      u.backups(d.id).catch(() => []),
    ]);
    // the installation in CDA Net, if any (link to the history)
    const job = d.mac
      ? (db.prepare("SELECT id, created_at createdAt FROM provisioning_jobs WHERE replace(upper(mac), ':', '') = ? AND status = 'success' ORDER BY created_at DESC LIMIT 1").get(d.mac.replace(/[^0-9A-Fa-f]/g, '').toUpperCase()) as
          | { id: string; createdAt: string }
          | undefined)
      : undefined;
    return { cpe: cpeView(detail, interfaces, wireless, unms), backups, job: job ?? null };
  });

  app.get('/api/admin/cpe/:deviceId/statistics', admin, async (req) => {
    const d = await cpeOf(req);
    const range = z.enum(RANGES).default('day').parse((req.query as { range?: string }).range);
    // guide lines of the chart: the thresholds of Impostazioni server
    return { ...(await uisp().statistics(d.id, range)), thresholds: { good: ctx.cfg.thresholds.signalGood, min: ctx.cfg.thresholds.signalMin } };
  });

  app.post('/api/admin/cpe/:deviceId/refresh', admin, async (req) => {
    const d = await cpeOf(req);
    await uisp().refreshDevice(d.id);
    log(req, 'refresh', d);
    return { ok: true };
  });

  app.post('/api/admin/cpe/:deviceId/restart', admin, async (req) => {
    const d = await cpeOf(req);
    await uisp().restartDevice(d.id);
    log(req, 'restart', d, d.status === 'active' ? '' : 'CPE offline: il comando arriverà solo se torna raggiungibile');
    return { ok: true, online: d.status === 'active' };
  });

  app.post('/api/admin/cpe/:deviceId/upgrade', admin, async (req) => {
    const d = await cpeOf(req);
    const detail = cpeView(await uisp().deviceDetail(d.id), [], null, null);
    if (!detail.online) throw new HttpError(409, 'cpe_offline');
    await uisp().upgradeDeviceToLatest(d.id);
    log(req, 'upgrade', d, `${detail.firmware.current ?? '?'} → ${detail.firmware.upgradeTo ?? 'ultima versione'}`);
    return { ok: true, from: detail.firmware.current, to: detail.firmware.upgradeTo };
  });

  app.post('/api/admin/cpe/:deviceId/backups', admin, async (req) => {
    const d = await cpeOf(req);
    await uisp().createBackup(d.id);
    log(req, 'backup', d);
    return { ok: true };
  });

  app.get('/api/admin/cpe/:deviceId/backups/:backupId', admin, async (req, reply) => {
    const d = await cpeOf(req);
    const backupId = z.string().min(1).max(100).parse((req.params as { backupId: string }).backupId);
    const meta = (await uisp().backups(d.id).catch(() => [])).find((b) => b.id === backupId);
    const r = await uisp().downloadBackup(d.id, backupId);
    const safe = (d.name || d.mac || d.id).replace(/[^\w.-]+/g, '_');
    const ext = (meta?.extension ?? 'bin').replace(/[^\w]+/g, '');
    reply
      .header('Content-Type', r.headers.get('content-type') ?? 'application/octet-stream')
      .header('Content-Disposition', `attachment; filename="backup-${safe}-${backupId.replace(/[^\w.-]+/g, '_')}.${ext || 'bin'}"`);
    return reply.send(Readable.fromWeb(r.body as import('node:stream/web').ReadableStream));
  });

  app.post('/api/admin/cpe/:deviceId/backups/:backupId/apply', admin, async (req) => {
    const d = await cpeOf(req);
    const backupId = z.string().min(1).max(100).parse((req.params as { backupId: string }).backupId);
    if (d.status !== 'active') throw new HttpError(409, 'cpe_offline');
    const known = (await uisp().backups(d.id)).find((b) => b.id === backupId);
    if (!known) throw new HttpError(404, 'backup_not_found');
    await uisp().applyBackup(d.id, backupId);
    log(req, 'backup_apply', d, known.timestamp ? `backup del ${known.timestamp}` : backupId);
    return { ok: true };
  });

  app.put('/api/admin/cpe/:deviceId/meta', admin, async (req) => {
    const d = await cpeOf(req);
    const b = z
      .object({ alias: z.string().trim().max(100).nullable().optional(), note: z.string().trim().max(1000).nullable().optional(), maintenance: z.boolean().optional() })
      .strict()
      .parse(req.body);
    const current = await uisp().deviceUnms(d.id);
    await uisp().setDeviceUnms(d.id, unmsWithMeta(current, b));
    log(req, 'meta', d, [b.alias !== undefined ? 'alias' : null, b.note !== undefined ? 'note' : null, b.maintenance !== undefined ? `manutenzione ${b.maintenance ? 'attiva' : 'disattiva'}` : null].filter(Boolean).join(', '));
    return { ok: true };
  });
}
