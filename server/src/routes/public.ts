import { createReadStream } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError, createLoginLimiter } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from '../crypto.ts';
import { nowIso, recordEvent } from '../db.ts';
import {
  COMPATIBILITY_FIRMWARE,
  DISTRICT_RANGE,
  MANAGEMENT_PORTS,
  NODE_RANGE,
  SUPPORTED_MODELS,
  TARGET_FIRMWARE,
} from '../domain/policy.ts';
import { loadLatestRelease } from '../services/releases.ts';

const loginSchema = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(200),
});

export function publicRoutes(app: FastifyInstance, ctx: AppContext) {
  const limiter = createLoginLimiter();
  const findUser = ctx.db.prepare('SELECT id, username, password_hash, role, active, token_version FROM users WHERE username = ?');

  app.get('/api/health', async () => ({
    ok: true,
    service: 'cdanet-cpe-server',
    version: ctx.version,
    targetFirmware: TARGET_FIRMWARE,
    minAndroidVersion: ctx.cfg.minAndroidVersion,
  }));

  const login = async (req: FastifyRequest) => {
    const body = loginSchema.parse(req.body);
    if (limiter.blocked(req.ip, body.username)) throw new HttpError(429, 'too_many_attempts');
    const u = findUser.get(body.username) as
      | { id: number; username: string; password_hash: string; role: 'admin' | 'installer'; active: number; token_version: number }
      | undefined;
    const valid = verifyPassword(body.password, u?.password_hash ?? DUMMY_PASSWORD_HASH);
    if (!u || !valid || !u.active) {
      limiter.fail(req.ip, body.username);
      throw new HttpError(401, 'invalid_credentials');
    }
    limiter.clear(req.ip, body.username);
    ctx.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), u.id);
    const { token, expiresAt } = await ctx.auth.issueToken(u);
    return { token, expiresAt, user: { id: u.id, username: u.username, role: u.role } };
  };
  app.post('/api/auth/login', login);
  // v0.5.x APKs log in here before their updater installs v1.
  app.post('/api/login', login);

  app.get('/api/auth/me', { preHandler: ctx.auth.requireUser }, async (req) => ({ user: req.user }));

  // ---- Il mio account -------------------------------------------------------------------
  const selfRow = ctx.db.prepare('SELECT id, username, password_hash, role, active, token_version, last_login_at, created_at FROM users WHERE id = ?');
  type SelfRow = { id: number; username: string; password_hash: string; role: 'admin' | 'installer'; active: number; token_version: number; last_login_at: string | null; created_at: string };

  app.get('/api/auth/account', { preHandler: ctx.auth.requireUser }, async (req) => {
    const u = selfRow.get(req.user!.id) as SelfRow;
    return { id: u.id, username: u.username, role: u.role, lastLoginAt: u.last_login_at, createdAt: u.created_at };
  });

  /** Own password change: needs the current password; other sessions are revoked, this one gets a new token. */
  app.post('/api/auth/password', { preHandler: ctx.auth.requireUser }, async (req) => {
    const b = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(12).max(200) }).strict().parse(req.body);
    const u = selfRow.get(req.user!.id) as SelfRow;
    if (limiter.blocked(req.ip, u.username)) throw new HttpError(429, 'too_many_attempts');
    if (!verifyPassword(b.currentPassword, u.password_hash)) {
      limiter.fail(req.ip, u.username);
      throw new HttpError(403, 'wrong_current_password');
    }
    if (b.newPassword === b.currentPassword) throw new HttpError(400, 'password_unchanged');
    if (b.newPassword.toLowerCase().includes(u.username.toLowerCase())) throw new HttpError(400, 'password_contains_username');
    limiter.clear(req.ip, u.username);
    ctx.db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(hashPassword(b.newPassword), u.id);
    recordEvent(ctx.db, u.id, 'account.password', u.username, 'cambio password personale');
    const { token, expiresAt } = await ctx.auth.issueToken({ ...u, token_version: u.token_version + 1 });
    return { ok: true, token, expiresAt };
  });

  /** Revokes every session of the account (lost phone, shared PC). */
  app.post('/api/auth/logout-all', { preHandler: ctx.auth.requireUser }, async (req) => {
    ctx.db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(req.user!.id);
    recordEvent(ctx.db, req.user!.id, 'account.logout_all', req.user!.username, 'tutte le sessioni chiuse');
    return { ok: true };
  });

  app.get('/api/meta', { preHandler: ctx.auth.requireUser }, async () => ({
    version: ctx.version,
    models: SUPPORTED_MODELS,
    targetFirmware: TARGET_FIRMWARE,
    compatibilityFirmware: COMPATIBILITY_FIRMWARE,
    ssid: { pattern: 'CDA-NET-N{nodo}-D{distretto}', node: NODE_RANGE, district: DISTRICT_RANGE },
    pppoeUserPattern: '^[A-Za-z0-9._-]+@cda-net\\.it$',
    factoryIp: ctx.cfg.network.factoryIp,
    managementPorts: MANAGEMENT_PORTS,
    jobTtlMinutes: ctx.cfg.jobTtlMinutes,
    uisp: !!ctx.uisp,
    coverageMaxKm: ctx.uispSettings.coverageMaxKm,
  }));

  // Android update channel: reachable before login so a broken login can still be repaired.
  app.get('/api/mobile/update', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const m = loadLatestRelease(ctx.cfg.releases.dir);
    if (!m) return { available: false };
    return {
      available: true,
      versionCode: m.versionCode,
      versionName: m.versionName,
      sha256: m.sha256,
      mandatory: m.mandatory,
      apkUrl: '/api/mobile/apk',
    };
  });

  app.get('/api/mobile/apk', async (_req, reply) => {
    const m = loadLatestRelease(ctx.cfg.releases.dir);
    if (!m) throw new HttpError(404, 'release_not_available');
    reply
      .header('Cache-Control', 'no-store')
      .header('X-Content-SHA256', m.sha256)
      .header('Content-Type', 'application/vnd.android.package-archive')
      .header('Content-Disposition', `attachment; filename="${m.fileName}"`);
    return reply.send(createReadStream(m.apkPath));
  });
}
