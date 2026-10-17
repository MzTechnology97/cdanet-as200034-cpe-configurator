import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { nowIso, recordEvent } from '../db.ts';
import { distanceM, isValidLatLon } from '../domain/geo.ts';
import { checkName, coverageQuery, NAME_MAX, summaryOf, type CheckKind, type CoverageParams } from '../domain/saved-checks.ts';
import { feasibilityLogo, feasibilityPdf, pdfFileName, type FeasibilityAnswer } from './feasibility.ts';

/**
 * Saved coverage and feasibility checks (module «coverage»). A check is saved with a name: the one
 * written, or the customer's of ISP Billing (admins only: installers never browse the customers).
 * The server runs the check again when it is saved, with the rights of whoever saves it, and keeps
 * the answer as it was (a coverage check with the other operators of the point, as Copertura shows
 * them), so the list shows what was said then and «Apri» checks the same point again the same way.
 * Everyone sees their own, admins every one; the Fattibilità page is for admins only.
 */

interface Row {
  id: number;
  kind: CheckKind;
  user_id: number | null;
  username: string;
  name: string;
  customer_id: string | null;
  customer_name: string;
  customer_code: string;
  lat: number;
  lon: number;
  label: string;
  params: string;
  summary: string;
  result?: string;
  created_at: string;
  updated_at: string;
}

const LIST_COLUMNS = 'id, kind, user_id, username, name, customer_id, customer_name, customer_code, lat, lon, label, params, summary, created_at, updated_at';

const parse = (s: string | undefined, fallback: unknown) => {
  try {
    return s ? (JSON.parse(s) as unknown) : fallback;
  } catch {
    return fallback;
  }
};

const view = (r: Row, me: number) => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  customer: r.customer_id ? { id: r.customer_id, name: r.customer_name, code: r.customer_code } : null,
  point: { lat: r.lat, lon: r.lon, label: r.label },
  params: parse(r.params, {}),
  summary: parse(r.summary, null),
  by: r.username,
  mine: r.user_id === me,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  ...(r.result !== undefined ? { result: parse(r.result, null) } : {}),
});

/** One customer of ISP Billing as the copy of the RADIUS sync has it: the name of its contract. */
export interface CrmCustomer {
  customerId: string;
  name: string;
  code: string;
  address: string;
  distanceM: number | null;
}

