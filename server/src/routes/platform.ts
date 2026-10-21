import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { recordEvent } from '../db.ts';

/** Content type of an uploaded backup file (checked, never restored here). */
export const BACKUP_CONTENT_TYPE = 'application/x-cdanet-backup';
const MAX_BACKUP_BYTES = 512 * 1024 * 1024;

/**
 * «Salute piattaforma» (admins): every source and the server at a glance; the encrypted backup of
 * the database to download (with a password chosen now, optionally with the master key so that it
 * can be restored on a new server) and the check of a backup file, which replaces nothing.
 */
export function platformRoutes(app: FastifyInstance, ctx: AppContext) {
  const admin = { preHandler: ctx.auth.requireAdmin };
  // the specialist sees how the platform is doing; the backups stay with the admins
  const staff = { preHandler: ctx.auth.requireSeesAll };

  app.get('/api/admin/platform/health', staff, async () => ctx.platformHealth.view());

  app.post('/api/admin/platform/backup', admin, async (req, reply) => {
    const b = z
      .object({ password: z.string().min(12, 'Almeno 12 caratteri').max(200), includeKey: z.boolean().default(false) })
      .strict()
      .parse(req.body);
    const file = ctx.platformHealth.backup(b.password, req.user!.username, b.includeKey ? ctx.cfg.masterKey : null);
    recordEvent(ctx.db, req.user!.id, 'platform.backup', `${Math.round(file.length / 1024)} KB`, b.includeKey ? 'con la chiave principale' : 'senza la chiave principale');
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    reply.header('Content-Type', 'application/octet-stream').header('Content-Disposition', `attachment; filename="cdanet-backup-${stamp}.cdanet"`).header('Cache-Control', 'no-store');
    return reply.send(file);
  });

  app.addContentTypeParser(BACKUP_CONTENT_TYPE, { parseAs: 'buffer', bodyLimit: MAX_BACKUP_BYTES }, (_req, body, done) => done(null, body));
  app.post('/api/admin/platform/backup/verify', { ...admin, bodyLimit: MAX_BACKUP_BYTES }, async (req) => {
    const password = String(req.headers['x-backup-password'] ?? '');
    if (!password) throw new HttpError(400, 'backup_password_required');
    if (!Buffer.isBuffer(req.body)) throw new HttpError(400, 'backup_invalid');
    const r = ctx.platformHealth.verify(req.body, password);
    recordEvent(ctx.db, req.user!.id, 'platform.backup_verify', String(r.meta.createdAt ?? ''), r.ok ? 'backup integro' : `backup danneggiato: ${r.integrity}`);
    return r;
  });
}
