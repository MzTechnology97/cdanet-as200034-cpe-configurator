import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { nowIso, recordEvent } from '../db.ts';
import { parseAirosBuild, parseAirosImage } from '../domain/firmware.ts';
import { TARGET_FIRMWARE } from '../domain/policy.ts';

export const FIRMWARE_CONTENT_TYPE = 'application/x-airos-firmware';
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

interface Row {
  id: number;
  createdAt: string;
  filename: string;
  platform: string;
  version: string;
  build: string;
  size: number;
  sha256: string;
  md5: string;
}

const SELECT = 'SELECT id, created_at createdAt, filename, platform, version, build, size, sha256, md5 FROM firmware_images';

/**
 * Field firmware upgrade: the admin uploads the reference airOS images, the app downloads the
 * ones of the target version (with Internet), then flashes the CPE over its Wi-Fi.
 */
export function firmwareRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const dir = ctx.cfg.firmwareDir;
  const admin = { preHandler: [ctx.auth.requireAdmin, ctx.modules.require('firmware_upgrade')] };
  const user = { preHandler: [ctx.auth.requireUser, ctx.modules.require('firmware_upgrade')] };
  const fileOf = (r: Pick<Row, 'sha256'>) => join(dir, `${r.sha256}.bin`);
  const view = (r: Row) => ({ ...r, target: r.version === TARGET_FIRMWARE, present: existsSync(fileOf(r)) });

  app.addContentTypeParser(FIRMWARE_CONTENT_TYPE, { parseAs: 'buffer', bodyLimit: MAX_IMAGE_BYTES }, (_req, body, done) => done(null, body));

  app.get('/api/admin/firmware', admin, async () => ({
    target: TARGET_FIRMWARE,
    items: (db.prepare(`${SELECT} ORDER BY version DESC, platform`).all() as unknown as Row[]).map(view),
  }));

  app.post('/api/admin/firmware', { ...admin, bodyLimit: MAX_IMAGE_BYTES }, async (req, reply) => {
    const body = req.body;
    if (!Buffer.isBuffer(body)) throw new HttpError(415, 'firmware_content_type');
    const info = parseAirosImage(body);
    if (!info) throw new HttpError(400, 'firmware_invalid');
    const filename = z.string().trim().min(1).max(120).catch('firmware.bin').parse((req.query as { name?: string }).name)
      .replace(/[^\w.+-]/g, '_');
    const sha256 = createHash('sha256').update(body).digest('hex');
    if (db.prepare('SELECT 1 FROM firmware_images WHERE sha256 = ?').get(sha256)) throw new HttpError(409, 'firmware_exists');
    mkdirSync(dir, { recursive: true });
    writeFileSync(fileOf({ sha256 }), body);
    const md5 = createHash('md5').update(body).digest('hex');
    const id = Number(
      db.prepare('INSERT INTO firmware_images(created_at, created_by, filename, platform, version, build, size, sha256, md5) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(nowIso(), req.user!.id, filename, info.platform, info.version, info.build, body.length, sha256, md5).lastInsertRowid,
    );
    recordEvent(db, req.user!.id, 'firmware.upload', info.build, `${filename} · ${body.length} byte`);
    reply.code(201);
    return { item: view(db.prepare(`${SELECT} WHERE id = ?`).get(id) as unknown as Row) };
  });

  app.delete('/api/admin/firmware/:id', admin, async (req) => {
    const id = z.coerce.number().int().positive().parse((req.params as { id: string }).id);
    const r = db.prepare(`${SELECT} WHERE id = ?`).get(id) as unknown as Row | undefined;
    if (!r) throw new HttpError(404, 'firmware_not_found');
    db.prepare('DELETE FROM firmware_images WHERE id = ?').run(id);
    rmSync(fileOf(r), { force: true });
    recordEvent(db, req.user!.id, 'firmware.delete', r.build, r.filename);
    return { ok: true };
  });

  /** Images of the target version (one per platform), for the app to keep on the phone. */
  app.get('/api/firmware', user, async () => ({
    target: TARGET_FIRMWARE,
    items: (db.prepare(`${SELECT} WHERE version = ? ORDER BY platform, id DESC`).all(TARGET_FIRMWARE) as unknown as Row[])
      .filter((r, i, all) => all.findIndex((x) => x.platform === r.platform) === i)
      .map(({ filename: _f, ...r }) => r)
      .filter((r) => existsSync(fileOf(r))),
  }));

  app.get('/api/firmware/:id/file', user, async (req, reply) => {
    const id = z.coerce.number().int().positive().parse((req.params as { id: string }).id);
    const r = db.prepare(`${SELECT} WHERE id = ? AND version = ?`).get(id, TARGET_FIRMWARE) as unknown as Row | undefined;
    if (!r || !existsSync(fileOf(r))) throw new HttpError(404, 'firmware_not_found');
    recordEvent(db, req.user!.id, 'firmware.download', r.build, '');
    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Length', String(r.size))
      .header('Content-Disposition', `attachment; filename="${r.platform}.v${r.version}.bin"`)
      .header('X-Firmware-Sha256', r.sha256)
      .send(createReadStream(fileOf(r)));
  });

  /** Outcome of a flash in the field (activity log; the NOC sees who upgraded what). */
  app.post('/api/firmware/report', user, async (req) => {
    const b = z
      .object({
        mac: z.string().trim().max(32).optional(),
        from: z.string().trim().max(80),
        to: z.string().trim().max(80),
        ok: z.boolean(),
        message: z.string().trim().max(300).optional(),
      })
      .parse(req.body);
    const from = parseAirosBuild(b.from)?.build ?? b.from;
    recordEvent(db, req.user!.id, b.ok ? 'firmware.upgrade' : 'firmware.upgrade_failed', b.mac ?? '', `${from} → ${b.to}${b.message ? ` · ${b.message}` : ''}`);
    return { ok: true };
  });
}