const KINDS = ['coverage', 'feasibility'] as const;
const COVERAGE_PARAMS = z
  .object({
    cpe: z.string().max(40).optional(),
    height: z.number().min(0).max(100).optional(),
    km: z.number().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .default({});

export function savedCheckRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;
  const user = { preHandler: [ctx.auth.requireUser, ctx.modules.require('coverage')] };
  const admin = { preHandler: [ctx.auth.requireAdmin, ctx.modules.require('coverage')] };
  const isAdmin = (req: FastifyRequest) => req.user!.role === 'admin';
  /** Feasibility is a check for sales: admins only, as its page. */
  const allowKind = (req: FastifyRequest, kind: CheckKind) => {
    if (kind === 'feasibility' && !isAdmin(req)) throw new HttpError(403, 'forbidden');
  };
  /** A saved check of this user (any for admins); another's does not exist for an installer. */
  const find = (req: FastifyRequest, withResult = false): Row => {
    const id = z.coerce.number().int().min(1).parse((req.params as { id: string }).id);
    const r = db.prepare(`SELECT ${LIST_COLUMNS}${withResult ? ', result' : ''} FROM saved_checks WHERE id = ?`).get(id) as unknown as Row | undefined;
    if (!r || (!isAdmin(req) && r.user_id !== req.user!.id)) throw new HttpError(404, 'saved_check_not_found');
    allowKind(req, r.kind);
    return r;
  };

  // ---- customers of ISP Billing (admins): by name, code, address or PPPoE user, and near a point --
  const addressText = (r: Record<string, unknown>) => {
    const v = (k: string) => (typeof r[k] === 'string' ? (r[k] as string).trim() : '');
    return [[v('address_line1'), v('address_line2')].filter(Boolean).join(' '), [v('postal_code'), v('city'), v('state_code') ? `(${v('state_code')})` : ''].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  };
  /** The customer as a saved check names it: «COGNOME NOME» of its contract, else its name in the CRM. */
  const customer = (id: string, distance: number | null = null, site: Record<string, unknown> | null = null): CrmCustomer | null => {
    const c = db.prepare('SELECT * FROM crm_customers WHERE customer_id = ?').get(id) as Record<string, unknown> | undefined;
    if (!c) return null;
    const formal = db.prepare("SELECT customer_formal f FROM crm_radius WHERE customer_id = ? AND customer_formal <> '' AND account_status <> 'Terminato' LIMIT 1").get(id) as { f: string } | undefined;
    return {
      customerId: id,
      name: (formal?.f || String(c.name ?? '')).replace(/\s+/g, ' ').trim().slice(0, NAME_MAX),
      code: String(c.internal_code ?? ''),
      address: (site && addressText(site)) || addressText(c),
      distanceM: distance,
    };
  };
  /** The customers with a site within [radiusM] of the point, the nearest first. */
  function customersNear(lat: number, lon: number, radiusM = 300, max = 5): CrmCustomer[] {
    const dLat = radiusM / 111_000 + 0.0005;
    const dLon = dLat / Math.max(0.2, Math.cos((lat * Math.PI) / 180));
    const sites = db
      .prepare('SELECT * FROM crm_addresses WHERE lat IS NOT NULL AND lng IS NOT NULL AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?')
      .all(lat - dLat, lat + dLat, lon - dLon, lon + dLon) as unknown as Array<Record<string, unknown> & { customer_id: string; lat: number; lng: number }>;
    const best = new Map<string, { d: number; site: Record<string, unknown> }>();
    for (const s of sites) {
      const d = Math.round(distanceM({ lat, lon }, { lat: s.lat, lon: s.lng }));
      if (d > radiusM) continue;
      const prev = best.get(s.customer_id);
      if (!prev || d < prev.d) best.set(s.customer_id, { d, site: s });
    }
    return [...best.entries()]
      .sort((a, b) => a[1].d - b[1].d)
      .slice(0, max)
      .map(([id, x]) => customer(id, x.d, x.site))
      .filter((c): c is CrmCustomer => c !== null);
  }
  function customersMatching(q: string, max = 12): CrmCustomer[] {
    // % and _ typed are letters ('!' escapes them)
    const like = `%${q.replace(/[!%_]/g, (c) => `!${c}`)}%`;
    const cols = ['c.name', 'c.internal_code', 'c.address_line1', 'c.city', 'r.username', 'r.customer_formal'];
    const ids = db
      .prepare(`SELECT DISTINCT c.customer_id id FROM crm_customers c LEFT JOIN crm_radius r ON r.customer_id = c.customer_id WHERE ${cols.map((c) => `${c} LIKE ? ESCAPE '!'`).join(' OR ')} LIMIT ?`)
      .all(...cols.map(() => like), max) as Array<{ id: string }>;
    return ids.map(({ id }) => customer(id)).filter((c): c is CrmCustomer => c !== null);
  }

  app.get('/api/admin/saved-checks/customers', admin, async (req) => {
    const p = z.object({ q: z.string().trim().max(80).default(''), lat: z.coerce.number().optional(), lon: z.coerce.number().optional() }).parse(req.query);
    const near = p.lat !== undefined && p.lon !== undefined && isValidLatLon(p.lat, p.lon) ? customersNear(p.lat, p.lon) : [];
    const found = p.q.length >= 2 ? customersMatching(p.q) : [];
    const seen = new Set(near.map((c) => c.customerId));
    return { configured: ctx.crm.client() !== null, near, found: found.filter((c) => !seen.has(c.customerId)) };
  });

  // ---- the saved checks -------------------------------------------------------------------------
  app.get('/api/saved-checks', user, async (req) => {
    const q = z
      .object({
        kind: z.enum(KINDS).default('coverage'),
        mine: z.enum(['0', '1', 'true', 'false']).optional(),
        q: z.string().trim().max(80).default(''),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(req.query);
    allowKind(req, q.kind);
    const where = ['kind = ?'];
    const args: Array<string | number> = [q.kind];
    // installers only their own; admins every one, or their own when asked
    if (!isAdmin(req) || q.mine === '1' || q.mine === 'true') {
      where.push('user_id = ?');
      args.push(req.user!.id);
    }
    if (q.q) {
      const like = `%${q.q.replace(/[!%_]/g, (c) => `!${c}`)}%`;
      where.push("(name LIKE ? ESCAPE '!' OR label LIKE ? ESCAPE '!' OR customer_name LIKE ? ESCAPE '!' OR customer_code LIKE ? ESCAPE '!')");
      args.push(like, like, like, like);
    }
    const total = (db.prepare(`SELECT count(*) n FROM saved_checks WHERE ${where.join(' AND ')}`).get(...args) as { n: number }).n;
    const rows = db.prepare(`SELECT ${LIST_COLUMNS} FROM saved_checks WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT ?`).all(...args, q.limit) as unknown as Row[];
    return { total, items: rows.map((r) => view(r, req.user!.id)) };
  });

  app.get('/api/saved-checks/:id', user, async (req) => view(find(req, true), req.user!.id));

  app.post('/api/saved-checks', user, async (req) => {
    const b = z
      .object({
        kind: z.enum(KINDS),
        name: z.string().max(400).optional(),
        customerId: z.string().trim().min(1).max(20).nullable().optional(),
        lat: z.number(),
        lon: z.number(),
        label: z.string().trim().max(200).default(''),
        params: COVERAGE_PARAMS,
      })
      .parse(req.body);
    allowKind(req, b.kind);
    if (!isValidLatLon(b.lat, b.lon)) throw new HttpError(400, 'invalid_position');
    // a customer of ISP Billing: admins only (installers write the name)
    let who: CrmCustomer | null = null;
    if (b.customerId) {
      if (!isAdmin(req)) throw new HttpError(403, 'forbidden');
      who = customer(b.customerId);
      if (!who) throw new HttpError(404, 'customer_not_found');
    }
    // the check again, here, with the rights of whoever saves it: the answer kept is the server's
    const params: CoverageParams = b.kind === 'coverage' ? b.params : {};
    const headers = { authorization: String(req.headers.authorization ?? '') };
    const url = b.kind === 'coverage' ? `/api/coverage?${coverageQuery(b.lat, b.lon, params)}` : `/api/admin/feasibility?${new URLSearchParams({ lat: String(b.lat), lon: String(b.lon), label: b.label })}`;
    const r = await app.inject({ method: 'GET', url, headers });
    if (r.statusCode !== 200) {
      const code = (parse(r.body, {}) as { error?: string }).error ?? 'check_failed';
      throw new HttpError(r.statusCode >= 500 ? (r.statusCode === 503 ? 503 : 502) : r.statusCode, code);
    }
    const result = r.json() as Record<string, unknown>;
    // a coverage check keeps the other operators too, as Copertura shows them to whoever saves it
    // (installers without the operators' names): for an installer it is the whole feasibility
    if (b.kind === 'coverage') {
      const o = await app.inject({ method: 'GET', url: `${isAdmin(req) ? '/api/admin' : '/api/field'}/coverage/operators?lat=${b.lat}&lon=${b.lon}`, headers });
      result.operators = o.statusCode === 200 ? (o.json() as unknown) : null;
      result.operatorsError = o.statusCode === 200 ? null : ((parse(o.body, {}) as { error?: string }).error ?? 'operators_error');
    }
    const label = b.label || (b.kind === 'feasibility' && typeof result.address === 'string' ? result.address : '');
    const name = checkName({ name: b.name, customerName: who?.name, label, lat: b.lat, lon: b.lon });
    const now = nowIso();
    const ins = db
      .prepare(
        `INSERT INTO saved_checks(kind, user_id, username, name, customer_id, customer_name, customer_code, lat, lon, label, params, summary, result, created_at, updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(b.kind, req.user!.id, req.user!.username, name, who?.customerId ?? null, who?.name ?? '', who?.code ?? '', b.lat, b.lon, label.slice(0, 200), JSON.stringify(params), JSON.stringify(summaryOf(b.kind, result)), JSON.stringify(result), now, now);
    recordEvent(db, req.user!.id, 'saved_check.create', name, `${b.kind === 'coverage' ? 'copertura' : 'fattibilità'}${who ? ` · cliente ${who.code || who.customerId}` : ''}`);
    return view(db.prepare(`SELECT ${LIST_COLUMNS} FROM saved_checks WHERE id = ?`).get(Number(ins.lastInsertRowid)) as unknown as Row, req.user!.id);
  });

  /** Rename, link to a customer of ISP Billing (admins) or unlink it (customerId null). */
  app.patch('/api/saved-checks/:id', user, async (req) => {
    const row = find(req);
    const b = z.object({ name: z.string().max(400).optional(), customerId: z.string().trim().min(1).max(20).nullable().optional() }).parse(req.body ?? {});
    let who: { customerId: string; name: string; code: string } | null = row.customer_id ? { customerId: row.customer_id, name: row.customer_name, code: row.customer_code } : null;
    if (b.customerId !== undefined) {
      if (b.customerId === null) who = null;
      else {
        if (!isAdmin(req)) throw new HttpError(403, 'forbidden');
        const c = customer(b.customerId);
        if (!c) throw new HttpError(404, 'customer_not_found');
        who = c;
      }
    }
    // a customer chosen without a name: the check takes the customer's
    const name =
      b.name !== undefined || (b.customerId && who)
        ? checkName({ name: b.name ?? (b.customerId ? who?.name : undefined), customerName: who?.name, label: row.label, lat: row.lat, lon: row.lon })
        : row.name;
    db.prepare('UPDATE saved_checks SET name = ?, customer_id = ?, customer_name = ?, customer_code = ?, updated_at = ? WHERE id = ?').run(name, who?.customerId ?? null, who?.name ?? '', who?.code ?? '', nowIso(), row.id);
    if (name !== row.name || (who?.customerId ?? null) !== row.customer_id) recordEvent(db, req.user!.id, 'saved_check.rename', name, `prima: ${row.name}`);
    return view(db.prepare(`SELECT ${LIST_COLUMNS} FROM saved_checks WHERE id = ?`).get(row.id) as unknown as Row, req.user!.id);
  });

  app.delete('/api/saved-checks/:id', user, async (req) => {
    const row = find(req);
    db.prepare('DELETE FROM saved_checks WHERE id = ?').run(row.id);
    recordEvent(db, req.user!.id, 'saved_check.delete', row.name, row.kind === 'coverage' ? 'copertura' : 'fattibilità');
    return { ok: true };
  });

  /** The PDF of a saved feasibility check: the answer as it was, with the customer's name on top. */
  app.get('/api/saved-checks/:id/pdf', user, async (req, reply) => {
    const row = find(req, true);
    if (row.kind !== 'feasibility') throw new HttpError(400, 'not_a_feasibility_check');
    const f = parse(row.result, null) as FeasibilityAnswer | null;
    if (!f?.ours) throw new HttpError(409, 'saved_check_unreadable');
    recordEvent(db, req.user!.id, 'feasibility.pdf', row.name, `verifica salvata ${row.id}`);
    reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `attachment; filename="${pdfFileName(row.name, f.at || row.created_at)}"`);
    return reply.send(feasibilityPdf(f, feasibilityLogo(ctx.cfg.staticDir), { name: row.name, code: row.customer_code || undefined }));
  });
}
