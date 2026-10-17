import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, isStaff } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { recordEvent } from '../db.ts';
import { parseMac } from '../domain/policy.ts';

/** The states of a CPE taken off in a replacement, and what the installer says of it. */
export const RMA_STATES = ['to_return', 'returned', 'repair', 'scrapped', 'reused'] as const;
export const RMA_CONDITIONS = ['unknown', 'working', 'broken'] as const;

/**
 * Warehouse: the NOC sees the stock by warehouse and model, the CPEs to unload and who is short of
 * CPEs; an installer or partner sees the CPEs in their own warehouse (never the data source).
 */
export function warehouseRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;
  const admin = { preHandler: [ctx.auth.requireAdmin] };
  // the specialist sees the warehouse (his CPEs come from other companies: he never uses it)
  const staff = { preHandler: [ctx.auth.requireStaff] };
  const user = { preHandler: [ctx.auth.requireUser] };
  const w = () => ctx.warehouse;

  app.get('/api/admin/warehouse/sites', staff, async () => ({ ...w().state(), sites: w().sites() }));

  app.post('/api/admin/warehouse/refresh', admin, async (req) => {
    const r = await w().sync();
    recordEvent(db, req.user!.id, 'warehouse.refresh', 'magazzino', r.ok ? `${r.items} giacenze` : `errore ${r.error}`);
    return { ...r, ...w().state() };
  });

  /** The accounts with a warehouse under their minimum (their own, else the one of Impostazioni server). */
  const lowStock = () =>
    (
      db
        .prepare("SELECT id, username, warehouse_site_id siteId, warehouse_site site, warehouse_min_stock min FROM users WHERE active = 1 AND warehouse_site_id IS NOT NULL ORDER BY username")
        .all() as Array<{ id: number; username: string; siteId: number; site: string; min: number | null }>
    )
      .map((a) => ({ userId: a.id, username: a.username, site: a.site, cpe: w().cpesOf(a.siteId).length, min: a.min ?? ctx.cfg.warehouseMinStock }))
      .filter((a) => a.min > 0 && a.cpe < a.min);

  app.get('/api/admin/warehouse/overview', staff, async () => ({ ...w().state(), byModel: w().byModel(), lowStock: lowStock(), lowStockBelow: ctx.cfg.warehouseMinStock, toUnload: w().toUnload() }));

  /** An account's own minimum (null: the one of Impostazioni server). */
  app.put('/api/admin/users/:id/min-stock', admin, async (req) => {
    const id = z.coerce.number().int().positive().parse((req.params as { id: string }).id);
    const { min } = z.object({ min: z.number().int().min(0).max(50).nullable() }).strict().parse(req.body);
    const u = db.prepare('SELECT username FROM users WHERE id = ?').get(id) as { username: string } | undefined;
    if (!u) throw new HttpError(404, 'user_not_found');
    db.prepare('UPDATE users SET warehouse_min_stock = ? WHERE id = ?').run(min, id);
    recordEvent(db, req.user!.id, 'warehouse.min_stock', u.username, min === null ? `minimo predefinito (${ctx.cfg.warehouseMinStock})` : `minimo ${min} CPE`);
    return { ok: true, min, defaultMin: ctx.cfg.warehouseMinStock };
  });

  /** The NOC hears once when an installer's warehouse goes under its minimum (again only after a restock). */
  const checkLowStock = () => {
    if (!w().state().at) return;
    const low = lowStock();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'warehouse.low.notified'").get() as { value: string } | undefined;
    const before = new Set<number>(row ? (JSON.parse(row.value) as number[]) : []);
    const fresh = low.filter((a) => !before.has(a.userId));
    db.prepare("INSERT INTO settings(key, value, updated_at) VALUES('warehouse.low.notified', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(
      JSON.stringify(low.map((a) => a.userId)),
      new Date().toISOString(),
    );
    if (fresh.length && row)
      ctx.notify.inbox.push('noc', {
        kind: 'stock_low',
        title: `📦 ${fresh.length === 1 ? `Magazzino di ${fresh[0]!.username} da rifornire` : `${fresh.length} magazzini da rifornire`}`,
        lines: fresh.map((a) => `${a.username}: ${a.cpe} ${a.cpe === 1 ? 'CPE' : 'CPE'} (minimo ${a.min})`),
      });
  };
  const timer = setInterval(() => {
    try {
      checkLowStock();
    } catch (e) {
      app.log.warn(`magazzino: ${(e as Error).message}`);
    }
  }, 15 * 60_000);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));

  // ---- RMA: the CPEs taken off in a replacement --------------------------------------------
  const RMA_SELECT = `SELECT r.id, r.created_at createdAt, r.removed_job_id removedJobId, r.replaced_by_job_id replacedByJobId, r.mac, r.model, r.customer,
      r.condition, r.state, r.note, r.updated_at updatedAt, u.username removedBy, x.username updatedBy
    FROM cpe_rma r LEFT JOIN users u ON u.id = r.removed_by LEFT JOIN users x ON x.id = r.updated_by`;

  app.get('/api/admin/rma', staff, async (req) => {
    const { state } = z.object({ state: z.enum(['open', 'all', ...RMA_STATES]).default('open') }).parse(req.query);
    const where = state === 'all' ? '' : state === 'open' ? "WHERE r.state IN ('to_return','repair')" : 'WHERE r.state = ?';
    const items = db.prepare(`${RMA_SELECT} ${where} ORDER BY r.created_at DESC LIMIT 1000`).all(...(state === 'all' || state === 'open' ? [] : [state]));
    const counts = Object.fromEntries((db.prepare('SELECT state, count(*) n FROM cpe_rma GROUP BY state').all() as Array<{ state: string; n: number }>).map((r) => [r.state, r.n]));
    return { items, counts };
  });

  app.put('/api/admin/rma/:id', admin, async (req) => {
    const id = z.coerce.number().int().positive().parse((req.params as { id: string }).id);
    const b = z.object({ state: z.enum(RMA_STATES).optional(), condition: z.enum(RMA_CONDITIONS).optional(), note: z.string().trim().max(500).optional() }).strict().parse(req.body);
    const cur = db.prepare('SELECT mac, state FROM cpe_rma WHERE id = ?').get(id) as { mac: string; state: string } | undefined;
    if (!cur) throw new HttpError(404, 'rma_not_found');
    db.prepare('UPDATE cpe_rma SET state = COALESCE(?, state), condition = COALESCE(?, condition), note = COALESCE(?, note), updated_at = ?, updated_by = ? WHERE id = ?').run(
      b.state ?? null,
      b.condition ?? null,
      b.note ?? null,
      new Date().toISOString(),
      req.user!.id,
      id,
    );
    recordEvent(db, req.user!.id, 'rma.update', cur.mac, [b.state && b.state !== cur.state ? `${cur.state} → ${b.state}` : null, b.condition ? `stato della CPE: ${b.condition}` : null, b.note ? 'nota' : null].filter(Boolean).join(' · '));
    return db.prepare(`${RMA_SELECT} WHERE r.id = ?`).get(id);
  });

  /** The installer: the CPEs they took off and still have to bring back. */
  app.get('/api/field/rma', user, async (req) => ({
    items: db.prepare(`${RMA_SELECT} WHERE r.removed_by = ? AND r.state = 'to_return' ORDER BY r.created_at DESC`).all(req.user!.id),
  }));

  /** The installer of the replacement says how the CPE taken off is (working / broken) and a note. */
  app.post('/api/field/rma', user, async (req) => {
    const b = z.object({ jobId: z.string().uuid(), condition: z.enum(RMA_CONDITIONS), note: z.string().trim().max(500).default('') }).strict().parse(req.body);
    const r = db.prepare('SELECT r.id, r.mac, j.user_id owner FROM cpe_rma r JOIN provisioning_jobs j ON j.id = r.replaced_by_job_id WHERE r.replaced_by_job_id = ?').get(b.jobId) as
      | { id: number; mac: string; owner: number }
      | undefined;
    if (!r) throw new HttpError(404, 'rma_not_found');
    if (!isStaff(req.user!.role) && r.owner !== req.user!.id) throw new HttpError(403, 'forbidden');
    db.prepare('UPDATE cpe_rma SET condition = ?, note = ?, updated_at = ?, updated_by = ? WHERE id = ?').run(b.condition, b.note, new Date().toISOString(), req.user!.id, r.id);
    recordEvent(db, req.user!.id, 'rma.condition', r.mac, `${b.condition}${b.note ? ` · ${b.note}` : ''}`);
    return { ok: true, id: r.id };
  });

  /** Audit of the CPE movements (warehouses of ISP Billing, installations, acceptance tests). */
  app.get('/api/admin/warehouse/movements', staff, async (req) => {
    const q = z.object({ mac: z.string().max(40).optional(), site: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(2000).default(300) }).parse(req.query);
    const mac = q.mac ? parseMac(q.mac) : undefined;
    if (q.mac && !mac) throw new HttpError(400, 'invalid_mac');
    return { items: w().movements({ mac: mac ?? undefined, site: q.site, limit: q.limit }) };
  });

  /** The CPEs of the user's own warehouse, to pick from at step 1 and to check offline. */
  app.get('/api/warehouse/mine', user, async (req, reply) => {
    const u = db.prepare('SELECT warehouse_site_id siteId, warehouse_site site, stock_bypass bypass FROM users WHERE id = ?').get(req.user!.id) as
      | { siteId: number | null; site: string; bypass: number }
      | undefined;
    reply.header('Cache-Control', 'no-store');
    if (!u || u.siteId === null) return { linked: false, site: '', bypass: true, syncedAt: w().state().at, items: [] };
    const items = w()
      .cpesOf(u.siteId)
      .map((x) => ({ model: x.model, article: x.article, mac: x.mac, serial: x.serial, status: x.status, since: x.since }));
    return { linked: true, site: u.site, bypass: !!u.bypass, syncedAt: w().state().at, items };
  });

  /** Is this CPE in the user's warehouse? (online check before writing; offline the app uses «mine») */
  app.get('/api/warehouse/check', user, async (req) => {
    const mac = parseMac(z.object({ mac: z.string().max(40) }).parse(req.query).mac);
    if (!mac) throw new HttpError(400, 'invalid_mac');
    return stockCheck(ctx, req.user!.id, mac);
  });
}

export type StockCheck = { result: 'ok' | 'not_linked' | 'not_loaded' | 'other_warehouse' | 'not_in_stock'; bypass: boolean };

/**
 * Whether a user may install the CPE with [mac]: fine when it is in their warehouse, when their
 * account has no warehouse, or before the stock has been read once. Otherwise only with the
 * account's bypass. Admins are never stopped.
 */
export function stockCheck(ctx: AppContext, userId: number, mac: string): StockCheck & { allowed: boolean } {
  const u = ctx.db.prepare('SELECT role, warehouse_site_id siteId, stock_bypass bypass FROM users WHERE id = ?').get(userId) as
    | { role: string; siteId: number | null; bypass: number }
    | undefined;
  const bypass = !u || isStaff(u.role) || !!u.bypass;
  const done = (result: StockCheck['result']) => ({ result, bypass, allowed: result === 'ok' || result === 'not_linked' || result === 'not_loaded' || bypass });
  if (!u || u.siteId === null) return done('not_linked');
  if (!ctx.warehouse.loaded()) return done('not_loaded');
  const at = ctx.warehouse.whereIs(mac);
  if (!at) return done('not_in_stock');
  return done(at.siteId === u.siteId ? 'ok' : 'other_warehouse');
}
