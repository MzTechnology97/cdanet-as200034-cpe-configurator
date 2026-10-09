import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { recordEvent } from '../db.ts';
import { TARGET_FIRMWARE, parseClientHeader, parseMac, versionAtLeast, type CpeModel } from '../domain/policy.ts';
import { provisionRequestSchema } from '../services/provisioning.ts';

interface OldJob {
  id: string;
  user_id: number;
  status: string;
  model: CpeModel;
  mac: string;
  ssid: string;
  pppoe_user: string;
  template_name: string;
  latitude: number | null;
  longitude: number | null;
  location_accuracy: number | null;
  location_source: string;
  uisp_device_id: string;
}

/** Key of the template line carrying ${PPPOE_PASSWORD} (ppp.1.password in the standard airOS profile). */
export function pppoePasswordKey(template: string): string {
  const line = template.split(/\r?\n/).find((l) => l.includes('${PPPOE_PASSWORD}'));
  return line?.slice(0, line.indexOf('=')).trim() || 'ppp.1.password';
}

/** Value of a key in an airOS system.cfg (e.g. a UISP backup). */
export function cfgValue(cfg: string, key: string): string | null {
  for (const l of cfg.split(/\r?\n/)) {
    const i = l.indexOf('=');
    if (i > 0 && l.slice(0, i).trim() === key) return l.slice(i + 1);
  }
  return null;
}

/**
 * Replacement of a broken CPE: a new provisioning job with the data of the old one
 * (customer, SSID, position, template). The PPPoE password is typed by the installer or,
 * when omitted, read server-side from the latest UISP backup of the old CPE: it never
 * reaches the app except inside the rendered system.cfg, exactly as in a normal job.
 */
export function replaceRoutes(app: FastifyInstance, ctx: AppContext) {
  const user = { preHandler: [ctx.auth.requireUser, ctx.modules.require('replacement')] };
  const { db } = ctx;

  async function passwordFromUisp(old: OldJob, key: string): Promise<string> {
    const u = ctx.uisp;
    if (!u) throw new HttpError(409, 'pppoe_password_required', { reason: 'uisp_not_configured' });
    const device = (old.uisp_device_id ? await u.device(old.uisp_device_id) : null) ?? (await u.findByMac(old.mac));
    if (!device) throw new HttpError(409, 'pppoe_password_required', { reason: 'uisp_device_not_found' });
    const backups = (await u.backups(device.id)).filter((b) => b.id).sort((a, b) => String(b.timestamp ?? '').localeCompare(String(a.timestamp ?? '')));
    for (const b of backups.slice(0, 3)) {
      const r = await u.downloadBackup(device.id, b.id).catch(() => null);
      if (!r?.ok) continue;
      const value = cfgValue(await r.text(), key);
      if (value) return value;
    }
    throw new HttpError(409, 'pppoe_password_required', { reason: 'uisp_backup_without_password' });
  }

  app.post('/api/provisioning/jobs/:id/replace', user, async (req, reply) => {
    const client = parseClientHeader(req.headers['x-cda-client'] as string | undefined);
    if (!client) throw new HttpError(403, 'trusted_client_required');
    if (!versionAtLeast(client.version, ctx.cfg.minAndroidVersion)) {
      throw new HttpError(426, 'client_update_required', { minVersion: ctx.cfg.minAndroidVersion });
    }
    const id = z.string().min(1).max(80).parse((req.params as { id: string }).id);
    const old = db.prepare('SELECT * FROM provisioning_jobs WHERE id = ?').get(id) as OldJob | undefined;
    if (!old) throw new HttpError(404, 'job_not_found');
    if (old.user_id !== req.user!.id && req.user!.role !== 'admin') throw new HttpError(403, 'forbidden');
    if (old.status !== 'success') throw new HttpError(409, 'job_not_completed');

    const b = z
      .object({
        model: provisionRequestSchema.shape.model.optional(),
        mac: provisionRequestSchema.shape.mac,
        serial: provisionRequestSchema.shape.serial,
        pppoePassword: z.string().min(1).max(200).optional(),
        templateId: z.number().int().positive().optional(),
        location: provisionRequestSchema.shape.location,
      })
      .strict()
      .parse(req.body);
    if (parseMac(old.mac) === b.mac) throw new HttpError(409, 'replace_same_mac');

    const model = b.model ?? old.model;
    // Same named template as the old job when still available to this user (else the default).
    const sameTemplate =
      b.templateId ??
      (model === old.model && old.template_name
        ? (db.prepare('SELECT id FROM profile_templates WHERE model = ? AND name = ? AND firmware = ?').get(model, old.template_name, TARGET_FIRMWARE) as { id: number } | undefined)?.id
        : undefined);
    const templateId = sameTemplate && ctx.templates.resolve(model, sameTemplate, req.user!) ? sameTemplate : b.templateId;

    let password = b.pppoePassword;
    let passwordSource = 'installatore';
    if (!password) {
      const profile = ctx.templates.resolve(model, templateId, req.user!);
      if (!profile) throw new HttpError(409, 'provision_profile_missing');
      password = await passwordFromUisp(old, pppoePasswordKey(ctx.sealer.open(profile.ciphertext)));
      passwordSource = 'backup UISP';
    }

    const location =
      b.location ??
      (old.latitude != null && old.longitude != null
        ? { latitude: old.latitude, longitude: old.longitude, ...(old.location_accuracy != null ? { accuracy: old.location_accuracy } : {}), source: (['gps', 'address', 'manual'].includes(old.location_source) ? old.location_source : 'manual') as 'gps' | 'address' | 'manual' }
        : undefined);

    const x = provisionRequestSchema.parse({
      model,
      mac: b.mac,
      serial: b.serial,
      ssid: old.ssid,
      pppoeUser: old.pppoe_user,
      pppoePassword: password,
      ...(templateId ? { templateId } : {}),
      ...(location ? { location } : {}),
    });
    const pkg = ctx.provisioning.createJob(x, req.user!, `${client.platform}/${client.version}`);
    db.prepare('UPDATE provisioning_jobs SET replaces_job_id = ? WHERE id = ?').run(old.id, pkg.jobId);
    recordEvent(db, req.user!.id, 'job.replace', pkg.jobId, `sostituisce ${old.mac} → ${x.mac} · password PPPoE da ${passwordSource}`);
    reply.header('Cache-Control', 'no-store');
    return reply.code(201).send({ ...pkg, replacesJobId: old.id });
  });
}
