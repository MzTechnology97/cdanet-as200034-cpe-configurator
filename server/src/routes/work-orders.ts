import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { nowIso, recordEvent } from '../db.ts';
import { isValidLatLon } from '../domain/geo.ts';

const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const KINDS = ['new', 'repoint', 'repair', 'survey'] as const;
export const WORK_ORDER_KIND_LABEL: Record<(typeof KINDS)[number], string> = {
  new: 'Nuova installazione',
  repoint: 'Ripuntamento / cambio AP',
  repair: 'Guasto',
  survey: 'Sopralluogo',
};

/** Today in Italy (the office plans by local day). */
export function todayRome(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

interface Row {
  id: number;
  createdAt: string;
  updatedAt: string;
  assignedTo: number | null;
  assignee: string | null;
  day: string;
  slot: string;
  kind: (typeof KINDS)[number];
  customer: string;
  address: string;
  lat: number | null;
  lon: number | null;
  contact: string;
  pppoeUser: string;
  ciphertext: string;
  model: string;
  notes: string;
  status: string;
  statusNote: string;
  jobId: string | null;
  doneAt: string | null;
}

const SELECT = `SELECT w.id, w.created_at createdAt, w.updated_at updatedAt, w.assigned_to assignedTo, u.username assignee, w.day, w.slot, w.kind,
  w.customer, w.address, w.lat, w.lon, w.contact, w.pppoe_user pppoeUser, w.pppoe_ciphertext ciphertext, w.model, w.notes, w.status,
  w.status_note statusNote, w.job_id jobId, w.done_at doneAt
  FROM work_orders w LEFT JOIN users u ON u.id = w.assigned_to`;

/** What leaves the server: never the password, only whether the office set it. */
const view = (r: Row, today = todayRome()) => {
  const { ciphertext, ...rest } = r;
  return {
    ...rest,
    kindLabel: WORK_ORDER_KIND_LABEL[r.kind],
    hasPassword: ciphertext !== '',
    overdue: (r.status === 'open' || r.status === 'postponed') && r.day < today,
  };
};

/** "Agenda interventi": the office plans, the installer finds them in Oggi (module work_orders). */
export function workOrderRoutes(app: FastifyInstance, ctx: AppContext) {
  const admin = { preHandler: [ctx.auth.requireAdmin, ctx.modules.require('work_orders')] };
  const user = { preHandler: [ctx.auth.requireUser, ctx.modules.require('work_orders')] };
  const { db } = ctx;

  const fields = {
    assignedTo: z.number().int().positive().nullable(),
    day: DAY,
    slot: z.string().trim().max(40),
    kind: z.enum(KINDS),
    customer: z.string().trim().min(2).max(120),
    address: z.string().trim().max(200),
    lat: z.number().nullable(),
    lon: z.number().nullable(),
    contact: z.string().trim().max(120),
    pppoeUser: z.string().trim().max(128),
    /** '' clears it; omitted keeps the stored one. */
    pppoePassword: z.string().max(200),
    model: z.string().trim().max(40),
    notes: z.string().trim().max(1000),
  };
  const createBody = z.object({ ...fields, assignedTo: fields.assignedTo.optional(), slot: fields.slot.default(''), kind: fields.kind.default('new'), address: fields.address.default(''), lat: fields.lat.optional(), lon: fields.lon.optional(), contact: fields.contact.default(''), pppoeUser: fields.pppoeUser.default(''), pppoePassword: fields.pppoePassword.optional(), model: fields.model.default(''), notes: fields.notes.default('') }).strict();
  const patchBody = z.object(fields).partial().extend({ status: z.enum(['open', 'cancelled', 'postponed']).optional() }).strict();

  const installer = (id: number | null | undefined) => {
    if (id == null) return;
    const u = db.prepare('SELECT active FROM users WHERE id = ?').get(id) as { active: number } | undefined;
    if (!u || !u.active) throw new HttpError(400, 'user_not_found');
  };
  const position = (lat: number | null | undefined, lon: number | null | undefined) => {
    if ((lat == null) !== (lon == null)) throw new HttpError(400, 'invalid_position');
    if (lat != null && lon != null && !isValidLatLon(lat, lon)) throw new HttpError(400, 'invalid_position');
  };
  const get = (id: number) => db.prepare(`${SELECT} WHERE w.id = ?`).get(id) as Row | undefined;

  // ---- office (admins) ------------------------------------------------------------------------
  app.get('/api/admin/work-orders', admin, async (req) => {
    const q = z.object({ from: DAY.optional(), to: DAY.optional(), user: z.coerce.number().int().optional(), status: z.string().optional() }).parse(req.query);
    const from = q.from ?? todayRome();
    const to = q.to ?? from;
    const where = ['w.day BETWEEN ? AND ?'];
    const args: Array<string | number> = [from, to];
    if (q.user) (where.push('w.assigned_to = ?'), args.push(q.user));
    if (q.status) (where.push('w.status = ?'), args.push(q.status));
    // open orders of past days stay on the board until someone closes them
    const rows = db.prepare(`${SELECT} WHERE (${where.join(' AND ')}) OR (w.day < ? AND w.status IN ('open','postponed')${q.user ? ' AND w.assigned_to = ?' : ''}) ORDER BY w.day, w.slot, w.id`).all(...args, from, ...(q.user ? [q.user] : [])) as unknown as Row[];
    return { from, to, items: rows.map((r) => view(r)) };
  });

  app.post('/api/admin/work-orders', admin, async (req, reply) => {
    const b = createBody.parse(req.body);
    installer(b.assignedTo);
    position(b.lat, b.lon);
    const now = nowIso();
    const r = db
      .prepare(
        `INSERT INTO work_orders(created_at, created_by, updated_at, assigned_to, day, slot, kind, customer, address, lat, lon, contact, pppoe_user, pppoe_ciphertext, model, notes)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(now, req.user!.id, now, b.assignedTo ?? null, b.day, b.slot, b.kind, b.customer, b.address, b.lat ?? null, b.lon ?? null, b.contact, b.pppoeUser, b.pppoePassword ? ctx.sealer.seal(b.pppoePassword) : '', b.model, b.notes);
    const id = Number(r.lastInsertRowid);
    recordEvent(db, req.user!.id, 'work_order.create', `#${id}`, `${b.day} ${b.customer}`);
    return reply.code(201).send({ item: view(get(id)!) });
  });

  app.put('/api/admin/work-orders/:id', admin, async (req) => {
    const id = z.coerce.number().int().positive().parse((req.params as { id: string }).id);
    const b = patchBody.parse(req.body);
    const cur = get(id);
    if (!cur) throw new HttpError(404, 'work_order_not_found');
    if (b.assignedTo !== undefined) installer(b.assignedTo);
    position(b.lat !== undefined ? b.lat : cur.lat, b.lon !== undefined ? b.lon : cur.lon);
    const map: Record<string, string> = { assignedTo: 'assigned_to', pppoeUser: 'pppoe_user' };
    const cols: Array<[string, string | number | null]> = [];
    for (const [k, v] of Object.entries(b)) {
      if (v === undefined || k === 'pppoePassword') continue;
      cols.push([map[k] ?? k, v as string | number | null]);
    }
    if (b.pppoePassword !== undefined) cols.push(['pppoe_ciphertext', b.pppoePassword ? ctx.sealer.seal(b.pppoePassword) : '']);
    cols.push(['updated_at', nowIso()]);
    db.prepare(`UPDATE work_orders SET ${cols.map(([c]) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map(([, v]) => v), id);
    recordEvent(db, req.user!.id, 'work_order.update', `#${id}`, cols.map(([c]) => (c === 'pppoe_ciphertext' ? 'password' : c)).filter((c) => c !== 'updated_at').join(', '));
    return { item: view(get(id)!) };
  });

  app.delete('/api/admin/work-orders/:id', admin, async (req) => {
    const id = z.coerce.number().int().positive().parse((req.params as { id: string }).id);
    const cur = get(id);
    if (!cur) throw new HttpError(404, 'work_order_not_found');
    // an order that led to an installation stays as history; the others go away
    if (cur.jobId || cur.status === 'done') db.prepare("UPDATE work_orders SET status = 'cancelled', updated_at = ? WHERE id = ?").run(nowIso(), id);
    else db.prepare('DELETE FROM work_orders WHERE id = ?').run(id);
    recordEvent(db, req.user!.id, 'work_order.delete', `#${id}`, cur.customer);
    return { ok: true };
  });

  // ---- installer -----------------------------------------------------------------------------
  /** The installer's orders of a day (default today), plus the open ones left from past days. */
  app.get('/api/work-orders', user, async (req) => {
    const { day } = z.object({ day: DAY.optional() }).parse(req.query);
    const d = day ?? todayRome();
    const rows = db
      .prepare(`${SELECT} WHERE w.assigned_to = ? AND (w.day = ? OR (w.day < ? AND w.status IN ('open','started','postponed'))) AND w.status <> 'cancelled' ORDER BY w.day, w.slot, w.id`)
      .all(req.user!.id, d, d) as unknown as Row[];
    return { day: d, items: rows.map((r) => view(r, d)) };
  });

  app.post('/api/work-orders/:id/status', user, async (req) => {
    const id = z.coerce.number().int().positive().parse((req.params as { id: string }).id);
    const b = z.object({ status: z.enum(['started', 'postponed', 'open']), note: z.string().trim().max(300).default('') }).strict().parse(req.body);
    const cur = get(id);
    if (!cur || (cur.assignedTo !== req.user!.id && req.user!.role !== 'admin')) throw new HttpError(404, 'work_order_not_found');
    if (cur.status === 'done' || cur.status === 'cancelled') throw new HttpError(409, 'work_order_closed');
    db.prepare('UPDATE work_orders SET status = ?, status_note = ?, updated_at = ? WHERE id = ?').run(b.status, b.note, nowIso(), id);
    recordEvent(db, req.user!.id, 'work_order.status', `#${id}`, `${b.status}${b.note ? ` · ${b.note}` : ''}`);
    return { item: view(get(id)!) };
  });
}
