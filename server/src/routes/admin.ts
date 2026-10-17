import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { todayRome } from './work-orders.ts';
import { HttpError, createLoginLimiter } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { hashPassword, sha256Hex, verifyPassword } from '../crypto.ts';
import { nowIso, recordEvent } from '../db.ts';
import { applyForm, formFieldsView, policyWarnings, readForm, skeletonFor, templateFacts } from '../domain/airos-form.ts';
import { autoTemplate } from '../domain/autotemplate.ts';
import { parseWirelessCsv, wirelessCsv } from '../domain/wireless-csv.ts';
import { BOARD_MATCH_SUGGESTIONS, SSID_RX, SUPPORTED_MODELS, TARGET_FIRMWARE } from '../domain/policy.ts';
import { PLACEHOLDERS, inspectTemplate } from '../domain/systemcfg.ts';
import { DEFAULT_PARAMS, validateBoardMatch } from '../services/templates.ts';
import { loadLatestRelease } from '../services/releases.ts';
import { escapeHtml } from '../services/telegram.ts';
import { isModuleKey, type ModuleKey } from '../services/modules.ts';
import { isAp, isPtp } from '../services/uisp.ts';

const username = z.string().trim().min(3).max(80).regex(/^[A-Za-z0-9._-]+$/);
const password = z.string().min(12).max(200);

