import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { recordEvent } from '../db.ts';
import { parseMac } from '../domain/policy.ts';

/** Fewer CPEs than this in an installer's warehouse: the NOC is told to restock them. */
export const LOW_STOCK = 2;

/**
 * Warehouse: the NOC sees the stock by warehouse and model, the CPEs to unload and who is short of
 * CPEs; an installer or partner sees the CPEs in their own warehouse (never the data source).
 */
export function warehouseRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;
  const admin = { preHandler: [ctx.auth.requireAdmin] };
  const user = { preHandler: [ctx.auth.requireUser] };
  const w = () => ctx.warehouse;

  app.get('/api/admin/warehouse/sites', admin, async () => ({ ...w().state(), sites: w().sites() }));

  app.post('/api/admin/warehouse/refresh', admin, async (req) => {
    const r = await w().sync();
    recordEvent(db, req.user!.id, 'warehouse.refresh', 'magazzino', r.ok ? `${r.items} giacenze` : `errore ${r.error}`);
    return { ...r, ...w().state() };
  });

  app.get('/api/admin/warehouse/overview', admin, async () => {
    const accounts = db
      .prepare("SELECT id, username, warehouse_site_id siteId, warehouse_site site FROM users WHERE active = 1 AND warehouse_site_id IS NOT NULL ORDER BY username")
      .all() as Array<{ id: number; username: string; siteId: number; site: string }>;
    const lowStock = accounts
      .map((a) => ({ userId: a.id, username: a.username, site: a.site, cpe: w().cpesOf(a.siteId).length }))
      .filter((a) => a.cpe < LOW_STOCK);
    return { ...w().state(), byModel: w().byModel(), lowStock, lowStockBelow: LOW_STOCK, toUnload: w().toUnload() };
  });

  /** Audit of the CPE movements (warehouses of ISP Billing, installations, acceptance tests). */
  app.get('/api/admin/warehouse/movements', admin, async (req) => {
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
  const bypass = !u || u.role === 'admin' || !!u.bypass;
  const done = (result: StockCheck['result']) => ({ result, bypass, allowed: result === 'ok' || result === 'not_linked' || result === 'not_loaded' || bypass });
  if (!u || u.siteId === null) return done('not_linked');
  if (!ctx.warehouse.loaded()) return done('not_loaded');
  const at = ctx.warehouse.whereIs(mac);
  if (!at) return done('not_in_stock');
  return done(at.siteId === u.siteId ? 'ok' : 'other_warehouse');
}
