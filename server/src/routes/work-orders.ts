import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HttpError, seesAll } from '../auth.ts';
import type { AppContext } from '../context.ts';
import { nowIso, recordEvent } from '../db.ts';
import { toCsv } from '../domain/csv.ts';
import { distanceM, isValidLatLon } from '../domain/geo.ts';

/** The installer must be within this distance of the order's position to save the acceptance test. */
export const POSITION_MAX_M = 500;

const DAY = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const KINDS = ['new', 'repoint', 'repair', 'survey'] as const;
export const WORK_ORDER_KIND_LABEL: Record<(typeof KINDS)[number], string> = {
  new: 'Nuova installazione',
  repoint: 'Ripuntamento / cambio AP',
  repair: 'Guasto',
  survey: 'Sopralluogo',
};

export const STATUS_LABEL: Record<string, string> = { open: 'da fare', started: 'in corso', done: 'fatto', postponed: 'rimandato', cancelled: 'annullato' };

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
  locationFrom: string;
}

const SELECT = `SELECT w.id, w.created_at createdAt, w.updated_at updatedAt, w.assigned_to assignedTo, u.username assignee, w.day, w.slot, w.kind,
  w.customer, w.address, w.lat, w.lon, w.contact, w.pppoe_user pppoeUser, w.pppoe_ciphertext ciphertext, w.model, w.notes, w.status,
  w.status_note statusNote, w.job_id jobId, w.done_at doneAt, w.location_from locationFrom
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
  // the specialist sees the office's orders and their history; planning them stays with the admins
  const staff = { preHandler: [ctx.auth.requireSeesAll, ctx.modules.require('work_orders')] };
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
  const username = (uid: number | null | undefined) => (uid == null ? 'nessuno' : ((db.prepare('SELECT username FROM users WHERE id = ?').get(uid) as { username: string } | undefined)?.username ?? `#${uid}`));

  /** «giorno 2026-10-15 → 2026-10-16 · installatore mario → luca · password cambiata»: what an edit changed. */
  function changes(cur: Row, b: Partial<Record<string, unknown>>): string {
    const show = (v: unknown) => (v === '' || v == null ? '—' : String(v));
    const out: string[] = [];
    const diff = (label: string, before: unknown, after: unknown) => {
      if (after !== undefined && show(before) !== show(after)) out.push(`${label} ${show(before)} → ${show(after)}`);
    };
    diff('giorno', cur.day, b.day);
    diff('fascia', cur.slot, b.slot);
    if (b.assignedTo !== undefined && b.assignedTo !== cur.assignedTo) out.push(`installatore ${username(cur.assignedTo)} → ${username(b.assignedTo as number | null)}`);
    if (b.kind !== undefined && b.kind !== cur.kind) out.push(`tipo ${WORK_ORDER_KIND_LABEL[cur.kind]} → ${WORK_ORDER_KIND_LABEL[b.kind as (typeof KINDS)[number]]}`);
    if (b.status !== undefined && b.status !== cur.status) out.push(`stato ${STATUS_LABEL[cur.status] ?? cur.status} → ${STATUS_LABEL[b.status as string] ?? b.status}`);
    diff('cliente', cur.customer, b.customer);
    diff('indirizzo', cur.address, b.address);
    diff('contatto', cur.contact, b.contact);
    diff('utente PPPoE', cur.pppoeUser, b.pppoeUser);
    diff('modello', cur.model, b.model);
    if ((b.lat !== undefined && b.lat !== cur.lat) || (b.lon !== undefined && b.lon !== cur.lon)) out.push('posizione cambiata');
    if (b.notes !== undefined && b.notes !== cur.notes) out.push('note cambiate');
    if (b.pppoePassword !== undefined) out.push(b.pppoePassword ? 'password cambiata' : 'password tolta');
    return out.join(' · ') || 'nessuna modifica';
  }

  /** An order with an address but no position gets the address's (the GPS check needs a point). */
  async function locate(id: number): Promise<{ lat: number; lon: number } | null> {
    const o = get(id);
    if (!o) return null;
    if (o.lat != null && o.lon != null) return { lat: o.lat, lon: o.lon };
    if (o.address.trim().length < 5) return null;
    const hit = (await ctx.geocoder.search(o.address).catch(() => []))[0];
    if (!hit) return null;
    db.prepare("UPDATE work_orders SET lat = ?, lon = ?, location_from = 'address' WHERE id = ? AND lat IS NULL").run(hit.lat, hit.lon, id);
    return { lat: hit.lat, lon: hit.lon };
  }

  /**
   * The office's list: a period, an installer (or «none»: not assigned), statuses, a kind and a text
   * (customer, address, contact, PPPoE user or #number). [backlog] (default on) adds the open orders of
   * past days; a month or a year of history leaves it off. The summary counts the whole selection.
   */
  const listQuery = z.object({
    from: DAY.optional(),
    to: DAY.optional(),
    user: z.union([z.literal('none'), z.coerce.number().int().positive()]).optional(),
    status: z.string().regex(/^[a-z,]+$/).max(80).optional(),
    kind: z.enum(KINDS).optional(),
    q: z.string().trim().max(80).optional(),
    backlog: z.enum(['0', '1']).default('1'),
    order: z.enum(['asc', 'desc']).default('asc'),
    limit: z.coerce.number().int().min(1).max(5000).default(1000),
    offset: z.coerce.number().int().min(0).default(0),
  });
  function select(raw: unknown) {
    const q = listQuery.parse(raw);
    const from = q.from ?? todayRome();
    const to = q.to && q.to >= from ? q.to : from;
    const common: string[] = [];
    const args: Array<string | number> = [];
    if (q.user === 'none') common.push('w.assigned_to IS NULL');
    else if (q.user) (common.push('w.assigned_to = ?'), args.push(q.user));
    const statuses = (q.status ?? '').split(',').filter(Boolean);
    if (statuses.length) (common.push(`w.status IN (${statuses.map(() => '?').join(',')})`), args.push(...statuses));
    if (q.kind) (common.push('w.kind = ?'), args.push(q.kind));
    const text = (q.q ?? '').replace(/^#/, '');
    if (text) {
      const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      common.push("(w.customer LIKE ? ESCAPE '\\' OR w.address LIKE ? ESCAPE '\\' OR w.contact LIKE ? ESCAPE '\\' OR w.pppoe_user LIKE ? ESCAPE '\\' OR CAST(w.id AS TEXT) = ?)");
      args.push(like, like, like, like, text);
    }
    // open orders of past days stay on the board until someone closes them
    const when = q.backlog === '1' ? "(w.day BETWEEN ? AND ? OR (w.day < ? AND w.status IN ('open','postponed')))" : 'w.day BETWEEN ? AND ?';
    const whenArgs = q.backlog === '1' ? [from, to, from] : [from, to];
    const where = [when, ...common].join(' AND ');
    const dir = q.order === 'desc' ? 'DESC' : 'ASC';
    const all = db.prepare(`SELECT w.status, w.day, w.assigned_to, w.kind FROM work_orders w WHERE ${where}`).all(...whenArgs, ...args) as Array<{ status: string; day: string; assigned_to: number | null; kind: string }>;
    const today = todayRome();
    const count = (f: (r: (typeof all)[number]) => boolean) => all.filter(f).length;
    const summary = {
      open: count((r) => r.status === 'open'),
      started: count((r) => r.status === 'started'),
      done: count((r) => r.status === 'done'),
      postponed: count((r) => r.status === 'postponed'),
      cancelled: count((r) => r.status === 'cancelled'),
      overdue: count((r) => (r.status === 'open' || r.status === 'postponed') && r.day < today),
      unassigned: count((r) => r.assigned_to == null && r.status !== 'cancelled'),
      byKind: Object.fromEntries(KINDS.map((k) => [k, count((r) => r.kind === k)])),
    };
    const rows = db.prepare(`${SELECT} WHERE ${where} ORDER BY w.day ${dir}, w.slot, w.id LIMIT ? OFFSET ?`).all(...whenArgs, ...args, q.limit, q.offset) as unknown as Row[];
    return { q, from, to, total: all.length, summary, rows };
  }

  // ---- office (admins) ------------------------------------------------------------------------
  app.get('/api/admin/work-orders', staff, async (req) => {
    const r = select(req.query);
    return { from: r.from, to: r.to, total: r.total, summary: r.summary, items: r.rows.map((x) => view(x)) };
  });

  /** The same selection for Excel (';', UTF-8 BOM): never the PPPoE password. */
  app.get('/api/admin/work-orders.csv', { preHandler: [ctx.auth.requireSeesAll, ctx.modules.require('work_orders'), ctx.modules.require('csv_export')] }, async (req, reply) => {
    const r = select({ ...(req.query as object), limit: '5000', offset: '0' });
    const header = ['Numero', 'Giorno', 'Fascia', 'Tipo', 'Stato', 'Installatore', 'Cliente', 'Indirizzo', 'Contatto', 'Utente PPPoE', 'Modello', 'Note', 'Nota dello stato', 'Creato', 'Ultima modifica', 'Completato', 'Installazione'];
    const lines = r.rows.map((o) => [o.id, o.day, o.slot, WORK_ORDER_KIND_LABEL[o.kind], STATUS_LABEL[o.status] ?? o.status, o.assignee ?? '', o.customer, o.address, o.contact, o.pppoeUser, o.model, o.notes, o.statusNote, o.createdAt, o.updatedAt, o.doneAt ?? '', o.jobId ?? '']);
    recordEvent(db, req.user!.id, 'work_order.export', `${r.rows.length} righe`, `${r.from} → ${r.to}`);
    reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="interventi-${r.from}-${r.to}.csv"`);
    return '﻿' + toCsv([header, ...lines]);
  });

  /**
   * Everything that happened to an order, in order: created, every change (old → new), the alerts,
   * the installer's steps, the installation and its acceptance test.
   */
  app.get('/api/admin/work-orders/:id/history', staff, async (req) => {
    const id = z.coerce.number().int().positive().parse((req.params as { id: string }).id);
    const o = get(id);
    const evs = db
      // a deleted order's number can be given again: only what happened since this one was created
      .prepare("SELECT e.created_at at, e.action, e.detail, u.username FROM events e LEFT JOIN users u ON u.id = e.user_id WHERE e.target = ? AND e.action LIKE 'work_order.%' AND e.created_at >= ? ORDER BY e.id")
      .all(`#${id}`, o?.createdAt ?? '') as Array<{ at: string; action: string; detail: string; username: string | null }>;
    if (!o && !evs.length) throw new HttpError(404, 'work_order_not_found');
    const alerts = o ? (db.prepare('SELECT late_at lateAt, missed_at missedAt FROM work_orders WHERE id = ?').get(id) as { lateAt: string | null; missedAt: string | null }) : null;
    const job = o?.jobId
      ? (db.prepare('SELECT j.id, j.created_at createdAt, j.status, j.mac, j.model, u.username installer FROM provisioning_jobs j LEFT JOIN users u ON u.id = j.user_id WHERE j.id = ?').get(o.jobId) as
          | { id: string; createdAt: string; status: string; mac: string; model: string; installer: string | null }
          | undefined)
      : undefined;
    const acc = job
      ? (db.prepare('SELECT a.created_at at, a.verdict, a.review, u.username FROM job_acceptance a LEFT JOIN users u ON u.id = a.user_id WHERE a.job_id = ?').get(job.id) as
          | { at: string; verdict: string; review: string | null; username: string | null }
          | undefined)
      : undefined;
    const VERDICT: Record<string, string> = { ok: 'superato', warn: 'con riserva', bad: 'non superato' };
    const items = [
      ...evs.map((e) => ({ at: e.at, kind: e.action.slice('work_order.'.length), user: e.username, detail: e.detail })),
      ...(alerts?.lateAt ? [{ at: alerts.lateAt, kind: 'late', user: null, detail: 'non iniziato all’ora prevista: avviso al NOC' }] : []),
      ...(alerts?.missedAt ? [{ at: alerts.missedAt, kind: 'missed', user: null, detail: 'giornata finita senza intervento' }] : []),
      ...(job ? [{ at: job.createdAt, kind: 'job', user: job.installer, detail: `${job.model} ${job.mac}`.trim() }] : []),
      ...(acc ? [{ at: acc.at, kind: 'acceptance', user: acc.username, detail: `${VERDICT[acc.verdict] ?? acc.verdict}${acc.review === 'approved' ? ' · approvato dal NOC' : acc.review === 'pending' ? ' · da approvare' : ''}` }] : []),
    ].sort((a, b) => a.at.localeCompare(b.at));
    return { id, items, job: job ? { id: job.id, status: job.status, acceptance: acc?.verdict ?? null } : null };
  });

  /**
   * «Nuovo intervento» from the CRM (ISP Billing, as the RADIUS sync copies it): customers found by
   * name («COGNOME NOME» or company name), code, phone, address or PPPoE user, each with its sites
   * (its PPPoE accounts and where they are). Never a password: ISP Billing does not give it.
   */
  app.get('/api/admin/work-orders/crm', staff, async (req) => {
    const { q } = z.object({ q: z.string().trim().min(2).max(80) }).parse(req.query);
    // % and _ typed are letters ('!' escapes them)
    const like = `%${q.replace(/[!%_]/g, (c) => `!${c}`)}%`;
    const cols = ['c.name', 'c.internal_code', 'c.phone', 'c.phone2', 'c.address_line1', 'c.city', 'r.username', 'r.customer_formal'];
    const ids = db
      .prepare(
        `SELECT DISTINCT c.customer_id id FROM crm_customers c LEFT JOIN crm_radius r ON r.customer_id = c.customer_id
          WHERE ${cols.map((c) => `${c} LIKE ? ESCAPE '!'`).join(' OR ')} LIMIT 12`,
      )
      .all(...cols.map(() => like)) as Array<{ id: string }>;
    const text = (r: Record<string, unknown>) => {
      const v = (k: string) => (typeof r[k] === 'string' ? (r[k] as string).trim() : '');
      return [[v('address_line1'), v('address_line2')].filter(Boolean).join(' '), [v('postal_code'), v('city'), v('state_code') ? `(${v('state_code')})` : ''].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    };
    const items = ids.map(({ id }) => {
      const c = db.prepare('SELECT * FROM crm_customers WHERE customer_id = ?').get(id) as Record<string, string>;
      const accounts = db
        .prepare(
          `SELECT r.username, r.account_status status, r.profile, r.customer_formal formal, a.address_line1, a.address_line2, a.city, a.postal_code, a.state_code, a.lat, a.lng
             FROM crm_radius r LEFT JOIN crm_addresses a ON a.address_id = r.address_id
            WHERE r.customer_id = ? AND r.account_status <> 'Terminato' ORDER BY r.username`,
        )
        .all(id) as Array<{ username: string; status: string; profile: string; formal: string; lat: number | null; lng: number | null } & Record<string, string | null>>;
      const sites = accounts.map((a) => ({
        pppoeUser: a.username,
        status: a.status,
        profile: a.profile.replace(/^[^@]*@/, ''),
        address: text(a.address_line1 ? a : c),
        lat: a.lat ?? null,
        lon: a.lng ?? null,
      }));
      return {
        customerId: id,
        name: accounts.find((a) => a.formal)?.formal || c.name,
        code: c.internal_code,
        phone: c.phone || c.phone2,
        status: c.status,
        // a customer without a PPPoE account yet: its main address
        sites: sites.length ? sites : [{ pppoeUser: '', status: '', profile: '', address: text(c), lat: null, lon: null }],
      };
    });
    return { configured: ctx.crm.client() !== null, items };
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
    if (b.lat != null) db.prepare("UPDATE work_orders SET location_from = 'office' WHERE id = ?").run(id);
    else void locate(id);
    recordEvent(db, req.user!.id, 'work_order.create', `#${id}`, `${b.day} ${b.customer}`);
    const item = view(get(id)!);
    ctx.notify.workOrderAssigned(item);
    return reply.code(201).send({ item });
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
    if (b.lat !== undefined) cols.push(['location_from', b.lat == null ? '' : 'office']);
    // a new day or time: the reminders and the late/missed alerts start again
    if ((b.day !== undefined && b.day !== cur.day) || (b.slot !== undefined && b.slot !== cur.slot) || (b.assignedTo !== undefined && b.assignedTo !== cur.assignedTo)) {
      cols.push(['reminders', ''], ['late_at', null], ['missed_at', null]);
    }
    db.prepare(`UPDATE work_orders SET ${cols.map(([c]) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...cols.map(([, v]) => v), id);
    recordEvent(db, req.user!.id, 'work_order.update', `#${id}`, changes(cur, b));
    if (b.address !== undefined && b.lat === undefined && cur.locationFrom !== 'office') {
      // a new address replaces the position found from the old one
      db.prepare("UPDATE work_orders SET lat = NULL, lon = NULL, location_from = '' WHERE id = ?").run(id);
      void locate(id);
    }
    const item = view(get(id)!);
    // the installer hears about a new assignment, a new day or time
    if (item.assignedTo != null && item.status !== 'cancelled' && (item.assignedTo !== cur.assignedTo || item.day !== cur.day || item.slot !== cur.slot)) {
      ctx.notify.workOrderAssigned(item, item.assignedTo === cur.assignedTo);
    }
    return { item };
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

  /**
   * The installer's GPS against the order's position (typed by the office or found from the
   * address): beyond POSITION_MAX_M the acceptance test is blocked and the NOC is told once.
   */
  /**
   * The calendar: the orders of a range of days (up to 62) exactly as planned, done ones included,
   * cancelled ones left out. An installer sees their own, a specialist his own and his work groups';
   * the NOC (and a specialist with «visibilità piena») every installer's, or one with ?user=, plus
   * the installers to plan on.
   */
  app.get('/api/work-orders/calendar', user, async (req) => {
    const q = z.object({ from: DAY, to: DAY, user: z.coerce.number().int().positive().optional() }).parse(req.query);
    const days = (Date.parse(`${q.to}T00:00:00Z`) - Date.parse(`${q.from}T00:00:00Z`)) / 86_400_000;
    if (!(days >= 0 && days <= 62)) throw new HttpError(400, 'invalid_range');
    const isAdmin = seesAll(req.user!);
    // a specialist: his own orders and those of the members of his work groups (issue #275), never
    // the rest of the team; an installer: his own
    const team = !isAdmin && req.user!.role === 'specialist' ? ctx.workGroups.calendarIds(req.user!.id) : [req.user!.id];
    const who: number[] | null = isAdmin ? (q.user ? [q.user] : null) : q.user && team.includes(q.user) ? [q.user] : team;
    const rows = db
      .prepare(
        `${SELECT} WHERE w.day BETWEEN ? AND ? AND w.status <> 'cancelled'${who !== null ? ` AND w.assigned_to IN (${who.map(() => '?').join(',')})` : ''} ORDER BY w.day, w.slot, w.id`,
      )
      .all(q.from, q.to, ...(who ?? [])) as unknown as Row[];
    const today = todayRome();
    const installers = isAdmin
      ? (db.prepare("SELECT id, username FROM users WHERE active = 1 AND role = 'installer' ORDER BY username").all() as Array<{ id: number; username: string }>)
      : undefined;
    return { from: q.from, to: q.to, today, items: rows.map((r) => view(r, today)), ...(installers ? { installers } : {}) };
  });

  app.post('/api/work-orders/:id/position', user, async (req) => {
    const id = z.coerce.number().int().positive().parse((req.params as { id: string }).id);
    const b = z.object({ lat: z.number(), lon: z.number(), accuracyM: z.number().min(0).max(100_000).optional() }).strict().parse(req.body);
    if (!isValidLatLon(b.lat, b.lon)) throw new HttpError(400, 'invalid_position');
    const cur = get(id);
    if (!cur || (cur.assignedTo !== req.user!.id && !seesAll(req.user!))) throw new HttpError(404, 'work_order_not_found');
    const ref = await locate(id);
    if (!ref) return { ok: true, checked: false, distanceM: null, maxM: POSITION_MAX_M, reference: null };
    const d = Math.round(distanceM(ref, { lat: b.lat, lon: b.lon }));
    const ok = d <= POSITION_MAX_M;
    const prev = (() => {
      try {
        return JSON.parse((db.prepare('SELECT position_check p FROM work_orders WHERE id = ?').get(id) as { p: string }).p || '{}') as { notified?: boolean };
      } catch {
        return {};
      }
    })();
    const notify = !ok && !prev.notified;
    db.prepare('UPDATE work_orders SET position_check = ? WHERE id = ?').run(JSON.stringify({ distanceM: d, ok, at: nowIso(), accuracyM: b.accuracyM ?? null, notified: !!prev.notified || notify }), id);
    const reference = get(id)!.locationFrom === 'address' ? 'address' : 'office';
    if (!ok) {
      recordEvent(db, req.user!.id, 'work_order.position_mismatch', `#${id}`, `${cur.customer}: ${d} m dalla posizione dell'intervento`);
      if (notify) {
        ctx.notify.inbox.push('noc', {
          kind: 'work_order_noc',
          title: `📍 Posizione non corrispondente: ${cur.customer}`,
          lines: [`L'installatore ${req.user!.username} è a ${d >= 1000 ? `${(d / 1000).toFixed(1).replace('.', ',')} km` : `${d} m`} da ${reference === 'address' ? "l'indirizzo" : 'la posizione'} dell'intervento.`, cur.address, 'Il collaudo è bloccato finché i dati non coincidono.'].filter(Boolean),
        });
      }
    }
    return { ok, checked: true, distanceM: d, maxM: POSITION_MAX_M, reference };
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
