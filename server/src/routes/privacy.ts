import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { nowIso, recordEvent } from '../db.ts';
import { attestationHtml, type Controller, controllerComplete, noticeSha256, PRIVACY_VERSION, privacyNotice } from '../domain/privacy.ts';

const KEY = 'privacy.controller';

/**
 * Privacy notice of the app: the admin fills in the controller's details, every user reads and
 * accepts the notice at the first login (and again when it changes). Each acceptance is kept as
 * a printable attestation (who, when, IP, device, SHA-256 of the text).
 */
export function privacyRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;
  const user = { preHandler: ctx.auth.requireUser };
  const admin = { preHandler: ctx.auth.requireAdmin };

  const controller = (): Controller | null => {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY) as { value: string } | undefined;
    if (!r) return null;
    try {
      return JSON.parse(r.value) as Controller;
    } catch {
      return null;
    }
  };
  const lastAcceptance = (userId: number, sha: string) =>
    db.prepare('SELECT id, accepted_at acceptedAt FROM privacy_acceptances WHERE user_id = ? AND text_sha256 = ? ORDER BY id DESC LIMIT 1').get(userId, sha) as
      | { id: number; acceptedAt: string }
      | undefined;

  /** The notice to show (null when the admin has not completed it yet) and whether this user accepted it. */
  app.get('/api/privacy', user, async (req) => {
    const c = controller();
    if (!controllerComplete(c)) return { required: false, notice: null };
    const sha = noticeSha256(c);
    const done = lastAcceptance(req.user!.id, sha);
    return { required: !done, version: PRIVACY_VERSION, sha256: sha, notice: privacyNotice(c), acceptedAt: done?.acceptedAt ?? null, acceptanceId: done?.id ?? null };
  });

  app.post('/api/privacy/accept', user, async (req, reply) => {
    const b = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), device: z.string().trim().max(120).default('') }).strict().parse(req.body);
    const c = controller();
    if (!controllerComplete(c)) throw new HttpError(409, 'privacy_not_configured');
    const sha = noticeSha256(c);
    // the user accepts exactly the text they were shown
    if (b.sha256 !== sha) throw new HttpError(409, 'privacy_changed');
    const acceptedAt = nowIso();
    const ua = String(req.headers['x-cda-client'] ?? req.headers['user-agent'] ?? '').slice(0, 200);
    const appVersion = /^android\/([\w.-]+)/.exec(String(req.headers['x-cda-client'] ?? ''))?.[1] ?? '';
    const id = Number(
      db
        .prepare('INSERT INTO privacy_acceptances(user_id, username, version, text_sha256, accepted_at, ip, user_agent, app_version, device, document) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(req.user!.id, req.user!.username, PRIVACY_VERSION, sha, acceptedAt, req.ip, ua, appVersion, b.device, '').lastInsertRowid,
    );
    const doc = attestationHtml({ id, username: req.user!.username, acceptedAt, ip: req.ip, device: b.device, appVersion, sha256: sha, version: PRIVACY_VERSION }, c);
    db.prepare('UPDATE privacy_acceptances SET document = ? WHERE id = ?').run(doc, id);
    recordEvent(db, req.user!.id, 'privacy.accept', req.user!.username, `informativa ${PRIVACY_VERSION} · attestazione n. ${id}`);
    return reply.code(201).send({ id, acceptedAt });
  });

  /** The printable attestation: its owner or an admin. */
  app.get('/api/privacy/acceptances/:id/document', user, async (req, reply) => {
    const id = z.coerce.number().int().positive().parse((req.params as { id: string }).id);
    const r = db.prepare('SELECT user_id userId, document FROM privacy_acceptances WHERE id = ?').get(id) as { userId: number; document: string } | undefined;
    if (!r || (r.userId !== req.user!.id && req.user!.role !== 'admin')) throw new HttpError(404, 'not_found');
    return reply.header('Content-Type', 'text/html; charset=utf-8').header('Cache-Control', 'no-store').send(r.document);
  });

  // ---- admin ------------------------------------------------------------------------------------
  app.get('/api/admin/privacy', admin, async () => {
    const c = controller();
    const sha = controllerComplete(c) ? noticeSha256(c) : null;
    const users = db.prepare('SELECT id, username, role, active FROM users ORDER BY username COLLATE NOCASE').all() as Array<{ id: number; username: string; role: string; active: number }>;
    const rows = db
      .prepare('SELECT id, user_id userId, username, version, text_sha256 sha256, accepted_at acceptedAt, ip, device, app_version appVersion FROM privacy_acceptances ORDER BY id DESC LIMIT 500')
      .all() as Array<{ id: number; userId: number; sha256: string }>;
    return {
      controller: c,
      complete: controllerComplete(c),
      version: PRIVACY_VERSION,
      sha256: sha,
      notice: controllerComplete(c) ? privacyNotice(c) : null,
      users: users.map((u) => ({ ...u, current: !!sha && rows.some((r) => r.userId === u.id && r.sha256 === sha) })),
      acceptances: rows.map((r) => ({ ...r, current: r.sha256 === sha })),
    };
  });

  app.put('/api/admin/privacy', admin, async (req) => {
    const b = z
      .object({
        name: z.string().trim().max(200),
        address: z.string().trim().max(300),
        vat: z.string().trim().max(40).default(''),
        email: z.string().trim().max(200),
        pec: z.string().trim().max(200).default(''),
        dpo: z.string().trim().max(300).default(''),
        retentionMonths: z.number().int().min(1).max(120).default(24),
      })
      .strict()
      .parse(req.body);
    db.prepare(
      `INSERT INTO settings(key, value, updated_at, updated_by) VALUES(?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ).run(KEY, JSON.stringify(b), nowIso(), req.user!.id);
    recordEvent(db, req.user!.id, 'privacy.controller', b.name, 'dati del titolare aggiornati: l’informativa va accettata di nuovo');
    return { ok: true, complete: controllerComplete(b), sha256: controllerComplete(b) ? noticeSha256(b) : null };
  });
}
