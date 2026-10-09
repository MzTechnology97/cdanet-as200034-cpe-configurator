import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
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
  parseClientHeader,
} from '../domain/policy.ts';
import { loadLatestRelease } from '../services/releases.ts';
import { escapeHtml } from '../services/telegram.ts';
import { hashRecovery, looksLikeRecoveryCode, newRecoveryCodes, newSecret, otpauthUrl, verifyCode } from '../domain/totp.ts';

const loginSchema = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(200),
});

export function publicRoutes(app: FastifyInstance, ctx: AppContext) {
  const limiter = createLoginLimiter();
  const findUser = ctx.db.prepare('SELECT id, username, password_hash, role, active, token_version, totp_enabled FROM users WHERE username = ?');

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
      | { id: number; username: string; password_hash: string; role: 'admin' | 'installer'; active: number; token_version: number; totp_enabled: number }
      | undefined;
    const valid = verifyPassword(body.password, u?.password_hash ?? DUMMY_PASSWORD_HASH);
    if (!u || !valid || !u.active) {
      limiter.fail(req.ip, body.username);
      if (limiter.blocked(req.ip, body.username)) {
        ctx.notify.security(`Troppi tentativi di accesso falliti per <b>${escapeHtml(body.username)}</b> da ${escapeHtml(req.ip)}: accesso bloccato per qualche minuto`);
      }
      throw new HttpError(401, 'invalid_credentials');
    }
    limiter.clear(req.ip, body.username);
    // Two-step verification: the password alone only buys a 5-minute token for the code step.
    if (u.totp_enabled) return { mfaRequired: true, mfaToken: await ctx.auth.issueMfaToken(u) };
    return session(u, req.ip);
  };

  async function session(u: { id: number; username: string; role: 'admin' | 'installer'; token_version: number; totp_enabled?: number }, ip: string, notify = true) {
    ctx.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), u.id);
    const { token, expiresAt } = await ctx.auth.issueToken(u);
    if (u.role === 'admin' && notify) ctx.notify.adminLogin(u.id, u.username, ip);
    const mfaSetupRequired = u.role === 'admin' && ctx.auth.totpRequiredForAdmins() && !u.totp_enabled;
    return { token, expiresAt, user: { id: u.id, username: u.username, role: u.role }, ...(mfaSetupRequired ? { mfaSetupRequired: true } : {}) };
  }

  /** Second step: TOTP code (or a one-time recovery code). */
  app.post('/api/auth/login/totp', async (req) => {
    const b = z.object({ mfaToken: z.string().min(10).max(2000), code: z.string().trim().min(6).max(12) }).strict().parse(req.body);
    const t = await ctx.auth.verifyMfaToken(b.mfaToken);
    const u = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(t.id) as TotpRow | undefined;
    if (!u || !u.active || u.token_version !== t.tv || !u.totp_enabled) throw new HttpError(401, 'mfa_expired');
    if (limiter.blocked(req.ip, u.username)) throw new HttpError(429, 'too_many_attempts');
    if (!checkSecondFactor(u, b.code)) {
      limiter.fail(req.ip, u.username);
      if (limiter.blocked(req.ip, u.username)) ctx.notify.security(`Troppi codici di verifica errati per <b>${escapeHtml(u.username)}</b> da ${escapeHtml(req.ip)}`);
      throw new HttpError(401, 'invalid_code');
    }
    limiter.clear(req.ip, u.username);
    return session(u, req.ip);
  });

  type TotpRow = {
    id: number;
    username: string;
    password_hash: string;
    role: 'admin' | 'installer';
    active: number;
    token_version: number;
    totp_secret: string;
    totp_pending: string;
    totp_enabled: number;
    totp_last_step: number;
    recovery_codes: string;
  };

  /** TOTP code (anti-replay) or one-time recovery code; consumes what it uses. */
  function checkSecondFactor(u: TotpRow, code: string): boolean {
    if (looksLikeRecoveryCode(code) && !/^\d{6}$/.test(code)) {
      const hashes = JSON.parse(u.recovery_codes || '[]') as string[];
      const h = hashRecovery(code);
      if (!hashes.includes(h)) return false;
      ctx.db.prepare('UPDATE users SET recovery_codes = ? WHERE id = ?').run(JSON.stringify(hashes.filter((x) => x !== h)), u.id);
      recordEvent(ctx.db, u.id, 'account.recovery_code', u.username, `codice di recupero usato, ne restano ${hashes.length - 1}`);
      return true;
    }
    const step = verifyCode(ctx.sealer.open(u.totp_secret), code, { lastStep: u.totp_last_step });
    if (step === null) return false;
    ctx.db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, u.id);
    return true;
  }
  app.post('/api/auth/login', login);
  // v0.5.x APKs log in here before their updater installs v1.
  app.post('/api/login', login);

  app.get('/api/auth/me', { preHandler: ctx.auth.requireUser }, async (req) => ({ user: req.user }));

  // ---- Il mio account -------------------------------------------------------------------
  const selfRow = ctx.db.prepare('SELECT id, username, password_hash, role, active, token_version, last_login_at, created_at FROM users WHERE id = ?');
  type SelfRow = { id: number; username: string; password_hash: string; role: 'admin' | 'installer'; active: number; token_version: number; last_login_at: string | null; created_at: string };

  app.get('/api/auth/account', { preHandler: ctx.auth.requireUser }, async (req) => {
    const u = selfRow.get(req.user!.id) as SelfRow;
    const t = ctx.db.prepare('SELECT totp_enabled, recovery_codes FROM users WHERE id = ?').get(u.id) as { totp_enabled: number; recovery_codes: string };
    return {
      id: u.id,
      username: u.username,
      role: u.role,
      lastLoginAt: u.last_login_at,
      createdAt: u.created_at,
      totpEnabled: !!t.totp_enabled,
      totpRequired: u.role === 'admin' && ctx.auth.totpRequiredForAdmins(),
      recoveryCodesLeft: t.totp_enabled ? (JSON.parse(t.recovery_codes) as string[]).length : 0,
    };
  });

  // ---- Two-step verification (TOTP) ------------------------------------------------------
  const totpRow = (id: number) => ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as TotpRow;
  const needPassword = (u: TotpRow, password: string, ip: string) => {
    if (limiter.blocked(ip, u.username)) throw new HttpError(429, 'too_many_attempts');
    if (!verifyPassword(password, u.password_hash)) {
      limiter.fail(ip, u.username);
      throw new HttpError(403, 'wrong_current_password');
    }
  };

  /** Step 1: new secret (pending until confirmed with a code). Password required. */
  app.post('/api/auth/totp/setup', { preHandler: ctx.auth.requireUser }, async (req) => {
    const b = z.object({ password: z.string().min(1).max(200) }).strict().parse(req.body);
    const u = totpRow(req.user!.id);
    needPassword(u, b.password, req.ip);
    const secret = newSecret();
    ctx.db.prepare('UPDATE users SET totp_pending = ? WHERE id = ?').run(ctx.sealer.seal(secret), u.id);
    return { secret, otpauthUrl: otpauthUrl(secret, u.username) };
  });

  /** Step 2: the first code from the app turns it on; recovery codes are shown once. */
  app.post('/api/auth/totp/enable', { preHandler: ctx.auth.requireUser }, async (req) => {
    const b = z.object({ code: z.string().trim().min(6).max(8) }).strict().parse(req.body);
    const u = totpRow(req.user!.id);
    if (!u.totp_pending) throw new HttpError(409, 'totp_setup_missing');
    const pending = ctx.sealer.open(u.totp_pending);
    const step = verifyCode(pending, b.code);
    if (step === null) throw new HttpError(400, 'invalid_code');
    const rc = newRecoveryCodes();
    ctx.db
      .prepare("UPDATE users SET totp_secret = ?, totp_pending = '', totp_enabled = 1, totp_last_step = ?, recovery_codes = ? WHERE id = ?")
      .run(u.totp_pending, step, JSON.stringify(rc.hashes), u.id);
    recordEvent(ctx.db, u.id, 'account.totp_enable', u.username, 'verifica in due passaggi attivata');
    if (u.role === 'admin') ctx.notify.security(`Verifica in due passaggi attivata per <b>${escapeHtml(u.username)}</b>`);
    return { ok: true, recoveryCodes: rc.codes };
  });

  app.post('/api/auth/totp/disable', { preHandler: ctx.auth.requireUser }, async (req) => {
    const b = z.object({ password: z.string().min(1).max(200), code: z.string().trim().min(6).max(12) }).strict().parse(req.body);
    const u = totpRow(req.user!.id);
    if (!u.totp_enabled) return { ok: true };
    if (u.role === 'admin' && ctx.auth.totpRequiredForAdmins()) throw new HttpError(409, 'totp_required_by_policy');
    needPassword(u, b.password, req.ip);
    if (!checkSecondFactor(u, b.code)) throw new HttpError(400, 'invalid_code');
    ctx.db.prepare("UPDATE users SET totp_secret = '', totp_pending = '', totp_enabled = 0, totp_last_step = 0, recovery_codes = '[]' WHERE id = ?").run(u.id);
    recordEvent(ctx.db, u.id, 'account.totp_disable', u.username, 'verifica in due passaggi disattivata');
    if (u.role === 'admin') ctx.notify.security(`Verifica in due passaggi <b>disattivata</b> da <b>${escapeHtml(u.username)}</b>`);
    return { ok: true };
  });

  app.post('/api/auth/totp/recovery', { preHandler: ctx.auth.requireUser }, async (req) => {
    const b = z.object({ password: z.string().min(1).max(200) }).strict().parse(req.body);
    const u = totpRow(req.user!.id);
    if (!u.totp_enabled) throw new HttpError(409, 'totp_not_enabled');
    needPassword(u, b.password, req.ip);
    const rc = newRecoveryCodes();
    ctx.db.prepare('UPDATE users SET recovery_codes = ? WHERE id = ?').run(JSON.stringify(rc.hashes), u.id);
    recordEvent(ctx.db, u.id, 'account.recovery_new', u.username, 'nuovi codici di recupero');
    return { recoveryCodes: rc.codes };
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
    if (u.role === 'admin') ctx.notify.security(`Password dell'amministratore <b>${escapeHtml(u.username)}</b> cambiata dall'interessato`);
    const { token, expiresAt } = await ctx.auth.issueToken({ ...u, token_version: u.token_version + 1 });
    return { ok: true, token, expiresAt };
  });

  /** Revokes every session of the account (lost phone, shared PC). */
  app.post('/api/auth/logout-all', { preHandler: ctx.auth.requireUser }, async (req) => {
    ctx.db.prepare('UPDATE users SET token_version = token_version + 1 WHERE id = ?').run(req.user!.id);
    recordEvent(ctx.db, req.user!.id, 'account.logout_all', req.user!.username, 'tutte le sessioni chiuse');
    return { ok: true };
  });

  // ---- Quick login from the app (fingerprint / face) -----------------------------------------
  // After a full login (password and, when enabled, the TOTP code) the app registers the phone:
  // it gets a random device key, kept in the Android keystore behind the biometric prompt.
  // The server keeps only its hash; the key stops working with logout-all, a password change,
  // an admin reset or when it is removed (Il mio account / app settings).
  // Persistent login: the app stays signed in with the phone's key; the key expires after
  // DEVICE_IDLE_DAYS without use and in any case DEVICE_MAX_DAYS after the login with the password.
  const DEVICE_IDLE_DAYS = 30;
  const DEVICE_MAX_DAYS = 180;
  const DAY_MS = 24 * 3600 * 1000;
  const deviceExpiry = (createdAt: string, now = Date.now()) =>
    new Date(Math.min(now + DEVICE_IDLE_DAYS * DAY_MS, Date.parse(createdAt) + DEVICE_MAX_DAYS * DAY_MS)).toISOString();
  const deviceRow = ctx.db.prepare('SELECT d.*, u.username, u.role, u.active, u.token_version tv, u.totp_enabled FROM auth_devices d JOIN users u ON u.id = d.user_id WHERE d.id = ?');
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const trusted = (req: FastifyRequest) => {
    const c = parseClientHeader(req.headers['x-cda-client'] as string | undefined);
    if (!c) throw new HttpError(403, 'trusted_client_required');
  };

  app.post('/api/auth/devices', { preHandler: ctx.auth.requireUser }, async (req, reply) => {
    trusted(req);
    const b = z.object({ name: z.string().trim().min(1).max(60), persistent: z.boolean().optional() }).strict().parse(req.body);
    const u = selfRow.get(req.user!.id) as SelfRow;
    // a few phones per account: the oldest ones make room
    const old = ctx.db.prepare('SELECT id FROM auth_devices WHERE user_id = ? ORDER BY created_at DESC').all(u.id) as Array<{ id: string }>;
    for (const o of old.slice(4)) ctx.db.prepare('DELETE FROM auth_devices WHERE id = ?').run(o.id);
    const id = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const created = nowIso();
    const expiresAt = deviceExpiry(created);
    ctx.db
      .prepare('INSERT INTO auth_devices(id, user_id, secret_hash, name, token_version, created_at, expires_at, persistent) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, u.id, sha(secret), b.name, u.token_version, created, expiresAt, b.persistent ? 1 : 0);
    recordEvent(ctx.db, u.id, 'account.quick_login_on', u.username, `${b.persistent ? 'accesso persistente' : 'accesso rapido'} attivato su ${b.name}`);
    reply.header('Cache-Control', 'no-store');
    return reply.code(201).send({ id, secret, expiresAt });
  });

  app.get('/api/auth/devices', { preHandler: ctx.auth.requireUser }, async (req) => {
    const u = selfRow.get(req.user!.id) as SelfRow;
    const rows = ctx.db
      .prepare('SELECT id, name, created_at createdAt, last_used_at lastUsedAt, expires_at expiresAt, persistent, token_version tv FROM auth_devices WHERE user_id = ? ORDER BY created_at DESC')
      .all(u.id) as Array<{ id: string; name: string; createdAt: string; lastUsedAt: string | null; expiresAt: string | null; persistent: number; tv: number }>;
    const now = nowIso();
    return {
      devices: rows.map(({ tv, persistent, ...d }) => ({ ...d, persistent: !!persistent, active: tv === u.token_version && (!d.expiresAt || d.expiresAt > now) })),
    };
  });

  app.delete('/api/auth/devices/:id', { preHandler: ctx.auth.requireUser }, async (req) => {
    const id = z.string().uuid().parse((req.params as { id: string }).id);
    const r = ctx.db.prepare('DELETE FROM auth_devices WHERE id = ? AND user_id = ?').run(id, req.user!.id);
    if (!r.changes) throw new HttpError(404, 'device_not_found');
    recordEvent(ctx.db, req.user!.id, 'account.quick_login_off', req.user!.username, 'accesso rapido disattivato');
    return { ok: true };
  });

  app.post('/api/auth/device-login', async (req) => {
    trusted(req);
    const b = z.object({ id: z.string().uuid(), secret: z.string().min(20).max(100) }).parse(req.body);
    if (limiter.blocked(req.ip, `device:${b.id}`)) throw new HttpError(429, 'too_many_attempts');
    const d = deviceRow.get(b.id) as
      | {
          user_id: number;
          secret_hash: string;
          token_version: number;
          name: string;
          created_at: string;
          expires_at: string | null;
          persistent: number;
          username: string;
          role: 'admin' | 'installer';
          active: number;
          tv: number;
          totp_enabled: number;
        }
      | undefined;
    const ok = !!d && timingSafeEqual(Buffer.from(sha(b.secret)), Buffer.from(d.secret_hash)) && !!d.active && d.token_version === d.tv;
    if (!d || !ok) {
      limiter.fail(req.ip, `device:${b.id}`);
      throw new HttpError(401, 'device_revoked');
    }
    limiter.clear(req.ip, `device:${b.id}`);
    if (d.expires_at && d.expires_at <= nowIso()) {
      // the persistent login ran out: a login with the password is needed (and registers the phone again)
      ctx.db.prepare('DELETE FROM auth_devices WHERE id = ?').run(b.id);
      throw new HttpError(401, 'device_expired');
    }
    const deviceExpiresAt = d.expires_at ? deviceExpiry(d.created_at) : null;
    ctx.db.prepare('UPDATE auth_devices SET last_used_at = ?, expires_at = COALESCE(?, expires_at) WHERE id = ?').run(nowIso(), deviceExpiresAt, b.id);
    recordEvent(ctx.db, d.user_id, 'account.quick_login', d.username, d.name);
    return { ...(await session({ id: d.user_id, username: d.username, role: d.role, token_version: d.tv, totp_enabled: d.totp_enabled }, req.ip, !d.persistent)), deviceExpiresAt };
  });

  app.get('/api/meta', { preHandler: ctx.auth.requireUser }, async (req) => ({
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
    modules: ctx.modules.stateFor(req.user!.id),
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
      // with "App sempre all'ultima versione" every new release is mandatory
      mandatory: m.mandatory || ctx.cfg.appForceLatest,
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
