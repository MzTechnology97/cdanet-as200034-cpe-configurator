import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { hashPassword, sha256Hex } from '../crypto.ts';
import { nowIso, recordEvent } from '../db.ts';
import { autoTemplate } from '../domain/autotemplate.ts';
import { parseWirelessCsv } from '../domain/wireless-csv.ts';
import { BOARD_MATCH_SUGGESTIONS, SSID_RX, SUPPORTED_MODELS, TARGET_FIRMWARE } from '../domain/policy.ts';
import { PLACEHOLDERS, inspectTemplate, normalizeTemplate } from '../domain/systemcfg.ts';
import { loadLatestRelease } from '../services/releases.ts';

const username = z.string().trim().min(3).max(80).regex(/^[A-Za-z0-9._-]+$/);
const password = z.string().min(12).max(200);

export function adminRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, sealer } = ctx;
  const admin = { preHandler: ctx.auth.requireAdmin };
  const actor = (req: { user?: { id: number } }) => req.user?.id ?? null;

  // ---- Installer / admin accounts ------------------------------------------------
  app.get('/api/admin/users', admin, async () =>
    db
      .prepare(
        `SELECT u.id, u.username, u.role, u.active, u.created_at createdAt, u.last_login_at lastLoginAt,
                (SELECT count(*) FROM provisioning_jobs j WHERE j.user_id = u.id) jobs
         FROM users u ORDER BY u.role, u.username`,
      )
      .all()
      .map((r) => ({ ...r, active: !!(r as { active: number }).active })),
  );

  app.post('/api/admin/users', admin, async (req, reply) => {
    const b = z.object({ username, password, role: z.enum(['installer', 'admin']).default('installer') }).strict().parse(req.body);
    try {
      const r = db
        .prepare('INSERT INTO users(username, password_hash, role, created_at) VALUES(?,?,?,?)')
        .run(b.username, hashPassword(b.password), b.role, nowIso());
      recordEvent(db, actor(req), 'user.create', b.username, b.role);
      return reply.code(201).send({ ok: true, id: Number(r.lastInsertRowid) });
    } catch {
      throw new HttpError(409, 'username_exists');
    }
  });

  app.patch('/api/admin/users/:id', admin, async (req) => {
    const id = z.coerce.number().int().positive().parse((req.params as { id: string }).id);
    const b = z
      .object({ active: z.boolean().optional(), password: password.optional(), role: z.enum(['installer', 'admin']).optional() })
      .strict()
      .refine((x) => Object.keys(x).length > 0, 'empty')
      .parse(req.body);
    const target = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(id) as
      | { id: number; username: string; role: string }
      | undefined;
    if (!target) throw new HttpError(404, 'user_not_found');
    if (id === req.user?.id && (b.active === false || b.role === 'installer')) throw new HttpError(409, 'cannot_demote_current_admin');
    if ((b.active === false || b.role === 'installer') && target.role === 'admin') {
      const admins = (db.prepare("SELECT count(*) n FROM users WHERE role = 'admin' AND active = 1").get() as { n: number }).n;
      if (admins <= 1) throw new HttpError(409, 'last_admin');
    }
    // Any security-relevant change bumps token_version, revoking existing sessions.
    if (b.password !== undefined) db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(hashPassword(b.password), id);
    if (b.active !== undefined) db.prepare('UPDATE users SET active = ?, token_version = token_version + 1 WHERE id = ?').run(b.active ? 1 : 0, id);
    if (b.role !== undefined) db.prepare('UPDATE users SET role = ?, token_version = token_version + 1 WHERE id = ?').run(b.role, id);
    recordEvent(db, actor(req), 'user.update', target.username, Object.keys(b).join(','));
    return { ok: true, id, username: target.username };
  });

  // ---- SSID / WPA2 --------------------------------------------------------------
  app.get('/api/admin/wireless-networks', admin, async () =>
    db.prepare('SELECT ssid, updated_at updatedAt FROM wireless_secrets ORDER BY ssid').all(),
  );

  app.put('/api/admin/wireless-networks/:ssid', admin, async (req) => {
    const ssid = z.string().regex(SSID_RX).parse((req.params as { ssid: string }).ssid);
    const b = z.object({ wpa2Password: z.string().min(8).max(63).regex(/^[\x20-\x7e]+$/) }).strict().parse(req.body);
    db.prepare(
      `INSERT INTO wireless_secrets(ssid, wpa2_ciphertext, updated_at) VALUES(?,?,?)
       ON CONFLICT(ssid) DO UPDATE SET wpa2_ciphertext = excluded.wpa2_ciphertext, updated_at = excluded.updated_at`,
    ).run(ssid, sealer.seal(b.wpa2Password), nowIso());
    recordEvent(db, actor(req), 'wireless.set', ssid);
    return { ok: true, ssid };
  });

  app.delete('/api/admin/wireless-networks/:ssid', admin, async (req) => {
    const ssid = z.string().regex(SSID_RX).parse((req.params as { ssid: string }).ssid);
    db.prepare('DELETE FROM wireless_secrets WHERE ssid = ?').run(ssid);
    recordEvent(db, actor(req), 'wireless.delete', ssid);
    return { ok: true };
  });

  /** Bulk create/update from CSV. All-or-nothing: any invalid row and nothing is written. */
  app.post('/api/admin/wireless-networks/import', { ...admin, bodyLimit: 2 * 1024 * 1024 }, async (req) => {
    const b = z.object({ csv: z.string().min(1).max(2_000_000), dryRun: z.boolean().default(true) }).strict().parse(req.body);
    const { rows, errors } = parseWirelessCsv(b.csv);
    const existing = new Map(
      (db.prepare('SELECT ssid, wpa2_ciphertext FROM wireless_secrets').all() as Array<{ ssid: string; wpa2_ciphertext: string }>).map((r) => [
        r.ssid,
        r.wpa2_ciphertext,
      ]),
    );
    const created: string[] = [];
    const updated: string[] = [];
    const unchanged: string[] = [];
    const sameKey = (sealed: string, wpa2: string) => {
      try {
        return sealer.open(sealed) === wpa2;
      } catch {
        return false;
      }
    };
    for (const r of rows) {
      const sealed = existing.get(r.ssid);
      if (!sealed) created.push(r.ssid);
      else if (sameKey(sealed, r.wpa2)) unchanged.push(r.ssid);
      else updated.push(r.ssid);
    }
    const ok = errors.length === 0;
    if (ok && !b.dryRun && created.length + updated.length > 0) {
      const write = new Set([...created, ...updated]);
      const upsert = db.prepare(
        `INSERT INTO wireless_secrets(ssid, wpa2_ciphertext, updated_at) VALUES(?,?,?)
         ON CONFLICT(ssid) DO UPDATE SET wpa2_ciphertext = excluded.wpa2_ciphertext, updated_at = excluded.updated_at`,
      );
      const now = nowIso();
      db.exec('BEGIN');
      try {
        for (const r of rows) if (write.has(r.ssid)) upsert.run(r.ssid, sealer.seal(r.wpa2), now);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      recordEvent(db, actor(req), 'wireless.import', `${rows.length} righe`, `${created.length} nuove, ${updated.length} aggiornate, ${unchanged.length} invariate`);
    }
    return { ok, dryRun: b.dryRun || !ok, rows: rows.length, created, updated, unchanged, errors: errors.slice(0, 200), errorCount: errors.length };
  });

  app.post('/api/admin/wireless-networks/bulk-delete', admin, async (req) => {
    const b = z.object({ ssids: z.array(z.string().regex(SSID_RX)).min(1).max(10_000) }).strict().parse(req.body);
    const del = db.prepare('DELETE FROM wireless_secrets WHERE ssid = ?');
    let deleted = 0;
    db.exec('BEGIN');
    try {
      for (const s of new Set(b.ssids)) deleted += Number(del.run(s).changes);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    recordEvent(db, actor(req), 'wireless.bulk_delete', `${deleted} reti`, b.ssids.slice(0, 20).join(', ') + (b.ssids.length > 20 ? '…' : ''));
    return { ok: true, deleted };
  });

  // ---- airOS profiles -----------------------------------------------------------
  const modelParam = z.object({ model: z.enum(SUPPORTED_MODELS) });
  const profileBody = z
    .object({ template: z.string().min(64).max(300_000), boardMatch: z.string().trim().min(2).max(240) })
    .strict();

  const validateBoardMatch = (rx: string) => {
    try {
      new RegExp(rx, 'is');
    } catch {
      throw new HttpError(400, 'board_match_invalid_regex');
    }
  };

  app.get('/api/admin/profiles', admin, async () => {
    const rows = db
      .prepare(
        `SELECT p.model, p.firmware, p.board_match boardMatch, p.template_sha256 sha256, p.updated_at updatedAt, u.username updatedBy
         FROM provision_profiles p LEFT JOIN users u ON u.id = p.updated_by ORDER BY p.model`,
      )
      .all() as Array<{ model: string }>;
    return SUPPORTED_MODELS.map((model) => ({ model, firmware: TARGET_FIRMWARE, profile: rows.find((r) => r.model === model) ?? null }));
  });

  app.get('/api/admin/placeholders', admin, async () => Object.entries(PLACEHOLDERS).map(([name, description]) => ({ name, description })));

  /** Raw CPE backup -> template with placeholders + preview. Nothing is stored here. */
  app.post('/api/admin/profiles/:model/autotemplate', admin, async (req) => {
    const { model } = modelParam.parse(req.params);
    const b = z.object({ backup: z.string().min(64).max(300_000) }).strict().parse(req.body);
    const result = autoTemplate(b.backup);
    return { ...result, report: inspectTemplate(result.template), suggestedBoardMatch: BOARD_MATCH_SUGGESTIONS[model] };
  });

  app.post('/api/admin/profiles/:model/inspect', admin, async (req) => {
    modelParam.parse(req.params);
    const b = profileBody.partial({ boardMatch: true }).parse(req.body);
    if (b.boardMatch) validateBoardMatch(b.boardMatch);
    return inspectTemplate(b.template);
  });

  app.put('/api/admin/profiles/:model', admin, async (req) => {
    const { model } = modelParam.parse(req.params);
    const b = profileBody.parse(req.body);
    validateBoardMatch(b.boardMatch);
    const report = inspectTemplate(b.template);
    if (!report.ok) throw new HttpError(400, report.errors[0] as string, { report });
    const template = normalizeTemplate(b.template);
    const sha = sha256Hex(template);
    const now = nowIso();
    db.prepare(
      `INSERT INTO provision_profiles(model, firmware, board_match, template_ciphertext, template_sha256, updated_at, updated_by)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(model, firmware) DO UPDATE SET board_match = excluded.board_match, template_ciphertext = excluded.template_ciphertext,
         template_sha256 = excluded.template_sha256, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ).run(model, TARGET_FIRMWARE, b.boardMatch, sealer.seal(template), sha, now, actor(req));
    recordEvent(db, actor(req), 'profile.set', model, sha);
    return { ok: true, model, firmware: TARGET_FIRMWARE, sha256: sha, updatedAt: now, report };
  });

  app.delete('/api/admin/profiles/:model', admin, async (req) => {
    const { model } = modelParam.parse(req.params);
    db.prepare('DELETE FROM provision_profiles WHERE model = ? AND firmware = ?').run(model, TARGET_FIRMWARE);
    recordEvent(db, actor(req), 'profile.delete', model);
    return { ok: true };
  });

  // ---- Status / settings --------------------------------------------------------
  app.get('/api/admin/status', admin, async () => {
    const c = ctx.cfg;
    const count = (sql: string, ...params: string[]) => (db.prepare(sql).get(...params) as { n: number }).n;
    const since30d = new Date(Date.now() - 30 * 86400_000).toISOString();
    const release = loadLatestRelease(c.releases.dir);
    return {
      version: ctx.version,
      runtimeSecrets: {
        cpeAdminPassword: !!c.cpeSecrets.adminPassword,
        uispEnrollment: !!c.cpeSecrets.uispEnrollment,
        snmpCommunity: c.cpeSecrets.snmpCommunity === 'public' ? 'public (default)' : 'custom',
      },
      policy: {
        cpeAdminUsername: c.cpeSecrets.adminUsername,
        snmpContact: c.cpeSecrets.snmpContact,
        network: c.network,
        jobTtlMinutes: c.jobTtlMinutes,
        minAndroidVersion: c.minAndroidVersion,
        auditRetentionDays: c.auditRetentionDays,
      },
      counts: {
        users: count('SELECT count(*) n FROM users WHERE active = 1'),
        wirelessNetworks: count('SELECT count(*) n FROM wireless_secrets'),
        profiles: count('SELECT count(*) n FROM provision_profiles WHERE firmware = ?', TARGET_FIRMWARE),
        jobs30d: count('SELECT count(*) n FROM provisioning_jobs WHERE created_at > ?', since30d),
        success30d: count("SELECT count(*) n FROM provisioning_jobs WHERE status = 'success' AND created_at > ?", since30d),
      },
      androidRelease: release
        ? { versionName: release.versionName, versionCode: release.versionCode, sha256: release.sha256, mandatory: release.mandatory }
        : null,
      androidReleaseSync: c.releases.githubRepo ? { repo: c.releases.githubRepo, everyMinutes: c.releases.syncMinutes } : null,
    };
  });

  app.get('/api/admin/events', admin, async (req) => {
    const limit = z.coerce.number().int().min(1).max(500).default(200).parse((req.query as { limit?: string }).limit);
    return db
      .prepare(
        `SELECT e.id, e.created_at createdAt, u.username, e.action, e.target, e.detail
         FROM events e LEFT JOIN users u ON u.id = e.user_id ORDER BY e.id DESC LIMIT ?`,
      )
      .all(limit);
  });
}