export function adminRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, sealer } = ctx;
  const admin = { preHandler: ctx.auth.requireAdmin };
  // what the specialist sees and uses too (the CDA Net templates in read only, the form helpers)
  const staff = { preHandler: ctx.auth.requireStaff };
  const actor = (req: { user?: { id: number } }) => req.user?.id ?? null;

  // ---- Funzionalità (modules) -------------------------------------------------------
  app.get('/api/admin/modules', admin, async () => ctx.modules.list());

  app.put('/api/admin/modules', admin, async (req) => {
    const body = z.record(z.string(), z.boolean()).parse(req.body);
    const changes = Object.fromEntries(Object.entries(body).filter(([k]) => isModuleKey(k))) as Partial<Record<ModuleKey, boolean>>;
    if (!Object.keys(changes).length) throw new HttpError(400, 'invalid_request');
    ctx.modules.update(changes, req.user!.id);
    recordEvent(db, actor(req), 'modules.update', Object.keys(changes).join(', '), Object.entries(changes).map(([k, v]) => `${k}=${v ? 'on' : 'off'}`).join(' · '));
    return ctx.modules.list();
  });

  /** Modules of a single user: null = follow the global setting. */
  app.get('/api/admin/users/:id/modules', admin, async (req) => {
    const id = z.coerce.number().int().positive().parse((req.params as { id: string }).id);
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) throw new HttpError(404, 'user_not_found');
    return ctx.modules.listFor(id);
  });

  app.put('/api/admin/users/:id/modules', admin, async (req) => {
    const id = z.coerce.number().int().positive().parse((req.params as { id: string }).id);
    const target = db.prepare('SELECT username FROM users WHERE id = ?').get(id) as { username: string } | undefined;
    if (!target) throw new HttpError(404, 'user_not_found');
    const body = z.record(z.string(), z.boolean().nullable()).parse(req.body);
    const changes = Object.fromEntries(Object.entries(body).filter(([k]) => isModuleKey(k))) as Partial<Record<ModuleKey, boolean | null>>;
    if (!Object.keys(changes).length) throw new HttpError(400, 'invalid_request');
    ctx.modules.setFor(id, changes);
    recordEvent(db, actor(req), 'modules.user', target.username, Object.entries(changes).map(([k, v]) => `${k}=${v === null ? 'predefinito' : v ? 'on' : 'off'}`).join(' · '));
    return ctx.modules.listFor(id);
  });

  // ---- Security policy ---------------------------------------------------------------
  app.get('/api/admin/security', admin, async () => ({ totpRequiredForAdmins: ctx.auth.totpRequiredForAdmins() }));

  app.put('/api/admin/security', admin, async (req) => {
    const b = z.object({ totpRequiredForAdmins: z.boolean() }).strict().parse(req.body);
    // Never lock out the admin who flips the switch.
    if (b.totpRequiredForAdmins && !req.user!.totp) throw new HttpError(409, 'enable_totp_first');
    db.prepare(
      `INSERT INTO settings(key, value, updated_at, updated_by) VALUES('security.totp_admins', ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ).run(b.totpRequiredForAdmins ? 'required' : 'optional', nowIso(), req.user!.id);
    recordEvent(db, actor(req), 'security.policy', 'verifica in due passaggi admin', b.totpRequiredForAdmins ? 'obbligatoria' : 'facoltativa');
    ctx.notify.security(`Verifica in due passaggi per gli amministratori resa <b>${b.totpRequiredForAdmins ? 'obbligatoria' : 'facoltativa'}</b> da ${escapeHtml(req.user!.username)}`);
    return { totpRequiredForAdmins: b.totpRequiredForAdmins };
  });

  // ---- Installer / admin accounts ------------------------------------------------
  app.get('/api/admin/users', admin, async () =>
    db
      .prepare(
        `SELECT u.id, u.username, u.role, u.active, u.created_at createdAt, u.last_login_at lastLoginAt, u.totp_enabled totpEnabled, u.full_view fullView,
                u.warehouse_site_id warehouseSiteId, u.warehouse_site warehouseSite, u.stock_bypass stockBypass, u.warehouse_min_stock warehouseMinStock,
                (SELECT count(*) FROM provisioning_jobs j WHERE j.user_id = u.id) jobs
         FROM users u ORDER BY u.role, u.username`,
      )
      .all()
      .map((r) => ({
        ...r,
        active: !!(r as { active: number }).active,
        totpEnabled: !!(r as { totpEnabled: number }).totpEnabled,
        stockBypass: !!(r as { stockBypass: number }).stockBypass,
        // a specialist sees the work of the others only with this (#275), given by an admin
        fullView: (r as { role: string }).role === 'specialist' && !!(r as { fullView: number }).fullView,
        workGroups: (r as { role: string }).role === 'specialist' ? ctx.workGroups.groupNames((r as { id: number }).id) : [],
      })),
  );

  /** The name of a warehouse of the stock (ISP Billing), for the account it is linked to. */
  const warehouseName = (siteId: number | null | undefined) => {
    if (siteId == null) return '';
    const site = ctx.warehouse.sites().find((s) => s.id === siteId);
    if (!site) throw new HttpError(400, 'warehouse_not_found');
    return site.name;
  };

  app.post('/api/admin/users', admin, async (req, reply) => {
    const b = z
      .object({
        username,
        password,
        role: z.enum(['installer', 'admin', 'specialist']).default('installer'),
        /** Warehouse of the installer or partner (ISP Billing site); null = none. */
        warehouseSiteId: z.number().int().positive().nullable().optional(),
        /** May install CPEs that are not in that warehouse. */
        stockBypass: z.boolean().default(false),
      })
      .strict()
      .parse(req.body);
    const site = warehouseName(b.warehouseSiteId);
    try {
      const r = db
        .prepare('INSERT INTO users(username, password_hash, role, created_at, warehouse_site_id, warehouse_site, stock_bypass) VALUES(?,?,?,?,?,?,?)')
        .run(b.username, hashPassword(b.password), b.role, nowIso(), b.warehouseSiteId ?? null, site, b.stockBypass ? 1 : 0);
      recordEvent(db, actor(req), 'user.create', b.username, b.role);
      // a new account that sees everything: the NOC hears of it
      if (b.role === 'specialist') ctx.notify.security(`Nuovo account specialist <b>${escapeHtml(b.username)}</b> creato da ${escapeHtml(req.user!.username)}: vede i suoi dati e quelli dei suoi gruppi di lavoro`);
      return reply.code(201).send({ ok: true, id: Number(r.lastInsertRowid) });
    } catch {
      throw new HttpError(409, 'username_exists');
    }
  });

  app.patch('/api/admin/users/:id', admin, async (req) => {
    const id = z.coerce.number().int().positive().parse((req.params as { id: string }).id);
    const b = z
      .object({
        active: z.boolean().optional(),
        password: password.optional(),
        role: z.enum(['installer', 'admin', 'specialist']).optional(),
        resetTotp: z.literal(true).optional(),
        warehouseSiteId: z.number().int().positive().nullable().optional(),
        stockBypass: z.boolean().optional(),
        /** A specialist sees the work and the data of the others (#275): off by default. */
        fullView: z.boolean().optional(),
      })
      .strict()
      .refine((x) => Object.keys(x).length > 0, 'empty')
      .parse(req.body);
    const target = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(id) as
      | { id: number; username: string; role: string }
      | undefined;
    if (!target) throw new HttpError(404, 'user_not_found');
    // the full view is a permission of the specialists only (#275)
    if (b.fullView !== undefined && (b.role ?? target.role) !== 'specialist') throw new HttpError(400, 'full_view_specialist_only');
    const demoted = b.active === false || (b.role !== undefined && b.role !== 'admin');
    if (id === req.user?.id && demoted) throw new HttpError(409, 'cannot_demote_current_admin');
    if (demoted && target.role === 'admin') {
      const admins = (db.prepare("SELECT count(*) n FROM users WHERE role = 'admin' AND active = 1").get() as { n: number }).n;
      if (admins <= 1) throw new HttpError(409, 'last_admin');
    }
    // Any security-relevant change bumps token_version, revoking existing sessions.
    if (b.password !== undefined) {
      db.prepare('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?').run(hashPassword(b.password), id);
      if (target.role === 'admin') ctx.notify.security(`Password dell'amministratore <b>${escapeHtml(target.username)}</b> reimpostata da ${escapeHtml(req.user!.username)}`);
      else if (target.role === 'specialist') ctx.notify.security(`Password dello specialist <b>${escapeHtml(target.username)}</b> reimpostata da ${escapeHtml(req.user!.username)}`);
    }
    if (b.resetTotp) {
      db.prepare("UPDATE users SET totp_secret = '', totp_pending = '', totp_enabled = 0, totp_last_step = 0, recovery_codes = '[]', token_version = token_version + 1 WHERE id = ?").run(id);
      ctx.notify.security(`Verifica in due passaggi di <b>${escapeHtml(target.username)}</b> azzerata da ${escapeHtml(req.user!.username)}`);
    }
    if (b.role === 'admin' && target.role !== 'admin') ctx.notify.security(`<b>${escapeHtml(target.username)}</b> promosso amministratore da ${escapeHtml(req.user!.username)}`);
    if (b.role === 'specialist' && target.role !== 'specialist') ctx.notify.security(`<b>${escapeHtml(target.username)}</b> reso specialist da ${escapeHtml(req.user!.username)}: vede i suoi dati e quelli dei suoi gruppi di lavoro`);
    if (b.active !== undefined) db.prepare('UPDATE users SET active = ?, token_version = token_version + 1 WHERE id = ?').run(b.active ? 1 : 0, id);
    // another role: the full view is given again, if ever, by an admin (#275)
    if (b.role !== undefined) db.prepare('UPDATE users SET role = ?, full_view = CASE WHEN role = ? THEN full_view ELSE 0 END, token_version = token_version + 1 WHERE id = ?').run(b.role, b.role, id);
    // the work groups are of the specialists: another role leaves them
    if (b.role !== undefined && b.role !== 'specialist') db.prepare('DELETE FROM work_group_members WHERE user_id = ?').run(id);
    if (b.fullView !== undefined) {
      const was = !!(db.prepare('SELECT full_view f FROM users WHERE id = ?').get(id) as { f: number }).f;
      db.prepare('UPDATE users SET full_view = ? WHERE id = ?').run(b.fullView ? 1 : 0, id);
      if (was !== b.fullView) {
        ctx.notify.security(
          b.fullView
            ? `Visibilità piena data allo specialist <b>${escapeHtml(target.username)}</b> da ${escapeHtml(req.user!.username)}: vede interventi, clienti e lavori di tutti`
            : `Visibilità piena tolta allo specialist <b>${escapeHtml(target.username)}</b> da ${escapeHtml(req.user!.username)}: vede solo i suoi dati e quelli dei suoi gruppi`,
        );
      }
    }
    // warehouse and bypass: no new login needed, the app reads them with «Le mie CPE»
    if (b.warehouseSiteId !== undefined) db.prepare('UPDATE users SET warehouse_site_id = ?, warehouse_site = ? WHERE id = ?').run(b.warehouseSiteId, warehouseName(b.warehouseSiteId), id);
    if (b.stockBypass !== undefined) db.prepare('UPDATE users SET stock_bypass = ? WHERE id = ?').run(b.stockBypass ? 1 : 0, id);
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

  /**
   * SSIDs of the customer APs in UISP (relays included, PtP links excluded), split into the ones
   * still without a key here (the list to work on) and the ones already imported.
   */
  async function uispSsids() {
    if (!ctx.uisp) throw new HttpError(503, 'uisp_not_configured');
    const valid = new Map<string, string[]>();
    const skipped = new Map<string, string[]>();
    for (const d of await ctx.uisp.allDevices()) {
      if (!isAp(d) || !d.ssid || isPtp(d)) continue;
      const into = SSID_RX.test(d.ssid) ? valid : skipped;
      into.set(d.ssid, [...(into.get(d.ssid) ?? []), d.name]);
    }
    const stored = new Map(
      (db.prepare('SELECT ssid, wpa2_ciphertext FROM wireless_secrets').all() as Array<{ ssid: string; wpa2_ciphertext: string }>).map((r) => [r.ssid, r.wpa2_ciphertext]),
    );
    const byName = (a: { ssid: string }, b: { ssid: string }) => a.ssid.localeCompare(b.ssid, 'it', { numeric: true });
    const all = [...valid].map(([ssid, aps]) => ({ ssid, aps: aps.sort() })).sort(byName);
    return {
      pending: all.filter((s) => !stored.has(s.ssid)),
      imported: all.filter((s) => stored.has(s.ssid)).map((s) => s.ssid),
      // SSIDs that look like customer APs but are not in the provisioning format (e.g. a district by name)
      skipped: [...skipped].map(([ssid, aps]) => ({ ssid, aps })).sort(byName),
      stored,
    };
  }

  app.get('/api/admin/wireless-networks/uisp', admin, async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { pending, imported, skipped } = await uispSsids();
    return { pending, imported: imported.length, skipped };
  });

  /**
   * The shared WPA2 key on the SSIDs found in UISP and not yet imported (all, or the chosen ones);
   * with scope 'all' it also replaces the key of the UISP networks already imported. Preview with
   * dryRun; the key never reaches the activity log.
   */
  app.post('/api/admin/wireless-networks/uisp-import', admin, async (req) => {
    const b = z
      .object({
        wpa2Password: z.string().min(8).max(63).regex(/^[\x20-\x7e]+$/),
        ssids: z.array(z.string().regex(SSID_RX)).max(10_000).optional(),
        scope: z.enum(['new', 'all']).default('new'),
        dryRun: z.boolean().default(true),
      })
      .strict()
      .parse(req.body);
    const { pending, imported, stored } = await uispSsids();
    const chosen = b.ssids ? new Set(b.ssids) : null;
    const created = pending.map((s) => s.ssid).filter((s) => !chosen || chosen.has(s));
    const updated: string[] = [];
    const unchanged: string[] = [];
    // only replacing keys needs to open the stored ones
    if (b.scope === 'all') {
      for (const ssid of imported) {
        let same = false;
        try {
          same = sealer.open(stored.get(ssid)!) === b.wpa2Password;
        } catch {
          /* unreadable: replaced */
        }
        (same ? unchanged : updated).push(ssid);
      }
    }
    const kept = b.scope === 'all' ? [] : imported;
    if (!b.dryRun && created.length + updated.length > 0) {
      const upsert = db.prepare(
        `INSERT INTO wireless_secrets(ssid, wpa2_ciphertext, updated_at) VALUES(?,?,?)
         ON CONFLICT(ssid) DO UPDATE SET wpa2_ciphertext = excluded.wpa2_ciphertext, updated_at = excluded.updated_at`,
      );
      const now = nowIso();
      db.exec('BEGIN');
      try {
        for (const s of [...created, ...updated]) upsert.run(s, sealer.seal(b.wpa2Password), now);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      recordEvent(db, actor(req), 'wireless.uisp_import', `${created.length + updated.length} SSID da UISP`, `${created.length} nuove, ${updated.length} aggiornate, ${unchanged.length} invariate`);
    }
    return { dryRun: b.dryRun, pending: pending.length, created, updated, unchanged, kept };
  });

  /**
   * The networks with their WPA2 keys in clear, as a CSV the import reads back. Asks again for the
   * admin's own password; the export is logged and announced on the security channel.
   */
  const exportLimiter = createLoginLimiter(5);
  app.post('/api/admin/wireless-networks/export', admin, async (req, reply) => {
    const b = z
      .object({ password: z.string().min(1).max(200), ssids: z.array(z.string().regex(SSID_RX)).max(10_000).optional() })
      .strict()
      .parse(req.body);
    const me = db.prepare('SELECT username, password_hash FROM users WHERE id = ?').get(req.user!.id) as { username: string; password_hash: string };
    if (exportLimiter.blocked(req.ip, me.username)) throw new HttpError(429, 'too_many_attempts');
    if (!verifyPassword(b.password, me.password_hash)) {
      exportLimiter.fail(req.ip, me.username);
      throw new HttpError(403, 'wrong_current_password');
    }
    exportLimiter.clear(req.ip, me.username);
    const chosen = b.ssids ? new Set(b.ssids) : null;
    const rows = (db.prepare('SELECT ssid, wpa2_ciphertext FROM wireless_secrets').all() as Array<{ ssid: string; wpa2_ciphertext: string }>)
      .filter((r) => !chosen || chosen.has(r.ssid))
      .map((r) => ({ ssid: r.ssid, wpa2: sealer.open(r.wpa2_ciphertext) }))
      .sort((a, c) => a.ssid.localeCompare(c.ssid, 'it', { numeric: true }));
    recordEvent(db, actor(req), 'wireless.export', `${rows.length} reti`, 'chiavi WPA2 in chiaro');
    ctx.notify.security(`Chiavi WPA2 di <b>${rows.length}</b> reti Wi-Fi esportate in chiaro da ${escapeHtml(me.username)}`);
    reply
      .header('Cache-Control', 'no-store')
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="reti-wifi-${nowIso().slice(0, 10)}.csv"`);
    return wirelessCsv(rows);
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

  // ---- airOS templates (several named templates per model) ------------------------
  const modelParam = z.object({ model: z.enum(SUPPORTED_MODELS) });
  const idParam = z.object({ id: z.coerce.number().int().positive() });
  const templateName = z.string().trim().min(1).max(60).regex(/^[\p{L}\p{N} ._()+\/'&,·-]+$/u, 'Caratteri non ammessi nel nome');
  const templateText = z.string().min(64).max(300_000);
  const boardMatch = z.string().trim().min(2).max(240);
  // Visibility: 'all' installers, or only the listed users (personal templates).
  const visibility = {
    audience: z.enum(['all', 'users']).optional(),
    userIds: z.array(z.number().int().positive()).max(1000).optional(),
    defaultForAssigned: z.boolean().optional(),
  };
  // the template's own values forced at every provisioning, and its secrets (write-only)
  const paramsSchema = z.object({ watchdogHost: z.string().trim().max(253).optional(), snmpContact: z.string().trim().max(200).optional() }).strict();
  const secretSchema = z.string().max(4096).nullable().optional();
  const ownValues = {
    params: paramsSchema.optional(),
    secrets: z.object({ snmpCommunity: secretSchema, uispKey: secretSchema }).strict().optional(),
  };
  const formError = (e: unknown): never => {
    const m = (e as Error).message;
    throw /^form_/.test(m) ? new HttpError(400, m) : e;
  };
  /** The form of a text (with its report and the network rules it breaks). */
  const formOf = (model: (typeof SUPPORTED_MODELS)[number], template: string, params: { watchdogHost: string; snmpContact: string }) => {
    const { values, missing } = readForm(template, params, model);
    return { template, params, values, missing, warnings: policyWarnings(values), facts: templateFacts(template), report: inspectTemplate(template) };
  };

  app.get('/api/admin/profiles', staff, async () => {
    const all = ctx.templates.list();
    return SUPPORTED_MODELS.map((model) => ({ model, firmware: TARGET_FIRMWARE, templates: all.filter((t) => t.model === model) }));
  });

  app.get('/api/admin/placeholders', staff, async () => Object.entries(PLACEHOLDERS).map(([name, description]) => ({ name, description })));

  /** The fields of the template form (like the CPE's web interface), with each model's defaults. */
  app.get('/api/admin/template-form', staff, async () => ({ fields: formFieldsView() }));

  /** The form of a template text; without a text, the one of a new template made from the form alone. */
  app.post('/api/admin/profiles/:model/form/read', staff, async (req) => {
    const { model } = modelParam.parse(req.params);
    const b = z.object({ template: templateText.optional(), params: paramsSchema.optional() }).strict().parse(req.body ?? {});
    return formOf(model, b.template ?? skeletonFor(model), { ...DEFAULT_PARAMS, ...b.params });
  });

  /** The form's changes written into the text (only what changed): nothing is stored here. */
  app.post('/api/admin/profiles/:model/form/apply', staff, async (req) => {
    const { model } = modelParam.parse(req.params);
    const b = z
      .object({ template: templateText, params: paramsSchema.optional(), changes: z.record(z.string().max(40), z.union([z.string().max(300), z.number(), z.boolean()])) })
      .strict()
      .parse(req.body);
    let out: ReturnType<typeof applyForm>;
    try {
      out = applyForm(b.template, { ...DEFAULT_PARAMS, ...b.params }, model, b.changes);
    } catch (e) {
      return formError(e);
    }
    return formOf(model, out.text, out.params);
  });

  /** Raw CPE backup -> template with placeholders + preview. Nothing is stored here. */
  app.post('/api/admin/profiles/:model/autotemplate', staff, async (req) => {
    const { model } = modelParam.parse(req.params);
    const b = z.object({ backup: templateText }).strict().parse(req.body);
    const result = autoTemplate(b.backup);
    return { ...result, report: inspectTemplate(result.template), suggestedBoardMatch: BOARD_MATCH_SUGGESTIONS[model] };
  });

  app.post('/api/admin/profiles/:model/inspect', staff, async (req) => {
    modelParam.parse(req.params);
    const b = z.object({ template: templateText, boardMatch: boardMatch.optional() }).strict().parse(req.body);
    if (b.boardMatch) validateBoardMatch(b.boardMatch);
    return inspectTemplate(b.template);
  });

  app.post('/api/admin/profiles/:model/templates', admin, async (req, reply) => {
    const { model } = modelParam.parse(req.params);
    const b = z
      .object({ name: templateName, template: templateText, boardMatch, isDefault: z.boolean().optional(), ...visibility, ...ownValues, secretsFrom: z.number().int().positive().optional() })
      .strict()
      .parse(req.body);
    const t = ctx.templates.create(model, b, actor(req));
    recordEvent(db, actor(req), 'template.create', `${model} · ${t.name}`, t.sha256);
    return reply.code(201).send(t);
  });

  app.get('/api/admin/templates/:id', staff, async (req) => ctx.templates.get(idParam.parse(req.params).id));

  app.patch('/api/admin/templates/:id', admin, async (req) => {
    const { id } = idParam.parse(req.params);
    const b = z
      .object({ name: templateName.optional(), template: templateText.optional(), boardMatch: boardMatch.optional(), isDefault: z.literal(true).optional(), ...visibility, ...ownValues })
      .strict()
      .refine((x) => Object.keys(x).length > 0, 'empty')
      .parse(req.body);
    const t = ctx.templates.update(id, b, actor(req));
    // the keys changed, never the values (the secrets least of all)
    recordEvent(db, actor(req), b.template ? 'template.edit' : 'template.update', `${t.model} · ${t.name}`, Object.keys(b).join(','));
    return t;
  });

  app.delete('/api/admin/templates/:id', admin, async (req) => {
    const t = ctx.templates.remove(idParam.parse(req.params).id);
    recordEvent(db, actor(req), 'template.delete', `${t.model} · ${t.name}`);
    return { ok: true };
  });

  // ---- Status / settings --------------------------------------------------------
  app.get('/api/admin/status', staff, async () => {
    const c = ctx.cfg;
    const count = (sql: string, ...params: string[]) => (db.prepare(sql).get(...params) as { n: number }).n;
    const since30d = new Date(Date.now() - 30 * 86400_000).toISOString();
    const release = loadLatestRelease(c.releases.dir);
    return {
      version: ctx.version,
      runtimeSecrets: {
        cpeAdminPassword: !!c.cpeSecrets.adminPassword,
      },
      policy: {
        cpeAdminUsername: c.cpeSecrets.adminUsername,
        factoryIp: c.network.factoryIp,
        jobTtlMinutes: c.jobTtlMinutes,
        minAndroidVersion: c.minAndroidVersion,
        auditRetentionDays: c.auditRetentionDays,
      },
      // what needs the office today (the dashboard's first row)
      today: (() => {
        const day = todayRome();
        return {
          day,
          workOrders: count("SELECT count(*) n FROM work_orders WHERE day = ? AND status <> 'cancelled'", day),
          workOrdersDone: count("SELECT count(*) n FROM work_orders WHERE day = ? AND status = 'done'", day),
          workOrdersLate: count("SELECT count(*) n FROM work_orders WHERE day < ? AND status IN ('open','postponed')", day),
          nocPending: count("SELECT count(*) n FROM job_acceptance WHERE review = 'pending'"),
          koOpen: count('SELECT count(*) n FROM install_ko WHERE resolved_at IS NULL'),
          jobs24h: count('SELECT count(*) n FROM provisioning_jobs WHERE created_at > ?', new Date(Date.now() - 86400_000).toISOString()),
        };
      })(),
      counts: {
        users: count('SELECT count(*) n FROM users WHERE active = 1'),
        wirelessNetworks: count('SELECT count(*) n FROM wireless_secrets'),
        profiles: count('SELECT count(DISTINCT model) n FROM profile_templates WHERE firmware = ?', TARGET_FIRMWARE),
        templates: count('SELECT count(*) n FROM profile_templates WHERE firmware = ?', TARGET_FIRMWARE),
        jobs30d: count('SELECT count(*) n FROM provisioning_jobs WHERE created_at > ?', since30d),
        success30d: count("SELECT count(*) n FROM provisioning_jobs WHERE status = 'success' AND created_at > ?", since30d),
      },
      androidRelease: release
        ? { versionName: release.versionName, versionCode: release.versionCode, sha256: release.sha256, mandatory: release.mandatory }
        : null,
      androidReleaseSync: c.releases.githubRepo ? { repo: c.releases.githubRepo, everyMinutes: c.releases.syncMinutes } : null,
    };
  });

  app.get('/api/admin/events', staff, async (req) => {
    const limit = z.coerce.number().int().min(1).max(500).default(200).parse((req.query as { limit?: string }).limit);
    return db
      .prepare(
        `SELECT e.id, e.created_at createdAt, u.username, e.action, e.target, e.detail
         FROM events e LEFT JOIN users u ON u.id = e.user_id ORDER BY e.id DESC LIMIT ?`,
      )
      .all(limit);
  });
}
